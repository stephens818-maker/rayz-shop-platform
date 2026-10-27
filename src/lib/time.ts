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
 * How times of day read, the brand setting `time_format`: "12h" is 9:05 AM and 5:30 PM (the default),
 * "24h" is 09:05 and 17:30. Times are stored as UTC instants and shown in the shop's zone.
 */
export type TimeFormat = "12h" | "24h";
export const TIME_FORMATS: readonly TimeFormat[] = ["12h", "24h"];
export const TIME_FORMAT_LABEL: Record<TimeFormat, string> = { "12h": "12-hour, with AM and PM (9:05 AM, 5:30 PM)", "24h": "24-hour (09:05, 17:30)" };

// On globalThis, not in a module variable: the server bundles this module more than once (server
// components, client components, route handlers), and the brand setting has to reach all of them.
const FORMAT_KEY = "__rayzTimeFormat";
type FormatGlobal = { [FORMAT_KEY]?: TimeFormat };

/** The brand's `time_format` as loaded on this server or page (loadDisplay, DisplaySync); "12h" until then. */
export function currentTimeFormat(): TimeFormat {
  return (globalThis as FormatGlobal)[FORMAT_KEY] === "24h" ? "24h" : "12h";
}

export function setTimeFormat(f: TimeFormat): void {
  (globalThis as FormatGlobal)[FORMAT_KEY] = f === "24h" ? "24h" : "12h";
}

/** The Luxon pattern for a time of day: "h:mm a" or "HH:mm". */
export function timePattern(format: TimeFormat = currentTimeFormat()): string {
  return format === "24h" ? "HH:mm" : "h:mm a";
}

const zoned = (instant: Date | number | string | DateTime) => (DateTime.isDateTime(instant) ? instant : toZoned(instant));

/**
 * The one clock formatter, shared with the customer API: "9:05 AM" in the shop's zone. A Luxon
 * DateTime reads in its own zone. Without a format, the brand's `time_format`.
 */
export function formatTime(instant: Date | number | string | DateTime, format: TimeFormat = currentTimeFormat()): string {
  return zoned(instant).toFormat(timePattern(format));
}

/** A local date ("2026-10-21") as that day; an instant (Date, or a timestamp string) as its day in the shop's zone. */
export function formatDate(date: LocalDate | Date | string, fmt = "EEE, MMM d"): string {
  const dt = typeof date === "string" && date.length === 10 ? DateTime.fromISO(date, { zone: SHOP_TZ }) : toZoned(date);
  return dt.toFormat(fmt);
}

export interface DateTimeStyle {
  format?: TimeFormat;
  /** The date's Luxon pattern, "EEE, MMM d" by default. */
  date?: string;
  /** Between the date and the time, " · " by default. */
  sep?: string;
}

/**
 * An instant's date and time in the shop's zone: "Tue, Oct 27 · 2:05 PM". The second argument is the
 * format ("12h" | "24h", the brand's by default) or a style that also sets the date and separator.
 */
export function formatDateTime(instant: Date | number | string | DateTime, style: TimeFormat | DateTimeStyle = {}): string {
  const st = typeof style === "string" ? { format: style } : style;
  const z = zoned(instant);
  return `${z.toFormat(st.date ?? "EEE, MMM d")}${st.sep ?? " · "}${formatTime(z, st.format)}`;
}

/** A time of day from minutes after midnight: "9:05 AM" (or "09:05" on the 24-hour setting). Past midnight wraps. */
export function minutesToLabel(min: number, f: TimeFormat = currentTimeFormat()): string {
  const h = Math.floor(min / 60) % 24;
  const m = (min % 60).toString().padStart(2, "0");
  if (f === "24h") return `${h.toString().padStart(2, "0")}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
}

/** "HH:mm" (a time input's or a stored quiet-hours value) as it reads: "9:05 PM". Anything else comes back as is. */
export function hhmmLabel(s: string | null | undefined, f: TimeFormat = currentTimeFormat()): string {
  if (!s || !/^\d{1,2}:\d{2}/.test(s)) return s ?? "";
  return minutesToLabel(hhmmToMinutes(s), f);
}

/** "2026-10-27 14:05" (a local timestamp from SQL) as it reads: "Oct 27, 2026 2:05 PM". Anything else comes back as is. */
export function localStampLabel(s: string, dateFmt = "MMM d, yyyy", f: TimeFormat = currentTimeFormat()): string {
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
