import { createStaffClient, formatCents, formatLongDate, localeFor, rangeForPreset, type PayoutAccount, type PayoutAccountState } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Card, Chip, Display, Field, Loading, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { payoutStatusLabel, transferStatusLabel } from "../../src/earnings-view";
import { API_URL } from "../../src/net";
import { PAYOUT_COPY, PAYOUT_STATES } from "../../src/payout-copy";
import { useStaff } from "../../src/session";
import { chicagoToday } from "../../src/today";

export default function Payouts() {
  const { t, lang } = useI18n();
  const locale = localeFor(lang);
  const { session, stepUp } = useStaff();
  const today = useMemo(() => chicagoToday(), []);
  const range = rangeForPreset("current_period", today);
  const [setup, setSetup] = useState(false);
  const [amount, setAmount] = useState("20");
  const [quote, setQuote] = useState<{ feeCents: number; deductedFromTipsCents: number; amountCents: number } | null>(null);
  const [message, setMessage] = useState("");
  const client = useMemo(() => createStaffClient(API_URL, () => session?.token ?? null, () => stepUp), [session?.token, stepUp]);

  const account = useQuery({
    queryKey: ["payout-account", session?.token],
    enabled: Boolean(session),
    queryFn: async () => {
      const result = await client.payoutAccount();
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? t("retry"));
      return result.data.account;
    },
  });
  const history = useQuery({
    queryKey: ["payouts", session?.token, stepUp, range.from],
    enabled: Boolean(session && stepUp),
    queryFn: async () => {
      const result = await client.payouts({ from: range.from, to: range.to });
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? t("retry"));
      return result.data;
    },
  });

  const copy = account.data ? PAYOUT_COPY[account.data.state] : null;

  const begin = () => {
    void client.send("/api/staff/v1/me/payout-account/session", { method: "POST" }).then(() => setSetup(true));
  };
  const mark = (state: PayoutAccountState) => {
    void client
      .send("/api/staff/v1/me/payout-account/session/complete", { method: "POST", body: JSON.stringify({ state }) })
      .then(() => {
        setSetup(false);
        return account.refetch();
      });
  };
  const seeFee = () => {
    const amountCents = Math.max(0, Math.round(Number(amount) * 100));
    void client
      .send<{ amountCents: number; feeCents: number; deductedFromTipsCents: number }>("/api/staff/v1/me/instant-payouts/quote", {
        method: "POST",
        body: JSON.stringify({ amountCents }),
      })
      .then((result) => {
        if (result.data) setQuote(result.data);
      });
  };
  const sendNow = () => {
    if (!quote) return;
    void client
      .send("/api/staff/v1/me/instant-payouts", { method: "POST", body: JSON.stringify({ amountCents: quote.amountCents }) })
      .then((result) => {
        if (result.ok) setMessage(t("done"));
      });
  };

  return (
    <ScrollScreen>
      <Display>{t("payouts")}</Display>
      {account.isLoading ? <Loading label={t("loading")} /> : null}
      {copy && account.data ? <AccountCard account={account.data} title={copy.title} body={copy.body} action={copy.action} onAction={begin} /> : null}
      {setup ? (
        <Card>
          <Body>{t("secureSetup")}</Body>
          <Body muted>{t("sandboxSetup")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PAYOUT_STATES.map((state) => (
              <Chip key={state} label={state.replace(/_/g, " ")} onPress={() => mark(state)} />
            ))}
          </View>
        </Card>
      ) : null}
      {account.data?.state === "active" ? (
        <Card>
          <Body>{t("preferences")}</Body>
          <Body muted>{account.data.externalLast4 ? `${t("bankEnding")} ••${account.data.externalLast4}` : ""}</Body>
          <Button
            label={account.data.instantOptIn ? t("instantPayout") : t("standardPayout")}
            kind="secondary"
            onPress={() => {
              void client
                .send("/api/staff/v1/me/payout-preferences", { method: "PATCH", body: JSON.stringify({ instantOptIn: !account.data?.instantOptIn }) })
                .then(() => account.refetch());
            }}
          />
          <Body>{t("instantPayout")}</Body>
          <Field label={t("instantPayout")} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <Button label={t("seeFee")} kind="secondary" onPress={seeFee} />
          {quote ? (
            <>
              <Body>{`${formatCents(quote.feeCents)} fee`}</Body>
              <Body muted>{t("instantHint")}</Body>
              <Body muted>{`${t("notDeducted")} ${formatCents(quote.deductedFromTipsCents)}`}</Body>
              <Button label={t("sendNow")} onPress={sendNow} />
            </>
          ) : null}
        </Card>
      ) : null}
      {history.data && !history.data.tipTransfersEnabled && history.data.payrollCopy ? <Banner>{history.data.payrollCopy}</Banner> : null}
      {history.data?.transfers.map((row) => (
        <Card key={row.id}>
          <Body>{transferStatusLabel(row.status)}</Body>
          <Money cents={Math.max(0, row.amountCents)} />
          {row.arrivalDate ? <Body muted>{formatLongDate(row.arrivalDate.slice(0, 10), locale)}</Body> : null}
        </Card>
      ))}
      {history.data?.payouts.map((row) => (
        <Card key={row.id}>
          <Body>{payoutStatusLabel(row.status)}</Body>
          <Money cents={Math.max(0, row.amountCents)} />
          {row.bankLast4 ? <Body muted>{`••${row.bankLast4}`}</Body> : null}
          {row.failureMessage ? <Banner tone="bad">{row.failureMessage}</Banner> : null}
          {row.arrivalDate ? <Body muted>{formatLongDate(row.arrivalDate.slice(0, 10), locale)}</Body> : null}
        </Card>
      ))}
      {message ? <Banner tone="good">{message}</Banner> : null}
    </ScrollScreen>
  );
}

function AccountCard({
  account,
  title,
  body,
  action,
  onAction,
}: {
  account: PayoutAccount;
  title: string;
  body: string;
  action: string | null;
  onAction: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <Body>{title}</Body>
      <Body muted>{body}</Body>
      {account.state !== "active" ? <Banner>{t("owedPayroll")}</Banner> : null}
      {account.externalLast4 ? <Body>{`${t("bankEnding")} ••${account.externalLast4}`}</Body> : null}
      {action ? <Button label={action === "Set up" ? t("setupDeposits") : t("continueSetup")} onPress={onAction} /> : null}
    </Card>
  );
}
