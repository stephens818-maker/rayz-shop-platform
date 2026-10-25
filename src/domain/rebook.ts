/**
 * The Rebook Rate report's definitions, worked out the same way everywhere they appear (the report,
 * the Morning Dashboard, a barber's own card on Today, custom reports and the assistant):
 *
 * - Rebooked at checkout: the client left with their next visit on the books. It was booked by the
 *   end of the visit's day (at checkout, later that day, or already booked before the visit) for a
 *   later day, and wasn't cancelled that day. Squire visits without a booked-at time are left out.
 * - Back within 30, 45 or 60 days, or their own usual gap: of the clients seen in the range, judged
 *   from their first visit in it, the share whose next completed visit at any Ray'z shop came within
 *   that many days, however it was booked. Only visits whose window has closed are judged.
 * - New-client rebook rate: the same rebook rate, on first-ever visits to the brand.
 * - 2nd-visit retention: of the clients whose first-ever visit is in the range, the share back for
 *   a second within the return window (60 days when the window is their own gap; new clients don't
 *   have one yet).
 * - Future appointments: booked or confirmed appointments still to come, as of now.
 * Pure: no database, no clock.
 */
import { LocalDate, addDays, diffDays, formatDate } from "@/lib/time";

export const RETURN_DAYS = [30, 45, 60] as const;
export type ReturnDays = (typeof RETURN_DAYS)[number];
export type ReturnWindow = ReturnDays | "own";
/** New clients have no gap of their own yet, so "their own gap" judges 2nd visits over this. */
export const NEW_CLIENT_FALLBACK_DAYS = 60;
/** Fewer visits than this and a barber or location is listed on the leaderboard without a rank. */
export const MIN_RANKED_VISITS = 10;

export const WINDOW_LABEL: Record<string, string> = { "30": "30 days", "45": "45 days", "60": "60 days", own: "Their usual gap" };
export const parseWindow = (v: unknown): ReturnWindow => (v === "30" ? 30 : v === "60" ? 60 : v === "own" ? "own" : 45);
export const windowDays = (w: ReturnWindow): number => (w === "own" ? NEW_CLIENT_FALLBACK_DAYS : w);
export const windowLabel = (w: ReturnWindow) => (w === "own" ? "their usual gap" : `${w} days`);

export const CLIENT_TYPES = { all: "All clients", new: "New", returning: "Returning" } as const;
export type ClientType = keyof typeof CLIENT_TYPES;
export const parseClientType = (v: unknown): ClientType => (v === "new" || v === "returning" ? v : "all");

export type TrendGrain = "week" | "month";
/** Weekly up to about a quarter, monthly beyond. */
export const parseTrend = (v: unknown, from: LocalDate, to: LocalDate): TrendGrain => (v === "week" || v === "month" ? v : diffDays(to, from) > 100 ? "month" : "week");
/** "Week of Oct 5" (weeks start Sunday, like the rest of the app) or "Oct 2026". */
export const periodLabel = (start: LocalDate, g: TrendGrain) => (g === "week" ? `Week of ${formatDate(start, "MMM d")}` : formatDate(start, "MMM yyyy"));

/** Every period start from `from` to `to`, so weeks with no visits still show. */
export function periodStarts(from: LocalDate, to: LocalDate, g: TrendGrain): LocalDate[] {
  const first = g === "week" ? addDays(from, -new Date(`${from}T12:00:00Z`).getUTCDay()) : `${from.slice(0, 7)}-01`;
  const out: LocalDate[] = [];
  for (let d = first; d <= to && out.length < 400; ) {
    out.push(d);
    if (g === "week") d = addDays(d, 7);
    else {
      const [y, m] = d.split("-").map(Number);
      d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    }
  }
  return out;
}

/** What the queries count; every number adds up across visits, the client counts only within one grain. */
export interface RebookCounts {
  /** Completed visits in the range. */
  visits: number;
  /** Visits with a known booked-at time: the rebook rate's base. */
  known: number;
  rebooked: number;
  /** Of those, the next visit was booked during the visit or later that day (the rest were already booked). */
  sameDay: number;
  newVisits: number;
  newKnown: number;
  newRebooked: number;
  /** Clients seen, each judged from their first visit in the range. */
  clients: number;
  judged: Record<ReturnDays | "own", number>;
  back: Record<ReturnDays | "own", number>;
  /** Clients whose first-ever visit is in the range. */
  newClients: number;
  newJudged: number;
  newBack: number;
  /** Clients seen who have a visit booked now. */
  prebookedClients: number;
  /** Booked or confirmed appointments still to come. */
  future: number;
}

export const zeroCounts = (): RebookCounts => ({
  visits: 0,
  known: 0,
  rebooked: 0,
  sameDay: 0,
  newVisits: 0,
  newKnown: 0,
  newRebooked: 0,
  clients: 0,
  judged: { 30: 0, 45: 0, 60: 0, own: 0 },
  back: { 30: 0, 45: 0, 60: 0, own: 0 },
  newClients: 0,
  newJudged: 0,
  newBack: 0,
  prebookedClients: 0,
  future: 0,
});

const ratio = (a: number, b: number) => (b ? a / b : null);

export interface RebookRates {
  rebook: number | null;
  newRebook: number | null;
  /** Back within the chosen window. */
  returned: number | null;
  back: Record<ReturnDays | "own", number | null>;
  secondVisit: number | null;
  prebooked: number | null;
}

export function rebookRates(c: RebookCounts, w: ReturnWindow): RebookRates {
  const back = { 30: ratio(c.back[30], c.judged[30]), 45: ratio(c.back[45], c.judged[45]), 60: ratio(c.back[60], c.judged[60]), own: ratio(c.back.own, c.judged.own) };
  return {
    rebook: ratio(c.rebooked, c.known),
    newRebook: ratio(c.newRebooked, c.newKnown),
    returned: back[w],
    back,
    secondVisit: ratio(c.newBack, c.newJudged),
    prebooked: ratio(c.prebookedClients, c.clients),
  };
}

/** Rates compare in points: "+4 pts", "−3 pts", "even"; null when either side has nothing. */
export function ptsLabel(x: number | null, brand: number | null): string | null {
  if (x === null || brand === null) return null;
  const p = Math.round((x - brand) * 100);
  return p === 0 ? "even" : `${p > 0 ? "+" : "−"}${Math.abs(p)} pts`;
}

export const pctText = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export const RANK_BY = {
  rebook: { label: "Rebook rate", get: (r: RebookRates) => r.rebook, base: (c: RebookCounts) => c.known },
  new_rebook: { label: "New-client rebook rate", get: (r: RebookRates) => r.newRebook, base: (c: RebookCounts) => c.newKnown },
  return: { label: "Return rate", get: (r: RebookRates) => r.returned, base: (c: RebookCounts, w: ReturnWindow) => c.judged[w] },
  second_visit: { label: "2nd-visit retention", get: (r: RebookRates) => r.secondVisit, base: (c: RebookCounts) => c.newJudged },
} as const satisfies Record<string, { label: string; get: (r: RebookRates) => number | null; base: (c: RebookCounts, w: ReturnWindow) => number }>;
export type RankBy = keyof typeof RANK_BY;
export const parseRankBy = (v: unknown): RankBy => (typeof v === "string" && Object.hasOwn(RANK_BY, v) ? (v as RankBy) : "rebook");

export interface Ranked<T> {
  item: T;
  rank: number | null;
  value: number | null;
}

/**
 * Highest first, ties by name. Anyone under MIN_RANKED_VISITS (in the measure's own base) is listed
 * after everyone ranked, without a rank, so two lucky visits don't top the board.
 */
export function rankBoard<T extends { name: string; counts: RebookCounts }>(items: readonly T[], by: RankBy, w: ReturnWindow, min = MIN_RANKED_VISITS): Ranked<T>[] {
  const d = RANK_BY[by];
  const scored = items.map((item) => ({ item, value: d.get(rebookRates(item.counts, w)), ok: d.base(item.counts, w) >= min }));
  const order = (a: (typeof scored)[number], b: (typeof scored)[number]) => (b.value ?? -1) - (a.value ?? -1) || a.item.name.localeCompare(b.item.name);
  const ranked = scored.filter((x) => x.ok && x.value !== null).sort(order);
  const rest = scored.filter((x) => !(x.ok && x.value !== null)).sort(order);
  return [...ranked.map((x, i) => ({ item: x.item, rank: i + 1, value: x.value })), ...rest.map((x) => ({ item: x.item, rank: null, value: x.value }))];
}