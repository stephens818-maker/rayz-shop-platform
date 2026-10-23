import { formatCents, type PaymentPreview } from "@rayz/api";

/**
 * Label for Stripe PaymentSheet.FlowController (customFlow on this SDK).
 * The fee is on the confirm button, before the charge.
 */
export function flowButtonLabel(preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding">): string {
  const total = formatCents(preview.totalCents);
  if (preview.funding === "debit") return `Pay ${total} · No surcharge on debit cards`;
  if (preview.feeCents > 0) return `Pay ${total} (includes ${formatCents(preview.feeCents)} credit card surcharge)`;
  return `Pay ${total}`;
}

export function labelContainsCardNumber(label: string): boolean {
  return /\d{12,}/.test(label.replace(/\s/g, ""));
}

export const NOTHING_CHARGED = "Nothing was charged.";

/** A live PaymentIntent opens the sheet. Setup secrets and sandbox PaymentIntents do not. */
export function skipNativeSheet(clientSecret: string): boolean {
  return !clientSecret.startsWith("pi_") || clientSecret.startsWith("pi_test_") || clientSecret.startsWith("seti_");
}

export function flowSheetParams(
  preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding">,
  intent: { clientSecret: string; ephemeralKey: string; customerId: string },
) {
  return {
    paymentIntentClientSecret: intent.clientSecret,
    customerEphemeralKeySecret: intent.ephemeralKey,
    customerId: intent.customerId,
    merchantDisplayName: "Ray'z",
    customFlow: true as const,
    primaryButtonLabel: flowButtonLabel(preview),
  };
}

export interface SheetStep {
  error?: { code?: string; message?: string } | null;
}

/** Charge only after init, present, and confirm all succeed. Cancel or any error does not charge. */
export function afterSheet(steps: { init?: SheetStep; present?: SheetStep; confirm?: SheetStep }): { charge: boolean; message: string | null } {
  if (!steps.init || steps.init.error || !steps.present || steps.present.error || !steps.confirm || steps.confirm.error) {
    return { charge: false, message: NOTHING_CHARGED };
  }
  return { charge: true, message: null };
}