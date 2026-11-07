import "server-only";
import { localDateOf, todayLocal } from "@/lib/time";
import { StaffContext } from "@/server/auth/staff";
import { resolveBarberView, resolveLocations } from "../scope";

export type RatingsParams = { shop?: string | string[]; staff?: string | string[]; view?: string; min?: string; period?: string; table?: string };

export const PERIODS = { all: "All time", "12m": "Last 12 months", "90d": "Last 90 days" } as const;
export const MIN_RATINGS = [1, 2, 3, 5] as const;

/** "All time" for the ratings-given table: before any rating could have been given. */
const BEGINNING = "2020-01-01";

export async function resolveRatingsParams(ctx: StaffContext, p: RatingsParams, now = new Date()) {
  const locations = await resolveBarberView(ctx, p, "client_ratings", await resolveLocations(ctx, p));
  const min = MIN_RATINGS.find((m) => String(m) === p.min) ?? 1;
  const period = (p.period && p.period in PERIODS ? p.period : "all") as keyof typeof PERIODS;
  const days = period === "90d" ? 90 : period === "12m" ? 365 : null;
  const since = days ? new Date(now.getTime() - days * 86_400_000) : null;
  const shopIds = locations.selection.shopIds;
  /** Combined ranks clients across the selected shops; by location ranks them at each shop. Only ratings by the selected barbers count. */
  const query = {
    shopIds,
    staffIds: locations.staffIds,
    minRatings: min,
    since,
    limit: 10,
    combined: locations.loc.view === "combined" && shopIds.length > 1 ? { label: locations.label } : null,
  };
  const scope = { shopIds, staffIds: locations.staffIds, from: since ? localDateOf(since) : BEGINNING, to: todayLocal() };
  return { ...locations, shopIds, min, period, since, query, scope };
}
