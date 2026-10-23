/**
 * Actual service times. Pure: which timed appointments count, the average and median math, how
 * a service compares with its booked time, and when a barber's times call for a different
 * booked duration. Server code loads the rows and calls these.
 */
import { snapDuration } from "./timing";

/** Within this many minutes of the booked time counts as on time. */
export const ON_TIME_TOLERANCE_MIN = 5;
/** Over this many times the booked time: someone forgot to tap Finish. */
export const OUTLIER_OVER_FACTOR = 3;
/** Under this share of the booked time: Start was tapped late, or Start and Finish together by mistake. */
export const OUTLIER_UNDER_FACTOR = 0.25;
/** Waits longer than this (arrival to start) are left out of wait times: an early check-in or a forgotten one. */
export const WAIT_MAX_MIN = 180;

/** Suggestions need this many counted services of one barber, one service, at one shop. */
export const SUGGEST_MIN_SAMPLES = 8;
/** ...an average and a median at least this far from the booked time... */
export const SUGGEST_MIN_DIFF_MIN = 5;
/** ...and at least this share of the booked time... */
export const SUGGEST_MIN_DIFF_SHARE = 0.15;
/** ...with at least this share of the services on that side of it. */
export const SUGGEST_CONSISTENCY = 0.7;

export type TimingFlag = "over_3x" | "under_quarter" | "left_running";
export const FLAG_LABEL: Record<TimingFlag, string> = {
  over_3x: `Over ${OUTLIER_OVER_FACTOR}× the booked time`,
  under_quarter: "Under a quarter of the booked time",
  left_running: "Timer left running",
};

/** A manager's call on one appointment: count it even though it's flagged, or leave it out. Null: by the flags. */
export type TimingReview = "include" | "exclude";
export const REVIEW_LABEL: Record<TimingReview, string> = { include: "Counted by a manager", exclude: "Left out by a manager" };

export type FinishedVia = "finish" | "checkout" | "correction";
export const FINISHED_VIA_LABEL: Record<FinishedVia, string> = { finish: "Finish tapped", checkout: "Checkout (Finish not tapped)", correction: "Corrected by a manager" };

export interface TimedService {
  bookedMin: number;
  arrivedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  review: TimingReview | null;
}

/** A recorded moment and who recorded it, as sent to the browser. */
export interface Stamp {
  at: string;
  by: string | null;
}

/** One appointment's times for the calendar, the barber's day and the POS. */
export interface TimesView {
  appointmentId: string;
  bookedMin: number;
  arrived: Stamp | null;
  started: Stamp | null;
  finished: (Stamp & { via: FinishedVia }) | null;
  checkedOut: Stamp | null;
  review: TimingReview | null;
  reviewNote: string | null;
  corrected: Stamp | null;
  actualMin: number | null;
  waitMin: number | null;
  flags: TimingFlag[];
  counts: boolean;
}

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

/** Start to finish, or null until both are recorded. */
export function actualMinutes(t: Pick<TimedService, "startedAt" | "finishedAt">): number | null {
  if (!t.startedAt || !t.finishedAt) return null;
  return minutesBetween(t.startedAt, t.finishedAt);
}

/** Arrival to start, or null without both, when the start came first, or past the wait limit. */
export function waitMinutes(t: Pick<TimedService, "arrivedAt" | "startedAt">): number | null {
  if (!t.arrivedAt || !t.startedAt) return null;
  const w = minutesBetween(t.arrivedAt, t.startedAt);
  return w < 0 || w > WAIT_MAX_MIN ? null : w;
}

/** Why a time looks wrong. An open timer is flagged once it has run past the outlier limit. */
export function timingFlags(t: TimedService, now: Date = new Date()): TimingFlag[] {
  const booked = Math.max(1, t.bookedMin);
  if (!t.startedAt) return [];
  if (!t.finishedAt) return minutesBetween(t.startedAt, now) > booked * OUTLIER_OVER_FACTOR ? ["left_running"] : [];
  const actual = minutesBetween(t.startedAt, t.finishedAt);
  const flags: TimingFlag[] = [];
  if (actual > booked * OUTLIER_OVER_FACTOR) flags.push("over_3x");
  if (actual < booked * OUTLIER_UNDER_FACTOR) flags.push("under_quarter");
  return flags;
}

/** Counts toward averages: started and finished, and either unflagged or counted by a manager. Left out by a manager never counts. */
export function counts(t: TimedService, now: Date = new Date()): boolean {
  if (actualMinutes(t) === null) return false;
  if (t.review === "exclude") return false;
  if (t.review === "include") return true;
  return timingFlags(t, now).length === 0;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
}

/** The middle value; with an even count, halfway between the two middle ones. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type Pace = "on_time" | "over" | "under";
export function paceOf(actualMin: number, bookedMin: number): Pace {
  const d = actualMin - bookedMin;
  if (d > ON_TIME_TOLERANCE_MIN) return "over";
  if (d < -ON_TIME_TOLERANCE_MIN) return "under";
  return "on_time";
}

export interface Sample {
  actualMin: number;
  bookedMin: number;
  /** Null when there's no usable arrival. */
  waitMin: number | null;
}

export interface TimingSummary {
  n: number;
  avgMin: number | null;
  medianMin: number | null;
  avgBookedMin: number | null;
  /** Average of (actual - booked): positive runs over. */
  avgVarianceMin: number | null;
  medianVarianceMin: number | null;
  onTime: number | null;
  over: number | null;
  under: number | null;
  waitN: number;
  avgWaitMin: number | null;
  medianWaitMin: number | null;
}

/** Counted services only: callers filter with `counts` first. Shares are of `n`. */
export function summarize(samples: readonly Sample[]): TimingSummary {
  const n = samples.length;
  const actual = samples.map((s) => s.actualMin);
  const variance = samples.map((s) => s.actualMin - s.bookedMin);
  const paces = samples.map((s) => paceOf(s.actualMin, s.bookedMin));
  const share = (p: Pace) => (n ? paces.filter((x) => x === p).length / n : null);
  const waits = samples.map((s) => s.waitMin).filter((w): w is number => w !== null);
  return {
    n,
    avgMin: mean(actual),
    medianMin: median(actual),
    avgBookedMin: mean(samples.map((s) => s.bookedMin)),
    avgVarianceMin: mean(variance),
    medianVarianceMin: median(variance),
    onTime: share("on_time"),
    over: share("over"),
    under: share("under"),
    waitN: waits.length,
    avgWaitMin: mean(waits),
    medianWaitMin: median(waits),
  };
}

export interface DurationSuggestion {
  /** The booked duration to switch to, on the service's duration step. */
  minutes: number;
  currentMin: number;
  n: number;
  avgMin: number;
  medianMin: number;
  /** Share of the services that ran on the suggested side of the current time. */
  consistency: number;
}

/**
 * A new booked duration for one barber and one service when their actual times consistently
 * differ from it: enough services, the average and the median both past the threshold on the same
 * side, and most services on that side too. The suggestion is the average on the duration step.
 */
export function suggestDuration(input: { currentMin: number; actualMin: readonly number[]; stepMin: number }): DurationSuggestion | null {
  const { currentMin, actualMin, stepMin } = input;
  const n = actualMin.length;
  if (n < SUGGEST_MIN_SAMPLES) return null;
  const avg = mean(actualMin)!;
  const med = median(actualMin)!;
  const threshold = Math.max(SUGGEST_MIN_DIFF_MIN, currentMin * SUGGEST_MIN_DIFF_SHARE);
  const dAvg = avg - currentMin;
  const dMed = med - currentMin;
  if (Math.abs(dAvg) < threshold || Math.abs(dMed) < threshold || Math.sign(dAvg) !== Math.sign(dMed)) return null;
  const longer = dAvg > 0;
  const consistency = actualMin.filter((x) => (longer ? x > currentMin : x < currentMin)).length / n;
  if (consistency < SUGGEST_CONSISTENCY) return null;
  const minutes = snapDuration(avg, stepMin);
  if (minutes === currentMin) return null;
  return { minutes, currentMin, n, avgMin: avg, medianMin: med, consistency };
}

/** What a correction may set: arrival no later than the start, the finish after the start, nothing in the future. */
export function correctionProblem(t: { arrivedAt: Date | null; startedAt: Date | null; finishedAt: Date | null }, now: Date = new Date()): string | null {
  const future = (d: Date | null) => d && d.getTime() > now.getTime() + 60_000;
  if (future(t.arrivedAt) || future(t.startedAt) || future(t.finishedAt)) return "Times can't be in the future";
  if (t.finishedAt && !t.startedAt) return "Add a start time before the finish";
  if (t.startedAt && t.finishedAt && t.finishedAt <= t.startedAt) return "The finish must be after the start";
  if (t.arrivedAt && t.startedAt && t.arrivedAt > t.startedAt) return "Arrival must be at or before the start";
  if (t.startedAt && t.finishedAt && minutesBetween(t.startedAt, t.finishedAt) > 24 * 60) return "A service can't run longer than a day";
  return null;
}

/** Whole and tenths of a minute, like "41.2 min". */
export const formatMinutes = (m: number | null) => (m === null ? "—" : `${(Math.round(m * 10) / 10).toFixed(1)} min`);
export const formatDelta = (m: number | null) => (m === null ? "—" : `${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(Math.round(m * 10) / 10).toFixed(1)} min`);
