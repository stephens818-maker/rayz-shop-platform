import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops } from "@/db/schema";
import type { BreakdownColumn } from "@/components/access-breakdown";
import { Access, BRAND_ADMIN_ALWAYS, BRAND_ADMIN_ROLE_KEY, ShopScope, isBrandLevelPerson, roleFitsShop, sameAccess } from "@/domain/permissions";
import type { StaffAccess } from "./access";

type Role = typeof roles.$inferSelect;

const names = (xs: string[]) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more`);

/** What the role itself lists (as the shop runs it), before scope and shop login rules. */
const listed = (role: Role, scope: ShopScope) => [...new Set([...role.permissions, ...(role.key === BRAND_ADMIN_ROLE_KEY && scope === "all" ? BRAND_ADMIN_ALWAYS : [])])];

export function column(key: string, label: string, a: Access, role: Role, o: { scope: ShopScope; kind: "person" | "shop"; granted?: ReadonlySet<string>; ownerMismatch?: boolean }): BreakdownColumn {
  return {
    key,
    label,
    role: role.name,
    isOwner: a.isOwner,
    held: [...a.permissions],
    fromRole: listed(role, o.scope),
    granted: [...(o.granted ?? [])],
    scope: o.scope,
    brandLevel: isBrandLevelPerson({ kind: o.kind, scope: o.scope, role }),
    shopLogin: o.kind === "shop",
    ownerMismatch: !!o.ownerMismatch,
    maxDiscountPct: a.maxDiscountPct,
    limits: a.limits,
  };
}

/** One column per group of their shops with the same role and access; one "every shop" column when it's the same everywhere. */
export async function breakdownColumns(a: StaffAccess, kind: "person" | "shop", visible: (shopId: string) => boolean = () => true): Promise<BreakdownColumn[]> {
  const opts = { scope: a.scope, kind, granted: a.granted };
  if (a.isOwner) return [column("all", "Every shop", a, a.role, opts)];
  const entries = [...a.byShop].filter(([id]) => visible(id));
  if (!entries.length) return [column("none", a.shopIds.length ? "Their shops" : "No shops yet", a, a.role, opts)];
  const owners = new Map(
    (await db.select({ id: shops.id, ownerEntityId: shops.ownerEntityId }).from(shops).where(inArray(shops.id, entries.map(([id]) => id)))).map((s) => [s.id, s.ownerEntityId]),
  );
  const groups: { ids: string[]; access: Access & { role: Role } }[] = [];
  for (const [id, x] of entries) {
    const g = groups.find((y) => y.access.role.id === x.role.id && sameAccess(y.access, x));
    if (g) g.ids.push(id);
    else groups.push({ ids: [id], access: x });
  }
  groups.sort((x, y) => Number(y.access.role.id === a.role.id) - Number(x.access.role.id === a.role.id));
  const name = (id: string) => a.shops.find((s) => s.id === id)?.name ?? "Shop";
  return groups.map((g) =>
    column(
      g.ids.join(","),
      groups.length === 1 && a.scope === "all" ? "Every shop" : names(g.ids.map(name)),
      g.access,
      g.access.role,
      { ...opts, ownerMismatch: !roleFitsShop(g.access.role, owners.get(g.ids[0])) },
    ),
  );
}
