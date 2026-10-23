export interface ReceiptRefund {
  id: string;
  amountCents: number;
}

export interface ReceiptView {
  serviceCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  totalCents: number;
  tender: string;
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
