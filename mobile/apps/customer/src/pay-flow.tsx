import type { PaymentPreview } from "@rayz/api";
import { Button } from "@rayz/ui";
import { flowButtonLabel } from "./flow-controller";

/** Web never imports the Stripe native SDK. The fee is on this button before confirm. */
export function PayConfirm({
  preview,
  disabled,
  onPress,
}: {
  preview: Pick<PaymentPreview, "feeCents" | "feeLabel" | "totalCents"> | null;
  disabled: boolean;
  onPress: () => void;
  setup?: { clientSecret: string; ephemeralKey: string; customerId: string } | null;
}) {
  return <Button label={preview ? flowButtonLabel(preview) : "Pay"} disabled={disabled} onPress={onPress} />;
}
