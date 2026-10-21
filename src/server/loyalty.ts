import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, loyaltyAccounts, loyaltyLedger, loyaltyRewards } from "@/db/schema";
import { DEFAULT_LOYALTY, LoyaltyConfig, accrue, progressExpired, reverseAccrual, rewardExpiry, usableRewards } from "@/domain/loyalty";
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
      redeem: `${cfg.redeemableOn === "services" ? "Rewards can be used on services." : "Rewards can be used on anything except gift cards."} One reward per visit.`,
      expiry: cfg.rewardExpiryDays ? `Rewards expire ${cfg.rewardExpiryDays} days after they're earned.` : "Rewards don't expire.",
    },
  };
}

const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** Creates the account if needed and takes a row lock on it for the rest of the transaction. */
export async function lockAccount(tx: DBorTx, customerId: string) {
  await tx.insert(loyaltyAccounts).values({ customerId }).onConflictDoNothing();
  const [acct] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId)).for("update");
  return acct;
}

/** Called inside the checkout transaction. Returns the number of rewards issued. */
export async function accrueForSale(tx: DBorTx, customerId: string, saleId: string, earnCents: number, now = new Date()) {
  const cfg = await getLoyaltyConfig(tx);
  if (!cfg.enabled || earnCents <= 0) return 0;
  const acct = await lockAccount(tx, customerId);
  const startProgress = !progressExpired(acct.lastEarnAt, now, cfg) ? acct.progressCents : 0;
  const r = accrue(startProgress, earnCents, cfg);
  await tx
    .update(loyaltyAccounts)
    .set({ progressCents: r.progressCents, lifetimeEarnedCents: acct.lifetimeEarnedCents + r.appliedCents, lastEarnAt: now, updatedAt: now })
    .where(eq(loyaltyAccounts.customerId, customerId));
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "earn", progressDeltaCents: r.appliedCents });
  for (let i = 0; i < r.rewardsIssued; i++) {
    await tx.insert(loyaltyRewards).values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), sourceSaleId: saleId });
    await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_issued", rewardCents: cfg.rewardCents });
  }
  return r.rewardsIssued;
}

/**
 * Take back `reverseCents` of earned service spend after a refund or void. Unused rewards the sale
 * issued are revoked first (newest first), so a full refund returns progress to its pre-sale value.
 */
export async function reverseForSale(tx: DBorTx, customerId: string, saleId: string, reverseCents: number, now = new Date()) {
  const cfg = await getLoyaltyConfig(tx);
  if (reverseCents <= 0) return { rewardsRevoked: 0, unrecoveredCents: 0 };
  const acct = await lockAccount(tx, customerId);
  const revocable = await tx
    .select()
    .from(loyaltyRewards)
    .where(and(eq(loyaltyRewards.sourceSaleId, saleId), isNull(loyaltyRewards.redeemedAt)))
    .orderBy(desc(loyaltyRewards.issuedAt))
    .for("update");
  const r = reverseAccrual(acct.progressCents, reverseCents, revocable.length, cfg);
  for (const rw of revocable.slice(0, r.rewardsRevoked)) {
    await tx.delete(loyaltyRewards).where(eq(loyaltyRewards.id, rw.id));
    await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_revoked", rewardCents: -rw.amountCents });
  }
  await tx
    .update(loyaltyAccounts)
    .set({ progressCents: r.progressCents, lifetimeEarnedCents: Math.max(0, acct.lifetimeEarnedCents - reverseCents), updatedAt: now })
    .where(eq(loyaltyAccounts.customerId, customerId));
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reverse", progressDeltaCents: -reverseCents });
  return { rewardsRevoked: r.rewardsRevoked, unrecoveredCents: r.unrecoveredCents };
}

export async function loadRedeemableReward(tx: DBorTx, customerId: string, rewardId: string, now = new Date()) {
  const r = await tx.query.loyaltyRewards.findFirst({ where: and(eq(loyaltyRewards.id, rewardId), eq(loyaltyRewards.customerId, customerId)) });
  if (!r || r.redeemedAt || (r.expiresAt && r.expiresAt < now)) throw new AppError("bad_request", "That reward isn't available");
  return r;
}

/** Conditional on the reward still being unused, so two tickets can't both spend it. */
export async function markRewardRedeemed(tx: DBorTx, rewardId: string, saleId: string, customerId: string, cents: number, now = new Date()) {
  const res = await tx
    .update(loyaltyRewards)
    .set({ redeemedAt: now, redeemedSaleId: saleId })
    .where(
      and(
        eq(loyaltyRewards.id, rewardId),
        eq(loyaltyRewards.customerId, customerId),
        isNull(loyaltyRewards.redeemedAt),
        or(isNull(loyaltyRewards.expiresAt), gt(loyaltyRewards.expiresAt, now)),
      ),
    )
    .returning({ id: loyaltyRewards.id });
  if (!res.length) throw new AppError("conflict", "That reward was just used on another ticket");
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_redeemed", rewardCents: -cents });
}

export async function restoreRewardsForSale(tx: DBorTx, saleId: string) {
  const restored = await tx
    .update(loyaltyRewards)
    .set({ redeemedAt: null, redeemedSaleId: null })
    .where(eq(loyaltyRewards.redeemedSaleId, saleId))
    .returning({ customerId: loyaltyRewards.customerId, amountCents: loyaltyRewards.amountCents });
  for (const r of restored) await tx.insert(loyaltyLedger).values({ customerId: r.customerId, saleId, kind: "reward_restored", rewardCents: r.amountCents });
  return restored.length;
}
