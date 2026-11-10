import { LocalDate, addDays } from "@/lib/time";
import { quarterStart } from "./report-range";

/** Squire's analytics periods, as the report presets they are. */
export const ANALYTICS_PERIODS = [
  { id: "7d", label: "1W" },
  { id: "4w", label: "4W" },
  { id: "month", label: "MTD" },
  { id: "quarter", label: "QTD" },
  { id: "ytd", label: "YTD" },
] as const;

export const COMPARE_MODES = [
  { value: "prior", label: "Previous period" },
  { value: "year", label: "Same period last year" },
] as const;
export type CompareMode = (typeof COMPARE_MODES)[number]["value"];

const daysBetween = (a: LocalDate, b: LocalDate) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The same date a year earlier; Feb 29 becomes Feb 28. */
export function yearBefore(d: LocalDate): LocalDate {
  const [y, m, day] = d.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y - 1, m))).padStart(2, "0")}`;
}

/** The same day of the month a month earlier, capped at that month's last day. */
function monthBefore(d: LocalDate): LocalDate {
  const [y, m, day] = d.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(day, daysInMonth(py, pm))).padStart(2, "0")}`;
}

/**
 * What a range is compared with. Previous period: month to date against the same days of last
 * month, quarter to date against as many days into last quarter, year to date against the same
 * days last year, and anything else against as many days just before. Last year: the same dates.
 */
export function comparePeriod(from: LocalDate, to: LocalDate, preset: string | null, mode: CompareMode): { from: LocalDate; to: LocalDate } {
  if (mode === "year" || preset === "ytd") return { from: yearBefore(from), to: yearBefore(to) };
  if (preset === "month") return { from: monthBefore(from), to: monthBefore(to) };
  if (preset === "quarter") {
    const start = quarterStart(addDays(from, -1));
    const end = addDays(start, daysBetween(from, to));
    return { from: start, to: end < from ? end : addDays(from, -1) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Change from `before` to `now`, and as a share of `before` (null when there was nothing before). */
export function periodChange(now: number | null, before: number | null): { diff: number | null; pct: number | null } {
  if (now === null || before === null) return { diff: null, pct: null };
  return { diff: now - before, pct: before ? (now - before) / Math.abs(before) : null };
}
