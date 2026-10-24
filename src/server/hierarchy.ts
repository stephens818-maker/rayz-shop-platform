import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ownerEntities, regions, shops } from "@/db/schema";
import type { ScopeAt, ShopScope } from "@/domain/permissions";
import { AppError, forbidden, notFound } from "./errors";

/**
 * The franchise hierarchy's policy layer: Brand > owner group > region > location. Reach is always
 * resolved to shops (staff_access_shops, kept in step with the hierarchy by database triggers), so
 * every tenant guard (src/server/tenant.ts) keeps working off shop IDs. On top of that, owner-group
 * records (finances, Stripe account, settings) are reached only by the brand or by people scoped to
 * that whole owner group.
 */

export interface ScopeChoice {
  scope: ShopScope;
  scopeEntityId?: string | null;
  scopeRegionId?: string | null;
}

/** An owner-group or region scope's shops right now; null for the other scopes. */
export async function hierarchyShops(c: ScopeChoice, tx: DBorTx = db): Promise<string[] | null> {
  if (c.scope === "entity") {
    if (!c.scopeEntityId) return [];
    return (await tx.select({ id: shops.id }).from(shops).where(eq(shops.ownerEntityId, c.scopeEntityId)).orderBy(asc(shops.name))).map((r) => r.id);
  }
  if (c.scope === "region") {
    if (!c.scopeRegionId) return [];
    return (await tx.select({ id: shops.id }).from(shops).where(eq(shops.regionId, c.scopeRegionId)).orderBy(asc(shops.name))).map((r) => r.id);
  }
  return null;
}

/** A scope as stored and checked: the entity or region it points at (which must exist) and the owner group a region belongs to. */
export async function resolveScope(c: ScopeChoice, tx: DBorTx = db): Promise<ScopeAt & { scopeEntityId: string | null; scopeRegionId: string | null }> {
  if (c.scope === "entity") {
    if (!c.scopeEntityId) throw new AppError("bad_request", "Pick the owner group");
    const e = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, c.scopeEntityId), columns: { id: true } });
    if (!e) throw notFound("Owner group");
    return { scope: "entity", scopeEntityId: e.id, scopeRegionId: null, regionEntityId: null };
  }
  if (c.scope === "region") {
    if (!c.scopeRegionId) throw new AppError("bad_request", "Pick the region");
    const r = await tx.query.regions.findFirst({ where: eq(regions.id, c.scopeRegionId), columns: { id: true, ownerEntityId: true } });
    if (!r) throw notFound("Region");
    return { scope: "region", scopeEntityId: null, scopeRegionId: r.id, regionEntityId: r.ownerEntityId };
  }
  return { scope: c.scope, scopeEntityId: null, scopeRegionId: null, regionEntityId: null };
}

/** Who reaches owner-group records: the brand, or someone scoped to exactly that owner group. */
export interface EntityViewer {
  brandWide: boolean;
  scope?: ShopScope;
  scopeEntityId?: string | null;
  scopeRegionId?: string | null;
  shopIds: readonly string[];
}

/** The owner groups whose records the viewer may open. Null: every one (the brand). */
export function entityReach(v: EntityViewer): string[] | null {
  if (v.brandWide) return null;
  return v.scope === "entity" && v.scopeEntityId ? [v.scopeEntityId] : [];
}

export function canReachEntity(v: EntityViewer, entityId: string) {
  const reach = entityReach(v);
  return reach === null || reach.includes(entityId);
}

/** For actions on an owner group's records: refused as not found when it's outside reach, so IDs reveal nothing. */
export function assertEntity(v: EntityViewer, entityId: string) {
  if (!canReachEntity(v, entityId)) throw new AppError("not_found", "Not found");
}

/** The owner groups of these shops, with each one's shops in the list. */
export async function ownersOf(shopIds: readonly string[], tx: DBorTx = db) {
  if (!shopIds.length) return [];
  return (await tx.execute(sql`
    select oe.id, oe.name, oe.kind, oe.status, array_agg(sh.id order by sh.name) "shopIds"
    from shops sh join owner_entities oe on oe.id = sh.owner_entity_id
    where sh.id in (${sql.join(shopIds.map((s) => sql`${s}::uuid`), sql`, `)})
    group by oe.id order by oe.kind <> 'brand', oe.name`)) as unknown as { id: string; name: string; kind: "brand" | "franchisee"; status: string; shopIds: string[] }[];
}

/**
 * Owner groups all of whose shops are in the viewer's reach: the ones whose own numbers (P&L,
 * royalties, payouts pooled on the owner's account) they may see under entity.finances.
 */
export async function entitiesWithin(v: EntityViewer, tx: DBorTx = db): Promise<string[]> {
  const reach = entityReach(v);
  if (reach && reach.length) return reach;
  const ids = (await ownersOf(v.shopIds, tx)).map((o) => o.id);
  if (reach === null) return ids;
  if (!ids.length) return [];
  const rows = (await tx.execute(sql`
    select owner_entity_id id from shops where owner_entity_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    group by owner_entity_id
    having bool_and(id in (${sql.join(v.shopIds.length ? v.shopIds.map((s) => sql`${s}::uuid`) : [sql`null::uuid`], sql`, `)}))`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Owner groups and regions for pickers, within reach. */
export async function hierarchyChoices(v: EntityViewer, tx: DBorTx = db) {
  const reach = entityReach(v);
  const entities = await tx
    .select({ id: ownerEntities.id, name: ownerEntities.name, kind: ownerEntities.kind, status: ownerEntities.status })
    .from(ownerEntities)
    .where(reach === null ? undefined : reach.length ? inArray(ownerEntities.id, reach) : sql`false`)
    .orderBy(sql`${ownerEntities.kind} <> 'brand'`, asc(ownerEntities.name));
  const regionRows = await tx
    .select({ id: regions.id, name: regions.name, ownerEntityId: regions.ownerEntityId })
    .from(regions)
    .where(
      reach === null
        ? undefined
        : reach.length
          ? inArray(regions.ownerEntityId, reach)
          : v.scope === "region" && v.scopeRegionId
            ? eq(regions.id, v.scopeRegionId)
            : sql`false`,
    )
    .orderBy(asc(regions.name));
  return { entities, regions: regionRows };
}

/** The caller may only manage owner-group records with a permission and inside reach. */
export function requireEntityAccess(v: EntityViewer & { permissions: ReadonlySet<string> }, entityId: string, perm: string) {
  if (!v.permissions.has(perm)) throw forbidden("You don't have permission to do that");
  assertEntity(v, entityId);
}
