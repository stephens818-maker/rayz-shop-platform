import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import type { StaffContext } from "./auth/staff";

/**
 * The context reports run under. With "See reports for every shop", someone who works at a few shops
 * reports on all of them (an owner entity's own role: all of that owner's shops). Brand-level rows
 * that belong to no shop stay for people with access to every shop, and nothing outside reports
 * widens.
 */
export async function reportContext(ctx: StaffContext): Promise<StaffContext> {
  if (ctx.brandWide || !ctx.permissions.has("reports.all_shops")) return ctx;
  const role = (ctx.currentShopId && ctx.access.byShop.get(ctx.currentShopId)?.role) || ctx.access.role;
  const owner = role.ownerEntityId ?? null;
  const all = await db
    .select({ id: shops.id, name: shops.name, slug: shops.slug, address: shops.address, city: shops.city, status: shops.status })
    .from(shops)
    .where(owner ? eq(shops.ownerEntityId, owner) : undefined)
    .orderBy(asc(shops.name));
  return { ...ctx, shopIds: all.map((s) => s.id), shops: all };
}
