import { json, route } from "@/server/api";
import { sendBadgeNotices } from "@/server/customer-badges";
import { AppError } from "@/server/errors";
import { runJobs } from "@/server/jobs";
import { runAbWinners } from "@/server/marketing/engine";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";

export const maxDuration = 300;

/**
 * Vercel Cron target (see vercel.json): decides A/B tests whose time is up, then works through
 * background tasks: the automated campaigns due at each location that has them on (one task per
 * location), each lapsed sequence that's on, and each blast whose time has come (one task each, so
 * a big blast doesn't hold up the rest). Then queues Badge news
 * for badges customers just earned or lost, then drains
 * due messages. Marketing due in
 * quiet hours waits in the queue. Safe to run twice: each client gets each occasion once. Closed
 * unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const abWinners = await runAbWinners(new Date());
  const tasks = await runJobs(new Date(), { kinds: ["triggers", "campaigns"], budgetMs: 180_000 });
  const badgeNews = await sendBadgeNotices();
  return json({ ...(await processDueJobs()), marketing: { tasks, abWinners }, badgeNews });
});
