import { json, route } from "@/server/api";
import { sendBadgeNotices } from "@/server/customer-badges";
import { AppError } from "@/server/errors";
import { runJobs } from "@/server/jobs";
import { runMarketing } from "@/server/marketing/engine";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";

export const maxDuration = 300;

/**
 * Vercel Cron target (see vercel.json): queues the automated campaigns that are due at each location
 * that has them on (one background task per location, so it scales with the number of locations), the lapsed sequences that are on, the blasts whose time has come and Badge news
 * for badges customers just earned or lost, then drains
 * due messages. Marketing due in
 * quiet hours waits in the queue. Safe to run twice: each client gets each occasion once. Closed
 * unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const triggers = await runJobs(new Date(), { kinds: ["triggers"], budgetMs: 150_000 });
  const marketing = await runMarketing(new Date(), { triggers: false });
  const badgeNews = await sendBadgeNotices();
  return json({ ...(await processDueJobs()), marketing: { ...marketing, triggers }, badgeNews });
});
