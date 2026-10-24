import { json, options, query, route } from "@/server/api";
import { AvailabilityQuery } from "@/server/api-schemas";
import { getAvailability } from "@/server/booking";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (req, { shop }) => {
  const q = query(req, AvailabilityQuery);
  const r = await getAvailability({
    shopRef: shop,
    date: q.date,
    serviceId: q.serviceId,
    addonIds: q.addonIds ? q.addonIds.split(",").filter(Boolean) : [],
    barberRef: q.barber ?? "any",
  });
  return json({ shopId: r.shopId, date: q.date, durationMin: r.durationMin, estimateCents: r.estimateCents, slots: r.slots, reason: r.reason });
});
