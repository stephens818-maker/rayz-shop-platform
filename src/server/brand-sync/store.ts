import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSyncControls, brandSyncValues, shopSyncState } from "@/db/schema";
import { SyncMode, SyncType, syncKey } from "@/domain/brand-sync";
import type { Actor } from "../audit";

export interface StateRow {
  mode: SyncMode;
  local: unknown;
}

/** Each shop's recorded state for these settings, keyed "<shopId>|<key>". */
export async function stateRows(tx: DBorTx, keys: readonly string[], shopIds?: readonly string[]): Promise<Map<string, StateRow>> {
  if (!keys.length || (shopIds && !shopIds.length)) return new Map();
  const rows = await tx
    .select()
    .from(shopSyncState)
    .where(and(inArray(shopSyncState.key, [...keys]), shopIds ? inArray(shopSyncState.shopId, [...shopIds]) : undefined));
  return new Map(rows.map((r) => [`${r.shopId}|${r.key}`, { mode: r.mode, local: r.local }]));
}

/** Records a shop's mode for a setting; `local` is only written when given (undefined leaves it). */
export async function putState(tx: DBorTx, shopId: string, key: string, mode: SyncMode, local?: unknown) {
  const set = { mode, updatedAt: new Date(), ...(local !== undefined ? { local: local as object | null } : {}) };
  await tx
    .insert(shopSyncState)
    .values({ shopId, key, mode, local: (local ?? null) as object | null })
    .onConflictDoUpdate({ target: [shopSyncState.shopId, shopSyncState.key], set });
}

/**
 * A shop's own value of a setting that used to be brand-only, or undefined while it follows the
 * brand. Readers at checkout, booking and sign-in call this, so it's one indexed lookup.
 */
export async function localValue<V>(type: SyncType, item: string, shopId: string | null | undefined, tx: DBorTx = db): Promise<V | undefined> {
  if (!shopId) return undefined;
  const [r] = await tx
    .select({ local: shopSyncState.local })
    .from(shopSyncState)
    .where(and(eq(shopSyncState.shopId, shopId), eq(shopSyncState.key, syncKey(type, item)), isNotNull(shopSyncState.local)));
  return (r?.local ?? undefined) as V | undefined;
}

/** Every shop's own value for one type's items (roles at sign-in, templates in the library), keyed "<shopId>|<item>". */
export async function localValues<V>(type: SyncType, shopIds: readonly string[], tx: DBorTx = db): Promise<Map<string, V>> {
  if (!shopIds.length) return new Map();
  const rows = await tx
    .select({ shopId: shopSyncState.shopId, key: shopSyncState.key, local: shopSyncState.local })
    .from(shopSyncState)
    .where(and(inArray(shopSyncState.shopId, [...shopIds]), like(shopSyncState.key, `${type}:%`), isNotNull(shopSyncState.local)));
  return new Map(rows.map((r) => [`${r.shopId}|${r.key.slice(type.length + 1)}`, r.local as V]));
}

export async function brandValue<T>(key: string, tx: DBorTx = db): Promise<T | undefined> {
  const [r] = await tx.select({ v: brandSyncValues.value }).from(brandSyncValues).where(eq(brandSyncValues.key, key));
  return (r?.v ?? undefined) as T | undefined;
}

export async function putBrandValue(tx: DBorTx, key: string, value: unknown, actor: Actor) {
  const v = value as object;
  await tx
    .insert(brandSyncValues)
    .values({ key, value: v, updatedBy: actor.staffId ?? null })
    .onConflictDoUpdate({ target: brandSyncValues.key, set: { value: v, updatedAt: new Date(), updatedBy: actor.staffId ?? null } });
}

export async function controlRows(tx: DBorTx = db): Promise<Map<string, boolean>> {
  const rows = await tx.select().from(brandSyncControls);
  return new Map(rows.map((r) => [r.type, r.shopsCanEdit]));
}

export async function putControl(tx: DBorTx, type: SyncType, on: boolean, actor: Actor) {
  await tx
    .insert(brandSyncControls)
    .values({ type, shopsCanEdit: on, updatedBy: actor.staffId ?? null })
    .onConflictDoUpdate({ target: brandSyncControls.type, set: { shopsCanEdit: on, updatedAt: new Date(), updatedBy: actor.staffId ?? null } });
}

/** Drops recorded states for an item that no longer exists (a rolled-back new service). */
export async function dropStates(tx: DBorTx, key: string) {
  await tx.delete(shopSyncState).where(eq(shopSyncState.key, key));
}

export const lockSync = (tx: DBorTx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('brand_sync'))`);
