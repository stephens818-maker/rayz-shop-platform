import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { payGroups, payrollLockedOt, payrollOverrides, payrollProfiles, payrollRates, payrollRuns, staff, timeEntries } from "@/db/schema";
import { calendarProblem, periodOf, periodStarting, periodsAround, workweeksOf, type CalendarPeriod, type PayCalendar } from "@/domain/payroll/calendar";
import {
  OVERRIDABLE,
  anomalies,
  assemble,
  computeLine,
  ftStatus,
  reconcile,
  totalsOf,
  type Anomaly,
  type FtStatus,
  type LineInput,
  type Mismatch,
  type Overridable,
  type Overrides,
  type PayrollSettings,
  type ShopBlock,
  type Totals,
} from "@/domain/payroll/calc";
import { dailyHours, overtimeSlices, sliceKey, weekStartOf, type Slice, type TimeEntry } from "@/domain/payroll/overtime";
import { addDays, endOfLocalDay, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { guaranteeTopUps, exportExtras } from "@/domain/compensation";
import { loadCompensationSettings, payrollPlans, setupRates } from "@/server/compensation";
import { payrollSalesBetween } from "@/server/reports";
import { lockPayrollTips, payrollTipSplit } from "@/server/tips/payouts";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { isolvedTimecardExporter, type PayrollExporter } from "./export";
import { checkPayrollTips, type TipCheck } from "./tip-reconcile";
import { DEFAULT_CALENDAR, ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings, type PayGroup } from "./groups";

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

export interface BlockView extends ShopBlock {
  payGroupId: string;
  payGroup: string;
  exportTab: string;
  period: CalendarPeriod;
  locked: { at: string; by: string | null } | null;
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
  ft: Record<string, FtStatus>;
  weeks: Record<string, WeekBreakdown[]>;
  locked: "none" | "some" | "all";
}

interface Snapshot {
  block: ShopBlock;
}

/** Periods locked before tips were split by how they're paid had every tip paid separately; before guaranteed minimums, nobody had a top-up. */
function upgradeBlock(b: ShopBlock): ShopBlock {
  const tipCols = <T extends { tips: number; tipsInPayroll?: number; tipsOutside?: number; tipsPaidOut?: number; guaranteeTopUp?: number }>(x: T): T => ({
    ...x,
    tipsInPayroll: x.tipsInPayroll ?? 0,
    tipsOutside: x.tipsOutside ?? x.tips,
    tipsPaidOut: x.tipsPaidOut ?? 0,
    guaranteeTopUp: x.guaranteeTopUp ?? 0,
  });
  return { ...b, lines: b.lines.map(tipCols), totals: tipCols(b.totals) };
}

const centi = (x: number) => x / 100;

/**
 * Everything on the Payroll Report for one pay period: each shop (pay group) whose calendar has this
 * period, with its rows, totals, export rows, the reconciliation result and anomalies. A locked shop
 * comes back exactly as it was approved.
 */
export async function buildPayroll(start: LocalDate, end: LocalDate): Promise<PayrollView | null> {
  const groups = await ensurePayGroups();
  const inRun = groups.map((g) => ({ g, p: periodStarting(g.calendar, start) })).filter((x): x is { g: PayGroup; p: CalendarPeriod } => x.p !== null && x.p.end === end && x.p.number >= 1);
  if (!inRun.length) return null;
  const settings = await loadSettings();
  const groupOf = new Map(groups.map((g) => [g.shopId, g]));
  const calOf = (shopId: string) => groupOf.get(shopId)?.calendar ?? DEFAULT_CALENDAR;
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
  const tipSplit = await payrollTipSplit([...runShops], start, end);
  const keys = new Set([...hours.keys(), ...salesOf.keys(), ...overrides.map((o) => `${o.staffId}|${o.shopId}`), ...[...tipSplit.entries()].filter(([, v]) => v.adjustCents || v.absorbedCents || v.inPayrollCents).map(([k]) => k)]);
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
  for (const k of keys) {
    const [staffId, shopId] = k.split("|");
    if (!runShops.has(shopId)) continue;
    const p = person.get(staffId);
    const pr = profile.get(staffId);
    const r = rateOf(staffId, shopId);
    const plan = plans?.rateFor(staffId, shopId) ?? null;
    const h = hours.get(k) ?? { worked: 0, training: 0, pto: 0, ot: 0 };
    const s = salesOf.get(k);
    const ov: Overrides = {};
    for (const o of overrides) if (o.staffId === staffId && o.shopId === shopId && (OVERRIDABLE as readonly string[]).includes(o.field)) ov[o.field as Overridable] = { value: o.value, reason: o.reason };
    const name = p?.label ?? "Unknown";
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
      ptoHours: centi(h.pto),
      trainingHours: centi(h.training),
      serviceSales: (s?.serviceSalesCents ?? 0) / 100,
      productSales: (s?.productSalesCents ?? 0) / 100,
      tips: ((s?.cardTipsCents ?? 0) + (s?.cashTipsCents ?? 0) + (s?.giftCardTipsCents ?? 0) + (tipSplit.get(k)?.adjustCents ?? 0) + (tipSplit.get(k)?.absorbedCents ?? 0)) / 100,
      tipsInPayroll: (tipSplit.get(k)?.inPayrollCents ?? 0) / 100,
      tipsPaidOut: (tipSplit.get(k)?.paidOutCents ?? 0) / 100,
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

  const live = assemble(
    inRun.map(({ g }) => ({ shopId: g.shopId, shop: g.shop, inputs: (inputsByShop.get(g.shopId) ?? []).sort(order) })),
    settings,
    { extras: exportExtras(comp), guaranteeHeader: comp.guaranteeHeader },
  );
  const lockedBy = new Map((runs.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, runs.map((r) => r.lockedBy).filter((x): x is string => !!x))) : []).map((s) => [s.id, s.label]));
  const blocks: BlockView[] = inRun.map(({ g, p }, i) => {
    const run = runOf.get(g.id);
    const block = run ? upgradeBlock((run.snapshot as Snapshot).block) : live.blocks[i];
    return {
      ...block,
      shop: g.shop,
      payGroupId: g.id,
      payGroup: g.label,
      exportTab: g.exportTab,
      period: p,
      locked: run ? { at: run.lockedAt.toISOString(), by: run.lockedBy ? (lockedBy.get(run.lockedBy) ?? null) : null } : null,
    };
  });
  const grandAndCheck = runs.length ? assembleFromBlocks(blocks) : { grand: live.grand, mismatches: live.mismatches };
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
    anomalies: anomalies(blocks, settings),
    ft,
    weeks: weekBreakdowns(slices, staffIds, weeks, start, runShops, (id) => groupOf.get(id)?.shop ?? "Other shop"),
    locked: runs.length === 0 ? "none" : runs.length === inRun.length ? "all" : "some",
  };
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

/** Approve and lock every shop in the period at once. Refused while anything doesn't reconcile. */
export async function approveAndLock(start: LocalDate, end: LocalDate, actor: Actor): Promise<{ error: string; mismatches?: Mismatch[] } | { locked: number }> {
  const view = await buildPayroll(start, end);
  if (!view) return { error: "No shop has a pay period with those dates." };
  if (view.locked !== "none") return { error: "This pay period is already locked." };
  if (view.mismatches.length) return { error: "Totals don't reconcile, so the period can't be locked.", mismatches: view.mismatches };
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
    periodOf: (shopId, date) => periodOf(groupOf.get(shopId)?.calendar ?? DEFAULT_CALENDAR, date).start,
    locked: new Map(lockedRows.map((l) => [sliceKey({ ...l }), l.otCenti])),
  }).filter((s) => s.periodStart === start && runShops.has(s.shopId));

  return db.transaction(async (tx) => {
    let n = 0;
    for (const b of view.blocks) {
      const snapshot: Snapshot = { block: { shopId: b.shopId, shop: b.shop, lines: b.lines, totals: b.totals, exportRows: b.exportRows, exportHeaders: b.exportHeaders, exportFrom: b.exportFrom } };
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
        { payGroup: b.payGroup, periodStart: start, periodEnd: end, periodNumber: b.period.number, rows: b.lines.length, laborCost: b.totals.laborCost, service: b.totals.service },
        b.shopId,
        tx,
      );
      n++;
    }
    await lockPayrollTips(tx, view.blocks, start, end, actor);
    return { locked: n };
  });
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
  const f = { tab: row.tab, payGroup: row.label, periodNumber: row.run.periodNumber, periodStart: start, periodEnd: end, rows: block.exportRows, headers: block.exportHeaders };
  return { fileName: exporter.fileName(f), contentType: exporter.contentType, body: await exporter.render(f), runId: row.run.id, shopId: row.run.payGroupId };
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

export async function saveProfile(staffId: string, v: { employeeNumber: string | null; keyIsText: boolean; isolvedName: string | null; exportPosition: number | null }, actor: Actor): Promise<string | null> {
  const num = v.employeeNumber?.trim() || null;
  if (num && num.length > 32) return "That employee number is too long.";
  await db
    .insert(payrollProfiles)
    .values({ staffId, employeeNumber: num, keyIsText: v.keyIsText, isolvedName: v.isolvedName?.trim() || null, exportPosition: v.exportPosition })
    .onConflictDoUpdate({
      target: payrollProfiles.staffId,
      set: { employeeNumber: num, keyIsText: v.keyIsText, isolvedName: v.isolvedName?.trim() || null, exportPosition: v.exportPosition, updatedAt: new Date() },
    });
  // The number itself stays out of the audit trail.
  await audit(actor, "payroll.profile", "staff", staffId, { employeeNumberSet: !!num, keyIsText: v.keyIsText, exportPosition: v.exportPosition });
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
