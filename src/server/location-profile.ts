import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopPhotos, shops } from "@/db/schema";
import { receiptBranding } from "@/domain/connect";
import { SHOP_PART_PERMISSION } from "@/domain/permissions";
import {
  LocationProfileInput,
  SHOP_PHOTOS_MAX,
  cleanAmenities,
  shopPhotoProblem,
  socialLinks,
  taxJurisdiction,
  validLatLng,
  type LocationProfileForm,
  type TaxJurisdiction,
} from "@/domain/location-profile";
import { audit } from "./audit";
import { assertShopAccess, can, type StaffContext } from "./auth/staff";
import { AppError, forbidden, notFound } from "./errors";
import { geocodeAddress, geocoderName } from "./geo";

/** Settings → Location profile: the form's values, the photos and logo, and which lookup is on. */
export async function loadLocationProfile(shopId: string) {
  const s = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!s) throw notFound("Shop");
  const photos = await db
    .select({ id: shopPhotos.id, kind: shopPhotos.kind, alt: shopPhotos.alt })
    .from(shopPhotos)
    .where(eq(shopPhotos.shopId, shopId))
    .orderBy(asc(shopPhotos.sortOrder), asc(shopPhotos.createdAt));
  return {
    slug: s.slug,
    name: s.name,
    form: {
      address: s.address,
      address2: s.address2,
      city: s.city,
      state: s.state,
      zip: s.zip,
      phone: s.phone ?? "",
      email: s.email ?? "",
      latitude: s.latitude,
      longitude: s.longitude,
      geocodeSource: s.geocodeSource,
      googlePlaceId: s.googlePlaceId ?? "",
      reviewUrl: receiptBranding(s.receipt).reviewUrl ?? "",
      social: socialLinks(s.social) as Record<string, string>,
      directions: s.directions ?? "",
      amenities: cleanAmenities(s.amenities),
      taxJurisdiction: taxJurisdiction(s.taxJurisdiction),
    } satisfies LocationProfileForm,
    textNumber: s.twilioNumber,
    geocodedAt: s.geocodedAt?.toISOString() ?? null,
    photos: photos.filter((p) => p.kind === "photo"),
    logo: photos.find((p) => p.kind === "logo") ?? null,
    logoUrl: s.logoUrl,
    geocoder: geocoderName(),
  };
}
export type LocationProfileView = Awaited<ReturnType<typeof loadLocationProfile>>;

const sameJurisdiction = (a: TaxJurisdiction, b: TaxJurisdiction) => a.county === b.county && a.city === b.city && a.district === b.district && a.code === b.code;

/**
 * Save a location's profile. Needs the shop's details part; the review link also needs its checkout
 * part (it's the receipt's), and the tax jurisdiction "Taxes and card fees". An address change
 * without a pin from the lookup, or a shop with no pin, is geocoded here (the ZIP's centre at worst).
 */
export async function saveLocationProfile(ctx: StaffContext, shopId: string, raw: LocationProfileForm, now = new Date()) {
  assertShopAccess(ctx, shopId);
  if (!can(ctx, "settings.shop") && !can(ctx, SHOP_PART_PERMISSION.details)) throw forbidden("You can't change this shop's details");
  const v = LocationProfileInput.parse(raw);
  const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!before) throw notFound("Shop");
  const receipt = receiptBranding(before.receipt);
  if (v.reviewUrl !== receipt.reviewUrl && !can(ctx, "settings.shop") && !can(ctx, SHOP_PART_PERMISSION.checkout)) throw forbidden("Changing the Google review link needs the shop's checkout and receipt settings");
  const oldTax = taxJurisdiction(before.taxJurisdiction);
  const newTax = v.taxJurisdiction ? taxJurisdiction(v.taxJurisdiction) : oldTax;
  if (!sameJurisdiction(oldTax, newTax) && !can(ctx, "settings.taxes")) throw forbidden("Only people who set taxes and card fees can change the tax jurisdiction");

  const addressChanged = (["address", "address2", "city", "state", "zip"] as const).some((k) => (before[k] ?? "") !== v[k]);
  let pin: { latitude: number | null; longitude: number | null; geocodeSource: typeof v.geocodeSource; geocodedAt: Date | null } = {
    latitude: before.latitude,
    longitude: before.longitude,
    geocodeSource: before.geocodeSource,
    geocodedAt: before.geocodedAt,
  };
  const given = { lat: v.latitude, lng: v.longitude };
  const moved = validLatLng(given) && (given.lat !== before.latitude || given.lng !== before.longitude);
  if (moved) pin = { latitude: given.lat, longitude: given.lng, geocodeSource: v.geocodeSource ?? "manual", geocodedAt: now };
  else if (v.latitude === null && before.latitude !== null && !addressChanged) pin = { latitude: null, longitude: null, geocodeSource: null, geocodedAt: null };
  if ((addressChanged && !moved) || pin.latitude === null) {
    const g = await geocodeAddress(v);
    if (g && g.lat !== null && g.lng !== null) pin = { latitude: g.lat, longitude: g.lng, geocodeSource: g.source, geocodedAt: now };
    else if (addressChanged && before.geocodeSource !== "manual") pin = { latitude: null, longitude: null, geocodeSource: null, geocodedAt: null };
  }

  const values = {
    address: v.address,
    address2: v.address2,
    city: v.city,
    state: v.state,
    zip: v.zip,
    phone: v.phone,
    email: v.email,
    googlePlaceId: v.googlePlaceId,
    social: v.social as Record<string, unknown>,
    directions: v.directions,
    amenities: v.amenities as string[],
    taxJurisdiction: newTax as unknown as Record<string, unknown>,
    ...pin,
  };
  await db.transaction(async (tx) => {
    await tx.update(shops).set(values).where(eq(shops.id, shopId));
    if (v.reviewUrl !== receipt.reviewUrl)
      await tx
        .update(shops)
        .set({ receipt: sql`${shops.receipt} || ${JSON.stringify({ reviewUrl: v.reviewUrl, ...(v.reviewUrl ? {} : { reviewFollowUp: { ...receipt.reviewFollowUp, enabled: false } }) })}::jsonb` })
        .where(eq(shops.id, shopId));
    const changed = Object.fromEntries(
      Object.entries(values).filter(([k, x]) => k !== "geocodedAt" && JSON.stringify(x ?? null) !== JSON.stringify((before as Record<string, unknown>)[k] ?? null)),
    );
    await audit(ctx.actor, "shop.location_profile", "shop", shopId, { changed, ...(v.reviewUrl !== receipt.reviewUrl ? { reviewUrl: v.reviewUrl } : {}) }, shopId, tx);
  });
  return { latitude: pin.latitude, longitude: pin.longitude, geocodeSource: pin.geocodeSource, phone: values.phone };
}

/** A photo for the public page, or the uploaded logo (which replaces the last one). */
export async function addShopPhoto(ctx: StaffContext, shopId: string, input: { kind: "photo" | "logo"; dataUrl: string; alt?: string | null }) {
  assertShopAccess(ctx, shopId);
  if (!can(ctx, "settings.shop") && !can(ctx, SHOP_PART_PERMISSION.details)) throw forbidden("You can't change this shop's details");
  if (input.kind !== "photo" && input.kind !== "logo") throw new AppError("bad_request", "A photo or the logo?");
  const problem = shopPhotoProblem(input.dataUrl);
  if (problem) throw new AppError("bad_request", problem);
  const alt = input.alt?.trim().slice(0, 140) || null;
  const id = await db.transaction(async (tx) => {
    let sortOrder = 0;
    if (input.kind === "logo") await tx.delete(shopPhotos).where(and(eq(shopPhotos.shopId, shopId), eq(shopPhotos.kind, "logo")));
    else {
      const [{ n, last }] = await tx
        .select({ n: sql<number>`count(*)::int`, last: sql<number>`coalesce(max(${shopPhotos.sortOrder}), 0)::int` })
        .from(shopPhotos)
        .where(and(eq(shopPhotos.shopId, shopId), eq(shopPhotos.kind, "photo")));
      if (n >= SHOP_PHOTOS_MAX) throw new AppError("bad_request", `Up to ${SHOP_PHOTOS_MAX} photos per location`);
      sortOrder = last + 1;
    }
    const [row] = await tx.insert(shopPhotos).values({ shopId, kind: input.kind, dataUrl: input.dataUrl, alt, sortOrder, createdBy: ctx.staff.id }).returning({ id: shopPhotos.id });
    await audit(ctx.actor, input.kind === "logo" ? "shop.logo_upload" : "shop.photo_add", "shop", shopId, { photo: row.id, alt }, shopId, tx);
    return row.id;
  });
  return { id };
}

export async function removeShopPhoto(ctx: StaffContext, photoId: string) {
  const [p] = await db.select({ shopId: shopPhotos.shopId, kind: shopPhotos.kind }).from(shopPhotos).where(eq(shopPhotos.id, photoId));
  if (!p) throw notFound("Photo");
  assertShopAccess(ctx, p.shopId);
  if (!can(ctx, "settings.shop") && !can(ctx, SHOP_PART_PERMISSION.details)) throw forbidden("You can't change this shop's details");
  await db.delete(shopPhotos).where(eq(shopPhotos.id, photoId));
  await audit(ctx.actor, p.kind === "logo" ? "shop.logo_remove" : "shop.photo_remove", "shop", p.shopId, { photo: photoId }, p.shopId);
  return { ok: true };
}

/** Move a photo one place earlier or later. */
export async function moveShopPhoto(ctx: StaffContext, photoId: string, dir: -1 | 1) {
  const [p] = await db.select({ shopId: shopPhotos.shopId }).from(shopPhotos).where(eq(shopPhotos.id, photoId));
  if (!p) throw notFound("Photo");
  assertShopAccess(ctx, p.shopId);
  if (!can(ctx, "settings.shop") && !can(ctx, SHOP_PART_PERMISSION.details)) throw forbidden("You can't change this shop's details");
  const list = await db
    .select({ id: shopPhotos.id })
    .from(shopPhotos)
    .where(and(eq(shopPhotos.shopId, p.shopId), eq(shopPhotos.kind, "photo")))
    .orderBy(asc(shopPhotos.sortOrder), asc(shopPhotos.createdAt));
  const i = list.findIndex((x) => x.id === photoId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return { ok: true };
  [list[i], list[j]] = [list[j], list[i]];
  await db.transaction(async (tx) => {
    for (const [n, x] of list.entries()) await tx.update(shopPhotos).set({ sortOrder: n + 1 }).where(eq(shopPhotos.id, x.id));
  });
  return { ok: true };
}

/** A photo for the public page, by its shop's slug: only for shops clients can see. */
export async function publicShopPhoto(slug: string, photoId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(photoId)) return null;
  const [p] = await db
    .select({ dataUrl: shopPhotos.dataUrl, status: shops.status })
    .from(shopPhotos)
    .innerJoin(shops, eq(shops.id, shopPhotos.shopId))
    .where(and(eq(shopPhotos.id, photoId), eq(shops.slug, slug.toLowerCase())));
  return p && (p.status === "live" || p.status === "closed") ? p.dataUrl : null;
}
