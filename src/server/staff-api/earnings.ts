import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollApprovals, payrollExportSends, payrollRuns, paymentTransfers, sales, shops, tipAbsorptions, tipLedger, tipPayouts } from "@/db/schema";
import { periodOf, periodStarting, periodsAround, type PayCalendar } from "@/domain/payroll/calendar";
import { DEFAULT_PAYROLL_SETTINGS, employeePay, exportRowChecks, paystubLines, toCents, type Line, type ShopBlock } from "@/domain/payroll/calc";
import {
  CASH_TIPS_COPY,
  GROSS_LABEL,
  LATE_DECLARATION_COPY,
  LATE_TIP_COPY,
  OT_PAY_LABEL,
  PARTIAL_WEEK_OT_LABEL,
  PAYROLL_TIPS_COPY,
  REFUNDED_AFTER_EXPORT_COPY,
  SHOP_COVERS_REFUND_COPY,
  cashTipReminder,
  hoursOf,
  periodPay,
  trainingLine,
  type TrainingLine,
} from "@/domain/my-earnings";
import { type ClientCounts, linesPph } from "@/domain/pph";
import { blockTickets } from "@/server/service-tickets";
import { appPayoutStatus, appTransferStatus } from "@/domain/staff-payouts";
import { employeeFeeCents, receivedCents } from "@/domain/tips";
import { SHOP_TZ, addDays, diffDays, endOfLocalDay, isValidLocalDate, localDateOf, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { audit } from "@/server/audit";
import { AppError, forbidden } from "@/server/errors";
import { approvalOf, buildPayroll, dayFigures, ensurePayGroups, lockedRunsOver, type DayFigures, type PayrollView } from "@/server/payroll/run";
import { PAID, rows, uuids } from "@/server/report-sql";
import { notSquireEra } from "@/server/squire-era";
import { staffAccount } from "@/server/tips/accounts";
import { currentDeclarationsOf } from "@/server/tips/declarations";
import { syncTipLedger } from "@/server/tips/ledger";
import type { TipPayout } from "@/server/tips/payouts";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { tipToBarberShops } from "@/server/payments/settlement";
import type { StaffAppContext } from "./http";
import { payoutSetup, sees, type Sees } from "./pay";

/**
 * My Earnings, the Rayz App builder's contract (2026-10-28): the signed-in employee's own pay
 * periods, pay for one period, days, tickets and Stripe payouts. The employee is always the token's;
 * nothing here takes a staff id. Amounts are integer cents.
 *
 * Pay comes from their line of the Payroll Report (buildPayroll, the run the iSolved file is made
 * from), through periodPay, so the greater-of and every total are worked out once, on the server,
 * the way payroll works them out. Days add up to the period: hours and sales are read as the report
 * reads them, tips from the tip ledger the report's TIPS reconciles to (dayFigures). A locked or
 * exported period is what its lock kept: the approved lines, days and workweeks, never worked out
 * again from the live data.
 *
 * A pay period's id is its start date. period=current is the one holding today.
 */

/** Longest from/to for days, tickets and payouts: each day is its own read of the report's sales. */
export const MAX_RANGE_DAYS = 31;

type MyShop = { id: string; name: string };
type ShopCalendar = { shop: MyShop; groupId: string; calendar: PayCalendar };

export interface MyPeriod {
  id: LocalDate;
  start: LocalDate;
  end: LocalDate;
  number: number;
  checkDate: LocalDate;
  /** Their shops whose pay calendar has this period. */
  cals: ShopCalendar[];
}

async function myShops(staffId: string): Promise<MyShop[]> {
  const ids = await workShopIds(staffId);
  return ids.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived"))) : [];
}

async function myCalendars(staffId: string) {
  const [list, groups] = await Promise.all([myShops(staffId), ensurePayGroups()]);
  const g = new Map(groups.map((x) => [x.shopId, x]));
  const cals: ShopCalendar[] = list.flatMap((s) => (g.has(s.id) ? [{ shop: s, groupId: g.get(s.id)!.id, calendar: g.get(s.id)!.calendar }] : []));
  return { shops: list, cals };
}

/** The pay period starting on `start` at their shops (the brand's shops share period dates; a shop on a calendar that doesn't start one then isn't in it). */
function periodAt(cals: readonly ShopCalendar[], start: LocalDate): MyPeriod | null {
  const hits = cals.flatMap((c) => {
    const p = periodStarting(c.calendar, start);
    return p && p.number >= 1 ? [{ c, p }] : [];
  });
  if (!hits.length) return null;
  const same = hits.filter((h) => h.p.end === hits[0].p.end);
  return { id: start, start, end: same[0].p.end, number: same[0].p.number, checkDate: same.map((h) => h.p.checkDate).sort().at(-1)!, cals: same.map((h) => h.c) };
}

function currentPeriod(cals: readonly ShopCalendar[], today: LocalDate): MyPeriod | null {
  const starts = cals.map((c) => periodOf(c.calendar, today).start).sort();
  return starts.length ? periodAt(cals, starts.at(-1)!) : null;
}

export interface PeriodQuery {
  period?: string;
  periodId?: string;
  from?: string;
  to?: string;
}

const bad = (message: string, field: string) => new AppError("bad_request", message, { field });

/** "current", a start date, or null when none was sent. */
function periodIdOf(q: PeriodQuery): "current" | LocalDate | null {
  if (q.period !== undefined && q.periodId !== undefined) throw bad("Send period or periodId, not both", "periodId");
  const v = q.periodId ?? q.period;
  if ((q.from !== undefined || q.to !== undefined) && v !== undefined) throw bad("Send from/to or a pay period, not both", "from");
  if (v === undefined) return null;
  if (v === "current") return v;
  if (!isValidLocalDate(v)) throw bad("A pay period's id is its start date, like 2026-10-18, or period=current", q.periodId !== undefined ? "periodId" : "period");
  return v;
}

function periodById(cals: readonly ShopCalendar[], id: "current" | LocalDate, today: LocalDate, field: string): MyPeriod {
  const p = id === "current" ? currentPeriod(cals, today) : periodAt(cals, id);
  if (!p)
    throw new AppError("not_found", id === "current" ? "You aren't on a shop's pay calendar" : "No pay period starts then: its id is the date it starts (GET /me/pay-periods lists them)", { field });
  return p;
}

function rangeOf(q: PeriodQuery): { from: LocalDate; to: LocalDate } | null {
  if (q.from === undefined && q.to === undefined) return null;
  if (q.from === undefined || q.to === undefined) throw bad("Send both from and to", q.from === undefined ? "from" : "to");
  if (q.from > q.to) throw bad("from is after to", "from");
  return { from: q.from, to: q.to };
}

/** /me/earnings: pay is worked out per pay period, so a from/to has to be exactly one. */
function earningsPeriod(cals: readonly ShopCalendar[], q: PeriodQuery, today: LocalDate): MyPeriod {
  const id = periodIdOf(q);
  const range = rangeOf(q);
  if (!range) return periodById(cals, id ?? "current", today, q.periodId !== undefined ? "periodId" : "period");
  const p = periodAt(cals, range.from);
  if (!p || p.end !== range.to)
    throw bad("Pay is worked out per pay period: send period=current, period=<id> or periodId=<id> (or a from/to that is exactly one pay period). GET /me/earnings/days covers any range.", "from");
  return p;
}

/** Days, tickets and payouts: a pay period, or any from/to up to MAX_RANGE_DAYS. Nothing sent: the current period. */
function spanOf(cals: readonly ShopCalendar[], q: PeriodQuery, today: LocalDate): { from: LocalDate; to: LocalDate; period: MyPeriod | null } {
  const id = periodIdOf(q);
  const range = rangeOf(q);
  if (range) {
    if (diffDays(range.to, range.from) >= MAX_RANGE_DAYS) throw bad(`from/to covers at most ${MAX_RANGE_DAYS} days`, "to");
    const p = periodAt(cals, range.from);
    return { ...range, period: p && p.end === range.to ? p : null };
  }
  const p = periodById(cals, id ?? "current", today, q.periodId !== undefined ? "periodId" : "period");
  return { from: p.start, to: p.end, period: p };
}

// ───────────────────────────── Period status ─────────────────────────────

export type PeriodStatus = "draft" | "approved" | "locked" | "exported";
export type PayrollStatus = "not_yet_processed" | "sent_to_payroll" | "paid_in_paycheck";

interface PeriodState {
  periodStatus: PeriodStatus;
  payrollStatus: PayrollStatus;
  /** The Payroll Report's iSolved file status for the period. */
  exportStatus: "draft" | "approved" | "sent";
  /** False once their shops' figures are the approved snapshot (locked) or sent to iSolved. */
  isEstimate: boolean;
  snapshotId: string | null;
  computedAt: string;
  sentAt: string | null;
}

/**
 * Each period's status for their shops: exported once it's marked sent to iSolved, locked when every
 * one of their shops is locked for it, approved while an approval is on it and the figures still
 * match it (as the Payroll Report checks), and draft otherwise. Paid in a paycheck from its check date.
 */
async function periodStates(periods: readonly MyPeriod[], today: LocalDate, views: Map<LocalDate, PayrollView | null> = new Map()): Promise<Map<LocalDate, PeriodState>> {
  if (!periods.length) return new Map();
  const starts = periods.map((p) => p.start);
  const [runs, sends, approvals] = await Promise.all([
    db.select({ id: payrollRuns.id, g: payrollRuns.payGroupId, s: payrollRuns.periodStart, e: payrollRuns.periodEnd, at: payrollRuns.lockedAt }).from(payrollRuns).where(inArray(payrollRuns.periodStart, starts)),
    db.select({ s: payrollExportSends.periodStart, e: payrollExportSends.periodEnd, at: payrollExportSends.sentAt }).from(payrollExportSends).where(inArray(payrollExportSends.periodStart, starts)),
    db.select({ s: payrollApprovals.periodStart, e: payrollApprovals.periodEnd }).from(payrollApprovals).where(and(inArray(payrollApprovals.periodStart, starts), isNull(payrollApprovals.revokedAt))),
  ]);
  const out = new Map<LocalDate, PeriodState>();
  for (const p of periods) {
    const same = (x: { s: string; e: string }) => x.s === p.start && x.e === p.end;
    const mine = runs.filter((r) => same(r) && p.cals.some((c) => c.groupId === r.g));
    const locked = mine.length > 0 && mine.length === p.cals.length;
    const sent = sends.find(same);
    let approved = false;
    if (!sent && !locked && approvals.some(same)) {
      const view = views.has(p.start) ? views.get(p.start)! : await buildPayroll(p.start, p.end, { clockChecks: false });
      approved = !!view && !!(await approvalOf(view))?.current;
    }
    out.set(p.start, {
      periodStatus: sent ? "exported" : locked ? "locked" : approved ? "approved" : "draft",
      payrollStatus: sent ? (p.checkDate <= today ? "paid_in_paycheck" : "sent_to_payroll") : "not_yet_processed",
      exportStatus: sent ? "sent" : locked || approved ? "approved" : "draft",
      isEstimate: !sent && !locked,
      snapshotId: locked ? mine.map((r) => r.id).sort().join("+") : null,
      computedAt: locked ? new Date(Math.max(...mine.map((r) => r.at.getTime()))).toISOString() : new Date().toISOString(),
      sentAt: sent?.at.toISOString() ?? null,
    });
  }
  return out;
}

/** GET /me/pay-periods: their pay periods, newest first: the one holding today and eight before it. */
export async function myPayPeriodList(ctx: StaffAppContext, today: LocalDate = todayLocal()) {
  sees(ctx);
  const { cals } = await myCalendars(ctx.staff.id);
  const starts = new Set<LocalDate>();
  for (const c of cals) for (const p of periodsAround(c.calendar, today, 8, 0)) if (p.number >= 1) starts.add(p.start);
  const periods = [...starts]
    .sort()
    .reverse()
    .flatMap((s) => periodAt(cals, s) ?? []);
  const st = await periodStates(periods, today);
  return {
    periods: periods.map((p) => {
      const s = st.get(p.start)!;
      return {
        id: p.id,
        start: p.start,
        end: p.end,
        number: p.number,
        checkDate: p.checkDate,
        periodStatus: s.periodStatus,
        payrollStatus: s.payrollStatus,
        exportStatus: s.exportStatus,
        isEstimate: s.isEstimate,
        current: p.start <= today && today <= p.end,
        shopIds: p.cals.map((c) => c.shop.id),
      };
    }),
  };
}

// ───────────────────────────── Tips, transfers and payouts ─────────────────────────────

async function myLedger(staffId: string, shopIds: readonly string[], w: { from: LocalDate; to: LocalDate } | { saleIds: readonly string[] }) {
  if (!shopIds.length || ("saleIds" in w && !w.saleIds.length)) return [];
  await syncTipLedger(db, { shopIds });
  return db
    .select({
      id: tipLedger.id,
      shopId: tipLedger.shopId,
      saleId: tipLedger.saleId,
      kind: tipLedger.kind,
      method: tipLedger.method,
      amountCents: tipLedger.amountCents,
      date: tipLedger.businessDate,
      saleDate: sales.businessDate,
      shared: sql<boolean>`exists (select 1 from tip_split_shares x where x.sale_id = ${tipLedger.saleId} and x.staff_id <> ${tipLedger.staffId})`,
      payout: tipPayouts,
      transfer: paymentTransfers,
    })
    .from(tipLedger)
    .leftJoin(sales, eq(sales.id, tipLedger.saleId))
    .leftJoin(tipPayouts, and(eq(tipPayouts.id, tipLedger.payoutId), eq(tipPayouts.staffId, tipLedger.staffId)))
    .leftJoin(
      paymentTransfers,
      and(eq(tipLedger.kind, "tip"), eq(paymentTransfers.kind, "tip"), eq(paymentTransfers.paymentId, tipLedger.paymentId), eq(paymentTransfers.staffId, tipLedger.staffId)),
    )
    .where(
      and(
        eq(tipLedger.staffId, staffId),
        inArray(tipLedger.shopId, [...shopIds]),
        "saleIds" in w ? inArray(tipLedger.saleId, [...w.saleIds]) : and(gte(tipLedger.businessDate, w.from), lte(tipLedger.businessDate, w.to)),
      ),
    )
    .orderBy(asc(tipLedger.businessDate), asc(tipLedger.createdAt));
}

type LedgerRow = Awaited<ReturnType<typeof myLedger>>[number];
type Transfer = NonNullable<LedgerRow["transfer"]>;

/** Their tips by tender, net of the refunds taken back from them; manager adjustments apart. */
function tendersOf(list: readonly Pick<LedgerRow, "method" | "amountCents">[]) {
  const t = { card: 0, cash: 0, giftCard: 0, adjust: 0 };
  for (const r of list) t[r.method === "card" ? "card" : r.method === "cash" ? "cash" : r.method === "gift_card" ? "giftCard" : "adjust"] += r.amountCents;
  return t;
}

const dateOf = (d: Date | null | undefined) => (d ? localDateOf(d) : null);

/** A Stripe tip payout. payoutStatus is Stripe's (pending, in_transit, paid, failed, canceled): a payout is never "reversed". */
function payoutBrief(p: TipPayout) {
  return {
    payoutStatus: appPayoutStatus(p),
    amountCents: receivedCents(p),
    arrivalDate: p.arrivalDate ?? (p.status === "paid" ? dateOf(p.paidAt) : null),
    bankLast4: p.destinationLast4,
    failureMessage: p.failureMessage,
  };
}

/** A card tip's transfer to their Stripe account at the sale; null for one never made. Its status is the transfer's, never the payout's. */
function transferBrief(t: Transfer) {
  const s = appTransferStatus(t);
  return s ? { transferStatus: s.status, transferReversedBy: s.reversedBy, amountCents: t.amountCents, transferArrivalDate: t.status === "sent" ? dateOf(t.sentAt) : null } : null;
}

type Setup = Awaited<ReturnType<typeof payoutSetup>>;
interface TipRoute {
  method: Setup["shops"][number]["method"];
  /** The shop's tip switch (tip_to_barber, with FEATURE_TIP_TO_BARBER): off, its card tips are paid through payroll. */
  tipToBarber: boolean;
  /** Their card tips here go to their Stripe account at the sale: Stripe is how they're paid, Stripe payouts are on, and the shop's switch is on. */
  transfers: boolean;
}

/** How each of their shops pays them their tips, held to each shop's tip switch. */
async function tipRoutesOf(setup: Setup): Promise<Map<string, TipRoute>> {
  const on = await tipToBarberShops(setup.shops.map((x) => x.shopId));
  return new Map(setup.shops.map((x) => [x.shopId, { method: x.method, tipToBarber: on.has(x.shopId), transfers: x.method === "stripe" && stripePayoutsOn() && on.has(x.shopId) }]));
}

const payrollCopyOf = (r: TipRoute | undefined) => (r?.transfers ? null : r?.method === "cash" ? CASH_TIPS_COPY : PAYROLL_TIPS_COPY);

/** How their tip on a ticket reaches them: Stripe (a transfer made, or the shop's switch on), the shop's cash drawer, or payroll. */
function dispositionOf(r: LedgerRow | undefined, route: TipRoute | undefined): "stripe" | "payroll" | "cash" {
  if (r?.transfer && r.transfer.status !== "cancelled") return "stripe";
  const via = r?.payout?.method ?? (route?.transfers ? "stripe" : route?.method === "cash" ? "cash" : "payroll");
  return via === "stripe" ? "stripe" : via === "cash" ? "cash" : "payroll";
}

/** Tips the shop covered for them: refunded to the client after the tip reached them (or outside the refund window), so their pay isn't reduced. */
async function shopCoveredRefunds(staffId: string, shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  if (!shopIds.length) return [];
  const list = await db
    .select({
      id: tipAbsorptions.id,
      shopId: tipAbsorptions.shopId,
      kind: tipAbsorptions.kind,
      amountCents: tipAbsorptions.amountCents,
      date: tipAbsorptions.businessDate,
      saleDate: sales.businessDate,
      saleId: tipAbsorptions.saleId,
      afterExport: sql<boolean>`exists (select 1 from payroll_runs lr join pay_groups lg on lg.id = lr.pay_group_id where lg.shop_id = ${sales.shopId} and ${sales.businessDate} between lr.period_start and lr.period_end)`,
    })
    .from(tipAbsorptions)
    .leftJoin(sales, eq(sales.id, tipAbsorptions.saleId))
    .where(and(eq(tipAbsorptions.staffId, staffId), inArray(tipAbsorptions.shopId, [...shopIds]), gte(tipAbsorptions.businessDate, from), lte(tipAbsorptions.businessDate, to), ne(tipAbsorptions.kind, "dispute")))
    .orderBy(asc(tipAbsorptions.businessDate));
  return list.map((a) => ({
    id: a.id,
    kind: a.afterExport ? ("tip_refunded_after_export" as const) : ("card_tip_refund" as const),
    shopId: a.shopId,
    saleId: a.saleId,
    amountCents: a.amountCents,
    effectCents: 0,
    originalDate: a.saleDate ?? a.date,
    postedDate: a.date,
    lateDeclaration: false,
    flagged: a.afterExport,
    reducesPay: false as const,
    reason: a.kind,
    copy: a.afterExport ? REFUNDED_AFTER_EXPORT_COPY : SHOP_COVERS_REFUND_COPY,
  }));
}

/**
 * What changed after an earlier pay period was locked and is flagged in this one instead (that one is
 * never reopened): tips on its tickets that came in late and cash tips declared late, each paid here
 * (effectCents), and its card tips refunded since, which the shop covers (nothing taken from them).
 * Amounts are never negative.
 */
function lateChanges(ledger: readonly LedgerRow[], declared: readonly { id: string; shopId: string; businessDate: string; postedDate: string; amountCents: number }[], covered: Awaited<ReturnType<typeof shopCoveredRefunds>>, start: LocalDate) {
  const flag = { flagged: true as const, reducesPay: false as const };
  return [
    ...ledger
      .filter((r) => r.kind === "tip" && r.saleDate && r.saleDate < start)
      .map((r) => ({ id: r.id, kind: "late_tip" as const, shopId: r.shopId, saleId: r.saleId, amountCents: r.amountCents, effectCents: r.amountCents, originalDate: r.saleDate!, postedDate: r.date, lateDeclaration: false, ...flag, copy: LATE_TIP_COPY })),
    ...declared
      .filter((d) => d.businessDate < start)
      .map((d) => ({ id: d.id, kind: "late_declaration" as const, shopId: d.shopId, saleId: null, amountCents: d.amountCents, effectCents: d.amountCents, originalDate: d.businessDate, postedDate: d.postedDate, lateDeclaration: true, ...flag, copy: LATE_DECLARATION_COPY })),
    ...covered.filter((c) => c.kind === "tip_refunded_after_export").map(({ reason: _r, ...c }) => ({ ...c, ...flag })),
  ].sort((a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id));
}

// ───────────────────────────── GET /me/earnings ─────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

/** Their line's columns in the shop's iSolved file against the report, for the parts they may see. */
function reconciliationOf(see: Sees, block: ShopBlock | undefined, line: Line | undefined) {
  const isolved = (block && line ? exportRowChecks(block, line) : [])
    .filter((x) => see[x.group])
    .map((x) => ({ header: x.header, unit: x.unit, group: x.group, amount: x.exported, payrollReport: x.report, matches: x.matches }));
  return { matches: isolved.every((x) => x.matches), isolved, adjustedOnReport: line?.overridden ?? [] };
}

/**
 * Their Chicago workweeks (Sunday to Saturday) touching the period, with the hours at every shop they
 * worked added up, as payroll counts overtime; each shop's part, and which pay period each part is
 * paid in. OT hours are payroll's; the dollars are an estimate until iSolved applies the 1.5x.
 */
function weeksOf(view: PayrollView | null, staffId: string, p: MyPeriod) {
  return (view?.weeks[staffId] ?? []).map((w) => {
    const prod = r2(sum(w.slices, (s) => s.worked));
    const train = r2(sum(w.slices, (s) => s.training));
    const ot = r2(sum(w.slices, (s) => s.ot));
    const weekEnd = addDays(w.weekStart, 6);
    const partial = w.weekStart < p.start || weekEnd > p.end;
    const byPeriod = new Map<LocalDate, (typeof w.slices)[number][]>();
    for (const s of w.slices) byPeriod.set(s.periodStart, [...(byPeriod.get(s.periodStart) ?? []), s]);
    const byShop = new Map<string, (typeof w.slices)[number][]>();
    for (const s of w.slices) byShop.set(s.shopId, [...(byShop.get(s.shopId) ?? []), s]);
    return {
      weekStart: w.weekStart,
      weekEnd,
      timezone: SHOP_TZ,
      productionHours: prod,
      trainingHours: train,
      regularHours: r2(prod + train - ot),
      otHours: ot,
      /** Hours that count toward the overtime threshold, every shop added up. */
      basisHours: w.basis,
      partial,
      otIsEstimate: ot > 0,
      otLabelCode: partial ? ("partial_week" as const) : ot > 0 ? ("ot_estimated" as const) : null,
      otLabel: partial ? PARTIAL_WEEK_OT_LABEL : ot > 0 ? OT_PAY_LABEL : null,
      shops: [...byShop].map(([shopId, list]) => ({
        shopId,
        shopName: list[0].shop,
        productionHours: r2(sum(list, (s) => s.worked)),
        trainingHours: r2(sum(list, (s) => s.training)),
        otHours: r2(sum(list, (s) => s.ot)),
      })),
      postings: [...byPeriod].map(([periodId, list]) => {
        const pw = r2(sum(list, (s) => s.worked));
        const pt = r2(sum(list, (s) => s.training));
        const po = r2(sum(list, (s) => s.ot));
        return { periodId, productionHours: pw, trainingHours: pt, regularHours: r2(pw + pt - po), otHours: po };
      }),
    };
  });
}

/**
 * GET /me/earnings?period=current|<id> (or periodId=<id>): one pay period at every shop of theirs on
 * it, from their line of the Payroll Report. Parts they may not see are null: pay without
 * compensation.own, tips without tips.own, sales without report.my_sales.view and reports.money,
 * hours without timesheet.own. totalCents needs both pay and tips, pph both sales and hours.
 */
export async function myEarnings(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  const me = ctx.staff.id;
  const { cals } = await myCalendars(me);
  const per = earningsPeriod(cals, q, today);
  const shopIds = per.cals.map((c) => c.shop.id);
  const view = await buildPayroll(per.start, per.end, { clockChecks: false });
  const [state, ledger, days, declared, covered, setup, tickets] = await Promise.all([
    periodStates([per], today, new Map([[per.start, view]])).then((m) => m.get(per.start)!),
    see.tips ? myLedger(me, shopIds, { from: per.start, to: per.end }) : [],
    see.tips ? myDays(me, shopIds, per.start, per.end, today) : [],
    see.tips ? currentDeclarationsOf(me, shopIds, per.start, per.end) : [],
    see.tips ? shopCoveredRefunds(me, shopIds, per.start, per.end) : [],
    payoutSetup(ctx),
    see.sales && see.hours && view ? blockTickets(view.blocks.filter((b) => shopIds.includes(b.shopId)), [me]) : new Map<string, number>(),
  ]);
  const routes = await tipRoutesOf(setup);
  const countsTowardOt = (view?.settings ?? DEFAULT_PAYROLL_SETTINGS).trainingCountsTowardOt;
  const trainingOf = (lines: readonly Line[]) => (see.wages ? seenTraining(trainingLine(lines, { countsTowardOt }), see.hours) : null);

  const slices = per.cals.map((c) => {
    const block = view?.blocks.find((b) => b.shopId === c.shop.id);
    const line = block?.lines.find((l) => l.staffId === me);
    const pay = line ? employeePay(line) : null;
    const here = days.filter((d) => d.shopId === c.shop.id);
    const t = { card: sum(here, (d) => d.cardTipsCents), cash: sum(here, (d) => d.cashTipsCents), giftCard: sum(here, (d) => d.giftCardTipsCents) };
    const tipsCents = pay?.tipsCents ?? 0;
    const declaredCents = pay?.declaredCashTipsCents ?? 0;
    const route = routes.get(c.shop.id);
    return {
      line,
      pay,
      out: {
        shopId: c.shop.id,
        shopName: c.shop.name,
        tipToBarber: !!route?.tipToBarber,
        tipTransfersEnabled: !!route?.transfers,
        payrollCopy: payrollCopyOf(route),
        cardTipsCents: see.tips ? t.card : null,
        cashTipsCents: see.tips ? t.cash + declaredCents : null,
        serviceSalesCents: see.sales ? (line ? toCents(line.service) : 0) : null,
        productSalesCents: see.sales ? (line ? toCents(line.product) : 0) : null,
        giftCardTipsCents: see.tips ? t.giftCard : null,
        cashOnTicketsCents: see.tips ? t.cash : null,
        declaredCashTipsCents: see.tips ? declaredCents : null,
        tipAdjustmentsCents: see.tips ? tipsCents - t.card - t.cash - t.giftCard : null,
        totalTipsCents: see.tips ? tipsCents + declaredCents : null,
        tipsInPayrollCents: see.tips ? (line ? toCents(line.tipsInPayroll) : 0) : null,
        tipsPaidSeparatelyCents: see.tips ? (line ? toCents(line.tipsOutside) : 0) : null,
        paystub: block ? paystubLines(block, me).filter((l) => see[l.group]) : [],
        source: block?.source ?? "platform",
        squireImported: block?.source === "squire" && !!block.squireImport,
        locked: !!block?.locked,
        fromLock: !!block?.locked,
        pay: see.wages ? pay : null,
        training: trainingOf(line ? [line] : []),
        hours: see.hours ? shopHours(line) : null,
        pph: pphOut(line ? [line] : [], see, tickets),
        reconciliation: reconciliationOf(see, block, line),
      },
    };
  });

  const total = periodPay(slices.flatMap((s) => (s.line ? [s.line] : [])));
  const tipsOf = (k: "cardTipsCents" | "cashTipsCents" | "giftCardTipsCents" | "cashOnTicketsCents" | "declaredCashTipsCents" | "tipAdjustmentsCents" | "totalTipsCents") =>
    see.tips ? sum(slices, (s) => s.out[k] ?? 0) : null;
  const wages = see.wages;
  const nav = neighbours(cals, per, today);

  return {
    from: per.start,
    to: per.end,
    period: { id: per.id, start: per.start, end: per.end, number: per.number, checkDate: per.checkDate },
    previousPeriodId: nav.previous,
    nextPeriodId: nav.next,
    sees: see,
    grossLabel: GROSS_LABEL,
    isEstimate: state.isEstimate,
    periods: [{ id: per.id, start: per.start, end: per.end, periodStatus: state.periodStatus, payrollStatus: state.payrollStatus, isEstimate: state.isEstimate, snapshotId: state.snapshotId, computedAt: state.computedAt }],
    periodStatus: state.periodStatus,
    payrollStatus: state.payrollStatus,
    exportStatus: state.exportStatus,
    sentToPayrollAt: state.sentAt,
    snapshotId: state.snapshotId,
    computedAt: state.computedAt,

    ...nulled(total.wages, wages),
    training: trainingOf(slices.flatMap((s) => (s.line ? [s.line] : []))),
    otIsEstimate: true,
    otDisclosure: OT_PAY_LABEL,
    ...nulled(total.hours, see.hours),

    serviceSalesCents: see.sales ? sum(slices, (s) => s.out.serviceSalesCents ?? 0) : null,
    productSalesCents: see.sales ? sum(slices, (s) => s.out.productSalesCents ?? 0) : null,
    pph: pphOut(
      slices.flatMap((s) => (s.line ? [s.line] : [])),
      see,
      tickets,
    ),
    cardTipsCents: tipsOf("cardTipsCents"),
    cashTipsCents: tipsOf("cashTipsCents"),
    giftCardTipsCents: tipsOf("giftCardTipsCents"),
    cashOnTicketsCents: tipsOf("cashOnTicketsCents"),
    declaredCashTipsCents: tipsOf("declaredCashTipsCents"),
    tipAdjustmentsCents: tipsOf("tipAdjustmentsCents"),
    totalTipsCents: tipsOf("totalTipsCents"),
    totalCents: wages && see.tips ? total.grossCents : null,

    workweeks: see.hours ? weeksOf(view, me, per) : [],
    shops: slices.map((s) => s.out),
    adjustments: see.tips ? lateChanges(ledger, declared, covered, per.start) : [],
    refunds: covered.filter((c) => c.kind === "card_tip_refund"),
    declarations: declared.map((d) => ({ id: d.id, shopId: d.shopId, date: d.businessDate, postedDate: d.postedDate, late: d.businessDate < per.start, amountCents: d.amountCents, source: d.source })),
    cashTipReminder: view ? cashTipReminder(view.settings.declarations) : null,
    payout: setup,
  };
}

/**
 * Their own Productivity Per Hour (src/domain/pph.ts) from their lines of the Payroll Report: service
 * and product sales over worked hours (regular plus overtime), and their completed service tickets
 * over the same hours. Needs both their sales and their hours; the rates are null (N/A) with no
 * worked hours.
 */
function pphOut(lines: readonly Line[], see: Sees, tickets: ClientCounts) {
  if (!see.sales || !see.hours) return null;
  const p = linesPph(lines, tickets);
  const c = (v: number | null) => (v === null ? null : toCents(v));
  return {
    workedHours: r2(p.hours),
    servicePphCents: c(p.servicePph),
    productPphCents: c(p.productPph),
    totalPphCents: c(p.totalPph),
    clients: p.clients,
    clientsPerHour: p.clientsPerHour === null ? null : r2(p.clientsPerHour),
    na: p.servicePph === null,
  };
}

/** The training line with its hours left out for someone who may see pay but not their hours. */
const seenTraining = (t: TrainingLine, hours: boolean) => (hours ? t : { ...t, hours: null, paidAsOvertimeHours: null });

function shopHours(l: Line | undefined) {
  const h = hoursOf(l ? [l] : []);
  return { production: h.productionHours, regular: h.regularHours, overtime: h.otHours, training: h.trainingHours, pto: h.ptoHours };
}

/** Every field of `o`, or every one null when they may not see it. */
const nulled = <T extends Record<string, unknown>>(o: T, on: boolean) => (on ? o : (Object.fromEntries(Object.keys(o).map((k) => [k, null])) as { [K in keyof T]: null }));

/** The ids of the pay periods either side; the next is null while it's still to come. */
function neighbours(cals: readonly ShopCalendar[], p: MyPeriod, today: LocalDate) {
  const before = cals.map((c) => periodOf(c.calendar, addDays(p.start, -1))).filter((x) => x.number >= 1 && x.end === addDays(p.start, -1));
  const after = periodAt(cals, addDays(p.end, 1));
  return { previous: before.length ? before.map((x) => x.start).sort().at(-1)! : null, next: after && after.start <= today ? after.id : null };
}

// ───────────────────────────── GET /me/earnings/days ─────────────────────────────

type MyDay = DayFigures & { fromLock: boolean };

/**
 * Their days at these shops: for a shop's locked pay period, the days its lock kept (never worked out
 * again); otherwise, and for a period locked before locks kept days, dayFigures on the live data.
 */
async function myDays(me: string, shopIds: readonly string[], from: LocalDate, to: LocalDate, today: LocalDate): Promise<MyDay[]> {
  const until = to < today ? to : today;
  const [runs, live] = await Promise.all([lockedRunsOver(shopIds, from, to), dayFigures(me, shopIds, from, until)]);
  const kept = runs.filter((r) => r.days);
  const inKept = (d: DayFigures) => kept.some((r) => r.shopId === d.shopId && d.date >= r.start && d.date <= r.end);
  return [
    ...(live.get(me) ?? []).filter((d) => !inKept(d)).map((d) => ({ ...d, fromLock: false })),
    ...kept.flatMap((r) => (r.days![me] ?? []).filter((d) => d.date >= from && d.date <= to).map((d) => ({ ...d, fromLock: true }))),
  ].sort((x, y) => x.date.localeCompare(y.date) || x.shopId.localeCompare(y.shopId));
}

const tipsOfDay = (d: Pick<DayFigures, "cardTipsCents" | "cashTipsCents" | "giftCardTipsCents" | "tipAdjustmentsCents">) => d.cardTipsCents + d.cashTipsCents + d.giftCardTipsCents + d.tipAdjustmentsCents;

/**
 * GET /me/earnings/days?periodId= (or period=, or from/to): each day they worked, sold or were
 * tipped, every shop of theirs added up. Hours and sales are read as the Payroll Report reads them
 * and tips come from the tip ledger, so over a pay period the days add up to GET /me/earnings (before
 * a manager's override on the report). A locked period's days are the ones its lock kept.
 */
export async function myEarningsDays(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const span = spanOf(cals, q, today);
  const [list, state] = await Promise.all([
    myDays(
      me,
      mine.map((s) => s.id),
      span.from,
      span.to,
      today,
    ),
    span.period ? periodStates([span.period], today).then((m) => m.get(span.period!.start)!) : null,
  ]);
  const work = see.hours || see.sales;
  const shown = list.filter(
    (d) => (work && (d.workedCenti || d.trainingCenti || d.ptoCenti || d.tickets || d.serviceCents || d.productCents)) || (see.tips && (tipsOfDay(d) || d.declaredCashTipsCents)),
  );
  const days = [...new Set(shown.map((d) => d.date))].map((date) => {
    const x = shown.filter((d) => d.date === date);
    const S = (f: (d: MyDay) => number) => sum(x, f);
    const dec = S((d) => d.declaredCashTipsCents);
    return {
      date,
      cardTipsCents: see.tips ? S((d) => d.cardTipsCents) : null,
      cashTipsCents: see.tips ? S((d) => d.cashTipsCents) + dec : null,
      serviceSalesCents: see.sales ? S((d) => d.serviceCents) : null,
      productSalesCents: see.sales ? S((d) => d.productCents) : null,
      productionHours: see.hours ? r2(S((d) => d.workedCenti) / 100) : null,
      trainingHours: see.hours ? r2(S((d) => d.trainingCenti) / 100) : null,
      tickets: S((d) => d.tickets),
      giftCardTipsCents: see.tips ? S((d) => d.giftCardTipsCents) : null,
      cashOnTicketsCents: see.tips ? S((d) => d.cashTipsCents) : null,
      declaredCashTipsCents: see.tips ? dec : null,
      tipAdjustmentsCents: see.tips ? S((d) => d.tipAdjustmentsCents) : null,
      totalTipsCents: see.tips ? S(tipsOfDay) + dec : null,
      ptoHours: see.hours ? r2(S((d) => d.ptoCenti) / 100) : null,
      fromLock: x.every((d) => d.fromLock),
      shopIds: [...new Set(x.map((d) => d.shopId))],
    };
  });
  return { from: span.from, to: span.to, periodId: span.period?.id ?? null, ...periodFlags(state), days };
}

/** periodStatus and isEstimate for a response about one pay period; both null for a from/to that isn't one. */
const periodFlags = (s: PeriodState | null) => ({ periodStatus: s?.periodStatus ?? null, isEstimate: s ? s.isEstimate : null });

// ───────────────────────────── GET /me/earnings/tickets ─────────────────────────────

interface TicketRow {
  saleId: string;
  shopId: string;
  date: LocalDate;
  startedAt: Date | string;
  clientFirstName: string | null;
  serviceName: string | null;
  serviceCents: number;
  productCents: number;
}

/**
 * GET /me/earnings/tickets?periodId=&date=: their tickets on one Chicago calendar day of one of their
 * pay periods, each with the services and products credited to them (as payroll credits them: the
 * ticket's barber, less lines done by someone else, plus lines they did on someone else's ticket),
 * their own tip by tender (their share on a split ticket, never anyone else's), how it reaches them,
 * and the card tip's transfer status and its payout's status, each in its own field. Clients by
 * first name only.
 */
export async function myEarningsTickets(ctx: StaffAppContext, q: { periodId: string; date: string }, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  if (!see.tips && !see.sales) throw forbidden("You don't have permission to see tips or sales");
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const per = periodById(cals, periodIdOf({ periodId: q.periodId })!, today, "periodId");
  if (!isValidLocalDate(q.date) || q.date < per.start || q.date > per.end) throw bad(`date is a Chicago calendar day in that pay period, ${per.start} to ${per.end}`, "date");
  const date = q.date;
  const ids = per.cals.map((c) => c.shop.id);
  const name = new Map(mine.map((s) => [s.id, s.name]));
  const list = ids.length
    ? await rows<TicketRow>(sql`
        select s.id "saleId", s.shop_id "shopId", s.business_date::text "date", coalesce(a.starts_at, s.created_at) "startedAt", c.first_name "clientFirstName",
          (select string_agg(distinct si.name, ', ') from sale_items si where si.sale_id = s.id and si.kind = 'service' and coalesce(si.staff_id, s.staff_id) = ${me}) "serviceName",
          ((case when s.staff_id = ${me} then s.service_net_cents else 0 end)
            + coalesce((select sum(lm.net_cents) from sale_line_moves lm where lm.sale_id = s.id and lm.staff_id = ${me} and lm.source = 'sale'), 0))::int "serviceCents",
          (case when s.staff_id = ${me} then s.product_net_cents else 0 end)::int "productCents"
        from sales s
        left join customers c on c.id = s.customer_id
        left join appointments a on a.id = s.appointment_id
        where s.shop_id in ${uuids(ids)} and s.business_date = ${date} and s.status in ${PAID} and ${notSquireEra()}
          and (s.staff_id = ${me}
            or exists (select 1 from sale_line_moves lm where lm.sale_id = s.id and lm.staff_id = ${me})
            or exists (select 1 from tip_ledger tl where tl.sale_id = s.id and tl.staff_id = ${me}))
        order by coalesce(a.starts_at, s.created_at), s.id`)
    : [];
  const [ledger, setup, covered, state] = await Promise.all([
    see.tips ? myLedger(me, ids, { saleIds: list.map((t) => t.saleId) }) : [],
    payoutSetup(ctx),
    see.tips ? shopCoveredRefunds(me, ids, date, date) : [],
    periodStates([per], today).then((m) => m.get(per.start)!),
  ]);
  const routes = await tipRoutesOf(setup);
  const tickets = list.map((t) => {
    const mineHere = ledger.filter((r) => r.saleId === t.saleId);
    const tip = mineHere.find((r) => r.kind === "tip" && r.transfer) ?? mineHere.find((r) => r.kind === "tip");
    const tender = tendersOf(mineHere);
    const late = mineHere.find((r) => r.kind === "tip" && r.date !== t.date);
    const payout = see.tips && tip?.payout?.method === "stripe" ? payoutBrief(tip.payout) : null;
    const transfer = see.tips && tip?.transfer ? transferBrief(tip.transfer) : null;
    return {
      saleId: t.saleId,
      shopId: t.shopId,
      shopName: name.get(t.shopId) ?? "",
      clientFirstName: firstNameOnly(t.clientFirstName),
      startedAt: new Date(t.startedAt).toISOString(),
      serviceName: t.serviceName ?? "",
      serviceCents: see.sales ? t.serviceCents : null,
      productCents: see.sales ? t.productCents : null,
      cardTipCents: see.tips ? tender.card : null,
      cashTipCents: see.tips ? tender.cash : null,
      giftCardTipCents: see.tips ? tender.giftCard : null,
      shared: see.tips ? mineHere.some((r) => r.shared) : null,
      tipDisposition: see.tips ? dispositionOf(tip, routes.get(t.shopId)) : null,
      transferStatus: transfer?.transferStatus ?? null,
      transferReversedBy: transfer?.transferReversedBy ?? null,
      transferArrivalDate: transfer?.transferArrivalDate ?? null,
      payoutId: see.tips && tip?.payout?.method === "stripe" ? tip.payout.id : null,
      payoutStatus: payout?.payoutStatus ?? null,
      payoutArrivalDate: payout?.arrivalDate ?? null,
      lateDeclaration: false,
      originalDate: late ? t.date : null,
      postedDate: late?.date ?? null,
    };
  });
  return { periodId: per.id, date, timezone: SHOP_TZ, ...periodFlags(state), tickets, refunds: covered };
}

/** A client on an employee's screen: their first name only, whatever was typed into the field. */
export const firstNameOnly = (raw: string | null) => raw?.trim().split(/\s+/)[0] || "Walk-in";

// ───────────────────────────── Audit ─────────────────────────────

const VIEW_KEYS = ["period", "periodId", "from", "to", "date", "year"] as const;

/**
 * Every My Earnings view, in the audit log: who, which endpoint and period (the query already held to
 * its schema), on which sign-in. Their own figures only, so the entity is themselves.
 */
export async function logEarningsView(ctx: StaffAppContext, endpoint: string, params: URLSearchParams) {
  const asked = Object.fromEntries(VIEW_KEYS.flatMap((k) => (params.has(k) ? [[k, params.get(k)]] : [])));
  await audit(ctx.actor, "staff.earnings_view", "staff", ctx.staff.id, { endpoint, ...asked, via: "staff_app", sessionId: ctx.sessionId }, ctx.currentShopId ?? null);
}

// ───────────────────────────── GET /me/payouts ─────────────────────────────

/**
 * GET /me/payouts?periodId= (or period=, or from/to): each card tip of theirs transferred to their
 * Stripe account at the sale in the span, with its status and when it got there, and the Stripe
 * payouts that take their tips on to their bank or debit card: Stripe's own status (pending,
 * in_transit, paid, failed, canceled) and the arrival date Stripe gives. A tip transfer is never
 * reversed by the platform: reversed appears only when Stripe reversed it. A payout their bank
 * returned is failed with returned true, and its tips go out again with their next payout.
 */
export async function myPayoutsView(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const span = spanOf(cals, q, today);
  const ids = mine.map((s) => s.id);
  const [ledger, setup, acct, made, state] = await Promise.all([
    myLedger(me, ids, { from: span.from, to: span.to }),
    payoutSetup(ctx),
    staffAccount(me),
    db
      .select()
      .from(tipPayouts)
      .where(and(eq(tipPayouts.staffId, me), eq(tipPayouts.method, "stripe"), gte(tipPayouts.createdAt, startOfLocalDay(span.from)), lte(tipPayouts.createdAt, endOfLocalDay(span.to))))
      .orderBy(desc(tipPayouts.createdAt)),
    span.period ? periodStates([span.period], today).then((m) => m.get(span.period!.start)!) : null,
  ]);
  const transfers = ledger.flatMap((r) => {
    if (r.kind !== "tip" || !r.transfer || !r.saleId) return [];
    const payout = r.payout?.method === "stripe" ? r.payout : null;
    const t = transferBrief(r.transfer);
    if (!t) return [];
    const po = payout ? payoutBrief(payout) : null;
    return [
      {
        id: r.transfer.id,
        saleId: r.saleId,
        shopId: r.shopId,
        amountCents: t.amountCents,
        transferStatus: t.transferStatus,
        transferReversedBy: t.transferReversedBy,
        transferArrivalDate: t.transferArrivalDate,
        date: r.date,
        payoutId: payout?.id ?? null,
        payoutStatus: po?.payoutStatus ?? null,
        payoutArrivalDate: po?.arrivalDate ?? null,
      },
    ];
  });
  const payouts = new Map<string, TipPayout>();
  for (const r of ledger) if (r.payout?.method === "stripe") payouts.set(r.payout.id, r.payout);
  for (const p of made) payouts.set(p.id, p);
  const routes = await tipRoutesOf(setup);
  const anyOn = [...routes.values()].some((r) => r.transfers);
  return {
    from: span.from,
    to: span.to,
    periodId: span.period?.id ?? null,
    ...periodFlags(state),
    bankLast4: acct?.destinationLast4 ?? null,
    tipTransfersEnabled: anyOn,
    payrollCopy: anyOn ? null : payrollCopyOf(routes.get(setup.shops[0]?.shopId ?? "")),
    shops: setup.shops.map((x) => ({ shopId: x.shopId, tipToBarber: !!routes.get(x.shopId)?.tipToBarber, tipTransfersEnabled: !!routes.get(x.shopId)?.transfers, payrollCopy: payrollCopyOf(routes.get(x.shopId)) })),
    transfers,
    payouts: [...payouts.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ id: p.id, shopId: p.shopId, ...payoutBrief(p), feeCents: employeeFeeCents(p), instant: p.instant, returned: !!p.returnedAt, createdAt: p.createdAt.toISOString(), paidAt: p.paidAt?.toISOString() ?? null })),
  };
}

