import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollApprovals, payrollExportSends, payrollRuns, paymentTransfers, sales, shops, tipAbsorptions, tipLedger, tipPayouts } from "@/db/schema";
import { periodOf, periodStarting, periodsAround, type PayCalendar } from "@/domain/payroll/calendar";
import { employeePay, exportRowChecks, paystubLines, toCents, type EmployeePay, type Line, type ShopBlock } from "@/domain/payroll/calc";
import {
  CASH_TIPS_COPY,
  EXPLANATION,
  GROSS_LABEL,
  LATE_TIP_COPY,
  OT_PAY_LABEL,
  PARTIAL_WEEK_OT_LABEL,
  PAYROLL_TIPS_COPY,
  SHOP_COVERS_REFUND_COPY,
  cashTipReminder,
  type EarningsCode,
  type EarningsRule,
} from "@/domain/my-earnings";
import { appPayoutStatus, appTransferStatus } from "@/domain/staff-payouts";
import { employeeFeeCents, receivedCents } from "@/domain/tips";
import { SHOP_TZ, addDays, diffDays, endOfLocalDay, isValidLocalDate, localDateOf, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { AppError, forbidden } from "@/server/errors";
import { approvalOf, buildPayroll, employeeDays, ensurePayGroups, type PayrollView } from "@/server/payroll/run";
import { PAID, rows, uuids } from "@/server/report-sql";
import { notSquireEra } from "@/server/squire-era";
import { staffAccount } from "@/server/tips/accounts";
import { currentDeclarationsOf } from "@/server/tips/declarations";
import { syncTipLedger } from "@/server/tips/ledger";
import type { TipPayout } from "@/server/tips/payouts";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import type { StaffAppContext } from "./http";
import { payoutSetup, sees, type Sees } from "./pay";

/**
 * My Earnings, the Rayz App builder's contract (2026-10-28): the signed-in employee's own pay
 * periods, pay for one period, days, tickets and Stripe payouts. The employee is always the token's;
 * nothing here takes a staff id. Amounts are integer cents.
 *
 * Pay comes from their line of the Payroll Report (buildPayroll, the run the iSolved file is made
 * from; a locked period is its approved snapshot), through employeePay, so the greater-of and every
 * total are worked out once, on the server, the way payroll works them out. Days add up to the
 * period: hours and sales are read as the report reads them (employeeDays), tips from the tip
 * ledger the report's TIPS reconciles to.
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
  if (!p) throw bad(id === "current" ? "You aren't on a shop's payroll" : "Unknown pay period: its id is the date it starts (GET /me/pay-periods lists them)", field);
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

/** A Stripe tip payout, as TipPayoutView. */
function payoutBrief(p: TipPayout) {
  return {
    status: appPayoutStatus(p),
    amountCents: receivedCents(p),
    arrivalDate: p.arrivalDate ?? (p.status === "paid" ? dateOf(p.paidAt) : null),
    bankLast4: p.destinationLast4,
    failureMessage: p.failureMessage,
  };
}

/** A card tip's transfer to their Stripe account at the sale, as TipTransferView; null for one never made. */
function transferBrief(t: Transfer, payout: TipPayout | null) {
  const s = appTransferStatus(t, payout);
  return s ? { status: s.status, reversedBy: s.reversedBy, amountCents: t.amountCents, arrivalDate: t.status === "sent" ? dateOf(t.sentAt) : null } : null;
}

type ShopMethod = Awaited<ReturnType<typeof payoutSetup>>["shops"][number]["method"];
const transfersOn = (m: ShopMethod | undefined) => m === "stripe" && stripePayoutsOn();
const payrollCopyOf = (m: ShopMethod | undefined) => (transfersOn(m) ? null : m === "cash" ? CASH_TIPS_COPY : PAYROLL_TIPS_COPY);

/** How their tip on a ticket reaches them: Stripe, the shop's cash drawer, or payroll. */
function dispositionOf(r: LedgerRow | undefined, m: ShopMethod | undefined): "stripe" | "payroll" | "cash" {
  if (r?.transfer && r.transfer.status !== "cancelled") return "stripe";
  const via = r?.payout?.method ?? (transfersOn(m) ? "stripe" : m);
  return via === "stripe" ? "stripe" : via === "cash" ? "cash" : "payroll";
}

/** Tips the shop covered for them: refunded to the client after the tip reached them (or outside the refund window), so their pay isn't reduced. */
async function shopCoveredRefunds(staffId: string, shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  if (!shopIds.length) return [];
  const list = await db
    .select({ id: tipAbsorptions.id, shopId: tipAbsorptions.shopId, kind: tipAbsorptions.kind, amountCents: tipAbsorptions.amountCents, date: tipAbsorptions.businessDate, saleDate: sales.businessDate, saleId: tipAbsorptions.saleId })
    .from(tipAbsorptions)
    .leftJoin(sales, eq(sales.id, tipAbsorptions.saleId))
    .where(and(eq(tipAbsorptions.staffId, staffId), inArray(tipAbsorptions.shopId, [...shopIds]), gte(tipAbsorptions.businessDate, from), lte(tipAbsorptions.businessDate, to), ne(tipAbsorptions.kind, "dispute")))
    .orderBy(asc(tipAbsorptions.businessDate));
  return list.map((a) => ({
    id: a.id,
    kind: "card_tip_refund" as const,
    shopId: a.shopId,
    saleId: a.saleId,
    amountCents: a.amountCents,
    originalDate: a.saleDate ?? a.date,
    postedDate: a.date,
    lateDeclaration: false,
    reducesPay: false as const,
    reason: a.kind,
    copy: SHOP_COVERS_REFUND_COPY,
  }));
}

/** Tips on tickets from an earlier pay period that posted to this one, because that one had closed. */
function lateTips(list: readonly LedgerRow[], start: LocalDate) {
  return list
    .filter((r) => r.kind === "tip" && r.saleDate && r.saleDate < start)
    .map((r) => ({
      id: r.id,
      kind: "late_tip" as const,
      shopId: r.shopId,
      saleId: r.saleId,
      amountCents: r.amountCents,
      originalDate: r.saleDate!,
      postedDate: r.date,
      lateDeclaration: false,
      reducesPay: false as const,
      copy: LATE_TIP_COPY,
    }));
}

// ───────────────────────────── GET /me/earnings ─────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const sameOrNull = <T>(xs: readonly T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);

/** Their line's columns in the shop's iSolved file against the report, for the parts they may see. */
function reconciliationOf(see: Sees, block: ShopBlock | undefined, line: Line | undefined) {
  const isolved = (block && line ? exportRowChecks(block, line) : [])
    .filter((x) => see[x.group])
    .map((x) => ({ header: x.header, unit: x.unit, group: x.group, amount: x.exported, payrollReport: x.report, matches: x.matches }));
  return { matches: isolved.every((x) => x.matches), isolved, adjustedOnReport: line?.overridden ?? [] };
}

function weeksOf(view: PayrollView | null, staffId: string, p: MyPeriod) {
  return (view?.weeks[staffId] ?? []).map((w) => {
    const prod = r2(sum(w.slices, (s) => s.worked));
    const train = r2(sum(w.slices, (s) => s.training));
    const ot = r2(sum(w.slices, (s) => s.ot));
    const weekEnd = addDays(w.weekStart, 6);
    const partial = w.weekStart < p.start || weekEnd > p.end;
    const byPeriod = new Map<LocalDate, (typeof w.slices)[number][]>();
    for (const s of w.slices) byPeriod.set(s.periodStart, [...(byPeriod.get(s.periodStart) ?? []), s]);
    return {
      weekStart: w.weekStart,
      weekEnd,
      timezone: SHOP_TZ,
      productionHours: prod,
      trainingHours: train,
      regularHours: r2(prod + train - ot),
      otHours: ot,
      partial,
      otLabelCode: partial ? ("partial_week" as const) : ot > 0 ? ("ot_estimated" as const) : null,
      otLabel: partial ? PARTIAL_WEEK_OT_LABEL : ot > 0 ? OT_PAY_LABEL : null,
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
 * hours without timesheet.own. totalCents needs both pay and tips.
 */
export async function myEarnings(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  const me = ctx.staff.id;
  const { cals } = await myCalendars(me);
  const per = earningsPeriod(cals, q, today);
  const shopIds = per.cals.map((c) => c.shop.id);
  const view = await buildPayroll(per.start, per.end, { clockChecks: false });
  const [state, ledger, declared, covered, setup] = await Promise.all([
    periodStates([per], today, new Map([[per.start, view]])).then((m) => m.get(per.start)!),
    see.tips ? myLedger(me, shopIds, { from: per.start, to: per.end }) : [],
    see.tips ? currentDeclarationsOf(me, shopIds, per.start, per.end) : [],
    see.tips ? shopCoveredRefunds(me, shopIds, per.start, per.end) : [],
    payoutSetup(ctx),
  ]);
  const methodOf = new Map(setup.shops.map((s) => [s.shopId, s.method]));

  const slices = per.cals.map((c) => {
    const block = view?.blocks.find((b) => b.shopId === c.shop.id);
    const line = block?.lines.find((l) => l.staffId === me);
    const pay = line ? employeePay(line) : null;
    const t = tendersOf(ledger.filter((r) => r.shopId === c.shop.id));
    const tipsCents = pay?.tipsCents ?? 0;
    const declaredCents = pay?.declaredCashTipsCents ?? 0;
    const m = methodOf.get(c.shop.id);
    return {
      line,
      pay,
      out: {
        shopId: c.shop.id,
        shopName: c.shop.name,
        tipTransfersEnabled: transfersOn(m),
        payrollCopy: payrollCopyOf(m),
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
        pay: see.wages ? pay : null,
        hours: see.hours ? hoursOf(line) : null,
        reconciliation: reconciliationOf(see, block, line),
      },
    };
  });

  const pays = slices.flatMap((s) => (s.pay ? [s.pay] : []));
  const rules = [...new Set(pays.map((p) => p.appliedRule))];
  const codes = [...new Set(pays.map((p) => p.explanationCode))];
  const appliedRule: EarningsRule = rules.length > 1 ? "mixed" : (rules[0] ?? "hourly");
  const explanationCode: EarningsCode = rules.length > 1 || codes.length > 1 ? "mixed" : (codes[0] ?? "equal");
  const P = (f: (p: EmployeePay) => number) => sum(pays, f);
  const lines = slices.flatMap((s) => (s.line ? [s.line] : []));
  const L = (f: (l: Line) => number) => r2(sum(lines, f));
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

    appliedRule: wages ? appliedRule : null,
    explanationCode: wages ? explanationCode : null,
    explanation: wages ? EXPLANATION[explanationCode] : null,
    topUpCents: wages ? P((p) => p.topUpCents) : null,
    hourlyPayCents: wages ? P((p) => p.hourlyPayCents) : null,
    hourlyRateCents: wages ? sameOrNull(pays.map((p) => p.hourlyRateCents)) : null,
    serviceCommissionCents: wages ? P((p) => p.serviceCommissionCents) : null,
    productCommissionCents: wages ? P((p) => p.productCommissionCents) : null,
    commissionCents: wages ? P((p) => p.serviceCommissionCents + p.productCommissionCents) : null,
    lateCommissionCents: wages ? P((p) => p.lateCommissionCents) : null,
    commSalesCents: wages ? P((p) => p.commSalesCents) : null,
    serviceCommissionRate: wages ? sameOrNull(pays.map((p) => p.serviceCommissionRate)) : null,
    productCommissionRate: wages ? sameOrNull(pays.map((p) => p.productCommissionRate)) : null,
    greaterOfCents: wages ? P((p) => p.greaterOfCents) : null,
    guaranteeTopUpCents: wages ? P((p) => p.guaranteeTopUpCents) : null,
    otPremiumCents: wages ? P((p) => p.otPremiumCents) : null,
    wagesCents: wages ? P((p) => p.wagesCents) : null,

    productionHours: see.hours ? L((l) => l.hours + l.otHours) : null,
    trainingHours: see.hours ? L((l) => l.trainingHours) : null,
    regularHours: see.hours ? L((l) => l.hours) : null,
    otHours: see.hours ? L((l) => l.otHours) : null,
    ptoHours: see.hours ? L((l) => l.ptoHours) : null,
    trainingRateCents: wages ? sameOrNull(pays.map((p) => p.trainingRateCents)) : null,
    trainingPayCents: wages ? P((p) => p.trainingPayCents) : null,
    ptoPayCents: wages ? P((p) => p.ptoPayCents) : null,
    otEstimatedCents: wages ? P((p) => p.overtimePayCents) : null,
    otDisclosure: OT_PAY_LABEL,

    serviceSalesCents: see.sales ? sum(slices, (s) => s.out.serviceSalesCents ?? 0) : null,
    productSalesCents: see.sales ? sum(slices, (s) => s.out.productSalesCents ?? 0) : null,
    cardTipsCents: tipsOf("cardTipsCents"),
    cashTipsCents: tipsOf("cashTipsCents"),
    giftCardTipsCents: tipsOf("giftCardTipsCents"),
    cashOnTicketsCents: tipsOf("cashOnTicketsCents"),
    declaredCashTipsCents: tipsOf("declaredCashTipsCents"),
    tipAdjustmentsCents: tipsOf("tipAdjustmentsCents"),
    totalTipsCents: tipsOf("totalTipsCents"),
    totalCents: wages && see.tips ? P((p) => p.grossCents) : null,

    workweeks: see.hours ? weeksOf(view, me, per) : [],
    shops: slices.map((s) => s.out),
    adjustments: see.tips ? lateTips(ledger, per.start) : [],
    refunds: covered,
    declarations: declared.map((d) => ({ id: d.id, shopId: d.shopId, date: d.businessDate, amountCents: d.amountCents, source: d.source })),
    cashTipReminder: view ? cashTipReminder(view.settings.declarations) : null,
    payout: setup,
  };
}

function hoursOf(l: Line | undefined) {
  return { production: r2((l?.hours ?? 0) + (l?.otHours ?? 0)), regular: l?.hours ?? 0, overtime: l?.otHours ?? 0, training: l?.trainingHours ?? 0, pto: l?.ptoHours ?? 0 };
}

/** The ids of the pay periods either side; the next is null while it's still to come. */
function neighbours(cals: readonly ShopCalendar[], p: MyPeriod, today: LocalDate) {
  const before = cals.map((c) => periodOf(c.calendar, addDays(p.start, -1))).filter((x) => x.number >= 1 && x.end === addDays(p.start, -1));
  const after = periodAt(cals, addDays(p.end, 1));
  return { previous: before.length ? before.map((x) => x.start).sort().at(-1)! : null, next: after && after.start <= today ? after.id : null };
}

// ───────────────────────────── GET /me/earnings/days ─────────────────────────────

/**
 * GET /me/earnings/days?periodId= (or period=, or from/to): each day they worked, sold or were
 * tipped. Hours and sales are read as the Payroll Report reads them and tips come from the tip
 * ledger, so over a pay period the days add up to GET /me/earnings (before a manager's override on
 * the report; locked periods are the approved snapshot, the days the live data).
 */
export async function myEarningsDays(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const span = spanOf(cals, q, today);
  const ids = mine.map((s) => s.id);
  const until = span.to < today ? span.to : today;
  const [worked, ledger, declared] = await Promise.all([
    see.hours || see.sales ? employeeDays(me, ids, span.from, until) : { hours: [], sales: [] },
    see.tips ? myLedger(me, ids, { from: span.from, to: span.to }) : [],
    see.tips ? currentDeclarationsOf(me, ids, span.from, span.to) : [],
  ]);
  const dates = new Set<LocalDate>([...worked.hours.map((h) => h.date), ...worked.sales.map((s) => s.date), ...ledger.map((r) => r.date), ...declared.map((d) => d.businessDate)]);
  const days = [...dates].sort().map((date) => {
    const h = worked.hours.filter((x) => x.date === date);
    const s = worked.sales.filter((x) => x.date === date);
    const t = tendersOf(ledger.filter((r) => r.date === date));
    const dec = sum(
      declared.filter((d) => d.businessDate === date),
      (d) => d.amountCents,
    );
    return {
      date,
      cardTipsCents: see.tips ? t.card : null,
      cashTipsCents: see.tips ? t.cash + dec : null,
      serviceSalesCents: see.sales ? sum(s, (x) => x.serviceCents) : null,
      productSalesCents: see.sales ? sum(s, (x) => x.productCents) : null,
      productionHours: see.hours ? r2(sum(h, (x) => x.worked) / 100) : null,
      trainingHours: see.hours ? r2(sum(h, (x) => x.training) / 100) : null,
      tickets: sum(s, (x) => x.tickets),
      giftCardTipsCents: see.tips ? t.giftCard : null,
      cashOnTicketsCents: see.tips ? t.cash : null,
      declaredCashTipsCents: see.tips ? dec : null,
      tipAdjustmentsCents: see.tips ? t.adjust : null,
      totalTipsCents: see.tips ? t.card + t.cash + t.giftCard + t.adjust + dec : null,
      ptoHours: see.hours ? r2(sum(h, (x) => x.pto) / 100) : null,
    };
  });
  return { from: span.from, to: span.to, periodId: span.period?.id ?? null, days };
}

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
 * GET /me/earnings/tickets?date= (inside a period or from/to, or on its own): their tickets that day,
 * each with the services and products credited to them (as payroll credits them: the ticket's
 * barber, less lines done by someone else, plus lines they did on someone else's ticket), their own
 * tip by tender (their share on a split ticket, never anyone else's) and how it reaches them.
 */
export async function myEarningsTickets(ctx: StaffAppContext, q: PeriodQuery & { date?: string }, today: LocalDate = todayLocal()) {
  const see = sees(ctx);
  if (!see.tips && !see.sales) throw forbidden("You don't have permission to see tips or sales");
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const asked = q.period !== undefined || q.periodId !== undefined || q.from !== undefined || q.to !== undefined;
  const span = asked ? spanOf(cals, q, today) : { from: q.date ?? today, to: q.date ?? today, period: null };
  if (q.date && (q.date < span.from || q.date > span.to)) throw bad("date isn't in that pay period or range", "date");
  const from = q.date ?? span.from;
  const to = q.date ?? span.to;
  if (diffDays(to, from) >= MAX_RANGE_DAYS) throw bad(`Tickets cover at most ${MAX_RANGE_DAYS} days`, "to");
  const ids = mine.map((s) => s.id);
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
        where s.shop_id in ${uuids(ids)} and s.business_date between ${from} and ${to} and s.status in ${PAID} and ${notSquireEra()}
          and (s.staff_id = ${me}
            or exists (select 1 from sale_line_moves lm where lm.sale_id = s.id and lm.staff_id = ${me})
            or exists (select 1 from tip_ledger tl where tl.sale_id = s.id and tl.staff_id = ${me}))
        order by coalesce(a.starts_at, s.created_at), s.id`)
    : [];
  const [ledger, setup, covered] = await Promise.all([
    see.tips ? myLedger(me, ids, { saleIds: list.map((t) => t.saleId) }) : [],
    payoutSetup(ctx),
    see.tips ? shopCoveredRefunds(me, ids, from, to) : [],
  ]);
  const methodOf = new Map(setup.shops.map((s) => [s.shopId, s.method]));
  const tickets = list.map((t) => {
    const mineHere = ledger.filter((r) => r.saleId === t.saleId);
    const tip = mineHere.find((r) => r.kind === "tip" && r.transfer) ?? mineHere.find((r) => r.kind === "tip");
    const tender = tendersOf(mineHere);
    const late = mineHere.find((r) => r.kind === "tip" && r.date !== t.date);
    const payout = tip?.payout?.method === "stripe" ? tip.payout : null;
    return {
      saleId: t.saleId,
      shopId: t.shopId,
      shopName: name.get(t.shopId) ?? "",
      clientFirstName: t.clientFirstName ?? "Walk-in",
      startedAt: new Date(t.startedAt).toISOString(),
      serviceName: t.serviceName ?? "",
      serviceCents: see.sales ? t.serviceCents : null,
      productCents: see.sales ? t.productCents : null,
      cardTipCents: see.tips ? tender.card : null,
      cashTipCents: see.tips ? tender.cash : null,
      giftCardTipCents: see.tips ? tender.giftCard : null,
      shared: see.tips ? mineHere.some((r) => r.shared) : null,
      tipDisposition: see.tips ? dispositionOf(tip, methodOf.get(t.shopId)) : null,
      transfer: see.tips && tip?.transfer ? transferBrief(tip.transfer, payout) : null,
      payout: see.tips && payout ? payoutBrief(payout) : null,
      lateDeclaration: false,
      originalDate: late ? t.date : null,
      postedDate: late?.date ?? null,
    };
  });
  return { from, to, date: q.date ?? null, tickets, refunds: covered };
}

// ───────────────────────────── GET /me/payouts ─────────────────────────────

/**
 * GET /me/payouts?periodId= (or period=, or from/to): each card tip of theirs transferred to their
 * Stripe account at the sale in the span, with its status and when it got there, and the Stripe
 * payouts that take their tips on to their bank or debit card: Stripe's own status (pending,
 * in_transit, paid, failed, canceled) and the arrival date Stripe gives. A tip transfer is never
 * reversed by the platform: reversed appears only when Stripe reversed it or the payout carrying it
 * was returned by their bank (reversedBy says which).
 */
export async function myPayoutsView(ctx: StaffAppContext, q: PeriodQuery, today: LocalDate = todayLocal()) {
  const me = ctx.staff.id;
  const { shops: mine, cals } = await myCalendars(me);
  const span = spanOf(cals, q, today);
  const ids = mine.map((s) => s.id);
  const [ledger, setup, acct, made] = await Promise.all([
    myLedger(me, ids, { from: span.from, to: span.to }),
    payoutSetup(ctx),
    staffAccount(me),
    db
      .select()
      .from(tipPayouts)
      .where(and(eq(tipPayouts.staffId, me), eq(tipPayouts.method, "stripe"), gte(tipPayouts.createdAt, startOfLocalDay(span.from)), lte(tipPayouts.createdAt, endOfLocalDay(span.to))))
      .orderBy(desc(tipPayouts.createdAt)),
  ]);
  const transfers = ledger.flatMap((r) => {
    if (r.kind !== "tip" || !r.transfer || !r.saleId) return [];
    const payout = r.payout?.method === "stripe" ? r.payout : null;
    const t = transferBrief(r.transfer, payout);
    if (!t) return [];
    const po = payout ? payoutBrief(payout) : null;
    return [
      {
        id: r.transfer.id,
        saleId: r.saleId,
        shopId: r.shopId,
        amountCents: t.amountCents,
        status: t.status,
        reversedBy: t.reversedBy,
        arrivalDate: t.arrivalDate,
        date: r.date,
        payoutId: payout?.id ?? null,
        payoutStatus: po?.status ?? null,
        payoutArrivalDate: po?.arrivalDate ?? null,
      },
    ];
  });
  const payouts = new Map<string, TipPayout>();
  for (const r of ledger) if (r.payout?.method === "stripe") payouts.set(r.payout.id, r.payout);
  for (const p of made) payouts.set(p.id, p);
  const anyOn = setup.shops.some((s) => transfersOn(s.method));
  return {
    from: span.from,
    to: span.to,
    periodId: span.period?.id ?? null,
    bankLast4: acct?.destinationLast4 ?? null,
    tipTransfersEnabled: anyOn,
    payrollCopy: anyOn ? null : payrollCopyOf(setup.shops[0]?.method),
    transfers,
    payouts: [...payouts.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ id: p.id, shopId: p.shopId, ...payoutBrief(p), feeCents: employeeFeeCents(p), instant: p.instant, returned: !!p.returnedAt, createdAt: p.createdAt.toISOString(), paidAt: p.paidAt?.toISOString() ?? null })),
  };
}

