import { json, options, query, route } from "@/server/api";
import { AvailableDaysQuery } from "@/server/api-schemas";
import { getAvailableDays } from "@/server/booking";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (req, { shop }) => {
  const q = query(req, AvailableDaysQuery);
  const days = await getAvailableDays({
    shopRef: shop,
    from: q.from,
    days: q.days,
    serviceId: q.serviceId,
    addonIds: q.addonIds ? q.addonIds.split(",").filter(Boolean) : [],
    barberRef: q.barber ?? "any",
  });
  return json({ days });
});
