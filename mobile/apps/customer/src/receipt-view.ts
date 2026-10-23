import { formatCents } from "@rayz/api";

export interface ReceiptRefund {
  id: string;
  amountCents: number;
  from?: "shop" | "tip" | "shop_and_tip" | null;
  shopPortionCents?: number | null;
  tipPortionCents?: number | null;
}

export interface ReceiptSettlement {
  shopCents: number;
  tipCents: number;
  tipStatus: "executed" | "reversed" | "planned" | "with_shop";
}

export interface ReceiptView {
  serviceCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  totalCents: number;
  tender: string;
  barberFirstName?: string | null;
  settlement?: ReceiptSettlement | null;
  refunds: ReceiptRefund[];
}

/**
 * A found receipt is the object itself. An unknown id is `{ receipt: null }`.
 * Refunds list beside the original total.
 */
export function receiptView(body: ({ receipt: ReceiptView | null } | ReceiptView) | null): ReceiptView | null {
  if (!body) return null;
  if ("receipt" in body) return body.receipt;
  return body;
}

export function receiptTotal(receipt: ReceiptView | null): number | null {
  if (!receipt) return null;
  return receipt.totalCents;
}

/** Account the refund left. Blank when the ledger did not record a card settlement. */
export function refundPortionPhrase(refund: Pick<ReceiptRefund, "from" | "shopPortionCents" | "tipPortionCents">): string {
  if (refund.from === "shop") return " from the shop";
  if (refund.from === "tip") return " from the tip";
  if (refund.from === "shop_and_tip" && refund.shopPortionCents != null && refund.tipPortionCents != null) {
    return ` from the shop ${formatCents(refund.shopPortionCents)} and the tip ${formatCents(refund.tipPortionCents)}`;
  }
  return "";
}

export function settlementLines(ticketTipCents: number, settlement: ReceiptSettlement | null | undefined, barberFirstName?: string | null): string[] {
  if (!settlement) return [];
  const lines: string[] = [];
  const first = barberFirstName?.trim().split(/\s+/)[0] || "your barber";
  if (settlement.tipCents > 0 && (settlement.tipStatus === "executed" || settlement.tipStatus === "reversed" || settlement.tipStatus === "planned")) {
    lines.push(`Tip ${formatCents(settlement.tipCents)} paid to ${first}.`);
  } else if (settlement.tipStatus === "with_shop" && ticketTipCents > 0) {
    lines.push(`Tip ${formatCents(ticketTipCents)} stayed with the shop.`);
  }
  lines.push(`Shop ${formatCents(settlement.shopCents)}`);
  return lines;
}
