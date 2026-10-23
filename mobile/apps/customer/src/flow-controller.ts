import { formatCents, type PaymentPreview } from "@rayz/api";

/**
 * Label for Stripe PaymentSheet.FlowController (customFlow on this SDK).
 * The fee is on the confirm button, before the charge.
 */
export function flowButtonLabel(preview: Pick<PaymentPreview, "feeCents" | "feeLabel" | "totalCents">): string {
  const total = formatCents(preview.totalCents);
  if (preview.feeCents > 0 && preview.feeLabel) return `Pay ${total} · ${preview.feeLabel}`;
  return `Pay ${total}`;
}

export function labelContainsCardNumber(label: string): boolean {
  return /\d{12,}/.test(label.replace(/\s/g, ""));
}

/** Stripe PaymentSheet customFlow is FlowController on this SDK. Sandbox setup secrets skip the sheet. */
export function skipNativeSheet(clientSecret: string): boolean {
  return clientSecret.startsWith("seti_test_");
}

export function flowSheetParams(
  preview: Pick<PaymentPreview, "feeCents" | "feeLabel" | "totalCents">,
  setup: { clientSecret: string; ephemeralKey: string; customerId: string },
) {
  return {
    setupIntentClientSecret: setup.clientSecret,
    customerEphemeralKeySecret: setup.ephemeralKey,
    customerId: setup.customerId,
    merchantDisplayName: "Ray'z",
    customFlow: true as const,
    primaryButtonLabel: flowButtonLabel(preview),
  };
}