import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { allShopIds, sendLowStockAlerts } from "@/server/inventory/adjust";
import { cronAuthorized } from "@/server/notifications/cron";
import { processDueJobs } from "@/server/notifications/queue";

/** Vercel Cron target (see vercel.json). Queues low-stock alerts, then drains due jobs. Closed unless CRON_SECRET is set. */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  const lowStock = await sendLowStockAlerts(null, await allShopIds());
  return json({ ...(await processDueJobs()), lowStock });
});
