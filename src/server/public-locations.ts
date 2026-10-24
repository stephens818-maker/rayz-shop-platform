import "server-only";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopClosures, shopHours, shopPhotos, shops, staffSchedules, zipPoints } from "@/db/schema";
import { receiptBranding } from "@/domain/connect";
import { listedPublicly, takesOnlineBookings } from "@/domain/location-lifecycle";
import {
  LatLng,
  amenityLabel,
  cityLine,
  cleanAmenities,
  deepLinks,
  directionsUrl,
  fullAddress,
  haversineMiles,
  mapsUrl,
  openStatus,
  phoneView,
  socialLinks,
  validLatLng,
  weeklyHours,
  type PublicLocation,
} from "@/domain/location-profile";
import { appBaseUrl } from "@/lib/deployment";
import { addDays, minutesToHHMM, todayLocal } from "@/lib/time";
import { getAvailability } from "./booking";
import { getShop, shopCatalog } from "./catalog";
import { AppError, notFound } from "./errors";

type ShopRow = typeof shops.$inferSelect;

export interface LocationQuery {
  near?: LatLng | null;
  zip?: string | null;
  radiusMiles?: number | null;
  serviceId?: string | null;
  now?: Date;
  /** false: skip the next open slot (redirects and anything else that doesn't show it). */
  nextSlot?: boolean;
}

/** The URL a shop photo is served from. */
export const shopPhotoUrl = (base: string, slug: string, id: string) => `${base}/locations/${slug}/photos/${id}`;

const CLOSURE_DAYS = 90;
const NEXT_SLOT_DAYS = 14;
const CACHE_MS = 60_000;
const slotCache = new Map<string, { at: number; value: PublicLocation["nextAvailable"] }>();

/**
 * The first open slot in the next two weeks for the shop's first online service (or the one asked
 * for), any barber. Cached for a minute per shop and service, since the list asks for every shop.
 */
export async function nextAvailable(s: ShopRow, serviceId: string | null | undefined, now: Date, base: string): Promise<PublicLocation["nextAvailable"]> {
  const today = todayLocal(now);
  if (!takesOnlineBookings(s, today)) return null;
  const key = `${s.id}:${serviceId ?? ""}`;
  const hit = slotCache.get(key);
  if (!process.env.VITEST && hit && now.getTime() - hit.at < CACHE_MS) return hit.value;
  const services = (await shopCatalog(s.id, { onlineOnly: true })).filter((x) => x.kind === "service");
  const svc = serviceId ? services.find((x) => x.id === serviceId) : services[0];
  let value: PublicLocation["nextAvailable"] = null;
  if (svc) {
    const days = Math.min(NEXT_SLOT_DAYS, s.bookingWindowDays + 1);
    try {
      for (let i = 0; i < days && !value; i++) {
        const r = await getAvailability({ shopRef: s.id, date: addDays(today, i), serviceId: svc.id, barberRef: "any", now });
        const first = r.slots[0];
        if (first) value = { startsAt: first.startsAt, serviceId: svc.id, serviceName: svc.name, barberIds: first.barberIds, bookUrl: deepLinks(base, s.slug, { service: svc.slug }).booking };
      }
    } catch (e) {
      console.error("next available failed", s.slug, (e as Error).message);
    }
  }
  slotCache.set(key, { at: now.getTime(), value });
  return value;
}

async function zipCentres(zips: string[]) {
  const list = [...new Set(zips.map((z) => z.slice(0, 5)).filter((z) => /^\d{5}$/.test(z)))];
  if (!list.length) return new Map<string, LatLng>();
  const rows = await db.select().from(zipPoints).where(inArray(zipPoints.zip, list));
  return new Map(rows.map((r) => [r.zip, { lat: r.lat, lng: r.lng }]));
}

async function serialize(rows: ShopRow[], q: LocationQuery): Promise<PublicLocation[]> {
  if (!rows.length) return [];
  const now = q.now ?? new Date();
  const base = appBaseUrl();
  const ids = rows.map((r) => r.id);
  const today = todayLocal(now);
  const [hours, closures, photos, counts, centres] = await Promise.all([
    db.select().from(shopHours).where(inArray(shopHours.shopId, ids)).orderBy(asc(shopHours.weekday), asc(shopHours.openMin)),
    db
      .select()
      .from(shopClosures)
      .where(and(inArray(shopClosures.shopId, ids), gte(shopClosures.date, today), lte(shopClosures.date, addDays(today, CLOSURE_DAYS))))
      .orderBy(asc(shopClosures.date)),
    db
      .select({ id: shopPhotos.id, shopId: shopPhotos.shopId, kind: shopPhotos.kind, alt: shopPhotos.alt })
      .from(shopPhotos)
      .where(inArray(shopPhotos.shopId, ids))
      .orderBy(asc(shopPhotos.sortOrder), asc(shopPhotos.createdAt)),
    db
      .select({ shopId: staffSchedules.shopId, n: sql<number>`count(distinct ${staffSchedules.staffId})::int` })
      .from(staffSchedules)
      .where(inArray(staffSchedules.shopId, ids))
      .groupBy(staffSchedules.shopId),
    zipCentres(rows.filter((r) => !validLatLng({ lat: r.latitude, lng: r.longitude })).map((r) => r.zip)),
  ]);
  const out = await Promise.all(
    rows.map(async (s): Promise<PublicLocation> => {
      const h = hours.filter((x) => x.shopId === s.id);
      const c = closures.filter((x) => x.shopId === s.id).map((x) => ({ date: x.date, reason: x.reason }));
      const pin = validLatLng({ lat: s.latitude, lng: s.longitude }) ? { lat: s.latitude!, lng: s.longitude!, approximate: s.geocodeSource === "zip" } : centres.has(s.zip.slice(0, 5)) ? { ...centres.get(s.zip.slice(0, 5))!, approximate: true } : null;
      const status = openStatus({ hours: h, closures: c, now, timezone: s.timezone, closedThrough: s.status === "closed" ? (s.closedUntil ?? "indefinite") : null });
      const bookingEnabled = takesOnlineBookings(s, today);
      const pics = photos.filter((p) => p.shopId === s.id);
      const logo = pics.find((p) => p.kind === "logo");
      const links = deepLinks(base, s.slug);
      const target = { ...s, latitude: pin?.lat ?? null, longitude: pin?.lng ?? null };
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status === "closed" ? "closed" : "live",
        description: s.description,
        address: { line1: s.address, line2: s.address2, city: s.city, state: s.state, zip: s.zip, country: "US", full: fullAddress(s) },
        geo: pin,
        distanceMiles: null,
        phone: phoneView(s.phone, "tel"),
        textNumber: phoneView(s.twilioNumber, "sms"),
        email: s.email,
        timezone: s.timezone,
        hours: h.map((x) => ({ weekday: x.weekday, open: minutesToHHMM(x.openMin), close: minutesToHHMM(x.closeMin) })),
        weeklyHours: weeklyHours(h),
        closures: c,
        openNow: status.openNow,
        openStatus: { closesAt: status.closesAt, nextOpenAt: status.nextOpenAt, today: status.today, label: status.label },
        nextAvailable: q.nextSlot === false ? null : await nextAvailable(s, q.serviceId, now, base),
        bookingEnabled,
        closedNote: s.status === "closed" && !bookingEnabled ? (s.closedNote ?? "This shop is temporarily closed.") : null,
        closedUntil: s.status === "closed" ? s.closedUntil : null,
        cancelCutoffMinutes: s.cancelCutoffMinutes,
        barberCount: counts.find((x) => x.shopId === s.id)?.n ?? 0,
        links: { booking: links.booking, app: links.app, embed: links.embed, location: links.location, map: mapsUrl(target), directions: directionsUrl(target), review: receiptBranding(s.receipt).reviewUrl },
        googlePlaceId: s.googlePlaceId,
        social: socialLinks(s.social),
        photos: pics.filter((p) => p.kind === "photo").map((p) => ({ id: p.id, url: shopPhotoUrl(base, s.slug, p.id), alt: p.alt ?? `${s.name}` })),
        logoUrl: logo ? shopPhotoUrl(base, s.slug, logo.id) : s.logoUrl,
        accentColor: s.accentColor,
        directions: s.directions,
        amenities: cleanAmenities(s.amenities).map((k) => ({ key: k, label: amenityLabel(k) })),
      };
    }),
  );
  return out;
}

async function origin(q: LocationQuery): Promise<LatLng | null> {
  if (q.near) return validLatLng(q.near) ? q.near : null;
  if (!q.zip) return null;
  const p = await db.query.zipPoints.findFirst({ where: eq(zipPoints.zip, q.zip) });
  if (!p) throw new AppError("bad_request", "We don't know that ZIP code");
  return { lat: p.lat, lng: p.lng };
}

/** Every location clients can see: by name, or nearest first from a point or ZIP (within the radius, if given). */
export async function publicLocations(q: LocationQuery = {}): Promise<PublicLocation[]> {
  const from = await origin(q);
  const rows = await db.select().from(shops).where(inArray(shops.status, ["live", "closed"])).orderBy(asc(shops.name));
  const list = await serialize(rows, q);
  if (!from) return list;
  for (const l of list) l.distanceMiles = l.geo ? Math.round(haversineMiles(from, l.geo) * 10) / 10 : null;
  return list
    .filter((l) => !q.radiusMiles || (l.distanceMiles !== null && l.distanceMiles <= q.radiusMiles))
    .sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity) || a.name.localeCompare(b.name));
}

/** One location by slug or ID. One being set up or archived doesn't exist for clients. */
export async function publicLocation(ref: string, q: LocationQuery = {}): Promise<PublicLocation> {
  const s = await getShop(ref.toLowerCase()).catch(() => getShop(ref));
  if (!listedPublicly(s)) throw notFound("Location");
  const [l] = await serialize([s], q);
  return l;
}

/** For the JSON-LD and the page: the location plus what only the page needs. */
export async function publicLocationPage(ref: string, now = new Date()) {
  const l = await publicLocation(ref, { now });
  return { ...l, cityLine: cityLine(l.address) };
}
