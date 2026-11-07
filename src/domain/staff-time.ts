/**
 * Staff self-service time: quick and recurring blocks (lunch, breaks, the bank...) and time off
 * requests, each with a reason from the brand's list (src/domain/block-reasons.ts). Pure: the rules
 * and their limits, recurring occurrences, time off spans and who is working, off or blocked on a
 * day. Server code (src/server/staff-time.ts) loads rows and calls these.
 */
import { LocalDate, addDays, diffDays, endOfLocalDay, formatDate, localMinutesOf, minutesToLabel, startOfLocalDay, weekdayOf, zonedWallTime } from "@/lib/time";

/** What a block is written as: lunch is held to the lunch limit; time off comes from a request or a manager. */
export type BlockKind = "lunch" | "other" | "time_off";

/** Durations offered as one-tap chips for a quick block. */
export const QUICK_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
export const LUNCH_NOW_MIN = 30;
/** Recurring blocks are written ahead this far: past the longest booking window (365 days). */
export const SERIES_HORIZON_DAYS = 380;
/** The longest single time off request. */
export const MAX_TIME_OFF_DAYS = 60;

// ───────────────────────────── Rules ─────────────────────────────

export interface StaffTimeRules {
  /** auto: requests are approved on submission when nothing is booked in them. manager: someone with "Approve time off" decides. */
  timeOffApproval: "auto" | "manager";
  /** Longest lunch a barber can block for themselves. */
  maxLunchMin: number;
  /** Longest block for any other reason a barber can add for themselves. */
  maxBlockMin: number;
  /** Days ahead a time off request must start. Sick time is exempt. */
  minNoticeDays: number;
}

export const DEFAULT_STAFF_TIME_RULES: StaffTimeRules = { timeOffApproval: "manager", maxLunchMin: 60, maxBlockMin: 120, minNoticeDays: 7 };

const intIn = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** The valid keys of a stored or submitted rules object; anything else is dropped. */
export function cleanRules(raw: unknown): Partial<StaffTimeRules> {
  const out: Partial<StaffTimeRules> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.timeOffApproval === "auto" || r.timeOffApproval === "manager") out.timeOffApproval = r.timeOffApproval;
  const lunch = intIn(r.maxLunchMin, 5, 240);
  if (lunch !== undefined) out.maxLunchMin = lunch;
  const block = intIn(r.maxBlockMin, 5, 720);
  if (block !== undefined) out.maxBlockMin = block;
  const notice = intIn(r.minNoticeDays, 0, 90);
  if (notice !== undefined) out.minNoticeDays = notice;
  return out;
}

/** What problems a submitted rules patch has, in words for the form. */
export function rulesProblem(raw: Record<string, unknown>): string | null {
  const clean = cleanRules(raw);
  if ("timeOffApproval" in raw && raw.timeOffApproval !== undefined && !clean.timeOffApproval) return "Pick automatic or manager approval";
  if ("maxLunchMin" in raw && raw.maxLunchMin !== undefined && clean.maxLunchMin === undefined) return "Longest lunch is 5 to 240 minutes";
  if ("maxBlockMin" in raw && raw.maxBlockMin !== undefined && clean.maxBlockMin === undefined) return "Longest block is 5 to 720 minutes";
  if ("minNoticeDays" in raw && raw.minNoticeDays !== undefined && clean.minNoticeDays === undefined) return "Notice is 0 to 90 days";
  return null;
}

/** Brand rules with a shop's changes on top. */
export const shopRules = (brand: unknown, shop: unknown): StaffTimeRules => ({ ...DEFAULT_STAFF_TIME_RULES, ...cleanRules(brand), ...cleanRules(shop) });

/** Time that covers several shops follows the strictest of them. */
export function strictestRules(list: readonly StaffTimeRules[]): StaffTimeRules {
  if (!list.length) return { ...DEFAULT_STAFF_TIME_RULES };
  return {
    timeOffApproval: list.some((r) => r.timeOffApproval === "manager") ? "manager" : "auto",
    maxLunchMin: Math.min(...list.map((r) => r.maxLunchMin)),
    maxBlockMin: Math.min(...list.map((r) => r.maxBlockMin)),
    minNoticeDays: Math.max(...list.map((r) => r.minNoticeDays)),
  };
}

/** A barber's own block against the limits. People who can block anyone's time aren't held to them. */
export function selfBlockProblem(rules: StaffTimeRules, isLunch: boolean, minutes: number): string | null {
  if (!(minutes > 0)) return "End must be after start";
  if (isLunch && minutes > rules.maxLunchMin) return `Lunch can be at most ${rules.maxLunchMin} minutes here`;
  if (!isLunch && minutes > rules.maxBlockMin) return `A block can be at most ${rules.maxBlockMin} minutes here. Ask a manager for longer, or request time off.`;
  return null;
}

/** Minimum notice for a time off request. Reasons marked "no notice needed" (sick time) can be asked for the same day. */
export function noticeProblem(rules: StaffTimeRules, noticeExempt: boolean, fromDate: LocalDate, today: LocalDate): string | null {
  if (fromDate < today) return "Time off can't start in the past";
  if (noticeExempt || rules.minNoticeDays === 0) return null;
  const days = diffDays(fromDate, today);
  if (days < rules.minNoticeDays) return `Time off needs ${rules.minNoticeDays} days' notice here (from ${addDays(today, rules.minNoticeDays)}). For anything sooner, ask a manager.`;
  return null;
}

// ───────────────────────────── Recurring blocks ─────────────────────────────

export interface SeriesPattern {
  weekdays: readonly number[];
  startMin: number;
  endMin: number;
  startsOn: LocalDate;
  endsOn: LocalDate | null;
}

export function seriesProblem(p: SeriesPattern): string | null {
  if (!p.weekdays.length) return "Pick at least one day";
  if (p.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Days are Sunday to Saturday";
  if (!(p.startMin >= 0 && p.endMin <= 24 * 60 && p.startMin < p.endMin)) return "End must be after start";
  if (p.endsOn && p.endsOn < p.startsOn) return "The last day is before the first";
  return null;
}

/**
 * The occurrences of a recurring block from `from` through `through` (inclusive local dates), at
 * wall-clock times: 12:00 stays 12:00 across a DST change.
 */
export function seriesOccurrences(p: SeriesPattern, from: LocalDate, through: LocalDate): { date: LocalDate; startsAt: Date; endsAt: Date }[] {
  const first = from > p.startsOn ? from : p.startsOn;
  const last = p.endsOn && p.endsOn < through ? p.endsOn : through;
  const days = new Set(p.weekdays);
  const out: { date: LocalDate; startsAt: Date; endsAt: Date }[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!days.has(weekdayOf(d))) continue;
    const startsAt = zonedWallTime(d, p.startMin).toJSDate();
    const endsAt = zonedWallTime(d, p.endMin).toJSDate();
    if (endsAt > startsAt) out.push({ date: d, startsAt, endsAt });
  }
  return out;
}

export const weekdaysLabel = (days: readonly number[]) => {
  const s = [...days].sort((a, b) => a - b).join(",");
  if (s === "1,2,3,4,5") return "Weekdays";
  if (s === "0,1,2,3,4,5,6") return "Every day";
  if (s === "0,6") return "Weekends";
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
    .join(", ");
};

// ───────────────────────────── Time off ─────────────────────────────

export interface TimeOffRange {
  fromDate: LocalDate;
  toDate: LocalDate;
  /** Part of one day; both null for whole days. */
  startMin: number | null;
  endMin: number | null;
}

/** "Mon, Mar 2", "Mon, Mar 2 – Fri, Mar 6" or "Mon, Mar 2, 1:00 PM–5:00 PM". */
export function rangeLabel(r: Pick<TimeOffRange, "fromDate" | "toDate" | "startMin" | "endMin">) {
  if (r.startMin !== null && r.endMin !== null) return `${formatDate(r.fromDate)}, ${minutesToLabel(r.startMin)}–${minutesToLabel(r.endMin % (24 * 60))}`;
  return r.fromDate === r.toDate ? formatDate(r.fromDate) : `${formatDate(r.fromDate)} – ${formatDate(r.toDate)}`;
}

/** When the time off starts and ends, or what's wrong with it. Whole days run midnight to midnight. */
export function timeOffSpan(r: TimeOffRange): { startsAt: Date; endsAt: Date; allDay: boolean } | { problem: string } {
  if (r.toDate < r.fromDate) return { problem: "The last day is before the first" };
  if (diffDays(r.toDate, r.fromDate) + 1 > MAX_TIME_OFF_DAYS) return { problem: `Request at most ${MAX_TIME_OFF_DAYS} days at a time` };
  const partial = r.startMin !== null || r.endMin !== null;
  if (!partial) return { startsAt: startOfLocalDay(r.fromDate), endsAt: endOfLocalDay(r.toDate), allDay: true };
  if (r.startMin === null || r.endMin === null) return { problem: "Give a start and an end time" };
  if (r.fromDate !== r.toDate) return { problem: "Part of a day is one day. For several days, request whole days." };
  if (!(r.startMin >= 0 && r.endMin <= 24 * 60 && r.startMin < r.endMin)) return { problem: "End must be after start" };
  return { startsAt: zonedWallTime(r.fromDate, r.startMin).toJSDate(), endsAt: zonedWallTime(r.fromDate, r.endMin).toJSDate(), allDay: false };
}

/** The appointment overlaps the time (service time; buffers don't count). */
export const overlaps = (a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

// ───────────────────────────── Who's in ─────────────────────────────

export interface Interval {
  start: number;
  end: number;
}

/** Total length of the union of intervals, in minutes. */
export function unionMinutes(list: readonly Interval[]): number {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: Interval | null = null;
  for (const i of sorted) {
    if (!cur || i.start > cur.end) {
      if (cur) total += cur.end - cur.start;
      cur = { ...i };
    } else cur.end = Math.max(cur.end, i.end);
  }
  if (cur) total += cur.end - cur.start;
  return Math.round(total / 60_000);
}

const clip = (i: Interval, w: Interval): Interval | null => {
  const start = Math.max(i.start, w.start);
  const end = Math.min(i.end, w.end);
  return end > start ? { start, end } : null;
};

/** Minutes of `inside` (unioned) that fall within `windows` (unioned). */
export function overlapMinutes(inside: readonly Interval[], windows: readonly Interval[]): number {
  const parts: Interval[] = [];
  for (const i of inside) for (const w of windows) {
    const c = clip(i, w);
    if (c) parts.push(c);
  }
  return unionMinutes(parts);
}

export type DayStatus = "working" | "partly_off" | "off" | "not_scheduled";
export const STATUS_LABEL: Record<DayStatus, string> = { working: "Working", partly_off: "Partly off", off: "Off", not_scheduled: "Not scheduled" };

export interface DayBlockInput {
  startsAt: Date;
  endsAt: Date;
  category: string;
  kind: string;
  reasonId: string | null;
  reason: string;
  note: string | null;
}

export interface DayBlock {
  category: string;
  reasonId: string | null;
  reason: string;
  note: string | null;
  startMin: number;
  endMin: number;
}

export interface StaffDayInput {
  date: LocalDate;
  /** This barber's hours at this shop on this day. */
  spans: readonly { startMin: number; endMin: number }[];
  /** Blocks that apply here: this shop's and all-shop ones. */
  blocks: readonly DayBlockInput[];
  /** Pending requests that cover part of the day. */
  pending: readonly { startsAt: Date; endsAt: Date }[];
}

export interface StaffDay {
  status: DayStatus;
  scheduledMin: number;
  /** Time off within their hours, or the whole day when they're off without hours. */
  offMin: number;
  /** Lunch, breaks and other blocks within their hours. */
  blockedMin: number;
  /** "Lunch 12:00–12:30" etc., in local minutes for the caller to format. */
  blocks: DayBlock[];
  /** A time off request waiting for a manager covers part of the day. */
  pending: boolean;
  /** Has time off on the day at all (even outside their hours here). */
  hasTimeOff: boolean;
}

export const isTimeOff = (b: { category: string; kind: string }) => b.category === "time_off" || b.kind === "day_off";

/** Who is working, off or blocked on one day at one shop. */
export function staffDay(input: StaffDayInput): StaffDay {
  const dayStart = startOfLocalDay(input.date).getTime();
  const dayEnd = endOfLocalDay(input.date).getTime();
  const wall = (m: number) => zonedWallTime(input.date, m).toMillis();
  const windows = input.spans.map((s) => ({ start: wall(s.startMin), end: wall(s.endMin) }));
  const day: Interval = { start: dayStart, end: dayEnd };
  const asInterval = (b: { startsAt: Date; endsAt: Date }) => clip({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }, day);
  const off = input.blocks.filter(isTimeOff).map(asInterval).filter((x): x is Interval => !!x);
  const other = input.blocks.filter((b) => !isTimeOff(b));
  const scheduledMin = unionMinutes(windows);
  const offMin = overlapMinutes(off, windows);
  const blockedOnly = other.map(asInterval).filter((x): x is Interval => !!x);
  // Blocked time inside time off is already off.
  const blockedMin = Math.max(0, overlapMinutes([...blockedOnly, ...off], windows) - offMin);
  const pending = input.pending.some((p) => asInterval(p) !== null);
  let status: DayStatus;
  if (!scheduledMin) status = off.length ? "off" : "not_scheduled";
  else if (offMin >= scheduledMin) status = "off";
  else if (offMin > 0) status = "partly_off";
  else status = "working";
  const toMin = (d: Date) => (d.getTime() <= dayStart ? 0 : d.getTime() >= dayEnd ? 24 * 60 : localMinutesOf(d));
  return {
    status,
    scheduledMin,
    offMin: scheduledMin ? offMin : unionMinutes(off),
    blockedMin,
    blocks: input.blocks
      .map((b) => ({ category: isTimeOff(b) ? "time_off" : b.category, reasonId: b.reasonId, reason: b.reason, note: b.note, startMin: toMin(b.startsAt), endMin: toMin(b.endsAt) }))
      .sort((a, b) => a.startMin - b.startMin),
    pending,
    hasTimeOff: off.length > 0,
  };
}
