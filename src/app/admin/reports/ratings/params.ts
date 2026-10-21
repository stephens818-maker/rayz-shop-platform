import "server-only";
import { StaffContext } from "@/server/auth/staff";
import { resolveLocations } from "../scope";

export type RatingsParams = { shop?: string | string[]; view?: string; min?: string; period?: string };

export const PERIODS = { all: "All time", "12m": "Last 12 months", "90d": "Last 90 days" } as const;
export const MIN_RATINGS = [1, 2, 3, 5] as const;

export async function resolveRatingsParams(ctx: StaffContext, p: RatingsParams, now = new Date()) {
  const locations = await resolveLocations(ctx, p);
  const min = MIN_RATINGS.find((m) => String(m) === p.min) ?? 1;
  const period = (p.period && p.period in PERIODS ? p.period : "all") as keyof typeof PERIODS;
  const days = period === "90d" ? 90 : period === "12m" ? 365 : null;
  const since = days ? new Date(now.getTime() - days * 86_400_000) : null;
  const shopIds = locations.selection.shopIds;
  /** Combined ranks clients across the selected shops; by location ranks them at each shop. */
  const query = { shopIds, minRatings: min, since, limit: 10, combined: locations.loc.view === "combined" && shopIds.length > 1 ? { label: locations.label } : null };
  return { ...locations, shopIds, min, period, since, query };
}
