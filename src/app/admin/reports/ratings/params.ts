import "server-only";
import { StaffContext, reportShopIds } from "@/server/auth/staff";

export type RatingsParams = { shop?: string; min?: string; period?: string };

export const PERIODS = { all: "All time", "12m": "Last 12 months", "90d": "Last 90 days" } as const;
export const MIN_RATINGS = [1, 2, 3, 5] as const;

export function resolveRatingsParams(ctx: StaffContext, p: RatingsParams, now = new Date()) {
  const shopIds = reportShopIds(ctx, p.shop ?? null);
  const min = MIN_RATINGS.find((m) => String(m) === p.min) ?? 1;
  const period = (p.period && p.period in PERIODS ? p.period : "all") as keyof typeof PERIODS;
  const days = period === "90d" ? 90 : period === "12m" ? 365 : null;
  const since = days ? new Date(now.getTime() - days * 86_400_000) : null;
  return { shopIds, min, period, since, shopParam: p.shop ?? null };
}
