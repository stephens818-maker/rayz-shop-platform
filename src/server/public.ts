import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, shopHours, shopPhotos, shops, staff, staffSchedules } from "@/db/schema";
import { listedPublicly, takesOnlineBookings } from "@/domain/location-lifecycle";
import { shopPhotoUrl } from "@/domain/location-profile";
import { minutesToHHMM, todayLocal } from "@/lib/time";
import { needsIdentityCheck, type SignInResult } from "./auth/customer";
import { getAppointmentByCode } from "./booking";
import { getShop, shopBarbers, shopCatalog } from "./catalog";
import { AppError, notFound } from "./errors";
import { shopDefaults } from "./location-defaults";
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
    bookingMode: s.bookingMode,
    externalBookingUrl: s.bookingMode === "external" ? s.externalBookingUrl : null,
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

/** GET /shops/{shop} (I9): the shop plus the policy text the booking site shows before a client confirms. */
export async function publicShopDetail(ref: string) {
  const shop = await publicShop(ref);
  const d = await shopDefaults(shop.id);
  return { ...shop, policies: { cancellation: d.cancellationPolicy || null, noShow: d.noShowPolicy || null, cancelCutoffMinutes: shop.cancelCutoffMinutes } };
}

/** The web booking page: the shop, plus its closure note and branding. */
export async function publicShopPage(ref: string) {
  const s = await getShop(ref);
  const shop = await publicShop(ref);
  const [logo, d] = await Promise.all([
    db.query.shopPhotos.findFirst({ where: and(eq(shopPhotos.shopId, s.id), eq(shopPhotos.kind, "logo")), columns: { id: true } }),
    shopDefaults(s.id),
  ]);
  return {
    ...shop,
    headline: d.bookingHeadline || null,
    cancellationPolicy: d.cancellationPolicy || null,
    noShowPolicy: d.noShowPolicy || null,
    tracking: { ga4: d.ga4MeasurementId, metaPixel: d.metaPixelId },
    closedNote: s.status === "closed" && !takesOnlineBookings({ ...s, bookingMode: "platform" }, todayLocal()) ? (s.closedNote ?? "This shop is temporarily closed.") : null,
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
  const home = c.homeShopId ? await db.query.shops.findFirst({ where: eq(shops.id, c.homeShopId), columns: { id: true, slug: true, name: true, status: true } }) : null;
  const barber = c.preferredStaffId
    ? await db.query.staff.findFirst({ where: and(eq(staff.id, c.preferredStaffId), eq(staff.active, true), eq(staff.isBookable, true)), columns: { id: true, publicSlug: true, displayLabel: true } })
    : null;
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    email: c.email,
    emailVerified: !!(c.email && c.emailVerifiedAt),
    secured: !!c.securedAt,
    identityCheckRequired: await needsIdentityCheck(c),
    smsOptIn: c.smsOptIn,
    emailOptIn: c.emailOptIn,
    pushTransactional: c.pushTransactional,
    smsMarketingOptIn: c.smsMarketingOptIn,
    emailMarketingOptIn: c.emailMarketingOptIn,
    pushMarketing: c.pushMarketing,
    receiptDelivery: c.receiptDelivery ?? null,
    homeShop: home && listedPublicly(home) ? { id: home.id, slug: home.slug, name: home.name } : null,
    birthday: c.birthday ?? null,
    preferences: {
      note: c.preferencesNote,
      updatedAt: c.preferencesUpdatedAt?.toISOString() ?? null,
      preferredBarber: barber ? { id: barber.id, slug: barber.publicSlug, displayName: barber.displayLabel } : null,
    },
  };
}

export async function tokenResponse(r: { isNew: boolean; accessToken: string; refreshToken: string; tokenType: "Bearer"; expiresIn: number; customer: { id: string }; identityCheckRequired?: boolean }) {
  return {
    needsProfile: false,
    isNew: r.isNew,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    tokenType: r.tokenType,
    expiresIn: r.expiresIn,
    identityCheckRequired: r.identityCheckRequired ?? false,
    customer: await publicMe(r.customer.id),
  };
}

/** Whatever a sign-in step returned, as the API sends it: tokens, or the next step. */
export async function signInResponse(r: SignInResult) {
  if ("accessToken" in r) return tokenResponse(r);
  return r;
}

const ACTIVE_APPOINTMENT = ["booked", "confirmed", "checked_in", "in_service"] as const;
export type AppointmentFilter = "upcoming" | "past" | "cancelled";
type ListCursor = { l: AppointmentFilter; t: string; id: string };

const encodeCursor = (c: ListCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): ListCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ListCursor;
    if (["upcoming", "past", "cancelled"].includes(c.l) && !Number.isNaN(Date.parse(c.t)) && /^[0-9a-f-]{36}$/i.test(c.id)) return c;
  } catch {}
  throw new AppError("bad_request", "That cursor isn't valid; start from the first page", { field: "cursor" });
}

export interface MyAppointmentsQuery {
  status?: AppointmentFilter;
  limit?: number;
  cursor?: string;
  /** Children on the account too (I6). Each appointment's `customer` says whose it is. */
  family?: boolean;
}

/**
 * Upcoming soonest first; past (any status) and cancelled (any date) newest first. Keyset pages on
 * (startsAt, id), so a booking made between pages never repeats or skips one.
 */
async function appointmentPage(who: string[], list: AppointmentFilter, limit: number, after: ListCursor | null, now: Date) {
  const forward = list === "upcoming";
  const whose = inArray(appointments.customerId, who);
  const which =
    list === "upcoming"
      ? and(gte(appointments.startsAt, now), inArray(appointments.status, [...ACTIVE_APPOINTMENT]))
      : list === "past"
        ? lt(appointments.startsAt, now)
        : eq(appointments.status, "cancelled");
  const at = after ? new Date(after.t) : null;
  const keyset =
    after && at
      ? forward
        ? or(gt(appointments.startsAt, at), and(eq(appointments.startsAt, at), gt(appointments.id, after.id)))
        : or(lt(appointments.startsAt, at), and(eq(appointments.startsAt, at), lt(appointments.id, after.id)))
      : undefined;
  const rows = await db
    .select({ id: appointments.id, code: appointments.code, startsAt: appointments.startsAt })
    .from(appointments)
    .where(and(whose, which, keyset))
    .orderBy(...(forward ? [asc(appointments.startsAt), asc(appointments.id)] : [desc(appointments.startsAt), desc(appointments.id)]))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    appointments: await Promise.all(page.map((a) => getAppointmentByCode(a.code, now))),
    nextCursor: rows.length > limit && last ? encodeCursor({ l: list, t: last.startsAt.toISOString(), id: last.id }) : null,
  };
}

/**
 * With no status or cursor: the first page of upcoming and of past, the shape older app builds read.
 * With either: one list, one page.
 */
export async function myAppointments(customerId: string, now = new Date(), q: MyAppointmentsQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  if (after && q.status && after.l !== q.status) throw new AppError("bad_request", "That cursor is for another list", { field: "cursor" });
  const who = [customerId];
  if (q.family) who.push(...(await db.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, customerId))).map((c) => c.id));
  const list = after?.l ?? q.status;
  if (list) return appointmentPage(who, list, limit, after, now);
  const [upcoming, past] = await Promise.all([appointmentPage(who, "upcoming", limit, null, now), appointmentPage(who, "past", limit, null, now)]);
  return { upcoming: upcoming.appointments, past: past.appointments, nextCursor: { upcoming: upcoming.nextCursor, past: past.nextCursor } };
}
