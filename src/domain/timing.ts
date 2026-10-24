/**
 * Booking time rules. Pure: which slot interval applies to a barber at a shop, how long a service
 * takes them, and the chair time a booking holds (service, add-ons, prep and cleanup buffers).
 */

/** The intervals offered as buttons. Any other whole multiple of 5 from 5 to 120 is allowed as a custom value. */
export const INTERVAL_PRESETS = [15, 20, 30] as const;
export const INTERVAL_MIN = 5;
export const INTERVAL_MAX = 120;

/** Service durations snap to one of these steps. */
export const DURATION_STEPS = [5, 10, 15, 20, 30] as const;
export const DURATION_MIN = 5;
export const DURATION_MAX = 480;
export const BUFFER_MAX = 120;

export function intervalProblem(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isInteger(n)) return "The interval must be a whole number of minutes";
  if (n < INTERVAL_MIN || n > INTERVAL_MAX) return `The interval must be between ${INTERVAL_MIN} and ${INTERVAL_MAX} minutes`;
  if (n % 5 !== 0) return "The interval must be a multiple of 5 minutes";
  return null;
}

export const isDurationStep = (n: unknown): n is (typeof DURATION_STEPS)[number] => (DURATION_STEPS as readonly unknown[]).includes(n);

export function durationProblem(min: unknown, step: number): string | null {
  if (typeof min !== "number" || !Number.isInteger(min)) return "The duration must be a whole number of minutes";
  if (min < DURATION_MIN || min > DURATION_MAX) return `The duration must be between ${DURATION_MIN} and ${DURATION_MAX} minutes`;
  if (min % step !== 0) return `The duration must be in ${step}-minute steps (for example ${snapDuration(min, step)})`;
  return null;
}

/** The nearest allowed duration (ties round up), kept inside the allowed range. */
export function snapDuration(min: number, step: number): number {
  const snapped = Math.round(min / step) * step;
  return Math.min(Math.floor(DURATION_MAX / step) * step, Math.max(step * Math.ceil(DURATION_MIN / step), snapped));
}

export function bufferProblem(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > BUFFER_MAX) return `Buffers are 0 to ${BUFFER_MAX} whole minutes`;
  return null;
}

// ───────────────────────────── Resolution ─────────────────────────────

export type IntervalSource = "barber_at_shop" | "barber" | "shop" | "brand";
export const INTERVAL_SOURCE_LABEL: Record<IntervalSource, string> = {
  barber_at_shop: "set for this barber at this shop",
  barber: "set for this barber",
  shop: "shop setting",
  brand: "brand default",
};

export interface IntervalLevels {
  brand: number;
  shop?: number | null;
  barber?: number | null;
  barberAtShop?: number | null;
}

/** The most specific interval wins: the barber at this shop, then the barber, then the shop, then the brand. */
export function resolveInterval(l: IntervalLevels): { minutes: number; source: IntervalSource } {
  if (l.barberAtShop != null) return { minutes: l.barberAtShop, source: "barber_at_shop" };
  if (l.barber != null) return { minutes: l.barber, source: "barber" };
  if (l.shop != null) return { minutes: l.shop, source: "shop" };
  return { minutes: l.brand, source: "brand" };
}

export type DurationSource = "barber_at_shop" | "barber" | "shop" | "service";

export interface DurationLevels {
  service: number;
  shop?: number | null;
  barber?: number | null;
  barberAtShop?: number | null;
}

/** The most specific duration wins: the barber at this shop, then the barber, then the shop's price list, then the service. */
export function resolveDuration(l: DurationLevels): { minutes: number; source: DurationSource } {
  if (l.barberAtShop != null) return { minutes: l.barberAtShop, source: "barber_at_shop" };
  if (l.barber != null) return { minutes: l.barber, source: "barber" };
  if (l.shop != null) return { minutes: l.shop, source: "shop" };
  return { minutes: l.service, source: "service" };
}

// ───────────────────────────── Booking plan ─────────────────────────────

export interface TimedItem {
  kind: "service" | "addon";
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  bookingIncrementMin?: number | null;
}

/** What one booking holds on one barber's calendar. */
export interface BookingPlan {
  /** Service plus add-ons. */
  durationMin: number;
  /** Prep held before the start. */
  beforeMin: number;
  /** Cleanup held after the service; it has to fit inside working hours too. */
  afterMin: number;
  /** The shop's gap between appointments, held after the cleanup. It may run past closing. */
  gapMin: number;
  /** Start times step by this from the start of each working stretch. */
  intervalMin: number;
}

/**
 * Add-on durations and buffers add to the main service. The main service's own booking increment,
 * when it has one, replaces the barber's interval for that booking (a long color that only starts on the half hour).
 */
export function bookingPlan(items: readonly TimedItem[], opts: { intervalMin: number; gapMin?: number }): BookingPlan {
  const sum = (f: (i: TimedItem) => number) => items.reduce((a, i) => a + Math.max(0, f(i)), 0);
  const main = items.find((i) => i.kind === "service");
  return {
    durationMin: sum((i) => i.durationMin),
    beforeMin: sum((i) => i.bufferBeforeMin ?? 0),
    afterMin: sum((i) => i.bufferAfterMin ?? 0),
    gapMin: Math.max(0, opts.gapMin ?? 0),
    intervalMin: main?.bookingIncrementMin ?? opts.intervalMin,
  };
}

/** Minutes stored on the appointment as its trailing buffer (cleanup plus the shop's gap). */
export const trailingBuffer = (p: Pick<BookingPlan, "afterMin" | "gapMin">) => p.afterMin + p.gapMin;
