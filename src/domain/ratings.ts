/** Staff-only client ratings: 1–5 stars per visit with an optional private note. */

export const RATING_NOTE_MAX = 500;

/** Appointment statuses that count as a visit someone can rate (a no-show can be rated too). */
export const RATEABLE_APPOINTMENT_STATUSES = ["checked_in", "in_service", "completed", "no_show"] as const;
/** Ticket statuses that count as a visit (open and voided tickets don't). */
export const RATEABLE_SALE_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

/** What the signed-in person may do with ratings, from their permissions. */
export interface RatingViewer {
  staffId: string;
  shopIds: string[];
  /** clients.rate */
  canRate: boolean;
  /** clients.ratings_all: every rating and note, and any visit at their shops. */
  seesAll: boolean;
  /** clients.ratings_moderate: remove anyone's rating. */
  moderates: boolean;
}

export interface RatingSummary {
  avg: number;
  count: number;
}

export function cleanRating(input: { stars: unknown; note?: unknown }): { stars: number; note: string | null } | { error: string } {
  const raw = input.stars;
  const stars = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: "Pick 1 to 5 stars" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > RATING_NOTE_MAX) return { error: `Keep the note under ${RATING_NOTE_MAX} characters` };
  return { stars, note: note || null };
}

/**
 * Who may rate a visit: someone who sees every rating may rate any visit at their shops; anyone
 * else only visits they served (they booked the chair or rang up the ticket).
 */
export function rateVisitDenied(viewer: RatingViewer, visit: { shopId: string; servedBy: (string | null)[] }): string | null {
  if (!viewer.canRate) return "You don't have permission to rate clients";
  if (!viewer.shopIds.includes(visit.shopId)) return "That visit was at a shop outside your access";
  if (viewer.seesAll) return null;
  return visit.servedBy.includes(viewer.staffId) ? null : "You can only rate visits you served";
}

/** Everyone edits only their own ratings. */
export function editRatingDenied(viewer: RatingViewer, rating: { staffId: string }): string | null {
  return rating.staffId === viewer.staffId ? null : "You can only change your own ratings";
}

/** The author can remove their rating; a moderator can remove any at their shops (for a note that shouldn't be there). */
export function deleteRatingDenied(viewer: RatingViewer, rating: { staffId: string; shopId: string }): string | null {
  if (rating.staffId === viewer.staffId) return null;
  if (viewer.moderates && viewer.shopIds.includes(rating.shopId)) return null;
  return "You can only remove your own ratings";
}

/** Managers read every rating and note; everyone else reads the average plus their own. */
export const seesAllRatings = (viewer: Pick<RatingViewer, "seesAll">) => viewer.seesAll;

export const formatAverage = (avg: number) => (Math.round(avg * 10) / 10).toFixed(1);

export function ratingTone(avg: number): "red" | "amber" | "green" {
  if (avg < 3) return "red";
  if (avg < 4) return "amber";
  return "green";
}

export const RATING_FILTERS = {
  rated: "Rated",
  low: "Under 3 stars",
  high: "4 stars and up",
  unrated: "Not rated",
} as const;
export type RatingFilter = keyof typeof RATING_FILTERS;

export const CLIENT_SORTS = {
  recent: "Newest clients",
  rating_desc: "Highest rated",
  rating_asc: "Lowest rated",
} as const;
export type ClientSort = keyof typeof CLIENT_SORTS;

export const parseRatingFilter = (v: string | undefined): RatingFilter | null => (v && v in RATING_FILTERS ? (v as RatingFilter) : null);
export const parseClientSort = (v: string | undefined): ClientSort => (v && v in CLIENT_SORTS ? (v as ClientSort) : "recent");

/**
 * How many clients go in the lowest and highest lists for a shop with `rated` clients, so a small
 * shop never shows the same client in both.
 */
export function splitLowHigh(rated: number, limit: number): { lowest: number; highest: number } {
  const lowest = Math.min(limit, Math.ceil(rated / 2));
  return { lowest, highest: Math.min(limit, rated - lowest) };
}
