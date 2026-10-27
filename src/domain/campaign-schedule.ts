/**
 * When and to whom a blast goes, kept pure: recurring schedules, the A/B test's groups and winner,
 * the holdout group, and send-time optimization (each client's usual booking time). Groups come from
 * a hash of the campaign and client, so a client is always in the same group however often the
 * engine runs.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import { formatTime } from "@/lib/time";
import { TEMPLATE_PART_LABEL, TemplatesSchema, type Templates } from "./marketing";

// ───────────────────────────── Recurring schedules ─────────────────────────────

export const FREQS = ["once", "weekly", "biweekly", "monthly"] as const;
export type Freq = (typeof FREQS)[number];
export const FREQ_LABEL: Record<Freq, string> = { once: "One time", weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month" };

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-31")
  .nullable()
  .default(null);

/** A repeating blast: the first send (the anchor) sets the weekday or day of the month and the time. */
export const RecurrenceSchema = z.object({
  freq: z.enum(["weekly", "biweekly", "monthly"]),
  /** The last day it may go out, inclusive, in the location's calendar. */
  endsOn: isoDate,
  anchor: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export function recurrenceOf(raw: unknown): Recurrence | null {
  if (!raw) return null;
  const r = RecurrenceSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** The nth send after the anchor, in local wall time so a weekly 10 AM send stays at 10 AM across daylight saving. */
export function occurrence(anchor: Date, freq: Recurrence["freq"], n: number, timeZone: string): Date {
  const a = DateTime.fromJSDate(anchor).setZone(timeZone);
  const at = freq === "monthly" ? a.plus({ months: n }) : a.plus({ weeks: freq === "weekly" ? n : 2 * n });
  return at.toJSDate();
}

/** The first send strictly after `after`, or null once it's past the end date. */
export function nextOccurrence(r: Pick<Recurrence, "freq" | "endsOn">, anchor: Date, after: Date, timeZone: string): Date | null {
  // Months run 28 to 31 days; counting 31 starts the search at or before the answer.
  const days = r.freq === "monthly" ? 31 : r.freq === "weekly" ? 7 : 14;
  let n = Math.max(0, Math.floor((after.getTime() - anchor.getTime()) / (days * 86_400_000)) - 1);
  for (let i = 0; i < 400; i++, n++) {
    const at = occurrence(anchor, r.freq, n, timeZone);
    if (at.getTime() <= after.getTime()) continue;
    if (r.endsOn && DateTime.fromJSDate(at).setZone(timeZone).toISODate()! > r.endsOn) return null;
    return at;
  }
  return null;
}

/** Sends from `from` to `to` (for the calendar), at most `max`. */
export function occurrencesBetween(r: Pick<Recurrence, "freq" | "endsOn">, anchor: Date, from: Date, to: Date, timeZone: string, max = 62): Date[] {
  const out: Date[] = [];
  let at: Date | null = anchor.getTime() >= from.getTime() ? anchor : nextOccurrence(r, anchor, new Date(from.getTime() - 1), timeZone);
  while (at && at.getTime() <= to.getTime() && out.length < max) {
    out.push(at);
    at = nextOccurrence(r, anchor, at, timeZone);
  }
  return out;
}

/** Each send of a recurring blast is its own occasion, so a client gets each one once. One-time blasts keep "blast". */
export const blastOccasion = (scheduledAt: Date | null, recurring: boolean, timeZone: string) =>
  recurring && scheduledAt ? `blast:${DateTime.fromJSDate(scheduledAt).setZone(timeZone).toISODate()}` : "blast";

export function recurrenceLabel(r: Recurrence | null, timeZone: string): string {
  if (!r) return FREQ_LABEL.once;
  const a = r.anchor ? DateTime.fromISO(r.anchor).setZone(timeZone) : null;
  const on = a ? (r.freq === "monthly" ? ` on the ${a.toFormat("d")}${ordinal(a.day)}` : ` on ${a.toFormat("cccc")}`) : "";
  const time = a ? ` at ${formatTime(a)}` : "";
  return `${FREQ_LABEL[r.freq]}${on}${time}${r.endsOn ? `, until ${DateTime.fromISO(r.endsOn).toFormat("MMM d, yyyy")}` : ""}`;
}
const ordinal = (d: number) => (d % 100 >= 11 && d % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][d % 10] ?? "th"));

// ───────────────────────────── Groups ─────────────────────────────

/** A stable number in [0, 1) for a key, so the same client always lands in the same group. */
export function bucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // FNV-1a alone skews when keys differ only in their last characters (sequential ids); murmur3's finalizer evens it out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

export const HOLDOUT_MAX = 50;
/** Held back: gets nothing, to compare against. Independent of the A/B groups. */
export const inHoldout = (campaignId: string, customerId: string, pct: number) => pct > 0 && bucket(`holdout:${campaignId}:${customerId}`) < pct / 100;

// ───────────────────────────── A/B tests ─────────────────────────────

export const AB_METRICS = ["click", "open", "booking"] as const;
export type AbMetric = (typeof AB_METRICS)[number];
export const AB_METRIC_LABEL: Record<AbMetric, string> = { click: "Click rate", open: "Open rate (emails)", booking: "Booking rate" };

/** Variant B's wording: whatever differs from A (subject, text, push). Empty fields follow A. */
export const AbVariantSchema = TemplatesSchema.partial();

export const AbSchema = z.object({
  /** Each variant goes to half of this share of the audience; the rest get the winner. */
  testPct: z.number().int().min(10).max(50).default(20),
  metric: z.enum(AB_METRICS).default("click"),
  /** How long the test runs before the winner is picked and sent to everyone else. */
  waitHours: z.number().int().min(1).max(72).default(4),
  b: AbVariantSchema.default({}),
  winner: z.enum(["a", "b"]).nullable().default(null),
  testEndsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  decidedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** The test groups' results when the winner was picked. */
  result: z
    .object({ a: z.object({ n: z.number(), hits: z.number() }), b: z.object({ n: z.number(), hits: z.number() }) })
    .nullable()
    .default(null),
});
export type AbTest = z.infer<typeof AbSchema>;

export function abOf(raw: unknown): AbTest | null {
  if (!raw) return null;
  const r = AbSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Which A/B group a client is in: a, b, or neither (they wait for the winner). */
export function abGroup(campaignId: string, customerId: string, testPct: number): "a" | "b" | null {
  const x = bucket(`ab:${campaignId}:${customerId}`);
  if (x >= testPct / 100) return null;
  return x < testPct / 200 ? "a" : "b";
}

/** Variant B's wording: A with B's fields laid over it. */
export function variantTemplates(a: Templates, b: Partial<Templates>): Templates {
  return { ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "string" && v.trim())) };
}

/** What a variant changes, for the review step: "Email subject, Text". */
export function abChanges(a: Templates, b: Partial<Templates>): string[] {
  return (Object.keys(TEMPLATE_PART_LABEL) as (keyof Templates)[]).filter((k) => typeof b[k] === "string" && b[k]!.trim() && b[k] !== (a[k] ?? "")).map((k) => TEMPLATE_PART_LABEL[k]);
}

/** The variant with the higher rate wins; a tie (or no data) keeps A, the original. */
export function pickWinner(a: { n: number; hits: number }, b: { n: number; hits: number }): "a" | "b" {
  const ra = a.n ? a.hits / a.n : 0;
  const rb = b.n ? b.hits / b.n : 0;
  return rb > ra ? "b" : "a";
}

// ───────────────────────────── Send-time optimization ─────────────────────────────

/** A client's usual time to book: the median minute of the day (local) of the bookings they made, from two of them. */
export function usualMinute(minutes: readonly number[]): number | null {
  if (minutes.length < 2) return null;
  const s = [...minutes].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** When the message goes: the next time it's the client's usual minute, within a day; now without one. Quiet hours apply after this. */
export function optimizedSendAt(now: Date, timeZone: string, minute: number | null): Date {
  if (minute === null) return now;
  const local = DateTime.fromJSDate(now).setZone(timeZone);
  let at = local.startOf("day").plus({ minutes: minute });
  if (at < local) at = at.plus({ days: 1 });
  return at.toJSDate();
}
