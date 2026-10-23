/**
 * Read-only shop and tip split for receipts and purchase history.
 * Charge creation stays in core `chargeCard`. This module only interprets ledger rows.
 */

export type TipStatus = "executed" | "skipped" | "reversed" | "with_shop" | "planned" | "failed";

export type RefundFrom = "shop" | "tip" | "shop_and_tip";

export interface LedgerTransfer {
  paymentIntentId: string;
  role: "shop_net" | "tip";
  amountCents: number;
  reversedCents: number;
  status: "planned" | "executed" | "reversed" | "failed" | "skipped";
  transferGroup: string | null;
  note: string | null;
}

export interface LedgerPayment {
  amountCents: number;
  tipCents: number;
  applicationFeeCents: number;
  stripeAccountId: string | null;
  stripePaymentIntentId: string | null;
}

export interface SettlementView {
  shopCents: number;
  /** Tip moved on its own transfer. Zero when the tip stayed inside the shop amount. */
  tipCents: number;
  tipStatus: TipStatus;
  transferGroup: string | null;
}

export interface RefundSlice {
  createdAt: string | Date;
  amountCents: number;
  method: string;
}

export interface RefundPortion {
  shopPortionCents: number | null;
  tipPortionCents: number | null;
  from: RefundFrom | null;
}

const COUNTED_TIP = new Set(["executed", "reversed", "planned"]);

function tipStatusOf(tipRows: LedgerTransfer[], shopIncludesTip: boolean): TipStatus {
  if (tipRows.length === 0) return shopIncludesTip ? "with_shop" : "skipped";
  const statuses = new Set(tipRows.map((r) => r.status));
  if (statuses.size === 1) {
    const only = tipRows[0]!.status;
    if (only === "skipped") return shopIncludesTip ? "with_shop" : "skipped";
    return only;
  }
  const active = tipRows.filter((r) => r.status !== "skipped");
  if (active.length === 0) return shopIncludesTip ? "with_shop" : "skipped";
  if (active.every((r) => r.status === "reversed")) return "reversed";
  if (active.some((r) => r.status === "executed")) return "executed";
  if (active.some((r) => r.status === "planned")) return "planned";
  if (active.some((r) => r.status === "failed")) return "failed";
  return "skipped";
}

function oneGroup(rows: LedgerTransfer[]): string | null {
  const groups = [...new Set(rows.map((r) => r.transferGroup).filter((g): g is string => !!g))];
  return groups.length === 1 ? groups[0]! : null;
}

/**
 * Shop and tip amounts the way the ledger recorded them.
 * `connect_transfers` wins. A card payment with a connected account and no transfer rows
 * is one shop amount (charge minus the application fee), and any tip stayed with that shop.
 * Cash and imports with no Connect rows return null.
 */
export function settlementFromLedger(payments: LedgerPayment[], transfers: LedgerTransfer[]): SettlementView | null {
  const covered = new Set(transfers.map((t) => t.paymentIntentId));
  const bare = payments.filter((p) => p.stripeAccountId && !(p.stripePaymentIntentId && covered.has(p.stripePaymentIntentId)));
  if (transfers.length === 0 && bare.length === 0) return null;

  const shopFromTransfers = transfers.filter((t) => t.role === "shop_net").reduce((sum, t) => sum + t.amountCents, 0);
  const shopFromBare = bare.reduce((sum, p) => sum + p.amountCents - p.applicationFeeCents, 0);
  const tipRows = transfers.filter((t) => t.role === "tip");
  const shopIncludesTip =
    transfers.some((t) => t.role === "shop_net" && !!t.note?.includes("Includes the tip")) ||
    (transfers.length === 0 && bare.some((p) => p.tipCents > 0));
  const tipStatus = transfers.length === 0 ? (bare.some((p) => p.tipCents > 0) ? "with_shop" : "skipped") : tipStatusOf(tipRows, shopIncludesTip);
  const countedTip = tipRows.filter((t) => COUNTED_TIP.has(t.status)).reduce((sum, t) => sum + t.amountCents, 0);

  return {
    shopCents: shopFromTransfers + shopFromBare,
    tipCents: tipStatus === "with_shop" ? 0 : countedTip,
    tipStatus,
    transferGroup: oneGroup(transfers),
  };
}

/**
 * Which account a refund left. Ticket `tipCents` is not the source of funds.
 * A tip reversal pool is spent oldest-refund first, and only onto card refunds.
 * With no tip reversal, a settled card refund is entirely from the shop.
 * Unsettled tickets and non-card refunds leave the portion blank.
 */
export function portionsForRefunds(refunds: RefundSlice[], transfers: LedgerTransfer[], payments: LedgerPayment[]): RefundPortion[] {
  const settled = transfers.length > 0 || payments.some((p) => !!p.stripeAccountId);
  let pool = transfers.filter((t) => t.role === "tip").reduce((sum, t) => sum + Math.max(0, t.reversedCents), 0);
  const order = refunds
    .map((refund, index) => ({ refund, index }))
    .sort((a, b) => new Date(a.refund.createdAt).getTime() - new Date(b.refund.createdAt).getTime() || a.index - b.index);
  const out: RefundPortion[] = refunds.map(() => ({ shopPortionCents: null, tipPortionCents: null, from: null }));
  for (const { refund, index } of order) {
    if (!settled || refund.method !== "card") continue;
    const tipPortionCents = pool > 0 ? Math.min(refund.amountCents, pool) : 0;
    pool -= tipPortionCents;
    const shopPortionCents = refund.amountCents - tipPortionCents;
    const from: RefundFrom = tipPortionCents === 0 ? "shop" : shopPortionCents === 0 ? "tip" : "shop_and_tip";
    out[index] = { shopPortionCents, tipPortionCents, from };
  }
  return out;
}
