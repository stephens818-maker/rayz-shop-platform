import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { allShopIds, sendLowStockAlerts } from "@/server/inventory/adjust";
import { runJobs } from "@/server/jobs";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";
import { extendSeries } from "@/server/block-series";
import { sendDueMorningDashboards } from "@/server/morning-dashboard";
import { timeClockCron } from "@/server/time-clock";
import { declarationReminderCron } from "@/server/tips/declarations";
import { onboardingReminderCron } from "@/server/tips/onboarding";
import { taxCheckReminderCron } from "@/server/tips/tracker";
import { payQuestionCron } from "@/server/pay-questions";
import { staffRetentionCron } from "@/server/staff-retention";

export const maxDuration = 300;

/**
 * Vercel Cron target (see vercel.json). Writes recurring blocks ahead, queues low-stock alerts, sends
 * the Morning Dashboard if its own cron missed it, flags forgotten clock-outs (and nightly,
 * full-time/part-time changes), reminds staff who haven't finished Stripe payout setup (and, once a year, the brand to check Stripe
 * won't file 1099s for them), reminds employees on the 1st to the 9th to declare last month's cash tips, sends unanswered pay questions to the owners, deletes signed-out phones and old punch photos (the staff privacy notice), then works through background tasks (src/server/jobs.ts): each
 * location's nudges (call-in follow-ups, Google review asks, rebook reminders set at checkout), each
 * scheduled custom report that's due, and each location's tip payout draft that's due. Then drains
 * due messages. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const recurringBlocks = await extendSeries();
  const lowStock = await sendLowStockAlerts(null, await allShopIds());
  const digest = await sendDueMorningDashboards();
  const timeClock = await timeClockCron();
  const payoutSetupReminders = await onboardingReminderCron();
  const taxFormCheck = await taxCheckReminderCron();
  const tipDeclarations = await declarationReminderCron();
  const payQuestions = await payQuestionCron();
  const staffRetention = await staffRetentionCron();
  const tasks = await runJobs(new Date(), { kinds: ["nudges", "reports", "payouts"], budgetMs: 200_000 });
  return json({ ...(await processDueJobs()), lowStock, recurringBlocks, digest, timeClock, payoutSetupReminders, taxFormCheck, tipDeclarations, payQuestions, staffRetention, tasks });
});
