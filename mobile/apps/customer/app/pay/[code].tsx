import { formatCents, type PaymentPreview } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Card, Chip, Display, Loading, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { payModel } from "../../src/pay-model";
import { api } from "../../src/net";
import { TestCardPicker } from "../../src/secure-card";
import { useSession } from "../../src/session";

interface Method { id: string; brand: string; last4: string; funding: string; wallet: boolean }

const TIPS = [0, 300, 500, 800];

export default function Pay() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [method, setMethod] = useState<Method | null>(null);
  const [tip, setTip] = useState(500);
  const [paid, setPaid] = useState<{ totalCents: number; feeCents: number; tender: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const idem = useMemo(() => `pay-${code}-${Date.now()}`, [code]);

  const cards = useQuery({
    queryKey: ["cards", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ paymentMethods: Method[] }>("/api/v1/me/payment-methods", session?.token),
  });
  const chosen = method ?? cards.data?.paymentMethods[0] ?? null;
  const preview = useQuery({
    queryKey: ["preview", code, chosen?.id, tip, chosen?.wallet],
    enabled: Boolean(session && chosen),
    queryFn: () =>
      api<PaymentPreview>(`/api/v1/appointments/${code}/payment-preview`, session?.token, {
        method: "POST",
        body: JSON.stringify({ paymentMethodId: chosen?.id, tipCents: tip, wallet: chosen?.wallet ?? false }),
      }),
  });
  const model = preview.data ? payModel(preview.data) : null;

  const pay = () => {
    if (!session || !chosen) return;
    setBusy(true);
    setError("");
    void api<{ totalCents: number; feeCents: number; tender: string }>(`/api/v1/appointments/${code}/payments`, session.token, {
      method: "POST",
      headers: { "Idempotency-Key": idem },
      body: JSON.stringify({ paymentMethodId: chosen.id, tipCents: tip, wallet: chosen.wallet }),
    })
      .then((body) => setPaid(body))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")))
      .finally(() => setBusy(false));
  };

  if (!session) {
    return (
      <ScrollScreen>
        <Display>{t("pay")}</Display>
        <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{paid ? t("paidTitle") : t("pay")}</Display>
      {paid ? (
        <Card>
          <Money cents={paid.totalCents} large />
          <Body muted>{paid.tender || `${chosen?.brand ?? ""} ••${chosen?.last4 ?? ""}`}</Body>
          <Button label={t("done")} onPress={() => router.replace("/(app)/home")} />
        </Card>
      ) : (
        <>
          <Body>{t("addTestCard")}</Body>
          <TestCardPicker token={session.token} onAdded={(card) => { setMethod(card); void cards.refetch(); }} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {cards.data?.paymentMethods.map((card) => (
              <Chip key={card.id} label={`${card.brand} ••${card.last4}`} selected={chosen?.id === card.id} onPress={() => setMethod(card)} />
            ))}
          </View>
          <Body>{t("tip")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {TIPS.map((cents) => (
              <Chip key={cents} label={formatCents(cents)} selected={tip === cents} onPress={() => setTip(cents)} />
            ))}
          </View>
          {preview.isLoading ? <Loading label={t("loading")} /> : null}
          {preview.data && !preview.data.paymentsEnabled ? <Banner>{preview.data.unavailableCopy ?? t("notLive")}</Banner> : null}
          {model && preview.data?.paymentsEnabled ? (
            <Card>
              {model.lines.map((line) => (
                <View key={line.label} style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 32 }}>
                  <Body>{line.label}</Body>
                  <Body>{formatCents(line.cents)}</Body>
                </View>
              ))}
              {model.showFee && model.disclosure ? <Banner>{model.disclosure}</Banner> : <Body muted>{t("noFee")}</Body>}
              {model.tipTransferCopy ? <Body muted>{model.tipTransferCopy}</Body> : null}
              <Body muted>{t("pay")}</Body>
              <Money cents={model.totalCents} large />
            </Card>
          ) : null}
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <Button label={t("payButton")} disabled={busy || !model || !preview.data?.paymentsEnabled} onPress={pay} />
        </>
      )}
    </ScrollScreen>
  );
}
