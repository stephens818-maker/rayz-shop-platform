"use server";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { roles, shops, staff, staffAccessShops } from "@/db/schema";
import {
  OWNER_ROLE_KEY,
  Permission,
  RoleDef,
  SHOP_SCOPES,
  accessByShop,
  cleanOverrides,
  diffPermissions,
  effectiveAccess,
  isBrandLevelPerson,
  isPermission,
  roleChangeDenied,
  templateFor,
  templateRow,
  userAccessChangeDenied,
} from "@/domain/permissions";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { accessState, activeOwnerCount, loadStaffAccess } from "@/server/auth/access";
import { authorize, staffGrantor } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { entityShopIds, resolveEntityScope } from "@/server/owner-entities";

const asDef = (r: typeof roles.$inferSelect): RoleDef => ({ key: r.key, name: r.name, permissions: r.permissions, maxDiscountPct: r.maxDiscountPct, brandLevel: r.brandLevel });
const permsOf = (r: RoleDef) => [...effectiveAccess(r).permissions];

function revalidate() {
  revalidatePath("/admin", "layout");
}

const RoleSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().trim().min(2, "Give the role a name").max(40),
  description: z.string().trim().max(300).optional().default(""),
  permissions: z.array(z.string()).transform((xs) => [...new Set(xs.filter(isPermission))]),
  maxDiscountPct: z.number().int().min(0).max(100),
  defaultScope: z.enum(SHOP_SCOPES),
  /** Custom roles only; left as it is when not sent. */
  brandLevel: z.boolean().optional(),
});

/** Create or edit a role. Changes apply to everyone with the role on their next request. */
export async function saveRoleAction(raw: z.input<typeof RoleSchema>) {
  return safe(async () => {
    const ctx = await authorize("permissions.manage");
    const p = RoleSchema.parse(raw);
    const before = p.id ? await db.query.roles.findFirst({ where: eq(roles.id, p.id) }) : null;
    if (p.id && !before) throw notFound("Role");
    const brandLevel = p.brandLevel ?? before?.brandLevel ?? false;
    const after: RoleDef = { key: before?.key ?? null, name: p.name, permissions: p.permissions, maxDiscountPct: p.maxDiscountPct, brandLevel };
    const denied = roleChangeDenied(staffGrantor(ctx), before ? asDef(before) : null, after);
    if (denied) throw forbidden(denied);
    const dup = await db.query.roles.findFirst({ where: and(sql`lower(${roles.name}) = lower(${p.name})`, p.id ? ne(roles.id, p.id) : undefined) });
    if (dup) throw new AppError("conflict", `There's already a role called "${dup.name}"`);
    const permissions = p.permissions.filter((x) => !/^report\..+\.export$/.test(x) || (p.permissions as string[]).includes(x.replace(/\.export$/, ".view")));
    const values = { name: p.name, description: p.description, permissions, maxDiscountPct: p.maxDiscountPct, defaultScope: p.defaultScope, brandLevel, updatedAt: new Date() };
    const id = await db.transaction(async (tx) => {
      let id = p.id;
      if (id) await tx.update(roles).set(values).where(eq(roles.id, id));
      else {
        const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${roles.sortOrder}), 0)::int` }).from(roles);
        id = (await tx.insert(roles).values({ ...values, key: null, sortOrder: n + 10 }).returning({ id: roles.id }))[0].id;
      }
      const diff = diffPermissions(before ? permsOf(asDef(before)) : [], permsOf(after));
      await audit(
        ctx.actor,
        before ? "permissions.role_update" : "permissions.role_create",
        "role",
        id,
        {
          name: p.name,
          ...(before && before.name !== p.name ? { renamedFrom: before.name } : {}),
          added: diff.added,
          removed: diff.removed,
          maxDiscountPct: before && before.maxDiscountPct === p.maxDiscountPct ? undefined : { from: before?.maxDiscountPct ?? null, to: p.maxDiscountPct },
          defaultScope: before && before.defaultScope === p.defaultScope ? undefined : { from: before?.defaultScope ?? null, to: p.defaultScope },
          brandLevel: (before?.brandLevel ?? false) === brandLevel ? undefined : { from: before?.brandLevel ?? false, to: brandLevel },
        },
        null,
        tx,
      );
      return id;
    });
    revalidate();
    return { id };
  });
}

/** Put a built-in role back to its template. */
export async function resetRoleAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("permissions.manage");
    const before = await db.query.roles.findFirst({ where: eq(roles.id, id) });
    const t = templateFor(before?.key);
    if (!before || !t) throw new AppError("bad_request", "Only built-in roles have a template to reset to");
    const row = templateRow(t);
    const denied = roleChangeDenied(staffGrantor(ctx), asDef(before), { key: t.key, name: before.name, permissions: row.permissions, maxDiscountPct: row.maxDiscountPct });
    if (denied) throw forbidden(denied);
    const diff = diffPermissions(permsOf(asDef(before)), permsOf(t));
    await db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({ name: t.name, description: row.description, permissions: row.permissions, maxDiscountPct: row.maxDiscountPct, defaultScope: row.defaultScope, updatedAt: new Date() })
        .where(eq(roles.id, id));
      await audit(ctx.actor, "permissions.role_reset", "role", id, { name: t.name, added: diff.added, removed: diff.removed, maxDiscountPct: { from: before.maxDiscountPct, to: row.maxDiscountPct } }, null, tx);
    });
    revalidate();
    return { id };
  });
}

export async function deleteRoleAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("permissions.manage");
    const before = await db.query.roles.findFirst({ where: eq(roles.id, id) });
    if (!before) throw notFound("Role");
    const denied = roleChangeDenied(staffGrantor(ctx), asDef(before), null);
    if (denied) throw forbidden(denied);
    const [{ n }] = await db
      .select({ n: sql<number>`count(distinct ${staff.id})::int` })
      .from(staff)
      .where(or(eq(staff.roleId, id), sql`exists (select 1 from staff_access_shops a where a.staff_id = ${staff.id} and a.role_id = ${id})`));
    if (n) throw new AppError("conflict", `${n} ${n === 1 ? "person has" : "people have"} this role. Give them another role first.`);
    await db.transaction(async (tx) => {
      await tx.delete(roles).where(eq(roles.id, id));
      await audit(ctx.actor, "permissions.role_delete", "role", id, { name: before.name, permissions: permsOf(asDef(before)), maxDiscountPct: before.maxDiscountPct }, null, tx);
    });
    revalidate();
    return { id };
  });
}

const UserSchema = z.object({
  staffId: z.string().uuid(),
  roleId: z.string().uuid(),
  overrides: z.record(z.string(), z.boolean()).transform(cleanOverrides),
  maxDiscountPct: z.number().int().min(0).max(100).nullable(),
  scope: z.enum(SHOP_SCOPES),
  /** For an entity scope: which owner entity. Its shops come from the entity, not shopIds. */
  scopeEntityId: z.string().uuid().nullable().optional(),
  shopIds: z.array(z.string().uuid()).transform((xs) => [...new Set(xs)]),
  /** A different role at some of their shops (shop ID → role ID). */
  shopRoles: z.record(z.string().uuid(), z.string().uuid()).optional().default({}),
});

/** One person's role, per-user overrides, discount limit, assigned shops and their role at each. */
export async function saveUserAccessAction(raw: z.input<typeof UserSchema>) {
  return safe(async () => {
    const ctx = await authorize("permissions.manage");
    const p = UserSchema.parse(raw);
    const current = await loadStaffAccess(p.staffId);
    if (!current) throw notFound("Staff member");
    const role = await db.query.roles.findFirst({ where: eq(roles.id, p.roleId) });
    if (!role) throw notFound("Role");
    const owner = role.key === OWNER_ROLE_KEY;
    const overrides = owner ? {} : p.overrides;
    const scope = owner ? "all" : p.scope;
    const kind = (await db.query.staff.findFirst({ where: eq(staff.id, p.staffId), columns: { kind: true } }))?.kind;
    if (kind === "shop" && scope !== "one") throw new AppError("bad_request", "A shop login always has access to exactly one shop");
    const scopeEntityId = await resolveEntityScope(scope, p.scopeEntityId);
    const shopIds = scope === "all" ? [] : scopeEntityId ? await entityShopIds(scopeEntityId) : p.shopIds;
    if (scope === "entity" && !shopIds.length) throw new AppError("bad_request", "That owner has no locations yet");
    if (shopIds.length) {
      const found = await db.select({ id: shops.id }).from(shops).where(inArray(shops.id, shopIds));
      if (found.length !== shopIds.length) throw notFound("Shop");
    }
    const shopRoles: Record<string, string> = {};
    if (scope === "selected" || scope === "entity") {
      for (const [shopId, roleId] of Object.entries(p.shopRoles)) {
        if (!shopIds.includes(shopId)) throw new AppError("bad_request", "A shop role needs the person assigned to that shop");
        if (roleId !== role.id) shopRoles[shopId] = roleId;
      }
    }
    const extraIds = [...new Set(Object.values(shopRoles))];
    const extra = extraIds.length ? await db.select().from(roles).where(inArray(roles.id, extraIds)) : [];
    if (extra.length !== extraIds.length) throw notFound("Role");
    if (extra.some((r) => r.key === OWNER_ROLE_KEY)) throw new AppError("bad_request", "Brand Owner covers every shop, so it can't be a role at one shop");
    const byId = new Map(extra.map((r) => [r.id, r]));
    const { union: next } = accessByShop(
      role,
      shopIds.map((shopId) => ({ shopId, role: shopRoles[shopId] ? byId.get(shopRoles[shopId])! : null })),
      overrides,
      owner ? null : p.maxDiscountPct,
      scope,
    );
    const denied = userAccessChangeDenied(
      staffGrantor(ctx),
      accessState(current),
      { staffId: current.staffId, ...next, scope, scopeEntityId, shopIds, overrides, brandLevel: !!kind && isBrandLevelPerson({ kind, scope, role }) },
      { activeOwners: await activeOwnerCount() },
    );
    if (denied) throw forbidden(denied);
    const diff = diffPermissions(current.permissions, next.permissions);
    await db.transaction(async (tx) => {
      await tx
        .update(staff)
        .set({ roleId: role.id, shopScope: scope, scopeEntityId, permissionOverrides: overrides as Record<string, boolean>, maxDiscountPct: owner ? null : p.maxDiscountPct })
        .where(eq(staff.id, p.staffId));
      await tx.delete(staffAccessShops).where(eq(staffAccessShops.staffId, p.staffId));
      if (shopIds.length) await tx.insert(staffAccessShops).values(shopIds.map((shopId) => ({ staffId: p.staffId, shopId, roleId: shopRoles[shopId] ?? null })));
      const shopRoleNames = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([s, r]) => [s, byId.get(r)?.name ?? r]));
      await audit(
        ctx.actor,
        "permissions.user_update",
        "staff",
        p.staffId,
        {
          role: current.role.id === role.id ? role.name : { from: current.role.name, to: role.name },
          scope: current.scope === scope ? scope : { from: current.scope, to: scope },
          scopeEntity: current.scopeEntityId === scopeEntityId ? undefined : { from: current.scopeEntityId, to: scopeEntityId },
          shops: { from: current.scope === "all" ? "all" : current.shopIds, to: scope === "all" ? "all" : shopIds },
          shopRoles:
            JSON.stringify(current.shopRoles) === JSON.stringify(shopRoles)
              ? undefined
              : { from: Object.fromEntries(Object.entries(current.shopRoles).map(([s]) => [s, current.byShop.get(s)!.role.name])), to: shopRoleNames(shopRoles) },
          added: diff.added,
          removed: diff.removed,
          overrides,
          maxDiscountPct: current.maxDiscountPct === next.maxDiscountPct ? undefined : { from: current.maxDiscountPct, to: next.maxDiscountPct },
        },
        null,
        tx,
      );
    });
    revalidate();
    return { staffId: p.staffId, permissions: [...next.permissions] as Permission[] };
  });
}
