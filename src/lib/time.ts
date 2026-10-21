import { DateTime } from "luxon";

/** Every shop operates on Chicago time. All wall-clock math must go through these helpers. */
export const SHOP_TZ = "America/Chicago";

export type LocalDate = string; // YYYY-MM-DD in SHOP_TZ

export function toZoned(instant: Date | number | string): DateTime {
  const dt =
    typeof instant === "string"
      ? DateTime.fromISO(instant, { setZone: true })
      : DateTime.fromMillis(typeof instant === "number" ? instant : instant.getTime());
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

export function formatTime(instant: Date | number | string): string {
  return toZoned(instant).toFormat("h:mm a");
}

export function formatDate(date: LocalDate | Date, fmt = "EEE, MMM d"): string {
  const dt = typeof date === "string" ? DateTime.fromISO(date, { zone: SHOP_TZ }) : toZoned(date);
  return dt.toFormat(fmt);
}

export function formatDateTime(instant: Date | number | string): string {
  return toZoned(instant).toFormat("EEE, MMM d · h:mm a");
}

export function minutesToLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
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
