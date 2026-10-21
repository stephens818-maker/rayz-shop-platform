import { and, asc, eq, inArray } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { roles, shops, staff, staffAccessShops, staffShops } from "@/db/schema";
import { Access, BRAND_ONLY, Grantor, Permission, ShopScope, UserAccessState, OWNER_ROLE_KEY, cleanOverrides, effectiveAccess } from "@/domain/permissions";

export interface StaffAccess extends Access {
  staffId: string;
  role: typeof roles.$inferSelect;
  scope: ShopScope;
  /** Shops this person may see and act on. */
  shopIds: string[];
  shops: { id: string; name: string; slug: string; address: string | null; city: string | null }[];
  /** Brand-only permissions the role or overrides give, which are off because the scope isn't all shops. */
  needsAllShops: Permission[];
}

/** A person's effective permissions and shop scope, straight from the database. */
export async function loadStaffAccess(staffId: string, tx: DBorTx = db): Promise<StaffAccess | null> {
  const [row] = await tx.select({ s: staff, r: roles }).from(staff).innerJoin(roles, eq(roles.id, staff.roleId)).where(eq(staff.id, staffId));
  if (!row) return null;
  return accessFor(row.s, row.r, tx);
}

export async function accessFor(s: typeof staff.$inferSelect, role: typeof roles.$inferSelect, tx: DBorTx = db): Promise<StaffAccess> {
  const scope: ShopScope = role.key === OWNER_ROLE_KEY ? "all" : s.shopScope;
  const a = effectiveAccess(role, cleanOverrides(s.permissionOverrides), s.maxDiscountPct, scope);
  const needsAllShops = scope === "all" ? [] : [...effectiveAccess(role, cleanOverrides(s.permissionOverrides), s.maxDiscountPct).permissions].filter((p) => BRAND_ONLY.has(p));
  const cols = { id: shops.id, name: shops.name, slug: shops.slug, address: shops.address, city: shops.city };
  const shopRows =
    scope === "all"
      ? await tx.select(cols).from(shops).orderBy(asc(shops.name))
      : await tx.select(cols).from(staffAccessShops).innerJoin(shops, eq(shops.id, staffAccessShops.shopId)).where(eq(staffAccessShops.staffId, s.id)).orderBy(asc(shops.name));
  return { ...a, staffId: s.id, role, scope, shopIds: shopRows.map((x) => x.id), shops: shopRows, needsAllShops };
}

export const grantor = (a: Pick<StaffAccess, "staffId" | "isOwner" | "permissions" | "maxDiscountPct" | "scope" | "shopIds">): Grantor => ({
  staffId: a.staffId,
  isOwner: a.isOwner,
  permissions: a.permissions,
  maxDiscountPct: a.maxDiscountPct,
  scope: a.scope,
  shopIds: a.shopIds,
});

export const accessState = (a: StaffAccess): UserAccessState => ({
  staffId: a.staffId,
  isOwner: a.isOwner,
  permissions: a.permissions,
  maxDiscountPct: a.maxDiscountPct,
  scope: a.scope,
  shopIds: a.shopIds,
});

export async function workShopIds(staffId: string, tx: DBorTx = db) {
  return (await tx.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
}

export async function roleByKey(key: string, tx: DBorTx = db) {
  const r = await tx.query.roles.findFirst({ where: eq(roles.key, key) });
  if (!r) throw new Error(`Role template "${key}" is missing; run the migrations`);
  return r;
}

export async function activeOwnerCount(tx: DBorTx = db) {
  const rows = await tx
    .select({ id: staff.id })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(roles.key, "brand_owner"), eq(staff.active, true)));
  return rows.length;
}

/** Staff whose access includes one of these shops (or every shop). */
export async function staffWithAccessTo(shopIds: string[], tx: DBorTx = db) {
  if (!shopIds.length) return [];
  const viaShop = await tx.selectDistinct({ id: staffAccessShops.staffId }).from(staffAccessShops).where(inArray(staffAccessShops.shopId, shopIds));
  const brand = await tx.select({ id: staff.id }).from(staff).where(eq(staff.shopScope, "all"));
  return [...new Set([...viaShop, ...brand].map((r) => r.id))];
}

export const has = (a: { permissions: ReadonlySet<Permission> }, p: Permission) => a.permissions.has(p);
