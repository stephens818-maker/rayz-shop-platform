import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { payGroups, payrollEmployers, payrollExportSends, payrollProfiles, staff, timeEntries, tipAbsorptions, tipLedger, tipPayouts, type PayrollSendShop } from "@/db/schema";
import { EXPORT_COLUMNS, PAID_TIP_COLUMNS, PAYROLL_TIP_COLUMNS, extraFromOf, sumColumns, toCents, type Line } from "@/domain/payroll/calc";
import { FLAG_LABEL, FT_LABEL, PUNCH_LABEL, csv, type PunchType } from "@/domain/time-clock";
import type { Permission } from "@/domain/permissions";
import type { BarChart } from "@/domain/report-charts";
import { ABSORPTION_LABEL, TIPS_PAID_STATUS_LABEL, employerTaxIdLabel, tipsPaidStatus, type TipsPaidBuckets, type TipsPaidStatus } from "@/domain/staff-payouts";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { addDays, endOfLocalDay, formatDate, formatDateTime, formatTime, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { AppError } from "@/server/errors";
import type { ReportChart, ReportData, ReportOption } from "@/server/report-data";
import { PAID, rows as sqlRows, uuids } from "@/server/report-sql";
import { itemMix, staffSelection, type ReportScope } from "@/server/reports";
import { ftOverview, hoursSlices, periodFor, punchEditsBetween, scheduledMinutesLeft, shiftsBetween, timesheetList } from "@/server/time-clock";
import { weekStartOf } from "@/domain/payroll/overtime";
import { addIsolvedSheet } from "./export";
import { loadSettings } from "./groups";
import { MAX_REPORT_PERIODS, payPeriodPresets, periodLabel, periodsEnding, type PayPeriodRef } from "./periods";
import { buildPayroll, type BlockView, type PayrollView } from "./run";

/**
 * The payroll reports (Reports → Payroll). iSolved is the payroll company and stays the system of
 * record: it computes paychecks, taxes and blended overtime. These reports show what the platform
 * sends it, pay period by pay period, from the same Payroll Report the period is approved and locked
 * on (a locked shop comes back exactly as approved), so every figure ties to the iSolved file to the
 * cent. Pay periods follow each pay group's calendar (bi-weekly unless Payroll setup says weekly).
 * Brand-only by default; rate and labor cost columns need "See pay rates and labor cost".
 */

export interface PayrollReportInput {
  scope: ReportScope;
  loc: ViewCtx;
  perms?: ReadonlySet<Permission>;
  params?: Record<string, string | undefined>;
  now?: Date;
}

export type ExportStatus = "draft" | "approved" | "sent";
export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = { draft: "Draft", approved: "Approved", sent: "Sent to iSolved" };

interface PeriodRun {
  ref: PayPeriodRef;
  key: string;
  label: string;
  view: PayrollView;
  /** The viewer's shops in the period. */
  blocks: BlockView[];
  /** Their rows, for the employees picked. */
  lines: Line[];
}

const text = (label: string): Column => ({ label });
const int = (label: string): Column => ({ label, kind: "int" });
const money = (label: string): Column => ({ label, kind: "money" });
const rate = (label: string): Column => ({ label, kind: "money", sum: false });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });
/** Hours to the hundredth, as iSolved takes them. */
const hrs = (label: string, sum = true): Column => ({ label, kind: "decimal", sum });
const bool = (label: string): Column => ({ label, kind: "bool", sum: false });

const h2 = (x: number) => Math.round(x * 100) / 100;
const chartMin = (hours: number) => Math.round(hours * 60);
const byText = (i: number) => (a: Cell[], b: Cell[]) => String(a[i] ?? "").localeCompare(String(b[i] ?? ""));
const sumOf = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const yearLabel = (ref: Pick<PayPeriodRef, "start" | "end">) => `${periodLabel(ref)}, ${ref.end.slice(0, 4)}`;
const noBarber = (loc: ViewCtx): ViewCtx => ({ ...loc, byBarber: false });
const combined = (loc: ViewCtx): ViewCtx => ({ ...loc, view: "combined", byBarber: false });

async function labels(ids: Iterable<string>) {
  const list = [...new Set(ids)];
  return new Map((list.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, list)) : []).map((s) => [s.id, s.label]));
}

/** The pay periods that end in the range, each built as on the Payroll Report and cut down to the viewer's shops and the employees picked. */
async function runsIn(scope: ReportScope): Promise<{ runs: PeriodRun[]; capped: boolean }> {
  const { periods, capped } = await periodsEnding(scope.from, scope.to, scope.shopIds);
  const sel = staffSelection(scope);
  const runs: PeriodRun[] = [];
  for (const ref of periods) {
    const view = await buildPayroll(ref.start, ref.end);
    if (!view) continue;
    const blocks = view.blocks.filter((b) => scope.shopIds.includes(b.shopId));
    if (!blocks.length) continue;
    runs.push({ ref, key: `${ref.start}_${ref.end}`, label: yearLabel(ref), view, blocks, lines: blocks.flatMap((b) => b.lines.filter((l) => !sel || sel.includes(l.staffId))) });
  }
  return { runs, capped };
}

function periodNotes(runs: PeriodRun[], capped: boolean): string[] {
  return [
    runs.length
      ? `Covers the ${runs.length === 1 ? "pay period" : `${runs.length} pay periods`} ending in the dates picked: ${runs.map((r) => r.label).join("; ")}. Pay periods follow each shop's pay calendar in Payroll setup (bi-weekly by default).`
      : "No pay period ends in the dates picked. Pick a pay period above, or widen the dates.",
    ...(capped ? [`Only the last ${MAX_REPORT_PERIODS} pay periods are shown; narrow the dates for earlier ones.`] : []),
  ];
}

async function sendsOf(runs: readonly PeriodRun[]) {
  if (!runs.length) return new Map<string, typeof payrollExportSends.$inferSelect & { by: string | null }>();
  const list = await db
    .select({ s: payrollExportSends, by: staff.displayLabel })
    .from(payrollExportSends)
    .leftJoin(staff, eq(staff.id, payrollExportSends.sentBy))
    .where(inArray(payrollExportSends.periodStart, runs.map((r) => r.ref.start)));
  return new Map(list.map((x) => [`${x.s.periodStart}_${x.s.periodEnd}`, { ...x.s, by: x.by }]));
}

const statusOf = (view: Pick<PayrollView, "locked">, sent: boolean): ExportStatus => (sent ? "sent" : view.locked === "all" ? "approved" : "draft");

/** Tips in the tip ledger for a period, per employee and shop, by how they were paid. Gift card tips count with cash. */
async function tipsByMethod(shopIds: string[], start: LocalDate, end: LocalDate, sel: string[] | null) {
  if (!shopIds.length || (sel && !sel.length)) return new Map<string, { card: number; cash: number; adjust: number }>();
  const list = await db
    .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, method: tipLedger.method, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
    .from(tipLedger)
    .where(and(inArray(tipLedger.shopId, shopIds), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end), sel ? inArray(tipLedger.staffId, sel) : undefined))
    .groupBy(tipLedger.shopId, tipLedger.staffId, tipLedger.method);
  const out = new Map<string, { card: number; cash: number; adjust: number }>();
  for (const r of list) {
    const k = `${r.staffId}|${r.shopId}`;
    const v = out.get(k) ?? { card: 0, cash: 0, adjust: 0 };
    if (r.method === "card") v.card += r.cents;
    else if (r.method === "adjust") v.adjust += r.cents;
    else v.cash += r.cents;
    out.set(k, v);
  }
  return out;
}

/** Direct payouts of a period that are paid, per employee and shop, by method. */
function paidDirect(view: PayrollView) {
  const out = new Map<string, { stripe: number; cash: number; stripeCount: number }>();
  for (const r of view.tips.rows) {
    const v = { stripe: 0, cash: 0, stripeCount: 0 };
    for (const p of r.payouts.filter((x) => x.status === "paid")) {
      if (p.method === "stripe") {
        v.stripe += p.tipsCents + p.adjustCents;
        v.stripeCount++;
      } else v.cash += p.tipsCents + p.adjustCents;
    }
    out.set(`${r.staffId}|${r.shopId}`, v);
  }
  return out;
}

const hourlyPay = (l: Line) => toCents(l.hourlyTotal) + toCents(l.otPay) + toCents(l.trainingPay);
/** Gross wages the iSolved file stands for: labor cost (hourly, OT, training, commission, top-ups) and every tip, declared cash tips included. */
const toIsolved = (l: Line) => toCents(l.laborCost) + toCents(l.tips) + toCents(l.declaredCashTips ?? 0);

// ───────────────────────────── Payroll summary ─────────────────────────────

export async function payrollSummaryData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const rates = !!i.perms?.has("payroll.rates");
  const sel = staffSelection(scope);
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const sends = await sendsOf(runs);
  const rowsOut: ListRow[] = [];
  const periodRows: ListRow[] = [];
  const perPeriod: { label: string; hourly: number; comm: number; tips: number }[] = [];
  const perPerson = new Map<string, { name: string; hourly: number; comm: number; tips: number }>();
  for (const r of runs) {
    const [methods, paid] = [await tipsByMethod(r.blocks.map((b) => b.shopId), r.ref.start, r.ref.end, sel), paidDirect(r.view)];
    const status = EXPORT_STATUS_LABEL[statusOf(r.view, sends.has(r.key))];
    for (const l of r.lines) {
      const k = `${l.staffId}|${l.shopId}`;
      const m = methods.get(k) ?? { card: 0, cash: 0, adjust: 0 };
      const tips = toCents(l.tips);
      const stripe = paid.get(k)?.stripe ?? 0;
      rowsOut.push({
        shopId: l.shopId,
        staffId: l.staffId,
        key: l.staffId,
        cells: [
          l.name,
          h2(l.hours),
          h2(l.otHours),
          h2(l.ptoHours),
          h2(l.trainingHours),
          ...(rates ? [toCents(l.wage), hourlyPay(l)] : []),
          toCents(l.commission),
          toCents(l.productTotal),
          toCents(l.netComm),
          m.card,
          m.cash,
          tips - m.card - m.cash,
          tips,
          toCents(l.tipsInPayroll),
          stripe,
          toCents(l.declaredCashTips ?? 0),
          ...(rates ? [toIsolved(l)] : []),
        ],
      });
      const p = perPerson.get(l.staffId) ?? { name: l.name, hourly: 0, comm: 0, tips: 0 };
      p.hourly += hourlyPay(l) + toCents(l.guaranteeTopUp);
      p.comm += toCents(l.netComm);
      p.tips += tips;
      perPerson.set(l.staffId, p);
    }
    for (const b of r.blocks) {
      const mine = r.lines.filter((l) => l.shopId === b.shopId);
      periodRows.push({
        shopId: b.shopId,
        key: r.key,
        cells: [
          r.label,
          status,
          mine.length,
          h2(sumOf(mine, (l) => l.hours)),
          h2(sumOf(mine, (l) => l.otHours)),
          sumOf(mine, (l) => toCents(l.netComm)),
          sumOf(mine, (l) => toCents(l.tips)),
          sumOf(mine, (l) => paid.get(`${l.staffId}|${l.shopId}`)?.stripe ?? 0),
          sumOf(mine, (l) => toCents(l.declaredCashTips ?? 0)),
          ...(rates ? [sumOf(mine, toIsolved)] : []),
        ],
      });
    }
    perPeriod.push({
      label: r.ref.end,
      hourly: sumOf(r.lines, (l) => hourlyPay(l) + toCents(l.guaranteeTopUp)),
      comm: sumOf(r.lines, (l) => toCents(l.netComm)),
      tips: sumOf(r.lines, (l) => toCents(l.tips)),
    });
  }
  const lines = runs.flatMap((r) => r.lines);
  const at = (j: number) => sumOf(rowsOut, (r) => Number(r.cells[rates ? j + 2 : j]));
  const [card, cash, stripe] = [at(8), at(9), at(13)];
  const columns = [
    text("Employee"),
    hrs("Regular hours"),
    hrs("OT hours"),
    hrs("Paid time off hours"),
    hrs("Training hours"),
    ...(rates ? [rate("Hourly rate"), money("Gross hourly pay")] : []),
    money("Service commission"),
    money("Product commission"),
    money("Commission to iSolved (E_Comm Sales)"),
    money("Card tips"),
    money("Cash tips"),
    money("Tip adjustments"),
    money("Tips"),
    money("Tips in payroll"),
    money("Tips already paid via Stripe"),
    money("Cash tips declared"),
    ...(rates ? [money("Total to iSolved")] : []),
  ];
  const parts = rates ? ["Hourly, OT and training pay", "Commission", "Tips"] : ["Commission", "Tips"];
  const stack = (x: { hourly: number; comm: number; tips: number }) => (rates ? [x.hourly, x.comm, x.tips] : [x.comm, x.tips]);
  const bars: BarChart[] = [];
  if (perPeriod.length > 1)
    bars.push({ id: "periods", title: "Pay by pay period", kind: "money", shape: "time", legend: parts, bars: perPeriod.map((p) => ({ label: p.label, value: stack(p).reduce((a, b) => a + b, 0), parts: stack(p) })) });
  if (perPerson.size > 1)
    bars.push({
      id: "people",
      title: "Pay by employee",
      subtitle: perPerson.size > 12 ? `Top 12 of ${perPerson.size}` : undefined,
      kind: "money",
      shape: "rank",
      legend: parts,
      bars: [...perPerson.values()]
        .map((p) => ({ label: p.name, value: stack(p).reduce((a, b) => a + b, 0), parts: stack(p) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 12),
    });
  return {
    presets,
    bars,
    stats: [
      { label: "Pay periods", value: String(runs.length), hint: runs.length === 1 ? EXPORT_STATUS_LABEL[statusOf(runs[0].view, sends.has(runs[0].key))] : undefined },
      { label: "Regular hours", value: h2(sumOf(lines, (l) => l.hours)).toFixed(2), hint: `${h2(sumOf(lines, (l) => l.otHours)).toFixed(2)} h overtime` },
      { label: "Commission to iSolved", value: formatCents(sumOf(lines, (l) => toCents(l.netComm))), hint: "E_Comm Sales: commission over hourly, plus product commission" },
      { label: "Tips", value: formatCents(sumOf(lines, (l) => toCents(l.tips))), hint: `card ${formatCents(card)} · cash ${formatCents(cash)}` },
      { label: "Already paid via Stripe", value: formatCents(stripe), hint: "reported to iSolved, not paid again" },
      ...(rates ? [{ label: "Total to iSolved", value: formatCents(sumOf(lines, toIsolved)), hint: "gross wages in the file, tips included" }] : []),
    ],
    tables: [
      listTable(loc, { id: "employees", title: "By employee", columns, rows: rowsOut, merge: true, sort: byText(0) }),
      listTable(noBarber(loc), {
        id: "periods",
        title: "By pay period",
        columns: [
          text("Pay period"),
          text("iSolved file"),
          int("Rows"),
          hrs("Regular hours"),
          hrs("OT hours"),
          money("Commission to iSolved"),
          money("Tips"),
          money("Tips already paid via Stripe"),
          money("Cash tips declared"),
          ...(rates ? [money("Total to iSolved")] : []),
        ],
        rows: periodRows.reverse(),
        merge: true,
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      "iSolved is the payroll company and the system of record: it computes the paychecks, taxes and overtime at the blended rate. Hours come from the time clock (worked time, unpaid breaks out); regular hours are worked hours less overtime past 40 in a workweek across shops.",
      "Cash tips include gift card tips. Cash tips declared are cash employees were handed and declared (never rung up): they go to iSolved under their own earning code and aren't paid again. Tip adjustments are manager adjustments and overrides on the Payroll Report. Tips already paid (cash, or direct to their bank via Stripe) are reported to iSolved as tips received, so they're taxed but not paid again.",
      ...(rates
        ? ["Total to iSolved is the gross wages the file stands for: hourly pay, overtime at 1.5× the base rate, training pay, commission, any guaranteed-minimum top-up, and every tip. Paid time off goes to iSolved as hours."]
        : ['Hourly rates, hourly pay and the total show only with "See pay rates and labor cost".']),
    ],
  };
}

// ───────────────────────────── Timesheet detail ─────────────────────────────

const punchText = (x: unknown) => {
  if (!x || typeof x !== "object") return "—";
  const o = x as { type?: PunchType; at?: string; voided?: boolean };
  return [o.type ? PUNCH_LABEL[o.type] : null, o.at ? formatDateTime(o.at) : null, o.voided ? "(voided)" : null].filter(Boolean).join(" ");
};
const EDIT_LABEL = { edit: "Edited", add: "Added", void: "Voided" } as const;

export async function payrollTimesheetsData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const multi = loc.shops.length > 1;
  const [shifts, edits, presets] = await Promise.all([
    shiftsBetween(scope.shopIds, scope.from, scope.to, sel),
    punchEditsBetween(scope.shopIds, scope.from, scope.to, sel),
    payPeriodPresets(undefined, scope.shopIds),
  ]);
  const periods = [];
  for (let p = await periodFor(scope.from); p.start <= scope.to && periods.length < MAX_REPORT_PERIODS; p = await periodFor(addDays(p.end, 1))) periods.push(p);
  const sheets = await Promise.all(periods.map(async (p) => ({ p, list: await timesheetList(p.start, scope.shopIds, sel) })));
  const name = await labels([...shifts.map((s) => s.staffId), ...edits.map((e) => e.staffId), ...sheets.flatMap((s) => s.list.rows.map((r) => r.staffId))]);
  const who = (id: string) => name.get(id) ?? "Unknown";
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));
  const approvals = sheets.flatMap(({ p, list }) => list.rows.filter((r) => r.workedCenti > 0 || r.problems > 0).map((r) => ({ p, r, locked: list.locks[r.shopId] ?? null })));
  const waiting = approvals.filter((a) => !a.r.managerApprovedAt).length;
  const perDay = new Map<string, number>();
  for (const s of shifts) perDay.set(s.date, (perDay.get(s.date) ?? 0) + s.workedMin);
  return {
    presets,
    bars:
      perDay.size > 1
        ? [{ id: "days", title: "Hours worked by day", kind: "hours", shape: "time", bars: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, m]) => ({ label: d, value: m })) }]
        : [],
    stats: [
      { label: "Shifts", value: String(shifts.length), hint: `${shifts.filter((s) => !s.end).length} still open` },
      { label: "Hours worked", value: (sumOf(shifts, (s) => s.workedMin) / 60).toFixed(2), hint: `${sumOf(shifts, (s) => s.breaks.length)} breaks, ${(sumOf(shifts, (s) => s.unpaidBreakMin) / 60).toFixed(2)} h unpaid` },
      { label: "Edited shifts", value: String(shifts.filter((s) => s.edited).length), hint: `${edits.length} punch changes by a manager` },
      { label: "Waiting on a manager", value: String(waiting), hint: `of ${approvals.length} timesheets with hours` },
    ],
    tables: [
      listTable(loc, {
        id: "shifts",
        title: "Punches and breaks",
        columns: [text("Date"), text("Employee"), text("Clock in"), text("Clock out"), text("Breaks"), int("Break minutes"), int("Unpaid break minutes"), hrs("Hours worked"), hrs("Scheduled hours"), text("Flags"), bool("Edited"), text("How")],
        rows: shifts.map((s) => ({
          shopId: s.shopId,
          staffId: s.staffId,
          cells: [
            s.date,
            who(s.staffId),
            formatTime(s.start),
            s.end ? formatTime(s.end) : "Still open",
            s.breaks.map((b) => `${formatTime(b.start)}–${b.end ? formatTime(b.end) : "open"}${b.paid ? "" : " unpaid"}`).join("; "),
            s.breakMin,
            s.unpaidBreakMin,
            h2(s.workedMin / 60),
            h2(s.scheduledMin / 60),
            s.flags.map((f) => FLAG_LABEL[f]).join(", "),
            s.edited,
            s.methods.join(", "),
          ],
        })),
        keepShop: multi,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1])),
      }),
      listTable(loc, {
        id: "edits",
        title: "Edits",
        subtitle: "Every punch a manager added, moved or voided, with the reason.",
        columns: [text("Changed"), text("Employee"), text("Change"), text("Before"), text("After"), text("Reason"), text("By")],
        rows: edits.map((e) => ({
          shopId: e.shopId,
          staffId: e.staffId,
          cells: [formatDateTime(e.at), who(e.staffId), EDIT_LABEL[e.action], punchText(e.before), punchText(e.after), e.reason, e.by ?? "—"],
        })),
        keepShop: multi,
        totals: false,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])),
      }),
      listTable(loc, {
        id: "approvals",
        title: "Approvals",
        subtitle: "Each timesheet: the employee signs off, then a manager approves; the shop's period then locks.",
        columns: [text("Timesheet period"), text("Employee"), hrs("Hours worked"), hrs("OT hours"), int("Missed punches"), text("Employee signed off"), text("Manager approved"), text("Period locked")],
        rows: approvals.map(({ p, r, locked }) => ({
          shopId: r.shopId,
          staffId: r.staffId,
          cells: [
            yearLabel(p),
            who(r.staffId),
            h2(r.workedCenti / 100),
            h2(r.otCenti / 100),
            r.problems,
            r.employeeApprovedAt ? formatDateTime(r.employeeApprovedAt) : "Not yet",
            r.managerApprovedAt ? formatDateTime(r.managerApprovedAt) : "Waiting",
            locked ? formatDateTime(locked) : "Open",
          ],
        })),
        keepShop: multi,
        sort: (a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
    notes: [
      "Shifts are listed on the day they start. Breaks of the shop's unpaid length or longer come out of paid time.",
      `Timesheets run on the time clock's bi-weekly periods; ${shopName.size > 1 ? "each shop" : "the shop"} locks its period once every timesheet with hours is approved.`,
    ],
  };
}

// ───────────────────────────── Tips ─────────────────────────────

const METHOD_LABEL: Record<string, string> = { stripe: "Stripe", cash: "Cash", payroll: "Payroll", prior: "Paid before tip payouts" };

/** Tickets whose tip is split between barbers (a family on one ticket, or a shared service): each barber's share. Never a client's name. */
async function tipSplits(scope: ReportScope) {
  const sel = staffSelection(scope);
  return sqlRows<{ saleId: string; number: number; shopId: string; date: string; staffId: string; weight: number; totalWeight: number; appts: number; card: number; cash: number; total: number }>(sql`
    select s.id "saleId", s.number, s.shop_id "shopId", s.business_date::text date, sh.staff_id "staffId", sh.weight,
      (select sum(x.weight)::int from sale_tip_shares x where x.sale_id = s.id) "totalWeight",
      (select count(distinct i.appointment_id)::int from sale_items i where i.sale_id = s.id) appts,
      coalesce(sum(l.amount_cents) filter (where l.method = 'card'), 0)::int card,
      coalesce(sum(l.amount_cents) filter (where l.method in ('cash', 'gift_card')), 0)::int cash,
      coalesce(sum(l.amount_cents) filter (where l.method <> 'adjust'), 0)::int total
    from sale_tip_shares sh
    join sales s on s.id = sh.sale_id
    left join tip_ledger l on l.sale_id = s.id and l.staff_id = sh.staff_id
    where s.shop_id in ${uuids(scope.shopIds)} and s.business_date between ${scope.from} and ${scope.to} and s.status in ${PAID}
      ${sel ? sql`and sh.staff_id in ${uuids(sel)}` : sql``}
    group by s.id, s.number, s.shop_id, s.business_date, sh.staff_id, sh.weight
    order by s.business_date desc, s.number desc`);
}

/** Direct payouts held as owed (the employee hasn't finished their Stripe setup, or there's no direct path yet), per employee and shop, for a period's tips. */
async function heldForSetup(shopIds: string[], start: LocalDate, end: LocalDate) {
  if (!shopIds.length) return new Map<string, number>();
  const list = await db
    .select({ shopId: tipLedger.shopId, staffId: tipLedger.staffId, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
    .from(tipLedger)
    .innerJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
    .where(and(inArray(tipLedger.shopId, shopIds), gte(tipLedger.businessDate, start), lte(tipLedger.businessDate, end), eq(tipPayouts.status, "held"), inArray(tipPayouts.holdKind, ["stripe_setup", "transfers_pending"])))
    .groupBy(tipLedger.shopId, tipLedger.staffId);
  return new Map(list.map((r) => [`${r.staffId}|${r.shopId}`, r.cents]));
}

export async function payrollTipsData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const multi = loc.shops.length > 1;
  const [{ runs, capped }, presets, splits] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds), tipSplits(scope)]);
  const people: ListRow[] = [];
  const payouts: ListRow[] = [];
  const periods: ListRow[] = [];
  const chart: { label: string; card: number; cash: number; stripe: number; cashPaid: number; flight: number; owed: number }[] = [];
  for (const r of runs) {
    const shopIds = r.blocks.map((b) => b.shopId);
    const [methods, held] = await Promise.all([tipsByMethod(shopIds, r.ref.start, r.ref.end, sel), heldForSetup(shopIds, r.ref.start, r.ref.end)]);
    const checks = r.view.tips.rows.filter((x) => shopIds.includes(x.shopId) && (!sel || sel.includes(x.staffId)));
    const keys = new Set([...checks.map((c) => `${c.staffId}|${c.shopId}`), ...methods.keys()]);
    const point = { label: r.ref.end, card: 0, cash: 0, stripe: 0, cashPaid: 0, flight: 0, owed: 0 };
    const perShop = new Map<string, Cell[]>();
    for (const k of keys) {
      const [staffId, shopId] = k.split("|");
      const c = checks.find((x) => x.staffId === staffId && x.shopId === shopId);
      const m = methods.get(k) ?? { card: 0, cash: 0, adjust: 0 };
      const paid = (c?.payouts ?? []).filter((p) => p.status === "paid");
      const stripe = sumOf(
        paid.filter((p) => p.method === "stripe"),
        (p) => p.tipsCents + p.adjustCents,
      );
      const cashPaid = sumOf(
        paid.filter((p) => p.method !== "stripe"),
        (p) => p.tipsCents + p.adjustCents,
      );
      const cells: Cell[] = [
        c?.name ?? loc.staffNames?.[staffId] ?? "Unknown",
        m.card,
        m.cash,
        m.adjust,
        m.card + m.cash + m.adjust,
        c?.inPayrollCents ?? 0,
        stripe,
        cashPaid,
        c?.inFlightCents ?? 0,
        c?.owedCents ?? 0,
        held.get(k) ?? 0,
      ];
      people.push({ shopId, staffId, key: staffId, cells });
      const s = perShop.get(shopId) ?? [r.label, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      [m.card, m.cash, m.adjust, m.card + m.cash + m.adjust, c?.inPayrollCents ?? 0, stripe, cashPaid, c?.inFlightCents ?? 0, c?.owedCents ?? 0].forEach((v, j) => (s[j + 1] = Number(s[j + 1]) + v));
      perShop.set(shopId, s);
      Object.assign(point, { card: point.card + m.card, cash: point.cash + m.cash + m.adjust, stripe: point.stripe + stripe, cashPaid: point.cashPaid + cashPaid, flight: point.flight + (c?.inFlightCents ?? 0), owed: point.owed + (c?.owedCents ?? 0) });
      for (const p of c?.payouts ?? [])
        payouts.push({
          shopId,
          staffId,
          cells: [p.paidAt ? formatDate(p.paidAt, "yyyy-MM-dd") : p.sentAt ? formatDate(p.sentAt, "yyyy-MM-dd") : "", c!.name, r.label, METHOD_LABEL[p.method] ?? p.method, p.status, p.tipsCents + p.adjustCents, p.instant, p.stripeTransferId ?? "", p.stripePayoutId ?? ""],
        });
    }
    for (const [shopId, cells] of perShop) periods.push({ shopId, key: r.key, cells });
    chart.push(point);
  }
  const col = (j: number) => sumOf(people, (r) => Number(r.cells[j]));
  const familyTickets = new Set(splits.filter((s) => s.appts > 1).map((s) => s.saleId)).size;
  const shared = new Set(splits.map((s) => s.saleId)).size;
  const tipColumns = [money("Card tips"), money("Cash tips"), money("Adjustments"), money("Tips earned"), money("Paid in payroll"), money("Paid via Stripe"), money("Paid in cash"), money("Sent, not paid yet"), money("Pending")];
  return {
    presets,
    bars: [
      ...(chart.length
        ? [
            { id: "card_cash", title: "Card vs cash tips by pay period", kind: "money", shape: "time", legend: ["Card", "Cash and adjustments"], bars: chart.map((p) => ({ label: p.label, value: p.card + p.cash, parts: [p.card, p.cash] })) } satisfies BarChart,
            {
              id: "paid",
              title: "Direct tips: paid and pending",
              kind: "money",
              shape: "time",
              legend: ["Paid via Stripe", "Paid in cash", "Sent, not paid yet", "Pending"],
              bars: chart.map((p) => ({ label: p.label, value: p.stripe + p.cashPaid + p.flight + Math.max(0, p.owed), parts: [p.stripe, p.cashPaid, p.flight, Math.max(0, p.owed)] })),
            } satisfies BarChart,
          ]
        : []),
    ],
    stats: [
      { label: "Tips earned", value: formatCents(col(4)), hint: `card ${formatCents(col(1))} · cash ${formatCents(col(2))}` },
      { label: "Paid via Stripe", value: formatCents(col(6)), hint: `${payouts.filter((p) => p.cells[3] === "Stripe" && p.cells[4] === "paid").length} payouts paid` },
      { label: "Pending", value: formatCents(col(9)), hint: col(10) ? `${formatCents(col(10))} waiting on their Stripe setup` : `${formatCents(col(8))} sent, not paid yet` },
      { label: "Split tickets", value: String(shared), hint: `${familyTickets} family tickets` },
    ],
    tables: [
      listTable(loc, { id: "employees", title: "By employee", columns: [text("Employee"), ...tipColumns, money("Waiting on Stripe setup")], rows: people, merge: true, sort: byText(0) }),
      listTable(noBarber(loc), { id: "periods", title: "By pay period", columns: [text("Pay period"), ...tipColumns], rows: periods.reverse(), merge: true }),
      listTable(loc, {
        id: "payouts",
        title: "Payouts",
        subtitle: "Each direct payout of these pay periods' tips, with its Stripe ids. Never an account or card number.",
        columns: [text("Paid"), text("Employee"), text("Pay period"), text("Method"), text("Status"), money("Amount"), bool("Instant"), text("Stripe transfer"), text("Stripe payout")],
        rows: payouts,
        keepShop: multi,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])),
      }),
      listTable(loc, {
        id: "splits",
        title: "Family and shared tickets",
        subtitle: "Tickets with more than one barber: how each tip was split. A family ticket has more than one person's appointment on it.",
        columns: [text("Date"), int("Ticket"), text("Kind"), text("Employee"), pct("Share"), money("Card tip"), money("Cash tip"), money("Tip")],
        rows: splits.map((s) => ({
          shopId: s.shopId,
          staffId: s.staffId,
          cells: [s.date, s.number, s.appts > 1 ? "Family" : "Shared", loc.staffNames?.[s.staffId] ?? "Unknown", s.totalWeight ? s.weight / s.totalWeight : null, s.card, s.cash, s.total],
        })),
        keepShop: multi,
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      "Tips earned are the tip ledger: card, cash and gift card tips less tip refunds, plus manager adjustments. Pending is what isn't paid yet: waiting for approval, held, or not in a payout batch. Every tip goes to iSolved as income; tips already paid are reported as received.",
      "Family and shared tickets cover the dates picked.",
    ],
  };
}

// ───────────────────────────── Tips paid (ST-C13) ─────────────────────────────

export interface TipsPaidRow extends TipsPaidBuckets {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  employerId: string | null;
  employer: string;
  companyCode: string | null;
  taxId: string;
  staffId: string;
  name: string;
  employeeNumber: string | null;
  shopIds: string[];
  reversedCents: number;
  absorbedCents: number;
  status: TipsPaidStatus;
  problems: string[];
}

export interface TipsPaidPeriod {
  start: LocalDate;
  end: LocalDate;
  label: string;
  status: TipsPaidStatus;
  rows: TipsPaidRow[];
}

const NO_EMPLOYER = "No employer set";

/** Where a ledger entry's tip stands, by the payout it's in (none: not paid yet). */
function bucketOf(method: string | null, status: string | null): keyof Omit<TipsPaidBuckets, "earnedCents"> {
  if (status === "paid") return method === "stripe" ? "transferredCents" : method === "payroll" ? "payrollCents" : "cashCents";
  if (status === "approved" || status === "processing") return "inFlightCents";
  return "owedCents";
}

/**
 * A pay period's tips paid, per employer (one FEIN) and employee: every tip the period earned, and
 * where it went (paid via Stripe, in cash, through payroll, owed, or sent and not paid yet), with the
 * tip reversals and what the shop absorbed. A row is final once its shops are approved and locked
 * and the buckets add up to what was earned (tipsPaidStatus); the period is final when every row is.
 */
async function tipsPaidPeriod(r: Pick<PeriodRun, "ref" | "label" | "blocks">, sel: string[] | null): Promise<TipsPaidPeriod> {
  const shopIds = r.blocks.map((b) => b.shopId);
  const lockedShop = new Set(r.blocks.filter((b) => b.locked).map((b) => b.shopId));
  const none: TipsPaidPeriod = { start: r.ref.start, end: r.ref.end, label: r.label, status: "final", rows: [] };
  if (!shopIds.length || (sel && !sel.length)) return none;
  const inPeriod = (t: typeof tipLedger | typeof tipAbsorptions) =>
    and(inArray(t.shopId, shopIds), gte(t.businessDate, r.ref.start), lte(t.businessDate, r.ref.end), sel ? inArray(t.staffId, sel) : undefined);
  const [entries, absorbed] = await Promise.all([
    db
      .select({
        shopId: tipLedger.shopId,
        staffId: tipLedger.staffId,
        employerId: tipLedger.employerId,
        kind: tipLedger.kind,
        method: tipPayouts.method,
        status: tipPayouts.status,
        cents: sql<number>`sum(${tipLedger.amountCents})::int`,
      })
      .from(tipLedger)
      .leftJoin(tipPayouts, eq(tipPayouts.id, tipLedger.payoutId))
      .where(inPeriod(tipLedger))
      .groupBy(tipLedger.shopId, tipLedger.staffId, tipLedger.employerId, tipLedger.kind, tipPayouts.method, tipPayouts.status),
    db
      .select({ shopId: tipAbsorptions.shopId, staffId: tipAbsorptions.staffId, employerId: tipAbsorptions.employerId, cents: sql<number>`sum(${tipAbsorptions.amountCents})::int` })
      .from(tipAbsorptions)
      .where(inPeriod(tipAbsorptions))
      .groupBy(tipAbsorptions.shopId, tipAbsorptions.staffId, tipAbsorptions.employerId),
  ]);
  const rows = new Map<string, TipsPaidRow>();
  const rowOf = (staffId: string, employerId: string | null, shopId: string) => {
    const k = `${employerId ?? ""}|${staffId}`;
    let row = rows.get(k);
    if (!row) {
      row = {
        periodStart: r.ref.start,
        periodEnd: r.ref.end,
        employerId,
        employer: NO_EMPLOYER,
        companyCode: null,
        taxId: "",
        staffId,
        name: "",
        employeeNumber: null,
        shopIds: [],
        earnedCents: 0,
        transferredCents: 0,
        cashCents: 0,
        payrollCents: 0,
        owedCents: 0,
        inFlightCents: 0,
        reversedCents: 0,
        absorbedCents: 0,
        status: "draft",
        problems: [],
      };
      rows.set(k, row);
    }
    if (!row.shopIds.includes(shopId)) row.shopIds.push(shopId);
    return row;
  };
  for (const e of entries) {
    const row = rowOf(e.staffId, e.employerId, e.shopId);
    row.earnedCents += e.cents;
    row[bucketOf(e.method, e.status)] += e.cents;
    if (e.kind === "refund") row.reversedCents -= e.cents;
  }
  for (const a of absorbed) rowOf(a.staffId, a.employerId, a.shopId).absorbedCents += a.cents;
  if (!rows.size) return none;
  const list = [...rows.values()];
  const employerIds = [...new Set(list.map((x) => x.employerId).filter((x): x is string => !!x))];
  const people = [...new Set(list.map((x) => x.staffId))];
  const [employers, profiles] = await Promise.all([
    employerIds.length ? db.select().from(payrollEmployers).where(inArray(payrollEmployers.id, employerIds)) : [],
    db.select({ id: staff.id, label: staff.displayLabel, number: payrollProfiles.employeeNumber, isolvedName: payrollProfiles.isolvedName }).from(staff).leftJoin(payrollProfiles, eq(payrollProfiles.staffId, staff.id)).where(inArray(staff.id, people)),
  ]);
  const employerOf = new Map(employers.map((x) => [x.id, x]));
  const personOf = new Map(profiles.map((x) => [x.id, x]));
  for (const row of list) {
    const emp = row.employerId ? employerOf.get(row.employerId) : undefined;
    const who = personOf.get(row.staffId);
    Object.assign(row, { employer: emp?.legalName ?? NO_EMPLOYER, companyCode: emp?.isolvedCompanyCode ?? null, taxId: employerTaxIdLabel(emp?.taxIdLast4 ?? null), name: who?.isolvedName || who?.label || "Unknown", employeeNumber: who?.number ?? null });
    const { status, problems } = tipsPaidStatus(row, row.shopIds.every((id) => lockedShop.has(id)));
    if (!emp) problems.push("the shop has no employer: set its legal entity in Payroll setup");
    else if (!emp.isolvedCompanyCode) problems.push(`${emp.legalName} has no iSolved company code`);
    if (!row.employeeNumber) problems.push("no iSolved employee number");
    row.problems = problems;
    row.status = status === "final" && !problems.length ? "final" : "draft";
  }
  list.sort((a, b) => a.employer.localeCompare(b.employer) || a.name.localeCompare(b.name));
  return { ...none, status: list.every((x) => x.status === "final") ? "final" : "draft", rows: list };
}

export async function payrollTipsPaidData(i: PayrollReportInput): Promise<ReportData & { periods: Omit<TipsPaidPeriod, "rows">[]; shopParam: string | null }> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const done = await Promise.all(runs.map((r) => tipsPaidPeriod(r, sel)));
  const people: ListRow[] = [];
  const byEmployer = new Map<string, ListRow>();
  for (const p of done)
    for (const x of p.rows) {
      const buckets = [x.earnedCents, x.transferredCents, x.cashCents, x.payrollCents, x.owedCents, x.inFlightCents, x.reversedCents, x.absorbedCents];
      people.push({
        shopId: x.shopIds[0],
        staffId: x.staffId,
        cells: [p.label, x.employer, x.companyCode ?? "", x.taxId, x.name, x.employeeNumber ?? "", ...buckets, TIPS_PAID_STATUS_LABEL[x.status], x.problems.join("; ")],
      });
      const k = `${p.start}|${x.employer}`;
      const e = byEmployer.get(k) ?? { shopId: x.shopIds[0], key: k, cells: [p.label, x.employer, x.companyCode ?? "", x.taxId, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "Final"] };
      e.cells[4] = Number(e.cells[4]) + 1;
      buckets.forEach((v, j) => (e.cells[5 + j] = Number(e.cells[5 + j]) + v));
      if (x.status === "draft") e.cells[13] = Number(e.cells[13]) + 1;
      e.cells[14] = Number(e.cells[13]) ? "Draft" : "Final";
      byEmployer.set(k, e);
    }
  const periods = done.map(({ rows, ...p }) => ({ ...p, rows: rows.length }));
  const periodRows: ListRow[] = done.map((p) => ({
    shopId: scope.shopIds[0],
    key: `${p.start}_${p.end}`,
    cells: [p.label, new Set(p.rows.map((x) => x.employer)).size, p.rows.length, sumOf(p.rows, (x) => x.earnedCents), sumOf(p.rows, (x) => x.payrollCents), sumOf(p.rows, (x) => x.owedCents), TIPS_PAID_STATUS_LABEL[p.status]],
  }));
  const absorbedList = await absorptionsIn(scope, sel);
  const col = (j: number) => sumOf(people, (r) => Number(r.cells[j]));
  const amounts = [money("Tips earned"), money("Paid via Stripe"), money("Paid in cash"), money("Paid through payroll"), money("Owed"), money("Sent, not paid yet"), money("Reversed (refunds)"), money("Absorbed by the shop")];
  const drafts = people.filter((r) => r.cells[14] === "Draft").length;
  return {
    presets,
    periods: periods.reverse().map(({ start, end, label, status }) => ({ start, end, label, status })),
    shopParam: scope.shopIds.length ? scope.shopIds.join(",") : null,
    bars: [],
    stats: [
      { label: "Tips earned", value: formatCents(col(6)), hint: `${formatCents(col(12))} reversed · ${formatCents(col(13))} absorbed by the shop` },
      { label: "Paid through payroll", value: formatCents(col(9)), hint: `${formatCents(col(7))} via Stripe · ${formatCents(col(8))} in cash` },
      { label: "Owed", value: formatCents(col(10)), hint: col(11) ? `${formatCents(col(11))} sent, not paid yet` : "Owed tips go on payroll at the cutoff" },
      { label: "Final", value: `${people.length - drafts} of ${people.length}`, tone: drafts ? "down" : "up", hint: drafts ? `${drafts} draft: see Why` : "Every row adds up to the cent" },
    ],
    tables: [
      listTable(combined(loc), {
        id: "periods",
        title: "By pay period",
        subtitle: "Final once every row is: its shops approved and locked, nothing sent and unpaid, and earned = paid via Stripe + in cash + through payroll + owed.",
        columns: [text("Pay period"), int("Employers"), int("Employees"), money("Tips earned"), money("Paid through payroll"), money("Owed"), text("Status")],
        rows: periodRows.reverse(),
        totals: false,
      }),
      listTable(combined(loc), {
        id: "employers",
        title: "By employer",
        subtitle: "Each employer is one FEIN (the pay groups' legal entity). Only the last 4 of the EIN is kept.",
        columns: [text("Pay period"), text("Employer"), text("iSolved company"), text("EIN"), int("Employees"), ...amounts, int("Draft rows"), text("Status")],
        rows: [...byEmployer.values()].reverse(),
        totals: false,
      }),
      listTable(combined(loc), {
        id: "employees",
        title: "By employee",
        columns: [text("Pay period"), text("Employer"), text("iSolved company"), text("EIN"), text("Employee"), text("Employee number"), ...amounts, text("Status"), text("Why draft")],
        rows: people,
        totals: false,
      }),
      listTable(loc, {
        id: "absorbed",
        title: "Absorbed by the shop",
        subtitle: "Refunded or disputed tips the barber keeps: partial refunds, refunds after the reversal window, and card disputes. The shop pays them.",
        columns: [text("Date"), text("Employee"), text("Why"), money("Tip")],
        rows: absorbedList.map((a) => ({ shopId: a.shopId, staffId: a.staffId, cells: [a.businessDate, loc.staffNames?.[a.staffId] ?? "Unknown", ABSORPTION_LABEL[a.kind], a.amountCents] })),
        keepShop: loc.shops.length > 1,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])),
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      "Tips are dated by the brand's tip date rule (the sale date by default) and tagged with the shop's employer when written. A full refund within the reversal window takes the tip back; anything else the shop absorbs.",
      "Owed tips are Stripe tips of barbers who can't be paid directly yet. Where the brand sends owed tips to payroll, they're paid with the paycheck at the period's cutoff, once.",
    ],
  };
}

async function absorptionsIn(scope: ReportScope, sel: string[] | null) {
  if (!scope.shopIds.length || (sel && !sel.length)) return [];
  return db
    .select()
    .from(tipAbsorptions)
    .where(and(inArray(tipAbsorptions.shopId, scope.shopIds), gte(tipAbsorptions.businessDate, scope.from), lte(tipAbsorptions.businessDate, scope.to), sel ? inArray(tipAbsorptions.staffId, sel) : undefined))
    .limit(2000);
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * A pay period's tips-paid file for iSolved: one row per employer and employee. Marked DRAFT until
 * every row is final. Dollar amounts, the iSolved company code and employee number; never an EIN
 * beyond its last 4, or any account number.
 */
export async function tipsPaidFile(start: LocalDate, end: LocalDate, shopIds: readonly string[]): Promise<{ fileName: string; body: string; status: TipsPaidStatus; rows: number } | null> {
  const view = await buildPayroll(start, end);
  if (!view) return null;
  const blocks = view.blocks.filter((b) => shopIds.includes(b.shopId));
  if (!blocks.length) return null;
  const ref = { start, end };
  const p = await tipsPaidPeriod({ ref: { ...ref, groups: [] }, label: yearLabel(ref), blocks }, null);
  const header = ["Company Code", "Employer", "EIN", "Employee Number", "Employee", "Period Start", "Period End", "Tips Earned", "Paid via Stripe", "Paid in Cash", "Paid Through Payroll", "Owed", "Sent Not Paid", "Reversed", "Absorbed by Shop", "Status"];
  const lines = p.rows.map((x) => [
    x.companyCode ?? "",
    x.employer,
    x.taxId,
    x.employeeNumber ?? "",
    x.name,
    start,
    end,
    ...[x.earnedCents, x.transferredCents, x.cashCents, x.payrollCents, x.owedCents, x.inFlightCents, x.reversedCents, x.absorbedCents].map(dollars),
    TIPS_PAID_STATUS_LABEL[x.status],
  ]);
  const fileName = `${p.status === "draft" ? "DRAFT - " : ""}Tips paid (${start} to ${end}).csv`;
  return { fileName, body: csv([header, ...lines]), status: p.status, rows: p.rows.length };
}

// ───────────────────────────── Commission ─────────────────────────────

const OTHER_LINE = "Refunds, moved lines and overrides";

export async function payrollCommissionData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const rates = !!i.perms?.has("payroll.rates");
  const sel = staffSelection(scope);
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const items: ListRow[] = [];
  const employees: ListRow[] = [];
  const byService = new Map<string, { label: string; cents: number }>();
  for (const r of runs) {
    const mix = await itemMix({ shopIds: r.blocks.map((b) => b.shopId), from: r.ref.start, to: r.ref.end, staffIds: sel }, { byShop: true, byStaff: true });
    for (const l of r.lines) {
      const mine = mix.filter((x) => x.shopId === l.shopId && x.staffId === l.staffId);
      for (const [type, kinds, pctOf, total, sales] of [
        ["Service", ["service", "addon"], l.servicePct, toCents(l.commission), toCents(l.service)],
        ["Product", ["product"], l.productPct, toCents(l.productTotal), toCents(l.product)],
      ] as const) {
        const list = mine.filter((x) => (kinds as readonly string[]).includes(x.kind));
        let comm = 0;
        let net = 0;
        for (const x of list) {
          const c = Math.round(x.netCents * pctOf);
          comm += c;
          net += x.netCents;
          items.push({ shopId: l.shopId, staffId: l.staffId, key: `${l.staffId}|${type}|${x.name}`, cells: [l.name, x.name, type, x.qty, x.netCents, pctOf, c] });
          const s = byService.get(`${type}|${x.name}`) ?? { label: x.name, cents: 0 };
          s.cents += c;
          byService.set(`${type}|${x.name}`, s);
        }
        if (total !== comm || sales !== net) items.push({ shopId: l.shopId, staffId: l.staffId, key: `${l.staffId}|${type}|${OTHER_LINE}`, cells: [l.name, OTHER_LINE, type, null, sales - net, null, total - comm] });
      }
      employees.push({
        shopId: l.shopId,
        staffId: l.staffId,
        key: l.staffId,
        cells: [
          l.name,
          toCents(l.service),
          toCents(l.commission),
          ...(rates ? [toCents(l.hourlyTotal)] : []),
          toCents(l.serviceTotal),
          toCents(l.product),
          toCents(l.productTotal),
          toCents(l.netComm),
        ],
      });
    }
  }
  const lines = runs.flatMap((r) => r.lines);
  const deriveRate = (c: Cell[]) => {
    const out = [...c];
    out[5] = typeof c[4] === "number" && c[4] && typeof c[6] === "number" && c[1] !== OTHER_LINE ? c[6] / c[4] : null;
    return out;
  };
  const top = [...byService.values()].sort((a, b) => b.cents - a.cents);
  const servicesRows: ListRow[] = items.map((r) => ({ shopId: r.shopId, key: `${r.cells[2]}|${r.cells[1]}`, cells: [r.cells[1], r.cells[2], r.cells[3], r.cells[4], r.cells[6]] }));
  const perPerson = new Map<string, { name: string; service: number; product: number }>();
  for (const l of lines) {
    const p = perPerson.get(l.staffId) ?? { name: l.name, service: 0, product: 0 };
    p.service += toCents(l.commission);
    p.product += toCents(l.productTotal);
    perPerson.set(l.staffId, p);
  }
  return {
    presets,
    bars: [
      ...(top.length > 1
        ? [{ id: "services", title: "Commission by service and product", subtitle: top.length > 12 ? `Top 12 of ${top.length}` : undefined, kind: "money", shape: "rank", bars: top.slice(0, 12).map((s) => ({ label: s.label, value: s.cents })) } satisfies BarChart]
        : []),
      ...(perPerson.size > 1
        ? [
            {
              id: "people",
              title: "Commission by employee",
              kind: "money",
              shape: "rank",
              legend: ["Service", "Product"],
              bars: [...perPerson.values()]
                .map((p) => ({ label: p.name, value: p.service + p.product, parts: [Math.max(0, p.service), Math.max(0, p.product)] }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 12),
            } satisfies BarChart,
          ]
        : []),
    ],
    stats: [
      { label: "Service commission", value: formatCents(sumOf(lines, (l) => toCents(l.commission))), hint: `on ${formatCents(sumOf(lines, (l) => toCents(l.service)))} of service sales` },
      { label: "Product commission", value: formatCents(sumOf(lines, (l) => toCents(l.productTotal))), hint: `on ${formatCents(sumOf(lines, (l) => toCents(l.product)))} of product sales` },
      { label: "Commission to iSolved", value: formatCents(sumOf(lines, (l) => toCents(l.netComm))), hint: "E_Comm Sales" },
      { label: "Top earner", value: top[0]?.label ?? "—", hint: top[0] ? formatCents(top[0].cents) : undefined },
    ],
    tables: [
      listTable(loc, {
        id: "items",
        title: "By employee, service and product",
        columns: [text("Employee"), text("Service or product"), text("Type"), int("Qty"), money("Net sales"), pct("Rate"), money("Commission")],
        rows: items,
        merge: true,
        derive: deriveRate,
        sort: (a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])) || Number(b[6] ?? 0) - Number(a[6] ?? 0),
      }),
      listTable(noBarber(loc), {
        id: "services",
        title: "By service and product",
        columns: [text("Service or product"), text("Type"), int("Qty"), money("Net sales"), money("Commission")],
        rows: servicesRows,
        merge: true,
        sort: (a, b) => String(a[1]).localeCompare(String(b[1])) || Number(b[4] ?? 0) - Number(a[4] ?? 0),
      }),
      listTable(loc, {
        id: "employees",
        title: "By employee",
        subtitle: "Service commission over hourly pay, plus product commission, is the Comm Sales column in the iSolved file.",
        columns: [
          text("Employee"),
          money("Service sales"),
          money("Service commission"),
          ...(rates ? [money("Hourly pay")] : []),
          money("Service commission over hourly"),
          money("Product sales"),
          money("Product commission"),
          money("Commission to iSolved (E_Comm Sales)"),
        ],
        rows: employees,
        merge: true,
        sort: byText(0),
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      `Each line's commission is its net sales × the employee's rate in that pay period. Refunds, lines moved between barbers, imported tickets and manager overrides are on a "${OTHER_LINE}" row, so each employee's service and product commission ties to the payroll report to the cent.`,
    ],
  };
}

// ───────────────────────────── Full time ─────────────────────────────

export async function payrollFullTimeData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const settings = await loadSettings();
  const window = settings.ftWindowWeeks;
  const asOf = addDays(scope.to, 1);
  const lastWeek = addDays(weekStartOf(asOf), -7);
  const firstWeek = addDays(lastWeek, -7 * (window - 1));
  const [here, presets] = await Promise.all([
    sel && !sel.length
      ? []
      : db
          .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, sec: sql<number>`sum(extract(epoch from ${timeEntries.endsAt} - ${timeEntries.startsAt}))::float` })
          .from(timeEntries)
          .where(and(inArray(timeEntries.shopId, scope.shopIds.length ? scope.shopIds : ["00000000-0000-0000-0000-000000000000"]), lt(timeEntries.startsAt, endOfLocalDay(addDays(lastWeek, 6))), gte(timeEntries.endsAt, startOfLocalDay(firstWeek)), sel ? inArray(timeEntries.staffId, sel) : undefined))
          .groupBy(timeEntries.staffId, timeEntries.shopId),
    payPeriodPresets(undefined, scope.shopIds),
  ]);
  const mainShop = new Map<string, { shopId: string; sec: number }>();
  for (const r of here) if ((mainShop.get(r.staffId)?.sec ?? -1) < r.sec) mainShop.set(r.staffId, { shopId: r.shopId, sec: r.sec });
  const ids = [...mainShop.keys()];
  const ft = ids.length ? await ftOverview(ids, asOf, window, settings) : { rows: [], lastWeek, window, threshold: settings.ftHoursPerWeek };
  const name = await labels(ids);
  const threshold = ft.threshold;
  const weeks = Array.from({ length: window }, (_, k) => addDays(firstWeek, 7 * k));
  const close = ft.rows.filter((r) => Math.abs(r.average - threshold) <= 2);
  return {
    presets,
    bars: ft.rows.length
      ? [
          {
            id: "average",
            title: "Average hours a week",
            subtitle: ft.rows.length > 12 ? `Top 12 of ${ft.rows.length}` : undefined,
            kind: "hours",
            shape: "rank",
            reference: { value: chartMin(threshold), label: `Full time: more than ${threshold} h a week` },
            bars: [...ft.rows]
              .sort((a, b) => b.average - a.average)
              .slice(0, 12)
              .map((r) => ({ label: name.get(r.staffId) ?? "Unknown", value: chartMin(r.average), warn: r.status === "full_time" })),
          },
        ]
      : [],
    stats: [
      { label: "Full time", value: String(ft.rows.filter((r) => r.status === "full_time").length), hint: `averaging more than ${threshold} h a week` },
      { label: "Part time", value: String(ft.rows.filter((r) => r.status === "part_time").length), hint: `${threshold} h or less` },
      { label: "Within 2 hours of the line", value: String(close.length), hint: close.length ? close.map((r) => name.get(r.staffId) ?? "Unknown").slice(0, 3).join(", ") : undefined },
      { label: "Window", value: `${window} weeks`, hint: `${formatDate(firstWeek, "MMM d")} – ${formatDate(addDays(lastWeek, 6), "MMM d, yyyy")}` },
    ],
    tables: [
      listTable(noBarber(loc), {
        id: "employees",
        title: "Full time and part time",
        columns: [text("Employee"), ...weeks.map((w) => hrs(`Week of ${formatDate(w, "MMM d")}`)), hrs("Average a week", false), text("Status"), hrs(`Over or under ${threshold} h`, false)],
        rows: ft.rows.map((r) => ({
          shopId: mainShop.get(r.staffId)!.shopId,
          staffId: r.staffId,
          key: r.staffId,
          cells: [name.get(r.staffId) ?? "Unknown", ...r.weeks.map((w) => h2(w.hours)), r.average, FT_LABEL[r.status], h2(r.average - threshold)],
        })),
        totals: false,
        sort: (a, b) => Number(b[window + 1] ?? 0) - Number(a[window + 1] ?? 0),
      }),
    ],
    notes: [
      `Full time is an average of more than ${threshold} hours a week over the ${window} full workweeks (Sunday to Saturday) ending by ${formatDate(scope.to, "MMM d, yyyy")}, counting ${settings.ftBasis === "worked" ? "worked hours" : settings.ftBasis === "paid" ? "worked, training and paid time off hours" : "worked and training hours"} at every shop. Exactly ${threshold} is part time. The threshold, window and basis are in Payroll setup.`,
      "Each person is listed under the shop where they worked the most hours in the window.",
    ],
  };
}

// ───────────────────────────── Labor cost vs sales ─────────────────────────────

export async function payrollLaborData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const rates = !!i.perms?.has("payroll.rates");
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));
  type Agg = { hours: number; service: number; product: number; labor: number };
  const agg = (ls: readonly Line[]): Agg => ({ hours: h2(sumOf(ls, (l) => l.hours + l.otHours)), service: sumOf(ls, (l) => toCents(l.service)), product: sumOf(ls, (l) => toCents(l.product)), labor: sumOf(ls, (l) => toCents(l.laborCost)) });
  const cells = (label: string, a: Agg): Cell[] => {
    const revenue = a.service + a.product;
    return [label, a.hours, a.service, a.product, revenue, ...(rates ? [a.labor, revenue ? a.labor / revenue : null] : []), a.hours ? Math.round(revenue / a.hours) : null];
  };
  const derive = (c: Cell[]) => {
    const out = [...c];
    const revenue = Number(c[4] ?? 0);
    const hours = Number(c[1] ?? 0);
    if (rates) out[6] = revenue ? Number(c[5] ?? 0) / revenue : null;
    out[rates ? 7 : 5] = hours ? Math.round(revenue / hours) : null;
    return out;
  };
  const periodRows: ListRow[] = [];
  const shopRows: ListRow[] = [];
  const trend = new Map<string, (number | null)[]>();
  for (const [n, r] of runs.entries()) {
    for (const b of r.blocks) {
      const a = agg(r.lines.filter((l) => l.shopId === b.shopId));
      periodRows.push({ shopId: b.shopId, key: r.key, cells: cells(r.label, a) });
      shopRows.push({ shopId: b.shopId, key: b.shopId, cells: cells(shopName.get(b.shopId) ?? b.shop, a) });
      const t = trend.get(b.shopId) ?? runs.map(() => null);
      t[n] = a.service + a.product ? a.labor / (a.service + a.product) : null;
      trend.set(b.shopId, t);
    }
  }
  const all = agg(runs.flatMap((r) => r.lines));
  const revenue = all.service + all.product;
  const perShop = [...new Set(shopRows.map((r) => r.shopId))].map((id) => {
    const a = agg(runs.flatMap((r) => r.lines.filter((l) => l.shopId === id)));
    return { id, label: shopName.get(id) ?? "", a, share: a.service + a.product ? a.labor / (a.service + a.product) : 0 };
  });
  const brand = runs.map((r) => {
    const a = agg(r.lines);
    return a.service + a.product ? a.labor / (a.service + a.product) : null;
  });
  const columns = [text("Shop"), hrs("Hours"), money("Service sales"), money("Product sales"), money("Revenue"), ...(rates ? [money("Labor cost"), pct("Labor % of revenue")] : []), rate("Revenue per labor hour")];
  const charts: ReportChart[] =
    rates && runs.length > 1
      ? [
          {
            id: "labor_trend",
            title: "Labor % of revenue by pay period",
            labels: runs.map((r) => periodLabel(r.ref)),
            series: [...[...trend.entries()].map(([id, values]) => ({ label: shopName.get(id) ?? "", values })), ...(trend.size > 1 ? [{ label: "All selected shops", values: brand, dashed: true }] : [])],
          },
        ]
      : [];
  return {
    presets,
    charts,
    bars:
      perShop.length > 1
        ? [
            rates
              ? { id: "labor_pct", title: "Labor % of revenue by shop", kind: "pct", shape: "rank", bars: perShop.sort((a, b) => b.share - a.share).map((s) => ({ label: s.label, value: s.share })) }
              : { id: "per_hour", title: "Revenue per labor hour by shop", kind: "money", shape: "rank", bars: perShop.map((s) => ({ label: s.label, value: s.a.hours ? Math.round((s.a.service + s.a.product) / s.a.hours) : 0 })).sort((a, b) => b.value - a.value) },
          ]
        : [],
    stats: [
      { label: "Revenue", value: formatCents(revenue), hint: `services ${formatCents(all.service)} · products ${formatCents(all.product)}` },
      ...(rates
        ? [
            { label: "Labor cost", value: formatCents(all.labor), hint: "hourly, OT, training, commission and top-ups" },
            { label: "Labor % of revenue", value: revenue ? `${((all.labor / revenue) * 100).toFixed(1)}%` : "—" },
          ]
        : []),
      { label: "Revenue per labor hour", value: all.hours ? formatCents(Math.round(revenue / all.hours)) : "—", hint: `${all.hours.toFixed(2)} labor hours` },
    ],
    tables: [
      listTable(combined(loc), { id: "shops", title: "By shop", columns, rows: shopRows, merge: true, derive, sort: byText(0) }),
      listTable(noBarber(loc), { id: "periods", title: "By pay period", columns: [text("Pay period"), ...columns.slice(1)], rows: periodRows.reverse(), merge: true, derive }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      "Revenue is net service and product sales credited to barbers on the payroll report, after refunds. Labor cost is the payroll report's Labor Cost: hourly pay, overtime at 1.5×, training pay, commission and guaranteed-minimum top-ups. Employer taxes and benefits are in iSolved, not here.",
      ...(rates ? [] : ['Labor cost and labor % show only with "See pay rates and labor cost".']),
    ],
  };
}

// ───────────────────────────── Overtime watch ─────────────────────────────

/** Hours from 40 that count as close. */
export const OT_NEAR_HOURS = 4;
type OtStatus = "over" | "projected" | "near" | "under";
const OT_STATUS_LABEL: Record<OtStatus, string> = { over: "In overtime", projected: "Projected over", near: "Close to overtime", under: "Under" };

export async function payrollOvertimeData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const now = i.now ?? new Date();
  const today = todayLocal(now);
  const show = i.params?.show === "all" ? "all" : "watch";
  const [{ slices, settings }, presets] = await Promise.all([hoursSlices(scope.from, scope.to, sel), payPeriodPresets(undefined, scope.shopIds)]);
  const threshold = settings.otThresholdHours;
  const firstWeek = weekStartOf(scope.from);
  const lastWeek = weekStartOf(scope.to);
  const inScope = slices.filter((s) => s.weekStart >= firstWeek && s.weekStart <= lastWeek);
  const keys = new Set(inScope.filter((s) => scope.shopIds.includes(s.shopId) && (s.worked || s.training || s.pto)).map((s) => `${s.staffId}|${s.weekStart}`));
  const thisWeek = weekStartOf(today);
  const ids = [...new Set([...keys].map((k) => k.split("|")[0]))];
  const left = thisWeek >= firstWeek && thisWeek <= lastWeek && ids.length ? await scheduledMinutesLeft(ids, now, addDays(thisWeek, 6)) : new Map<string, number>();
  const name = await labels(ids);
  const list = [...keys].map((k) => {
    const [staffId, week] = k.split("|");
    const mine = inScope.filter((s) => s.staffId === staffId && s.weekStart === week);
    const basis = h2(sumOf(mine, (s) => s.basis) / 100);
    const ot = h2(sumOf(mine, (s) => s.ot) / 100);
    const atShop = new Map<string, number>();
    for (const s of mine.filter((x) => scope.shopIds.includes(x.shopId))) atShop.set(s.shopId, (atShop.get(s.shopId) ?? 0) + s.worked + s.training + s.pto);
    const shopId = [...atShop.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rest = week === thisWeek ? h2((left.get(staffId) ?? 0) / 60) : null;
    const projected = h2(basis + (rest ?? 0));
    const status: OtStatus = ot > 0 || basis > threshold ? "over" : rest !== null && projected > threshold ? "projected" : basis >= threshold - OT_NEAR_HOURS ? "near" : "under";
    return { staffId, week, shopId, basis, ot, rest, projected, status };
  });
  const shown = show === "all" ? list : list.filter((r) => r.status !== "under");
  const latest = list.filter((r) => r.week === (list.some((x) => x.week === thisWeek) ? thisWeek : lastWeek));
  return {
    presets,
    options: [
      {
        param: "show",
        label: "Show",
        value: show === "all" ? "all" : "",
        choices: [
          { value: "", label: "Over, projected or close" },
          { value: "all", label: "Everyone with hours" },
        ],
      } satisfies ReportOption,
    ],
    bars: latest.length
      ? [
          {
            id: "week",
            title: latest[0].week === thisWeek ? "This week: hours toward overtime" : `Week of ${formatDate(latest[0].week, "MMM d")}: hours toward overtime`,
            subtitle: latest.length > 12 ? `Top 12 of ${latest.length}` : undefined,
            kind: "hours",
            shape: "rank",
            reference: { value: chartMin(threshold), label: `Overtime after ${threshold} h a week` },
            legend: latest.some((r) => r.rest) ? ["Worked", "Still scheduled"] : undefined,
            bars: [...latest]
              .sort((a, b) => b.projected - a.projected)
              .slice(0, 12)
              .map((r) => ({
                label: name.get(r.staffId) ?? "Unknown",
                value: chartMin(r.projected),
                warn: r.status !== "under",
                ...(latest.some((x) => x.rest) ? { parts: [chartMin(r.basis), chartMin(r.rest ?? 0)] } : {}),
              })),
          },
        ]
      : [],
    stats: [
      { label: "In overtime", value: String(new Set(list.filter((r) => r.status === "over").map((r) => r.staffId)).size), hint: `${h2(sumOf(list, (r) => r.ot)).toFixed(2)} OT hours` },
      { label: "Projected over this week", value: String(list.filter((r) => r.status === "projected").length), hint: "hours so far plus what they're still scheduled" },
      { label: `Within ${OT_NEAR_HOURS} h of ${threshold}`, value: String(list.filter((r) => r.status === "near").length) },
      { label: "Weeks", value: String(new Set(list.map((r) => r.week)).size), hint: `${formatDate(firstWeek, "MMM d")} – ${formatDate(addDays(lastWeek, 6), "MMM d")}` },
    ],
    tables: [
      listTable(noBarber(loc), {
        id: "weeks",
        title: "By employee and workweek",
        columns: [text("Week of"), text("Employee"), hrs(`Hours toward ${threshold}`), hrs("OT hours"), hrs("Still scheduled this week", false), hrs("Projected", false), hrs("Left before OT", false), text("Status")],
        rows: shown.map((r) => ({
          shopId: r.shopId,
          staffId: r.staffId,
          cells: [r.week, name.get(r.staffId) ?? "Unknown", r.basis, r.ot, r.rest, r.rest === null ? null : r.projected, h2(Math.max(0, threshold - r.projected)), OT_STATUS_LABEL[r.status]],
        })),
        totals: false,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])) || Number(b[5] ?? b[2] ?? 0) - Number(a[5] ?? a[2] ?? 0),
      }),
    ],
    notes: [
      `Overtime is hours past ${threshold} in a Sunday-to-Saturday workweek, added up across every shop of the same company${settings.dailyOtHours ? ` (and past ${settings.dailyOtHours} in a day)` : ""}. Hours at shops outside your access count toward it but aren't named. Close is within ${OT_NEAR_HOURS} hours.`,
      "This week's projection adds what each person is still scheduled for to the hours they've clocked; an open shift counts once they clock out.",
    ],
  };
}

// ───────────────────────────── iSolved export preview ─────────────────────────────

export interface IsolvedPeriod {
  start: LocalDate;
  end: LocalDate;
  label: string;
  status: ExportStatus;
  /** Why it can't be marked sent yet, or null. */
  blocked: string | null;
  sentAt: string | null;
  sentBy: string | null;
}

function blockedReason(view: PayrollView): string | null {
  if (view.locked !== "all") return view.locked === "some" ? "Some shops in this period aren't approved and locked yet." : "Approve and lock this period on the Payroll Report first.";
  if (view.tips.mismatches.length) return `${view.tips.mismatches.length} tip difference${view.tips.mismatches.length === 1 ? "" : "s"} against the Stripe payouts: fix them first.`;
  return null;
}

export async function payrollIsolvedData(i: PayrollReportInput): Promise<ReportData & { periods: IsolvedPeriod[]; shopParam: string | null }> {
  const { scope, loc } = i;
  const sel = staffSelection(scope);
  const multi = loc.shops.length > 1;
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const sends = await sendsOf(runs);
  const fileRows: ListRow[] = [];
  const tipRows: ListRow[] = [];
  const periods: IsolvedPeriod[] = [];
  let differences = 0;
  for (const r of runs) {
    const sent = sends.get(r.key);
    const status = statusOf(r.view, !!sent);
    const checks = r.view.tips.rows.filter((x) => r.blocks.some((b) => b.shopId === x.shopId) && (!sel || sel.includes(x.staffId)));
    for (const b of r.blocks) {
      const from = extraFromOf(b);
      for (const row of b.exportRows.filter((x) => !sel || sel.includes(x.staffId))) {
        const c = checks.find((x) => x.staffId === row.staffId && x.shopId === b.shopId);
        const stripe = sumOf(
          (c?.payouts ?? []).filter((p) => p.method === "stripe" && p.status === "paid"),
          (p) => p.tipsCents + p.adjustCents,
        );
        const v = row.values;
        fileRows.push({
          shopId: b.shopId,
          staffId: row.staffId,
          cells: [
            r.label,
            row.isolvedName,
            row.key === null || row.key === "" ? "Missing" : "On file",
            h2(v[0] ?? 0),
            h2(v[1] ?? 0),
            toCents(v[2] ?? 0),
            toCents(v[3] ?? 0),
            h2(v[4] ?? 0),
            h2(v[5] ?? 0),
            toCents(sumColumns(from, v, PAYROLL_TIP_COLUMNS)),
            toCents(sumColumns(from, v, PAID_TIP_COLUMNS)),
            stripe,
            c ? (c.problems.length ? "Difference" : "Matches") : "No tips",
          ],
        });
      }
    }
    for (const c of checks) {
      differences += c.problems.length;
      tipRows.push({
        shopId: c.shopId,
        staffId: c.staffId,
        cells: [
          r.label,
          c.name,
          c.directCents,
          c.exportCashTipsCents ?? 0,
          (c.exportCashTipsCents ?? 0) - c.directCents,
          c.paidAtLockCents,
          c.exportPaidMemoCents,
          c.exportPaidMemoCents - c.paidAtLockCents,
          c.payouts.filter((p) => p.method === "stripe").length,
          c.payouts
            .filter((p) => p.method === "stripe")
            .map((p) => p.stripeTransferId ?? p.stripePayoutId ?? "")
            .filter(Boolean)
            .join(", "),
          c.problems.length ? c.problems.join("; ") : "Matches to the cent",
        ],
      });
    }
    periods.push({
      start: r.ref.start,
      end: r.ref.end,
      label: r.label,
      status,
      blocked: status === "sent" ? null : blockedReason(r.view),
      sentAt: sent ? sent.sentAt.toISOString() : null,
      sentBy: sent?.by ?? null,
    });
  }
  periods.reverse();
  const latest = periods[0];
  const periodRows: ListRow[] = periods.map((p) => {
    const r = runs.find((x) => x.ref.start === p.start && x.ref.end === p.end)!;
    const locked = r.blocks.filter((b) => b.locked);
    return {
      shopId: r.blocks[0].shopId,
      key: `${p.start}_${p.end}`,
      cells: [
        p.label,
        formatDate(r.blocks[0].period.checkDate, "MMM d, yyyy"),
        r.blocks.length,
        sumOf(r.blocks, (b) => b.exportRows.length),
        EXPORT_STATUS_LABEL[p.status],
        locked.length === r.blocks.length && locked[0]?.locked ? `${formatDateTime(locked[0].locked.at)}${locked[0].locked.by ? ` · ${locked[0].locked.by}` : ""}` : `${locked.length} of ${r.blocks.length} shops`,
        p.sentAt ? `${formatDateTime(p.sentAt)}${p.sentBy ? ` · ${p.sentBy}` : ""}` : "—",
        r.view.tips.mismatches.length,
      ],
    };
  });
  const sumCol = (j: number) => sumOf(fileRows, (r) => Number(r.cells[j] ?? 0));
  const memo = sumCol(10);
  const stripe = sumCol(11);
  return {
    presets,
    periods,
    shopParam: scope.shopIds.length ? scope.shopIds.join(",") : null,
    bars: [],
    stats: [
      { label: "iSolved file", value: latest ? EXPORT_STATUS_LABEL[latest.status] : "—", hint: latest ? `${latest.label}${latest.blocked && latest.status !== "sent" ? ` · ${latest.blocked}` : ""}` : undefined },
      { label: "Rows", value: String(fileRows.length), hint: `${sumCol(3).toFixed(2)} regular h · ${sumCol(4).toFixed(2)} OT h` },
      { label: "Comm Sales", value: formatCents(sumCol(6)), hint: `cash tips received ${formatCents(sumCol(5))}` },
      { label: "Tips vs Stripe payouts", value: differences ? `${differences} difference${differences === 1 ? "" : "s"}` : "Reconciles to the cent", tone: differences ? "down" : "up", hint: `paid via Stripe ${formatCents(stripe)} · tips-paid memo ${formatCents(memo)}` },
    ],
    tables: [
      listTable(combined(loc), {
        id: "periods",
        title: "iSolved file by pay period",
        subtitle: "Draft until every shop in the period is approved and locked; approved after; sent once it's marked uploaded to iSolved.",
        columns: [text("Pay period"), text("Check date"), int("Shops"), int("Rows"), text("Status"), text("Approved and locked"), text("Sent to iSolved"), int("Tip differences")],
        rows: periodRows,
        totals: false,
      }),
      listTable(loc, {
        id: "file",
        title: "What the file carries",
        subtitle: "Each shop's tab, row by row, in the iSolved Timecard Import layout. Employee keys go out in the file only.",
        columns: [
          text("Pay period"),
          text("iSolved name"),
          text("Employee key"),
          hrs("E_Regular_Hours"),
          hrs("E_Overtime 1.5_Hours"),
          money("E_Cash Tips Recd_Dollars"),
          money("E_Comm Sales_Dollars"),
          hrs("E_Ray'z Paid Time_Hours"),
          hrs("E_Training_Hours"),
          money("Tips in payroll"),
          money("Tips already paid (memo)"),
          money("Paid via Stripe"),
          text("Tips check"),
        ],
        rows: fileRows,
        keepShop: multi,
      }),
      listTable(loc, {
        id: "reconcile",
        title: "Tips against Stripe payouts",
        subtitle: "To the cent, per employee: tips paid outside payroll against the file's tips received, and payouts paid (by the lock) against its tips-paid memo.",
        columns: [
          text("Pay period"),
          text("Employee"),
          money("Tips paid outside payroll"),
          money("In the file (E_Cash Tips Recd)"),
          money("Difference"),
          money("Payouts paid by the lock"),
          money("In the file (memo)"),
          money("Difference "),
          int("Stripe payouts"),
          text("Stripe ids"),
          text("Result"),
        ],
        rows: tipRows,
        keepShop: multi,
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      "The iSolved export downloads one workbook per pay period with a tab for each shop, exactly as each shop's file would download from the Payroll Report. A file from a period that isn't approved and locked yet is marked DRAFT and can change.",
      "Marking a period sent needs \"Approve and lock a pay period\". It's refused until every shop is locked and every employee's tips match their Stripe payouts to the cent.",
    ],
  };
}

// ───────────────────────────── The iSolved file ─────────────────────────────

/** One workbook for a pay period: a tab per shop (in the viewer's shops) in the iSolved layout, from the approved snapshot once locked. */
export async function isolvedWorkbook(start: LocalDate, end: LocalDate, shopIds: readonly string[]): Promise<{ fileName: string; body: Buffer; status: ExportStatus; rows: number; shops: string[] } | null> {
  const view = await buildPayroll(start, end);
  if (!view) return null;
  const blocks = view.blocks.filter((b) => shopIds.includes(b.shopId));
  if (!blocks.length) return null;
  const [sent] = await db.select({ id: payrollExportSends.id }).from(payrollExportSends).where(and(eq(payrollExportSends.periodStart, start), eq(payrollExportSends.periodEnd, end)));
  const status = statusOf(view, !!sent);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ray'z";
  const used = new Set<string>();
  for (const b of blocks) {
    let tab = b.exportTab.slice(0, 31);
    for (let n = 2; used.has(tab); n++) tab = `${b.exportTab.slice(0, 27)} (${n})`;
    used.add(tab);
    addIsolvedSheet(wb, { tab, payGroup: b.payGroup, periodNumber: b.period.number, periodStart: start, periodEnd: end, rows: b.exportRows, headers: b.exportHeaders });
  }
  const number = blocks[0].period.number;
  const fileName = `${status === "draft" ? "DRAFT - " : ""}iSolved - period ${String(number).padStart(2, "0")} (${start} to ${end}).xlsx`;
  return { fileName, body: Buffer.from(await wb.xlsx.writeBuffer()), status, rows: sumOf(blocks, (b) => b.exportRows.length), shops: blocks.map((b) => b.shopId) };
}

const bad = (msg: string) => new AppError("bad_request", msg);

/** Marks a pay period's iSolved file uploaded. Only once every shop is approved and locked and the tips reconcile to the cent. */
export async function markIsolvedSent(start: LocalDate, end: LocalDate, actor: Actor, note: string | null): Promise<void> {
  const view = await buildPayroll(start, end);
  if (!view) throw bad("No shop has a pay period with those dates.");
  const why = blockedReason(view);
  if (why) throw bad(why);
  const shops: PayrollSendShop[] = view.blocks.map((b) => {
    const headers = b.exportHeaders ?? EXPORT_COLUMNS.map((c) => c.header);
    return {
      shopId: b.shopId,
      payGroup: b.payGroup,
      tab: b.exportTab,
      rows: b.exportRows.length,
      headers,
      totals: headers.map((_, j) => h2(sumOf(b.exportRows, (r) => r.values[j] ?? 0))),
      employerId: b.employer?.id ?? null,
      employer: b.employer?.legalName ?? null,
      isolvedCompanyCode: b.employer?.isolvedCompanyCode ?? null,
    };
  });
  const [row] = await db
    .insert(payrollExportSends)
    .values({ periodStart: start, periodEnd: end, shops, note: note?.trim().slice(0, 300) || null, sentBy: actor.staffId ?? null })
    .onConflictDoNothing()
    .returning({ id: payrollExportSends.id });
  if (!row) throw new AppError("conflict", "This pay period is already marked sent.");
  await audit(actor, "payroll.isolved_sent", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, shops: shops.map((s) => ({ payGroup: s.payGroup, employer: s.employer, rows: s.rows })), note: note?.trim() || null });
}

/** Takes the sent mark off (say, the upload failed in iSolved). The period goes back to approved. */
export async function undoIsolvedSent(start: LocalDate, end: LocalDate, actor: Actor, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 3) throw bad("Say why the file wasn't sent after all.");
  const gone = await db
    .delete(payrollExportSends)
    .where(and(eq(payrollExportSends.periodStart, start), eq(payrollExportSends.periodEnd, end)))
    .returning({ id: payrollExportSends.id, sentAt: payrollExportSends.sentAt });
  if (!gone.length) throw bad("This pay period isn't marked sent.");
  await audit(actor, "payroll.isolved_unsent", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, sentAt: gone[0].sentAt.toISOString(), reason: why.slice(0, 300) });
}

// ───────────────────────────── W-2 tip and overtime codes (SB-C7) ─────────────────────────────

/** Each shop's employer (one FEIN), from its pay group. */
async function employersOf(shopIds: readonly string[]) {
  const rows = shopIds.length
    ? await db
        .select({ shopId: payGroups.shopId, legalEntity: payGroups.legalEntity, employer: payrollEmployers.legalName, taxIdLast4: payrollEmployers.taxIdLast4 })
        .from(payGroups)
        .leftJoin(payrollEmployers, eq(payrollEmployers.id, payGroups.employerId))
        .where(inArray(payGroups.shopId, [...shopIds]))
    : [];
  const by = new Map(rows.map((r) => [r.shopId, { name: r.employer ?? r.legalEntity ?? NO_EMPLOYER, taxId: employerTaxIdLabel(r.taxIdLast4 ?? null) }]));
  return (shopId: string) => by.get(shopId) ?? { name: NO_EMPLOYER, taxId: employerTaxIdLabel(null) };
}

/** Straight-time pay for the FLSA regular rate: hourly for every hour worked, commission, training and any top-up; never tips. */
const straightTimeCents = (l: Line) => toCents(l.laborCost) - toCents(l.otPay) + toCents(l.wage * l.otHours);
const workedHours = (l: Line) => l.hours + l.otHours + l.trainingHours;

/**
 * The 2026 W-2 fields for "no tax on tips" and "no tax on overtime", per employer and employee over
 * the pay periods picked (a year to date for the W-2): qualified tips for box 12 code TP (tips rung up
 * plus declared cash tips, charged and cash apart) with the employee's tipped occupation code, and the
 * overtime premium for code TT (the half of time-and-a-half), by FLSA workweek. iSolved files the W-2;
 * the CPA confirms the codes, the occupation list and the regular-rate method before year end.
 */
export async function payrollW2CodesData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const rates = !!i.perms?.has("payroll.rates");
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const settings = runs[0]?.view.settings ?? (await loadSettings());
  const codes = settings.tipTax;
  const employer = await employersOf([...new Set(runs.flatMap((r) => r.blocks.map((b) => b.shopId)))]);
  const ids = [...new Set(runs.flatMap((r) => r.lines.map((l) => l.staffId)))];
  const occupation = new Map((ids.length ? await db.select({ id: payrollProfiles.staffId, code: payrollProfiles.tippedOccupationCode }).from(payrollProfiles).where(inArray(payrollProfiles.staffId, ids)) : []).map((p) => [p.id, p.code]));

  type Acc = { employer: string; taxId: string; staffId: string; shopId: string; name: string; charged: number; pos: number; declared: number; ot: number; base: number; blended: number; periods: number; locked: number };
  const people = new Map<string, Acc>();
  const weekRows: ListRow[] = [];
  for (const r of runs) {
    for (const l of r.lines) {
      const e = employer(l.shopId);
      const k = `${e.name}|${l.staffId}`;
      const a = people.get(k) ?? { employer: e.name, taxId: e.taxId, staffId: l.staffId, shopId: l.shopId, name: l.name, charged: 0, pos: 0, declared: 0, ot: 0, base: 0, blended: 0, periods: 0, locked: 0 };
      a.charged += toCents(l.chargedTips);
      a.pos += toCents(l.tips) - toCents(l.chargedTips);
      a.declared += toCents(l.declaredCashTips ?? 0);
      a.ot += l.otHours;
      a.base += Math.round(toCents(l.wage) * l.otHours * 0.5);
      const hours = workedHours(l);
      a.blended += hours > 0 ? Math.round((straightTimeCents(l) / hours) * l.otHours * 0.5) : 0;
      a.periods++;
      if (r.blocks.find((b) => b.shopId === l.shopId)?.locked) a.locked++;
      people.set(k, a);
    }
    for (const l of r.lines) {
      const shop = r.blocks.find((b) => b.shopId === l.shopId)?.shop;
      for (const w of r.view.weeks[l.staffId] ?? []) {
        const ot = h2(sumOf(w.slices.filter((x) => x.inThisRun && x.shop === shop), (x) => x.ot));
        if (!ot) continue;
        weekRows.push({
          shopId: l.shopId,
          staffId: l.staffId,
          key: `${r.key}|${l.staffId}|${l.shopId}|${w.weekStart}`,
          cells: [employer(l.shopId).name, l.name, w.weekStart, h2(w.basis), ot, ...(rates ? [toCents(l.wage)] : []), Math.round(toCents(l.wage) * ot * 0.5)],
        });
      }
    }
  }
  const list = [...people.values()].sort((a, b) => a.employer.localeCompare(b.employer) || a.name.localeCompare(b.name));
  const rowsOut: ListRow[] = list.map((a) => ({
    shopId: a.shopId,
    staffId: a.staffId,
    key: `${a.employer}|${a.staffId}`,
    cells: [
      a.employer,
      a.taxId,
      a.name,
      occupation.get(a.staffId) ?? "",
      a.charged,
      a.pos + a.declared,
      a.declared,
      a.charged + a.pos + a.declared,
      h2(a.ot),
      a.base,
      a.blended,
      a.locked === a.periods ? "Locked" : `${a.periods - a.locked} of ${a.periods} periods not locked`,
      [
        ...(a.charged + a.pos + a.declared && !occupation.get(a.staffId) ? ["No tipped occupation code: set it in Payroll setup"] : []),
        ...(a.blended > a.base ? ["Commission raises the regular rate: the CPA decides which premium goes in TT"] : []),
      ].join("; "),
    ],
  }));
  const tp = sumOf(list, (a) => a.charged + a.pos + a.declared);
  return {
    presets,
    stats: [
      { label: `Qualified tips (code ${codes.qualifiedTipsCode})`, value: formatCents(tp), hint: `charged ${formatCents(sumOf(list, (a) => a.charged))} · cash ${formatCents(sumOf(list, (a) => a.pos + a.declared))}` },
      { label: "Cash tips declared", value: formatCents(sumOf(list, (a) => a.declared)) },
      { label: "Overtime hours", value: h2(sumOf(list, (a) => a.ot)).toFixed(2) },
      { label: `Overtime premium (code ${codes.overtimeCode})`, value: formatCents(sumOf(list, (a) => a.base)), hint: `at the base rate; ${formatCents(sumOf(list, (a) => a.blended))} at the blended regular rate` },
    ],
    tables: [
      listTable(combined(loc), {
        id: "employees",
        title: "By employer and employee",
        columns: [
          text("Employer"),
          text("FEIN"),
          text("Employee"),
          text("Tipped occupation code"),
          money(`Charged tips (${codes.qualifiedTipsCode})`),
          money(`Cash tips (${codes.qualifiedTipsCode})`),
          money("Of which declared"),
          money(`Qualified tips, box 12 ${codes.qualifiedTipsCode}`),
          hrs("Overtime hours"),
          money(`OT premium at base rate, box 12 ${codes.overtimeCode}`),
          money("OT premium at blended regular rate"),
          text("Periods"),
          text("Check"),
        ],
        rows: rowsOut,
        sort: byText(0),
      }),
      listTable(combined(loc), {
        id: "workweeks",
        title: "Overtime by FLSA workweek",
        subtitle: "Sunday to Saturday, across every shop of the same employer; the premium is half the base rate for each overtime hour.",
        columns: [text("Employer"), text("Employee"), text("Week of"), hrs("Hours toward overtime", false), hrs("Overtime hours"), ...(rates ? [rate("Base rate")] : []), money(`OT premium (${codes.overtimeCode})`)],
        rows: weekRows,
        sort: byText(2),
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      `Qualified tips are every tip that went through payroll or was paid out (card, cash and gift card tips rung up, adjustments) plus cash tips employees declared, never the card surcharge or a service charge. Box 12 code ${codes.qualifiedTipsCode} and the overtime premium code ${codes.overtimeCode} are set in Payroll setup.`,
      "iSolved files the W-2s. Before year end the CPA and iSolved confirm the codes, each employee's tipped occupation code (Treasury's list), and whether the overtime premium uses the base rate or the blended regular rate (commission raises it). Nothing here changes a paycheck.",
      ...(rates ? [] : ['Base rates show only with "See pay rates and labor cost".']),
    ],
  };
}

// ───────────────────────────── 45B FICA tip credit (SB-C6, ST-C13) ─────────────────────────────

/**
 * Tips that count toward the 45B credit for employer FICA on tips, by employer, employee and month:
 * tips (charged, cash rung up and declared) over what it takes to bring that month's cash wages up to
 * the credit's floor ($7.25 an hour for barbering unless the CPA says otherwise), times the employer
 * FICA rate. A pay period's tips count in the month of its paycheck, when they're reported and FICA
 * is due on them; the per-period rows show the same figures before the month nets them. Only from the
 * date in Payroll setup. The CPA claims it (Form 8846) and confirms barbering qualifies for the year.
 */
export async function payrollFicaTipCreditData(i: PayrollReportInput): Promise<ReportData> {
  const { scope, loc } = i;
  const rates = !!i.perms?.has("payroll.rates");
  const [{ runs, capped }, presets] = await Promise.all([runsIn(scope), payPeriodPresets(undefined, scope.shopIds)]);
  const settings = runs[0]?.view.settings ?? (await loadSettings());
  const { creditFrom, creditWageCentsPerHour: floor, ficaRate } = settings.tipTax;
  const employer = await employersOf([...new Set(runs.flatMap((r) => r.blocks.map((b) => b.shopId)))]);
  const rowsOut: ListRow[] = [];
  type Month = { month: string; employer: string; taxId: string; staffId: string; shopId: string; name: string; hours: number; wages: number; charged: number; posCash: number; declared: number; periods: number; locked: number };
  const months = new Map<string, Month>();
  let skipped = 0;
  for (const r of runs) {
    if (r.ref.end < creditFrom) {
      skipped++;
      continue;
    }
    for (const l of r.lines) {
      const e = employer(l.shopId);
      const hours = workedHours(l);
      const wages = toCents(l.laborCost);
      const charged = toCents(l.chargedTips);
      const posCash = toCents(l.tips) - charged;
      const declared = toCents(l.declaredCashTips ?? 0);
      const tips = charged + posCash + declared;
      if (!tips && !hours) continue;
      const shortfall = Math.max(0, Math.round(floor * hours) - wages);
      const creditable = Math.max(0, tips - shortfall);
      const locked = !!r.blocks.find((b) => b.shopId === l.shopId)?.locked;
      rowsOut.push({
        shopId: l.shopId,
        staffId: l.staffId,
        key: `${r.key}|${l.staffId}|${l.shopId}`,
        cells: [r.label, e.name, e.taxId, l.name, h2(hours), ...(rates ? [wages] : []), charged, posCash, declared, tips, shortfall, creditable, Math.round(creditable * ficaRate), locked ? "Locked" : "Draft"],
      });
      const month = (r.ref.groups.find((g) => g.shopId === l.shopId)?.checkDate ?? r.ref.end).slice(0, 7);
      const k = `${month}|${e.name}|${l.staffId}`;
      const m = months.get(k) ?? { month, employer: e.name, taxId: e.taxId, staffId: l.staffId, shopId: l.shopId, name: l.name, hours: 0, wages: 0, charged: 0, posCash: 0, declared: 0, periods: 0, locked: 0 };
      m.hours += hours;
      m.wages += wages;
      m.charged += charged;
      m.posCash += posCash;
      m.declared += declared;
      m.periods++;
      if (locked) m.locked++;
      months.set(k, m);
    }
  }
  const byEmployer = new Map<string, { shopId: string; tips: number; creditable: number; credit: number }>();
  const monthRows: ListRow[] = [...months.values()].map((m) => {
    const tips = m.charged + m.posCash + m.declared;
    const shortfall = Math.max(0, Math.round(floor * m.hours) - m.wages);
    const creditable = Math.max(0, tips - shortfall);
    const credit = Math.round(creditable * ficaRate);
    const t = byEmployer.get(m.employer) ?? { shopId: m.shopId, tips: 0, creditable: 0, credit: 0 };
    t.tips += tips;
    t.creditable += creditable;
    t.credit += credit;
    byEmployer.set(m.employer, t);
    return {
      shopId: m.shopId,
      staffId: m.staffId,
      key: `${m.month}|${m.employer}|${m.staffId}`,
      cells: [
        formatDate(`${m.month}-01`, "MMM yyyy"),
        m.employer,
        m.taxId,
        m.name,
        h2(m.hours),
        ...(rates ? [m.wages] : []),
        m.charged,
        m.posCash,
        m.declared,
        tips,
        shortfall,
        creditable,
        credit,
        m.locked === m.periods ? "Locked" : `${m.periods - m.locked} of ${m.periods} periods not locked`,
      ],
    };
  });
  monthRows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const total = { tips: sumOf([...byEmployer.values()], (x) => x.tips), creditable: sumOf([...byEmployer.values()], (x) => x.creditable), credit: sumOf([...byEmployer.values()], (x) => x.credit) };
  const figures = (first: string) => [
    text(first),
    text("Employer"),
    text("FEIN"),
    text("Employee"),
    hrs("Hours worked"),
    ...(rates ? [money("Cash wages")] : []),
    money("Charged tips"),
    money("Cash tips rung up"),
    money("Cash tips declared"),
    money("Reported tips"),
    money("Needed to reach the floor"),
    money("Tips that count"),
    money("Estimated credit"),
    text("Status"),
  ];
  return {
    presets,
    stats: [
      { label: "Tips", value: formatCents(total.tips), hint: "charged, cash rung up and declared" },
      { label: "Tips that count", value: formatCents(total.creditable), hint: `over ${formatCents(floor)} an hour in cash wages, by month` },
      { label: "Estimated credit", value: formatCents(total.credit), hint: `${(ficaRate * 100).toFixed(2)}% employer FICA` },
    ],
    tables: [
      listTable(combined(loc), {
        id: "months",
        title: "By month and employee",
        subtitle: "What Form 8846 adds up: each month's tips and cash wages, by the month of the paycheck.",
        columns: figures("Month"),
        rows: monthRows,
        sort: byText(0),
      }),
      listTable(combined(loc), {
        id: "employers",
        title: "By employer",
        columns: [text("Employer"), money("Reported tips"), money("Tips that count"), money("Estimated credit")],
        rows: [...byEmployer.entries()].map(([name, t]) => ({ shopId: t.shopId, key: name, cells: [name, t.tips, t.creditable, t.credit] })),
        sort: byText(0),
      }),
      listTable(combined(loc), {
        id: "employees",
        title: "By pay period and employee",
        subtitle: "Each pay period on its own; the month nets them, so these can add up to a little more or less than the months.",
        columns: figures("Pay period"),
        rows: rowsOut,
        sort: byText(0),
      }),
    ],
    notes: [
      ...periodNotes(runs, capped),
      ...(skipped ? [`${skipped === 1 ? "A pay period ends" : `${skipped} pay periods end`} before ${formatDate(creditFrom, "MMM d, yyyy")}, when the credit starts in Payroll setup, so ${skipped === 1 ? "it's" : "they're"} left out.`] : []),
      `Cash wages are hourly, overtime, training and commission pay, never tips. Each month, tips needed to bring them to ${formatCents(floor)} an hour don't count; the rest earn ${(ficaRate * 100).toFixed(2)}% of employer Social Security and Medicare back. Since 2025, barbering and other beauty services qualify at the federal minimum wage. The floor, the rate and the start date are set in Payroll setup.`,
      "An estimate for the CPA, who claims the credit (Form 8846) and confirms the shops qualify for the year and the floor to use. Nothing here changes a paycheck or the iSolved file.",
      ...(rates ? [] : ['Cash wages show only with "See pay rates and labor cost"; the credit still uses them.']),
    ],
  };
}
