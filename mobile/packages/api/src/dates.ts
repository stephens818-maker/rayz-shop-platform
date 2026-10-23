/**
 * Civil dates in America/Chicago. Arithmetic stays on the YYYY-MM-DD calendar
 * so daylight saving never shifts a day.
 *
 * Payroll periods match the shop platform: bi-weekly, Sunday–Saturday, anchored
 * on Saturday 2026-10-03.
 * Overtime workweeks are Monday–Sunday, so a week can post hours into two periods.
 */

export const PAYROLL_ANCHOR_END = "2026-10-03";
export const PERIOD_DAYS = 14;
export const TIME_ZONE = "America/Chicago";

export type RangePreset = "current_period" | "last_period" | "this_week" | "last_week" | "month_to_date" | "custom";

export interface DateRange {
  from: string;
  to: string;
}

export interface SavedRange {
  preset: RangePreset;
  from: string;
  to: string;
}

const PRESETS: RangePreset[] = ["current_period", "last_period", "this_week", "last_week", "month_to_date", "custom"];

export function isPreset(value: string): value is RangePreset {
  return (PRESETS as string[]).includes(value);
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 0 = Sunday … 6 = Saturday, for a civil date. */
export function weekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function diffDays(later: string, earlier: string): number {
  const [y1, m1, d1] = later.split("-").map(Number);
  const [y2, m2, d2] = earlier.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((a - b) / 86_400_000);
}

export function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

export function clampRange(from: string, to: string, boundFrom: string, boundTo: string): DateRange | null {
  const start = maxDate(from, boundFrom);
  const end = minDate(to, boundTo);
  if (start > end) return null;
  return { from: start, to: end };
}

/** Monday–Sunday workweek that contains `iso`. */
export function workweekContaining(iso: string): DateRange {
  const dow = weekday(iso);
  const sinceMonday = dow === 0 ? 6 : dow - 1;
  const from = addDays(iso, -sinceMonday);
  return { from, to: addDays(from, 6) };
}

export function weekCovers(week: DateRange, range: DateRange): "full" | "partial" | "none" {
  if (!rangesOverlap(week.from, week.to, range.from, range.to)) return "none";
  if (week.from >= range.from && week.to <= range.to) return "full";
  return "partial";
}

export interface PayPeriod {
  id: string;
  start: string;
  end: string;
  index: number;
}

export function payPeriodByIndex(index: number, anchorEnd = PAYROLL_ANCHOR_END): PayPeriod {
  const end = addDays(anchorEnd, index * PERIOD_DAYS);
  const start = addDays(end, -(PERIOD_DAYS - 1));
  return { id: start, start, end, index };
}

export function payPeriodFor(date: string, anchorEnd = PAYROLL_ANCHOR_END): PayPeriod {
  if (weekday(anchorEnd) !== 6) throw new Error("Payroll anchor must be a Saturday");
  const offset = diffDays(date, anchorEnd);
  const index = Math.ceil(offset / PERIOD_DAYS) || 0;
  return payPeriodByIndex(index, anchorEnd);
}

export function payPeriodsOverlapping(from: string, to: string, anchorEnd = PAYROLL_ANCHOR_END): PayPeriod[] {
  const first = payPeriodFor(from, anchorEnd).index;
  const last = payPeriodFor(to, anchorEnd).index;
  const out: PayPeriod[] = [];
  for (let i = first; i <= last; i++) out.push(payPeriodByIndex(i, anchorEnd));
  return out;
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function rangeForPreset(preset: Exclude<RangePreset, "custom">, today: string): DateRange {
  if (!isDate(today)) throw new Error("today must be YYYY-MM-DD");
  if (preset === "current_period") {
    const p = payPeriodFor(today);
    return { from: p.start, to: p.end };
  }
  if (preset === "last_period") {
    const p = payPeriodByIndex(payPeriodFor(today).index - 1);
    return { from: p.start, to: p.end };
  }
  if (preset === "this_week") return workweekContaining(today);
  if (preset === "last_week") {
    const current = workweekContaining(today);
    return workweekContaining(addDays(current.from, -1));
  }
  return { from: monthStart(today), to: today };
}

/** Presets recompute from today. A custom range keeps the dates the employee picked. */
export function resolveSavedRange(saved: SavedRange | null, today: string): SavedRange {
  if (!saved || saved.preset === "custom") {
    if (saved?.preset === "custom" && isDate(saved.from) && isDate(saved.to)) {
      const from = minDate(saved.from, saved.to);
      const to = maxDate(saved.from, saved.to);
      return { preset: "custom", from, to };
    }
    const current = rangeForPreset("current_period", today);
    return { preset: "current_period", ...current };
  }
  return { preset: saved.preset, ...rangeForPreset(saved.preset, today) };
}

export function formatLongDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatClock(isoInstant: string, locale: string, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(new Date(isoInstant));
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
