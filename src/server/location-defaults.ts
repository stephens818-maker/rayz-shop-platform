import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, shops } from "@/db/schema";
import {
  DEFAULT_FIELDS,
  DefaultKey,
  Effective,
  LocationDefaults,
  brandDefaults,
  cleanPartial,
  columnPatch,
  effectiveDefaults,
  isDefaultKey,
  parseDefault,
  valuesOf,
} from "@/domain/location-defaults";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

export async function loadBrandDefaults(tx: DBorTx = db): Promise<LocationDefaults> {
  const [b] = await tx.select({ d: brandSettings.locationDefaults }).from(brandSettings).limit(1);
  return brandDefaults(b?.d);
}

export interface LocationDefaultsRow {
  shopId: string;
  shop: string;
  effective: Effective;
}

/** Every listed location's values beside the brand's, with which ones are its own. */
export async function locationDefaultsBoard(shopIds: string[]): Promise<{ brand: LocationDefaults; shops: LocationDefaultsRow[] }> {
  const [brand, rows] = await Promise.all([
    loadBrandDefaults(),
    shopIds.length
      ? db
          .select({ id: shops.id, name: shops.name, o: shops.brandOverrides })
          .from(shops)
          .where(and(inArray(shops.id, shopIds), ne(shops.status, "archived")))
          .orderBy(asc(shops.name))
      : Promise.resolve([]),
  ]);
  return { brand, shops: rows.map((r) => ({ shopId: r.id, shop: r.name, effective: effectiveDefaults(brand, cleanPartial(r.o)) })) };
}

/** One location's effective values, for the booking site, reminders and Add staff. */
export async function shopDefaults(shopId: string, tx: DBorTx = db): Promise<LocationDefaults> {
  const [brand, row] = await Promise.all([loadBrandDefaults(tx), tx.select({ o: shops.brandOverrides }).from(shops).where(eq(shops.id, shopId)).limit(1)]);
  return valuesOf(effectiveDefaults(brand, cleanPartial(row[0]?.o)));
}

function parsed<K extends DefaultKey>(key: K, raw: unknown) {
  const p = parseDefault(key, raw);
  if (!p.ok) throw new AppError("bad_request", `${DEFAULT_FIELDS[key].label}: ${p.error}`);
  return p.value;
}

const jsonKey = (key: DefaultKey) => sql`${key}::text`;

/** Changes the brand value; every location that follows the brand gets it, ones with their own keep theirs. */
export async function saveBrandDefault(actor: Actor, key: DefaultKey, raw: unknown) {
  if (!isDefaultKey(key)) throw new AppError("bad_request", "Unknown setting");
  const value = parsed(key, raw);
  return db.transaction(async (tx) => {
    const before = await loadBrandDefaults(tx);
    await tx
      .update(brandSettings)
      .set({ locationDefaults: sql`${brandSettings.locationDefaults} || jsonb_build_object(${jsonKey(key)}, ${JSON.stringify(value)}::jsonb)`, updatedAt: new Date() })
      .where(eq(brandSettings.id, 1));
    const patch = columnPatch({ [key]: value });
    const following = await tx
      .select({ id: shops.id })
      .from(shops)
      .where(sql`not (${shops.brandOverrides} ? ${key})`);
    if (Object.keys(patch).length && following.length)
      await tx
        .update(shops)
        .set(patch)
        .where(
          inArray(
            shops.id,
            following.map((s) => s.id),
          ),
        );
    await audit(actor, "brand.location_default", "brand_settings", key, { key, from: before[key], to: value, following: following.length }, null, tx);
    return { following: following.length };
  });
}

/** Gives one location its own value ("this shop only"). */
export async function setShopOverride(actor: Actor, shopId: string, key: DefaultKey, raw: unknown, tx?: DBorTx) {
  if (!isDefaultKey(key)) throw new AppError("bad_request", "Unknown setting");
  const value = parsed(key, raw);
  const run = async (t: DBorTx) => {
    const [row] = await t.select({ o: shops.brandOverrides }).from(shops).where(eq(shops.id, shopId)).for("update");
    if (!row) throw notFound("Shop");
    const before = cleanPartial(row.o)[key];
    await t
      .update(shops)
      .set({ brandOverrides: sql`${shops.brandOverrides} || jsonb_build_object(${jsonKey(key)}, ${JSON.stringify(value)}::jsonb)`, ...columnPatch({ [key]: value }) })
      .where(eq(shops.id, shopId));
    await audit(actor, "shop.location_override", "shop", shopId, { key, from: before ?? null, to: value }, shopId, t);
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Puts one location back on the brand value ("all shops"). */
export async function clearShopOverride(actor: Actor, shopId: string, key: DefaultKey) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ o: shops.brandOverrides }).from(shops).where(eq(shops.id, shopId)).for("update");
    if (!row) throw notFound("Shop");
    const own = cleanPartial(row.o);
    if (!(key in own)) return;
    const brand = await loadBrandDefaults(tx);
    await tx
      .update(shops)
      .set({ brandOverrides: sql`${shops.brandOverrides} - ${key}::text`, ...columnPatch({ [key]: brand[key] }) })
      .where(eq(shops.id, shopId));
    await audit(actor, "shop.location_override_cleared", "shop", shopId, { key, from: own[key], to: brand[key] }, shopId, tx);
  });
}

/**
 * Shop settings forms save the columns directly. A value changed there becomes the shop's own;
 * one set back to the brand value keeps following the brand.
 */
export async function noteShopColumnChanges(shopId: string, values: Partial<LocationDefaults>, tx: DBorTx = db) {
  const keys = Object.keys(values) as DefaultKey[];
  if (!keys.length) return;
  const brand = await loadBrandDefaults(tx);
  const own: Record<string, unknown> = {};
  const follow: string[] = [];
  for (const k of keys) {
    if (values[k] === brand[k]) follow.push(k);
    else own[k] = values[k];
  }
  const dropped = follow.length ? sql`(${shops.brandOverrides} - array[${sql.join(follow.map((k) => sql`${k}`), sql`, `)}]::text[])` : sql`${shops.brandOverrides}`;
  await tx
    .update(shops)
    .set({ brandOverrides: sql`${dropped} || ${JSON.stringify(own)}::jsonb` })
    .where(eq(shops.id, shopId));
}

/** The location's client reminder times, which a barber's own times override. */
export async function shopReminderHours(shopId: string, tx: DBorTx = db) {
  const d = await shopDefaults(shopId, tx);
  return { firstHours: d.reminderFirstHours, secondHours: d.reminderSecondHours };
}
