import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { roles, staff } from "@/db/schema";
import { accessFor, atShop } from "../auth/access";
import type { StaffContext } from "../auth/staff";

/**
 * Someone's context without a request, for scheduled reports: their stored access across all
 * their shops when it's the same at each (as when they work over all their shops at once),
 * otherwise their first open shop under that shop's role, the way they start when they sign in.
 * Location sign-in rules don't apply: nothing is shown on a device, it's emailed to them.
 */
export async function staffContextFor(staffId: string): Promise<StaffContext | null> {
  const [row] = await db
    .select({ s: staff, r: roles })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.id, staffId), eq(staff.active, true)));
  if (!row) return null;
  const all = await accessFor(row.s, row.r);
  const open = all.shops.filter((s) => s.status !== "archived");
  const currentShopId = all.uniform ? null : (open[0]?.id ?? all.shopIds[0] ?? null);
  const access = all.uniform || !currentShopId ? all : atShop(all, currentShopId);
  const role = (currentShopId && all.byShop.get(currentShopId)?.role) || row.r;
  return {
    staff: { id: row.s.id, firstName: row.s.firstName, displayLabel: row.s.displayLabel, roleId: role.id, roleKey: role.key, roleName: role.name, kind: row.s.kind },
    actor: { staffId: row.s.id, label: `${role.name}:${row.s.displayLabel}` },
    access,
    shopIds: access.shopIds,
    shops: access.shops,
    assignedShops: open,
    combinedView: all.uniform && all.shopIds.length > 1,
    currentShopId,
    scope: access.scope,
    scopeEntityId: access.scopeEntityId,
    scopeRegionId: access.scopeRegionId,
    brandWide: access.scope === "all",
    isOwner: access.isOwner,
    permissions: access.permissions,
    maxDiscountPct: access.maxDiscountPct,
  };
}
