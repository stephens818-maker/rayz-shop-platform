import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, entityFeeTerms, entityPaymentAccounts, ownerEntities, regions, shops, staff } from "@/db/schema";
import { brandStandards, standardsProblem } from "@/domain/brand-standards";
import {
  ENTITY_STATUSES,
  EntityTaxSettingsSchema,
  type FeeTerms,
  type OwnerEntityKind,
  type OwnerEntityStatus,
  entityProblem,
  feeTermsProblem,
  franchiseData,
  FranchiseDataSchema,
  regionFitProblem,
  regionProblem,
  slugify,
} from "@/domain/franchise";
import { todayLocal } from "@/lib/time";
import { type Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { type EntityViewer, entityReach } from "./hierarchy";

export interface EntityRecord {
  name: string;
  legalName: string | null;
  kind: OwnerEntityKind;
  contactEmail: string | null;
  payrollCompanyCode: string | null;
  status: OwnerEntityStatus;
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Creates or edits an owner group (the brand's job). An owner group with locations can't be marked exited. */
export async function saveEntity(actor: Actor, id: string | null, v: EntityRecord) {
  const problem = entityProblem(v);
  if (problem) throw new AppError("bad_request", problem);
  if (!ENTITY_STATUSES.includes(v.status)) throw new AppError("bad_request", "Pick a status");
  const values = {
    name: v.name.trim(),
    legalName: blank(v.legalName),
    kind: v.kind,
    contactEmail: blank(v.contactEmail),
    payrollCompanyCode: blank(v.payrollCompanyCode),
    status: v.status,
  };
  return db.transaction(async (tx) => {
    if (!id) {
      const [row] = await tx.insert(ownerEntities).values(values).returning({ id: ownerEntities.id });
      await audit(actor, "owner_entity.create", "owner_entity", row.id, values, null, tx);
      return { id: row.id };
    }
    const before = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, id) });
    if (!before) throw notFound("Owner group");
    if (v.status === "exited" && before.status !== "exited") {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(shops).where(eq(shops.ownerEntityId, id));
      if (n.n) throw new AppError("conflict", "Move its locations to another owner group before marking it exited");
    }
    if (before.kind === "brand" && v.kind !== "brand") {
      const [n] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(ownerEntities)
        .where(and(eq(ownerEntities.kind, "brand"), ne(ownerEntities.id, id)));
      if (!n.n) throw new AppError("conflict", "Rayz corporate's own owner group stays corporate");
    }
    await tx
      .update(ownerEntities)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(ownerEntities.id, id));
    await audit(actor, "owner_entity.update", "owner_entity", id, { ...values, from: { name: before.name, kind: before.kind, status: before.status } }, null, tx);
    return { id };
  });
}

/** What an owner group may keep up itself (entity.settings): contact, payroll company code and sales tax filing. */
export async function saveEntitySettings(actor: Actor, entityId: string, v: { contactEmail: string | null; payrollCompanyCode: string | null; taxSettings: unknown }) {
  const before = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, entityId) });
  if (!before) throw notFound("Owner group");
  const problem = entityProblem({ name: before.name, kind: before.kind, contactEmail: blank(v.contactEmail), payrollCompanyCode: blank(v.payrollCompanyCode) });
  if (problem) throw new AppError("bad_request", problem);
  const taxSettings = EntityTaxSettingsSchema.parse(v.taxSettings ?? {});
  const values = { contactEmail: blank(v.contactEmail), payrollCompanyCode: blank(v.payrollCompanyCode), taxSettings };
  await db
    .update(ownerEntities)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(ownerEntities.id, entityId));
  await audit(actor, "owner_entity.settings", "owner_entity", entityId, values, null);
}

/**
 * New royalty and ad fund rates for an owner group from a date. Rates are effective-dated and never
 * rewritten: charges already took application fees at the old ones, so a start date can't be in the
 * past. Rates that haven't started yet can be replaced.
 */
export async function addFeeTerms(actor: Actor, entityId: string, t: FeeTerms, today = todayLocal()) {
  const problem = feeTermsProblem(t);
  if (problem) throw new AppError("bad_request", problem);
  if (t.effectiveFrom < today) throw new AppError("bad_request", "Rates can start today or later; past charges already used the rates in force then");
  const owner = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, entityId), columns: { id: true, kind: true, name: true } });
  if (!owner) throw notFound("Owner group");
  if (owner.kind === "brand") throw new AppError("bad_request", "Rayz corporate's own locations don't pay royalties");
  const existing = await db.query.entityFeeTerms.findFirst({ where: and(eq(entityFeeTerms.ownerEntityId, entityId), eq(entityFeeTerms.effectiveFrom, t.effectiveFrom)) });
  if (existing && existing.effectiveFrom <= today) throw new AppError("conflict", "Rates starting today are already in force; start the change tomorrow");
  const values = { royaltyBps: t.royaltyBps, adFundBps: t.adFundBps, collect: t.collect, createdBy: actor.staffId ?? null };
  await db
    .insert(entityFeeTerms)
    .values({ ownerEntityId: entityId, effectiveFrom: t.effectiveFrom, ...values })
    .onConflictDoUpdate({ target: [entityFeeTerms.ownerEntityId, entityFeeTerms.effectiveFrom], set: values });
  await audit(actor, "owner_entity.fee_terms", "owner_entity", entityId, { owner: owner.name, effectiveFrom: t.effectiveFrom, ...values, replaced: !!existing }, null);
}

async function freeSlug(name: string, exceptId: string | null) {
  const base = slugify(name);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const hit = await db.query.regions.findFirst({ where: eq(regions.slug, slug), columns: { id: true } });
    if (!hit || hit.id === exceptId) return slug;
  }
}

/**
 * A brand market (no owner group: can hold any owner's locations) or an owner group's own region.
 * Giving a region an owner group needs every location already in it to be that owner's.
 */
export async function saveRegion(actor: Actor, id: string | null, v: { name: string; ownerEntityId: string | null }) {
  const problem = regionProblem(v);
  if (problem) throw new AppError("bad_request", problem);
  if (v.ownerEntityId) {
    const owner = await db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, v.ownerEntityId), columns: { id: true } });
    if (!owner) throw notFound("Owner group");
  }
  const name = v.name.trim();
  if (!id) {
    const [row] = await db
      .insert(regions)
      .values({ name, slug: await freeSlug(name, null), ownerEntityId: v.ownerEntityId })
      .returning({ id: regions.id });
    await audit(actor, "region.create", "region", row.id, { name, ownerEntityId: v.ownerEntityId }, null);
    return { id: row.id };
  }
  const before = await db.query.regions.findFirst({ where: eq(regions.id, id) });
  if (!before) throw notFound("Region");
  if (v.ownerEntityId && v.ownerEntityId !== before.ownerEntityId) {
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(shops)
      .where(and(eq(shops.regionId, id), sql`${shops.ownerEntityId} is distinct from ${v.ownerEntityId}`));
    if (n.n) throw new AppError("conflict", "Some of its locations belong to another owner group; move them out first, or keep it a brand market");
  }
  if (!v.ownerEntityId && before.ownerEntityId) {
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(staff)
      .where(eq(staff.scopeRegionId, id));
    if (n.n) throw new AppError("conflict", "People are scoped to this owner group's region; change their access before making it a brand market");
  }
  const slug = name === before.name ? before.slug : await freeSlug(name, id);
  await db.update(regions).set({ name, slug, ownerEntityId: v.ownerEntityId }).where(eq(regions.id, id));
  await audit(actor, "region.update", "region", id, { name, ownerEntityId: v.ownerEntityId, from: { name: before.name, ownerEntityId: before.ownerEntityId } }, null);
  return { id };
}

/** Only an empty region with nobody scoped to it can go. */
export async function deleteRegion(actor: Actor, id: string) {
  const before = await db.query.regions.findFirst({ where: eq(regions.id, id) });
  if (!before) throw notFound("Region");
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(shops).where(eq(shops.regionId, id));
  if (s.n) throw new AppError("conflict", "Move its locations out of the region first");
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(staff).where(eq(staff.scopeRegionId, id));
  if (p.n) throw new AppError("conflict", "People are scoped to this region; change their access first");
  await db.delete(regions).where(eq(regions.id, id));
  await audit(actor, "region.delete", "region", id, { name: before.name }, null);
}

/**
 * Moves a location to another owner group and/or region (a resale, or a regrouping). History stays
 * with the owner of the day (shop_owner_history), and access follows: people scoped to the new
 * owner or region gain the location, the old owner's lose it (database triggers). When the region
 * isn't given, a region that no longer fits the new owner is cleared.
 */
export async function moveShop(actor: Actor, shopId: string, v: { ownerEntityId: string; regionId?: string | null }) {
  return db.transaction(async (tx) => {
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true, ownerEntityId: true, regionId: true, paymentsMode: true } });
    if (!shop) throw notFound("Location");
    const owner = await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, v.ownerEntityId), columns: { id: true, name: true, status: true } });
    if (!owner) throw notFound("Owner group");
    if (owner.status === "exited" && owner.id !== shop.ownerEntityId) throw new AppError("bad_request", `${owner.name} has left the system`);
    let regionId = v.regionId === undefined ? shop.regionId : v.regionId;
    if (regionId) {
      const region = await tx.query.regions.findFirst({ where: eq(regions.id, regionId), columns: { ownerEntityId: true } });
      if (!region) throw notFound("Region");
      const misfit = regionFitProblem(region, owner.id);
      if (misfit && v.regionId !== undefined) throw new AppError("bad_request", misfit);
      if (misfit) regionId = null;
    }
    if (shop.ownerEntityId === owner.id && shop.regionId === regionId) return { notes: [] as string[] };
    await tx.update(shops).set({ ownerEntityId: owner.id, regionId }).where(eq(shops.id, shopId));
    await audit(actor, "shop.owner", "shop", shopId, { shop: shop.name, from: shop.ownerEntityId, to: owner.id, owner: owner.name, regionFrom: shop.regionId, region: regionId }, shopId, tx);
    const notes: string[] = [];
    if (shop.ownerEntityId !== owner.id && shop.paymentsMode === "connected")
      notes.push(`${shop.name} still settles in its own Stripe account, which belongs to the business that set it up. Switch it to the owner group's account under Payments and banking if the new owner should be paid.`);
    if (shop.ownerEntityId !== owner.id && shop.paymentsMode === "entity") notes.push(`${shop.name}'s card payments now go to ${owner.name}'s Stripe account.`);
    return { notes };
  });
}

export async function saveStandards(actor: Actor, raw: unknown) {
  const s = brandStandards(raw);
  const problem = standardsProblem(s);
  if (problem) throw new AppError("bad_request", problem);
  await db.update(brandSettings).set({ standards: s as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "brand.standards", "brand", "1", { ...s }, null);
  return s;
}

/** The brand's client-data settings for franchise agreements; every change is in the audit log with the agreement reference. */
export async function saveFranchiseData(actor: Actor, raw: unknown) {
  const v = FranchiseDataSchema.parse(raw ?? {});
  const [row] = await db.select({ franchise: brandSettings.franchise }).from(brandSettings).where(eq(brandSettings.id, 1));
  const before = franchiseData(row?.franchise);
  await db.update(brandSettings).set({ franchise: v, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "brand.franchise_data", "brand", "1", { ...v, from: before }, null);
  return v;
}

export async function loadFranchiseData() {
  const [row] = await db.select({ franchise: brandSettings.franchise, standards: brandSettings.standards }).from(brandSettings).where(eq(brandSettings.id, 1));
  return { data: franchiseData(row?.franchise), standards: brandStandards(row?.standards) };
}

/**
 * The franchise page's data, within reach: owner groups with their locations, Stripe account and
 * rates (the current ones and any scheduled), and regions. Shops are only those the viewer reaches.
 */
export async function franchiseOverview(v: EntityViewer, today = todayLocal()) {
  const reach = entityReach(v);
  const visibleOwners =
    reach === null
      ? undefined
      : reach.length
        ? inArray(ownerEntities.id, reach)
        : v.shopIds.length
          ? sql`${ownerEntities.id} in (select owner_entity_id from shops where id in (${sql.join(
              v.shopIds.map((s) => sql`${s}::uuid`),
              sql`, `,
            )}))`
          : sql`false`;
  const owners = await db
    .select({ e: ownerEntities, a: entityPaymentAccounts })
    .from(ownerEntities)
    .leftJoin(entityPaymentAccounts, eq(entityPaymentAccounts.ownerEntityId, ownerEntities.id))
    .where(visibleOwners)
    .orderBy(sql`${ownerEntities.kind} <> 'brand'`, asc(ownerEntities.name));
  const ids = owners.map((o) => o.e.id);
  const [shopRows, termRows, regionRows] = await Promise.all([
    db
      .select({ id: shops.id, name: shops.name, status: shops.status, ownerEntityId: shops.ownerEntityId, regionId: shops.regionId, paymentsMode: shops.paymentsMode })
      .from(shops)
      .where(reach === null ? undefined : v.shopIds.length ? inArray(shops.id, [...v.shopIds]) : sql`false`)
      .orderBy(asc(shops.name)),
    ids.length
      ? db
          .select()
          .from(entityFeeTerms)
          .where(inArray(entityFeeTerms.ownerEntityId, ids))
          .orderBy(asc(entityFeeTerms.ownerEntityId), desc(entityFeeTerms.effectiveFrom))
      : Promise.resolve([]),
    db
      .select({ id: regions.id, name: regions.name, ownerEntityId: regions.ownerEntityId })
      .from(regions)
      .where(reach === null ? undefined : ids.length ? sql`${regions.ownerEntityId} is null or ${inArray(regions.ownerEntityId, ids)}` : sql`${regions.ownerEntityId} is null`)
      .orderBy(asc(regions.name)),
  ]);
  return {
    entities: owners.map(({ e, a }) => {
      const terms = termRows.filter((t) => t.ownerEntityId === e.id);
      return {
        ...e,
        account: a,
        shops: shopRows.filter((s) => s.ownerEntityId === e.id),
        currentTerms: terms.find((t) => t.effectiveFrom <= today) ?? null,
        scheduledTerms: terms.filter((t) => t.effectiveFrom > today).reverse(),
      };
    }),
    regions: regionRows.map((r) => ({ ...r, shops: shopRows.filter((s) => s.regionId === r.id) })),
    shops: shopRows,
  };
}
