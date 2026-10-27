import { DateTime } from "luxon";

/** Every shop operates on Chicago time. All wall-clock math must go through these helpers. */
export const SHOP_TZ = "America/Chicago";

export type LocalDate = string; // YYYY-MM-DD in SHOP_TZ

/** ISO strings, or Postgres timestamptz text ("2026-10-01 17:00:00.123+00") from raw SQL rows. */
function fromText(s: string): DateTime {
  const iso = DateTime.fromISO(s, { setZone: true });
  return iso.isValid ? iso : DateTime.fromSQL(s, { setZone: true });
}

export function toZoned(instant: Date | number | string): DateTime {
  const dt = typeof instant === "string" ? fromText(instant) : DateTime.fromMillis(typeof instant === "number" ? instant : instant.getTime());
  return dt.setZone(SHOP_TZ);
}

/** Local wall-clock time (minutes after local midnight) on a local date → absolute DateTime. */
export function zonedWallTime(date: LocalDate, minutesAfterMidnight: number): DateTime {
  const day = DateTime.fromISO(date, { zone: SHOP_TZ }).startOf("day");
  const hour = Math.floor(minutesAfterMidnight / 60);
  const minute = minutesAfterMidnight % 60;
  if (hour >= 24) return day.plus({ days: 1 }).set({ hour: hour - 24, minute });
  return day.set({ hour, minute });
}

/** Like zonedWallTime, but null for a time that doesn't exist (the hour skipped when clocks spring forward). */
export function existingWallTime(date: LocalDate, minutesAfterMidnight: number): DateTime | null {
  const dt = zonedWallTime(date, minutesAfterMidnight);
  return dt.hour * 60 + dt.minute === minutesAfterMidnight % (24 * 60) ? dt : null;
}

export function startOfLocalDay(date: LocalDate): Date {
  return DateTime.fromISO(date, { zone: SHOP_TZ }).startOf("day").toJSDate();
}

/** Exclusive end of the local day (= start of the next local day). Handles 23h/25h DST days. */
export function endOfLocalDay(date: LocalDate): Date {
  return DateTime.fromISO(date, { zone: SHOP_TZ }).startOf("day").plus({ days: 1 }).toJSDate();
}

export function localDateOf(instant: Date | number | string): LocalDate {
  return toZoned(instant).toISODate()!;
}

export function todayLocal(now: Date = new Date()): LocalDate {
  return localDateOf(now);
}

/** 0 = Sunday … 6 = Saturday (JS convention, used in the DB). */
export function weekdayOf(date: LocalDate): number {
  return DateTime.fromISO(date, { zone: SHOP_TZ }).weekday % 7;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return DateTime.fromISO(date, { zone: SHOP_TZ }).plus({ days }).toISODate()!;
}

export function diffDays(a: LocalDate, b: LocalDate): number {
  const da = DateTime.fromISO(a, { zone: "UTC" });
  const db = DateTime.fromISO(b, { zone: "UTC" });
  return Math.round(da.diff(db, "days").days);
}

export function isValidLocalDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/**
 * How times of day read: "12h" is 9:05 AM and 5:30 PM (the brand default), "24h" is 09:05 and 17:30.
 * Times are stored as UTC instants and shown in the shop's zone; this only changes how they read.
 */
export type ClockFormat = "12h" | "24h";
export const CLOCK_FORMATS: readonly ClockFormat[] = ["12h", "24h"];
export const CLOCK_FORMAT_LABEL: Record<ClockFormat, string> = { "12h": "12-hour, with AM and PM (9:05 AM, 5:30 PM)", "24h": "24-hour (09:05, 17:30)" };

// On globalThis, not in a module variable: the server bundles this module more than once (server
// components, client components, route handlers), and the brand setting has to reach all of them.
const CLOCK_KEY = "__rayzClockFormat";
type ClockGlobal = { [CLOCK_KEY]?: ClockFormat };

export function clockFormat(): ClockFormat {
  return (globalThis as ClockGlobal)[CLOCK_KEY] === "24h" ? "24h" : "12h";
}

export function setClockFormat(f: ClockFormat): void {
  (globalThis as ClockGlobal)[CLOCK_KEY] = f === "24h" ? "24h" : "12h";
}

/** The Luxon pattern for a time of day in the brand's format. */
export function timePattern(f: ClockFormat = clockFormat()): string {
  return f === "24h" ? "HH:mm" : "h:mm a";
}

/** A Luxon DateTime's time of day in the brand's format, in whatever zone it's set to. */
export function formatClock(dt: DateTime, f: ClockFormat = clockFormat()): string {
  return dt.toFormat(timePattern(f));
}

export function formatTime(instant: Date | number | string): string {
  return formatClock(toZoned(instant));
}

/** A local date ("2026-10-21") as that day; an instant (Date, or a timestamp string) as its day in the shop's zone. */
export function formatDate(date: LocalDate | Date | string, fmt = "EEE, MMM d"): string {
  const dt = typeof date === "string" && date.length === 10 ? DateTime.fromISO(date, { zone: SHOP_TZ }) : toZoned(date);
  return dt.toFormat(fmt);
}

/** An instant's date and time in the shop's zone: "Tue, Oct 27 · 2:05 PM". */
export function formatDateTime(instant: Date | number | string, dateFmt = "EEE, MMM d", sep = " · "): string {
  const z = toZoned(instant);
  return `${z.toFormat(dateFmt)}${sep}${formatClock(z)}`;
}

/** A time of day from minutes after midnight: "9:05 AM" (or "09:05" on the 24-hour setting). Past midnight wraps. */
export function minutesToLabel(min: number, f: ClockFormat = clockFormat()): string {
  const h = Math.floor(min / 60) % 24;
  const m = (min % 60).toString().padStart(2, "0");
  if (f === "24h") return `${h.toString().padStart(2, "0")}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

/** "HH:mm" (a time input's or a stored quiet-hours value) as it reads: "9:05 PM". Anything else comes back as is. */
export function hhmmLabel(s: string | null | undefined, f: ClockFormat = clockFormat()): string {
  if (!s || !/^\d{1,2}:\d{2}/.test(s)) return s ?? "";
  return minutesToLabel(hhmmToMinutes(s), f);
}

/** "2026-10-27 14:05" (a local timestamp from SQL) as it reads: "Oct 27, 2026 2:05 PM". Anything else comes back as is. */
export function localStampLabel(s: string, dateFmt = "MMM d, yyyy", f: ClockFormat = clockFormat()): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return s;
  return `${DateTime.fromISO(m[1]).toFormat(dateFmt)} ${minutesToLabel(hhmmToMinutes(m[2]), f)}`;
}

export function minutesToHHMM(min: number): string {
  return `${Math.floor(min / 60).toString().padStart(2, "0")}:${(min % 60).toString().padStart(2, "0")}`;
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Minutes after local midnight for an instant (used to place blocks on the day calendar). */
export function localMinutesOf(instant: Date | number | string): number {
  const z = toZoned(instant);
  return z.hour * 60 + z.minute;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
