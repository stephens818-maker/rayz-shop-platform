/**
 * Brand-wide value-based loyalty (matches Squire's saved setting: "Value based", goal $300, reward $15,
 * products and tips excluded). Earn base = net service dollars after discounts, before tax.
 */
export interface LoyaltyConfig {
  enabled: boolean;
  thresholdCents: number;
  rewardCents: number;
  /** Days an issued reward stays redeemable. null = never expires. */
  rewardExpiryDays: number | null;
  /** Progress resets if the client hasn't visited for this many days. null = never. */
  progressExpiryDays: number | null;
  /** What a reward can be spent on at checkout. */
  redeemableOn: "services" | "all";
  /** Max rewards redeemable on one ticket. */
  maxRewardsPerTicket: number;
  /** Whether a reward can be combined with a promo code on the same ticket. */
  stackWithPromos: boolean;
}

export const DEFAULT_LOYALTY: LoyaltyConfig = {
  enabled: true,
  thresholdCents: 30_000,
  rewardCents: 1_500,
  rewardExpiryDays: 365,
  progressExpiryDays: null,
  redeemableOn: "services",
  maxRewardsPerTicket: 1,
  stackWithPromos: false,
};

export interface AccrualResult {
  progressCents: number;
  rewardsIssued: number;
  /** Earn delta applied to progress (after clamping). */
  appliedCents: number;
}

/** Add eligible spend and issue a reward for every full threshold crossed. */
export function accrue(currentProgressCents: number, earnCents: number, cfg: LoyaltyConfig): AccrualResult {
  if (!cfg.enabled || cfg.thresholdCents <= 0) {
    return { progressCents: currentProgressCents, rewardsIssued: 0, appliedCents: 0 };
  }
  const earn = Math.max(0, Math.round(earnCents));
  const total = currentProgressCents + earn;
  const rewardsIssued = Math.floor(total / cfg.thresholdCents);
  return { progressCents: total - rewardsIssued * cfg.thresholdCents, rewardsIssued, appliedCents: earn };
}

export interface ReversalResult {
  progressCents: number;
  /** How many of the sale's still-unredeemed rewards to take back. */
  rewardsRevoked: number;
  /** Spend that couldn't be clawed back because the reward it earned was already used. */
  unrecoveredCents: number;
}

/**
 * Undo `reverseCents` of earned spend. Each reward the sale issued (and that's still unused) is
 * worth one threshold of progress, so a full refund lands progress exactly where it was before
 * the sale. If the reward was already spent, progress bottoms out at zero.
 */
export function reverseAccrual(currentProgressCents: number, reverseCents: number, revocableRewards: number, cfg: LoyaltyConfig): ReversalResult {
  let x = currentProgressCents - Math.max(0, Math.round(reverseCents));
  let revoked = 0;
  while (x < 0 && revoked < revocableRewards && cfg.thresholdCents > 0) {
    x += cfg.thresholdCents;
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
