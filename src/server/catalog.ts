import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { catalogCategories, services, shopHours, shopServices, shops, staff, staffSchedules, staffShops, Shop, TaxCategory } from "@/db/schema";
import { notFound } from "./errors"; import { timingAt } from "./brand-sync/adapters/service-rules";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getShop(ref: string, tx: DBorTx = db): Promise<Shop> {
  const where = UUID_RE.test(ref) ? or(eq(shops.id, ref), eq(shops.slug, ref)) : eq(shops.slug, ref);
  const row = await tx.query.shops.findFirst({ where });
  if (!row) throw notFound("Shop");
  return row;
}

export interface EffectiveService {
  id: string;
  slug: string;
  name: string;
  kind: "service" | "addon";
  category: string;
  description: string | null;
  priceCents: number;
  /** At this shop. A barber's own duration (staff_service_durations) can beat it: see src/server/timing.ts. */
  durationMin: number;
  durationStepMin: number;
  bookingIncrementMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  bookableOnline: boolean;
  sortOrder: number;
  taxCategory: TaxCategory;
}

/** Master catalog merged with the shop's overrides. Only services enabled at the shop are returned. */
export async function shopCatalog(shopId: string, opts: { onlineOnly?: boolean } = {}, tx: DBorTx = db): Promise<EffectiveService[]> {
  const rows = await tx
    .select({ s: services, o: shopServices })
    .from(shopServices)
    .innerJoin(services, eq(services.id, shopServices.serviceId))
    .leftJoin(catalogCategories, and(eq(catalogCategories.kind, "service"), sql`lower(${catalogCategories.name}) = lower(${services.category})`))
    .where(and(eq(shopServices.shopId, shopId), eq(shopServices.enabled, true), eq(services.active, true)))
    .orderBy(asc(services.kind), sql`coalesce(${catalogCategories.sortOrder}, 100000)`, asc(services.sortOrder), asc(services.name)); const timing = await timingAt(shopId, tx);
  return rows
    .map(({ s, o }) => ({ s: { ...s, ...timing.get(s.id) }, o }))
    .map(({ s, o }) => ({
      id: s.id,
      slug: s.slug,
      name: o.nameOverride ?? s.name,
      kind: s.kind,
      category: s.category,
      description: s.description,
      priceCents: o.priceCents ?? s.defaultPriceCents,
      durationMin: o.durationMin ?? s.defaultDurationMin,
      durationStepMin: s.durationStepMin,
      bookingIncrementMin: s.bookingIncrementMin,
      bufferBeforeMin: s.bufferBeforeMin,
      bufferAfterMin: s.bufferAfterMin,
      bookableOnline: o.bookableOnline,
      sortOrder: s.sortOrder,
      taxCategory: s.taxCategory,
    }))
    .filter((s) => !opts.onlineOnly || s.bookableOnline);
}

export interface PublicBarber {
  id: string;
  slug: string;
  /** Admin-set label (e.g. "Taylor R."). First names only — never a surname. */
  displayName: string;
  color: string;
  photoUrl: string | null;
}

/** Barbers who are bookable at a shop. Surnames are never selected. */
export async function shopBarbers(shopId: string, opts: { onlineOnly?: boolean } = {}, tx: DBorTx = db): Promise<PublicBarber[]> {
  const rows = await tx
    .select({
      id: staff.id,
      slug: staff.publicSlug,
      displayName: staff.displayLabel,
      color: staff.color,
      visibleOnline: staffShops.visibleOnline,
    })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staff.active, true), eq(staff.isBookable, true)))
    .orderBy(asc(staff.displayLabel));
  // Only barbers with weekly hours at this shop can actually take bookings here.
  const scheduled = await tx
    .selectDistinct({ staffId: staffSchedules.staffId })
    .from(staffSchedules)
    .where(eq(staffSchedules.shopId, shopId));
  const has = new Set(scheduled.map((s) => s.staffId));
  return rows
    .filter((r) => has.has(r.id) && (!opts.onlineOnly || r.visibleOnline))
    .map(({ id, slug, displayName, color }) => ({ id, slug, displayName, color, photoUrl: null }));
}

export async function shopWeeklyHours(shopId: string, tx: DBorTx = db) {
  return tx.select().from(shopHours).where(eq(shopHours.shopId, shopId)).orderBy(asc(shopHours.weekday));
}

export async function servicesByIds(shopId: string, ids: string[], tx: DBorTx = db): Promise<EffectiveService[]> {
  if (ids.length === 0) return [];
  const all = await shopCatalog(shopId, {}, tx);
  const byId = new Map(all.map((s) => [s.id, s]));
  return ids.map((id) => {
    const s = byId.get(id);
    if (!s) throw notFound(`Service ${id} at this shop`);
    return s;
  });
}

export async function resolveStaffRef(ref: string, tx: DBorTx = db) {
  const where = UUID_RE.test(ref) ? or(eq(staff.id, ref), eq(staff.publicSlug, ref)) : eq(staff.publicSlug, ref);
  return tx.query.staff.findFirst({ where });
}

export async function shopsByIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(shops).where(inArray(shops.id, ids)).orderBy(asc(shops.name));
}
