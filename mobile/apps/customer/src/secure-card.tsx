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

/** Sandbox instruments. There is no card-number field. */
export function TestCardPicker({ token, onAdded }: { token: string; onAdded: (card: Added) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = (funding: "credit" | "debit", wallet: boolean) => {
    setBusy(true);
    setError("");
    void api<{ paymentMethod: Added }>("/api/v1/me/payment-methods/setup", token, {
      method: "POST",
      body: JSON.stringify({ funding, wallet }),
    })
      .then((body) => onAdded(body.paymentMethod))
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
