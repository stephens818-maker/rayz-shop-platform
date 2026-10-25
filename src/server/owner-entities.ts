import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ownerEntities, shops } from "@/db/schema";
import type { ShopScope } from "@/domain/permissions";
import { AppError, notFound } from "./errors";

/**
 * Owner entities as a reach: a person scoped to an entity has exactly its shops in
 * staff_access_shops (kept so by database triggers), so every tenant guard keeps working off shop
 * IDs. This module resolves an entity scope to its shops and says which entities someone may pick.
 */

/** Ray'z Corporate: the entity new locations go to unless another is chosen. */
export async function defaultOwnerEntity(tx: DBorTx = db) {
  const row = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.isDefault, true) });
  if (row) return row;
  const id = ((await tx.execute(sql`select rayz_corporate_entity()::text id`)) as unknown as { id: string }[])[0].id;
  return (await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, id) }))!;
}

/** An entity's shops right now. */
export async function entityShopIds(entityId: string, tx: DBorTx = db): Promise<string[]> {
  return (await tx.select({ id: shops.id }).from(shops).where(eq(shops.ownerEntityId, entityId)).orderBy(asc(shops.name))).map((r) => r.id);
}

/** A scope as stored: the entity an entity scope points at (which must exist), or none. */
export async function resolveEntityScope(scope: ShopScope, entityId: string | null | undefined, tx: DBorTx = db): Promise<string | null> {
  if (scope !== "entity") return null;
  if (!entityId) throw new AppError("bad_request", "Pick the owner");
  const e = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, entityId), columns: { id: true } });
  if (!e) throw notFound("Owner");
  return e.id;
}

/** The owner entities someone may scope people to: every one for the brand, their own for an entity's person. */
export async function entityChoices(v: { brandWide: boolean; scope: ShopScope; scopeEntityId: string | null }, tx: DBorTx = db) {
  const reach = v.brandWide ? null : v.scope === "entity" && v.scopeEntityId ? [v.scopeEntityId] : [];
  if (reach && !reach.length) return [];
  return tx
    .select({ id: ownerEntities.id, name: ownerEntities.name, kind: ownerEntities.kind })
    .from(ownerEntities)
    .where(reach ? inArray(ownerEntities.id, reach) : undefined)
    .orderBy(sql`not ${ownerEntities.isDefault}`, asc(ownerEntities.kind), asc(ownerEntities.name));
}

/** The one owner entity all these shops belong to, or null when they're split across owners. */
export async function commonOwner(shopIds: readonly string[], tx: DBorTx = db): Promise<string | null> {
  if (!shopIds.length) return null;
  const rows = await tx.selectDistinct({ id: shops.ownerEntityId }).from(shops).where(inArray(shops.id, [...shopIds]));
  return rows.length === 1 ? rows[0].id : null;
}
