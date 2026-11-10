import { json, route } from "@/server/api";
import { dropCustomerMoves, exportToWarehouse, loadAnalyticsSettings, runBackfill, sweepAbandonedFunnels } from "@/server/analytics";
import { AppError } from "@/server/errors";
import { cronAuthorized } from "@/server/notifications/cron";

export const maxDuration = 300;

/**
 * Nightly (see vercel.json): logs booking funnels left without a booking, logs history from
 * before the event log until every table is done (picking up where the last night stopped), then
 * copies the day's events to the warehouse when that's on. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const abandoned = await sweepAbandonedFunnels();
  const backfill = await runBackfill({ budgetMs: 120_000 });
  const settings = await loadAnalyticsSettings();
  const warehouse = settings.warehouse ? await exportToWarehouse({ budgetMs: 120_000 }) : (await dropCustomerMoves(), { skipped: "off" });
  return json({ abandoned, backfill, warehouse });
});
