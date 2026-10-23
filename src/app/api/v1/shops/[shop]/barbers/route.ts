import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { json, options, route } from "@/server/api";
import { getShop, shopBarbers } from "@/server/catalog";

export const OPTIONS = options;
export const GET = route<{ shop: string }>(async (_req, { shop }) => {
  const s = await getShop(shop);
  const rows = await shopBarbers(s.id, { onlineOnly: true });
  const ids = rows.map((r) => r.id);
  const names = ids.length ? await db.select({ id: staff.id, firstName: staff.firstName }).from(staff).where(inArray(staff.id, ids)) : [];
  const first = new Map(names.map((n) => [n.id, n.firstName]));
  return json({ barbers: rows.map((r) => ({ ...r, displayName: first.get(r.id) || r.displayName })) });
});
