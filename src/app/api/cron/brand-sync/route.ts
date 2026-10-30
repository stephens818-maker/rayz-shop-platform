import { json, route } from "@/server/api";
import { runDueSyncs } from "@/server/brand-sync/engine";
import { AppError } from "@/server/errors";
import { cronAuthorized } from "@/server/notifications/cron";

/**
 * Vercel Cron target, every 5 minutes (see vercel.json): runs brand syncs scheduled for now or
 * earlier, each as whoever scheduled it. The Sync status page and the next brand change also run
 * any that are due. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  return json(await runDueSyncs(new Date()));
});
