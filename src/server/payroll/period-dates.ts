import { and, eq, inArray } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { payGroups, payPeriodDates, payrollRuns } from "@/db/schema";
import { periodByIndex, periodDatesProblem, periodOf, periodStarting, type PayCalendar, type PeriodDates } from "@/domain/payroll/calendar";
import { todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "../audit";

type PayGroupRow = typeof payGroups.$inferSelect;
type DatesRow = typeof payPeriodDates.$inferSelect;

/** A pay group's calendar from its row, with its periods' stored dates when given. */
export const groupCalendar = (g: PayGroupRow, dates?: PayCalendar["dates"]): PayCalendar => ({
  anchorStart: g.anchorStart,
  anchorNumber: g.anchorNumber,
  periodDays: g.periodDays,
  checkOffsetDays: g.checkOffsetDays,
  submitOffsetDays: g.submitOffsetDays,
  numberResetsYearly: g.numberResetsYearly,
  ...(dates ? { dates } : {}),
});

/** Periods written ahead of time: about four months back and six ahead, so the upcoming check and submit-by dates are on record. */
const BACK = 8;
const AHEAD = 13;

const datesOf = (rows: readonly Pick<DatesRow, "periodStart" | "checkDate" | "submitBy">[]): Record<LocalDate, PeriodDates> =>
  Object.fromEntries(rows.map((r) => [r.periodStart, { checkDate: r.checkDate, submitBy: r.submitBy }]));

function calendarRows(g: PayGroupRow, cal: PayCalendar, today: LocalDate) {
  const cur = periodOf(cal, today).index;
  const out: (typeof payPeriodDates.$inferInsert)[] = [];
  for (let i = cur - BACK; i <= cur + AHEAD; i++) {
    const p = periodByIndex(cal, i);
    if (p.number < 1) continue;
    out.push({ payGroupId: g.id, periodStart: p.start, periodEnd: p.end, periodNumber: p.number, checkDate: p.checkDate, submitBy: p.submitBy });
  }
  return out;
}

/**
 * Each pay group's stored period dates, by period start. Periods around today that have none yet are
 * written from the calendar first, so every upcoming period's check and submit-by date is on record.
 */
export async function storedPeriodDates(groups: readonly PayGroupRow[], today: LocalDate = todayLocal(), tx: DBorTx = db): Promise<Map<string, Record<LocalDate, PeriodDates>>> {
  if (!groups.length) return new Map();
  const rows = await tx
    .select({ payGroupId: payPeriodDates.payGroupId, periodStart: payPeriodDates.periodStart, checkDate: payPeriodDates.checkDate, submitBy: payPeriodDates.submitBy })
    .from(payPeriodDates)
    .where(inArray(payPeriodDates.payGroupId, groups.map((g) => g.id)));
  const have = new Set(rows.map((r) => `${r.payGroupId}|${r.periodStart}`));
  const missing = groups.flatMap((g) => calendarRows(g, groupCalendar(g, datesOf(rows.filter((r) => r.payGroupId === g.id))), today)).filter((r) => !have.has(`${r.payGroupId}|${r.periodStart}`));
  if (missing.length) {
    await tx.insert(payPeriodDates).values(missing).onConflictDoNothing();
    rows.push(...missing.map((m) => ({ payGroupId: m.payGroupId, periodStart: m.periodStart, checkDate: m.checkDate, submitBy: m.submitBy })));
  }
  return new Map(groups.map((g) => [g.id, datesOf(rows.filter((r) => r.payGroupId === g.id))]));
}

/**
 * After a pay group's calendar changes: the calendar's own rows of unlocked periods are dropped (they're
 * written again from the new offsets), a moved period keeps its dates if it's still a period, and
 * every row takes the new numbering.
 */
export async function resyncPeriodDates(tx: DBorTx, groupId: string): Promise<void> {
  const [g] = await tx.select().from(payGroups).where(eq(payGroups.id, groupId));
  if (!g) return;
  const rows = await tx.select().from(payPeriodDates).where(eq(payPeriodDates.payGroupId, groupId));
  const locked = new Set((await tx.select({ s: payrollRuns.periodStart }).from(payrollRuns).where(eq(payrollRuns.payGroupId, groupId))).map((r) => r.s));
  const cal = groupCalendar(g, datesOf(rows.filter((r) => r.reason || locked.has(r.periodStart))));
  for (const r of rows) {
    const p = periodStarting(cal, r.periodStart);
    if (!p || (!r.reason && !locked.has(r.periodStart))) await tx.delete(payPeriodDates).where(eq(payPeriodDates.id, r.id));
    else if (p.number !== r.periodNumber || p.end !== r.periodEnd) await tx.update(payPeriodDates).set({ periodNumber: p.number, periodEnd: p.end }).where(eq(payPeriodDates.id, r.id));
  }
}

/**
 * Moves a period's check date or submit-by date (a holiday, or iSolved's calendar says otherwise), for
 * every pay group with that period, with a reason. Dates equal to the calendar's offsets put it back.
 * Refused once any of those pay groups has locked the period: its check date is part of the record.
 */
export async function savePeriodDates(
  start: LocalDate,
  end: LocalDate,
  v: { checkDate: LocalDate; submitBy: LocalDate; reason: string },
  groups: readonly { id: string; shopId: string; calendar: PayCalendar }[],
  actor: Actor,
): Promise<string | null> {
  const reason = v.reason.trim();
  const targets = groups.map((g) => ({ g, p: periodStarting(g.calendar, start) })).filter((x) => x.p?.end === end);
  if (!targets.length) return "No pay group has that pay period.";
  const problem = periodDatesProblem({ end, checkDate: v.checkDate, submitBy: v.submitBy });
  if (problem) return problem;
  const [lock] = await db
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(inArray(payrollRuns.payGroupId, targets.map((t) => t.g.id)), eq(payrollRuns.periodStart, start)))
    .limit(1);
  if (lock) return "This pay period is locked, so its check date is part of the record.";
  const offsets = (c: PayCalendar) => periodStarting({ ...c, dates: undefined }, start)!;
  const backToCalendar = targets.every(({ g }) => offsets(g.calendar).checkDate === v.checkDate && offsets(g.calendar).submitBy === v.submitBy);
  if (!backToCalendar && reason.length < 3) return "Say why the dates moved (for example, a holiday).";
  if (reason.length > 200) return "Keep the reason under 200 characters.";
  await db.transaction(async (tx) => {
    for (const { g, p } of targets) {
      const row = { checkDate: v.checkDate, submitBy: v.submitBy, reason: backToCalendar ? null : reason, updatedBy: actor.staffId ?? null, updatedAt: new Date() };
      await tx
        .insert(payPeriodDates)
        .values({ payGroupId: g.id, periodStart: start, periodEnd: end, periodNumber: p!.number, ...row })
        .onConflictDoUpdate({ target: [payPeriodDates.payGroupId, payPeriodDates.periodStart], set: row });
    }
    const was = targets[0].p!;
    await audit(
      actor,
      "payroll.period_dates",
      "pay_period",
      null,
      { periodStart: start, periodEnd: end, from: { checkDate: was.checkDate, submitBy: was.submitBy }, to: { checkDate: v.checkDate, submitBy: v.submitBy }, reason: backToCalendar ? "Back to the calendar's dates" : reason, payGroups: targets.length },
      null,
      tx,
    );
  });
  return null;
}
