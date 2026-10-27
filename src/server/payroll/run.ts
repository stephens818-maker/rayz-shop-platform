import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, payGroups, payrollApprovals, payrollEmployers, payrollLockedOt, payrollOverrides, payrollProfiles, payrollRates, payrollRuns, sales as salesTable, staff, timeEntries, timePunches, type PayrollApprovalTotals } from "@/db/schema";
import { calendarProblem, periodOf, periodStarting, periodsAround, workweeksOf, type CalendarPeriod, type PayCalendar } from "@/domain/payroll/calendar";
import {
  OVERRIDABLE,
  anomalies,
  assemble,
  computeLine,
  fmtHours,
  fmtMoney,
  ftStatus,
  locationSummary,
  toCents,
  reconcile,
  totalsOf,
  type Anomaly,
  type FtStatus,
  type Line,
  type LineInput,
  type Mismatch,
  type Overridable,
  type Overrides,
  type PayrollSettings,
  type ShopBlock,
  type Totals,
} from "@/domain/payroll/calc";
import { minimumWageCents, minimumWageShortfallCents, rulesFor } from "@/domain/wage-hour";
import { dailyHours, overtimeSlices, sliceKey, weekStartOf, type DayHours, type Slice, type TimeEntry } from "@/domain/payroll/overtime";
import { addDays, endOfLocalDay, formatDate, localDateOf, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { AppError } from "@/server/errors";
import { guaranteeTopUps, exportExtras } from "@/domain/compensation";
import { loadCompensationSettings, payrollPlans, setupRates } from "@/server/compensation";
import { payrollSalesBetween, unassignedSalesBetween } from "@/server/reports";
import { declaredTipsBetween } from "@/server/tips/declarations";
import { lockPayrollTips, payrollTipSplit } from "@/server/tips/payouts";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { payrollHoursCheck, type PayrollHoursCheck } from "@/server/time-clock";
import { isolvedTimecardExporter, type PayrollExporter } from "./export";
import { checkPayrollTips, type TipCheck } from "./tip-reconcile";
import { ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings, type LegalEntity, type PayGroup } from "./groups";

export { DEFAULT_CALENDAR, ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings, type PayGroup } from "./groups";


export interface PeriodChoice {
  key: string;
  start: LocalDate;
  end: LocalDate;
  groups: { id: string; label: string; number: number; checkDate: LocalDate }[];
  lockedGroups: number;
  current: boolean;
}

export const periodKey = (start: string, end: string) => `${start}_${end}`;

/** Pay periods to pick from, newest first: shops on the same calendar share one. */
export async function periodChoices(now = new Date()): Promise<PeriodChoice[]> {
  const groups = await ensurePayGroups();
  const today = todayLocal(now);
  const map = new Map<string, PeriodChoice>();
  for (const g of groups) {
    for (const p of periodsAround(g.calendar, today, 8, 1)) {
      if (p.number < 1) continue;
      const key = periodKey(p.start, p.end);
      const c = map.get(key) ?? { key, start: p.start, end: p.end, groups: [], lockedGroups: 0, current: p.start <= today && today <= p.end };
      c.groups.push({ id: g.id, label: g.label, number: p.number, checkDate: p.checkDate });
      map.set(key, c);
    }
  }
  const locked = await db.select({ g: payrollRuns.payGroupId, s: payrollRuns.periodStart, e: payrollRuns.periodEnd }).from(payrollRuns);
  for (const l of locked) {
    const c = map.get(periodKey(l.s, l.e));
    if (c) c.lockedGroups += 1;
  }
  return [...map.values()].sort((a, b) => b.start.localeCompare(a.start) || a.end.localeCompare(b.end));
}

export interface WeekBreakdown {
  weekStart: LocalDate;
  /** Hours that count toward the 40, across every shop of the entity. */
  basis: number;
  ot: number;
  slices: { shop: string; periodStart: LocalDate; basis: number; ot: number; locked: boolean; inThisRun: boolean }[];
}

/** A figure of record on a locked shop that the live data no longer has: the file stays as approved, and this is flagged. */
export interface LockDrift {
  staffId: string;
  name: string;
  field: RecordField;
  locked: number;
  now: number;
}

export interface BlockView extends ShopBlock {
  payGroupId: string;
  payGroup: string;
  exportTab: string;
  /** The shop's legal entity: its pay group's employer, or the one it had when the period was locked. */
  employer: LegalEntity | null;
  /** The shop's work state: its wage-hour rules, and the state its hours are withheld for. */
  workState: string | null;
  period: CalendarPeriod;
  locked: { at: string; by: string | null } | null;
  /** Locked shops: the hash of the inputs of record as approved, and what's changed in the live data since. */
  lockCheck: { hash: string; liveHash: string; drift: LockDrift[]; importedAfterLock: number } | null;
}

export interface PayrollView {
  start: LocalDate;
  end: LocalDate;
  settings: PayrollSettings;
  blocks: BlockView[];
  grand: Totals;
  /** With direct Stripe payouts on, includes the tip check's differences at shops still open, so they block approve and lock. */
  mismatches: Mismatch[];
  /** The W-2 tip check: each employee's tips against the iSolved file and their payouts, to the cent. */
  tips: TipCheck;
  anomalies: Anomaly[];
  /** The period by legal entity and work state: what each FEIN files in each state. */
  byEntityState: EntityStateTotal[];
  ft: Record<string, FtStatus>;
  weeks: Record<string, WeekBreakdown[]>;
  locked: "none" | "some" | "all";
  /** Shops still open whose time clock hours aren't locked for every day of the period. While hours come from the clock, approve and lock waits for them. */
  hoursOpen: { shopId: string; shop: string; periods: { start: LocalDate; end: LocalDate }[]; waiting: string[] }[];
}

export interface EntityStateTotal {
  employerId: string | null;
  employer: string;
  workState: string | null;
  shops: string[];
  employees: number;
  hours: number;
  laborCost: number;
  tips: number;
}

interface Snapshot {
  block: ShopBlock;
  /** The hash of the inputs of record at the lock; absent on periods locked before it was kept. */
  inputsHash?: string;
}

/**
 * Periods locked before tips were split by how they're paid had every tip paid separately; before
 * guaranteed minimums, nobody had a top-up; before declarations and post-payout refunds, none of either.
 */
function upgradeBlock(b: ShopBlock): ShopBlock {
  type Cols = { tips: number; cardTipsOutside?: number; salesTax?: number; tipsInPayroll?: number; tipsOutside?: number; tipsPaidOut?: number; guaranteeTopUp?: number; declaredCashTips?: number; chargedTips?: number; lateTipRefunds?: number; tipRefundsShopCost?: number };
  const tipCols = <T extends Cols>(x: T): T => ({
    ...x,
    tipsInPayroll: x.tipsInPayroll ?? 0,
    tipsOutside: x.tipsOutside ?? x.tips,
    tipsPaidOut: x.tipsPaidOut ?? 0,
    guaranteeTopUp: x.guaranteeTopUp ?? 0,
    declaredCashTips: x.declaredCashTips ?? 0,
    chargedTips: x.chargedTips ?? 0,
    lateTipRefunds: x.lateTipRefunds ?? 0,
    tipRefundsShopCost: x.tipRefundsShopCost ?? 0,
    cardTipsOutside: x.cardTipsOutside ?? 0,
    salesTax: x.salesTax ?? 0,
  });
  return { ...b, lines: b.lines.map(tipCols), totals: tipCols(b.totals) };
}

/** What a period is approved on, per employee: hours, sales and tips. Rates, and tips paid out since, aren't: they change after a lock without changing the period. */
const RECORD_FIELDS = ["workedHours", "otHours", "ptoHours", "trainingHours", "serviceSales", "productSales", "tips", "declaredCashTips"] as const;
type RecordField = (typeof RECORD_FIELDS)[number];
export const RECORD_LABEL: Record<RecordField, string> = {
  workedHours: "Hours worked",
  otHours: "O.T. hours",
  ptoHours: "PTO hours",
  trainingHours: "Training hours",
  serviceSales: "Service $",
  productSales: "Product $",
  tips: "Tips",
  declaredCashTips: "Cash tips declared",
};

const recordOf = (l: Pick<Line, "input">) => RECORD_FIELDS.map((k) => toCents(l.input[k] ?? 0));

/** A hash of a shop's inputs of record, by employee: the same data hashes the same. */
export function inputsHash(lines: readonly Pick<Line, "staffId" | "input">[]): string {
  const rows = lines.map((l) => [l.staffId, ...recordOf(l)] as const).sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function driftOf(locked: readonly Line[], live: readonly Line[]): LockDrift[] {
  const out: LockDrift[] = [];
  const liveOf = new Map(live.map((l) => [l.staffId, l]));
  const lockedOf = new Map(locked.map((l) => [l.staffId, l]));
  for (const id of new Set([...lockedOf.keys(), ...liveOf.keys()])) {
    const a = lockedOf.get(id);
    const b = liveOf.get(id);
    RECORD_FIELDS.forEach((k) => {
      const was = toCents(a?.input[k] ?? 0);
      const now = toCents(b?.input[k] ?? 0);
      if (was !== now) out.push({ staffId: id, name: (a ?? b)!.name, field: k, locked: was / 100, now: now / 100 });
    });
  }
  return out;
}

const centi = (x: number) => x / 100;

/**
 * Everything on the Payroll Report for one pay period: each shop (pay group) whose calendar has this
 * period, with its rows, totals, export rows, the reconciliation result and anomalies. A locked shop
 * comes back exactly as it was approved. Without `clockChecks` (an employee's own pay), the time
 * clock's flags and hours gate are left out.
 */
export async function buildPayroll(start: LocalDate, end: LocalDate, o: { clockChecks?: boolean } = {}): Promise<PayrollView | null> {
  const groups = await ensurePayGroups();
  const inRun = groups.map((g) => ({ g, p: periodStarting(g.calendar, start) })).filter((x): x is { g: PayGroup; p: CalendarPeriod } => x.p !== null && x.p.end === end && x.p.number >= 1);
  if (!inRun.length) return null;
  const settings = await loadSettings();
  const groupOf = new Map(groups.map((g) => [g.shopId, g]));
  const calOf = (shopId: string) => groupOf.get(shopId)?.calendar ?? settings.calendar;
  const runShops = new Set(inRun.map((x) => x.g.shopId));

  const weeks = workweeksOf({ start, end });
  const ftFrom = addDays(weekStartOf(end), -7 * (settings.ftWindowWeeks - 1));
  const from = ftFrom < weeks[0] ? ftFrom : weeks[0];
  const to = addDays(weeks[weeks.length - 1], 6);
  const entries: TimeEntry[] = await db
    .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
    .from(timeEntries)
    .where(and(lt(timeEntries.startsAt, endOfLocalDay(to)), gt(timeEntries.endsAt, startOfLocalDay(from))));

  const runs = await db.select().from(payrollRuns).where(and(eq(payrollRuns.periodStart, start), eq(payrollRuns.periodEnd, end)));
  const runOf = new Map(runs.map((r) => [r.payGroupId, r]));
  const lockedRows = await db
    .select({ staffId: payrollLockedOt.staffId, shopId: payrollLockedOt.shopId, periodStart: payrollLockedOt.periodStart, weekStart: payrollLockedOt.weekStart, ot: payrollLockedOt.otCenti })
    .from(payrollLockedOt)
    .where(inArray(payrollLockedOt.weekStart, weeks));
  const locked = new Map(lockedRows.map((l) => [sliceKey(l), l.ot]));

  const days = dailyHours(entries);
  const slices = overtimeSlices(days, {
    thresholdCenti: Math.round(settings.otThresholdHours * 100),
    trainingCountsTowardOt: settings.trainingCountsTowardOt,
    dailyThresholdCenti: settings.dailyOtHours ? Math.round(settings.dailyOtHours * 100) : null,
    entityOf: (shopId) => groupOf.get(shopId)?.legalEntity ?? "",
    periodOf: (shopId, date) => periodOf(calOf(shopId), date).start,
    locked,
  });
  const mine = slices.filter((s) => s.periodStart === start && runShops.has(s.shopId) && s.weekStart >= weeks[0] && s.weekStart <= weeks[weeks.length - 1]);
  const hours = new Map<string, { worked: number; training: number; pto: number; ot: number }>();
  for (const s of mine) {
    const k = `${s.staffId}|${s.shopId}`;
    const h = hours.get(k) ?? { worked: 0, training: 0, pto: 0, ot: 0 };
    h.worked += s.worked;
    h.training += s.training;
    h.pto += s.pto;
    h.ot += s.ot;
    hours.set(k, h);
  }

  const sales = await payrollSalesBetween({ shopIds: [...runShops] }, start, end);
  const salesOf = new Map(sales.map((r) => [`${r.staffId}|${r.shopId}`, r]));
  const overrides = await db.select().from(payrollOverrides).where(and(eq(payrollOverrides.periodStart, start), inArray(payrollOverrides.shopId, [...runShops])));
  const [tipSplit, declared] = await Promise.all([payrollTipSplit([...runShops], start, end), declaredTipsBetween([...runShops], start, end)]);
  const keys = new Set([
    ...hours.keys(),
    ...salesOf.keys(),
    ...declared.keys(),
    ...overrides.map((o) => `${o.staffId}|${o.shopId}`),
    ...[...tipSplit.entries()].filter(([, v]) => v.adjustCents || v.absorbedCents || v.inPayrollCents).map(([k]) => k),
  ]);
  const staffIds = [...new Set([...keys].map((k) => k.split("|")[0]))];

  const [people, profiles, rates] = staffIds.length
    ? await Promise.all([
        db.select({ id: staff.id, label: staff.displayLabel, first: staff.firstName, last: staff.lastName }).from(staff).where(inArray(staff.id, staffIds)),
        db.select().from(payrollProfiles).where(inArray(payrollProfiles.staffId, staffIds)),
        db.select().from(payrollRates).where(inArray(payrollRates.staffId, staffIds)),
      ])
    : [[], [], []];
  const person = new Map(people.map((p) => [p.id, p]));
  const profile = new Map(profiles.map((p) => [p.staffId, p]));
  const rateOf = (staffId: string, shopId: string) => rates.find((r) => r.staffId === staffId && r.shopId === shopId) ?? rates.find((r) => r.staffId === staffId && r.shopId === null);
  const comp = await loadCompensationSettings();
  const plans = comp.enabled && comp.payrollUsesPlans && staffIds.length ? await payrollPlans({ staffIds, start, end, days, fallbackOf: await setupRates(staffIds) }) : null;

  const inputsByShop = new Map<string, LineInput[]>();
  const sourceFlags: Anomaly[] = [];
  for (const k of keys) {
    const [staffId, shopId] = k.split("|");
    if (!runShops.has(shopId)) continue;
    const p = person.get(staffId);
    const pr = profile.get(staffId);
    const r = rateOf(staffId, shopId);
    const plan = plans?.rateFor(staffId, shopId) ?? null;
    const h = hours.get(k) ?? { worked: 0, training: 0, pto: 0, ot: 0 };
    for (const [kind, on] of [["training", settings.trainingSource], ["pto", settings.ptoSource]] as const) {
      if (on !== "manager" || !h[kind]) continue;
      sourceFlags.push({
        staffId,
        shopId,
        kind: "hours_source",
        message: `${p?.label ?? "Unknown"} (${groupOf.get(shopId)?.shop ?? "Other shop"}): ${fmtHours(centi(h[kind]))} of ${kind === "pto" ? "PTO" : "training"} on the time clock aren't paid, because ${kind === "pto" ? "PTO" : "training"} hours are entered by a manager (Payroll setup). Type them on the report if they're owed.`,
      });
    }
    const s = salesOf.get(k);
    const ov: Overrides = {};
    for (const o of overrides) if (o.staffId === staffId && o.shopId === shopId && (OVERRIDABLE as readonly string[]).includes(o.field)) ov[o.field as Overridable] = { value: o.value, reason: o.reason };
    const name = p?.label ?? "Unknown";
    const split = tipSplit.get(k);
    const charged = (s?.cardTipsCents ?? 0) + (s?.giftCardTipsCents ?? 0);
    const raw = charged + (s?.cashTipsCents ?? 0) + (split?.adjustCents ?? 0) + (split?.absorbedCents ?? 0);
    const late = s?.lateTipRefundsCents ?? 0;
    // A refund of tips already paid is always the shop's cost (ST-C15), and tips never go below zero (SB-C2).
    const tipsCents = Math.max(0, raw);
    const input: LineInput = {
      staffId,
      name,
      shopId,
      employeeNumber: pr?.employeeNumber ?? null,
      keyIsText: pr?.keyIsText ?? false,
      isolvedName: pr?.isolvedName ?? [p?.last, p?.first].filter(Boolean).join(", ").toUpperCase(),
      hourlyRate: plan?.hourlyRate ?? r?.hourlyRate ?? 0,
      servicePct: plan?.servicePct ?? r?.servicePct ?? 0,
      productPct: plan?.productPct ?? r?.productPct ?? 0,
      trainingRate: r?.trainingRate ?? null,
      workedHours: centi(h.worked),
      otHours: centi(h.ot),
      ptoHours: settings.ptoSource === "manager" ? 0 : centi(h.pto),
      trainingHours: settings.trainingSource === "manager" ? 0 : centi(h.training),
      serviceSales: (s?.serviceSalesCents ?? 0) / 100,
      productSales: (s?.productSalesCents ?? 0) / 100,
      tips: tipsCents / 100,
      tipsInPayroll: (split?.inPayrollCents ?? 0) / 100,
      tipsPaidOut: (split?.paidOutCents ?? 0) / 100,
      owedTipsInPayroll: (split?.owedInPayrollCents ?? 0) / 100,
      tipsPaidByStripe: (split?.paidByStripeCents ?? 0) / 100,
      declaredCashTips: (declared.get(k) ?? 0) / 100,
      chargedTips: Math.min(tipsCents, Math.max(0, charged)) / 100,
      lateTipRefunds: late / 100,
      salesTax: (s?.salesTaxCents ?? 0) / 100,
      zeroHourlyPay: pr?.zeroHourlyPay ?? false,
      ...(plan?.mixed.length ? { mixedRates: plan.mixed } : {}),
      overrides: Object.keys(ov).length ? ov : undefined,
    };
    inputsByShop.set(shopId, [...(inputsByShop.get(shopId) ?? []), input]);
  }
  if (plans) {
    const probe = [...inputsByShop.values()].flat().map((i) => {
      const l = computeLine(i, settings);
      return { staffId: i.staffId, shopId: i.shopId, earned: l.totalWages + l.otPay + l.trainingPay, hours: l.hours + l.otHours };
    });
    const topUps = guaranteeTopUps(probe, (id) => plans.guaranteeOf(id));
    for (const list of inputsByShop.values()) for (const i of list) if (topUps.has(`${i.staffId}|${i.shopId}`)) i.guaranteeTopUp = topUps.get(`${i.staffId}|${i.shopId}`);
  }
  const order = (a: LineInput, b: LineInput) =>
    (profile.get(a.staffId)?.exportPosition ?? 1e9) - (profile.get(b.staffId)?.exportPosition ?? 1e9) || a.name.localeCompare(b.name);

  const unassigned = await unassignedSalesBetween([...runShops], start, end);
  const unassignedOf = (shopId: string) => {
    const u = unassigned.get(shopId);
    return u ? { unassigned: { serviceSales: u.serviceSalesCents / 100, productSales: u.productSalesCents / 100, salesTax: u.salesTaxCents / 100 } } : {};
  };
  const live = assemble(
    inRun.map(({ g }) => ({ shopId: g.shopId, shop: g.shop, inputs: (inputsByShop.get(g.shopId) ?? []).sort(order), ...unassignedOf(g.shopId) })),
    settings,
    { extras: exportExtras(comp), guaranteeHeader: comp.guaranteeHeader },
  );
  const lockedBy = new Map((runs.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, runs.map((r) => r.lockedBy).filter((x): x is string => !!x))) : []).map((s) => [s.id, s.label]));
  const imported = runs.length ? await importedAfterLock(runs, start, end, groups) : new Map<string, number>();
  const employerIds = [...new Set([...inRun.map(({ g }) => g.employerId), ...runs.map((r) => r.employerId)].filter((x): x is string => !!x))];
  const employerOf = new Map(
    (employerIds.length ? await db.select().from(payrollEmployers).where(inArray(payrollEmployers.id, employerIds)) : []).map((e) => [
      e.id,
      { id: e.id, legalName: e.legalName, isolvedCompanyCode: e.isolvedCompanyCode, taxIdLast4: e.taxIdLast4 },
    ]),
  );
  const blocks: BlockView[] = inRun.map(({ g, p }, i) => {
    const run = runOf.get(g.id);
    const snap = run ? (run.snapshot as Snapshot) : null;
    const block = snap ? upgradeBlock(snap.block) : live.blocks[i];
    const lockCheck = snap
      ? { hash: snap.inputsHash ?? inputsHash(block.lines), liveHash: inputsHash(live.blocks[i].lines), drift: driftOf(block.lines, live.blocks[i].lines), importedAfterLock: imported.get(g.id) ?? 0 }
      : null;
    return {
      ...block,
      shop: g.shop,
      payGroupId: g.id,
      payGroup: g.label,
      exportTab: g.exportTab,
      employer: employerOf.get((run ? run.employerId : g.employerId) ?? "") ?? null,
      workState: g.workState,
      period: p,
      locked: run ? { at: run.lockedAt.toISOString(), by: run.lockedBy ? (lockedBy.get(run.lockedBy) ?? null) : null } : null,
      lockCheck,
    };
  });
  const grandAndCheck = runs.length ? assembleFromBlocks(blocks) : { grand: live.grand, mismatches: live.mismatches };
  const openShops = o.clockChecks === false ? [] : blocks.filter((b) => !b.locked).map((b) => b.shopId);
  const [hoursCheck, serviceDays, typed] = await Promise.all([payrollHoursCheck(openShops, start, end), serviceDaysIn(openShops, start, end), typedHoursIn(openShops, start, end)]);
  const shopName = (id: string) => groupOf.get(id)?.shop ?? "Other shop";
  const tips = await checkPayrollTips(blocks, start, end);
  const tipGate = stripePayoutsOn() ? tips.mismatches.filter((m) => !blocks.find((b) => b.shopId === m.shopId)?.locked) : [];

  const ft: Record<string, FtStatus> = {};
  const weekly = new Map<string, Map<string, { worked: number; training: number; pto: number }>>();
  for (const s of slices) {
    if (s.weekStart < ftFrom || s.weekStart > weekStartOf(end)) continue;
    const w = weekly.get(s.staffId) ?? new Map();
    const v = w.get(s.weekStart) ?? { worked: 0, training: 0, pto: 0 };
    v.worked += centi(s.worked);
    v.training += centi(s.training);
    v.pto += centi(s.pto);
    w.set(s.weekStart, v);
    weekly.set(s.staffId, w);
  }
  for (const id of staffIds) {
    const w = weekly.get(id) ?? new Map();
    const list = Array.from({ length: settings.ftWindowWeeks }, (_, i) => w.get(addDays(ftFrom, 7 * i)) ?? { worked: 0, training: 0, pto: 0 });
    ft[id] = ftStatus(id, list, settings);
  }

  return {
    start,
    end,
    settings,
    blocks,
    grand: grandAndCheck.grand,
    mismatches: [...grandAndCheck.mismatches, ...tipGate],
    tips,
    anomalies: [
      ...anomalies(blocks, settings),
      ...sourceFlags.filter((a) => !blocks.find((b) => b.shopId === a.shopId)?.locked),
      ...clockAnomalies(blocks, settings, hoursCheck, days, serviceDays, typed, start, end),
      ...lockAnomalies(blocks),
      ...stateAnomalies(blocks, end, await missedMealsIn([...runShops], start, end)),
    ],
    byEntityState: byEntityState(blocks),
    ft,
    weeks: weekBreakdowns(slices, staffIds, weeks, start, runShops, (id) => groupOf.get(id)?.shop ?? "Other shop"),
    locked: runs.length === 0 ? "none" : runs.length === inRun.length ? "all" : "some",
    hoursOpen: hoursCheck.unlocked.map((u) => ({
      shopId: u.shopId,
      shop: shopName(u.shopId),
      periods: u.periods,
      waiting: [...new Set(hoursCheck.waiting.filter((w) => w.shopId === u.shopId).map((w) => w.label))],
    })),
  };
}

const PAID_SALE = ["paid", "partially_refunded", "refunded"] as const;

/** Service sales per employee, shop and business date, counted the way payroll counts them: paid tickets, no Squire history. */
async function serviceDaysIn(shopIds: string[], start: LocalDate, end: LocalDate) {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ staffId: salesTable.staffId, shopId: salesTable.shopId, date: salesTable.businessDate, cents: sql<number>`sum(${salesTable.serviceNetCents})::int` })
    .from(salesTable)
    .where(
      and(
        inArray(salesTable.shopId, shopIds),
        gte(salesTable.businessDate, start),
        lte(salesTable.businessDate, end),
        inArray(salesTable.status, [...PAID_SALE]),
        eq(salesTable.isImported, false),
        isNotNull(salesTable.staffId),
        sql`not exists (select 1 from payments sq where sq.sale_id = ${salesTable.id} and sq.processor = 'squire_import')`,
      ),
    )
    .groupBy(salesTable.staffId, salesTable.shopId, salesTable.businessDate)
    .having(sql`sum(${salesTable.serviceNetCents}) > 0`);
  return rows.map((r) => ({ ...r, staffId: r.staffId! }));
}

/** Worked hours typed in or imported rather than clocked, per employee and shop, in centi-hours. */
async function typedHoursIn(shopIds: string[], start: LocalDate, end: LocalDate) {
  const out = new Map<string, number>();
  if (!shopIds.length) return out;
  const rows: TimeEntry[] = await db
    .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
    .from(timeEntries)
    .where(
      and(
        inArray(timeEntries.shopId, shopIds),
        eq(timeEntries.kind, "worked"),
        inArray(timeEntries.source, ["manual", "import"]),
        lt(timeEntries.startsAt, endOfLocalDay(end)),
        gt(timeEntries.endsAt, startOfLocalDay(start)),
      ),
    );
  for (const d of dailyHours(rows)) if (d.date >= start && d.date <= end) out.set(`${d.staffId}|${d.shopId}`, (out.get(`${d.staffId}|${d.shopId}`) ?? 0) + d.worked);
  return out;
}

const day = (d: LocalDate) => formatDate(d, "EEE MMM d");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (xs: string[], max = 3, sep = "; ") => `${xs.slice(0, max).join(sep)}${xs.length > max ? "…" : ""}`;

/**
 * The time clock's side of the report (Charles: the hours come from the clock): missed punches,
 * timesheets no manager has approved, hours not locked (when that doesn't already block the lock),
 * service sales on a day with no hours at that shop, and hours typed in or imported instead of clocked.
 * Shops already locked are history and aren't checked.
 */
function clockAnomalies(
  blocks: readonly BlockView[],
  settings: PayrollSettings,
  check: PayrollHoursCheck,
  days: readonly DayHours[],
  serviceDays: { staffId: string; shopId: string; date: LocalDate; cents: number }[],
  typed: Map<string, number>,
  start: LocalDate,
  end: LocalDate,
): Anomaly[] {
  const out: Anomaly[] = [];
  const open = blocks.filter((b) => !b.locked);
  const shopOf = new Map(open.map((b) => [b.shopId, b.shop]));
  const byKey = <T extends { staffId: string; shopId: string }>(xs: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(`${x.staffId}|${x.shopId}`, [...(m.get(`${x.staffId}|${x.shopId}`) ?? []), x]);
    return m;
  };
  for (const list of byKey(check.missedPunches).values()) {
    const p = list[0];
    out.push({
      staffId: p.staffId,
      shopId: p.shopId,
      kind: "missed_punch",
      message: `${p.label} (${shopOf.get(p.shopId)}): ${plural(list.length, "missed punch", "missed punches")}: ${listed(list.map((x) => `${x.problem.toLowerCase()} on ${day(localDateOf(x.at))}`))}. That shift has no hours until a manager adds or fixes the punch, with a reason, on the timesheet.`,
    });
  }
  for (const w of check.waiting)
    out.push({
      staffId: w.staffId,
      shopId: w.shopId,
      kind: "timesheet_not_approved",
      message: `${w.label} (${shopOf.get(w.shopId)}): the timesheet for ${day(w.periodStart)} – ${day(w.periodEnd)} isn't approved by a manager yet.`,
    });
  if (!settings.hoursFromClock)
    for (const u of check.unlocked)
      out.push({
        staffId: null,
        shopId: u.shopId,
        kind: "hours_not_locked",
        message: `${shopOf.get(u.shopId)}: the time clock's hours aren't locked for ${u.periods.map((p) => `${day(p.start)} – ${day(p.end)}`).join(" and ")}, so they can still change after payroll is locked.`,
      });
  const hoursOn = new Set(days.filter((d) => d.date >= start && d.date <= end && d.worked + d.training > 0).map((d) => `${d.staffId}|${d.shopId}|${d.date}`));
  const lineOf = new Map<string, Line>(open.flatMap((b) => b.lines.map((l) => [`${l.staffId}|${b.shopId}`, l] as const)));
  for (const [k, list] of byKey(serviceDays.filter((s) => !hoursOn.has(`${s.staffId}|${s.shopId}|${s.date}`)))) {
    const l = lineOf.get(k);
    if (!l || l.hours + l.otHours === 0) continue;
    out.push({
      staffId: l.staffId,
      shopId: list[0].shopId,
      kind: "sales_day_without_hours",
      message: `${l.name} (${shopOf.get(list[0].shopId)}): service sales on ${plural(list.length, "day")} with no hours at this shop: ${listed(list.map((s) => `${day(s.date)} (${fmtMoney(s.cents / 100)})`))}. A missed clock-in? A manager adds the punches on the timesheet.`,
    });
  }
  if (settings.hoursFromClock)
    for (const [k, centiHours] of typed) {
      const l = lineOf.get(k);
      if (!l || !centiHours) continue;
      out.push({
        staffId: l.staffId,
        shopId: k.split("|")[1],
        kind: "hours_not_from_clock",
        message: `${l.name} (${shopOf.get(k.split("|")[1])}): ${fmtHours(centiHours / 100)} typed in or imported, not from the time clock.`,
      });
    }
  return out;
}

/** Tickets imported from Squire into a locked period after its lock. They never reach payroll, but a re-export should know. */
async function importedAfterLock(runs: readonly (typeof payrollRuns.$inferSelect)[], start: LocalDate, end: LocalDate, groups: readonly PayGroup[]) {
  const out = new Map<string, number>();
  for (const r of runs) {
    const shopId = groups.find((g) => g.id === r.payGroupId)?.shopId;
    if (!shopId) continue;
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(salesTable)
      .where(and(eq(salesTable.shopId, shopId), eq(salesTable.isImported, true), gte(salesTable.businessDate, start), lte(salesTable.businessDate, end), gt(salesTable.createdAt, r.lockedAt)));
    if (n) out.set(r.payGroupId, n);
  }
  return out;
}

/** Shifts in the period flagged for a meal period missed under the shop's state rule, per employee and shop. */
async function missedMealsIn(shopIds: string[], start: LocalDate, end: LocalDate) {
  const out = new Map<string, number>();
  if (!shopIds.length) return out;
  const rows = await db
    .select({ staffId: timePunches.staffId, shopId: timePunches.shopId, n: sql<number>`count(*)::int` })
    .from(timePunches)
    .where(
      and(
        inArray(timePunches.shopId, shopIds),
        eq(timePunches.type, "in"),
        isNull(timePunches.voidedAt),
        gte(timePunches.at, startOfLocalDay(start)),
        lt(timePunches.at, endOfLocalDay(end)),
        sql`${timePunches.flags} @> '["meal_missed"]'::jsonb`,
      ),
    )
    .groupBy(timePunches.staffId, timePunches.shopId);
  for (const r of rows) out.set(`${r.staffId}|${r.shopId}`, r.n);
  return out;
}

/**
 * The work state's rules (ST-I16): straight-time pay under the state minimum wage over the period's
 * paid hours (tips never count; owners at $0 are their own flag), meal periods the state requires and
 * the clock flagged missed, and a shop with no state in its address.
 */
function stateAnomalies(blocks: readonly BlockView[], end: LocalDate, missedMeals: Map<string, number>): Anomaly[] {
  const out: Anomaly[] = [];
  for (const b of blocks) {
    const rules = rulesFor(b.workState);
    if (!b.workState) out.push({ staffId: null, shopId: b.shopId, kind: "no_work_state", message: `${b.shop} has no state in its address, so only the federal minimum wage is checked. Add it in the location's details.` });
    const min = minimumWageCents(b.workState, end);
    for (const l of b.lines) {
      if (l.laborCost === 0) continue;
      const hoursPaid = l.hours + l.otHours + (l.trainingPay > 0 ? l.trainingHours : 0);
      const straight = toCents(l.totalWages + l.trainingPay + l.guaranteeTopUp + l.wage * l.otHours);
      const short = minimumWageShortfallCents(straight, hoursPaid, min);
      if (short > 0)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "below_minimum_wage",
          message: `${l.name} (${b.shop}): ${fmtMoney(straight / 100)} for ${fmtHours(hoursPaid)} is under the ${rules.name} minimum wage of ${fmtMoney(min / 100)} an hour by ${fmtMoney(short / 100)}, tips not counted. Check each workweek and top it up before locking.`,
        });
      const missed = missedMeals.get(`${l.staffId}|${b.shopId}`) ?? 0;
      if (missed && rules.mealPeriod)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "meal_missed",
          message: `${l.name} (${b.shop}): ${missed} shift${missed === 1 ? "" : "s"} of ${rules.mealPeriod.afterHours} hours or more without a ${rules.mealPeriod.minutes}-minute meal break starting by hour ${rules.mealPeriod.startByHours} (${rules.name} ${rules.mealPeriod.law}).`,
        });
    }
  }
  return out;
}

function byEntityState(blocks: readonly BlockView[]): EntityStateTotal[] {
  const by = new Map<string, EntityStateTotal & { people: Set<string> }>();
  for (const b of blocks) {
    const k = `${b.employer?.id ?? ""}|${b.workState ?? ""}`;
    const t = by.get(k) ?? { employerId: b.employer?.id ?? null, employer: b.employer?.legalName ?? "No employer set", workState: b.workState, shops: [], employees: 0, hours: 0, laborCost: 0, tips: 0, people: new Set<string>() };
    t.shops.push(b.shop);
    for (const l of b.lines) {
      t.people.add(l.staffId);
      t.hours += l.hours + l.otHours + l.trainingHours;
      t.laborCost += l.laborCost;
      t.tips += l.tips;
    }
    by.set(k, t);
  }
  return [...by.values()]
    .map(({ people, ...t }) => ({ ...t, employees: people.size, hours: Math.round(t.hours * 100) / 100, laborCost: Math.round(t.laborCost * 100) / 100, tips: Math.round(t.tips * 100) / 100 }))
    .sort((a, b) => a.employer.localeCompare(b.employer) || (a.workState ?? "").localeCompare(b.workState ?? ""));
}

/** Flags on locked shops: data changed since the lock (the file stays as approved), and Squire history imported after it. */
function lockAnomalies(blocks: readonly BlockView[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const b of blocks) {
    if (!b.lockCheck) continue;
    for (const d of b.lockCheck.drift) {
      const fmt = d.field.endsWith("Hours") ? fmtHours : fmtMoney;
      out.push({
        staffId: d.staffId,
        shopId: b.shopId,
        kind: "changed_since_lock",
        message: `${d.name} (${b.shop}): ${RECORD_LABEL[d.field]} was ${fmt(d.locked)} when the period was locked and is ${fmt(d.now)} now. The iSolved file stays as approved; correct it in the current period or in iSolved.`,
      });
    }
    if (b.lockCheck.importedAfterLock)
      out.push({
        staffId: null,
        shopId: b.shopId,
        kind: "late_import",
        message: `${b.shop}: ${b.lockCheck.importedAfterLock} Squire ticket${b.lockCheck.importedAfterLock === 1 ? " was" : "s were"} imported into this period after it was locked. Squire-era tips are reference only and never in the iSolved file, so it's unchanged.`,
      });
  }
  return out;
}

/** Locked shops come from their snapshots, so the Locations totals and the gate are rerun over those. */
function assembleFromBlocks(blocks: readonly ShopBlock[]) {
  const grand = totalsOf(blocks.map((b) => b.totals));
  return { grand, mismatches: reconcile(blocks, grand) };
}

function weekBreakdowns(slices: Slice[], staffIds: string[], weeks: LocalDate[], start: LocalDate, runShops: Set<string>, shopName: (id: string) => string): Record<string, WeekBreakdown[]> {
  const out: Record<string, WeekBreakdown[]> = {};
  for (const id of staffIds) {
    out[id] = weeks
      .map((w) => {
        const list = slices.filter((s) => s.staffId === id && s.weekStart === w);
        return {
          weekStart: w,
          basis: centi(list.reduce((a, s) => a + s.basis, 0)),
          ot: centi(list.reduce((a, s) => a + s.ot, 0)),
          slices: list.map((s) => ({ shop: shopName(s.shopId), periodStart: s.periodStart, basis: centi(s.basis), ot: centi(s.ot), locked: s.locked, inThisRun: s.periodStart === start && runShops.has(s.shopId) })),
        };
      })
      .filter((w) => w.slices.length);
  }
  return out;
}

/** Why approve and lock waits: the shops whose clock hours aren't locked, and whose timesheets still need a manager. */
export function hoursOpenMessage(open: PayrollView["hoursOpen"]): string {
  const waiting = open.flatMap((o) => o.waiting);
  return `Hours come from the time clock, and they aren't locked yet at ${open.map((o) => o.shop).join(", ")}. Lock each shop's timesheets for the period on Timesheets${
    waiting.length ? `, after a manager approves ${plural(waiting.length, "timesheet")} still waiting (${listed(waiting, 4, ", ")})` : ""
  }.`;
}

/**
 * What an approval approves: every shop's rows (inputs, rates, adjustments and results), totals and
 * iSolved file. Any change to what would be paid or uploaded hashes differently.
 */
export function figuresHash(blocks: readonly Pick<ShopBlock, "shopId" | "lines" | "totals" | "exportRows" | "exportHeaders" | "exportFrom">[]): string {
  const shops = [...blocks]
    .sort((a, b) => a.shopId.localeCompare(b.shopId))
    .map((b) => ({ shopId: b.shopId, lines: b.lines.map(({ input, ...l }) => ({ ...l, input })), totals: b.totals, exportRows: b.exportRows, exportHeaders: b.exportHeaders ?? null, exportFrom: b.exportFrom ?? null }));
  return createHash("sha256").update(JSON.stringify(shops)).digest("hex");
}

export function approvalTotals(blocks: readonly ShopBlock[]): PayrollApprovalTotals {
  const { total } = locationSummary(blocks);
  return {
    shops: blocks.map((b) => ({ shopId: b.shopId, shop: b.shop, rows: b.lines.length, service: b.totals.service, totalWages: b.totals.totalWages, laborCost: b.totals.laborCost })),
    service: total.service,
    employeeCost: total.employeeCost,
    grossProfit: total.grossProfit,
  };
}

export interface ApprovalView {
  id: string;
  approvedAt: string;
  approvedBy: string | null;
  note: string | null;
  totals: PayrollApprovalTotals;
  /** The live figures still hash the same: lock and the iSolved files go ahead. */
  current: boolean;
}

/** The period's active approval, and whether the figures still match it. */
export async function approvalOf(view: Pick<PayrollView, "start" | "end" | "blocks">): Promise<ApprovalView | null> {
  const [a] = await db
    .select({ a: payrollApprovals, by: staff.displayLabel })
    .from(payrollApprovals)
    .leftJoin(staff, eq(staff.id, payrollApprovals.approvedBy))
    .where(and(eq(payrollApprovals.periodStart, view.start), eq(payrollApprovals.periodEnd, view.end), isNull(payrollApprovals.revokedAt)));
  if (!a) return null;
  const open = view.blocks.filter((b) => !b.locked);
  return { id: a.a.id, approvedAt: a.a.approvedAt.toISOString(), approvedBy: a.by, note: a.a.note, totals: a.a.totals, current: !open.length || figuresHash(open) === a.a.figuresHash };
}

export type ApprovalStatus = "draft" | "approved" | "stale" | "locked";

export function approvalStatus(view: Pick<PayrollView, "locked">, a: Pick<ApprovalView, "current"> | null): ApprovalStatus {
  if (view.locked === "all") return "locked";
  if (!a) return "draft";
  return a.current ? "approved" : "stale";
}

/** Why the period can't be approved or locked right now, in a line, or null. */
export function approvalBlocked(view: PayrollView): string | null {
  if (view.mismatches.length) return `${view.mismatches.length} total${view.mismatches.length === 1 ? " doesn't" : "s don't"} reconcile`;
  if (view.settings.hoursFromClock && view.hoursOpen.length) return `Hours aren't locked on the time clock at ${view.hoursOpen.length} shop${view.hoursOpen.length === 1 ? "" : "s"}`;
  return null;
}

type Refusal = { error: string; mismatches?: Mismatch[] };

/** What stops a period being approved or locked as it stands. */
function gate(view: PayrollView | null): Refusal | null {
  if (!view) return { error: "No shop has a pay period with those dates." };
  if (view.locked !== "none") return { error: "This pay period is already locked." };
  if (view.mismatches.length) return { error: "Totals don't reconcile, so the period can't be approved or locked.", mismatches: view.mismatches };
  if (view.settings.hoursFromClock && view.hoursOpen.length) return { error: hoursOpenMessage(view.hoursOpen) };
  return null;
}

/**
 * Approve the period's figures as they stand: every shop, after review. Refused while anything
 * doesn't reconcile or the clock hours are open. Approving changed figures revokes the earlier
 * approval. The period still has to be locked; until then, a change to the figures needs a new approval.
 */
export async function approvePayroll(start: LocalDate, end: LocalDate, actor: Actor, note: string | null = null): Promise<Refusal | { approvalId: string }> {
  const view = await buildPayroll(start, end);
  const refused = gate(view);
  if (refused || !view) return refused!;
  const hash = figuresHash(view.blocks);
  const totals = approvalTotals(view.blocks);
  const text = note?.trim().slice(0, 300) || null;
  return db.transaction(async (tx) => {
    const [active] = await tx
      .select()
      .from(payrollApprovals)
      .where(and(eq(payrollApprovals.periodStart, start), eq(payrollApprovals.periodEnd, end), isNull(payrollApprovals.revokedAt)))
      .for("update");
    if (active?.figuresHash === hash) return { error: "These figures are already approved. Lock the period to finish." };
    if (active) {
      await tx.update(payrollApprovals).set({ revokedAt: new Date(), revokedBy: actor.staffId ?? null, revokeReason: "Approved again with changed figures" }).where(eq(payrollApprovals.id, active.id));
      await audit(actor, "payroll.approval_revoked", "payroll_approval", active.id, { periodStart: start, periodEnd: end, reason: "Approved again with changed figures", figuresHash: active.figuresHash }, null, tx);
    }
    const [row] = await tx.insert(payrollApprovals).values({ periodStart: start, periodEnd: end, figuresHash: hash, totals, note: text, approvedBy: actor.staffId ?? null }).returning({ id: payrollApprovals.id });
    await audit(
      actor,
      "payroll.approve",
      "payroll_approval",
      row.id,
      { periodStart: start, periodEnd: end, figuresHash: hash, ...totals, anomalies: view.anomalies.length, note: text, ...(active ? { supersedes: active.id } : {}) },
      null,
      tx,
    );
    return { approvalId: row.id };
  });
}

/** Take back an approval before the lock, with a reason. A locked period stays as approved. */
export async function revokeApproval(start: LocalDate, end: LocalDate, reason: string, actor: Actor): Promise<string | null> {
  const why = reason.trim().slice(0, 300);
  if (!why) return "Say why the approval is taken back.";
  const runs = await db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.periodStart, start), eq(payrollRuns.periodEnd, end)));
  if (runs.length) return "This pay period is locked, so its approval stands.";
  return db.transaction(async (tx) => {
    const [active] = await tx
      .update(payrollApprovals)
      .set({ revokedAt: new Date(), revokedBy: actor.staffId ?? null, revokeReason: why })
      .where(and(eq(payrollApprovals.periodStart, start), eq(payrollApprovals.periodEnd, end), isNull(payrollApprovals.revokedAt)))
      .returning({ id: payrollApprovals.id, figuresHash: payrollApprovals.figuresHash });
    if (!active) return "This pay period isn't approved.";
    await audit(actor, "payroll.approval_revoked", "payroll_approval", active.id, { periodStart: start, periodEnd: end, reason: why, figuresHash: active.figuresHash }, null, tx);
    return null;
  });
}

/**
 * Lock every shop in an approved period: the figures of record and the iSolved files are kept as
 * approved from then on. Needs a current approval: if anything changed since, approve again first.
 */
export async function lockPayroll(start: LocalDate, end: LocalDate, actor: Actor): Promise<Refusal | { locked: number }> {
  const view = await buildPayroll(start, end);
  const refused = gate(view);
  if (refused || !view) return refused!;
  const approval = await approvalOf(view);
  if (!approval) return { error: "Approve the period's figures before locking it." };
  if (!approval.current) return { error: `The figures changed since ${approval.approvedBy ?? "someone"} approved them. Review the changes and approve again before locking.` };
  const hash = figuresHash(view.blocks);
  const groups = await ensurePayGroups();
  const settings = view.settings;
  const runShops = new Set(view.blocks.map((b) => b.shopId));

  const weeks = workweeksOf({ start, end });
  const entries: TimeEntry[] = await db
    .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
    .from(timeEntries)
    .where(and(lt(timeEntries.startsAt, endOfLocalDay(addDays(weeks[weeks.length - 1], 6))), gt(timeEntries.endsAt, startOfLocalDay(weeks[0]))));
  const groupOf = new Map(groups.map((g) => [g.shopId, g]));
  const lockedRows = await db.select().from(payrollLockedOt).where(inArray(payrollLockedOt.weekStart, weeks));
  const slices = overtimeSlices(dailyHours(entries), {
    thresholdCenti: Math.round(settings.otThresholdHours * 100),
    trainingCountsTowardOt: settings.trainingCountsTowardOt,
    dailyThresholdCenti: settings.dailyOtHours ? Math.round(settings.dailyOtHours * 100) : null,
    entityOf: (shopId) => groupOf.get(shopId)?.legalEntity ?? "",
    periodOf: (shopId, date) => periodOf(groupOf.get(shopId)?.calendar ?? settings.calendar, date).start,
    locked: new Map(lockedRows.map((l) => [sliceKey({ ...l }), l.otCenti])),
  }).filter((s) => s.periodStart === start && runShops.has(s.shopId));

  return db.transaction(async (tx) => {
    const [still] = await tx.select({ hash: payrollApprovals.figuresHash, revokedAt: payrollApprovals.revokedAt }).from(payrollApprovals).where(eq(payrollApprovals.id, approval.id)).for("update");
    if (!still || still.hash !== hash || still.revokedAt) throw new AppError("conflict", "The approval changed just now. Reload and try again.");
    let n = 0;
    for (const b of view.blocks) {
      const snapshot: Snapshot = { block: { shopId: b.shopId, shop: b.shop, lines: b.lines, totals: b.totals, exportRows: b.exportRows, exportHeaders: b.exportHeaders, exportFrom: b.exportFrom }, inputsHash: inputsHash(b.lines) };
      const [run] = await tx
        .insert(payrollRuns)
        .values({ payGroupId: b.payGroupId, periodStart: start, periodEnd: end, periodNumber: b.period.number, checkDate: b.period.checkDate, settings, snapshot, lockedBy: actor.staffId ?? null })
        .onConflictDoNothing()
        .returning({ id: payrollRuns.id });
      if (!run) throw new Error("This pay period was locked by someone else just now.");
      const mine = slices.filter((s) => s.shopId === b.shopId);
      if (mine.length) {
        await tx
          .insert(payrollLockedOt)
          .values(mine.map((s) => ({ runId: run.id, staffId: s.staffId, shopId: s.shopId, periodStart: s.periodStart, weekStart: s.weekStart, otCenti: s.ot })))
          .onConflictDoNothing();
      }
      await audit(
        actor,
        "payroll.lock",
        "payroll_run",
        run.id,
        { payGroup: b.payGroup, periodStart: start, periodEnd: end, periodNumber: b.period.number, rows: b.lines.length, laborCost: b.totals.laborCost, service: b.totals.service, inputsHash: snapshot.inputsHash, approvalId: approval.id },
        b.shopId,
        tx,
      );
      n++;
    }
    await lockPayrollTips(tx, view.blocks, start, end, actor);
    return { locked: n };
  });
}

/** Approve and lock in one step (both recorded): what the Payroll Report's two steps do back to back. */
export async function approveAndLock(start: LocalDate, end: LocalDate, actor: Actor): Promise<Refusal | { locked: number }> {
  const view = await buildPayroll(start, end);
  const refused = gate(view);
  if (refused || !view) return refused!;
  if (!(await approvalOf(view))?.current) {
    const a = await approvePayroll(start, end, actor);
    if ("error" in a) return a;
  }
  return lockPayroll(start, end, actor);
}

/** The approved file for one shop. Only locked periods download; the file is built from what was approved. */
export async function lockedExport(payGroupId: string, start: LocalDate, end: LocalDate, exporter: PayrollExporter = isolvedTimecardExporter) {
  const [row] = await db
    .select({ run: payrollRuns, tab: payGroups.exportTab, label: payGroups.label })
    .from(payrollRuns)
    .innerJoin(payGroups, eq(payGroups.id, payrollRuns.payGroupId))
    .where(and(eq(payrollRuns.payGroupId, payGroupId), eq(payrollRuns.periodStart, start), eq(payrollRuns.periodEnd, end)));
  if (!row) return null;
  const block = (row.run.snapshot as Snapshot).block;
  const s = await loadSettings();
  const f = { tab: row.tab, payGroup: row.label, periodNumber: row.run.periodNumber, periodStart: start, periodEnd: end, rows: block.exportRows, headers: block.exportHeaders, format: s.exportFormat, namePattern: s.exportFileName };
  return { fileName: exporter.fileName(f), contentType: exporter.contentType, body: await exporter.render(f), runId: row.run.id as string | null, approvalId: null as string | null, shopId: row.run.payGroupId };
}

/**
 * One shop's iSolved file once the period is approved: from the lock's snapshot when locked, else
 * built from the live figures while they still match the approval. Null before approval, or after a
 * change that needs approving again.
 */
export async function approvedExport(payGroupId: string, start: LocalDate, end: LocalDate, exporter: PayrollExporter = isolvedTimecardExporter) {
  const locked = await lockedExport(payGroupId, start, end, exporter);
  if (locked) return locked;
  const view = await buildPayroll(start, end, { clockChecks: false });
  if (!view) return null;
  const b = view.blocks.find((x) => x.payGroupId === payGroupId);
  const approval = await approvalOf(view);
  if (!b || b.locked || !approval?.current) return null;
  const s = view.settings;
  const f = { tab: b.exportTab, payGroup: b.payGroup, periodNumber: b.period.number, periodStart: start, periodEnd: end, rows: b.exportRows, headers: b.exportHeaders, format: s.exportFormat, namePattern: s.exportFileName };
  return { fileName: exporter.fileName(f), contentType: exporter.contentType, body: await exporter.render(f), runId: null as string | null, approvalId: approval.id as string | null, shopId: b.payGroupId };
}

/** Every payroll step recorded for the period, oldest first: runs, adjustments, approvals, revocations, locks and downloads. */
export async function payrollTrail(start: LocalDate, end: LocalDate) {
  const list = await db
    .select({ at: auditLog.at, action: auditLog.action, by: auditLog.actorLabel, details: auditLog.details, shopId: auditLog.shopId, entityId: auditLog.entityId })
    .from(auditLog)
    .where(and(sql`${auditLog.action} like 'payroll.%'`, sql`${auditLog.details}->>'periodStart' = ${start}`, sql`coalesce(${auditLog.details}->>'periodEnd', ${end}) = ${end}`))
    .orderBy(asc(auditLog.at));
  // Steps written in one transaction share a timestamp: a replaced approval is taken back before the new one, and both come before a lock.
  const rank = (a: string) => ({ "payroll.approval_revoked": 0, "payroll.approve": 1, "payroll.lock": 2 })[a] ?? 1;
  return list
    .map((r, i) => ({ r, i }))
    .sort((x, y) => x.r.at.getTime() - y.r.at.getTime() || rank(x.r.action) - rank(y.r.action) || x.i - y.i)
    .map(({ r }) => ({ ...r, details: (r.details ?? {}) as Record<string, unknown> }));
}

export async function savePayGroup(id: string, v: { label: string; legalEntity: string; exportTab: string; calendar: PayCalendar }, actor: Actor): Promise<string | null> {
  const label = v.label.trim();
  const entity = v.legalEntity.trim();
  if (!label) return "Give the pay group a label.";
  if (!entity) return "Name the legal entity (FEIN) the pay group belongs to.";
  const problem = calendarProblem(v.calendar);
  if (problem) return problem;
  const [g] = await db.select({ id: payGroups.id, shopId: payGroups.shopId }).from(payGroups).where(eq(payGroups.id, id));
  if (!g) return "That pay group is gone.";
  const [hasRun] = await db.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.payGroupId, id)).limit(1);
  const [cur] = await db.select().from(payGroups).where(eq(payGroups.id, id));
  const calChanged =
    cur.anchorStart !== v.calendar.anchorStart || cur.anchorNumber !== v.calendar.anchorNumber || cur.periodDays !== v.calendar.periodDays || cur.checkOffsetDays !== v.calendar.checkOffsetDays;
  if (hasRun && calChanged) {
    const p = periodOf(v.calendar, cur.anchorStart);
    if (p.start !== cur.anchorStart) return "This pay group has locked periods; its calendar can only be renumbered, not moved to different dates.";
  }
  await db
    .update(payGroups)
    .set({
      label,
      legalEntity: entity,
      exportTab: v.exportTab.trim() || label,
      anchorStart: v.calendar.anchorStart,
      anchorNumber: v.calendar.anchorNumber,
      periodDays: v.calendar.periodDays,
      checkOffsetDays: v.calendar.checkOffsetDays,
      numberResetsYearly: v.calendar.numberResetsYearly,
      updatedAt: new Date(),
    })
    .where(eq(payGroups.id, id));
  await audit(actor, "payroll.pay_group", "pay_group", id, { label, legalEntity: entity, exportTab: v.exportTab, ...v.calendar }, g.shopId);
  return null;
}

export async function saveProfile(
  staffId: string,
  v: { employeeNumber: string | null; keyIsText: boolean; isolvedName: string | null; exportPosition: number | null; tippedOccupationCode?: string | null; zeroHourlyPay?: boolean },
  actor: Actor,
): Promise<string | null> {
  const num = v.employeeNumber?.trim() || null;
  if (num && num.length > 32) return "That employee number is too long.";
  const occ = v.tippedOccupationCode === undefined ? undefined : v.tippedOccupationCode?.trim().toUpperCase() || null;
  if (occ && !/^[A-Z0-9]{1,8}$/.test(occ)) return "The tipped occupation code is 1 to 8 letters or digits, from Treasury's list.";
  const set = {
    employeeNumber: num,
    keyIsText: v.keyIsText,
    isolvedName: v.isolvedName?.trim() || null,
    exportPosition: v.exportPosition,
    ...(occ === undefined ? {} : { tippedOccupationCode: occ }),
    ...(v.zeroHourlyPay === undefined ? {} : { zeroHourlyPay: v.zeroHourlyPay }),
  };
  await db
    .insert(payrollProfiles)
    .values({ staffId, ...set })
    .onConflictDoUpdate({ target: payrollProfiles.staffId, set: { ...set, updatedAt: new Date() } });
  // The number itself stays out of the audit trail.
  await audit(actor, "payroll.profile", "staff", staffId, {
    employeeNumberSet: !!num,
    isolvedNameSet: !!set.isolvedName,
    keyIsText: v.keyIsText,
    exportPosition: v.exportPosition,
    ...(occ === undefined ? {} : { tippedOccupationCode: occ }),
    ...(v.zeroHourlyPay === undefined ? {} : { zeroHourlyPay: v.zeroHourlyPay }),
  });
  return null;
}

export async function saveRate(staffId: string, shopId: string | null, v: { hourlyRate: number; servicePct: number; productPct: number; trainingRate: number | null }, actor: Actor): Promise<string | null> {
  const bad = (x: number, max: number) => !Number.isFinite(x) || x < 0 || x > max;
  if (bad(v.hourlyRate, 500)) return "Hourly wage is 0 to 500.";
  if (bad(v.servicePct, 1) || bad(v.productPct, 1)) return "Percentages are 0% to 100%.";
  if (v.trainingRate !== null && bad(v.trainingRate, 500)) return "Training rate is 0 to 500.";
  const existing = await db
    .select({ id: payrollRates.id })
    .from(payrollRates)
    .where(and(eq(payrollRates.staffId, staffId), shopId ? eq(payrollRates.shopId, shopId) : sql`${payrollRates.shopId} is null`));
  if (existing[0]) await db.update(payrollRates).set({ ...v, updatedAt: new Date() }).where(eq(payrollRates.id, existing[0].id));
  else await db.insert(payrollRates).values({ staffId, shopId, ...v });
  await audit(actor, "payroll.rate", "staff", staffId, { shopId, ...v }, shopId);
  return null;
}

export async function setOverride(shopId: string, periodStart: LocalDate, staffId: string, field: Overridable, value: number | null, reason: string, actor: Actor): Promise<string | null> {
  if (!(OVERRIDABLE as readonly string[]).includes(field)) return "That value can't be typed over.";
  if (await isLockedOn(shopId, periodStart)) return "This pay period is locked.";
  if (value !== null && (field === "ptoHours" || field === "trainingHours")) {
    const s = await loadSettings();
    if ((field === "ptoHours" ? s.ptoSource : s.trainingSource) === "clock")
      return `${field === "ptoHours" ? "PTO" : "Training"} hours come from the time clock only (Payroll setup), so they can't be typed on the report. Add a time entry instead.`;
  }
  if (value === null) {
    await db.delete(payrollOverrides).where(and(eq(payrollOverrides.shopId, shopId), eq(payrollOverrides.periodStart, periodStart), eq(payrollOverrides.staffId, staffId), eq(payrollOverrides.field, field)));
    await audit(actor, "payroll.override_clear", "staff", staffId, { field, periodStart }, shopId);
    return null;
  }
  if (!Number.isFinite(value)) return "Enter a number.";
  if (!reason.trim()) return "Say why the value is being typed over.";
  await db
    .insert(payrollOverrides)
    .values({ shopId, periodStart, staffId, field, value, reason: reason.trim(), createdBy: actor.staffId ?? null })
    .onConflictDoUpdate({ target: [payrollOverrides.shopId, payrollOverrides.periodStart, payrollOverrides.staffId, payrollOverrides.field], set: { value, reason: reason.trim(), createdBy: actor.staffId ?? null } });
  await audit(actor, "payroll.override", "staff", staffId, { field, value, reason: reason.trim(), periodStart }, shopId);
  return null;
}

export interface TimeEntryInput {
  staffId: string;
  shopId: string;
  kind: "worked" | "training" | "pto";
  startsAt: Date;
  endsAt: Date;
  note?: string | null;
  source?: "clock" | "import" | "manual";
}

export function timeEntryProblem(e: TimeEntryInput): string | null {
  if (!(e.startsAt instanceof Date) || Number.isNaN(e.startsAt.getTime()) || Number.isNaN(e.endsAt.getTime())) return "Enter a start and end time.";
  if (e.endsAt <= e.startsAt) return "The end has to be after the start.";
  if (e.endsAt.getTime() - e.startsAt.getTime() > 24 * 3600_000) return "One entry can't be longer than 24 hours.";
  return null;
}

export async function addTimeEntries(list: TimeEntryInput[], actor: Actor): Promise<{ error: string } | { added: number }> {
  for (const [i, e] of list.entries()) {
    const p = timeEntryProblem(e);
    if (p) return { error: list.length > 1 ? `Row ${i + 1}: ${p}` : p };
    if (await hoursLockedOn(e.shopId, todayLocal(e.startsAt))) return { error: `${list.length > 1 ? `Row ${i + 1}: ` : ""}that pay period is locked.` };
  }
  if (!list.length) return { added: 0 };
  const rows = await db
    .insert(timeEntries)
    .values(list.map((e) => ({ ...e, note: e.note ?? null, source: e.source ?? "manual", createdBy: actor.staffId ?? null })))
    .returning({ id: timeEntries.id, shopId: timeEntries.shopId });
  await audit(actor, "payroll.time_add", "time_entry", rows.length === 1 ? rows[0].id : null, { count: rows.length, source: list[0].source ?? "manual" }, rows.length === 1 ? rows[0].shopId : null);
  return { added: rows.length };
}

export async function deleteTimeEntry(id: string, actor: Actor): Promise<string | null> {
  const [e] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
  if (!e) return "That entry is gone.";
  if (e.punchInId) return "That entry comes from clock punches. Fix the punches on the timesheet instead.";
  if (await hoursLockedOn(e.shopId, todayLocal(e.startsAt))) return "That pay period is locked.";
  await db.delete(timeEntries).where(eq(timeEntries.id, id));
  await audit(actor, "payroll.time_delete", "time_entry", id, { staffId: e.staffId, kind: e.kind, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString() }, e.shopId);
  return null;
}
