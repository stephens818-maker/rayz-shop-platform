import { useStripe } from "@stripe/stripe-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Button, useI18n } from "@rayz/ui";
import { api } from "./net";
import { skipNativeSheet } from "./flow-controller";

interface Added {
  id: string;
  brand: string;
  last4: string;
  funding: string;
  wallet: boolean;
}

interface Setup {
  paymentMethod: Added;
  clientSecret: string;
  ephemeralKey: string;
  customerId: string;
}

/**
 * FlowController (customFlow) opens only for a live SetupIntent.
 * Sandbox secrets start with seti_test_ and never collect a PAN.
 * Brand and last4 are whatever Stripe returned.
 */
export function AddCard({ token, onAdded }: { token: string; onAdded: (card: Added) => void }) {
  const { t } = useI18n();
  const { initPaymentSheet, presentPaymentSheet, confirmPaymentSheetPayment } = useStripe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = () => {
    setBusy(true);
    setError("");
    void api<Setup>("/api/v1/me/payment-methods/setup", token, {
      method: "POST",
      body: JSON.stringify({ funding: "credit" }),
    })
      .then(async (body) => {
        if (!skipNativeSheet(body.clientSecret)) {
          const init = await initPaymentSheet({
            setupIntentClientSecret: body.clientSecret,
            customerEphemeralKeySecret: body.ephemeralKey,
            customerId: body.customerId,
            merchantDisplayName: "Ray'z",
            customFlow: true,
            primaryButtonLabel: "Save card",
          });
          if (!init.error) {
            const presented = await presentPaymentSheet();
            if (!presented.error) await confirmPaymentSheetPayment();
          }
        }
        onAdded(body.paymentMethod);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")))
      .finally(() => setBusy(false));
  };

  return (
    <View style={{ gap: 10 }}>
      <Button label={t("addCard")} kind="secondary" disabled={busy} onPress={add} />
      {error ? <Button label={error} kind="ghost" onPress={() => setError("")} /> : null}
    </View>
  );
}
