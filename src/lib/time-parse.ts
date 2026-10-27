import { clockFormat, type ClockFormat } from "./time";

/**
 * Typed times of day for the fast time picker: "9", "930", "9:30", "5p", "5:15pm", "17:00", "noon".
 * Without am or pm, 7 to 11 read as morning and 12 to 6 as afternoon (barbershop hours), and a
 * 24-hour time reads as itself. Returns minutes after midnight, or null when it isn't a time.
 */
export function parseTimeOfDay(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  if (!s) return null;
  if (s === "noon") return 12 * 60;
  if (s === "midnight") return 0;
  const m = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "a") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  else if (h >= 1 && h <= 6 && !(m[1].length === 2 && m[1].startsWith("0"))) h += 12;
  return h * 60 + min;
}

/** "9:30 AM", "12 PM": how a time of day reads in the picker ("09:30", "12:00" on the 24-hour setting). */
export function formatTimeOfDay(min: number, f: ClockFormat = clockFormat()): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  if (f === "24h") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** A tight grid's time of day: "9a", "5:30p" ("09:00", "17:30" on the 24-hour setting). 24:00 is midnight, "12a". */
export function compactTimeOfDay(min: number, f: ClockFormat = clockFormat()): string {
  if (f === "24h") return formatTimeOfDay(min, f);
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
}

/** Up or down a step (15 minutes by default), staying within the day. An off-step time snaps to the next one that way. */
export function stepTime(min: number, dir: 1 | -1, step = 15): number {
  const snapped = dir > 0 ? Math.ceil(min / step) * step : Math.floor(min / step) * step;
  const next = snapped === min ? min + dir * step : snapped;
  return Math.min(24 * 60 - step, Math.max(0, next));
}
