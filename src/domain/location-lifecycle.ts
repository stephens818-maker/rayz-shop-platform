/**
 * A location's life: set up (hidden from clients), live, temporarily closed, archived. Pure: what
 * each status allows, which moves are allowed, and the booking slug rules. src/server/location-admin.ts
 * does the work.
 */
import type { ShopStatus } from "@/db/schema";
import { slugify } from "@/lib/ids";
import type { LocalDate } from "@/lib/time";

export const SHOP_STATUS_LABEL: Record<ShopStatus, string> = { setup: "Setting up", live: "Live", closed: "Temporarily closed", archived: "Archived" };

export const NEXT_STATUSES: Record<ShopStatus, ShopStatus[]> = {
  setup: ["live", "archived"],
  live: ["closed", "archived"],
  closed: ["live", "archived"],
  archived: [],
};

export const canMove = (from: ShopStatus, to: ShopStatus) => NEXT_STATUSES[from].includes(to);

interface ShopLike {
  status: ShopStatus;
  bookingEnabled: boolean;
  closedUntil?: LocalDate | null;
}

/** A temporary closure with an end date is over once that date has passed. */
export function effectiveStatus(s: ShopLike, today: LocalDate): ShopStatus {
  return s.status === "closed" && s.closedUntil && s.closedUntil < today ? "live" : s.status;
}

/** Clients see it on the website and app: live or temporarily closed (with the closure note). */
export const listedPublicly = (s: Pick<ShopLike, "status">) => s.status === "live" || s.status === "closed";

/** Clients can book online. */
export const takesOnlineBookings = (s: ShopLike, today: LocalDate) => effectiveStatus(s, today) === "live" && s.bookingEnabled;

/** Closed for business on this date: archived, or inside a temporary closure. */
export function closedOn(s: Pick<ShopLike, "status" | "closedUntil">, date: LocalDate): boolean {
  if (s.status === "archived") return true;
  return s.status === "closed" && (!s.closedUntil || date <= s.closedUntil);
}

/** Staff can book, check out and move stock. Setup shops can, for practice runs before go-live. */
export const operational = (s: Pick<ShopLike, "status">) => s.status !== "archived";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Why a booking link slug can't be used, or null. Links are public, so they never carry a staff
 * member's or client's surname.
 */
export function slugProblem(slug: string, surnames: readonly (string | null | undefined)[]): string | null {
  if (!slug) return "Give the location a booking link name";
  if (slug.length < 3 || slug.length > 40) return "The booking link name must be 3 to 40 characters";
  if (!SLUG_RE.test(slug)) return "Use lowercase letters, numbers and single dashes in the booking link name";
  const words = new Set(slug.split("-"));
  for (const raw of surnames) {
    const parts = slugify(raw ?? "").split("-").filter((p) => p.length >= 3);
    if (parts.length && parts.every((p) => words.has(p))) return "The booking link can't contain a surname. Use the town or street instead.";
  }
  return null;
}

/** Checklist steps that must be done before a location goes live; the rest are recommended. */
export const REQUIRED_FOR_LIVE = ["details", "timezone", "owner", "hours", "taxes", "menu", "team", "payments", "slug"] as const;
export type RequiredStep = (typeof REQUIRED_FOR_LIVE)[number];

export interface StepState {
  key: string;
  done: boolean;
}

/** Steps still blocking go-live. Card payments can be waived to open cash-only. */
export function goLiveBlockers(steps: readonly StepState[], o: { cashOnly?: boolean } = {}): string[] {
  const need = new Set<string>(REQUIRED_FOR_LIVE);
  if (o.cashOnly) need.delete("payments");
  return steps.filter((s) => need.has(s.key) && !s.done).map((s) => s.key);
}

export const US_TIMEZONES = [
  { id: "America/Chicago", label: "Central" },
  { id: "America/New_York", label: "Eastern" },
  { id: "America/Denver", label: "Mountain" },
  { id: "America/Phoenix", label: "Arizona" },
  { id: "America/Los_Angeles", label: "Pacific" },
  { id: "America/Anchorage", label: "Alaska" },
  { id: "Pacific/Honolulu", label: "Hawaii" },
] as const;

/** Every shop runs on this zone today (src/lib/time.ts); a location elsewhere can't go live until that changes. */
export const SUPPORTED_TIMEZONE = "America/Chicago";

export const DEFAULT_HOURS: { weekday: number; openMin: number; closeMin: number }[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  openMin: 9 * 60,
  closeMin: weekday === 6 ? 15 * 60 : 19 * 60,
}));

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "D.C.", FL: "Florida",
  GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export const stateName = (code: string) => STATES[code.toUpperCase()] ?? code;

export const cutoffLabel = (min: number) => (min % 60 === 0 && min >= 60 ? `${min / 60} hour${min === 60 ? "" : "s"}` : `${min} minutes`);
