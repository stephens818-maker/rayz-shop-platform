import { and, asc, eq, inArray } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { roles, shops, staff, staffAccessShops, staffShops, type ShopStatus } from "@/db/schema";
import {
  Access,
  BRAND_ONLY,
  Grantor,
  Permission,
  ShopScope,
  UserAccessState,
  OWNER_ROLE_KEY,
  accessByShop,
  cleanOverrides,
  effectiveAccess,
  unionAccess,
} from "@/domain/permissions";

type Role = typeof roles.$inferSelect;

/** Permissions are what the person can do at any of their shops; `byShop` has each shop's. */
export interface StaffAccess extends Access {
  staffId: string;
  /** Their main role. */
  role: Role;
  scope: ShopScope;
  /** Shops this person may see and act on. */
  shopIds: string[];
  /** Archived shops stay in here, so reports and permissions still cover their history; operational lists use openShops. */
  shops: { id: string; name: string; slug: string; address: string | null; city: string | null; status: ShopStatus }[];
  /** What they may do at each of their shops, under that shop's role. */
  byShop: Map<string, Access & { role: Role }>;
  /** Their role at a shop where it isn't their main role. */
  shopRoles: Record<string, string>;
  /** The same permissions at every shop, so they can work across their shops at once. */
  uniform: boolean;
  /** Brand-only permissions the role or overrides give, which are off because the scope isn't all shops. */
  needsAllShops: Permission[];
}

/** A person's effective permissions and shop scope, straight from the database. */
export async function loadStaffAccess(staffId: string, tx: DBorTx = db): Promise<StaffAccess | null> {
  const [row] = await tx.select({ s: staff, r: roles }).from(staff).innerJoin(roles, eq(roles.id, staff.roleId)).where(eq(staff.id, staffId));
  if (!row) return null;
  return accessFor(row.s, row.r, tx);
}

export async function accessFor(s: typeof staff.$inferSelect, role: Role, tx: DBorTx = db): Promise<StaffAccess> {
  const scope: ShopScope = role.key === OWNER_ROLE_KEY ? "all" : s.shopScope;
  const overrides = cleanOverrides(s.permissionOverrides);
  const cols = { id: shops.id, name: shops.name, slug: shops.slug, address: shops.address, city: shops.city, status: shops.status };
  const shopRows: (StaffAccess["shops"][number] & { roleId: string | null })[] =
    scope === "all"
      ? (await tx.select(cols).from(shops).orderBy(asc(shops.name))).map((r) => ({ ...r, roleId: null }))
      : await tx
          .select({ ...cols, roleId: staffAccessShops.roleId })
          .from(staffAccessShops)
          .innerJoin(shops, eq(shops.id, staffAccessShops.shopId))
          .where(eq(staffAccessShops.staffId, s.id))
          .orderBy(asc(shops.name));
  const otherIds = [...new Set(shopRows.map((r) => r.roleId).filter((id): id is string => !!id && id !== role.id))];
  const others = new Map((otherIds.length ? await tx.select().from(roles).where(inArray(roles.id, otherIds)) : []).map((r) => [r.id, r]));
  const { byShop, union, uniform } = accessByShop(
    role,
    shopRows.map((r) => ({ shopId: r.id, role: (r.roleId && others.get(r.roleId)) || null })),
    overrides,
    s.maxDiscountPct,
    scope,
  );
  const shopRoles = Object.fromEntries([...byShop].filter(([, a]) => a.role.id !== role.id).map(([id, a]) => [id, a.role.id]));
  const needsAllShops =
    scope === "all" ? [] : [...unionAccess([role, ...others.values()].map((r) => effectiveAccess(r, overrides, s.maxDiscountPct))).permissions].filter((p) => BRAND_ONLY.has(p));
  return { ...union, staffId: s.id, role, scope, shopIds: shopRows.map((x) => x.id), shops: shopRows.map(({ roleId: _, ...x }) => x), byShop, shopRoles, uniform, needsAllShops };
}

/** The same person working in one of their shops: that shop's role and nothing else. */
export function atShop(a: StaffAccess, shopId: string): StaffAccess {
  const here = a.byShop.get(shopId);
  if (!here) return { ...a, permissions: new Set(), maxDiscountPct: 0, shopIds: [], shops: [] };
  return { ...a, ...here, role: a.role, shopIds: [shopId], shops: a.shops.filter((s) => s.id === shopId) };
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
