import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import type { ReportKey } from "@/domain/permissions";
import type { StaffContext } from "./auth/staff";

/** Reports that list clients or what people did stay at the shops someone works at. */
const AT_THEIR_SHOPS: ReadonlySet<ReportKey> = new Set<ReportKey>(["audit_log", "client_ratings"]);

/**
 * The context reports run under. With "See reports for every shop", someone who works at a few shops
 * reports on all of them (an owner entity's own role: all of that owner's shops). Brand-level rows
 * that belong to no shop stay for people with access to every shop, and nothing outside reports
 * widens: not the audit log or client ratings either.
 */
export async function reportContext(ctx: StaffContext, report: ReportKey): Promise<StaffContext> {
  if (ctx.brandWide || !ctx.permissions.has("reports.all_shops") || AT_THEIR_SHOPS.has(report)) return ctx;
  const role = (ctx.currentShopId && ctx.access.byShop.get(ctx.currentShopId)?.role) || ctx.access.role;
  const owner = role.ownerEntityId ?? null;
  const all = await db
    .select({ id: shops.id, name: shops.name, slug: shops.slug, address: shops.address, city: shops.city, status: shops.status })
    .from(shops)
    .where(owner ? eq(shops.ownerEntityId, owner) : undefined)
    .orderBy(asc(shops.name));
  return { ...ctx, shopIds: all.map((s) => s.id), shops: all };
}
