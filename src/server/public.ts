import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, serviceLocales, shopClosures, shopHours, shops, staff, staffSchedules } from "@/db/schema";
import { feeDisclosure } from "@/domain/checkout";
import { addDays, minutesToHHMM, todayLocal, toZoned } from "@/lib/time";
import { redemptionLocked } from "@/server/mobile/identity";
import { badgeFor, localeFromHeader, message } from "@/server/mobile/rules";
import { getAppointmentByCode, getAvailability } from "./booking";
import { getShop, shopBarbers, shopCatalog } from "./catalog";
import { notFound } from "./errors";

export async function publicShops(locale: "en" | "es" = "en") {
  const [rows, hours, counts, closures] = await Promise.all([
    db.select().from(shops).where(eq(shops.active, true)).orderBy(asc(shops.name)),
    db.select().from(shopHours).orderBy(asc(shopHours.weekday)),
    db
      .select({ shopId: staffSchedules.shopId, n: sql<number>`count(distinct ${staffSchedules.staffId})::int` })
      .from(staffSchedules)
      .groupBy(staffSchedules.shopId),
    db.select({ shopId: shopClosures.shopId, date: shopClosures.date, reason: shopClosures.reason }).from(shopClosures),
  ]);
  return Promise.all(
    rows.map(async (s) => {
      const h = hours.filter((x) => x.shopId === s.id);
      const c = closures.filter((x) => x.shopId === s.id).map((x) => ({ date: x.date, reason: x.reason }));
      const nextSlot = await nextOpenSlot(s.id, s.bookingMode, s.bookingEnabled);
      return serializeShop(s, h, counts.find((n) => n.shopId === s.id)?.n ?? 0, { closures: c, locale, openNow: shopIsOpen(h, c), nextSlot });
    }),
  );
}

export function serializeShop(
  s: typeof shops.$inferSelect,
  hours: (typeof shopHours.$inferSelect)[],
  barberCount: number,
  extras?: { closures?: { date: string; reason: string | null }[]; locale?: "en" | "es"; openNow?: boolean; nextSlot?: { startsAt: string; serviceId: string } | null },
) {
  const lat = s.lat == null ? null : Number(s.lat);
  const lng = s.lng == null ? null : Number(s.lng);
  const q = encodeURIComponent([s.address, s.city, s.state, s.zip].filter(Boolean).join(", "));
  const locale = extras?.locale ?? "en";
  const policy =
    s.cancellationPolicy ??
    (locale === "es"
      ? `Puedes cancelar o cambiar la cita hasta ${s.cancelCutoffMinutes} minutos antes. ${message("es", "sunday")} ${message("es", "fee")}`
      : `You can cancel or reschedule until ${s.cancelCutoffMinutes} minutes before. ${message("en", "sunday")} ${message("en", "fee")}`);
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    address: s.address,
    city: s.city,
    state: s.state,
    zip: s.zip,
    phone: s.phone,
    timezone: "America/Chicago" as const,
    bookingEnabled: s.bookingEnabled && s.bookingMode === "native",
    bookingMode: s.bookingMode,
    externalBookingUrl: s.externalBookingUrl,
    cancelCutoffMinutes: s.cancelCutoffMinutes,
    cancellationPolicy: policy,
    barberCount,
    hours: hours.map((h) => ({ weekday: h.weekday, open: minutesToHHMM(h.openMin), close: minutesToHHMM(h.closeMin) })),
    description: s.description,
    lat,
    lng,
    photoUrl: s.photoUrl,
    mapsUrl: `https://maps.google.com/?q=${q}`,
    googleReviewUrl: s.googleReviewUrl,
    openNow: extras?.openNow ?? false,
    closures: extras?.closures ?? [],
    tipPresets: s.tipPresets,
    cardFeeMayApply: s.cardFeeEnabled,
    cardFeeDisclosure: feeDisclosure({ enabled: s.cardFeeEnabled, rate: Number(s.cardFeeRate) }),
    nextSlot: extras?.nextSlot ?? null,
  };
}

const slotCache = new Map<string, { at: number; slot: { startsAt: string; serviceId: string } | null }>();

async function nextOpenSlot(shopId: string, bookingMode: string, bookingEnabled: boolean) {
  if (!bookingEnabled || bookingMode !== "native") return null;
  const hit = slotCache.get(shopId);
  if (hit && Date.now() - hit.at < 60_000) return hit.slot;
  let slot: { startsAt: string; serviceId: string } | null = null;
  try {
    const catalog = await shopCatalog(shopId, { onlineOnly: true });
    const service = catalog.find((s) => s.kind === "service");
    if (service) {
      const start = todayLocal();
      for (let i = 0; i < 3; i++) {
        const day = await getAvailability({ shopRef: shopId, date: addDays(start, i), serviceId: service.id, barberRef: "any" });
        if (day.slots[0]) {
          slot = { startsAt: day.slots[0].startsAt, serviceId: service.id };
          break;
        }
      }
    }
  } catch {
    slot = null;
  }
  slotCache.set(shopId, { at: Date.now(), slot });
  return slot;
}

function shopIsOpen(hours: (typeof shopHours.$inferSelect)[], closures: { date: string }[], now = new Date()) {
  const z = toZoned(now);
  const date = z.toISODate() ?? "";
  if (closures.some((c) => c.date === date)) return false;
  const weekday = z.weekday % 7;
  const row = hours.find((h) => h.weekday === weekday);
  if (!row) return false;
  const mins = z.hour * 60 + z.minute;
  return mins >= row.openMin && mins < row.closeMin;
}

export async function publicShop(ref: string, locale: "en" | "es" = "en") {
  const s = await getShop(ref);
  if (!s.active) throw notFound("Shop");
  const hours = await db.select().from(shopHours).where(eq(shopHours.shopId, s.id)).orderBy(asc(shopHours.weekday));
  const closures = await db.select({ date: shopClosures.date, reason: shopClosures.reason }).from(shopClosures).where(eq(shopClosures.shopId, s.id));
  const barbers = await shopBarbers(s.id, { onlineOnly: true });
  const nextSlot = await nextOpenSlot(s.id, s.bookingMode, s.bookingEnabled);
  return serializeShop(s, hours, barbers.length, { closures, locale, openNow: shopIsOpen(hours, closures), nextSlot });
}

export async function publicServices(ref: string, locale: "en" | "es" = "en") {
  const s = await getShop(ref);
  const catalog = await shopCatalog(s.id, { onlineOnly: true });
  const translated =
    locale === "en"
      ? new Map<string, { name: string; description: string | null }>()
      : new Map(
          (await db.select().from(serviceLocales).where(eq(serviceLocales.locale, locale))).map((row) => [row.serviceId, { name: row.name, description: row.description }]),
        );
  const all = catalog.map((x) => {
    const t = translated.get(x.id);
    return {
      id: x.id,
      slug: x.slug,
      name: t?.name ?? x.name,
      kind: x.kind,
      category: x.category,
      description: t?.description ?? x.description,
      priceCents: x.priceCents,
      durationMin: x.durationMin,
    };
  });
  return { services: all.filter((x) => x.kind === "service"), addons: all.filter((x) => x.kind === "addon") };
}

export { localeFromHeader };

export async function publicMe(customerId: string) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw notFound("Customer");
  const [visits] = (await db.execute(sql`
    select count(*)::int as n, max(starts_at) as last
    from appointments
    where customer_id = ${customerId} and status = 'completed'
  `)) as unknown as { n: number; last: string | null }[];
  const barber = c.preferredStaffId
    ? await db.query.staff.findFirst({ where: eq(staff.id, c.preferredStaffId), columns: { id: true, firstName: true } })
    : null;
  const last = visits?.last ? new Date(visits.last) : null;
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    email: c.email,
    emailVerifiedAt: c.emailVerifiedAt?.toISOString() ?? null,
    smsOptIn: c.smsOptIn,
    emailOptIn: c.emailOptIn,
    smsMarketingOptIn: c.smsMarketingOptIn,
    emailMarketingOptIn: c.emailMarketingOptIn,
    pushTransactional: c.pushTransactional,
    pushMarketing: c.pushMarketing,
    homeShopId: c.homeShopId,
    preferredBarberId: c.preferredStaffId,
    preferredBarber: barber ? { id: barber.id, firstName: barber.firstName } : null,
    birthday: c.birthday,
    birthYear: c.birthYear,
    preferences: c.preferences,
    notes: c.preferences,
    secureProfile: c.secureProfile,
    identityConfirmed: !redemptionLocked(c),
    redemptionLocked: redemptionLocked(c),
    badge: badgeFor(Number(visits?.n ?? 0), last),
  };
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
