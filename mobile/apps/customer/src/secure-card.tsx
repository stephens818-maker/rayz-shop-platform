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
 * One hosted-card action. Brand and last4 come back from Stripe's published test method.
 * The request never sends a number, brand, or last4.
 */
export function AddCard({ token, onAdded }: { token: string; onAdded: (card: Added) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = () => {
    setBusy(true);
    setError("");
    void api<{ paymentMethod: Added }>("/api/v1/me/payment-methods/setup", token, {
      method: "POST",
      body: JSON.stringify({ funding: "credit" }),
    })
      .then((body) => onAdded(body.paymentMethod))
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
