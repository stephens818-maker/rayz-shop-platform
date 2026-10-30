import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { renewSimulatedMemberships } from "@/server/memberships";
import { cronAuthorized } from "@/server/notifications/cron";

/**
 * Vercel Cron target, daily (see vercel.json): without Stripe keys, renews memberships whose month is up
 * and ends those set to cancel. With Stripe, Stripe Billing renews them and the webhook records it, so
 * this finds nothing to do. Closed unless CRON_SECRET is set.
 */
export const GET = route(async (req) => {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) throw new AppError("unauthorized", "Bad or missing cron secret");
  return json(await renewSimulatedMemberships(new Date()));
});
