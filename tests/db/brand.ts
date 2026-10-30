import type { SyncType } from "@/domain/brand-sync";
import type { Actor } from "@/server/audit";
import type { StaffContext } from "@/server/auth/staff";

export interface BrandChangeOpts {
  /** Only these shops; default every shop. */
  shops?: string[];
  /** Shops with their own value keep it; default they take the brand's. */
  keep?: boolean;
  /** Checked like a person in the brand login; default the scheduler (no checks). */
  ctx?: StaffContext | null;
  actor?: Actor;
}

export type Change = { type: SyncType; item: string; value: unknown };

/** A brand change the way the brand login sends it, through the sync scope, applied now. */
export async function brandChange(changes: Change[], o: BrandChangeOpts = {}) {
  const { commitBrandChange } = await import("@/server/brand-sync/engine");
  const { db } = await import("@/db");
  const { shops } = await import("@/db/schema");
  const all = o.keep ? [] : (await db.select({ id: shops.id }).from(shops)).map((s) => s.id);
  const overrides = Object.fromEntries(all.map((id) => [id, "replace" as const]));
  const actor = o.ctx?.actor ?? o.actor ?? { staffId: null, label: "test" };
  return commitBrandChange({ actor, ctx: o.ctx ?? null }, { changes, scope: o.shops ? "selected" : "all", shopIds: o.shops ?? [], overrides });
}

export const brandSet = (type: SyncType, item: string, value: unknown, o?: BrandChangeOpts) => brandChange([{ type, item, value }], o);

/** Brand settings by registry key; an object value is merged over the current one. */
export const brandSettings = (values: Record<string, unknown>, o?: BrandChangeOpts) =>
  brandChange(
    Object.entries(values).map(([item, value]) => ({ type: "setting" as const, item, value })),
    o,
  );

/** The same change through the brand login's server action, as whoever is signed in. */
export async function brandActions(changes: Change[], o: { shops?: string[]; keep?: boolean } = {}) {
  const { commitBrandSyncAction } = await import("@/app/admin/sync-status/actions");
  const { db } = await import("@/db");
  const { shops } = await import("@/db/schema");
  const all = o.keep ? [] : (await db.select({ id: shops.id }).from(shops)).map((s) => s.id);
  return commitBrandSyncAction({ changes, scope: o.shops ? "selected" : "all", shopIds: o.shops ?? [], overrides: Object.fromEntries(all.map((id) => [id, "replace" as const])) });
}

export const brandAction = (type: SyncType, item: string, value: unknown, o?: { shops?: string[]; keep?: boolean }) => brandActions([{ type, item, value }], o);

/** A client data rule as the portal saves it: a role's rule for every shop goes through the scope, the rest straight to the rule. */
export async function fieldRule(r: { field: string; level: string | null; roleId: string | null; staffId: string | null; shopId: string | null; setting?: "view" | "add" | "edit" }) {
  if (r.roleId && !r.staffId && !r.shopId) return brandAction("field_rule", r.roleId, { [`${r.setting ?? "view"}:${r.field}`]: r.level });
  const { setFieldRuleAction } = await import("@/app/admin/client-data/actions");
  return setFieldRuleAction(r);
}

/** The brand's current value of an item, as its editor sees it. */
export async function brandValue<V>(type: SyncType, item: string): Promise<V> {
  const { ADAPTERS } = await import("@/server/brand-sync/registry");
  const { db } = await import("@/db");
  const a = ADAPTERS[type] as unknown as { brand(tx: unknown, items: string[]): Promise<Map<string, unknown>> };
  return (await a.brand(db, [item])).get(item) as V;
}
