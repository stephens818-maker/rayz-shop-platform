import { DateTime } from "luxon";
import { LocalDate, SHOP_TZ, addDays, diffDays, endOfLocalDay, startOfLocalDay, weekdayOf } from "@/lib/time";

/**
 * One pay group's calendar. In iSolved each shop is a pay group with its own calendar: bi-weekly,
 * Sun–Sat, checks on the Friday after the period ends. Dubuque runs on a separate calendar from the
 * other shops, so calendars belong to pay groups, never to the brand.
 */
export interface PayCalendar {
  /** The first day (a Sunday) of a known period. */
  anchorStart: LocalDate;
  /** That period's number in iSolved (e.g. 23). */
  anchorNumber: number;
  periodDays: number;
  /** Days from the period's last day to its check date (6 = the Friday after a Saturday). */
  checkOffsetDays: number;
  /** iSolved numbers periods per check-date year: the first check of a new year is period 1. */
  numberResetsYearly: boolean;
}

export interface CalendarPeriod {
  index: number;
  number: number;
  start: LocalDate;
  end: LocalDate;
  checkDate: LocalDate;
  startsAt: Date;
  /** Exclusive: local midnight after `end`. */
  endsAt: Date;
}

/** Until the brand saves its own (Payroll setup, the payroll setting's calendar): period 23 = 10/18–10/31/2026. */
export const DEFAULT_BRAND_CALENDAR: PayCalendar = { anchorStart: "2026-10-18", anchorNumber: 23, periodDays: 14, checkOffsetDays: 6, numberResetsYearly: true };

export const sameCalendar = (a: PayCalendar, b: PayCalendar) =>
  a.anchorStart === b.anchorStart && a.anchorNumber === b.anchorNumber && a.periodDays === b.periodDays && a.checkOffsetDays === b.checkOffsetDays && a.numberResetsYearly === b.numberResetsYearly;

/** Both calendars start and end their periods on the same days (they may number them differently). */
export const sameDates = (a: Pick<PayCalendar, "anchorStart" | "periodDays">, b: Pick<PayCalendar, "anchorStart" | "periodDays">) =>
  a.periodDays === b.periodDays && ((diffDays(a.anchorStart, b.anchorStart) % a.periodDays) + a.periodDays) % a.periodDays === 0;

export function calendarProblem(c: PayCalendar): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.anchorStart)) return "Pick the first day of a known pay period.";
  if (c.periodDays !== 7 && c.periodDays !== 14) return "Pay periods are weekly or bi-weekly.";
  if (c.periodDays === 14 && weekdayOf(c.anchorStart) !== 0) return "Bi-weekly periods run Sunday to Saturday; the first day must be a Sunday.";
  if (!Number.isInteger(c.anchorNumber) || c.anchorNumber < 1) return "The period number is a whole number from 1.";
  if (!Number.isInteger(c.checkOffsetDays) || c.checkOffsetDays < 0 || c.checkOffsetDays > 31) return "The check date is 0 to 31 days after the period ends.";
  return null;
}

const yearOf = (d: LocalDate) => Number(d.slice(0, 4));

function raw(c: PayCalendar, index: number) {
  const start = addDays(c.anchorStart, index * c.periodDays);
  const end = addDays(start, c.periodDays - 1);
  return { start, end, checkDate: addDays(end, c.checkOffsetDays) };
}

function numberOf(c: PayCalendar, index: number, checkDate: LocalDate): number {
  if (!c.numberResetsYearly) return c.anchorNumber + index;
  const anchorYear = yearOf(raw(c, 0).checkDate);
  const year = yearOf(checkDate);
  if (year === anchorYear) return c.anchorNumber + index;
  let first = index;
  while (yearOf(raw(c, first - 1).checkDate) === year) first--;
  return index - first + 1;
}

export function periodByIndex(c: PayCalendar, index: number): CalendarPeriod {
  const r = raw(c, index);
  return { index, number: numberOf(c, index, r.checkDate), ...r, startsAt: startOfLocalDay(r.start), endsAt: endOfLocalDay(r.end) };
}

export function periodOf(c: PayCalendar, date: LocalDate): CalendarPeriod {
  return periodByIndex(c, Math.floor(diffDays(date, c.anchorStart) / c.periodDays));
}

export function periodStarting(c: PayCalendar, start: LocalDate): CalendarPeriod | null {
  const p = periodOf(c, start);
  return p.start === start ? p : null;
}

/** Periods from `before` back to `after` ahead of the one holding `today`, newest first. */
export function periodsAround(c: PayCalendar, today: LocalDate, before = 6, after = 1): CalendarPeriod[] {
  const cur = periodOf(c, today).index;
  const out: CalendarPeriod[] = [];
  for (let i = cur + after; i >= cur - before; i--) out.push(periodByIndex(c, i));
  return out;
}

/** The Sun–Sat workweeks (their Sundays) that overlap a period, so OT can see the whole week. */
export function workweeksOf(p: Pick<CalendarPeriod, "start" | "end">): LocalDate[] {
  const first = DateTime.fromISO(p.start, { zone: SHOP_TZ });
  let sun = first.minus({ days: first.weekday % 7 }).toISODate()!;
  const out: LocalDate[] = [];
  while (sun <= p.end) {
    out.push(sun);
    sun = addDays(sun, 7);
  }
  return out;
}
