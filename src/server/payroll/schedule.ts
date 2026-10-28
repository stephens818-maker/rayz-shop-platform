import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { payGroups, payPeriodDates, payrollRuns, paySchedulePeriods, shops } from "@/db/schema";
import { periodStarting, sameCalendar, sameDates, type PayCalendar } from "@/domain/payroll/calendar";
import { MAX_EXTENSION_PERIODS, extendSchedule, scheduleKey, scheduleProblems, type ScheduleRow } from "@/domain/payroll/pay-schedule";
import { diffDays, formatDate, isValidLocalDate, type LocalDate } from "@/lib/time";
import type { PayrollSettings } from "@/domain/payroll/calc";
import { audit, type Actor } from "../audit";
import { settingAt } from "../brand-sync/settings";
import { groupCalendar, resyncPeriodDates } from "./period-dates";

/** Who writes iSolved's schedule into the pay groups' period dates when it's loaded or extended. */
export const SCHEDULE_ACTOR: Actor = { staffId: null, label: "iSolved schedule" };

/** A pay group's part of iSolved's Payroll Run Schedule. */
export interface ScheduleSpan {
  /** As iSolved shows it, e.g. "B - Rock Island". */
  isolvedGroup: string;
  key: string;
  code: string | null;
  /** The first day of its first scheduled period, and the last day of its last. */
  from: LocalDate;
  through: LocalDate;
  periods: number;
  /** Periods an admin added past the end of iSolved's file. */
  added: number;
}

type SpanRow = ScheduleSpan & { groupId: string; stale: boolean };

/** One row per pay group and schedule group, so each pay group can be matched to its schedule in one read. */
async function spanRows(): Promise<SpanRow[]> {
  const s = paySchedulePeriods;
  return db
    .select({
      groupId: payGroups.id,
      key: s.groupKey,
      isolvedGroup: sql<string>`min(${s.isolvedGroup})`,
      code: sql<string | null>`max(${s.isolvedCode})`,
      from: sql<string>`min(${s.periodStart})::text`,
      through: sql<string>`max(${s.periodEnd})::text`,
      periods: sql<number>`count(*)::int`,
      added: sql<number>`(count(*) filter (where ${s.source} = 'admin'))::int`,
      // Compared in the database: created_at has microseconds, a JS Date only milliseconds.
      stale: sql<boolean>`max(${s.createdAt}) > coalesce(${payGroups.scheduleSyncedAt}, '-infinity'::timestamptz)`,
    })
    .from(payGroups)
    .innerJoin(s, sql`true`)
    .groupBy(payGroups.id, s.groupKey);
}

/** A pay group's schedule: by the shop's name (Le Claire is iSolved's LeClaire; "Ray'z Moline" is Moline), else by its iSolved code. */
function matchSpan<T extends { key: string; code: string | null }>(spans: readonly T[], g: { shop: string; code: string | null }): T | null {
  const key = scheduleKey(g.shop);
  const exact = spans.find((s) => s.key === key);
  if (exact) return exact;
  const ending = spans.filter((s) => key.endsWith(s.key));
  if (ending.length === 1) return ending[0];
  return g.code ? (spans.find((s) => s.code === g.code) ?? null) : null;
}

const toRow = (r: typeof paySchedulePeriods.$inferSelect): ScheduleRow => ({
  group: r.isolvedGroup,
  number: r.periodNumber,
  start: r.periodStart,
  end: r.periodEnd,
  runDate: r.runDate,
  checkDate: r.checkDate,
  note: r.note,
});

const reasonOf = (r: ScheduleRow) => (r.note ? `iSolved schedule: ${r.note}` : "iSolved schedule").slice(0, 200);

/** The run and check offsets most of a schedule's periods have (a holiday moves a few). */
function usualOffsets(rows: readonly ScheduleRow[]) {
  const mode = (f: (r: ScheduleRow) => number) => {
    const n = new Map<number, number>();
    for (const r of rows) n.set(f(r), (n.get(f(r)) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  };
  return { submitOffsetDays: mode((r) => diffDays(r.runDate, r.end)), checkOffsetDays: mode((r) => diffDays(r.checkDate, r.end)) };
}

/** Which of the rows the calendar (with the rows' own dates) doesn't number or end as iSolved does. */
function misaligned(cal: PayCalendar, rows: readonly ScheduleRow[]): ScheduleRow[] {
  const withDates: PayCalendar = { ...cal, dates: { ...cal.dates, ...Object.fromEntries(rows.map((r) => [r.start, { checkDate: r.checkDate, submitBy: r.runDate }])) } };
  return rows.filter((r) => {
    const p = periodStarting(withDates, r.start);
    return !p || p.end !== r.end || p.number !== r.number;
  });
}

/**
 * Writes the schedule rows a pay group hasn't taken yet into its period dates: iSolved's number,
 * check date and run date (the submit-by) for each period that isn't locked, with a reason where a
 * holiday moved them off the calendar's offsets. Gives the pay group iSolved's code when it has none.
 * If the pay group's calendar doesn't number the periods as iSolved does, it's realigned to the schedule.
 */
async function syncGroup(groupId: string, key: string, code: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [g] = await tx.select().from(payGroups).where(eq(payGroups.id, groupId)).for("update");
    if (!g) return;
    const rows = (
      await tx
        .select()
        .from(paySchedulePeriods)
        .where(and(eq(paySchedulePeriods.groupKey, key), gt(paySchedulePeriods.createdAt, sql`coalesce((select schedule_synced_at from pay_groups where id = ${g.id}), '-infinity'::timestamptz)`)))
        .orderBy(asc(paySchedulePeriods.periodStart))
    ).map(toRow);
    const all = (await tx.select().from(paySchedulePeriods).where(eq(paySchedulePeriods.groupKey, key)).orderBy(asc(paySchedulePeriods.periodStart))).map(toRow);
    let realigned: Pick<PayCalendar, "anchorStart" | "anchorNumber" | "checkOffsetDays" | "submitOffsetDays"> | null = null;
    let unaligned = 0;
    const cur = groupCalendar(g);
    if (all.length && misaligned(cur, all).length) {
      const first = all[0];
      const own: PayCalendar = { anchorStart: first.start, anchorNumber: first.number, periodDays: 14, numberResetsYearly: true, ...usualOffsets(all) };
      // The brand's calendar when it numbers them as iSolved does, so the shop stays on it with the others.
      const brand = (await settingAt<PayrollSettings>("payroll", null, tx)).calendar;
      const { dates: _d, scheduledThrough: _t, ...brandRule } = brand;
      const next = !misaligned(brandRule, all).length && brandRule.checkOffsetDays === own.checkOffsetDays && brandRule.submitOffsetDays === own.submitOffsetDays ? brandRule : own;
      const [hasRun] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.payGroupId, g.id)).limit(1);
      // A locked period's dates are part of the record: only its numbering may follow the schedule.
      if (hasRun && !sameDates(cur, next)) unaligned = misaligned(cur, all).length;
      else if (!sameCalendar(cur, next)) {
        await tx.update(payGroups).set({ ...next, updatedAt: new Date() }).where(eq(payGroups.id, g.id));
        realigned = { anchorStart: next.anchorStart, anchorNumber: next.anchorNumber, checkOffsetDays: next.checkOffsetDays, submitOffsetDays: next.submitOffsetDays };
      }
    }
    const cal: PayCalendar = realigned ? { ...cur, ...realigned, periodDays: 14, numberResetsYearly: true } : cur;
    const locked = new Set(
      rows.length
        ? (
            await tx
              .select({ s: payrollRuns.periodStart })
              .from(payrollRuns)
              .where(and(eq(payrollRuns.payGroupId, g.id), inArray(payrollRuns.periodStart, rows.map((r) => r.start))))
          ).map((r) => r.s)
        : [],
    );
    let moved = 0;
    for (const r of rows) {
      if (locked.has(r.start)) continue;
      const offsets = periodStarting(cal, r.start);
      const onOffsets = offsets?.checkDate === r.checkDate && offsets.submitBy === r.runDate;
      if (!onOffsets) moved++;
      const set = { periodEnd: r.end, periodNumber: r.number, checkDate: r.checkDate, submitBy: r.runDate, reason: onOffsets ? null : reasonOf(r), updatedBy: null, updatedAt: new Date() };
      await tx
        .insert(payPeriodDates)
        .values({ payGroupId: g.id, periodStart: r.start, ...set })
        .onConflictDoUpdate({ target: [payPeriodDates.payGroupId, payPeriodDates.periodStart], set });
    }
    if (realigned) await resyncPeriodDates(tx, g.id);
    let codeSet: string | null = null;
    if (code && !g.isolvedCode) {
      const [taken] = await tx.select({ id: payGroups.id }).from(payGroups).where(eq(payGroups.isolvedCode, code));
      if (!taken) {
        await tx.update(payGroups).set({ isolvedCode: code }).where(eq(payGroups.id, g.id));
        codeSet = code;
      }
    }
    await tx
      .update(payGroups)
      .set({ scheduleSyncedAt: sql`(select max(${paySchedulePeriods.createdAt}) from ${paySchedulePeriods} where ${paySchedulePeriods.groupKey} = ${key})` })
      .where(eq(payGroups.id, g.id));
    if (!rows.length && !realigned && !codeSet && !unaligned) return;
    await audit(
      SCHEDULE_ACTOR,
      "payroll.schedule_synced",
      "pay_group",
      g.id,
      {
        isolvedGroup: all[0]?.group ?? key,
        periods: rows.length,
        skippedLocked: rows.filter((r) => locked.has(r.start)).length,
        from: rows[0]?.start ?? null,
        through: rows.at(-1)?.end ?? null,
        datesMoved: moved,
        ...(codeSet ? { isolvedCode: codeSet } : {}),
        ...(unaligned ? { unaligned, why: "Its calendar has locked periods on other dates, so it wasn't moved to the schedule's." } : {}),
        ...(realigned ? { realigned: { from: { anchorStart: cur.anchorStart, anchorNumber: cur.anchorNumber, checkOffsetDays: cur.checkOffsetDays, submitOffsetDays: cur.submitOffsetDays }, to: realigned } } : {}),
      },
      g.shopId,
      tx,
    );
  });
}

/**
 * Brings every pay group up to date with iSolved's schedule (the seed, and any periods an admin
 * added since), and returns each pay group's schedule span by pay group id. Cheap when nothing is new.
 */
export async function syncPaySchedule(groups: readonly { id: string; shop: string; code: string | null }[]): Promise<{ spans: Map<string, ScheduleSpan>; synced: boolean }> {
  const rows = await spanRows();
  const spans = new Map<string, ScheduleSpan>();
  let synced = false;
  for (const g of groups) {
    const span = matchSpan(
      rows.filter((r) => r.groupId === g.id),
      g,
    );
    if (!span) continue;
    if (span.stale) {
      await syncGroup(g.id, span.key, span.code);
      synced = true;
    }
    const { groupId: _id, stale: _stale, ...rest } = span;
    spans.set(g.id, rest);
  }
  return { spans, synced };
}

/**
 * Adds periods past the end of a pay group's iSolved schedule, on its pattern (14 days, run and check
 * on the calendar's offsets), through the period holding `through`: at most a year at a time. Each
 * pay group picked is extended; groups sharing a calendar are extended together by picking them all.
 * Holidays aren't known ahead, so a moved run or check is set on Pay period dates once iSolved posts it.
 */
export async function extendPaySchedule(payGroupIds: readonly string[], through: LocalDate, actor: Actor): Promise<string | null> {
  if (!payGroupIds.length) return "Pick the pay groups to extend.";
  if (!isValidLocalDate(through)) return "Pick the last day to schedule through.";
  const groups = await db
    .select({ id: payGroups.id, shopId: payGroups.shopId, shop: shops.name, label: payGroups.label, code: payGroups.isolvedCode, checkOffsetDays: payGroups.checkOffsetDays, submitOffsetDays: payGroups.submitOffsetDays })
    .from(payGroups)
    .innerJoin(shops, eq(shops.id, payGroups.shopId))
    .where(inArray(payGroups.id, [...payGroupIds]));
  if (groups.length !== new Set(payGroupIds).size) return "A pay group picked is gone.";
  const spans = await spanRows();
  const plans: { g: (typeof groups)[number]; span: SpanRow; add: ScheduleRow[] }[] = [];
  for (const g of groups) {
    const span = matchSpan(
      spans.filter((s) => s.groupId === g.id),
      g,
    );
    if (!span) return `${g.label} has no iSolved pay schedule to extend.`;
    if (plans.some((p) => p.span.key === span.key)) continue;
    const have = (await db.select().from(paySchedulePeriods).where(eq(paySchedulePeriods.groupKey, span.key)).orderBy(asc(paySchedulePeriods.periodStart))).map(toRow);
    const add = extendSchedule(have.at(-1)!, through, { runOffsetDays: g.submitOffsetDays, checkOffsetDays: g.checkOffsetDays });
    if (!add.length) return `${g.label}'s schedule already runs through ${formatDate(span.through, "EEE MMM d, yyyy")}. Pick a later day to schedule through.`;
    const problems = scheduleProblems([...have, ...add]);
    if (problems.length) return `${g.label}'s schedule can't be extended: ${problems[0]}`;
    plans.push({ g, span, add });
  }
  await db.transaction(async (tx) => {
    for (const { g, span, add } of plans) {
      await tx.insert(paySchedulePeriods).values(
        add.map((r) => ({
          isolvedGroup: r.group,
          groupKey: span.key,
          isolvedCode: span.code,
          periodNumber: r.number,
          periodStart: r.start,
          periodEnd: r.end,
          runDate: r.runDate,
          checkDate: r.checkDate,
          source: "admin",
          addedBy: actor.staffId ?? null,
        })),
      );
      await audit(
        actor,
        "payroll.schedule_extended",
        "pay_group",
        g.id,
        { isolvedGroup: span.isolvedGroup, periods: add.length, from: add[0].start, through: add.at(-1)!.end, numbers: `${add[0].number}–${add.at(-1)!.number}`, capped: add.length === MAX_EXTENSION_PERIODS },
        g.shopId,
        tx,
      );
    }
  });
  const all = await db.select({ id: payGroups.id, shop: shops.name, code: payGroups.isolvedCode }).from(payGroups).innerJoin(shops, eq(shops.id, payGroups.shopId));
  await syncPaySchedule(all);
  return null;
}
