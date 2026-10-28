import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, payGroups, payrollApprovals, payrollCommissionAdjustments, payrollEmployers, payrollFinalPays, payrollLockedOt, payrollOverrides, payrollProfiles, payrollRates, payrollRuns, payrollSquireImports, payrollSquireInputs, sales as salesTable, shopHours, shops as shopsTable, staff, timeEntries, timePunches, tipLedger, type PayrollApprovalTotals } from "@/db/schema";
import { calendarProblem, periodOf, periodStarting, periodsAround, sameCalendar, workweeksOf, type CalendarPeriod, type PayCalendar } from "@/domain/payroll/calendar";
import {
  OVERRIDABLE,
  anomalies,
  assemble,
  computeLine,
  extraFromOf,
  fmtHours,
  fmtMoney,
  ftStatus,
  locationSummary,
  regularRateAdjustments,
  retroOtPremiumFor,
  toCents,
  reconcile,
  totalsOf,
  type Anomaly,
  type ExportRow,
  type ExtraFrom,
  type FtStatus,
  type LateCommission,
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
import { addDays, endOfLocalDay, formatDate, localDateOf, startOfLocalDay, todayLocal, weekdayOf, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { AppError } from "@/server/errors";
import { notSquireEra } from "@/server/squire-era";
import { loadRolloutPlan, type PayrollSource } from "@/server/rollout-plan";
import { guaranteeTopUps, exportExtras } from "@/domain/compensation";
import { loadCompensationSettings, payrollPlans, setupRates } from "@/server/compensation";
import { payrollSalesBetween, unassignedSalesBetween, type PayrollSalesRow } from "@/server/reports";
import { declaredByDay, declaredTipsBetween } from "@/server/tips/declarations";
import { syncTipLedger } from "@/server/tips/ledger";
import { lockPayrollTips, payrollTipSplit } from "@/server/tips/payouts";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { payrollHoursCheck, type PayrollHoursCheck } from "@/server/time-clock";
import { isolvedTimecardExporter, type PayrollExporter } from "./export";
import { declarationPostingDate, tipPostingDate } from "./tip-posting";
import { checkPayrollTips, type TipCheck, type TipCheckBlock } from "./tip-reconcile";
import { ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings, type LegalEntity, type PayGroup } from "./groups";
import { groupCalendar, resyncPeriodDates, savePeriodDates as savePeriodDatesFor } from "./period-dates";

export { DEFAULT_CALENDAR, ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings, type PayGroup } from "./groups";


export interface PeriodChoice {
  key: string;
  start: LocalDate;
  end: LocalDate;
  groups: { id: string; label: string; code: string | null; number: number; checkDate: LocalDate; submitBy: LocalDate; datesMoved: boolean }[];
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
      c.groups.push({ id: g.id, label: g.label, code: g.code, number: p.number, checkDate: p.checkDate, submitBy: p.submitBy, datesMoved: p.datesMoved });
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
  slices: { shopId: string; shop: string; periodStart: LocalDate; basis: number; worked: number; training: number; ot: number; locked: boolean; inThisRun: boolean }[];
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
  /** iSolved's pay group code (B is Rock Island), picked at upload. */
  payGroupCode: string | null;
  exportTab: string;
  /** The shop's legal entity: its pay group's employer, or the one it had when the period was locked. */
  employer: LegalEntity | null;
  /** The shop's work state: its wage-hour rules, and the state its hours are withheld for. */
  workState: string | null;
  period: CalendarPeriod;
  locked: { at: string; by: string | null } | null;
  /** Locked shops: the hash of the inputs of record as approved, and what's changed in the live data since. */
  lockCheck: { hash: string; liveHash: string; drift: LockDrift[]; importedAfterLock: number } | null;
  /** Where the period's figures come from: punches and tickets here, or (during the rollout) the shop's Squire Commissions report imported for the period. */
  source: PayrollSource;
  squireImport: { fileName: string | null; importedAt: string; rows: number; notes: string[] } | null;
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
  /** Employees paid off-cycle for this period (final pay, N9): left out of its rows and files. */
  finalPays: FinalPaid[];
  /** The period by legal entity and work state: what each FEIN files in each state. */
  byEntityState: EntityStateTotal[];
  ft: Record<string, FtStatus>;
  weeks: Record<string, WeekBreakdown[]>;
  locked: "none" | "some" | "all";
  /** Shops still open whose time clock hours aren't locked for every day of the period. While hours come from the clock, approve and lock waits for them. */
  hoursOpen: { shopId: string; shop: string; periods: { start: LocalDate; end: LocalDate }[]; waiting: string[] }[];
  /** Shops still open whose payroll for the period comes from Squire and whose Squire report isn't imported yet. Approve and lock waits for them. */
  squireMissing: { shopId: string; shop: string }[];
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
  /** Absent on periods locked before the rollout: they came from here. */
  source?: PayrollSource;
  /** Each employee on the shop's lines: their days here (dayFigures) and their workweeks across shops, as at the lock. Absent on periods locked before they were kept. */
  days?: Record<string, DayFigures[]>;
  weeks?: Record<string, WeekBreakdown[]>;
}

/**
 * Periods locked before tips were split by how they're paid had every tip paid separately; before
 * guaranteed minimums, nobody had a top-up; before declarations and post-payout refunds, none of either.
 */
function upgradeBlock(b: ShopBlock): ShopBlock {
  type Cols = { tips: number; otPremiumAdj?: number; cardTipsOutside?: number; salesTax?: number; tipsInPayroll?: number; tipsOutside?: number; tipsPaidOut?: number; guaranteeTopUp?: number; declaredCashTips?: number; chargedTips?: number; lateTipRefunds?: number; tipRefundsShopCost?: number };
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
    otPremiumAdj: x.otPremiumAdj ?? 0,
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

export function driftOf(locked: readonly Pick<Line, "staffId" | "name" | "input">[], live: readonly Pick<Line, "staffId" | "name" | "input">[]): LockDrift[] {
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
  const runs = await db.select().from(payrollRuns).where(and(eq(payrollRuns.periodStart, start), eq(payrollRuns.periodEnd, end)));
  const runOf = new Map(runs.map((r) => [r.payGroupId, r]));
  const rollout = await loadRolloutPlan();
  const sourceOf = new Map(
    inRun.map(({ g }) => {
      const run = runOf.get(g.id);
      return [g.shopId, run ? ((run.snapshot as Snapshot).source ?? "platform") : rollout.sourceOf(g.shopId, start)] as const;
    }),
  );
  const squireShops = new Set([...runShops].filter((id) => sourceOf.get(id) === "squire"));
  const platformShops = [...runShops].filter((id) => !squireShops.has(id));

  const weeks = workweeksOf({ start, end });
  const ftFrom = addDays(weekStartOf(end), -7 * (settings.ftWindowWeeks - 1));
  const from = ftFrom < weeks[0] ? ftFrom : weeks[0];
  const to = addDays(weeks[weeks.length - 1], 6);
  const entries = withoutSquireDays(
    await db
      .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
      .from(timeEntries)
      .where(and(lt(timeEntries.startsAt, endOfLocalDay(to)), gt(timeEntries.endsAt, startOfLocalDay(from)))),
    squireShops,
    start,
    end,
  );
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
  const hours = new Map<string, { worked: number; training: number; trainingOverlap: number; pto: number; ot: number }>();
  for (const s of mine) {
    const k = `${s.staffId}|${s.shopId}`;
    const h = hours.get(k) ?? { worked: 0, training: 0, trainingOverlap: 0, pto: 0, ot: 0 };
    h.worked += s.worked;
    h.training += s.training;
    h.trainingOverlap += s.trainingOverlap;
    h.pto += s.pto;
    h.ot += s.ot;
    hours.set(k, h);
  }

  const sales = platformShops.length ? await payrollSalesBetween({ shopIds: platformShops }, start, end) : [];
  const salesOf = new Map(sales.map((r) => [`${r.staffId}|${r.shopId}`, r]));
  const [squireRows, squireImports] = squireShops.size
    ? await Promise.all([
        db.select().from(payrollSquireInputs).where(and(eq(payrollSquireInputs.periodStart, start), inArray(payrollSquireInputs.shopId, [...squireShops]))),
        db.select().from(payrollSquireImports).where(and(eq(payrollSquireImports.periodStart, start), inArray(payrollSquireImports.shopId, [...squireShops]))),
      ])
    : [[], []];
  const squireOf = new Map(squireRows.map((r) => [`${r.staffId}|${r.shopId}`, r]));
  const squireImportOf = new Map(squireImports.map((r) => [r.shopId, r]));
  const overrides = await db.select().from(payrollOverrides).where(and(eq(payrollOverrides.periodStart, start), inArray(payrollOverrides.shopId, [...runShops])));
  const lateOf = await lateCommissionsFor([...runShops], start, settings);
  const finals = await db.select().from(payrollFinalPays).where(eq(payrollFinalPays.periodStart, start));
  const finalIds = new Set(finals.map((f) => f.staffId));
  const finalInputs: LineInput[] = [];
  const [tipSplit, declared] = await Promise.all([payrollTipSplit(platformShops, start, end), declaredTipsBetween(platformShops, start, end)]);
  const keys = new Set([
    ...hours.keys(),
    ...salesOf.keys(),
    ...squireOf.keys(),
    ...declared.keys(),
    ...overrides.map((o) => `${o.staffId}|${o.shopId}`),
    ...lateOf.keys(),
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
    const h = hours.get(k) ?? { worked: 0, training: 0, trainingOverlap: 0, pto: 0, ot: 0 };
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
    const who = {
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
      zeroHourlyPay: pr?.zeroHourlyPay ?? false,
      ...(plan?.mixed.length ? { mixedRates: plan.mixed } : {}),
      ...(lateOf.has(k) ? { lateCommissions: lateOf.get(k) } : {}),
      overrides: Object.keys(ov).length ? ov : undefined,
    };
    const input: LineInput = squireShops.has(shopId)
      ? { ...who, ...squireFigures(squireOf.get(k)) }
      : {
          ...who,
          workedHours: centi(h.worked),
          otHours: centi(h.ot),
          ptoHours: settings.ptoSource === "manager" ? 0 : centi(h.pto),
          trainingHours: settings.trainingSource === "manager" ? 0 : centi(h.training),
          ...(h.trainingOverlap && settings.trainingSource !== "manager" ? { trainingOverlapHours: centi(h.trainingOverlap) } : {}),
          serviceSales: ((s?.serviceSalesCents ?? 0) + baseExtra(s, "service", settings)) / 100,
          productSales: ((s?.productSalesCents ?? 0) + baseExtra(s, "product", settings)) / 100,
          tips: tipsCents / 100,
          tipsInPayroll: (split?.inPayrollCents ?? 0) / 100,
          tipsPaidOut: (split?.paidOutCents ?? 0) / 100,
          owedTipsInPayroll: (split?.owedInPayrollCents ?? 0) / 100,
          tipsPaidByStripe: (split?.paidByStripeCents ?? 0) / 100,
          declaredCashTips: (declared.get(k) ?? 0) / 100,
          chargedTips: Math.min(tipsCents, Math.max(0, charged)) / 100,
          lateTipRefunds: late / 100,
          salesTax: (s?.salesTaxCents ?? 0) / 100,
        };
    if (finalIds.has(staffId)) {
      finalInputs.push(input);
      continue;
    }
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
  const rr = regularRateAdjustments(
    [...inputsByShop.values()].flat().map((i) => computeLine(i, settings)),
    settings,
  );
  for (const list of inputsByShop.values()) for (const i of list) if (rr.has(`${i.staffId}|${i.shopId}`)) i.otRegularRateAdj = rr.get(`${i.staffId}|${i.shopId}`);
  const order = (a: LineInput, b: LineInput) =>
    (profile.get(a.staffId)?.exportPosition ?? 1e9) - (profile.get(b.staffId)?.exportPosition ?? 1e9) || a.name.localeCompare(b.name);

  const unassigned = await unassignedSalesBetween(platformShops, start, end);
  for (const q of squireImports)
    if (q.totals.unassignedServiceCents || q.totals.unassignedProductCents)
      unassigned.set(q.shopId, { serviceSalesCents: q.totals.unassignedServiceCents, productSalesCents: q.totals.unassignedProductCents, salesTaxCents: 0 });
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
      payGroupCode: g.code,
      exportTab: g.exportTab,
      employer: employerOf.get((run ? run.employerId : g.employerId) ?? "") ?? null,
      workState: g.workState,
      period: run ? { ...p, checkDate: run.checkDate } : p,
      locked: run ? { at: run.lockedAt.toISOString(), by: run.lockedBy ? (lockedBy.get(run.lockedBy) ?? null) : null } : null,
      lockCheck,
      source: sourceOf.get(g.shopId) ?? "platform",
      squireImport: (() => {
        const q = squireImportOf.get(g.shopId);
        return q ? { fileName: q.fileName, importedAt: q.importedAt.toISOString(), rows: q.rows, notes: q.notes } : null;
      })(),
    };
  });
  const grandAndCheck = runs.length ? assembleFromBlocks(blocks) : { grand: live.grand, mismatches: live.mismatches };
  const openShops = o.clockChecks === false ? [] : blocks.filter((b) => !b.locked && b.source === "platform").map((b) => b.shopId);
  const [hoursCheck, serviceDays, typed, sundayOpen] = await Promise.all([
    payrollHoursCheck(openShops, start, end),
    serviceDaysIn(openShops, start, end),
    typedHoursIn(openShops, start, end),
    openOnSunday(openShops),
  ]);
  const shopName = (id: string) => groupOf.get(id)?.shop ?? "Other shop";
  const finalPays = finalPaysOf(finals, finalInputs, person);
  const tips = await checkPayrollTips(withFinalRows(blocks.filter((b) => b.source === "platform"), finals), start, end);
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

  const refundedAfterExport = await tipsRefundedAfterExport(blocks, start, end);
  const flaggedAfterExport = new Set(refundedAfterExport.map((a) => `${a.staffId}|${a.shopId}`));
  return {
    start,
    end,
    settings,
    blocks,
    grand: grandAndCheck.grand,
    mismatches: [...grandAndCheck.mismatches, ...tipGate],
    tips,
    anomalies: [
      ...anomalies(blocks, settings).filter((a) => a.kind !== "late_tip_refund" || !flaggedAfterExport.has(`${a.staffId}|${a.shopId}`)),
      ...refundedAfterExport,
      ...sourceFlags.filter((a) => !blocks.find((b) => b.shopId === a.shopId)?.locked),
      ...clockAnomalies(blocks, settings, hoursCheck, days, serviceDays, typed, start, end, { checked: new Set(openShops), open: sundayOpen }),
      ...lockAnomalies(blocks),
      ...finalPayAnomalies(finalPays),
      ...(await lateTipsIn(blocks, start, end)),
      ...(await lateDeclarationsIn(blocks, start, end)),
      ...stateAnomalies(blocks, end, await missedMealsIn(platformShops, start, end)),
      ...crossSourceOt(blocks, (id) => groupOf.get(id)?.legalEntity ?? ""),
      ...(rollout.active ? await rolloutSourceAnomalies(blocks) : []),
    ],
    byEntityState: byEntityState(blocks),
    finalPays,
    ft,
    weeks: lockedWeeks(runs, inRun.length) ?? weekBreakdowns(slices, staffIds, weeks, start, runShops, (id) => groupOf.get(id)?.shop ?? "Other shop"),
    locked: runs.length === 0 ? "none" : runs.length === inRun.length ? "all" : "some",
    hoursOpen: hoursCheck.unlocked.map((u) => ({
      shopId: u.shopId,
      shop: shopName(u.shopId),
      periods: u.periods,
      waiting: [...new Set(hoursCheck.waiting.filter((w) => w.shopId === u.shopId).map((w) => w.label))],
    })),
    squireMissing: blocks.filter((b) => !b.locked && b.source === "squire" && !b.squireImport).map((b) => ({ shopId: b.shopId, shop: b.shop })),
  };
}

/** A shop's figures from its Squire Commissions report: tips were paid by Squire, so they're all "already received" in iSolved, as in the workbook. */
function squireFigures(q: typeof payrollSquireInputs.$inferSelect | undefined) {
  return {
    workedHours: centi(q?.workedCenti ?? 0),
    otHours: centi(q?.otCenti ?? 0),
    ptoHours: centi(q?.ptoCenti ?? 0),
    trainingHours: centi(q?.trainingCenti ?? 0),
    serviceSales: (q?.serviceCents ?? 0) / 100,
    productSales: (q?.productCents ?? 0) / 100,
    tips: Math.max(0, q?.tipsCents ?? 0) / 100,
    tipsInPayroll: 0,
    tipsPaidOut: 0,
    owedTipsInPayroll: 0,
    tipsPaidByStripe: 0,
    declaredCashTips: 0,
    chargedTips: 0,
    lateTipRefunds: 0,
    salesTax: (q?.salesTaxCents ?? 0) / 100,
  } satisfies Partial<LineInput>;
}

export interface EmployeeDaySales {
  date: LocalDate;
  staffId: string;
  shopId: string;
  /** Tickets they're the barber on. */
  tickets: number;
  serviceCents: number;
  productCents: number;
}

/**
 * One employee's days at the shops given, read the way buildPayroll reads them for the report: hours
 * by shop and local date from the time clock (centi-hours, dailyHours), and service and product sales
 * by day as the report credits them (payrollSalesBetween with the commission base's extras), in cents.
 * Days at a shop whose payroll for that period comes from Squire are left out: Squire's report has
 * only the period's total. Over a pay period, each figure adds up to the employee's line of the report
 * before a manager's override. A null staffId is everyone at the shops.
 */
export async function employeeDays(staffId: string | null, shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  if (!shopIds.length || from > to) return { hours: [] as DayHours[], sales: [] as EmployeeDaySales[] };
  const [groups, settings, rollout] = await Promise.all([ensurePayGroups(), loadSettings(), loadRolloutPlan()]);
  const groupOf = new Map(groups.map((g) => [g.shopId, g]));
  const ids = [...shopIds];
  const groupIds = ids.flatMap((id) => (groupOf.has(id) ? [groupOf.get(id)!.id] : []));
  const runs = groupIds.length
    ? await db
        .select({ g: payrollRuns.payGroupId, s: payrollRuns.periodStart, snapshot: payrollRuns.snapshot })
        .from(payrollRuns)
        .where(and(inArray(payrollRuns.payGroupId, groupIds), lte(payrollRuns.periodStart, to), gte(payrollRuns.periodEnd, from)))
    : [];
  const runOf = new Map(runs.map((r) => [`${r.g}|${r.s}`, r]));
  const sourceOn = (shopId: string, date: LocalDate): PayrollSource => {
    const g = groupOf.get(shopId);
    const start = periodOf(g?.calendar ?? settings.calendar, date).start;
    const run = g ? runOf.get(`${g.id}|${start}`) : undefined;
    return run ? ((run.snapshot as Snapshot).source ?? "platform") : rollout.sourceOf(shopId, start);
  };
  const entries = await db
    .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
    .from(timeEntries)
    .where(and(staffId ? eq(timeEntries.staffId, staffId) : undefined, inArray(timeEntries.shopId, ids), lt(timeEntries.startsAt, endOfLocalDay(to)), gt(timeEntries.endsAt, startOfLocalDay(from))));
  const hours = dailyHours(entries).filter((d) => d.date >= from && d.date <= to && sourceOn(d.shopId, d.date) === "platform");
  const sales: EmployeeDaySales[] = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    for (const s of await payrollSalesBetween({ shopIds: ids, ...(staffId ? { staffId } : {}) }, d, d))
      if (sourceOn(s.shopId, d) === "platform")
        sales.push({ date: d, staffId: s.staffId, shopId: s.shopId, tickets: s.tickets, serviceCents: s.serviceSalesCents + baseExtra(s, "service", settings), productCents: s.productSalesCents + baseExtra(s, "product", settings) });
  return { hours, sales };
}

/** One employee's day at one shop, in cents and centi-hours: what GET /me/earnings/days adds up, and what a lock keeps. */
export interface DayFigures {
  date: LocalDate;
  shopId: string;
  workedCenti: number;
  trainingCenti: number;
  ptoCenti: number;
  tickets: number;
  serviceCents: number;
  productCents: number;
  cardTipsCents: number;
  cashTipsCents: number;
  giftCardTipsCents: number;
  /** Manager adjustments and anything else in the tip ledger that isn't a tender. */
  tipAdjustmentsCents: number;
  declaredCashTipsCents: number;
}

const tenderKey = (method: string) => (method === "card" ? "cardTipsCents" : method === "cash" ? "cashTipsCents" : method === "gift_card" ? "giftCardTipsCents" : "tipAdjustmentsCents");

/**
 * Each day's figures per employee (all of them at the shops when staffId is null) and shop: hours and
 * sales as employeeDays reads them, tips from the tip ledger the report's TIPS reconciles to, and the
 * cash tips declared for the day as payroll counts them. Only days with something on them.
 */
export async function dayFigures(staffId: string | null, shopIds: readonly string[], from: LocalDate, to: LocalDate): Promise<Map<string, DayFigures[]>> {
  const out = new Map<string, Map<string, DayFigures>>();
  if (!shopIds.length || from > to) return new Map();
  await syncTipLedger(db, { shopIds });
  const [worked, ledger, declared] = await Promise.all([
    employeeDays(staffId, shopIds, from, to),
    db
      .select({ staffId: tipLedger.staffId, shopId: tipLedger.shopId, date: tipLedger.businessDate, method: tipLedger.method, cents: sql<number>`sum(${tipLedger.amountCents})::int` })
      .from(tipLedger)
      .where(and(staffId ? eq(tipLedger.staffId, staffId) : undefined, inArray(tipLedger.shopId, [...shopIds]), gte(tipLedger.businessDate, from), lte(tipLedger.businessDate, to)))
      .groupBy(tipLedger.staffId, tipLedger.shopId, tipLedger.businessDate, tipLedger.method),
    declaredByDay(staffId, shopIds, from, to),
  ]);
  const at = (who: string, shopId: string, date: LocalDate) => {
    const m = out.get(who) ?? new Map<string, DayFigures>();
    out.set(who, m);
    const k = `${shopId}|${date}`;
    const d = m.get(k) ?? { date, shopId, workedCenti: 0, trainingCenti: 0, ptoCenti: 0, tickets: 0, serviceCents: 0, productCents: 0, cardTipsCents: 0, cashTipsCents: 0, giftCardTipsCents: 0, tipAdjustmentsCents: 0, declaredCashTipsCents: 0 };
    m.set(k, d);
    return d;
  };
  for (const h of worked.hours) {
    const d = at(h.staffId, h.shopId, h.date);
    d.workedCenti += h.worked;
    d.trainingCenti += h.training;
    d.ptoCenti += h.pto;
  }
  for (const s of worked.sales) {
    const d = at(s.staffId, s.shopId, s.date);
    d.tickets += s.tickets;
    d.serviceCents += s.serviceCents;
    d.productCents += s.productCents;
  }
  for (const r of ledger) if (r.cents) at(r.staffId, r.shopId, r.date)[tenderKey(r.method)] += r.cents;
  for (const r of declared) at(r.staffId, r.shopId, r.date).declaredCashTipsCents += r.cents;
  return new Map([...out].map(([who, m]) => [who, [...m.values()].sort((a, b) => a.date.localeCompare(b.date) || a.shopId.localeCompare(b.shopId))]));
}

/** The locked runs of these shops' pay groups that overlap [from, to], with what each kept at the lock. */
export async function lockedRunsOver(shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  const groups = (await ensurePayGroups()).filter((g) => shopIds.includes(g.shopId));
  if (!groups.length) return [];
  const shopOf = new Map(groups.map((g) => [g.id, g.shopId]));
  const runs = await db
    .select({ id: payrollRuns.id, g: payrollRuns.payGroupId, start: payrollRuns.periodStart, end: payrollRuns.periodEnd, lockedAt: payrollRuns.lockedAt, snapshot: payrollRuns.snapshot })
    .from(payrollRuns)
    .where(and(inArray(payrollRuns.payGroupId, [...shopOf.keys()]), lte(payrollRuns.periodStart, to), gte(payrollRuns.periodEnd, from)));
  return runs.map((r) => {
    const s = r.snapshot as Snapshot;
    return { id: r.id, shopId: shopOf.get(r.g)!, start: r.start, end: r.end, lockedAt: r.lockedAt, days: s.days ?? null, weeks: s.weeks ?? null, source: s.source ?? "platform" };
  });
}

export type LockedRun = Awaited<ReturnType<typeof lockedRunsOver>>[number];

/** Punches at a shop whose payroll for the period comes from Squire don't count: Squire's hours are the record. */
function withoutSquireDays<T extends TimeEntry>(entries: T[], squireShops: ReadonlySet<string>, start: LocalDate, end: LocalDate): T[] {
  if (!squireShops.size) return entries;
  return entries.filter((e) => {
    const d = localDateOf(e.startsAt);
    return !(squireShops.has(e.shopId) && d >= start && d <= end);
  });
}

/**
 * Someone who worked at a shop paid from here and one paid from Squire data, for the same employer,
 * in the same period: overtime is per workweek across both, and Squire's report has only the
 * period's total, so it can't be worked out here. A manager checks their weeks and types the OT.
 */
function crossSourceOt(blocks: readonly BlockView[], entityOf: (shopId: string) => string): Anomaly[] {
  const out: Anomaly[] = [];
  const open = blocks.filter((b) => !b.locked);
  const seen = new Map<string, { name: string; platform: string[]; squire: string[]; worked: number }>();
  for (const b of open)
    for (const l of b.lines) {
      if (l.input.workedHours <= 0) continue;
      const k = `${l.staffId}|${entityOf(b.shopId)}`;
      const v = seen.get(k) ?? { name: l.name, platform: [], squire: [], worked: 0 };
      v[b.source].push(b.shop);
      v.worked += l.input.workedHours;
      seen.set(k, v);
    }
  for (const [k, v] of seen) {
    if (!v.platform.length || !v.squire.length) continue;
    out.push({
      staffId: k.split("|")[0],
      shopId: null,
      kind: "cross_source_ot",
      message: `${v.name} worked at ${v.platform.join(", ")} (time clock) and ${v.squire.join(", ")} (Squire data) for the same employer: ${fmtHours(v.worked)} in all. Overtime is per week across both, and Squire's report only has the period's total, so check their weeks and type the O.T. hours on the report.`,
    });
  }
  return out;
}

/** The rollout's flags, per shop: payroll from Squire while the shop books here, or from here while it still books on Squire. */
async function rolloutSourceAnomalies(blocks: readonly BlockView[]): Promise<Anomaly[]> {
  const open = blocks.filter((b) => !b.locked);
  if (!open.length) return [];
  const mode = new Map((await db.select({ id: shopsTable.id, bookingMode: shopsTable.bookingMode }).from(shopsTable).where(inArray(shopsTable.id, open.map((b) => b.shopId)))).map((s) => [s.id, s.bookingMode]));
  const out: Anomaly[] = [];
  for (const b of open) {
    const here = mode.get(b.shopId) !== "external";
    if (b.source === "squire" && here)
      out.push({ staffId: null, shopId: b.shopId, kind: "rollout_source", message: `${b.shop} books here, but its payroll for this period comes from Squire data. If it went live at the start of this period, set its payroll to come from here on the Rollout page.` });
    if (b.source === "platform" && !here)
      out.push({ staffId: null, shopId: b.shopId, kind: "rollout_source", message: `${b.shop} still books on Squire, but its payroll for this period comes from here, so tickets rung up in Squire aren't in it. Check the Rollout page.` });
  }
  return out;
}

/** I10: the card surcharge and loyalty rewards in the commission base, when the brand counts them. */
function baseExtra(s: PayrollSalesRow | undefined, kind: "service" | "product", settings: PayrollSettings): number {
  if (!s) return 0;
  const fee = settings.commissionBase.cardFee === "include" ? (kind === "service" ? s.cardFeeServiceCents : s.cardFeeProductCents) : 0;
  const loyalty = settings.commissionBase.loyalty === "shop_absorbs" ? (kind === "service" ? s.loyaltyServiceCents : s.loyaltyProductCents) : 0;
  return (fee ?? 0) + (loyalty ?? 0);
}

/** Late commissions paid in the period starting `start`, by `${staffId}|${shopId}`, each with the half-time it adds to its locked period's overtime there. */
async function lateCommissionsFor(shopIds: string[], start: LocalDate, settings: PayrollSettings): Promise<Map<string, LateCommission[]>> {
  const out = new Map<string, LateCommission[]>();
  if (!shopIds.length) return out;
  const rows = await db
    .select()
    .from(payrollCommissionAdjustments)
    .where(and(eq(payrollCommissionAdjustments.periodStart, start), inArray(payrollCommissionAdjustments.shopId, shopIds)))
    .orderBy(asc(payrollCommissionAdjustments.createdAt));
  if (!rows.length) return out;
  const groups = await ensurePayGroups();
  const locked = await db
    .select({ payGroupId: payrollRuns.payGroupId, periodStart: payrollRuns.periodStart, snapshot: payrollRuns.snapshot })
    .from(payrollRuns)
    .where(inArray(payrollRuns.periodStart, [...new Set(rows.map((r) => r.earnedStart))]));
  for (const r of rows) {
    const g = groups.find((x) => x.shopId === r.shopId);
    const run = locked.find((x) => x.payGroupId === g?.id && x.periodStart === r.earnedStart);
    const line = run ? ((run.snapshot as Snapshot).block.lines.find((l) => l.staffId === r.staffId) ?? null) : null;
    const amount = r.amountCents / 100;
    const k = `${r.staffId}|${r.shopId}`;
    out.set(k, [...(out.get(k) ?? []), { id: r.id, earnedStart: r.earnedStart, earnedEnd: r.earnedEnd, amount, reason: r.reason, retroOtPremium: retroOtPremiumFor(amount, line, settings) }]);
  }
  return out;
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
        isNotNull(salesTable.staffId),
        notSquireEra("sales"),
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
 * service sales on a day with no hours at that shop, hours typed in or imported instead of clocked, and
 * hours on a Sunday at a shop that's closed Sundays. Shops already locked are history and aren't checked.
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
  sunday: { checked: ReadonlySet<string>; open: ReadonlySet<string> },
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
  const sundays = days.filter((d) => d.date >= start && d.date <= end && d.worked > 0 && weekdayOf(d.date) === 0 && sunday.checked.has(d.shopId) && !sunday.open.has(d.shopId));
  for (const [k, list] of byKey(sundays)) {
    const l = lineOf.get(k);
    out.push({
      staffId: list[0].staffId,
      shopId: list[0].shopId,
      kind: "sunday_punch",
      message: `${l?.name ?? "An employee"} (${shopOf.get(list[0].shopId)}): hours on ${plural(list.length, "Sunday")}, when the shop is normally closed: ${listed(list.map((d) => `${day(d.date)} (${fmtHours(d.worked / 100)})`))}. They're paid, and count toward OT in the workweek that starts that Sunday. Check the punches are right.`,
    });
  }
  return out;
}

/** Shops whose weekly hours include Sunday: hours worked there on a Sunday aren't unusual. */
async function openOnSunday(shopIds: readonly string[]): Promise<Set<string>> {
  if (!shopIds.length) return new Set();
  const rows = await db.select({ shopId: shopHours.shopId }).from(shopHours).where(and(inArray(shopHours.shopId, [...shopIds]), eq(shopHours.weekday, 0)));
  return new Set(rows.map((r) => r.shopId));
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

/** One shop's part of a final pay as approved: the employee's row, and their line in that shop's iSolved file. */
export interface FinalPayShop {
  shopId: string;
  shop: string;
  payGroupId: string;
  payGroup: string;
  payGroupCode: string | null;
  exportTab: string;
  periodNumber: number;
  line: Line;
  exportRow: ExportRow;
  exportHeaders?: string[];
  exportFrom?: ExtraFrom[];
}

export interface FinalPaid {
  id: string;
  staffId: string;
  name: string;
  lastDay: LocalDate;
  approvedAt: string;
  shops: FinalPayShop[];
  /** What's changed in the live data since the final pay was approved. */
  drift: (LockDrift & { shop: string })[];
}

const finalShopsOf = (f: typeof payrollFinalPays.$inferSelect) => f.snapshot.shops as unknown as FinalPayShop[];

function finalPaysOf(finals: readonly (typeof payrollFinalPays.$inferSelect)[], live: readonly LineInput[], person: Map<string, { label: string }>): FinalPaid[] {
  return finals.map((f) => {
    const shops = finalShopsOf(f);
    const drift = [...new Set([...shops.map((x) => x.shopId), ...live.filter((i) => i.staffId === f.staffId).map((i) => i.shopId)])].flatMap((shopId) => {
      const was = shops.filter((x) => x.shopId === shopId).map((x) => x.line);
      const now = live.filter((i) => i.staffId === f.staffId && i.shopId === shopId).map((i) => ({ staffId: i.staffId, name: i.name, input: i }));
      const shop = shops.find((x) => x.shopId === shopId)?.shop ?? "another shop";
      return driftOf(was, now).map((d) => ({ ...d, shop }));
    });
    return { id: f.id, staffId: f.staffId, name: shops[0]?.line.name ?? person.get(f.staffId)?.label ?? "Unknown", lastDay: f.lastDay, approvedAt: f.approvedAt.toISOString(), shops, drift };
  });
}

/** The tip check counts every tip of the period, so a final pay's rows are checked with the shop's file. */
function withFinalRows<B extends TipCheckBlock>(blocks: readonly B[], finals: readonly (typeof payrollFinalPays.$inferSelect)[]): B[] {
  if (!finals.length) return [...blocks];
  return blocks.map((b) => {
    const mine = finals.flatMap((f) => finalShopsOf(f).filter((x) => x.shopId === b.shopId));
    return mine.length
      ? { ...b, lines: [...b.lines, ...mine.map((x) => x.line)], exportRows: [...b.exportRows, ...mine.map((x) => ({ ...x.exportRow, from: x.exportFrom ?? extraFromOf({ exportHeaders: x.exportHeaders }) }))] }
      : b;
  });
}

function finalPayAnomalies(list: readonly FinalPaid[]): Anomaly[] {
  return list.flatMap((f) => [
    {
      staffId: f.staffId,
      shopId: null,
      kind: "final_pay" as const,
      message: `${f.name} was paid off-cycle for this period (final pay, last day ${formatDate(f.lastDay, "MMM d")}, approved ${formatDate(localDateOf(f.approvedAt), "MMM d")}), so they're not in its files.`,
    },
    ...f.drift.map((d) => ({
      staffId: f.staffId,
      shopId: f.shops.find((x) => x.shop === d.shop)?.shopId ?? null,
      kind: "final_pay_changed" as const,
      message: `${f.name} (${d.shop}): ${RECORD_LABEL[d.field]} was ${(d.field.endsWith("Hours") ? fmtHours : fmtMoney)(d.locked)} in their final pay and is ${(d.field.endsWith("Hours") ? fmtHours : fmtMoney)(d.now)} now. Pay or recover the difference in iSolved.`,
    })),
  ]);
}

/** Tips on tickets from an earlier, already-locked period that came in afterwards, so they're paid in this one (N7). */
async function lateTipsIn(blocks: readonly BlockView[], start: LocalDate, end: LocalDate): Promise<Anomaly[]> {
  const open = blocks.filter((b) => !b.locked);
  if (!open.length) return [];
  const rows = await db.execute<{ staff_id: string; shop_id: string; cents: number; from: string; label: string }>(sql`
    select s.staff_id, s.shop_id, sum(p.tip_cents)::int cents, min(s.business_date)::text "from", st.display_label label
    from payments p join sales s on s.id = p.sale_id join staff st on st.id = s.staff_id
    where s.shop_id in (${sql.join(open.map((b) => sql`${b.shopId}::uuid`), sql`, `)}) and p.tip_cents <> 0 and s.status in ('paid', 'partially_refunded', 'refunded')
      and s.business_date < ${start} and ${tipPostingDate()} between ${start} and ${end} and ${notSquireEra()}
    group by 1, 2, 5`);
  return [...rows].map((r) => ({
    staffId: r.staff_id,
    shopId: r.shop_id,
    kind: "late_tip" as const,
    message: `${r.label} (${open.find((b) => b.shopId === r.shop_id)?.shop ?? "Other shop"}): ${fmtMoney(r.cents / 100)} of tips on tickets from ${formatDate(r.from, "MMM d")} came in after that pay period was locked, so they're paid in this one.`,
  }));
}

/** Cash tips declared after their day's pay period was locked: paid in this one (declarationPostingDate), flagged for review. */
async function lateDeclarationsIn(blocks: readonly BlockView[], start: LocalDate, end: LocalDate): Promise<Anomaly[]> {
  const open = blocks.filter((b) => !b.locked && b.source === "platform");
  if (!open.length) return [];
  const rows = await db.execute<{ staff_id: string; shop_id: string; cents: number; from: string; label: string }>(sql`
    select d.staff_id, d.shop_id, sum(d.amount_cents)::int cents, min(d.business_date)::text "from", st.display_label label
    from tip_declarations d join staff st on st.id = d.staff_id
    where d.shop_id in (${sql.join(open.map((b) => sql`${b.shopId}::uuid`), sql`, `)}) and d.business_date < ${start}
      and ${declarationPostingDate(sql.raw("d"))} between ${start} and ${end}
      and not exists (select 1 from tip_declarations r where r.replaces_id = d.id)
    group by 1, 2, 5`);
  return [...rows].map((r) => ({
    staffId: r.staff_id,
    shopId: r.shop_id,
    kind: "late_declaration" as const,
    message: `${r.label} (${open.find((b) => b.shopId === r.shop_id)?.shop ?? "Other shop"}): ${fmtMoney(r.cents / 100)} of cash tips for ${formatDate(r.from, "MMM d")} were declared after that pay period was locked, so they're paid in this one. The locked period stays as exported.`,
  }));
}

/**
 * Tips refunded in this period on tickets of a pay period already exported to iSolved (locked for
 * the shop's pay group, or approved). That period's E_Cash Tips Recd_Dollars stays as sent, and
 * this period's tips are never netted negative for it (the refund is left out of them).
 */
async function tipsRefundedAfterExport(blocks: readonly BlockView[], start: LocalDate, end: LocalDate): Promise<Anomaly[]> {
  const open = blocks.filter((b) => !b.locked);
  if (!open.length) return [];
  const rows = await db.execute<{ staff_id: string; shop_id: string; cents: number; from: string; label: string }>(sql`
    select s.staff_id, r.shop_id, sum(r.tip_cents)::int cents, min(s.business_date)::text "from", st.display_label label
    from refunds r join sales s on s.id = r.sale_id join staff st on st.id = s.staff_id
    where r.shop_id in (${sql.join(open.map((b) => sql`${b.shopId}::uuid`), sql`, `)}) and r.kind = 'refund' and r.tip_cents > 0
      and r.business_date between ${start} and ${end} and s.business_date < ${start} and ${notSquireEra()}
      and (exists (select 1 from payroll_runs pr join pay_groups pg on pg.id = pr.pay_group_id where pg.shop_id = s.shop_id and s.business_date between pr.period_start and pr.period_end)
        or exists (select 1 from payroll_approvals pa where pa.revoked_at is null and s.business_date between pa.period_start and pa.period_end))
    group by 1, 2, 5`);
  return [...rows].map((r) => ({
    staffId: r.staff_id,
    shopId: r.shop_id,
    kind: "tip_refunded_after_export" as const,
    message: `${r.label} (${open.find((b) => b.shopId === r.shop_id)?.shop ?? "Other shop"}): ${fmtMoney(r.cents / 100)} of tips refunded on tickets from ${formatDate(r.from, "MMM d")}, a pay period already exported to iSolved. Its E_Cash Tips Recd_Dollars stays as sent, and the refund isn't netted against this period's tips: they never go negative and nothing is taken from their pay. Review before locking.`,
  }));
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

/** Once every shop in the period is locked, each employee's workweeks as the lock kept them (null for a period locked before they were). */
function lockedWeeks(runs: readonly { snapshot: unknown }[], shops: number): Record<string, WeekBreakdown[]> | null {
  const kept = runs.map((r) => (r.snapshot as Snapshot).weeks);
  if (runs.length !== shops || kept.some((w) => !w)) return null;
  return Object.assign({}, ...kept);
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
          slices: list.map((s) => ({
            shopId: s.shopId,
            shop: shopName(s.shopId),
            periodStart: s.periodStart,
            basis: centi(s.basis),
            worked: centi(s.worked),
            training: centi(s.training),
            ot: centi(s.ot),
            locked: s.locked,
            inThisRun: s.periodStart === start && runShops.has(s.shopId),
          })),
        };
      })
      .filter((w) => w.slices.length);
  }
  return out;
}

/** Why approve and lock waits: the shops whose clock hours aren't locked, and whose timesheets still need a manager. */
export function squireMissingMessage(list: PayrollView["squireMissing"]): string {
  return `Payroll for ${list.map((x) => x.shop).join(", ")} comes from Squire this period, and Squire's Commissions report isn't imported for ${list.length === 1 ? "it" : "them"} yet. Import it on the Rollout page.`;
}

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
  if (view.squireMissing.length) return `Squire's report isn't imported for ${view.squireMissing.map((x) => x.shop).join(", ")}`;
  if (view.settings.hoursFromClock && view.hoursOpen.length) return `Hours aren't locked on the time clock at ${view.hoursOpen.length} shop${view.hoursOpen.length === 1 ? "" : "s"}`;
  return null;
}

type Refusal = { error: string; mismatches?: Mismatch[] };

/** What stops a period being approved or locked as it stands. */
function gate(view: PayrollView | null): Refusal | null {
  if (!view) return { error: "No shop has a pay period with those dates." };
  if (view.locked !== "none") return { error: "This pay period is already locked." };
  if (view.mismatches.length) return { error: "Totals don't reconcile, so the period can't be approved or locked.", mismatches: view.mismatches };
  if (view.squireMissing.length) return { error: squireMissingMessage(view.squireMissing) };
  if (view.settings.hoursFromClock && view.hoursOpen.length) return { error: hoursOpenMessage(view.hoursOpen) };
  return null;
}

const PREPARING = ["payroll.override", "payroll.override_clear", "payroll.late_commission", "payroll.late_commission_remove", "payroll.squire_import"];

export const SELF_APPROVAL =
  "You changed this pay period's figures (an adjustment, late commission or hours entered by hand), so someone else with Approve and lock approves them. The Brand Owner can approve their own changes; that's recorded.";

/** Who changed the period's figures by hand: adjustments, late commission, and hours entered, imported or deleted on the report. */
export async function preparersOf(start: LocalDate, end: LocalDate): Promise<{ staffId: string; label: string }[]> {
  const from = startOfLocalDay(start);
  const to = endOfLocalDay(end);
  const [audited, entered] = await Promise.all([
    db
      .selectDistinct({ id: auditLog.actorStaffId })
      .from(auditLog)
      .where(
        and(
          isNotNull(auditLog.actorStaffId),
          or(
            and(inArray(auditLog.action, PREPARING), sql`${auditLog.details}->>'periodStart' = ${start}`),
            and(eq(auditLog.action, "payroll.time_delete"), sql`(${auditLog.details}->>'startsAt')::timestamptz < ${to.toISOString()}::timestamptz and (${auditLog.details}->>'endsAt')::timestamptz > ${from.toISOString()}::timestamptz`),
          ),
        ),
      ),
    db
      .selectDistinct({ id: timeEntries.createdBy })
      .from(timeEntries)
      .where(and(isNotNull(timeEntries.createdBy), ne(timeEntries.source, "clock"), lt(timeEntries.startsAt, to), gt(timeEntries.endsAt, from))),
  ]);
  const ids = [...new Set([...audited, ...entered].map((r) => r.id).filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = await db.select({ staffId: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids));
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Approve the period's figures as they stand: every shop, after review. Refused while anything
 * doesn't reconcile or the clock hours are open, and to anyone who changed the figures by hand
 * unless they're the Brand Owner (recorded as approving their own changes). Approving changed
 * figures revokes the earlier approval. The period still has to be locked; until then, a change
 * to the figures needs a new approval.
 */
export async function approvePayroll(start: LocalDate, end: LocalDate, actor: Actor, note: string | null = null): Promise<Refusal | { approvalId: string }> {
  const view = await buildPayroll(start, end);
  const refused = gate(view);
  if (refused || !view) return refused!;
  const selfApproved = actor.staffId ? (await preparersOf(start, end)).some((p) => p.staffId === actor.staffId) : false;
  if (selfApproved && !(await loadStaffAccess(actor.staffId!))?.isOwner) return { error: SELF_APPROVAL };
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
      { periodStart: start, periodEnd: end, figuresHash: hash, ...totals, anomalies: view.anomalies.length, note: text, ...(active ? { supersedes: active.id } : {}), ...(selfApproved ? { selfApproved: true } : {}) },
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
  const entries = withoutSquireDays(
    await db
      .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
      .from(timeEntries)
      .where(and(lt(timeEntries.startsAt, endOfLocalDay(addDays(weeks[weeks.length - 1], 6))), gt(timeEntries.endsAt, startOfLocalDay(weeks[0])))),
    new Set(view.blocks.filter((b) => b.source === "squire").map((b) => b.shopId)),
    start,
    end,
  );
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
  const figures = await dayFigures(null, [...runShops], start, end);
  const kept = <T>(b: (typeof view.blocks)[number], f: (staffId: string) => T) => Object.fromEntries(b.lines.map((l) => [l.staffId, f(l.staffId)]));

  return db.transaction(async (tx) => {
    const [still] = await tx.select({ hash: payrollApprovals.figuresHash, revokedAt: payrollApprovals.revokedAt }).from(payrollApprovals).where(eq(payrollApprovals.id, approval.id)).for("update");
    if (!still || still.hash !== hash || still.revokedAt) throw new AppError("conflict", "The approval changed just now. Reload and try again.");
    let n = 0;
    for (const b of view.blocks) {
      const snapshot: Snapshot = {
        block: { shopId: b.shopId, shop: b.shop, lines: b.lines, totals: b.totals, exportRows: b.exportRows, exportHeaders: b.exportHeaders, exportFrom: b.exportFrom },
        inputsHash: inputsHash(b.lines),
        source: b.source,
        days: kept(b, (id) => (figures.get(id) ?? []).filter((d) => d.shopId === b.shopId)),
        weeks: kept(b, (id) => view.weeks[id] ?? []),
      };
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
        { payGroup: b.payGroup, periodStart: start, periodEnd: end, periodNumber: b.period.number, rows: b.lines.length, laborCost: b.totals.laborCost, service: b.totals.service, inputsHash: snapshot.inputsHash, approvalId: approval.id, source: b.source },
        b.shopId,
        tx,
      );
      n++;
    }
    await lockPayrollTips(tx, view.blocks.filter((b) => b.source === "platform"), start, end, actor, { skip: new Set(view.finalPays.map((f) => f.staffId)) });
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
    .select({ run: payrollRuns, tab: payGroups.exportTab, label: payGroups.label, code: payGroups.isolvedCode })
    .from(payrollRuns)
    .innerJoin(payGroups, eq(payGroups.id, payrollRuns.payGroupId))
    .where(and(eq(payrollRuns.payGroupId, payGroupId), eq(payrollRuns.periodStart, start), eq(payrollRuns.periodEnd, end)));
  if (!row) return null;
  const block = (row.run.snapshot as Snapshot).block;
  const s = await loadSettings();
  const f = { tab: row.tab, payGroup: row.label, payGroupCode: row.code, periodNumber: row.run.periodNumber, periodStart: start, periodEnd: end, rows: block.exportRows, headers: block.exportHeaders, format: s.exportFormat, namePattern: s.exportFileName };
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
  const f = { tab: b.exportTab, payGroup: b.payGroup, payGroupCode: b.payGroupCode, periodNumber: b.period.number, periodStart: start, periodEnd: end, rows: b.exportRows, headers: b.exportHeaders, format: s.exportFormat, namePattern: s.exportFileName };
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

/** Moves one pay period's check and submit-by dates for every pay group that has it (a holiday), with a reason. */
export async function savePeriodDates(start: LocalDate, end: LocalDate, v: { checkDate: LocalDate; submitBy: LocalDate; reason: string }, actor: Actor): Promise<string | null> {
  return savePeriodDatesFor(start, end, v, await ensurePayGroups(), actor);
}

export async function savePayGroup(
  id: string,
  v: { label: string; legalEntity: string; exportTab: string; code?: string | null; calendar: PayCalendar },
  actor: Actor,
): Promise<string | null> {
  const label = v.label.trim();
  const entity = v.legalEntity.trim();
  if (!label) return "Give the pay group a label.";
  if (!entity) return "Name the legal entity (FEIN) the pay group belongs to.";
  const problem = calendarProblem(v.calendar);
  if (problem) return problem;
  const [cur] = await db.select().from(payGroups).where(eq(payGroups.id, id));
  if (!cur) return "That pay group is gone.";
  const code = v.code === undefined ? cur.isolvedCode : v.code?.trim().toUpperCase() || null;
  if (code && !/^[A-Z0-9]{1,4}$/.test(code)) return "The iSolved pay group code is 1 to 4 letters or digits, like B.";
  if (code) {
    const [other] = await db.select({ label: payGroups.label }).from(payGroups).where(and(eq(payGroups.isolvedCode, code), ne(payGroups.id, id)));
    if (other) return `${other.label} already has pay group code ${code}.`;
  }
  const [hasRun] = await db.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.payGroupId, id)).limit(1);
  const calChanged = !sameCalendar(groupCalendar(cur), v.calendar);
  if (hasRun && calChanged) {
    const p = periodOf(v.calendar, cur.anchorStart);
    if (p.start !== cur.anchorStart) return "This pay group has locked periods; its calendar can only be renumbered, not moved to different dates.";
  }
  const { dates: _dates, ...cal } = v.calendar;
  await db.transaction(async (tx) => {
    await tx
      .update(payGroups)
      .set({
        label,
        legalEntity: entity,
        exportTab: v.exportTab.trim() || label,
        isolvedCode: code,
        anchorStart: cal.anchorStart,
        anchorNumber: cal.anchorNumber,
        periodDays: cal.periodDays,
        checkOffsetDays: cal.checkOffsetDays,
        submitOffsetDays: cal.submitOffsetDays,
        numberResetsYearly: cal.numberResetsYearly,
        updatedAt: new Date(),
      })
      .where(eq(payGroups.id, id));
    if (calChanged) await resyncPeriodDates(tx, id);
  });
  await audit(actor, "payroll.pay_group", "pay_group", id, { label, legalEntity: entity, exportTab: v.exportTab, isolvedCode: code, ...cal }, cur.shopId);
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

/** An employee's hours worked and overtime at a shop for the pay period starting then, as the punches give them (C6). */
async function punchedHours(shopId: string, periodStart: LocalDate, staffId: string): Promise<{ workedHours: number; otHours: number } | null> {
  const g = (await ensurePayGroups()).find((x) => x.shopId === shopId);
  const p = g ? periodStarting(g.calendar, periodStart) : null;
  if (!p) return null;
  const view = await buildPayroll(p.start, p.end, { clockChecks: false });
  const l = view?.blocks.find((b) => b.shopId === shopId)?.lines.find((x) => x.staffId === staffId);
  return { workedHours: l?.input.workedHours ?? 0, otHours: l?.input.otHours ?? 0 };
}

export async function setOverride(shopId: string, periodStart: LocalDate, staffId: string, field: Overridable, value: number | null, reason: string, actor: Actor): Promise<string | null> {
  if (!(OVERRIDABLE as readonly string[]).includes(field)) return "That value can't be typed over.";
  if (await isLockedOn(shopId, periodStart)) return "This pay period is locked.";
  const fromSquire = (await loadRolloutPlan()).sourceOf(shopId, periodStart) === "squire";
  if (value !== null && !fromSquire && (field === "ptoHours" || field === "trainingHours")) {
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
  if (!fromSquire && (field === "workedHours" || field === "otHours")) {
    const punched = await punchedHours(shopId, periodStart, staffId);
    if (punched && toCents(value) < toCents(punched[field]))
      return `The punches show ${fmtHours(punched[field])} of ${field === "otHours" ? "overtime" : "hours worked"}, and an adjustment can't go below that. If the punches are wrong, fix them on the timesheet.`;
  }
  await db
    .insert(payrollOverrides)
    .values({ shopId, periodStart, staffId, field, value, reason: reason.trim(), createdBy: actor.staffId ?? null })
    .onConflictDoUpdate({ target: [payrollOverrides.shopId, payrollOverrides.periodStart, payrollOverrides.staffId, payrollOverrides.field], set: { value, reason: reason.trim(), createdBy: actor.staffId ?? null } });
  await audit(actor, "payroll.override", "staff", staffId, { field, value, reason: reason.trim(), periodStart }, shopId);
  return null;
}

/**
 * I2: commission owed for a locked pay period, paid in the open one starting periodStart. Adds pay
 * only. The locked period keeps its file; the half-time the commission adds to its overtime is
 * worked out from its locked figures.
 */
export async function addLateCommission(
  v: { shopId: string; periodStart: LocalDate; staffId: string; earnedStart: LocalDate; amount: number; reason: string },
  actor: Actor,
): Promise<string | null> {
  const g = (await ensurePayGroups()).find((x) => x.shopId === v.shopId);
  if (!g || !periodStarting(g.calendar, v.periodStart)) return "Pick a pay period of that shop.";
  if (await isLockedOn(v.shopId, v.periodStart)) return "This pay period is locked.";
  const earned = periodStarting(g.calendar, v.earnedStart);
  if (!earned || earned.end >= v.periodStart) return "Pick an earlier pay period the commission was earned in.";
  if (!(await isLockedOn(v.shopId, v.earnedStart))) return "That pay period isn't locked yet: fix its sales or type over its figures there instead.";
  const cents = Math.round(v.amount * 100);
  if (!Number.isFinite(v.amount) || cents <= 0 || cents > 10_000_000) return "Enter the commission owed, more than $0.";
  if (!v.reason.trim()) return "Say what the commission is for.";
  const [row] = await db
    .insert(payrollCommissionAdjustments)
    .values({ shopId: v.shopId, periodStart: v.periodStart, staffId: v.staffId, earnedStart: earned.start, earnedEnd: earned.end, amountCents: cents, reason: v.reason.trim().slice(0, 300), createdBy: actor.staffId ?? null })
    .returning({ id: payrollCommissionAdjustments.id });
  await audit(actor, "payroll.late_commission", "staff", v.staffId, { id: row.id, periodStart: v.periodStart, earnedStart: earned.start, amountCents: cents, reason: v.reason.trim() }, v.shopId);
  return null;
}

export async function removeLateCommission(id: string, actor: Actor): Promise<string | null> {
  const [r] = await db.select().from(payrollCommissionAdjustments).where(eq(payrollCommissionAdjustments.id, id));
  if (!r) return "That adjustment is gone.";
  if (await isLockedOn(r.shopId, r.periodStart)) return "This pay period is locked.";
  await db.delete(payrollCommissionAdjustments).where(eq(payrollCommissionAdjustments.id, id));
  await audit(actor, "payroll.late_commission_remove", "staff", r.staffId, { id, periodStart: r.periodStart, amountCents: r.amountCents }, r.shopId);
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
