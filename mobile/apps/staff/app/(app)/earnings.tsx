import {
  createStaffClient,
  formatCents,
  formatHours,
  formatLongDate,
  LATE_ADJUSTMENT_COPY,
  rangeForPreset,
  type EarningsDay,
  type EarningsResponse,
  type EarningsTicket,
  type PayrollStatus,
  type RangePreset,
  type SavedRange,
} from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Card, Chip, Display, Field, Loading, Money, ScrollScreen, useI18n, type CopyKey } from "@rayz/ui";
import { earningsView, payoutStatusLabel, transferStatusLabel } from "../../src/earnings-view";
import { API_URL } from "../../src/net";
import { RangeCalendar } from "../../src/range-calendar";
import { RANGE_KEY, loadRange } from "../../src/range-store";
import { useStaff } from "../../src/session";
import { chicagoToday } from "../../src/today";

const PRESETS: Exclude<RangePreset, "custom">[] = ["current_period", "last_period", "this_week", "last_week", "month_to_date"];

function presetKey(preset: RangePreset): CopyKey {
  if (preset === "current_period") return "currentPeriod";
  if (preset === "last_period") return "lastPeriod";
  if (preset === "this_week") return "thisWeek";
  if (preset === "last_week") return "lastWeek";
  if (preset === "month_to_date") return "monthToDate";
  return "custom";
}

function payrollKey(status: PayrollStatus): CopyKey {
  if (status === "not_yet_processed") return "notYet";
  if (status === "sent_to_payroll") return "sentPayroll";
  return "paidCheck";
}

export default function Earnings() {
  const { t } = useI18n();
  const { session, stepUp, elevate } = useStaff();
  const today = useMemo(() => chicagoToday(), []);
  const [range, setRange] = useState<SavedRange>(() => loadRange(null, today));
  const [custom, setCustom] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(RANGE_KEY);
    setRange(loadRange(raw, today));
  }, [today]);

  const choose = (next: SavedRange) => {
    setRange(next);
    setDay(null);
    if (typeof localStorage !== "undefined") localStorage.setItem(RANGE_KEY, JSON.stringify(next));
  };

  const client = useMemo(
    () => createStaffClient(API_URL, () => session?.token ?? null, () => stepUp),
    [session?.token, stepUp],
  );

  const earnings = useQuery({
    queryKey: ["earnings", session?.token, stepUp, range.from, range.to],
    enabled: Boolean(session && stepUp),
    queryFn: async () => {
      const result = await client.earnings({ from: range.from, to: range.to });
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? t("retry"));
      return result.data;
    },
  });
  const days = useQuery({
    queryKey: ["earnings-days", session?.token, stepUp, range.from, range.to],
    enabled: Boolean(session && stepUp),
    queryFn: async () => {
      const result = await client.earningsDays({ from: range.from, to: range.to });
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? t("retry"));
      return result.data.days;
    },
  });
  const tickets = useQuery({
    queryKey: ["earnings-tickets", session?.token, stepUp, range.from, range.to, day],
    enabled: Boolean(session && stepUp && day),
    queryFn: async () => {
      const result = await client.earningsTickets({ from: range.from, to: range.to }, day ?? undefined);
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? t("retry"));
      return result.data.tickets;
    },
  });

  const download = (format: "csv" | "pdf") => {
    void client.payrollReport({ from: range.from, to: range.to }, format).then((file) => {
      if (!file.ok || typeof document === "undefined") return;
      const blob = new Blob([file.body], { type: file.contentType ?? (format === "pdf" ? "application/pdf" : "text/csv") });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `payroll-report.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  if (!stepUp) {
    return (
      <ScrollScreen>
        <Display>{t("earnings")}</Display>
        <Body muted>{t("pinHint")}</Body>
        <Field label={t("pinTitle")} value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
        {pinError ? <Banner tone="bad">{pinError}</Banner> : null}
        <Button
          label={t("showEarnings")}
          onPress={() => {
            void elevate(pin)
              .then(() => setPinError(""))
              .catch((err: unknown) => setPinError(err instanceof Error ? err.message : t("retry")));
          }}
        />
      </ScrollScreen>
    );
  }

  const view = earnings.data ? earningsView(earnings.data, (status) => t(payrollKey(status))) : null;

  return (
    <ScrollScreen>
      <Display>{t("earnings")}</Display>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {PRESETS.map((preset) => (
          <Chip
            key={preset}
            label={t(presetKey(preset))}
            selected={range.preset === preset}
            onPress={() => {
              setCustom(false);
              choose({ preset, ...rangeForPreset(preset, today) });
            }}
          />
        ))}
        <Chip label={t("custom")} selected={range.preset === "custom"} onPress={() => setCustom(true)} />
      </View>
      <Body muted>{`${formatLongDate(range.from, "en-US")} – ${formatLongDate(range.to, "en-US")}`}</Body>
      {custom ? (
        <Card>
          <Body>{t("customDates")}</Body>
          <RangeCalendar
            today={today}
            onApply={(from, to) => {
              choose({ preset: "custom", from, to });
              setCustom(false);
            }}
          />
        </Card>
      ) : null}
      {earnings.isLoading ? <Loading label={t("loading")} /> : null}
      {earnings.isError ? <Banner tone="bad">{earnings.error instanceof Error ? earnings.error.message : t("retry")}</Banner> : null}
      {earnings.isError ? <Button label={t("retry")} kind="secondary" onPress={() => earnings.refetch()} /> : null}
      {view ? <Report view={view} data={earnings.data!} days={days.data ?? []} tickets={tickets.data ?? []} day={day} onDay={setDay} /> : null}
      <Button label={t("downloadCsv")} kind="secondary" onPress={() => download("csv")} />
      <Button label={t("downloadPdf")} kind="secondary" onPress={() => download("pdf")} />
    </ScrollScreen>
  );
}

function Report({
  view,
  data,
  days,
  tickets,
  day,
  onDay,
}: {
  view: ReturnType<typeof earningsView>;
  data: EarningsResponse;
  days: EarningsDay[];
  tickets: EarningsTicket[];
  day: string | null;
  onDay: (day: string) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <View style={{ gap: 12 }}>
      {view.isEstimate ? <Chip label={t("estimate")} selected /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {view.periods.map((period) => (
          <Chip key={period.id} label={`${period.payrollLabel}`} selected />
        ))}
      </View>
      <Card>
        <Money cents={view.totalCents} large />
        <Body>{lang === "en" ? data.grossLabel : t("gross")}</Body>
        <Body muted>{view.explanation}</Body>
      </Card>
      <Card>
        <Body>{t("greaterOf")}</Body>
        <Body muted>{view.appliedRule === "hourly" ? t("hourly") : t("commission")}</Body>
        <Body>{`${t("hourly")} ${formatCents(view.hourlyPayCents)}`}</Body>
        <Body>{`${t("commission")} ${formatCents(view.commissionCents)}`}</Body>
        <Body>{`${t("topUp")} ${formatCents(view.topUpCents)}`}</Body>
        <Money cents={view.greaterOfCents} />
        {view.trainingLine ? (
          <>
            <Body>{view.trainingLine}</Body>
            <Money cents={view.trainingPayCents} />
          </>
        ) : null}
      </Card>
      {view.workweeks.map((week) => (
        <Card key={week.id}>
          <Body>{t("workweek")}</Body>
          <Body muted>{`${formatLongDate(week.weekStart, "en-US")} – ${formatLongDate(week.weekEnd, "en-US")}`}</Body>
          <Body>{`${t("production")} ${formatHours(week.productionHours)}`}</Body>
          <Body>{`${t("training")} ${formatHours(week.trainingHours)}`}</Body>
          <Body>{`${t("regular")} ${formatHours(week.regularHours)}`}</Body>
          <Body>{`${t("overtime")} ${formatHours(week.otHours)}`}</Body>
          {week.otLabel ? <Body muted>{week.otLabel}</Body> : null}
        </Card>
      ))}
      {view.otEstimatedCents > 0 ? <Body muted>{`${formatCents(view.otEstimatedCents)} · ${view.otDisclosure}`}</Body> : null}
      <Card>
        <Body>{t("cardTips")}</Body>
        <Money cents={view.cardTipsCents} />
        <Body>{t("cashTips")}</Body>
        <Money cents={view.cashTipsCents} />
      </Card>
      {view.shops.map((shop) => (
        <Card key={shop.shopId}>
          <Body>{shop.shopName}</Body>
          {shop.payrollCopy ? <Banner>{shop.payrollCopy}</Banner> : null}
          <Body muted>{`${t("cardTips")} ${formatCents(shop.cardTipsCents)}`}</Body>
          <Body muted>{`${t("cashTips")} ${formatCents(shop.cashTipsCents)}`}</Body>
        </Card>
      ))}
      <Banner>{view.cashTipReminder}</Banner>
      <Body>{t("tickets")}</Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {days.filter((row) => row.tickets > 0 || row.cardTipsCents > 0 || row.cashTipsCents > 0 || row.productionHours > 0).map((row) => (
          <Chip key={row.date} label={formatLongDate(row.date, "en-US")} selected={day === row.date} onPress={() => onDay(row.date)} />
        ))}
      </View>
      {tickets.map((ticket) => (
        <Card key={ticket.saleId}>
          <Body>{ticket.clientFirstName}</Body>
          <Body muted>{`${ticket.shopName} · ${ticket.serviceName}`}</Body>
          <Body>{`${t("cardTips")} ${formatCents(Math.max(0, ticket.cardTipCents))}`}</Body>
          <Body>{`${t("cashTips")} ${formatCents(Math.max(0, ticket.cashTipCents))}`}</Body>
          {ticket.tipDisposition === "payroll" ? <Body muted>{t("payrollTips")}</Body> : null}
          {ticket.tipDisposition === "stripe" && ticket.transfer ? <Body muted>{transferStatusLabel(ticket.transfer.status)}</Body> : null}
          {ticket.tipDisposition === "stripe" && ticket.payout ? <Body muted>{`${payoutStatusLabel(ticket.payout.status)}${ticket.payout.bankLast4 ? ` · ••${ticket.payout.bankLast4}` : ""}`}</Body> : null}
          {ticket.payout?.failureMessage ? <Banner tone="bad">{ticket.payout.failureMessage}</Banner> : null}
          {ticket.lateDeclaration ? <Body muted>{LATE_ADJUSTMENT_COPY}</Body> : null}
        </Card>
      ))}
      {view.adjustments.concat(view.refunds).map((row) => (
        <Card key={row.id}>
          <Body>{t("adjustments")}</Body>
          <Money cents={row.amountCents} />
          <Body muted>{row.copy}</Body>
          <Body muted>{t("notDeducted")}</Body>
        </Card>
      ))}
    </View>
  );
}
