"use server";

import { eq, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { roles, shops, staff, staffAccessShops } from "@/db/schema";
import {
  MONEY_LIMITS,
  OWNER_ROLE_KEY,
  Permission,
  RoleDef,
  SHOP_SCOPES,
  accessByShop,
  cleanExpiries,
  cleanLimits,
  cleanOverrides,
  diffPermissions,
  effectiveAccess,
  isBrandLevelPerson,
  limitLabel,
  liveOverrides,
  overrideChanges,
  roleChangeDenied,
  roleFitsShop,
  shopLoginGrantDenied,
  userAccessChangeDenied,
} from "@/domain/permissions";
import { todayLocal } from "@/lib/time";
import { syncKey } from "@/domain/brand-sync";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { dropStates } from "@/server/brand-sync/store";
import { accessState, activeOwnerCount, loadStaffAccess } from "@/server/auth/access";
import { authorize, staffGrantor } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { entityShopIds, resolveEntityScope } from "@/server/owner-entities";
import { regionShopIds, resolveRegionScope } from "@/server/regions";

const asDef = (r: typeof roles.$inferSelect): RoleDef => ({
  key: r.key,
  name: r.name,
  permissions: r.permissions,
  maxDiscountPct: r.maxDiscountPct,
  brandLevel: r.brandLevel,
  moneyLimits: cleanLimits(r.moneyLimits),
  ownerEntityId: r.ownerEntityId,
});
const limitsText = (l: Record<string, number | null | undefined>) =>
  MONEY_LIMITS.filter((m) => m.key in l)
    .map((m) => `${m.label} ${limitLabel(l[m.key] ?? null)}`)
    .join(", ") || "Role's";
const permsOf = (r: RoleDef) => [...effectiveAccess(r).permissions];

function revalidate() {
  revalidatePath("/admin", "layout");
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
      await dropStates(tx, syncKey("role", id));
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
  /** For a region scope: which region. Its shops come from the region, not shopIds. */
  scopeRegionId: z.string().uuid().nullable().optional(),
  /** The last day an override counts, per permission (YYYY-MM-DD); none is no end. */
  expires: z
    .record(z.string(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"))
    .optional()
    .default({})
    .transform(cleanExpiries),
  /** Their own dollar limits in cents, replacing the role's key by key; null is no limit. Missing keys follow the role. */
  moneyLimits: z
    .object(Object.fromEntries(MONEY_LIMITS.map((l) => [l.key, z.number().int().min(0, "Limits can't be negative").max(10_000_000).nullable().optional()])))
    .optional()
    .default({})
    .transform(cleanLimits),
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
    const today = todayLocal();
    // An override whose end date has passed is gone.
    const overrides = owner ? {} : liveOverrides(p.overrides, p.expires, today);
    const scope = owner ? "all" : p.scope;
    const kind = (await db.query.staff.findFirst({ where: eq(staff.id, p.staffId), columns: { kind: true } }))?.kind;
    if (kind === "shop" && scope !== "one") throw new AppError("bad_request", "A shop login always has access to exactly one shop");
    const scopeEntityId = await resolveEntityScope(scope, p.scopeEntityId);
    const scopeRegionId = await resolveRegionScope(scope, p.scopeRegionId);
    const shopIds = scope === "all" ? [] : scopeEntityId ? await entityShopIds(scopeEntityId) : scopeRegionId ? await regionShopIds(scopeRegionId) : p.shopIds;
    if (scope === "entity" && !shopIds.length) throw new AppError("bad_request", "That owner has no locations yet");
    if (scope === "region" && !shopIds.length) throw new AppError("bad_request", "That region has no locations yet");
    const found = shopIds.length ? await db.select({ id: shops.id, name: shops.name, ownerEntityId: shops.ownerEntityId }).from(shops).where(inArray(shops.id, shopIds)) : [];
    if (found.length !== shopIds.length) throw notFound("Shop");
    const shopOwner = new Map(found.map((s) => [s.id, s]));
    const expires = Object.fromEntries(Object.entries(p.expires).filter(([k]) => k in overrides));
    const moneyLimits = owner ? {} : p.moneyLimits;
    const shopRoles: Record<string, string> = {};
    if (scope === "selected" || scope === "entity" || scope === "region") {
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
    // A franchisee's own role is only for its shops.
    if (scope === "all" && role.ownerEntityId) throw new AppError("bad_request", `"${role.name}" belongs to one owner, so it can't cover every shop`);
    for (const shopId of shopIds) {
      const r = shopRoles[shopId] ? byId.get(shopRoles[shopId])! : role;
      if (!roleFitsShop(r, shopOwner.get(shopId)?.ownerEntityId)) throw new AppError("bad_request", `"${r.name}" belongs to another owner, so it can't be held at ${shopOwner.get(shopId)?.name ?? "that shop"}`);
    }
    const { union: next } = accessByShop(
      role,
      shopIds.map((shopId) => ({ shopId, role: shopRoles[shopId] ? byId.get(shopRoles[shopId])! : null })),
      overrides,
      owner ? null : p.maxDiscountPct,
      scope,
      moneyLimits,
    );
    const denied = userAccessChangeDenied(
      staffGrantor(ctx),
      accessState(current),
      { staffId: current.staffId, ...next, scope, scopeEntityId, scopeRegionId, shopIds, overrides, brandLevel: !!kind && isBrandLevelPerson({ kind, scope, role }) },
      { activeOwners: await activeOwnerCount() },
    );
    if (denied) throw forbidden(denied);
    const was = await db.query.staff.findFirst({ where: eq(staff.id, p.staffId), columns: { permissionOverrides: true, permissionOverrideExpires: true, moneyLimits: true, scopeRegionId: true } });
    const before = { overrides: cleanOverrides(was?.permissionOverrides), expires: cleanExpiries(was?.permissionOverrideExpires) };
    const brandOnly = kind === "shop" && shopLoginGrantDenied(staffGrantor(ctx), before.overrides, overrides);
    if (brandOnly) throw forbidden(brandOnly);
    const diff = diffPermissions(current.permissions, next.permissions);
    const oldLimits = cleanLimits(was?.moneyLimits);
    await db.transaction(async (tx) => {
      await tx
        .update(staff)
        .set({
          roleId: role.id,
          shopScope: scope,
          scopeEntityId,
          scopeRegionId,
          permissionOverrides: overrides as Record<string, boolean>,
          permissionOverrideExpires: expires,
          maxDiscountPct: owner ? null : p.maxDiscountPct,
          moneyLimits,
        })
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
          scopeRegion: (was?.scopeRegionId ?? null) === scopeRegionId ? undefined : { from: was?.scopeRegionId ?? null, to: scopeRegionId },
          shops: { from: current.scope === "all" ? "all" : current.shopIds, to: scope === "all" ? "all" : shopIds },
          shopRoles:
            JSON.stringify(current.shopRoles) === JSON.stringify(shopRoles)
              ? undefined
              : { from: Object.fromEntries(Object.entries(current.shopRoles).map(([s]) => [s, current.byShop.get(s)!.role.name])), to: shopRoleNames(shopRoles) },
          added: diff.added,
          removed: diff.removed,
          overrides,
          overrideChanges: overrideChanges(before, { overrides, expires }),
          maxDiscountPct: current.maxDiscountPct === next.maxDiscountPct ? undefined : { from: current.maxDiscountPct, to: next.maxDiscountPct },
          moneyLimits: JSON.stringify(oldLimits) === JSON.stringify(moneyLimits) ? undefined : { from: limitsText(oldLimits), to: limitsText(moneyLimits) },
        },
        null,
        tx,
      );
    });
    revalidate();
    return { staffId: p.staffId, permissions: [...next.permissions] as Permission[] };
  });
}
