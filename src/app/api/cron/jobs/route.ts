import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { pruneJobs, runJobs } from "@/server/jobs";
import { cronAuthorized } from "@/server/notifications/cron";

export const maxDuration = 300;

/**
 * Vercel Cron target (see vercel.json): queues yesterday's rollup for every location and works
 * through queued background tasks (src/server/jobs.ts) until its time is up. Several runs, and the
 * local worker, share the queue safely. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const jobs = await runJobs(new Date(), { kinds: ["rollup"], budgetMs: 240_000 });
  await pruneJobs();
  return json(jobs);
});
