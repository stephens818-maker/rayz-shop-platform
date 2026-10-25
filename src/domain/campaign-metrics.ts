/**
 * Campaign results, counted once per client message (unique) so no rate can pass 100%: opens are
 * emails opened over emails delivered, clicks are messages whose link was opened over messages
 * delivered, bookings are messages followed by a booking over messages delivered. Each rate has a
 * plain definition for its tooltip. Nothing here guesses: a rate with nothing to divide by is null
 * ("—"), never 0%.
 */
import { DateTime } from "luxon";

export interface Funnel {
  /** Marketing messages queued to clients (not tests, skips or holdouts). */
  sent: number;
  /** Accepted by the provider; texts once Twilio reports them delivered. */
  delivered: number;
  emailDelivered: number;
  smsDelivered: number;
  /** Delivered emails opened at least once (the pixel, or a click, which means it was opened). */
  uniqueOpens: number;
  /** Delivered messages whose link was opened at least once. */
  uniqueClicks: number;
  /** Delivered messages followed by at least one booking in the attribution window (last touch). */
  bookers: number;
  bookings: number;
  /** Net service and product sales credited to the messages, leaving out clients already booked when it went. */
  revenueCents: number;
  costCents: number;
  /** Email unsubscribe links. */
  unsubscribes: number;
  /** STOP replies to a marketing text. */
  optOuts: number;
  redemptions: number;
  /** Messages to clients who already had an appointment coming up; their spend isn't credited. */
  alreadyBooked: number;
}

export const EMPTY_FUNNEL: Funnel = {
  sent: 0,
  delivered: 0,
  emailDelivered: 0,
  smsDelivered: 0,
  uniqueOpens: 0,
  uniqueClicks: 0,
  bookers: 0,
  bookings: 0,
  revenueCents: 0,
  costCents: 0,
  unsubscribes: 0,
  optOuts: 0,
  redemptions: 0,
  alreadyBooked: 0,
};

export function addFunnel(a: Funnel, b: Partial<Funnel>): Funnel {
  const out = { ...a };
  for (const k of Object.keys(EMPTY_FUNNEL) as (keyof Funnel)[]) out[k] += Number(b[k] ?? 0);
  return out;
}

/** A share in [0, 1], or null with nothing to divide by. */
export const rate = (n: number, of: number): number | null => (of > 0 ? Math.min(1, Math.max(0, n / of)) : null);

export interface Rates {
  openRate: number | null;
  clickRate: number | null;
  bookingRate: number | null;
  unsubscribeRate: number | null;
  optOutRate: number | null;
  roi: number | null;
}

export function ratesOf(f: Funnel): Rates {
  return {
    openRate: rate(f.uniqueOpens, f.emailDelivered),
    clickRate: rate(f.uniqueClicks, f.delivered),
    bookingRate: rate(f.bookers, f.delivered),
    unsubscribeRate: rate(f.unsubscribes, f.emailDelivered),
    optOutRate: rate(f.optOuts, f.smsDelivered),
    roi: f.costCents > 0 ? (f.revenueCents - f.costCents) / f.costCents : null,
  };
}

/** "42.5%", or "—" with nothing to show. */
export function pctLabel(x: number | null, digits = 1): string {
  if (x === null || !Number.isFinite(x)) return "—";
  const v = x * 100;
  return `${v.toFixed(v === 0 || v === 100 ? 0 : digits)}%`;
}

export type MetricKey = "attributedSales" | "openRate" | "clickRate" | "bookingRate" | "unsubscribeRate" | "optOutRate" | "delivered" | "lift" | "roi";

/** One definition per measure, shown wherever the number is. */
export function metricDefinitions(attributionDays: number, basis: "sent" | "engaged"): Record<MetricKey, { label: string; definition: string }> {
  const window = basis === "engaged" ? `within ${attributionDays} days after the client opened or clicked the message` : `within ${attributionDays} days after the message`;
  return {
    attributedSales: {
      label: "Attributed sales",
      definition: `Net service and product sales by clients ${window}, credited to the latest message they got (last touch), so a sale counts once. Clients who already had an appointment booked when the message went aren't credited.`,
    },
    openRate: {
      label: "Open rate",
      definition:
        "Emails opened at least once, over emails delivered. Each email counts once however many times it's opened, so it can't pass 100%. A click counts as an open. Texts and pushes have no opens. Some mail apps load images for privacy, which can count an open the client didn't make.",
    },
    clickRate: {
      label: "Click rate",
      definition: "Messages whose tracked link (/m/…, one per client) was opened at least once, over messages delivered, all channels. Link previews and mail scanners aren't counted.",
    },
    bookingRate: { label: "Booking rate", definition: `Messages followed by a booking ${window}, over messages delivered. A booking the client made before the message doesn't count.` },
    unsubscribeRate: { label: "Unsubscribe rate", definition: "Email unsubscribe links used, over emails delivered." },
    optOutRate: { label: "Opt-out rate", definition: "STOP replies to a marketing text, over texts delivered." },
    delivered: { label: "Delivered", definition: "Messages the provider accepted; texts once Twilio reports them delivered. Tests, skipped clients and the holdout group aren't counted." },
    lift: {
      label: "Lift",
      definition: `Booking rate of clients who got it, less the booking rate of the holdout group (eligible clients held back at random), each counting any booking ${`within ${attributionDays} days`}. What the campaign really added.`,
    },
    roi: { label: "ROI", definition: "Attributed sales less cost (message costs plus coupon discounts), over cost." },
  };
}

/** Most successful first: attributed sales, then booking rate, then click rate, then reach. */
export function bySuccess<T extends { funnel: Funnel }>(a: T, b: T): number {
  const ra = ratesOf(a.funnel);
  const rb = ratesOf(b.funnel);
  return b.funnel.revenueCents - a.funnel.revenueCents || (rb.bookingRate ?? -1) - (ra.bookingRate ?? -1) || (rb.clickRate ?? -1) - (ra.clickRate ?? -1) || b.funnel.delivered - a.funnel.delivered;
}

export interface Lift {
  treated: { n: number; booked: number; rate: number | null };
  holdout: { n: number; booked: number; rate: number | null };
  /** Percentage points, e.g. 0.04 for four points. Null without both groups. */
  points: number | null;
  /** Extra bookings the campaign made: the lift times the clients who got it. */
  incremental: number | null;
}

export function liftOf(treated: { n: number; booked: number }, holdout: { n: number; booked: number }): Lift {
  const tr = rate(treated.booked, treated.n);
  const hr = rate(holdout.booked, holdout.n);
  const points = tr !== null && hr !== null ? tr - hr : null;
  return { treated: { ...treated, rate: tr }, holdout: { ...holdout, rate: hr }, points, incremental: points === null ? null : Math.round(points * treated.n) };
}

/**
 * Which send a message counts toward on a campaign's results. A blast's sends are its occasions:
 * one for a one-time blast, one per date for a recurring one. Automations and sequences send a
 * little every day, so theirs are grouped by the week (Monday) the message went.
 */
export function sendKey(kind: string, occasion: string, at: Date, timeZone: string): string {
  if (kind === "blast") return occasion.startsWith("blast") ? occasion : "blast";
  return `week:${DateTime.fromJSDate(at).setZone(timeZone).startOf("week").toISODate()}`;
}

export function sendLabel(key: string, firstAt: Date, timeZone: string): string {
  if (key.startsWith("week:")) return `Week of ${DateTime.fromISO(key.slice(5)).toFormat("MMM d, yyyy")}`;
  const date = /^blast:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
  return date ? DateTime.fromISO(date).toFormat("EEE, MMM d, yyyy") : DateTime.fromJSDate(firstAt).setZone(timeZone).toFormat("EEE, MMM d, yyyy");
}
