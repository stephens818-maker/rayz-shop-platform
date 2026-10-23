import type { PaymentPreview } from "@rayz/api";
import { useStripe } from "@stripe/stripe-react-native";
import { Button } from "@rayz/ui";
import { afterSheet, flowButtonLabel, flowSheetParams, NOTHING_CHARGED, skipNativeSheet } from "./flow-controller";

/** The selected card is charged only when PaymentSheet confirms the PaymentIntent. */
export function PayConfirm({
  preview,
  disabled,
  onPress,
  setup,
  onNothingCharged,
}: {
  preview: Pick<PaymentPreview, "feeCents" | "totalCents" | "funding"> | null;
  disabled: boolean;
  onPress: () => void;
  setup?: { clientSecret: string; ephemeralKey: string; customerId: string } | null;
  onNothingCharged?: (message: string) => void;
}) {
  const { initPaymentSheet, presentPaymentSheet, confirmPaymentSheetPayment } = useStripe();
  const press = async () => {
    if (!preview || !setup || skipNativeSheet(setup.clientSecret)) {
      onNothingCharged?.(NOTHING_CHARGED);
      return;
    }
    const init = await initPaymentSheet(flowSheetParams(preview, setup));
    const presented = init.error ? undefined : await presentPaymentSheet();
    const confirmed = init.error || presented?.error ? undefined : await confirmPaymentSheetPayment();
    const decision = afterSheet({
      init: init.error ? { error: init.error } : {},
      present: presented ? (presented.error ? { error: presented.error } : {}) : undefined,
      confirm: confirmed ? (confirmed.error ? { error: confirmed.error } : {}) : undefined,
    });
    if (!decision.charge) {
      onNothingCharged?.(decision.message ?? NOTHING_CHARGED);
      return;
    }
    onPress();
  };
  return <Button label={preview ? flowButtonLabel(preview) : "Pay"} disabled={disabled} onPress={() => void press()} />;
}
