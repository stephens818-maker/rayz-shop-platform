import { formatCents, type PaymentPreview } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Card, Chip, Display, Loading, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { cardQuoteLabel, chargeMatchesShown, confirmAllowed } from "../../src/flow-controller";
import { payModel, payRows } from "../../src/pay-model";
import { PayConfirm } from "../../src/pay-flow";
import { api } from "../../src/net";
import { AddCard } from "../../src/secure-card";
import { useSession } from "../../src/session";

interface Method { id: string; brand: string; last4: string; funding: string; wallet: boolean }

const TIPS = [0, 300, 500, 800];

export default function Pay() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [method, setMethod] = useState<Method | null>(null);
  const [intent, setIntent] = useState<{ id: string; clientSecret: string; paymentMethodId: string; funding: PaymentPreview["funding"]; feeCents: number; totalCents: number; amountCents: number; status: string } | null>(null);
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
  const cardIds = cards.data?.paymentMethods.map((card) => card.id).join(",") ?? "";
  const quotes = useQuery({
    queryKey: ["quotes", code, tip, cardIds, session?.token],
    enabled: Boolean(session && code && cardIds),
    queryFn: async () => {
      const methods = cards.data?.paymentMethods ?? [];
      return Promise.all(
        methods.map(async (card) => {
          const preview = await api<PaymentPreview>(`/api/v1/appointments/${code}/payment-preview`, session?.token, {
            method: "POST",
            body: JSON.stringify({ paymentMethodId: card.id, tipCents: tip }),
          });
          return { id: card.id, preview };
        }),
      );
    },
  });
  const chosen = method;
  useEffect(() => {
    if (!session || !chosen || !code) return;
    let live = true;
    setIntent(null);
    void api<{ id: string; clientSecret: string; paymentMethodId: string; funding: PaymentPreview["funding"]; feeCents: number; totalCents: number; amountCents: number; status: string }>(
      `/api/v1/appointments/${code}/payment-intents`,
      session.token,
      { method: "POST", body: JSON.stringify({ paymentMethodId: chosen.id, tipCents: tip }) },
    )
      .then((body) => {
        if (live) setIntent(body);
      })
      .catch(() => {
        if (live) setIntent(null);
      });
    return () => {
      live = false;
    };
  }, [session, chosen, tip, code]);
  const quotesReady = Boolean(quotes.data) && !quotes.isFetching && !quotes.isLoading;
  const selectedQuote = quotesReady ? quotes.data?.find((row) => row.id === chosen?.id)?.preview ?? null : null;
  const model = selectedQuote ? payModel(selectedQuote) : null;
  const lines = selectedQuote ? payRows(selectedQuote) : [];
  const displayedTotalCents = selectedQuote && intent && intent.paymentMethodId === chosen?.id ? intent.totalCents : null;
  const gate = confirmAllowed({
    selectedPaymentMethodId: chosen?.id ?? null,
    previewPaymentMethodId: selectedQuote ? chosen?.id ?? null : null,
    previewTotalCents: selectedQuote?.totalCents ?? null,
    displayedTotalCents,
  });
  const pricedPreview = gate.confirm && selectedQuote ? { feeCents: selectedQuote.feeCents, totalCents: selectedQuote.totalCents, funding: selectedQuote.funding } : null;

  const pay = () => {
    if (!session || !intent || !chosen) return;
    if (!selectedQuote || !chargeMatchesShown({ paymentMethodId: chosen.id, totalCents: selectedQuote.totalCents }, { paymentMethodId: intent.paymentMethodId, totalCents: intent.totalCents })) return;
    setBusy(true);
    setError("");
    void api(`/api/v1/appointments/${code}/payment-intents/${intent.id}/confirm`, session.token, { method: "POST" })
      .then(() =>
        api<{ totalCents: number; feeCents: number; tender: string; paymentMethodId: string }>(`/api/v1/appointments/${code}/payments`, session.token, {
          method: "POST",
          headers: { "Idempotency-Key": idem },
          body: JSON.stringify({ paymentIntentId: intent.id }),
        }),
      )
      .then((body) => {
        const shown = { paymentMethodId: chosen.id, totalCents: intent.totalCents };
        if (!chargeMatchesShown(shown, { paymentMethodId: body.paymentMethodId, totalCents: body.totalCents })) {
          setError(t("nothingCharged"));
          return;
        }
        setPaid(body);
      })
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
          <AddCard token={session.token} onAdded={(card) => { setMethod(card); void cards.refetch(); }} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {cards.data?.paymentMethods.map((card) => {
              const quote = quotes.data?.find((row) => row.id === card.id);
              const label = quotesReady && quote ? cardQuoteLabel(card, quote.preview.totalCents) : `${card.brand} ••${card.last4}`;
              return <Chip key={card.id} label={label} selected={chosen?.id === card.id} onPress={() => setMethod(card)} />;
            })}
          </View>
          <Body>{t("tip")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {TIPS.map((cents) => (
              <Chip key={cents} label={formatCents(cents)} selected={tip === cents} onPress={() => setTip(cents)} />
            ))}
          </View>
          {!chosen ? <Body>{t("cardSurchargeNote")}</Body> : null}
          {quotes.isLoading || quotes.isFetching ? <Loading label={t("loading")} /> : null}
          {selectedQuote && !selectedQuote.paymentsEnabled ? <Banner>{selectedQuote.unavailableCopy ?? t("notLive")}</Banner> : null}
          {model && selectedQuote?.paymentsEnabled ? (
            <Card>
              {lines.map((line) => (
                <View key={line.label} style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 32 }}>
                  <Body>{line.label}</Body>
                  <Body>{formatCents(line.cents)}</Body>
                </View>
              ))}
              {model.disclosure ? <Banner>{model.disclosure}</Banner> : <Body muted>{t("noFee")}</Body>}
              {model.tipTransferCopy ? <Body muted>{model.tipTransferCopy}</Body> : null}
            </Card>
          ) : null}
          {error ? <Banner tone="bad">{error}</Banner> : null}
          {chosen ? (
            <PayConfirm
              preview={pricedPreview}
              setup={intent ? { clientSecret: intent.clientSecret } : null}
              disabled={busy || !gate.confirm || !pricedPreview || !selectedQuote?.paymentsEnabled}
              onPress={pay}
              onNothingCharged={() => setError(t("nothingCharged"))}
              onReprice={() => {
                void quotes.refetch();
              }}
              selectedPaymentMethodId={chosen.id}
              pricedPaymentMethodId={selectedQuote ? chosen.id : null}
              previewTotalCents={selectedQuote?.totalCents ?? null}
              displayedTotalCents={displayedTotalCents}
              cardLabel={selectedQuote ? cardQuoteLabel(chosen, selectedQuote.totalCents) : `${chosen.brand} ••${chosen.last4}`}
            />
          ) : null}
        </>
      )}
    </ScrollScreen>
  );
}
