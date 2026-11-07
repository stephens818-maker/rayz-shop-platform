import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { runMilestones } from "@/server/milestones/engine";
import { cronAuthorized } from "@/server/notifications/cron";

export const maxDuration = 300;

/**
 * Vercel Cron target, hourly (see vercel.json): records the staff milestones reached since the last
 * run, logs each in the event log, and emails the brand and the person's managers about new ones.
 * Runs before the Morning Dashboard goes out. Each milestone is recorded once, so a repeated run adds
 * and sends nothing. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  return json(await runMilestones(new Date()));
});
