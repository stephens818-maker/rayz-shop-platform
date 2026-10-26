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

/**
 * A real PaymentIntent client secret is `pi_XXX_secret_YYY`.
 * The id is not parsed for test or live mode.
 */
export function realPaymentSecret(clientSecret: string): boolean {
  return /^pi_.+_secret_.+$/.test(clientSecret);
}

/** Mock sandbox secrets are `pi_test_` plus a hex nonce and do not contain `_secret_`. */
export function sandboxPaymentSecret(clientSecret: string): boolean {
  return clientSecret.startsWith("pi_test_") && !clientSecret.includes("_secret_");
}

export function publishableKeyMode(publishableKey: string): "test" | "live" | "unknown" {
  if (publishableKey.startsWith("pk_test_")) return "test";
  if (publishableKey.startsWith("pk_live_")) return "live";
  return "unknown";
}

export function productionBuildProfile(profile: string | null | undefined): boolean {
  return profile === "production";
}

/**
 * Test or live comes from the publishable key. A live key is refused unless this
 * is the production build profile. Real secrets open the sheet; mock secrets finish in the sandbox.
 */
export function nativeChargePlan(input: { clientSecret: string; publishableKey: string; productionBuild: boolean }): "sheet" | "sandbox" | "refuse" {
  const mode = publishableKeyMode(input.publishableKey);
  if (mode === "live" && !input.productionBuild) return "refuse";
  if (realPaymentSecret(input.clientSecret)) {
    if (mode === "test" || (mode === "live" && input.productionBuild)) return "sheet";
    return "refuse";
  }
  if (sandboxPaymentSecret(input.clientSecret) && mode === "test") return "sandbox";
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

/** The sheet confirms the one priced card. It does not receive the customer key that lists every saved card. */
export function lockedSheetParams(
  preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding">,
  intent: { clientSecret: string; paymentMethodId: string },
) {
  return {
    paymentIntentClientSecret: intent.clientSecret,
    merchantDisplayName: "Ray'z",
    customFlow: true as const,
    allowsDelayedPaymentMethods: false as const,
    primaryButtonLabel: flowButtonLabel(preview),
    paymentMethodId: intent.paymentMethodId,
  };
}

export function cardQuoteLabel(card: { brand: string; last4: string }, totalCents: number): string {
  return `${card.brand} ••${card.last4} · ${formatCents(totalCents)}`;
}

/** The charge is the card and the total the picker showed. */
export function chargeMatchesShown(
  shown: { paymentMethodId: string; totalCents: number },
  charged: { paymentMethodId: string; totalCents: number },
): boolean {
  return shown.paymentMethodId === charged.paymentMethodId && shown.totalCents === charged.totalCents;
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