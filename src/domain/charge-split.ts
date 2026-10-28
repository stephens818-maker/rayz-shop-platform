/**
 * Separate charges and transfers (I10, approved by Charles 2026-10-28): how one card charge on the
 * platform is divided, and how much of a refund or dispute comes back out of the shop's transfer.
 * Pure, so every rule is tested without Stripe or a database (tests/charge-split.test.ts).
 *
 * - The shop's portion is the charge (service, product, tax and the card surcharge) less the
 *   processing fee the platform keeps (the shop's fee schedule, as destination charges' application
 *   fee was), less the tips going to barbers. The card surcharge stays with the shop: it's there to
 *   cover that fee (ST-C18: the shop pays card fees, never the tip).
 * - A barber's tip goes to their Stripe Express account only with FEATURE_TIP_TO_BARBER on and an
 *   account that can take it. Otherwise it stays in the shop's portion (or, at a shop on the brand's
 *   account, on the platform) and is paid through payroll.
 * - Refunds and disputes are taken back from the shop's transfer only, up to what's left of it. A
 *   tip transfer is never reversed; what the shop's transfer can't cover is carried by the platform.
 */

export type Settlement = "platform" | "connected";

export interface TipShare {
  staffId: string;
  cents: number;
  /** The barber's Stripe account when a tip can go to it now; null when it can't. */
  accountId: string | null;
}

export interface SplitInput {
  amountCents: number;
  /** The processing fee the platform keeps. */
  feeCents: number;
  /** connected: the shop has a connected account to transfer to. platform: the shop is on the brand's account. */
  settlement: Settlement;
  /** Each barber's share of this charge's tip (the tip ledger's split). */
  tips: readonly TipShare[];
  tipToBarber: boolean;
}

export interface ChargeSplit {
  /** To the shop's connected account; 0 for a shop on the brand's account. */
  shopCents: number;
  tipTransfers: { staffId: string; accountId: string; cents: number }[];
  /** Tips left with the shop's portion, paid through payroll. */
  tipsWithShopCents: number;
  /** Tips left on the platform (a shop on the brand's account), paid through payroll or a tip payout. */
  tipsOnPlatformCents: number;
  /** The processing fee the shop's portion couldn't cover (a charge that's nearly all tip); the platform carries it, never the tip. */
  feeShortfallCents: number;
}

const whole = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be whole cents, 0 or more`);
  return n;
};

export function splitCharge(i: SplitInput): ChargeSplit {
  const amount = whole(i.amountCents, "The charge");
  const fee = whole(i.feeCents, "The processing fee");
  if (fee > amount) throw new Error("The processing fee can't be more than the charge");
  for (const t of i.tips) whole(t.cents, "A tip share");
  const tipTotal = i.tips.reduce((a, t) => a + t.cents, 0);
  if (tipTotal > amount) throw new Error("The tips can't be more than the charge");
  const tipTransfers = i.tipToBarber ? i.tips.filter((t) => t.cents > 0 && t.accountId).map((t) => ({ staffId: t.staffId, accountId: t.accountId!, cents: t.cents })) : [];
  const toBarbers = tipTransfers.reduce((a, t) => a + t.cents, 0);
  const kept = tipTotal - toBarbers;
  const left = amount - fee - toBarbers;
  const feeShortfallCents = Math.max(0, -left);
  if (i.settlement === "platform") return { shopCents: 0, tipTransfers, tipsWithShopCents: 0, tipsOnPlatformCents: kept, feeShortfallCents: 0 };
  return { shopCents: Math.max(0, left), tipTransfers, tipsWithShopCents: kept, tipsOnPlatformCents: 0, feeShortfallCents };
}

/**
 * How much of a refund or dispute comes back out of the shop's transfer: all of it, up to what's
 * left of the transfer. The rest is uncovered (it was a tip already with the barber, or the fee).
 */
export function shopReversal(o: { cents: number; transferCents: number; reversedCents: number }): { reverseCents: number; uncoveredCents: number } {
  const cents = whole(o.cents, "The refund");
  const left = Math.max(0, o.transferCents - o.reversedCents);
  const reverseCents = Math.min(cents, left);
  return { reverseCents, uncoveredCents: cents - reverseCents };
}

/** The charge's Stripe transfer group, shared by every payment of a sale (a split ticket's too). */
export const saleTransferGroup = (saleId: string) => `sale_${saleId}`;

/**
 * Where a card tip's money is, for paying it: with the barber (transferred at the sale, so it's paid
 * out from their Stripe balance, never through payroll or cash), with the shop (its own account, so
 * through payroll or the drawer), or on the platform (a shop on the brand's account, or a tip
 * transfer that didn't go through).
 */
export type TipRoute = "barber" | "shop" | "platform";
