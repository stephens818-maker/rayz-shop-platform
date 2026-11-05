import type { PaymentPreview } from "@rayz/api";
import { useStripe } from "@stripe/stripe-react-native";
import { Button } from "@rayz/ui";
import { afterSheet, confirmAllowed, flowButtonLabel, lockedSheetParams, nativeChargePlan, nextChargeStep, NOTHING_CHARGED, productionBuildProfile } from "./flow-controller";

/** The selected card is charged only when PaymentSheet confirms the PaymentIntent. */
export function PayConfirm({
  preview,
  disabled,
  onPress,
  setup,
  onNothingCharged,
  onReprice,
  pricedPaymentMethodId,
  selectedPaymentMethodId,
  previewTotalCents,
  displayedTotalCents,
  publishableKey = process.env.EXPO_PUBLIC_STRIPE_PK ?? "pk_test_sandbox_rayz",
  productionBuild = productionBuildProfile(process.env.EAS_BUILD_PROFILE),
}: {
  preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding"> | null;
  disabled: boolean;
  onPress: () => void;
  setup?: { clientSecret: string; ephemeralKey?: string; customerId?: string } | null;
  onNothingCharged?: (message: string) => void;
  onReprice?: () => void;
  pricedPaymentMethodId?: string | null;
  selectedPaymentMethodId?: string | null;
  previewTotalCents?: number | null;
  displayedTotalCents?: number | null;
  /** Kept for the screen. The sheet is locked to one card, so these are not read. */
  cardLabel?: string | null;
  sheetOptionLabel?: string | null;
  publishableKey?: string;
  productionBuild?: boolean;
}) {
  const { initPaymentSheet, presentPaymentSheet, confirmPaymentSheetPayment } = useStripe();
  const press = async () => {
    if (!preview || !setup) {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    const plan = nativeChargePlan({ clientSecret: setup.clientSecret, publishableKey, productionBuild });
    const allowed = confirmAllowed({
      selectedPaymentMethodId: selectedPaymentMethodId ?? null,
      previewPaymentMethodId: pricedPaymentMethodId ?? null,
      previewTotalCents: previewTotalCents ?? null,
      displayedTotalCents: displayedTotalCents ?? null,
    });
    const before = nextChargeStep({ plan, confirm: allowed.confirm, sheetSwitched: false });
    if (before === "nothing") {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    if (before === "reprice") {
      onReprice?.();
      return;
    }
    if (plan === "sandbox") {
      onPress();
      return;
    }
    const locked = lockedSheetParams(preview, { clientSecret: setup.clientSecret, paymentMethodId: selectedPaymentMethodId ?? "" });
    const init = await initPaymentSheet({
      paymentIntentClientSecret: locked.paymentIntentClientSecret,
      merchantDisplayName: locked.merchantDisplayName,
      customFlow: locked.customFlow,
      allowsDelayedPaymentMethods: locked.allowsDelayedPaymentMethods,
      primaryButtonLabel: locked.primaryButtonLabel,
    });
    const presented = init.error ? undefined : await presentPaymentSheet();
    if (init.error || presented?.error) {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    const confirmed = await confirmPaymentSheetPayment();
    const decision = afterSheet({
      init: {},
      present: {},
      confirm: confirmed.error ? { error: confirmed.error } : {},
    });
    if (!decision.charge) {
      onNothingCharged?.(decision.message ?? NOTHING_CHARGED);
      return;
    }
    onPress();
  };
  return <Button label={preview ? flowButtonLabel(preview) : "Pay"} disabled={disabled} onPress={() => void press()} />;
}
