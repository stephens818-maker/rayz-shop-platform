import type { PaymentPreview } from "@rayz/api";
import { useStripe } from "@stripe/stripe-react-native";
import { Button } from "@rayz/ui";
import { afterSheet, confirmAllowed, flowButtonLabel, flowSheetParams, nativeChargePlan, nextChargeStep, NOTHING_CHARGED, sheetCardSwitched } from "./flow-controller";

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
  cardLabel,
  sheetOptionLabel,
}: {
  preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding"> | null;
  disabled: boolean;
  onPress: () => void;
  setup?: { clientSecret: string; ephemeralKey: string; customerId: string } | null;
  onNothingCharged?: (message: string) => void;
  onReprice?: () => void;
  pricedPaymentMethodId?: string | null;
  selectedPaymentMethodId?: string | null;
  previewTotalCents?: number | null;
  displayedTotalCents?: number | null;
  cardLabel?: string | null;
  sheetOptionLabel?: string | null;
}) {
  const { initPaymentSheet, presentPaymentSheet, confirmPaymentSheetPayment } = useStripe();
  const press = async () => {
    if (!preview || !setup) {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    const plan = nativeChargePlan(setup.clientSecret);
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
    const init = await initPaymentSheet(flowSheetParams(preview, setup));
    const presented = init.error ? undefined : await presentPaymentSheet();
    if (init.error || presented?.error) {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    const afterPick = nextChargeStep({ plan, confirm: allowed.confirm, sheetSwitched: sheetCardSwitched(cardLabel, sheetOptionLabel) });
    if (afterPick !== "charge") {
      onReprice?.();
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
