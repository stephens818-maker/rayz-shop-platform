/**
 * The client list's filters are Campaign Center segments (SegmentSchema): one set of filters for
 * finding clients and for messaging them. These are the pure helpers around them.
 */
import { DateTime } from "luxon";
import type { Level } from "./client-privacy";
import { EMPTY_SEGMENT, SegmentSchema, type FilterSees, type Segment } from "./marketing";

/** "MM-DD" of every day from today through `days` days out; Feb 29 birthdays count on Feb 28 in other years. */
export function upcomingBirthdayKeys(today: string, days: number): string[] {
  const start = DateTime.fromISO(today);
  const keys = new Set<string>();
  for (let i = 0; i <= days; i++) {
    const d = start.plus({ days: i });
    keys.add(d.toFormat("MM-dd"));
    if (d.month === 2 && d.day === 28 && !d.isInLeapYear) keys.add("02-29");
  }
  return [...keys];
}

/** Only what differs from no filter, so a saved search or a link stays short. */
export function compactSegment(s: Segment): Partial<Segment> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (JSON.stringify(v) !== JSON.stringify((EMPTY_SEGMENT as Record<string, unknown>)[k])) out[k] = v;
  return out as Partial<Segment>;
}

/** The `f` URL parameter: the compact segment as base64url JSON. */
export function encodeFilter(s: Segment): string {
  const c = compactSegment(s);
  if (!Object.keys(c).length) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The `f` URL parameter back; anything unreadable is no filter. */
export function decodeFilter(raw: string | null | undefined): Segment {
  if (!raw) return EMPTY_SEGMENT;
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const r = SegmentSchema.safeParse(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))));
    return r.success ? r.data : EMPTY_SEGMENT;
  } catch {
    return EMPTY_SEGMENT;
  }
}

export interface FilterOptions {
  shops: Option[];
  barbers: Option[];
  items: Option[];
  tags: string[];
  promos: Option[];
  campaigns: Option[];
  sources: string[];
  customFields: Option[];
  /** The badges they see, by key. */
  badges: Option[];
}

type Option = { id: string; name: string };

/** What the filter panel may offer, from the person's levels: see segmentProblem. */
export interface PanelSees {
  levels: Record<string, Level>;
  /** Spend, tips and gift cards: people with every client. */
  money: boolean;
  /** Badge keys they see. */
  badges?: string[];
}

/** segmentProblem's view of a person. */
export const filterSees = (s: PanelSees): FilterSees => ({
  birthday: s.levels.birthday !== "hidden",
  ratings: s.levels.ratings !== "hidden",
  preferredBarber: s.levels.preferred_barber !== "hidden",
  level: (f) => s.levels[f] ?? "hidden",
  money: s.money,
  badges: s.badges,
});

