import { useStripe } from "@stripe/stripe-react-native";
import { useState } from "react";
import { View } from "react-native";
import { Button, useI18n } from "@rayz/ui";
import { api } from "./net";

interface Added {
  id: string;
  brand: string;
  last4: string;
  funding: string;
  wallet: boolean;
}

/**
 * Asks Stripe's sheet only when the server returns a real SetupIntent.
 * The sandbox secret never collects a PAN; the app stores brand and last4.
 */
export function TestCardPicker({ token, onAdded }: { token: string; onAdded: (card: Added) => void }) {
  const { t } = useI18n();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = (funding: "credit" | "debit", wallet: boolean) => {
    setBusy(true);
    setError("");
    void api<{ paymentMethod: Added; clientSecret?: string }>("/api/v1/me/payment-methods/setup", token, {
      method: "POST",
      body: JSON.stringify({ funding, wallet }),
    })
      .then(async (body) => {
        const secret = body.clientSecret ?? "";
        if (secret && !secret.startsWith("seti_test_sandbox")) {
          const init = await initPaymentSheet({ setupIntentClientSecret: secret, merchantDisplayName: "Ray'z" });
          if (!init.error) await presentPaymentSheet();
        }
        onAdded(body.paymentMethod);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")))
      .finally(() => setBusy(false));
  };

  return (
    <View style={{ gap: 10 }}>
      <Button label={t("visaCredit")} kind="secondary" disabled={busy} onPress={() => add("credit", false)} />
      <Button label={t("mcDebit")} kind="secondary" disabled={busy} onPress={() => add("debit", false)} />
      <Button label={t("testWallet")} kind="ghost" disabled={busy} onPress={() => add("credit", true)} />
      {error ? <Button label={error} kind="ghost" onPress={() => setError("")} /> : null}
    </View>
  );
}
