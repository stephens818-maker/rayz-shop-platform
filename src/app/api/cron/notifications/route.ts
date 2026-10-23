import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { allShopIds, sendLowStockAlerts } from "@/server/inventory/adjust";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";
import { extendSeries } from "@/server/block-series";
import { runFollowUps } from "@/server/call-ins";
import { sendDueDigests } from "@/server/digest";
import { timeClockCron } from "@/server/time-clock";
import { queueReviewFollowUps } from "@/server/reviews";
import { tipPayoutCron } from "@/server/tips/payouts";

/**
 * Vercel Cron target (see vercel.json). Writes recurring blocks ahead, queues low-stock alerts, retries
 * or flags call-in outreach with no answer, sends the morning digest once it's due, flags forgotten
 * clock-outs (and nightly, full-time/part-time changes), builds the daily and weekly tip payout drafts
 * that are due, asks for Google reviews where a location's follow-up is on, then drains due jobs. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const recurringBlocks = await extendSeries();
  const lowStock = await sendLowStockAlerts(null, await allShopIds());
  const followUps = await runFollowUps();
  const digest = await sendDueDigests();
  const timeClock = await timeClockCron();
  const tipPayouts = await tipPayoutCron();
  const reviews = await queueReviewFollowUps();
  return json({ ...(await processDueJobs()), lowStock, recurringBlocks, followUps, digest, timeClock, tipPayouts, reviews });
});
