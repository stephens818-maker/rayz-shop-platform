/**
 * Brand-wide loyalty, set up like Squire's: value based (every $300 of eligible spend earns $15) or
 * transaction based (every N paid visits earns the reward), with products and tips counted or not,
 * at the locations the program is assigned to. Earn base = net service dollars after discounts,
 * before tax, plus net product dollars and tips when they're switched on.
 */
export const LOYALTY_TYPES = ["value", "transaction"] as const;
export type LoyaltyType = (typeof LOYALTY_TYPES)[number];
export const LOYALTY_TYPE_LABEL: Record<LoyaltyType, string> = { value: "Value based", transaction: "Transaction based" };

export interface LoyaltyConfig {
  enabled: boolean;
  /** Value based: progress is eligible cents toward thresholdCents. Transaction based: progress is paid visits toward visitsGoal. */
  type: LoyaltyType;
  thresholdCents: number;
  /** Transaction based: paid visits per reward. */
  visitsGoal: number;
  /** Transaction based: a ticket only counts as a visit when its eligible spend is at least this. */
  minVisitCents: number;
  rewardCents: number;
  /** Net product sales count toward the goal (value based) or the minimum spend (transaction based). */
  includeProducts: boolean;
  includeTips: boolean;
  /** Locations where clients earn and spend rewards. null = every location, including ones added later. */
  shopIds: string[] | null;
  /** Days an issued reward stays redeemable. null = never expires. */
  rewardExpiryDays: number | null;
  /** Progress resets if the client hasn't visited for this many days. null = never. */
  progressExpiryDays: number | null;
  /** What a reward can be spent on at checkout. */
  redeemableOn: "services" | "all";
  /** Whether a reward can be combined with a promo code on the same ticket. */
  stackWithPromos: boolean;
}

export const DEFAULT_LOYALTY: LoyaltyConfig = {
  enabled: true,
  type: "value",
  thresholdCents: 30_000,
  visitsGoal: 10,
  minVisitCents: 0,
  rewardCents: 1_500,
  includeProducts: false,
  includeTips: false,
  shopIds: null,
  rewardExpiryDays: 365,
  progressExpiryDays: null,
  redeemableOn: "services",
  stackWithPromos: false,
};

/** The stored config with defaults for anything missing or malformed (configs saved before a setting existed). */
export function loyaltyConfig(raw: unknown): LoyaltyConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof LoyaltyConfig, unknown>>;
  const d = DEFAULT_LOYALTY;
  const int = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fb);
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const days = (v: unknown, fb: number | null) => (v === null ? null : typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fb);
  return {
    enabled: bool(o.enabled, d.enabled),
    type: o.type === "transaction" ? "transaction" : "value",
    thresholdCents: int(o.thresholdCents, d.thresholdCents),
    visitsGoal: int(o.visitsGoal, d.visitsGoal),
    minVisitCents: Math.max(0, int(o.minVisitCents, d.minVisitCents)),
    rewardCents: int(o.rewardCents, d.rewardCents),
    includeProducts: bool(o.includeProducts, d.includeProducts),
    includeTips: bool(o.includeTips, d.includeTips),
    shopIds: Array.isArray(o.shopIds) ? [...new Set(o.shopIds.filter((x): x is string => typeof x === "string"))] : null,
    rewardExpiryDays: days(o.rewardExpiryDays, d.rewardExpiryDays),
    progressExpiryDays: days(o.progressExpiryDays, d.progressExpiryDays),
    redeemableOn: o.redeemableOn === "all" ? "all" : "services",
    stackWithPromos: bool(o.stackWithPromos, d.stackWithPromos),
  };
}

/** Progress needed for one reward, in the program's unit (cents or visits). */
export const goalOf = (cfg: Pick<LoyaltyConfig, "type" | "thresholdCents" | "visitsGoal">): number => (cfg.type === "transaction" ? cfg.visitsGoal : cfg.thresholdCents);

/** The program runs at this location: on, and the location is assigned (or every location is). */
export const loyaltyAtShop = (cfg: Pick<LoyaltyConfig, "enabled" | "shopIds">, shopId: string | null | undefined): boolean =>
  cfg.enabled && (cfg.shopIds === null || (!!shopId && cfg.shopIds.includes(shopId)));

/** What a ticket's spend counts toward loyalty: services always, products and tips when they're on. Gift cards and tax never. */
export function loyaltyEligibleCents(t: { serviceNetCents: number; productNetCents: number; tipCents: number }, cfg: Pick<LoyaltyConfig, "includeProducts" | "includeTips">): number {
  return Math.max(0, t.serviceNetCents) + (cfg.includeProducts ? Math.max(0, t.productNetCents) : 0) + (cfg.includeTips ? Math.max(0, t.tipCents) : 0);
}

/** The progress one ticket's eligible spend adds: the cents, or one visit when it reaches the minimum. */
export function earnUnits(earnCents: number, cfg: Pick<LoyaltyConfig, "type" | "minVisitCents">): number {
  const e = Math.max(0, Math.round(earnCents));
  if (cfg.type === "value") return e;
  return e > 0 && e >= cfg.minVisitCents ? 1 : 0;
}

/**
 * Progress carried over when the program changes type or goal: the same share of the way to a
 * reward, rounded down so nobody is pushed past a reward they didn't earn.
 */
export function convertProgress(progress: number, from: Pick<LoyaltyConfig, "type" | "thresholdCents" | "visitsGoal">, to: Pick<LoyaltyConfig, "type" | "thresholdCents" | "visitsGoal">): number {
  const a = goalOf(from);
  const b = goalOf(to);
  if (from.type === to.type && a === b) return progress;
  if (a <= 0 || b <= 0) return 0;
  return Math.min(b - 1, Math.max(0, Math.floor((progress / a) * b)));
}

export interface AccrualResult {
  progressCents: number;
  rewardsIssued: number;
  /** Earn delta applied to progress, in the program's unit (cents, or visits for transaction based). */
  appliedCents: number;
}

/** Add one ticket's eligible spend and issue a reward for every full goal crossed. */
export function accrue(currentProgressCents: number, earnCents: number, cfg: LoyaltyConfig): AccrualResult {
  const goal = goalOf(cfg);
  if (!cfg.enabled || goal <= 0) {
    return { progressCents: currentProgressCents, rewardsIssued: 0, appliedCents: 0 };
  }
  const earn = earnUnits(earnCents, cfg);
  const total = currentProgressCents + earn;
  const rewardsIssued = Math.floor(total / goal);
  return { progressCents: total - rewardsIssued * goal, rewardsIssued, appliedCents: earn };
}

export interface ReversalResult {
  progressCents: number;
  /** How many of the sale's still-unredeemed rewards to take back. */
  rewardsRevoked: number;
  /** Spend that couldn't be clawed back because the reward it earned was already used. */
  unrecoveredCents: number;
}

/**
 * Undo `reverseCents` of earned progress (in the program's unit). Each reward the sale issued (and
 * that's still unused) is worth one goal of progress, so a full refund lands progress exactly where
 * it was before the sale. If the reward was already spent, progress bottoms out at zero.
 */
export function reverseAccrual(currentProgressCents: number, reverseCents: number, revocableRewards: number, cfg: LoyaltyConfig): ReversalResult {
  const goal = goalOf(cfg);
  let x = currentProgressCents - Math.max(0, Math.round(reverseCents));
  let revoked = 0;
  while (x < 0 && revoked < revocableRewards && goal > 0) {
    x += goal;
    revoked++;
  }
  return { progressCents: Math.max(0, x), rewardsRevoked: revoked, unrecoveredCents: Math.max(0, -x) };
}

export function rewardExpiry(issuedAt: Date, cfg: LoyaltyConfig): Date | null {
  if (cfg.rewardExpiryDays === null) return null;
  return new Date(issuedAt.getTime() + cfg.rewardExpiryDays * 86_400_000);
}

export interface RewardLike {
  amountCents: number;
  expiresAt: Date | null;
  redeemedAt: Date | null;
}

export function usableRewards<T extends RewardLike>(rewards: T[], now: Date = new Date()): T[] {
  return rewards
    .filter((r) => !r.redeemedAt && (!r.expiresAt || r.expiresAt.getTime() > now.getTime()))
    .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
}

/** Progress should reset when the last visit is older than progressExpiryDays. */
export function progressExpired(lastEarnAt: Date | null, now: Date, cfg: LoyaltyConfig): boolean {
  if (cfg.progressExpiryDays === null || !lastEarnAt) return false;
  return now.getTime() - lastEarnAt.getTime() > cfg.progressExpiryDays * 86_400_000;
}

const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** The program in words, for the client app, receipts and the settings page. `shopNames` are the assigned locations' names. */
export function loyaltyRules(cfg: LoyaltyConfig, shopNames?: readonly string[]): { earn: string; redeem: string; expiry: string; where: string } {
  const join = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const kinds = (s: string) => join(["service", ...(cfg.includeProducts ? ["product"] : []), ...(cfg.includeTips ? ["tip"] : [])].map((k) => k + s));
  const list = kinds("s");
  const excluded = !cfg.includeProducts && !cfg.includeTips ? " Products and tips don't count." : !cfg.includeProducts ? " Products don't count." : !cfg.includeTips ? " Tips don't count." : "";
  const earn =
    cfg.type === "transaction"
      ? `Every ${cfg.visitsGoal} paid visit${cfg.visitsGoal === 1 ? "" : "s"}${cfg.minVisitCents > 0 ? ` of at least ${dollars(cfg.minVisitCents)} on ${list}` : ""} earns a ${dollars(cfg.rewardCents)} reward.${cfg.minVisitCents > 0 ? excluded : ""}`
      : `Every ${dollars(cfg.thresholdCents)} in net ${kinds("")} spend (after discounts, before tax) earns a ${dollars(cfg.rewardCents)} reward.${excluded}`;
  return {
    earn,
    redeem: `${cfg.redeemableOn === "services" ? "Rewards can be used on services." : "Rewards can be used on anything except gift cards."} One reward per visit.`,
    expiry: cfg.rewardExpiryDays ? `Rewards expire ${cfg.rewardExpiryDays} days after they're earned.` : "Rewards don't expire.",
    where: cfg.shopIds === null || !shopNames ? "Earned and used at every location." : shopNames.length ? `Earned and used at ${shopNames.join(", ")}.` : "Not running at any location right now.",
  };
}

/** "$120 of $300" or "3 of 10 visits": where a card stands, for staff screens, receipts and the client's account. */
export function progressLabel(b: { type: LoyaltyType; progressCents: number; thresholdCents: number; visitsGoal: number }, money: (cents: number) => string): string {
  return b.type === "transaction" ? `${b.progressCents} of ${b.visitsGoal} visits` : `${money(b.progressCents)} of ${money(b.thresholdCents)}`;
}

/** How far along a card is, 0 to 1, for progress bars. */
export const progressShare = (b: { type: LoyaltyType; progressCents: number; thresholdCents: number; visitsGoal: number }): number => Math.min(1, Math.max(0, b.progressCents / Math.max(1, goalOf(b))));
