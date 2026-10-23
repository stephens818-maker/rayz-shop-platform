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

/** Sandbox SetupIntents never collect a card number. A Stripe SetupIntent secret still opens the sheet. */
export function skipNativeSheet(clientSecret: string): boolean {
  return clientSecret.startsWith("seti_") && !clientSecret.includes("_secret_");
}

/** Real Stripe PaymentIntent secrets, test or live, contain `_secret_`. */
export function opensStripeSheet(clientSecret: string): boolean {
  return /^pi_(test|live)_.+_secret_/.test(clientSecret);
}

/** Mock sandbox secrets are `pi_test_` plus a hex nonce and do not contain `_secret_`. */
export function sandboxTestPayment(clientSecret: string): boolean {
  return clientSecret.startsWith("pi_test_") && !clientSecret.includes("_secret_");
}

export function nativeChargePlan(clientSecret: string): "sheet" | "sandbox" | "refuse" {
  if (opensStripeSheet(clientSecret)) return "sheet";
  if (sandboxTestPayment(clientSecret)) return "sandbox";
  return "refuse";
}

/**
 * Confirm only when the server preview is for the selected card and the
 * total on screen is that preview. A different card has to be repriced first.
 */
export function confirmAllowed(input: {
  selectedPaymentMethodId: string | null;
  previewPaymentMethodId: string | null;
  previewTotalCents: number | null;
  displayedTotalCents: number | null;
}): { confirm: boolean; reprice: boolean } {
  if (!input.selectedPaymentMethodId || input.previewPaymentMethodId !== input.selectedPaymentMethodId) {
    return { confirm: false, reprice: true };
  }
  if (input.previewTotalCents == null || input.displayedTotalCents == null || input.displayedTotalCents !== input.previewTotalCents) {
    return { confirm: false, reprice: false };
  }
  return { confirm: true, reprice: false };
}

export function sheetCardSwitched(pricedLabel: string | null | undefined, optionLabel: string | null | undefined): boolean {
  if (!pricedLabel || !optionLabel) return false;
  const norm = (value: string) => value.replace(/\s/g, "").toLowerCase();
  return norm(pricedLabel) !== norm(optionLabel);
}

/** Refuse junk secrets. Reprice before confirm when the card or the total changed. */
export function nextChargeStep(input: { plan: "sheet" | "sandbox" | "refuse"; confirm: boolean; sheetSwitched: boolean }): "nothing" | "reprice" | "charge" {
  if (input.plan === "refuse") return "nothing";
  if (!input.confirm || input.sheetSwitched) return "reprice";
  return "charge";
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