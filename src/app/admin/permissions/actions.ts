"use server";

import { eq, inArray, or, sql } from "drizzle-orm";
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
  roleChangeDenied,
  userAccessChangeDenied,
} from "@/domain/permissions";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import {
  accessState,
  activeOwnerCount,
  loadStaffAccess,
} from "@/server/auth/access";
import { authorize, staffGrantor } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { entityShopIds, resolveEntityScope } from "@/server/owner-entities";

const asDef = (r: typeof roles.$inferSelect): RoleDef => ({
  key: r.key,
  name: r.name,
  permissions: r.permissions,
  maxDiscountPct: r.maxDiscountPct,
  brandLevel: r.brandLevel,
});
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
      .where(
        or(
          eq(staff.roleId, id),
          sql`exists (select 1 from staff_access_shops a where a.staff_id = ${staff.id} and a.role_id = ${id})`,
        ),
      );
    if (n)
      throw new AppError(
        "conflict",
        `${n} ${n === 1 ? "person has" : "people have"} this role. Give them another role first.`,
      );
    await db.transaction(async (tx) => {
      await tx.delete(roles).where(eq(roles.id, id));
      await audit(
        ctx.actor,
        "permissions.role_delete",
        "role",
        id,
        {
          name: before.name,
          permissions: permsOf(asDef(before)),
          maxDiscountPct: before.maxDiscountPct,
        },
        null,
        tx,
      );
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
  shopRoles: z
    .record(z.string().uuid(), z.string().uuid())
    .optional()
    .default({}),
});

/** One person's role, per-user overrides, discount limit, assigned shops and their role at each. */
export async function saveUserAccessAction(raw: z.input<typeof UserSchema>) {
  return safe(async () => {
    const ctx = await authorize("permissions.manage");
    const p = UserSchema.parse(raw);
    const current = await loadStaffAccess(p.staffId);
    if (!current) throw notFound("Staff member");
    const role = await db.query.roles.findFirst({
      where: eq(roles.id, p.roleId),
    });
    if (!role) throw notFound("Role");
    const owner = role.key === OWNER_ROLE_KEY;
    const overrides = owner ? {} : p.overrides;
    const scope = owner ? "all" : p.scope;
    const kind = (
      await db.query.staff.findFirst({
        where: eq(staff.id, p.staffId),
        columns: { kind: true },
      })
    )?.kind;
    if (kind === "shop" && scope !== "one")
      throw new AppError(
        "bad_request",
        "A shop login always has access to exactly one shop",
      );
    const scopeEntityId = await resolveEntityScope(scope, p.scopeEntityId);
    const shopIds =
      scope === "all"
        ? []
        : scopeEntityId
          ? await entityShopIds(scopeEntityId)
          : p.shopIds;
    if (scope === "entity" && !shopIds.length)
      throw new AppError("bad_request", "That owner has no locations yet");
    if (shopIds.length) {
      const found = await db
        .select({ id: shops.id })
        .from(shops)
        .where(inArray(shops.id, shopIds));
      if (found.length !== shopIds.length) throw notFound("Shop");
    }
    const shopRoles: Record<string, string> = {};
    if (scope === "selected" || scope === "entity") {
      for (const [shopId, roleId] of Object.entries(p.shopRoles)) {
        if (!shopIds.includes(shopId))
          throw new AppError(
            "bad_request",
            "A shop role needs the person assigned to that shop",
          );
        if (roleId !== role.id) shopRoles[shopId] = roleId;
      }
    }
    const extraIds = [...new Set(Object.values(shopRoles))];
    const extra = extraIds.length
      ? await db.select().from(roles).where(inArray(roles.id, extraIds))
      : [];
    if (extra.length !== extraIds.length) throw notFound("Role");
    if (extra.some((r) => r.key === OWNER_ROLE_KEY))
      throw new AppError(
        "bad_request",
        "Brand Owner covers every shop, so it can't be a role at one shop",
      );
    const byId = new Map(extra.map((r) => [r.id, r]));
    const { union: next } = accessByShop(
      role,
      shopIds.map((shopId) => ({
        shopId,
        role: shopRoles[shopId] ? byId.get(shopRoles[shopId])! : null,
      })),
      overrides,
      owner ? null : p.maxDiscountPct,
      scope,
    );
    const denied = userAccessChangeDenied(
      staffGrantor(ctx),
      accessState(current),
      {
        staffId: current.staffId,
        ...next,
        scope,
        scopeEntityId,
        shopIds,
        overrides,
        brandLevel: !!kind && isBrandLevelPerson({ kind, scope, role }),
      },
      { activeOwners: await activeOwnerCount() },
    );
    if (denied) throw forbidden(denied);
    const diff = diffPermissions(current.permissions, next.permissions);
    await db.transaction(async (tx) => {
      await tx
        .update(staff)
        .set({
          roleId: role.id,
          shopScope: scope,
          scopeEntityId,
          permissionOverrides: overrides as Record<string, boolean>,
          maxDiscountPct: owner ? null : p.maxDiscountPct,
        })
        .where(eq(staff.id, p.staffId));
      await tx
        .delete(staffAccessShops)
        .where(eq(staffAccessShops.staffId, p.staffId));
      if (shopIds.length)
        await tx
          .insert(staffAccessShops)
          .values(
            shopIds.map((shopId) => ({
              staffId: p.staffId,
              shopId,
              roleId: shopRoles[shopId] ?? null,
            })),
          );
      const shopRoleNames = (m: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(m).map(([s, r]) => [s, byId.get(r)?.name ?? r]),
        );
      await audit(
        ctx.actor,
        "permissions.user_update",
        "staff",
        p.staffId,
        {
          role:
            current.role.id === role.id
              ? role.name
              : { from: current.role.name, to: role.name },
          scope:
            current.scope === scope
              ? scope
              : { from: current.scope, to: scope },
          scopeEntity:
            current.scopeEntityId === scopeEntityId
              ? undefined
              : { from: current.scopeEntityId, to: scopeEntityId },
          shops: {
            from: current.scope === "all" ? "all" : current.shopIds,
            to: scope === "all" ? "all" : shopIds,
          },
          shopRoles:
            JSON.stringify(current.shopRoles) === JSON.stringify(shopRoles)
              ? undefined
              : {
                  from: Object.fromEntries(
                    Object.entries(current.shopRoles).map(([s]) => [
                      s,
                      current.byShop.get(s)!.role.name,
                    ]),
                  ),
                  to: shopRoleNames(shopRoles),
                },
          added: diff.added,
          removed: diff.removed,
          overrides,
          maxDiscountPct:
            current.maxDiscountPct === next.maxDiscountPct
              ? undefined
              : { from: current.maxDiscountPct, to: next.maxDiscountPct },
        },
        null,
        tx,
      );
    });
    revalidate();
    return {
      staffId: p.staffId,
      permissions: [...next.permissions] as Permission[],
    };
  });
}
