import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";

/** Vercel Cron target (see vercel.json). Drains due confirmation/reminder jobs. Closed unless CRON_SECRET is set. */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  return json(await processDueJobs());
});
