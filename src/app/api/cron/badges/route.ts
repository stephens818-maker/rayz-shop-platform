import { json, route } from "@/server/api";
import { runBadgeJob } from "@/server/badges";
import { AppError } from "@/server/errors";
import { cronAuthorized } from "@/server/notifications/cron";

export const maxDuration = 300;

/**
 * Vercel Cron target (see vercel.json): recomputes the cached client badges that are missing or
 * from an earlier day, in batches, until its time is up. It runs several times overnight, so a big
 * client file finishes across runs; each run picks up where the last stopped. Closed unless
 * CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  return json(await runBadgeJob(new Date(), { budgetMs: 240_000 }));
});
