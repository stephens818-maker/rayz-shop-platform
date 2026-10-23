import type { PaymentPreview } from "@rayz/api";
import { useStripe } from "@stripe/stripe-react-native";
import { Button } from "@rayz/ui";
import { flowButtonLabel, flowSheetParams, skipNativeSheet } from "./flow-controller";

/** Fee sits on PaymentSheet's primary button (customFlow) before the charge is confirmed. */
export function PayConfirm({
  preview,
  disabled,
  onPress,
  setup,
}: {
  preview: Pick<PaymentPreview, "feeCents" | "feeLabel" | "totalCents"> | null;
  disabled: boolean;
  onPress: () => void;
  setup?: { clientSecret: string; ephemeralKey: string; customerId: string } | null;
}) {
  const { initPaymentSheet, presentPaymentSheet, confirmPaymentSheetPayment } = useStripe();
  const press = async () => {
    if (preview && setup && !skipNativeSheet(setup.clientSecret)) {
      const init = await initPaymentSheet(flowSheetParams(preview, setup));
      if (!init.error) {
        const presented = await presentPaymentSheet();
        if (!presented.error) await confirmPaymentSheetPayment();
      }
    }
    onPress();
  };
  return <Button label={preview ? flowButtonLabel(preview) : "Pay"} disabled={disabled} onPress={() => void press()} />;
}
