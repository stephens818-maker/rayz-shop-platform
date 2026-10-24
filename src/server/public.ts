import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, shopHours, shopPhotos, shops, staffSchedules } from "@/db/schema";
import { listedPublicly, takesOnlineBookings } from "@/domain/location-lifecycle";
import { shopPhotoUrl } from "@/domain/location-profile";
import { minutesToHHMM, todayLocal } from "@/lib/time";
import { getAppointmentByCode } from "./booking";
import { getShop, shopBarbers, shopCatalog } from "./catalog";
import { notFound } from "./errors";
export async function publicShops() {
  const [rows, hours, counts] = await Promise.all([
    db.select().from(shops).where(inArray(shops.status, ["live", "closed"])).orderBy(asc(shops.name)),
    db.select().from(shopHours).orderBy(asc(shopHours.weekday)),
    db
      .select({ shopId: staffSchedules.shopId, n: sql<number>`count(distinct ${staffSchedules.staffId})::int` })
      .from(staffSchedules)
      .groupBy(staffSchedules.shopId),
  ]);
  return rows.map((s) => serializeShop(s, hours.filter((h) => h.shopId === s.id), counts.find((c) => c.shopId === s.id)?.n ?? 0));
}

export function serializeShop(s: typeof shops.$inferSelect, hours: (typeof shopHours.$inferSelect)[], barberCount: number) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    address: s.address,
    address2: s.address2,
    city: s.city,
    state: s.state,
    zip: s.zip,
    phone: s.phone,
    timezone: "America/Chicago" as const,
    bookingEnabled: takesOnlineBookings(s, todayLocal()),
    cancelCutoffMinutes: s.cancelCutoffMinutes,
    barberCount,
    hours: hours.map((h) => ({ weekday: h.weekday, open: minutesToHHMM(h.openMin), close: minutesToHHMM(h.closeMin) })),
  };
}

/** Clients see live and temporarily closed shops; one being set up or archived doesn't exist for them. */
export async function publicShop(ref: string) {
  const s = await getShop(ref);
  if (!listedPublicly(s)) throw notFound("Shop");
  const hours = await db.select().from(shopHours).where(eq(shopHours.shopId, s.id)).orderBy(asc(shopHours.weekday));
  const barbers = await shopBarbers(s.id, { onlineOnly: true });
  return serializeShop(s, hours, barbers.length);
}

/** The web booking page: the shop, plus its closure note and branding. */
export async function publicShopPage(ref: string) {
  const s = await getShop(ref);
  const shop = await publicShop(ref);
  const logo = await db.query.shopPhotos.findFirst({ where: and(eq(shopPhotos.shopId, s.id), eq(shopPhotos.kind, "logo")), columns: { id: true } });
  return {
    ...shop,
    closedNote: s.status === "closed" && !shop.bookingEnabled ? (s.closedNote ?? "This shop is temporarily closed.") : null,
    closedUntil: s.closedUntil,
    accentColor: s.accentColor,
    logoUrl: logo ? shopPhotoUrl("", s.slug, logo.id) : s.logoUrl,
  };
}

export async function publicServices(ref: string) {
  const s = await getShop(ref);
  if (!listedPublicly(s)) throw notFound("Shop");
  const all = (await shopCatalog(s.id, { onlineOnly: true })).map((x) => ({
    id: x.id,
    slug: x.slug,
    name: x.name,
    kind: x.kind,
    category: x.category,
    description: x.description,
    priceCents: x.priceCents,
    durationMin: x.durationMin,
  }));
  return { services: all.filter((x) => x.kind === "service"), addons: all.filter((x) => x.kind === "addon") };
}

export async function publicMe(customerId: string) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) throw notFound("Customer");
  return { id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email, smsOptIn: c.smsOptIn, emailOptIn: c.emailOptIn };
}

export async function tokenResponse(r: { isNew: boolean; accessToken: string; refreshToken: string; tokenType: "Bearer"; expiresIn: number; customer: { id: string } }) {
  return {
    needsProfile: false,
    isNew: r.isNew,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    tokenType: r.tokenType,
    expiresIn: r.expiresIn,
    customer: await publicMe(r.customer.id),
  };
}

export async function myAppointments(customerId: string, now = new Date()) {
  const [upcoming, past] = await Promise.all([
    db
      .select({ code: appointments.code })
      .from(appointments)
      .where(and(eq(appointments.customerId, customerId), gte(appointments.startsAt, now), inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service"])))
      .orderBy(asc(appointments.startsAt))
      .limit(20),
    db
      .select({ code: appointments.code })
      .from(appointments)
      .where(and(eq(appointments.customerId, customerId), lt(appointments.startsAt, now)))
      .orderBy(desc(appointments.startsAt))
      .limit(20),
  ]);
  return {
    upcoming: await Promise.all(upcoming.map((a) => getAppointmentByCode(a.code, now))),
    past: await Promise.all(past.map((a) => getAppointmentByCode(a.code, now))),
  };
}
