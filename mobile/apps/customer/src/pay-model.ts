import type { PaymentPreview } from "@rayz/api";

/** Presentation only. Amounts come from the payment preview, shown before Pay. */
export function payModel(preview: PaymentPreview) {
  return {
    paymentsEnabled: preview.paymentsEnabled,
    unavailableCopy: preview.unavailableCopy,
    lines: [
      { label: "Service", cents: preview.serviceCents },
      { label: "Tax", cents: preview.taxCents },
      { label: "Tip", cents: preview.tipCents },
      ...(preview.feeCents > 0 && preview.feeLabel ? [{ label: preview.feeLabel, cents: preview.feeCents }] : []),
    ],
    disclosure: preview.disclosure,
    showFee: preview.feeCents > 0,
    totalCents: preview.totalCents,
    tipTransferCopy: preview.tipTransfer.copy,
  };
}
