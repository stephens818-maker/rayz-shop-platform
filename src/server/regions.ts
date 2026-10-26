import "server-only";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { type DBorTx, db } from "@/db";
import { locationDailyStats, regions, shops, staff } from "@/db/schema";
import type { ShopScope } from "@/domain/permissions";
import { regionNameProblem } from "@/domain/regions";
import { slugify } from "@/lib/ids";
import { type Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

export async function regionList() {
  const [list, members] = await Promise.all([
    db.select().from(regions).orderBy(asc(regions.name)),
    db.select({ id: shops.id, name: shops.name, regionId: shops.regionId }).from(shops).where(sql`${shops.regionId} is not null and ${shops.status} <> 'archived'`).orderBy(asc(shops.name)),
  ]);
  return list.map((r) => ({ ...r, shops: members.filter((s) => s.regionId === r.id).map(({ id, name }) => ({ id, name })) }));
}

async function freeSlug(name: string) {
  const base = slugify(name) || "region";
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await db.query.regions.findFirst({ where: eq(regions.slug, slug), columns: { id: true } }))) return slug;
  }
}

export async function saveRegion(actor: Actor, id: string | null, rawName: string) {
  const name = rawName.trim();
  const problem = regionNameProblem(name);
  if (problem) throw new AppError("bad_request", problem);
  const same = await db.query.regions.findFirst({ where: sql`lower(${regions.name}) = lower(${name})`, columns: { id: true } });
  if (same && same.id !== id) throw new AppError("conflict", `There's already a region called ${name}`);
  if (id) {
    const [row] = await db.update(regions).set({ name }).where(eq(regions.id, id)).returning();
    if (!row) throw notFound("Region");
    await audit(actor, "region.update", "region", id, { name });
    return row;
  }
  const [row] = await db.insert(regions).values({ name, slug: await freeSlug(name) }).returning();
  await audit(actor, "region.create", "region", row.id, { name });
  return row;
}

/** Its locations, and their rolled-up days, are left without a region. */
export async function deleteRegion(actor: Actor, id: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(staff).where(eq(staff.scopeRegionId, id));
  if (n) throw new AppError("conflict", `${n} ${n === 1 ? "person's" : "people's"} access covers this region's shops. Change their shop access first.`);
  const [row] = await db.delete(regions).where(eq(regions.id, id)).returning();
  if (!row) throw notFound("Region");
  await audit(actor, "region.delete", "region", id, { name: row.name });
}

/** The location's rolled-up history moves with it, so comparisons always group by current region. */
export async function setShopRegion(actor: Actor, shopId: string, regionId: string | null) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true, regionId: true } });
  if (!shop) throw notFound("Location");
  const region = regionId ? await db.query.regions.findFirst({ where: eq(regions.id, regionId) }) : null;
  if (regionId && !region) throw notFound("Region");
  if (shop.regionId === regionId) return;
  await db.transaction(async (tx) => {
    await tx.update(shops).set({ regionId }).where(eq(shops.id, shopId));
    await tx.update(locationDailyStats).set({ regionId }).where(eq(locationDailyStats.shopId, shopId));
  });
  await audit(actor, "shop.region", "shop", shopId, { shop: shop.name, from: shop.regionId, to: regionId, region: region?.name ?? null }, shopId);
}

/** A region's shops right now. */
export async function regionShopIds(regionId: string, tx: DBorTx = db): Promise<string[]> {
  return (await tx.select({ id: shops.id }).from(shops).where(eq(shops.regionId, regionId)).orderBy(asc(shops.name))).map((r) => r.id);
}

/** A scope as stored: the region a region scope points at (which must exist), or none. */
export async function resolveRegionScope(scope: ShopScope, regionId: string | null | undefined, tx: DBorTx = db): Promise<string | null> {
  if (scope !== "region") return null;
  if (!regionId) throw new AppError("bad_request", "Pick the region");
  const r = await tx.query.regions.findFirst({ where: eq(regions.id, regionId), columns: { id: true } });
  if (!r) throw notFound("Region");
  return r.id;
}

/** The one region all these shops are in, or null when they're split or some have none. */
export async function commonRegion(shopIds: readonly string[], tx: DBorTx = db): Promise<string | null> {
  if (!shopIds.length) return null;
  const rows = await tx.selectDistinct({ id: shops.regionId }).from(shops).where(inArray(shops.id, [...shopIds]));
  return rows.length === 1 ? rows[0].id : null;
}
