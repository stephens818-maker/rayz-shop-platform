import { DateTime } from "luxon";
import { LocalDate, SHOP_TZ, addDays, diffDays, endOfLocalDay, isValidLocalDate, startOfLocalDay, weekdayOf } from "@/lib/time";

/**
 * One pay group's calendar. In iSolved each shop is a pay group with its own calendar: bi-weekly,
 * Sun–Sat, submitted by the Wednesday and paid on the Friday after the period ends. Dubuque runs on a
 * separate calendar from the other shops, so calendars belong to pay groups, never to the brand.
 */
export interface PayCalendar {
  /** The first day (a Sunday) of a known period. */
  anchorStart: LocalDate;
  /** That period's number in iSolved (e.g. 23). */
  anchorNumber: number;
  periodDays: number;
  /** Days from the period's last day to its check date (6 = the Friday after a Saturday). */
  checkOffsetDays: number;
  /** Days from the period's last day to iSolved's submission deadline (4 = the Wednesday after a Saturday). */
  submitOffsetDays: number;
  /** iSolved numbers periods per check-date year: the first check of a new year is period 1. */
  numberResetsYearly: boolean;
  /** Each period's stored dates, by its first day, where they differ from the offsets (a holiday moved the check). */
  dates?: Readonly<Record<LocalDate, PeriodDates>>;
}

export interface PeriodDates {
  checkDate: LocalDate;
  submitBy: LocalDate;
}

export interface CalendarPeriod {
  index: number;
  number: number;
  start: LocalDate;
  end: LocalDate;
  checkDate: LocalDate;
  /** The day the hours are due in iSolved. */
  submitBy: LocalDate;
  /** The check or submit-by date was moved by hand from the calendar's offsets. */
  datesMoved: boolean;
  startsAt: Date;
  /** Exclusive: local midnight after `end`. */
  endsAt: Date;
}

/**
 * Until the brand saves its own (Payroll setup, the payroll setting's calendar), iSolved's: bi-weekly
 * Sun–Sat, period 22 = 10/4–10/17/2026, submitted by Wednesday 10/21, check Friday 10/23.
 */
export const DEFAULT_BRAND_CALENDAR: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 22, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };

export const sameCalendar = (a: PayCalendar, b: PayCalendar) =>
  a.anchorStart === b.anchorStart &&
  a.anchorNumber === b.anchorNumber &&
  a.periodDays === b.periodDays &&
  a.checkOffsetDays === b.checkOffsetDays &&
  a.submitOffsetDays === b.submitOffsetDays &&
  a.numberResetsYearly === b.numberResetsYearly;

/** Both calendars start and end their periods on the same days (they may number them differently). */
export const sameDates = (a: Pick<PayCalendar, "anchorStart" | "periodDays">, b: Pick<PayCalendar, "anchorStart" | "periodDays">) =>
  a.periodDays === b.periodDays && ((diffDays(a.anchorStart, b.anchorStart) % a.periodDays) + a.periodDays) % a.periodDays === 0;

export function calendarProblem(c: PayCalendar): string | null {
  if (!isValidLocalDate(c.anchorStart)) return "Pick the first day of a known pay period.";
  if (c.periodDays !== 7 && c.periodDays !== 14) return "Pay periods are weekly or bi-weekly.";
  // I2: a period that starts mid-workweek would split a week's overtime (and its regular rate) across two runs.
  if (weekdayOf(c.anchorStart) !== 0) return "Pay periods run Sunday to Saturday, the workweek overtime is counted on; the first day must be a Sunday.";
  if (!Number.isInteger(c.anchorNumber) || c.anchorNumber < 1) return "The period number is a whole number from 1.";
  if (!Number.isInteger(c.checkOffsetDays) || c.checkOffsetDays < 0 || c.checkOffsetDays > 31) return "The check date is 0 to 31 days after the period ends.";
  if (!Number.isInteger(c.submitOffsetDays) || c.submitOffsetDays < 0 || c.submitOffsetDays > c.checkOffsetDays) return "Hours are due in iSolved on or after the period's last day, and no later than the check date.";
  return null;
}

/** A period's own check and submit-by dates: due once the period has ended, no later than the check. */
export function periodDatesProblem(p: { end: LocalDate; checkDate: LocalDate; submitBy: LocalDate }): string | null {
  if (!isValidLocalDate(p.checkDate) || !isValidLocalDate(p.submitBy)) return "Pick both dates.";
  if (p.submitBy < p.end) return "Hours can't be due in iSolved before the period's last day.";
  if (p.checkDate < p.submitBy) return "The check date can't be before the submit-by date.";
  if (diffDays(p.checkDate, p.end) > 31) return "The check date is at most 31 days after the period ends.";
  return null;
}

const yearOf = (d: LocalDate) => Number(d.slice(0, 4));

// Calendar dates as whole UTC days: periods are walked many times per page, and a date has no time zone.
const DAY_MS = 86_400_000;
const dayOf = (d: LocalDate) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number): LocalDate => new Date(day * DAY_MS).toISOString().slice(0, 10);

function raw(c: PayCalendar, index: number) {
  const startDay = dayOf(c.anchorStart) + index * c.periodDays;
  const endDay = startDay + c.periodDays - 1;
  const start = dateOf(startDay);
  const end = dateOf(endDay);
  const checkDate = dateOf(endDay + c.checkOffsetDays);
  const submitBy = dateOf(endDay + c.submitOffsetDays);
  const stored = c.dates?.[start];
  const moved = !!stored && (stored.checkDate !== checkDate || stored.submitBy !== submitBy);
  return { start, end, checkDate: stored?.checkDate ?? checkDate, submitBy: stored?.submitBy ?? submitBy, datesMoved: moved };
}

/** iSolved numbers by the year of the check date actually paid, so a check moved into January starts the new year. */
function numberOf(c: PayCalendar, index: number, checkDate: LocalDate): number {
  if (!c.numberResetsYearly) return c.anchorNumber + index;
  const anchorYear = yearOf(raw(c, 0).checkDate);
  const year = yearOf(checkDate);
  if (year === anchorYear) return c.anchorNumber + index;
  // Starts a few periods past the year's first check by the offsets, so a check moved across New Year's is still found.
  const toFirstCheck = dayOf(`${year}-01-01`) - dayOf(c.anchorStart) - (c.periodDays - 1 + c.checkOffsetDays);
  let first = Math.min(index, Math.ceil(toFirstCheck / c.periodDays) + 3);
  while (yearOf(raw(c, first - 1).checkDate) === year) first--;
  return index - first + 1;
}

export function periodByIndex(c: PayCalendar, index: number): CalendarPeriod {
  const r = raw(c, index);
  return { index, number: numberOf(c, index, r.checkDate), ...r, startsAt: startOfLocalDay(r.start), endsAt: endOfLocalDay(r.end) };
}

export function periodOf(c: PayCalendar, date: LocalDate): CalendarPeriod {
  return periodByIndex(c, Math.floor((dayOf(date) - dayOf(c.anchorStart)) / c.periodDays));
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
