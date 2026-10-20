import { and, asc, eq, isNull } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, loyaltyAccounts, loyaltyLedger, loyaltyRewards } from "@/db/schema";
import { DEFAULT_LOYALTY, LoyaltyConfig, accrue, progressExpired, rewardExpiry, usableRewards } from "@/domain/loyalty";
import { AppError } from "./errors";

export async function getLoyaltyConfig(tx: DBorTx = db): Promise<LoyaltyConfig> {
  const row = await tx.query.brandSettings.findFirst({ where: eq(brandSettings.id, 1) });
  return { ...DEFAULT_LOYALTY, ...((row?.loyalty as Partial<LoyaltyConfig>) ?? {}) };
}

export async function saveLoyaltyConfig(cfg: LoyaltyConfig) {
  await db
    .insert(brandSettings)
    .values({ id: 1, loyalty: cfg })
    .onConflictDoUpdate({ target: brandSettings.id, set: { loyalty: cfg, updatedAt: new Date() } });
}

export async function loyaltyBalance(customerId: string, now = new Date(), tx: DBorTx = db) {
  const cfg = await getLoyaltyConfig(tx);
  const acct = await tx.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.customerId, customerId) });
  const rewards = await tx
    .select()
    .from(loyaltyRewards)
    .where(and(eq(loyaltyRewards.customerId, customerId), isNull(loyaltyRewards.redeemedAt)))
    .orderBy(asc(loyaltyRewards.issuedAt));
  const usable = usableRewards(rewards, now);
  const expired = progressExpired(acct?.lastEarnAt ?? null, now, cfg);
  const progressCents = expired ? 0 : (acct?.progressCents ?? 0);
  return {
    enabled: cfg.enabled,
    thresholdCents: cfg.thresholdCents,
    rewardCents: cfg.rewardCents,
    progressCents,
    remainingCents: Math.max(0, cfg.thresholdCents - progressCents),
    lifetimeEarnedCents: acct?.lifetimeEarnedCents ?? 0,
    rewards: usable.map((r) => ({ id: r.id, amountCents: r.amountCents, issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null })),
    availableCents: usable.reduce((a, r) => a + r.amountCents, 0),
    rules: {
      earn: `Every ${dollars(cfg.thresholdCents)} in net service spend (after discounts, before tax) earns a ${dollars(cfg.rewardCents)} reward. Products and tips don't count.`,
      redeem: cfg.redeemableOn === "services" ? "Rewards can be used on services." : "Rewards can be used on anything except gift cards.",
      expiry: cfg.rewardExpiryDays ? `Rewards expire ${cfg.rewardExpiryDays} days after they're earned.` : "Rewards don't expire.",
    },
  };
}

const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** Called inside the checkout transaction. Returns the number of rewards issued. */
export async function accrueForSale(tx: DBorTx, customerId: string, saleId: string, earnCents: number, now = new Date()) {
  const cfg = await getLoyaltyConfig(tx);
  if (!cfg.enabled || earnCents === 0) return 0;
  const acct = await tx.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.customerId, customerId) });
  const startProgress = acct && !progressExpired(acct.lastEarnAt, now, cfg) ? acct.progressCents : 0;
  const r = accrue(startProgress, earnCents, cfg);
  await tx
    .insert(loyaltyAccounts)
    .values({ customerId, progressCents: r.progressCents, lifetimeEarnedCents: Math.max(0, r.appliedCents), lastEarnAt: now })
    .onConflictDoUpdate({
      target: loyaltyAccounts.customerId,
      set: {
        progressCents: r.progressCents,
        lifetimeEarnedCents: (acct?.lifetimeEarnedCents ?? 0) + r.appliedCents,
        lastEarnAt: earnCents > 0 ? now : (acct?.lastEarnAt ?? now),
        updatedAt: now,
      },
    });
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: earnCents > 0 ? "earn" : "reverse", progressDeltaCents: r.appliedCents });
  for (let i = 0; i < r.rewardsIssued; i++) {
    await tx.insert(loyaltyRewards).values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), sourceSaleId: saleId });
    await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_issued", rewardCents: cfg.rewardCents });
  }
  return r.rewardsIssued;
}

export async function loadRedeemableReward(tx: DBorTx, customerId: string, rewardId: string, now = new Date()) {
  const r = await tx.query.loyaltyRewards.findFirst({ where: and(eq(loyaltyRewards.id, rewardId), eq(loyaltyRewards.customerId, customerId)) });
  if (!r || r.redeemedAt || (r.expiresAt && r.expiresAt < now)) throw new AppError("bad_request", "That reward isn't available");
  return r;
}

export async function markRewardRedeemed(tx: DBorTx, rewardId: string, saleId: string, customerId: string, cents: number, now = new Date()) {
  await tx.update(loyaltyRewards).set({ redeemedAt: now, redeemedSaleId: saleId }).where(eq(loyaltyRewards.id, rewardId));
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_redeemed", rewardCents: -cents });
}

export async function restoreRewardsForSale(tx: DBorTx, saleId: string) {
  await tx.update(loyaltyRewards).set({ redeemedAt: null, redeemedSaleId: null }).where(eq(loyaltyRewards.redeemedSaleId, saleId));
}
