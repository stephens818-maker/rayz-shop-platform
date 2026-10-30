/**
 * Separate charges and transfers (I10, approved by Charles 2026-10-28): how one card charge on the
 * platform is divided, and how much of a refund or dispute comes back out of the shop's transfer.
 * Pure, so every rule is tested without Stripe or a database (tests/charge-split.test.ts).
 *
 * - The shop's portion is the charge (service, product, tax and the card surcharge) less the
 *   processing fee the platform keeps (the shop's fee schedule, as destination charges' application
 *   fee was), less the tips going to barbers. The card surcharge stays with the shop: it's there to
 *   cover that fee (ST-C18: the shop pays card fees, never the tip).
 * - A barber's tip goes to their Stripe recipient account (no Stripe dashboard) only with
 *   FEATURE_TIP_TO_BARBER and the shop's switch on and an account that can take it. Otherwise it stays in the shop's portion (or, at a shop on the brand's
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

export interface PlannedTransfer {
  paymentId: string;
  kind: "shop" | "tip";
  staffId: string | null;
}

/**
 * Stripe idempotency keys for a sale's transfers: {saleId}:shop and {saleId}:tip. A key already
 * taken (`taken`, or earlier in `rows`) gets longer instead of colliding: a second card on a split
 * ticket is {saleId}:shop:{paymentId}, and with tips for more than one barber each is
 * {saleId}:tip:{staffId}, then {saleId}:tip:{staffId}:{paymentId}.
 */
export function saleTransferKeys(saleId: string, rows: readonly PlannedTransfer[], taken: ReadonlySet<string> = new Set()): string[] {
  const used = new Set(taken);
  const barbers = new Set(rows.filter((r) => r.kind === "tip").map((r) => r.staffId));
  const pick = (...options: string[]) => {
    const k = options.find((o) => !used.has(o)) ?? options.at(-1)!;
    used.add(k);
    return k;
  };
  return rows.map((r) =>
    r.kind === "shop"
      ? pick(`${saleId}:shop`, `${saleId}:shop:${r.paymentId}`)
      : barbers.size === 1
        ? pick(`${saleId}:tip`, `${saleId}:tip:${r.staffId}`, `${saleId}:tip:${r.staffId}:${r.paymentId}`)
        : pick(`${saleId}:tip:${r.staffId}`, `${saleId}:tip:${r.staffId}:${r.paymentId}`),
  );
}

/**
 * What a refund or dispute the shop's transfer couldn't cover (shopReversal's uncoveredCents) was:
 * first the tips already with barbers on this charge (less tip losses already booked for it), then
 * whatever earlier platform losses this transfer had paid back (the shop owes those again), and the
 * rest the processing fee the platform kept.
 */
export function uncoveredParts(o: { uncoveredCents: number; tipsToBarbersCents: number; tipLossBookedCents: number; recoveredOnTransferCents: number }) {
  const uncovered = whole(o.uncoveredCents, "The uncovered amount");
  const tipCents = Math.min(uncovered, Math.max(0, o.tipsToBarbersCents - o.tipLossBookedCents));
  const reopenCents = Math.min(uncovered - tipCents, Math.max(0, o.recoveredOnTransferCents));
  return { tipCents, reopenCents, feeCents: uncovered - tipCents - reopenCents };
}

/**
 * A shop on the brand's account has no transfer of its own: the sale's portion is already on the
 * platform. Refunds and disputes come out of it first; past it (the charge less the tips sent to
 * barbers), each one's overflow is a tip already with a barber, which the platform absorbs.
 */
export function brandAccountOverflow(o: { amountCents: number; tipsToBarbersCents: number; takenBeforeCents: number; cents: number; bookedCents: number }): number {
  const cents = whole(o.cents, "The refund");
  const covered = Math.max(0, o.amountCents - o.tipsToBarbersCents);
  const over = Math.max(0, o.takenBeforeCents + cents - covered);
  return Math.max(0, Math.min(cents, over - o.bookedCents, o.tipsToBarbersCents - o.bookedCents));
}

/** How much of a shop's transfer goes to the shop-borne losses still owed, oldest first. */
export function recoveryFrom(shopCents: number, owed: readonly { id: string; cents: number }[]): { id: string; cents: number }[] {
  let left = whole(shopCents, "The shop's transfer");
  const out: { id: string; cents: number }[] = [];
  for (const o of owed) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, o.cents));
    if (take > 0) out.push({ id: o.id, cents: take });
    left -= take;
  }
  return out;
}

/**
 * Where a card tip's money is, for paying it: with the barber (transferred at the sale, so it's paid
 * out from their Stripe balance, never through payroll or cash), with the shop (its own account, so
 * through payroll or the drawer), or on the platform (a shop on the brand's account, or a tip
 * transfer that didn't go through).
 */
export type TipRoute = "barber" | "shop" | "platform";
