import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { clientContactGrants, roles, shops, staff, staffAccessShops, staffShops, type ShopStatus } from "@/db/schema";
import { ContactGrant, HeldGrants, heldGrants, kindsAt, withGrantKinds } from "@/domain/contact-grants";
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
  sameAccess,
  sharedLoginAccess,
  unionAccess,
} from "@/domain/permissions";
import { localValues } from "../brand-sync/store";

type Role = typeof roles.$inferSelect;

/** Permissions are what the person can do at any of their shops; `byShop` has each shop's. */
export interface StaffAccess extends Access {
  staffId: string;
  /** Their main role. */
  role: Role;
  scope: ShopScope;
  /** The owner entity an entity scope covers. */
  scopeEntityId: string | null;
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
  /** Contact access grants in force for them; see contact-grants.ts. */
  grants: HeldGrants;
  /** Permissions only a contact access grant gives them, left out when comparing what people may grant. */
  granted: ReadonlySet<Permission>;
}

async function grantsInForce(staffId: string, shopIds: string[], tx: DBorTx): Promise<ContactGrant[]> {
  const now = new Date();
  return tx
    .select({ id: clientContactGrants.id, kind: clientContactGrants.kind, staffId: clientContactGrants.staffId, shopId: clientContactGrants.shopId, expiresAt: clientContactGrants.expiresAt, revokedAt: clientContactGrants.revokedAt })
    .from(clientContactGrants)
    .where(
      and(
        isNull(clientContactGrants.revokedAt),
        or(isNull(clientContactGrants.expiresAt), gt(clientContactGrants.expiresAt, now)),
        or(eq(clientContactGrants.staffId, staffId), shopIds.length ? inArray(clientContactGrants.shopId, shopIds) : undefined),
      ),
    );
}

/** Each shop's access with the grants held there, and what they can do somewhere. */
function applyGrants<A extends Access>(byShop: Map<string, A>, union: Access, held: HeldGrants) {
  const granted = new Map([...byShop].map(([id, a]) => [id, withGrantKinds(a, kindsAt(held, id))] as const));
  const list = [...granted.values()];
  return { byShop: granted, union: list.length ? unionAccess(list) : withGrantKinds(union, held.everywhere), uniform: list.every((x) => sameAccess(x, list[0])) };
}

/** A person's effective permissions and shop scope, straight from the database. */
export async function loadStaffAccess(staffId: string, tx: DBorTx = db): Promise<StaffAccess | null> {
  const [row] = await tx.select({ s: staff, r: roles }).from(staff).innerJoin(roles, eq(roles.id, staff.roleId)).where(eq(staff.id, staffId));
  if (!row) return null;
  return accessFor(row.s, row.r, tx);
}

export async function accessFor(s: typeof staff.$inferSelect, role: Role, tx: DBorTx = db): Promise<StaffAccess> {
  const scope: ShopScope = role.key === OWNER_ROLE_KEY ? "all" : s.shopScope;
  const scopeEntityId = scope === "entity" ? s.scopeEntityId : null;
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
  // A shop can run its own version of a role the brand synced to it (Setup → Sync status), for
  // everyone working there under the role, brand-wide people included. Brand-only permissions work
  // on what every shop shares, so they stay the brand role's.
  const variants = role.key === OWNER_ROLE_KEY ? new Map<string, { permissions: string[]; maxDiscountPct: number }>() : await localValues<{ permissions: string[]; maxDiscountPct: number }>("role", shopRows.map((r) => r.id), tx);
  const roleAt = (shopId: string, r: Role | null): Role | null => {
    const base = r ?? role;
    const v = variants.get(`${shopId}|${base.id}`);
    if (!v) return r;
    return { ...base, permissions: [...new Set([...v.permissions.filter((p) => !BRAND_ONLY.has(p as Permission)), ...base.permissions.filter((p) => BRAND_ONLY.has(p as Permission))])], maxDiscountPct: v.maxDiscountPct };
  };
  const computed = accessByShop(
    role,
    shopRows.map((r) => ({ shopId: r.id, role: roleAt(r.id, (r.roleId && others.get(r.roleId)) || null) })),
    overrides,
    s.maxDiscountPct,
    scope,
  );
  const base =
    s.kind === "shop"
      ? { byShop: new Map([...computed.byShop].map(([id, a]) => [id, sharedLoginAccess(a)] as const)), union: sharedLoginAccess(computed.union), uniform: computed.uniform }
      : computed;
  const grants = heldGrants(await grantsInForce(s.id, shopRows.map((r) => r.id), tx), s.id);
  const { byShop, union, uniform } = applyGrants(base.byShop, base.union, grants);
  const granted = new Set([...union.permissions].filter((p) => !base.union.permissions.has(p)));
  const shopRoles = Object.fromEntries([...byShop].filter(([, a]) => a.role.id !== role.id).map(([id, a]) => [id, a.role.id]));
  const needsAllShops =
    scope === "all" ? [] : [...unionAccess([role, ...others.values()].map((r) => effectiveAccess(r, overrides, s.maxDiscountPct))).permissions].filter((p) => BRAND_ONLY.has(p));
  return { ...union, staffId: s.id, role, scope, scopeEntityId, shopIds: shopRows.map((x) => x.id), shops: shopRows.map(({ roleId: _, ...x }) => x), byShop, shopRoles, uniform, needsAllShops, grants, granted };
}

/** The same person working in one of their shops: that shop's role and nothing else. */
export function atShop(a: StaffAccess, shopId: string): StaffAccess {
  const here = a.byShop.get(shopId);
  if (!here) return { ...a, permissions: new Set(), maxDiscountPct: 0, shopIds: [], shops: [] };
  return { ...a, ...here, role: a.role, shopIds: [shopId], shops: a.shops.filter((s) => s.id === shopId) };
}

/**
 * The same person with some of their shops out of reach (a location's sign-in restriction). Brand-only
 * permissions work on records every shop shares, so losing any shop takes them away too; an owner
 * entity scope no longer covers the whole entity, so it's chosen shops for this request.
 */
export function withoutShops(a: StaffAccess, drop: ReadonlySet<string>): StaffAccess {
  if (!drop.size || !a.shopIds.some((id) => drop.has(id))) return a;
  // Grants are re-applied after narrowing: a grant isn't a brand-only permission, so losing a shop doesn't take it away.
  const narrow = <T extends Access>(x: T, shopId: string): T =>
    a.scope === "all" ? withGrantKinds({ ...x, permissions: new Set([...x.permissions].filter((p) => !BRAND_ONLY.has(p))) }, kindsAt(a.grants, shopId)) : x;
  const byShop = new Map([...a.byShop].filter(([id]) => !drop.has(id)).map(([id, x]) => [id, narrow(x, id)] as const));
  const list = [...byShop.values()];
  const union: Access = list.length ? unionAccess(list) : { isOwner: false, permissions: new Set(), maxDiscountPct: 0 };
  return {
    ...a,
    ...union,
    scope: a.scope === "all" || a.scope === "entity" ? "selected" : a.scope,
    scopeEntityId: null,
    shopIds: a.shopIds.filter((id) => !drop.has(id)),
    shops: a.shops.filter((s) => !drop.has(s.id)),
    byShop,
    shopRoles: Object.fromEntries(Object.entries(a.shopRoles).filter(([id]) => !drop.has(id))),
    uniform: list.every((x) => sameAccess(x, list[0])),
    needsAllShops: a.scope === "all" ? [...a.permissions].filter((p) => BRAND_ONLY.has(p)) : a.needsAllShops,
  };
}

/** What they may give others: never what only a contact access grant gives them. */
export const grantor = (
  a: Pick<StaffAccess, "staffId" | "isOwner" | "permissions" | "maxDiscountPct" | "scope" | "shopIds"> & Partial<Pick<StaffAccess, "scopeEntityId">> & { granted?: ReadonlySet<Permission> },
): Grantor => ({
  staffId: a.staffId,
  isOwner: a.isOwner,
  permissions: a.granted?.size ? new Set([...a.permissions].filter((p) => !a.granted!.has(p))) : a.permissions,
  maxDiscountPct: a.maxDiscountPct,
  scope: a.scope,
  shopIds: a.shopIds,
  scopeEntityId: a.scopeEntityId ?? null,
});

/** What their role and overrides give, without contact access grants (those are managed apart). */
export const accessState = (a: StaffAccess): UserAccessState => ({
  staffId: a.staffId,
  isOwner: a.isOwner,
  permissions: a.granted.size ? new Set([...a.permissions].filter((p) => !a.granted.has(p))) : a.permissions,
  maxDiscountPct: a.maxDiscountPct,
  scope: a.scope,
  shopIds: a.shopIds,
  scopeEntityId: a.scopeEntityId,
});

export async function workShopIds(staffId: string, tx: DBorTx = db) {
  return (await tx.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
}

export async function roleByKey(key: string, tx: DBorTx = db) {
  const r = await tx.query.roles.findFirst({ where: eq(roles.key, key) });
  if (!r) throw new Error(`Role template "${key}" is missing; run the migrations`);
  return r;
}

/** Brand Owners who can sign in: active, signed up and not removed. */
export async function activeOwnerCount(tx: DBorTx = db) {
  const rows = await tx
    .select({ id: staff.id })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(roles.key, "brand_owner"), eq(staff.active, true), isNotNull(staff.passwordHash), isNull(staff.removedAt)));
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
