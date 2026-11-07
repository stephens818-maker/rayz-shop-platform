import { funnelBeacon } from "@/domain/analytics";
import { json, options, route } from "@/server/api";
import { recordFunnelStep } from "@/server/analytics";

export const OPTIONS = options;

/**
 * The booking flow reports each step here (page opened, service, barber, time, details, booked) so
 * the event log has the funnel and where visitors drop off. Anonymous: the funnel id is random,
 * and only the booked step, which names its fresh appointment, ties it to a client.
 */
export const POST = route(async (req) => {
  const body = funnelBeacon.parse(await req.json().catch(() => ({})));
  return json(await recordFunnelStep(body, req.headers.get("user-agent")));
});
