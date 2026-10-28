import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, cx } from "@/components/ui";
import { formatPayHours } from "@/lib/hours";
import { COLUMN_LABEL, EXPORT_COLUMNS, FT_BASIS_LABEL, HOUR_COLUMNS, TRAINING_RATE_SOURCE, fmtHours, fmtMoney, type Line, type Totals } from "@/domain/payroll/calc";
import { formatDate, formatDateTime } from "@/lib/time";
import { reportView } from "@/domain/permissions";
import { type ClientCounts, type Pph, type PphRank, PPH_RANKS, RANK_LABEL, clientKey, clientsText, linePph, linesPph, pphOf, pphText, workedHoursOf } from "@/domain/pph";
import { blockTickets } from "@/server/service-tickets";
import { can, guardPage } from "@/server/auth/staff";
import { approvalBlocked, approvalOf, approvalStatus, buildPayroll, hoursOpenMessage, squireMissingMessage, payrollTrail, periodChoices, periodKey, preparersOf, RECORD_LABEL, SELF_APPROVAL, type ApprovalStatus, type PeriodChoice, type ApprovalView, type BlockView, type PayrollView } from "@/server/payroll/run";
import { ApprovalControls } from "./approval";
import { LateCommissionForm, OverrideForm } from "./client";
import { ApprovalNotice, PayrollTrailCard } from "./flow";

export const metadata: Metadata = { title: "Payroll report" };

const hrs = (x: number) => formatPayHours(x);
const hrsH = (x: number) => formatPayHours(x, { unit: true });
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);
const ratio = (x: number | null) => (x === null ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cell = (k: string, v: number) => (HOUR_COLUMNS.has(k) ? hrs(v) : fmtMoney(v));
/** The iSolved file's own numbers: hours stay decimal there whatever the screen shows. */
const fileCell = (k: string, v: number) => (HOUR_COLUMNS.has(k) ? formatPayHours(v, { style: "decimal" }) : fmtMoney(v));

const pphCell = (v: number | null) => pphText(v, fmtMoney);
const rankCell = (p: Pph, m: PphRank) => (m === "clients" ? clientsText(p.clientsPerHour) : pphCell(pphOf(p, m)));

type Col = {
  key: (keyof Line & string) | `${PphRank}Pph`;
  label: string;
  fmt: (l: Line, tickets: ClientCounts) => string;
  total?: (t: Totals, b: BlockView, tickets: ClientCounts) => string;
  extra?: boolean;
  onlyIf?: (b: BlockView) => boolean;
};
/** Review only: never in the workbook or the iSolved file. Totals are the block's sales (or tickets) over its worked hours. */
const PPH_COLS: Col[] = PPH_RANKS.map((m) => ({
  key: `${m}Pph` as const,
  label: RANK_LABEL[m],
  fmt: (l: Line, tickets: ClientCounts) => rankCell(linePph(l, tickets), m),
  total: (_: Totals, b: BlockView, tickets: ClientCounts) => rankCell(linesPph(b.lines, tickets), m),
  extra: true,
}));
const COLS: Col[] = [
  { key: "hours", label: COLUMN_LABEL.hours, fmt: (l) => hrs(l.hours), total: (t) => hrs(t.hours) },
  { key: "wage", label: COLUMN_LABEL.wage, fmt: (l) => fmtMoney(l.wage) },
  { key: "hourlyTotal", label: COLUMN_LABEL.hourlyTotal, fmt: (l) => fmtMoney(l.hourlyTotal), total: (t) => fmtMoney(t.hourlyTotal) },
  { key: "service", label: COLUMN_LABEL.service, fmt: (l) => fmtMoney(l.service), total: (t) => fmtMoney(t.service) },
  { key: "grossPerHour", label: COLUMN_LABEL.grossPerHour, fmt: (l) => ratio(l.grossPerHour), total: (t) => ratio(t.grossPerHour) },
  { key: "servicePct", label: COLUMN_LABEL.servicePct, fmt: (l) => pct(l.servicePct) },
  { key: "commission", label: COLUMN_LABEL.commission, fmt: (l) => fmtMoney(l.commission), total: (t) => fmtMoney(t.commission) },
  { key: "serviceTotal", label: COLUMN_LABEL.serviceTotal, fmt: (l) => fmtMoney(l.serviceTotal), total: (t) => fmtMoney(t.serviceTotal) },
  { key: "product", label: COLUMN_LABEL.product, fmt: (l) => fmtMoney(l.product), total: (t) => fmtMoney(t.product) },
  { key: "productPct", label: COLUMN_LABEL.productPct, fmt: (l) => pct(l.productPct) },
  { key: "productTotal", label: COLUMN_LABEL.productTotal, fmt: (l) => fmtMoney(l.productTotal), total: (t) => fmtMoney(t.productTotal) },
  { key: "netComm", label: COLUMN_LABEL.netComm, fmt: (l) => fmtMoney(l.netComm), total: (t) => fmtMoney(t.netComm) },
  { key: "totalWages", label: COLUMN_LABEL.totalWages, fmt: (l) => fmtMoney(l.totalWages), total: (t) => fmtMoney(t.totalWages) },
  { key: "pctOfGross", label: COLUMN_LABEL.pctOfGross, fmt: (l) => pct(l.pctOfGross), total: (t) => pct(t.pctOfGross) },
  { key: "ptoHours", label: COLUMN_LABEL.ptoHours, fmt: (l) => hrs(l.ptoHours), total: (t) => hrs(t.ptoHours) },
  { key: "otHours", label: COLUMN_LABEL.otHours, fmt: (l) => hrs(l.otHours), total: (t) => hrs(t.otHours) },
  { key: "tips", label: COLUMN_LABEL.tips, fmt: (l) => fmtMoney(l.tips), total: (t) => fmtMoney(t.tips) },
  { key: "trainingHours", label: COLUMN_LABEL.trainingHours, fmt: (l) => hrs(l.trainingHours), total: (t) => hrs(t.trainingHours) },
  { key: "otPay", label: COLUMN_LABEL.otPay, fmt: (l) => fmtMoney(l.otPay), total: (t) => fmtMoney(t.otPay), extra: true },
  { key: "trainingPay", label: COLUMN_LABEL.trainingPay, fmt: (l) => fmtMoney(l.trainingPay), total: (t) => fmtMoney(t.trainingPay), extra: true },
  {
    key: "guaranteeTopUp",
    label: COLUMN_LABEL.guaranteeTopUp,
    fmt: (l) => fmtMoney(l.guaranteeTopUp),
    total: (t) => fmtMoney(t.guaranteeTopUp),
    extra: true,
    onlyIf: (b) => b.lines.some((l) => l.guaranteeTopUp),
  },
  { key: "laborCost", label: COLUMN_LABEL.laborCost, fmt: (l) => fmtMoney(l.laborCost), total: (t) => fmtMoney(t.laborCost), extra: true },
  { key: "tipsOutside", label: COLUMN_LABEL.tipsOutside, fmt: (l) => fmtMoney(l.tipsOutside), total: (t) => fmtMoney(t.tipsOutside), extra: true },
  { key: "tipsInPayroll", label: COLUMN_LABEL.tipsInPayroll, fmt: (l) => fmtMoney(l.tipsInPayroll), total: (t) => fmtMoney(t.tipsInPayroll), extra: true },
  { key: "tipsPaidOut", label: COLUMN_LABEL.tipsPaidOut, fmt: (l) => fmtMoney(l.tipsPaidOut), total: (t) => fmtMoney(t.tipsPaidOut), extra: true },
  {
    key: "declaredCashTips",
    label: COLUMN_LABEL.declaredCashTips,
    fmt: (l) => fmtMoney(l.declaredCashTips),
    total: (t) => fmtMoney(t.declaredCashTips),
    extra: true,
    onlyIf: (b) => b.lines.some((l) => l.declaredCashTips),
  },
  {
    key: "lateTipRefunds",
    label: COLUMN_LABEL.lateTipRefunds,
    fmt: (l) => fmtMoney(l.lateTipRefunds),
    total: (t) => fmtMoney(t.lateTipRefunds),
    extra: true,
    onlyIf: (b) => b.lines.some((l) => l.lateTipRefunds),
  },
  {
    key: "tipRefundsShopCost",
    label: COLUMN_LABEL.tipRefundsShopCost,
    fmt: (l) => fmtMoney(l.tipRefundsShopCost),
    total: (t) => fmtMoney(t.tipRefundsShopCost),
    extra: true,
    onlyIf: (b) => b.lines.some((l) => l.tipRefundsShopCost),
  },
  ...PPH_COLS,
];
const colsFor = (b: BlockView) => COLS.filter((c) => !c.onlyIf || c.onlyIf(b));

export default async function PayrollReportPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/payroll/report");
  const choices = await periodChoices();
  const current = choices.findIndex((c) => c.current);
  const chosen = choices.find((c) => c.key === sp.period) ?? choices[current + 1] ?? choices[0];
  const view = chosen ? await buildPayroll(chosen.start, chosen.end) : null;
  const [approval, trail, preparers, tickets] = view
    ? await Promise.all([approvalOf(view), payrollTrail(view.start, view.end), preparersOf(view.start, view.end), blockTickets(view.blocks)])
    : [null, [], [], new Map<string, number>()];
  const selfPrepared = !ctx.isOwner && preparers.some((p) => p.staffId === ctx.actor.staffId);
  const status = view ? approvalStatus(view, approval) : "draft";
  const canRun = can(ctx, "payroll.run");
  const canApprove = can(ctx, "payroll.approve");
  const isolved = chosen && can(ctx, reportView("payroll_isolved")) ? `/admin/reports/payroll/isolved?preset=pp:${chosen.start}_${chosen.end}` : null;
  const reportLink = chosen && can(ctx, reportView("payroll_report")) ? `/admin/reports/payroll/report?period=${chosen.key}` : null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Payroll report"
        subtitle={
          chosen && (
            <>
              {formatDate(chosen.start, "MMM d")} – {formatDate(chosen.end, "MMM d, yyyy")} · {periodNumbers(chosen.groups)} · bi-weekly, Sunday to Saturday
            </>
          )
        }
        actions={
          view && view.locked === "none" && canApprove ? (
            <ApprovalControls
              start={view.start}
              end={view.end}
              label={`${formatDate(view.start, "MMM d")} – ${formatDate(view.end, "MMM d")} for ${view.blocks.length} shop${view.blocks.length === 1 ? "" : "s"}`}
              status={status}
              blocked={approvalBlocked(view)}
              approveBlocked={selfPrepared ? SELF_APPROVAL : null}
            />
          ) : undefined
        }
      />
      <div className="no-print mb-4 flex flex-wrap gap-1.5">
        {choices.slice(0, 8).map((c) => (
          <Link
            key={c.key}
            href={`/admin/payroll/report?period=${c.key}`}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", c.key === chosen?.key ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.current && " · current"}
            {c.lockedGroups > 0 && (c.lockedGroups === c.groups.length ? " · locked" : ` · ${c.lockedGroups} locked`)}
          </Link>
        ))}
        {reportLink && (
          <Link href={reportLink} className="ml-auto self-center text-sm font-medium text-brand-700 underline-offset-2 hover:underline" data-testid="payroll-report-link">
            Payroll Report (Locations) →
          </Link>
        )}
        {isolved && (
          <Link href={isolved} className="self-center text-sm font-medium text-brand-700 underline-offset-2 hover:underline" data-testid="payroll-isolved-link">
            iSolved export and payroll reports →
          </Link>
        )}
      </div>
      {!view ? (
        <Notice>No shop has a pay period with those dates.</Notice>
      ) : (
        <Report
          view={view}
          canRun={canRun}
          canFiles={canRun || can(ctx, "payroll.export")}
          approval={approval}
          status={status}
          trail={trail}
          preparers={preparers}
          earlier={choices.filter((c) => c.start < view.start && c.lockedGroups > 0).slice(0, 6)}
          tickets={tickets}
        />
      )}
    </div>
  );
}

function periodNumbers(groups: { label: string; number: number; checkDate: string; submitBy: string }[]) {
  const by = new Map<string, string[]>();
  for (const g of groups) {
    const k = `period ${String(g.number).padStart(2, "0")}, due in iSolved ${formatDate(g.submitBy, "EEE MMM d")}, check ${formatDate(g.checkDate, "EEE MMM d")}`;
    by.set(k, [...(by.get(k) ?? []), g.label]);
  }
  const parts = [...by.entries()];
  return parts.length === 1 ? parts[0][0] : parts.map(([k, labels]) => `${labels.join(", ")}: ${k}`).join(" · ");
}

function Report({
  view,
  canRun,
  canFiles,
  approval,
  status,
  trail,
  preparers,
  earlier,
  tickets,
}: {
  view: PayrollView;
  canRun: boolean;
  canFiles: boolean;
  approval: ApprovalView | null;
  status: ApprovalStatus;
  trail: Awaited<ReturnType<typeof payrollTrail>>;
  preparers: readonly { staffId: string; label: string }[];
  earlier: readonly PeriodChoice[];
  tickets: ClientCounts;
}) {
  const filesReady = status === "approved" || status === "locked";
  return (
    <div className="space-y-4">
      <ApprovalNotice view={view} approval={approval} status={status} preparers={preparers} />
      {view.locked === "all" ? null : view.mismatches.length ? (
        <Card>
          <CardHeader title="Totals don't reconcile: approval is blocked" subtitle={`Every total has to equal the sum of its rows, each shop's export has to add up to the report, and the Locations totals to the shops.${view.tips.mismatches.length ? " Each employee's tips in the file have to match their tips and payouts (the W-2 tip check)." : ""} Tolerance: $0.00.`} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-red-50 text-left text-xs text-red-800">
                <tr>
                  <th className="px-3 py-2">Where</th>
                  <th className="px-3 py-2">Column</th>
                  <th className="px-3 py-2 text-right">Report</th>
                  <th className="px-3 py-2 text-right">Should be</th>
                  <th className="px-3 py-2 text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {view.mismatches.map((m, i) => (
                  <tr key={i} className="border-t border-zinc-100">
                    <td className="px-3 py-1.5">{m.detail}</td>
                    <td className="px-3 py-1.5">{m.column}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{m.report.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{m.other.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums text-red-700">{(m.report - m.other).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Notice tone="green">
          Every total reconciles to the cent: each shop&apos;s totals are the sum of its rows, each shop&apos;s iSolved file adds up to its report columns, and the Locations totals are the sum
          of the shops.{view.locked === "some" && " Some shops in this period are already locked."}
        </Notice>
      )}

      <SquireGate view={view} />

      <HoursGate view={view} />

      <LockCheck view={view} />

      <TipCheckNotice view={view} />

      <Locations view={view} tickets={tickets} />

      <EntityStates view={view} />

      {view.anomalies.length > 0 && (
        <Card>
          <CardHeader title={`Anomalies (${view.anomalies.length})`} subtitle="For review. None of these block the lock and none are changed automatically." />
          <ul className="divide-y divide-zinc-100 text-sm">
            {view.anomalies.map((a, i) => (
              <li key={i} className="flex gap-2 px-4 py-2">
                <Badge tone={a.kind === "below_minimum_wage" || a.kind === "meal_missed" || a.kind === "missed_punch" ? "red" : AMBER.has(a.kind) ? "amber" : "gray"}>{a.kind.replace(/_/g, " ")}</Badge>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Notice tone="blue">
        O.T. HRS come from the cross-shop rule: each Sunday–Saturday week, hours at every shop of the same legal entity add up, everything over {view.settings.otThresholdHours} is overtime, and
        it&apos;s shared out to the shops by their share of that week&apos;s hours. O.T. Pay is {view.settings.otMultiplier} × base rate × those hours and is labor cost here; iSolved computes the
        real OT itself (it may compute blended OT higher). The iSolved files carry OT <strong>hours</strong> only. Training Pay is training hours × each person&apos;s training rate, outside the greater-of, and in labor cost; the files carry
        training hours in E_Training_Hours. Export values go out {view.settings.roundExport2dp ? "rounded to 2 decimals, half up" : "unrounded, exactly as computed"}.
      </Notice>

      {view.blocks.map((b) => (
        <ShopBlockCard
          key={b.shopId}
          b={b}
          view={view}
          canRun={canRun}
          tickets={tickets}
          downloadable={canFiles && filesReady}
          earlier={earlier.filter((c) => c.groups.some((g) => g.id === b.payGroupId)).map((c) => ({ start: c.start, label: `${formatDate(c.start, "MMM d")} – ${formatDate(c.end, "MMM d, yyyy")}` }))}
        />
      ))}

      <PayrollTrailCard trail={trail} names={new Map(view.blocks.flatMap((b) => b.lines.map((l) => [l.staffId, l.name] as const)))} />
    </div>
  );
}

const AMBER = new Set(["owner_case", "netcomm_gap", "below_punches", "sales_without_hours", "sales_day_without_hours", "timesheet_not_approved", "hours_not_locked", "hours_not_from_clock", "cross_source_ot", "rollout_source", "sunday_punch"]);

function SquireGate({ view }: { view: PayrollView }) {
  if (!view.squireMissing.length || view.locked === "all") return null;
  return (
    <Card>
      <CardHeader title="Squire data isn't imported: approve and lock is blocked" subtitle={squireMissingMessage(view.squireMissing)} />
      <div className="px-4 py-2 text-sm">
        <Link href="/admin/rollout" className="text-brand-700 underline-offset-2 hover:underline">
          Rollout →
        </Link>
      </div>
    </Card>
  );
}

function HoursGate({ view }: { view: PayrollView }) {
  if (!view.hoursOpen.length || view.locked === "all") return null;
  const blocking = view.settings.hoursFromClock;
  return (
    <Card>
      <CardHeader
        title={blocking ? "Hours aren't locked on the time clock: approve and lock is blocked" : "Hours aren't locked on the time clock"}
        subtitle={
          blocking
            ? `${hoursOpenMessage(view.hoursOpen)} A timesheet is approved once its missed punches are fixed; the period locks once every timesheet with hours is approved.`
            : "Payroll Setup has hours from the time clock off, so this doesn't block the lock, but these hours can still change afterwards."
        }
      />
      <ul className="divide-y divide-zinc-100 text-sm">
        {view.hoursOpen.map((o) => (
          <li key={o.shopId} className="px-4 py-2">
            <span className="font-medium">{o.shop}</span>: {o.periods.map((p) => `${formatDate(p.start, "MMM d")} – ${formatDate(p.end, "MMM d")}`).join(" and ")} not locked
            {o.waiting.length > 0 && `; waiting on a manager: ${o.waiting.join(", ")}`}.{" "}
            <Link href={`/admin/timesheets?period=${o.periods[0].start}&shop=${o.shopId}`} className="text-brand-700 underline-offset-2 hover:underline">
              Timesheets →
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LockCheck({ view }: { view: PayrollView }) {
  const locked = view.blocks.filter((b) => b.lockCheck);
  if (!locked.length) return null;
  const changed = locked.filter((b) => b.lockCheck!.drift.length || b.lockCheck!.importedAfterLock);
  if (!changed.length)
    return (
      <p className="text-xs text-zinc-500">
        Locked inputs unchanged since approval:{" "}
        {locked.map((b) => (
          <span key={b.shopId} className="mr-2 whitespace-nowrap">
            {b.shop} <code className="text-[11px]">{b.lockCheck!.hash.slice(0, 12)}</code>
          </span>
        ))}
      </p>
    );
  return (
    <Card>
      <CardHeader
        title="Changed since the lock"
        subtitle="The files stay exactly as approved. These are changes in the live data since: fix them in the next period in iSolved, or unlock and approve again."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-amber-50 text-left text-xs text-amber-900">
            <tr>
              <th className="px-3 py-2">Shop</th>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Figure</th>
              <th className="px-3 py-2 text-right">As locked</th>
              <th className="px-3 py-2 text-right">Now</th>
            </tr>
          </thead>
          <tbody>
            {changed.flatMap((b) => [
              ...b.lockCheck!.drift.map((d) => (
                <tr key={`${b.shopId}|${d.staffId}|${d.field}`} className="border-t border-zinc-100">
                  <td className="px-3 py-1.5">{b.shop}</td>
                  <td className="px-3 py-1.5">{d.name}</td>
                  <td className="px-3 py-1.5">{RECORD_LABEL[d.field]}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{cell(d.field.endsWith("Hours") ? "hours" : "tips", d.locked)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{cell(d.field.endsWith("Hours") ? "hours" : "tips", d.now)}</td>
                </tr>
              )),
              ...(b.lockCheck!.importedAfterLock
                ? [
                    <tr key={`${b.shopId}|import`} className="border-t border-zinc-100">
                      <td className="px-3 py-1.5">{b.shop}</td>
                      <td className="px-3 py-1.5" colSpan={4}>
                        {b.lockCheck!.importedAfterLock} Squire ticket{b.lockCheck!.importedAfterLock === 1 ? "" : "s"} imported after the lock (reference only, never paid here)
                      </td>
                    </tr>,
                  ]
                : []),
            ])}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-xs text-zinc-500">
        Hash as locked:{" "}
        {changed.map((b) => (
          <span key={b.shopId} className="mr-2 whitespace-nowrap">
            {b.shop} <code className="text-[11px]">{b.lockCheck!.hash.slice(0, 12)}</code> → now <code className="text-[11px]">{b.lockCheck!.liveHash.slice(0, 12)}</code>
          </span>
        ))}
      </p>
    </Card>
  );
}

function TipCheckNotice({ view }: { view: PayrollView }) {
  const { rows } = view.tips;
  if (!rows.length) return null;
  const paid = rows.reduce((a, r) => a + r.paidCents, 0);
  const link = (
    <Link href={`/admin/payroll/tips?period=${periodKey(view.start, view.end)}`} className="font-medium underline">
      Payroll tip report
    </Link>
  );
  const off = rows.filter((r) => r.problems.length).length;
  return off ? (
    <Notice tone="amber">
      W-2 tip check: {off} employee{off === 1 ? "'s" : "s'"} tips in the iSolved file don&apos;t match their tips and payouts. {link}.
    </Notice>
  ) : (
    <Notice tone="green">
      W-2 tip check: all {rows.length} employee{rows.length === 1 ? "'s" : "s'"} tips match to the cent. Tips paid straight to them ({fmtMoney(paid / 100)} paid out so far) go to iSolved as tips
      already received, so payroll includes them in W-2 wages and withholds on them. {link}.
    </Notice>
  );
}

function Locations({ view, tickets }: { view: PayrollView; tickets: ClientCounts }) {
  return (
    <Card>
      <CardHeader
        title="Locations"
        subtitle="Employee Cost is labor cost: Total Wages plus O.T. Pay and Training Pay. Every number is a sum of the shop blocks below. Productivity Per Hour (PPH; review only, never in the iSolved file) is sales over worked hours, and clients per hour completed service tickets over the same hours."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2 text-right">Service Sales</th>
              <th className="px-3 py-2 text-right">Total Wages</th>
              <th className="px-3 py-2 text-right">O.T. Pay</th>
              <th className="px-3 py-2 text-right">Training Pay</th>
              <th className="px-3 py-2 text-right">Employee Cost</th>
              <th className="px-3 py-2 text-right">Gross Profit</th>
              <th className="px-3 py-2 text-right">Cost % of Sales</th>
              {PPH_RANKS.map((m) => (
                <th key={m} className="bg-sky-50 px-3 py-2 text-right text-sky-800">
                  {RANK_LABEL[m]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ...view.blocks.map((b) => ({ name: b.shop, t: b.totals, locked: !!b.locked, pph: linesPph(b.lines, tickets) })),
              { name: "Total", t: view.grand, locked: false, pph: linesPph(view.blocks.flatMap((b) => b.lines), tickets) },
            ].map((r) => (
              <tr key={r.name} className={cx("border-t border-zinc-100", r.name === "Total" && "bg-zinc-50 font-semibold")}>
                <td className="px-3 py-1.5">
                  {r.name} {r.locked && <Badge tone="green">locked</Badge>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.service)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.totalWages)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.otPay)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.trainingPay)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.laborCost)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.t.grossProfit)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.t.service ? r.t.laborCost / r.t.service : null)}</td>
                {PPH_RANKS.map((m) => (
                  <td key={m} className="bg-sky-50/40 px-3 py-1.5 text-right tabular-nums">
                    {rankCell(r.pph, m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** What each legal entity (FEIN) pays in each work state: iSolved withholds by the work location, and each state's filings go per entity. */
function EntityStates({ view }: { view: PayrollView }) {
  if (view.byEntityState.length < 2 && view.byEntityState.every((r) => r.workState)) return null;
  return (
    <Card>
      <CardHeader title="By legal entity and work state" subtitle="Hours are withheld for the state they're worked in (the shop's address), whatever state the employee lives in. Each state's filings go per legal entity." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2">Legal entity</th>
              <th className="px-3 py-2">Work state</th>
              <th className="px-3 py-2">Shops</th>
              <th className="px-3 py-2 text-right">Employees</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2 text-right">Employee Cost</th>
              <th className="px-3 py-2 text-right">Tips</th>
            </tr>
          </thead>
          <tbody>
            {view.byEntityState.map((r) => (
              <tr key={`${r.employerId}|${r.workState}`} className="border-t border-zinc-100">
                <td className="px-3 py-1.5">{r.employer}</td>
                <td className="px-3 py-1.5">{r.workState ?? <Badge tone="amber">not set</Badge>}</td>
                <td className="px-3 py-1.5 text-zinc-600">{r.shops.join(", ")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.employees}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtHours(r.hours)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.laborCost)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.tips)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ShopBlockCard({
  b,
  view,
  canRun,
  tickets,
  downloadable,
  earlier,
}: {
  b: BlockView;
  view: PayrollView;
  canRun: boolean;
  tickets: ClientCounts;
  downloadable: boolean;
  earlier: { start: string; label: string }[];
}) {
  const s = view.settings;
  return (
    <Card>
      <CardHeader
        title={
          <>
            {b.shop}{" "}
            {b.source === "squire" && (
              <Badge tone="blue" className="align-middle">
                From Squire data
              </Badge>
            )}{" "}
            <span className="font-normal text-zinc-500">· pay group {b.payGroup}
            {b.payGroupCode ? ` (iSolved ${b.payGroupCode})` : " (no iSolved code yet)"}
            {b.employer ? ` · ${b.employer.legalName}${b.employer.isolvedCompanyCode ? ` (iSolved ${b.employer.isolvedCompanyCode})` : ""}` : ""}
            {b.workState ? ` · ${b.workState}` : ""} · period {String(b.period.number).padStart(2, "0")}, due {formatDate(b.period.submitBy ?? b.period.checkDate, "EEE MMM d")}, check {formatDate(b.period.checkDate, "EEE MMM d")}</span>
          </>
        }
        subtitle={
          b.locked
            ? `Locked ${formatDateTime(b.locked.at)}${b.locked.by ? ` by ${b.locked.by}` : ""}`
            : b.source === "squire"
              ? b.squireImport
                ? `Open: from Squire's Commissions report (${b.squireImport.fileName ?? "pasted"}, imported ${formatDateTime(b.squireImport.importedAt)}) and overrides. OT, PTO and training hours aren't in Squire's report: type them on the rows.`
                : "Open: payroll comes from Squire this period, and Squire's Commissions report isn't imported yet (Rollout page)."
              : "Open: live from hours, sales and overrides"
        }
        action={
          downloadable ? (
            <a className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/admin/payroll/download?group=${b.payGroupId}&start=${view.start}&end=${view.end}`}>
              Download iSolved file
            </a>
          ) : (
            <span className="text-xs text-zinc-500">The iSolved file downloads once the figures are approved.</span>
          )
        }
      />
      {b.lines.length === 0 ? (
        <p className="px-4 py-3 text-sm text-zinc-500">No hours or sales at {b.shop} in this period. Its file would have the header row only.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
                <tr>
                  <th className="sticky left-0 bg-zinc-50 px-2 py-2">Employee Name</th>
                  {colsFor(b).map((c) => (
                    <th key={c.key} className={cx("px-2 py-2 text-right", c.extra && "bg-sky-50 text-sky-800")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.staffId} className="border-t border-zinc-100">
                    <td className="sticky left-0 bg-white px-2 py-1.5 font-medium">
                      <a href={`#${b.shopId}-${l.staffId}`} className="hover:underline">
                        {l.name}
                      </a>
                      {l.overridden.length > 0 && <span title="Has typed-over values"> ✎</span>}
                    </td>
                    {colsFor(b).map((c) => (
                      <td key={c.key} className={cx("px-2 py-1.5 text-right tabular-nums", c.extra && "bg-sky-50/40", l.overridden.includes(c.key as never) && "bg-amber-50")}>
                        {c.fmt(l, tickets)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold">
                  <td className="sticky left-0 bg-zinc-50 px-2 py-1.5">Total</td>
                  {colsFor(b).map((c) => (
                    <td key={c.key} className="px-2 py-1.5 text-right tabular-nums">
                      {c.total?.(b.totals, b, tickets) ?? ""}
                    </td>
                  ))}
                </tr>
                <tr className="bg-zinc-50">
                  <td className="sticky left-0 bg-zinc-50 px-2 py-1.5">Gross Profit</td>
                  <td colSpan={colsFor(b).length} className="px-2 py-1.5 text-left tabular-nums">
                    {fmtMoney(b.totals.service)} service − {fmtMoney(b.totals.laborCost)} labor cost = <strong>{fmtMoney(b.totals.grossProfit)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-zinc-100 border-t border-zinc-100">
            {b.lines.map((l) => (
              <details key={l.staffId} id={`${b.shopId}-${l.staffId}`} className="group px-4 py-2 text-sm">
                <summary className="cursor-pointer select-none font-medium">
                  {l.name}: {fmtMoney(l.laborCost)} labor cost
                  {view.ft[l.staffId] && (
                    <Badge tone={view.ft[l.staffId].fullTime ? "blue" : "gray"} className="ml-2">
                      {view.ft[l.staffId].fullTime ? "Full time" : "Part time"}
                    </Badge>
                  )}
                </summary>
                <div className="mt-2 grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <p>
                      <span className="font-medium">Labor cost</span> = Total Wages {fmtMoney(l.totalWages)} + O.T. Pay {fmtMoney(l.otPay)} + Training Pay {fmtMoney(l.trainingPay)} ={" "}
                      <strong>{fmtMoney(l.laborCost)}</strong>
                    </p>
                    <p>
                      <span className="font-medium">O.T. Pay</span> = {s.otMultiplier} × {fmtMoney(l.wage)} base rate × {hrs(l.otHours)} OT hours = {fmtMoney(l.otPay)}.{" "}
                      <span className="text-amber-800">iSolved may compute blended OT higher.</span>
                    </p>
                    <p>
                      <span className="font-medium">Training Pay</span>:{" "}
                      {l.trainingRate === undefined
                        ? "left out of labor cost (locked before training pay counted)"
                        : `${hrsH(l.trainingHours)} × ${fmtMoney(l.trainingRate)} ${TRAINING_RATE_SOURCE[l.input.trainingRateSource ?? (l.input.trainingRate === null ? "hourly" : "payroll_setup")]}${(l.input.mixedRates ?? []).includes("trainingRate") ? " (mixed: the rate changed in the period)" : ""} = ${fmtMoney(l.trainingPay)}, outside the greater-of`}
                      {l.otFromTraining ? ` · ${hrsH(l.otFromTraining)} more went over the 40 here and is paid as O.T. hours` : ""}
                      {l.trainingHours > 0 &&
                        (s.trainingCountsTowardOt
                          ? ` · ${hrsH(l.trainingHours - (l.input.trainingOverlapHours ?? 0))} of it counts toward the weekly 40 (on top of clocked hours, C2)`
                          : " · training doesn't count toward the weekly 40 (C2 off, Q11)")}
                    </p>
                    {view.ft[l.staffId] && (
                      <p>
                        <span className="font-medium">{view.ft[l.staffId].fullTime ? "Full time" : "Part time"}</span>: averaged {hrsH(view.ft[l.staffId].averageHours)}/week over the last{" "}
                        {view.ft[l.staffId].weeks} weeks ({FT_BASIS_LABEL[s.ftBasis].toLowerCase()}); full time is more than {s.ftHoursPerWeek}. Pending Charles.
                      </p>
                    )}
                    <p className="text-xs text-zinc-500">
                      Worked {hrsH(l.input.workedHours)} at {b.shop} this period = {hrs(l.hours)} regular + {hrs(l.otHours)} OT. Gross service {fmtMoney(l.service)} (card + cash + gift card,
                      before tax and tips).
                    </p>
                    <p className="text-xs text-zinc-500">
                      <span className="font-medium">PPH</span> (Productivity Per Hour, review only): {fmtMoney(l.service)} service ÷ {hrsH(workedHoursOf(l))} worked ={" "}
                      {pphCell(linePph(l).servicePph)} an hour · {tickets.get(clientKey(l.staffId, b.shopId)) ?? 0} completed service tickets ÷ the same hours ={" "}
                      {clientsText(linePph(l, tickets).clientsPerHour)} clients per hour · product {pphCell(linePph(l).productPph)} · total {pphCell(linePph(l).totalPph)}.
                      {workedHoursOf(l) > 0 ? "" : " N/A: no worked hours here this period."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {(view.weeks[l.staffId] ?? []).length > 0 && (
                      <table className="w-full text-xs">
                        <thead className="text-left text-zinc-500">
                          <tr>
                            <th className="py-1">Week of</th>
                            <th className="py-1">Shop</th>
                            <th className="py-1 text-right">Hours toward 40</th>
                            <th className="py-1 text-right">OT share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.weeks[l.staffId].flatMap((w) => [
                            ...w.slices.map((x, i) => (
                              <tr key={`${w.weekStart}-${i}`} className={cx(!x.inThisRun && "text-zinc-400")}>
                                <td className="py-0.5">{i === 0 ? formatDate(w.weekStart, "MMM d") : ""}</td>
                                <td className="py-0.5">
                                  {x.shop}
                                  {x.periodStart !== view.start && ` (period from ${formatDate(x.periodStart, "MMM d")})`}
                                  {x.locked && " · locked"}
                                </td>
                                <td className="py-0.5 text-right tabular-nums">{hrs(x.basis)}</td>
                                <td className="py-0.5 text-right tabular-nums">{hrs(x.ot)}</td>
                              </tr>
                            )),
                            <tr key={`${w.weekStart}-t`} className="border-b border-zinc-100 font-medium">
                              <td />
                              <td className="py-0.5">All shops</td>
                              <td className="py-0.5 text-right tabular-nums">{hrs(w.basis)}</td>
                              <td className="py-0.5 text-right tabular-nums">{hrs(w.ot)}</td>
                            </tr>,
                          ])}
                        </tbody>
                      </table>
                    )}
                    {(l.otPremiumOwed ?? 0) > 0 && (
                      <p>
                        <span className="font-medium">O.T. premium (regular rate, C1)</span>: {fmtMoney(l.otPremiumOwed ?? 0)} owed on commission
                        {view.settings.otRegularRate === "adjust" ? " · in the iSolved file" : " · not in the iSolved file: enter it in iSolved by hand (Needs Charles)"}
                      </p>
                    )}
                    {(l.commissionWrittenOff ?? 0) > 0 && (
                      <p>
                        <span className="font-medium">Refunds written off</span>: {fmtMoney(l.commissionWrittenOff ?? 0)} (commission can&apos;t go below $0.00; the shop absorbs it)
                      </p>
                    )}
                    {canRun && !b.locked && (earlier.length > 0 || (l.input.lateCommissions?.length ?? 0) > 0) && (
                      <LateCommissionForm shopId={b.shopId} periodStart={view.start} staffId={l.staffId} current={l.input.lateCommissions ?? []} earlier={earlier} />
                    )}
                    {canRun && !b.locked ? (
                      <OverrideForm shopId={b.shopId} periodStart={view.start} staffId={l.staffId} current={l.input.overrides ?? {}} />
                    ) : (
                      Object.entries(l.input.overrides ?? {}).map(([k, o]) => (
                        <p key={k} className="text-xs">
                          Typed over: {k} = {o!.value} ({o!.reason})
                        </p>
                      ))
                    )}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </>
      )}
      <ExportPreview b={b} />
    </Card>
  );
}

function ExportPreview({ b }: { b: BlockView }) {
  return (
    <details className="border-t border-zinc-100 px-4 py-2 text-sm">
      <summary className="cursor-pointer select-none font-medium">
        iSolved file: sheet &quot;{b.exportTab}&quot;, {b.exportRows.length} row{b.exportRows.length === 1 ? "" : "s"}, values exactly as they go in the file
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="whitespace-nowrap font-mono text-[11px]">
          <thead>
            <tr className="bg-zinc-100">
              <th className="px-2 py-1 text-left">Key</th>
              <th className="px-2 py-1 text-left" />
              {(b.exportHeaders ?? EXPORT_COLUMNS.map((c) => c.header)).map((h) => (
                <th key={h} className="px-2 py-1 text-right">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.exportRows.map((r) => (
              <tr key={r.staffId} className="border-t border-zinc-100">
                <td className="px-2 py-0.5">{r.key === null ? <span className="text-red-700">missing</span> : typeof r.key === "string" ? `"${r.key}"` : r.key}</td>
                <td className="px-2 py-0.5">{r.isolvedName}</td>
                {r.values.map((v, i) => (
                  <td key={i} className="px-2 py-0.5 text-right">
                    {String(v)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-zinc-300 text-zinc-500">
              <td className="px-2 py-0.5" colSpan={2}>
                Adds up to (not in the file)
              </td>
              {(b.exportHeaders ?? EXPORT_COLUMNS.map((c) => c.header)).map((h, i) => {
                const from = i < EXPORT_COLUMNS.length ? EXPORT_COLUMNS[i].from : b.exportFrom?.[i - EXPORT_COLUMNS.length];
                return (
                  <td key={h} className="px-2 py-0.5 text-right">
                    {from === "wage" ? "" : fileCell(from ?? "", b.exportRows.reduce((a, r) => a + (r.values[i] ?? 0), 0))}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}
