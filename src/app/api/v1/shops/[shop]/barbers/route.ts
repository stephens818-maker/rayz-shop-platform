import { json, options, route } from "@/server/api";
import { getShop, shopBarbers } from "@/server/catalog";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => {
  const s = await getShop(shop);
  return json({ barbers: await shopBarbers(s.id, { onlineOnly: true }) });
});
