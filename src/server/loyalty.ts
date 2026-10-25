import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, customers, loyaltyAccounts, loyaltyLedger, loyaltyRewards, shops } from "@/db/schema";
import { FamilyLoyalty, familySettings } from "@/domain/family";
import { LoyaltyConfig, accrue, convertProgress, goalOf, loyaltyConfig, loyaltyRules, progressExpired, reverseAccrual, rewardExpiry, usableRewards } from "@/domain/loyalty";
import { AppError } from "./errors";

export async function getLoyaltyConfig(tx: DBorTx = db): Promise<LoyaltyConfig> {
  const row = await tx.query.brandSettings.findFirst({ where: eq(brandSettings.id, 1) });
  return loyaltyConfig(row?.loyalty);
}

/**
 * Saves the program. Switching between value and transaction based carries every client's
 * progress over as the same share of the way to a reward (one ledger entry each), in the same
 * transaction, so no ticket accrues against a half-converted card. Returns how many cards moved.
 */
export async function saveLoyaltyConfig(cfg: LoyaltyConfig, tx: DBorTx = db): Promise<{ converted: number }> {
  const before = await getLoyaltyConfig(tx);
  await tx
    .insert(brandSettings)
    .values({ id: 1, loyalty: cfg })
    .onConflictDoUpdate({ target: brandSettings.id, set: { loyalty: cfg, updatedAt: new Date() } });
  if (before.type === cfg.type) return { converted: 0 };
  const rows = await tx.select({ id: loyaltyAccounts.customerId, p: loyaltyAccounts.progressCents }).from(loyaltyAccounts).where(gt(loyaltyAccounts.progressCents, 0)).for("update");
  let converted = 0;
  for (const r of rows) {
    const next = convertProgress(r.p, before, cfg);
    if (next === r.p) continue;
    await tx.update(loyaltyAccounts).set({ progressCents: next, updatedAt: new Date() }).where(eq(loyaltyAccounts.customerId, r.id));
    await tx.insert(loyaltyLedger).values({ customerId: r.id, kind: "convert", progressDeltaCents: next - r.p, unit: unitOf(cfg) });
    converted++;
  }
  return { converted };
}

export type LoyaltyUnit = "cents" | "visits";
const unitOf = (cfg: Pick<LoyaltyConfig, "type">): LoyaltyUnit => (cfg.type === "transaction" ? "visits" : "cents");
/** Progress recorded in one unit, in the program's current unit (a ticket earned before the program changed type). */
const inUnit = (n: number, from: LoyaltyUnit, cfg: LoyaltyConfig): number =>
  from === unitOf(cfg) ? n : convertProgress(n, from === "visits" ? { ...cfg, type: "transaction" } : { ...cfg, type: "value" }, cfg);
async function familyLoyalty(tx: DBorTx): Promise<FamilyLoyalty> {
  const [b] = await tx.select({ f: brandSettings.family }).from(brandSettings).where(eq(brandSettings.id, 1));
  return familySettings(b?.f).loyalty;
}

/**
 * Whose card a client's visits earn on and whose rewards they spend: their own, or for a child
 * their parent's when the brand counts loyalty per household (the default).
 */
export async function loyaltyOwner(customerId: string, tx: DBorTx = db): Promise<string> {
  const [c] = await tx.select({ g: customers.guardianId }).from(customers).where(eq(customers.id, customerId));
  if (!c?.g) return customerId;
  return (await familyLoyalty(tx)) === "household" ? c.g : customerId;
}

/**
 * Who earns what on a paid ticket. Household loyalty: everything on the payer's household card.
 * Individual: each person's share of the eligible spend by their services' net (a family ticket
 * covering a parent and two children earns on three cards), the remainder to the ticket's client.
 */
export async function loyaltyShares(
  tx: DBorTx,
  saleCustomerId: string,
  eligibleCents: number,
  servicesByPerson: { customerId: string; netCents: number }[],
): Promise<{ customerId: string; cents: number }[]> {
  if (eligibleCents <= 0) return [];
  const mode = await familyLoyalty(tx);
  const people = [...new Set(servicesByPerson.map((x) => x.customerId))];
  if (mode === "household" || people.length <= 1) return [{ customerId: await loyaltyOwner(people.length === 1 ? people[0] : saleCustomerId, tx), cents: eligibleCents }];
  const weight = new Map<string, number>();
  for (const x of servicesByPerson) weight.set(x.customerId, (weight.get(x.customerId) ?? 0) + Math.max(0, x.netCents));
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return [{ customerId: saleCustomerId, cents: eligibleCents }];
  const out = [...weight].map(([customerId, w]) => ({ customerId, cents: Math.floor((eligibleCents * w) / total) }));
  const rest = eligibleCents - out.reduce((a, x) => a + x.cents, 0);
  const payer = out.find((x) => x.customerId === saleCustomerId) ?? out[0];
  payer.cents += rest;
  return out.filter((x) => x.cents > 0);
}

/** The household's cards a ticket for this client may spend a reward from. */
export async function rewardOwners(customerId: string, tx: DBorTx = db): Promise<string[]> {
  const owner = await loyaltyOwner(customerId, tx);
  if (owner !== customerId) return [owner];
  const [c] = await tx.select({ g: customers.guardianId }).from(customers).where(eq(customers.id, customerId));
  const head = c?.g ?? customerId;
  const kids = await tx.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, head));
  return [...new Set([customerId, head, ...kids.map((k) => k.id)])];
}

export async function loyaltyBalance(customerId: string, now = new Date(), tx: DBorTx = db) {
  const cfg = await getLoyaltyConfig(tx);
  const owner = await loyaltyOwner(customerId, tx);
  const acct = await tx.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.customerId, owner) });
  const rewards = await tx
    .select()
    .from(loyaltyRewards)
    .where(and(eq(loyaltyRewards.customerId, owner), isNull(loyaltyRewards.redeemedAt)))
    .orderBy(asc(loyaltyRewards.issuedAt));
  const usable = usableRewards(rewards, now);
  const expired = progressExpired(acct?.lastEarnAt ?? null, now, cfg);
  const progressCents = expired ? 0 : (acct?.progressCents ?? 0);
  const goal = goalOf(cfg);
  const shopNames = cfg.shopIds === null ? undefined : (await tx.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, cfg.shopIds.length ? cfg.shopIds : [crypto.randomUUID()]))).map((x) => x.name).sort();
  return {
    enabled: cfg.enabled,
    /** A child on the household card: the balance is their parent's. */
    household: owner !== customerId,
    ownerId: owner,
    /** "value": progress and the goal are cents. "transaction": they're paid visits (thresholdCents is still the value goal, for older app builds). */
    type: cfg.type,
    thresholdCents: cfg.thresholdCents,
    visitsGoal: cfg.visitsGoal,
    rewardCents: cfg.rewardCents,
    progressCents,
    remainingCents: Math.max(0, goal - progressCents),
    /** Locations it runs at; null: every location. */
    shopIds: cfg.shopIds,
    lifetimeEarnedCents: acct?.lifetimeEarnedCents ?? 0,
    rewards: usable.map((r) => ({ id: r.id, amountCents: r.amountCents, issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null })),
    availableCents: usable.reduce((a, r) => a + r.amountCents, 0),
    rules: loyaltyRules(cfg, shopNames),
  };
}

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
  if (r.appliedCents <= 0) return 0;
  await tx
    .update(loyaltyAccounts)
    .set({ progressCents: r.progressCents, lifetimeEarnedCents: acct.lifetimeEarnedCents + Math.round(earnCents), lastEarnAt: now, updatedAt: now })
    .where(eq(loyaltyAccounts.customerId, customerId));
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "earn", progressDeltaCents: r.appliedCents, unit: unitOf(cfg) });
  for (let i = 0; i < r.rewardsIssued; i++) {
    await tx.insert(loyaltyRewards).values({ customerId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), sourceSaleId: saleId });
    await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_issued", rewardCents: cfg.rewardCents });
  }
  return r.rewardsIssued;
}

/**
 * Take back `reverse` of earned progress after a refund or void, in the unit it was earned in (a
 * ticket from before the program changed type is converted). Unused rewards the sale issued are
 * revoked first (newest first), so a full refund returns progress to its pre-sale value.
 * `lifetimeCents` is the eligible spend taken off the lifetime total (the cents, for value based).
 */
export async function reverseForSale(tx: DBorTx, customerId: string, saleId: string, reverse: number, now = new Date(), o: { unit?: LoyaltyUnit; lifetimeCents?: number } = {}) {
  const cfg = await getLoyaltyConfig(tx);
  const unit = o.unit ?? "cents";
  if (reverse <= 0) return { rewardsRevoked: 0, unrecoveredCents: 0 };
  const acct = await lockAccount(tx, customerId);
  const revocable = await tx
    .select()
    .from(loyaltyRewards)
    .where(and(eq(loyaltyRewards.sourceSaleId, saleId), eq(loyaltyRewards.customerId, customerId), isNull(loyaltyRewards.redeemedAt)))
    .orderBy(desc(loyaltyRewards.issuedAt))
    .for("update");
  const r = reverseAccrual(acct.progressCents, inUnit(reverse, unit, cfg), revocable.length, cfg);
  for (const rw of revocable.slice(0, r.rewardsRevoked)) {
    await tx.delete(loyaltyRewards).where(eq(loyaltyRewards.id, rw.id));
    await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reward_revoked", rewardCents: -rw.amountCents });
  }
  const lifetime = o.lifetimeCents ?? (unit === "cents" ? reverse : 0);
  await tx
    .update(loyaltyAccounts)
    .set({ progressCents: r.progressCents, lifetimeEarnedCents: Math.max(0, acct.lifetimeEarnedCents - lifetime), updatedAt: now })
    .where(eq(loyaltyAccounts.customerId, customerId));
  await tx.insert(loyaltyLedger).values({ customerId, saleId, kind: "reverse", progressDeltaCents: -reverse, unit });
  return { rewardsRevoked: r.rewardsRevoked, unrecoveredCents: unitOf(cfg) === "cents" ? r.unrecoveredCents : 0 };
}

/**
 * Take back earned progress after a refund or void from whoever earned on the ticket (one card, or
 * each family member's). Spend earned as cents comes back in proportion to what each still has from
 * it; a visit earned under transaction based loyalty comes back only when the ticket is voided or
 * fully refunded (`full`), since a partly refunded visit still happened. Tickets with no earn
 * entries reverse on `fallbackCustomerId`.
 */
export async function reverseSaleLoyalty(tx: DBorTx, saleId: string, fallbackCustomerId: string, reverseCents: number, now = new Date(), o: { full?: boolean } = {}) {
  reverseCents = Math.max(0, reverseCents);
  if (reverseCents <= 0 && !o.full) return { rewardsRevoked: 0, unrecoveredCents: 0 };
  const rows = await tx
    .select({ customerId: loyaltyLedger.customerId, unit: loyaltyLedger.unit, n: sql<number>`coalesce(sum(${loyaltyLedger.progressDeltaCents}), 0)::int` })
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.saleId, saleId), inArray(loyaltyLedger.kind, ["earn", "reverse"])))
    .groupBy(loyaltyLedger.customerId, loyaltyLedger.unit);
  const left = rows.filter((r) => Number(r.n) > 0).map((r) => ({ customerId: r.customerId, unit: (r.unit === "visits" ? "visits" : "cents") as LoyaltyUnit, n: Number(r.n) }));
  if (!rows.length) return reverseForSale(tx, fallbackCustomerId, saleId, reverseCents, now);
  const out = { rewardsRevoked: 0, unrecoveredCents: 0 };
  const add = (x: { rewardsRevoked: number; unrecoveredCents: number }) => {
    out.rewardsRevoked += x.rewardsRevoked;
    out.unrecoveredCents += x.unrecoveredCents;
  };
  const cents = left.filter((r) => r.unit === "cents");
  if (cents.length) {
    const total = cents.reduce((a, r) => a + r.n, 0);
    const take = Math.min(reverseCents, total);
    const shares = cents.map((r) => ({ ...r, take: Math.floor((take * r.n) / total) }));
    shares[0].take += take - shares.reduce((a, r) => a + r.take, 0);
    out.unrecoveredCents += reverseCents - take;
    for (const r of shares) if (r.take > 0) add(await reverseForSale(tx, r.customerId, saleId, r.take, now));
  }
  const visits = left.filter((r) => r.unit === "visits");
  if (visits.length && o.full) {
    const each = Math.floor(reverseCents / visits.length);
    for (const [i, r] of visits.entries()) add(await reverseForSale(tx, r.customerId, saleId, r.n, now, { unit: "visits", lifetimeCents: each + (i === 0 ? reverseCents - each * visits.length : 0) }));
  }
  return out;
}

export async function loadRedeemableReward(tx: DBorTx, customerId: string, rewardId: string, now = new Date()) {
  const owners = await rewardOwners(customerId, tx);
  const r = await tx.query.loyaltyRewards.findFirst({ where: and(eq(loyaltyRewards.id, rewardId), inArray(loyaltyRewards.customerId, owners)) });
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
