import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { sendDueMorningDashboards } from "@/server/morning-dashboard";
import { cronAuthorized } from "@/server/notifications/cron";
import { loadDisplay } from "@/server/display";

export const maxDuration = 300;

/**
 * Vercel Cron target, every minute (see vercel.json): once the brand's send time has passed (7:02 AM
 * shop time by default), builds and sends each recipient's Morning Dashboard that hasn't gone out
 * today. Safe to run again and again: each person, version and channel goes out once a day. Closed
 * unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  await loadDisplay();
  return json(await sendDueMorningDashboards());
});
