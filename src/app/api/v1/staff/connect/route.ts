import { json, options, route } from "@/server/api";
import { staffConnectStatus } from "@/server/mobile/staff-connect";

/** Barber recipient-account status, recent tip transfers, and payout schedule. A customer token gets an empty body. */
export const OPTIONS = options;
export const GET = route(async (req) => {
  const shop = new URL(req.url).searchParams.get("shop");
  return json(await staffConnectStatus(req, shop));
});
