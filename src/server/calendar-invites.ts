import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, shops, staff } from "@/db/schema";
import { icsCalendar, locationDescription, type IcsEvent } from "@/domain/ics";
import { fullAddress, validLatLng } from "@/domain/location-profile";
import { calendarLinks } from "@/domain/notification-delivery";
import { appBaseUrl } from "@/lib/deployment";
import { formatPhone } from "@/lib/phone";
import { formatTime } from "@/lib/time";
import { groupView } from "./booking-groups";
import { notFound } from "./errors";

type ShopRow = typeof shops.$inferSelect;

/** Later fetches of the same invite replace earlier ones in the calendar. */
const sequence = (now: Date) => Math.max(0, Math.floor(now.getTime() / 1000) - 1_790_000_000);

/** Where it is, for an invite: the full address, the pin (not a ZIP's centre), and the phone and parking notes. */
export function shopPlace(s: ShopRow) {
  const pin = validLatLng({ lat: s.latitude, lng: s.longitude }) && s.geocodeSource !== "zip" ? { lat: s.latitude!, lng: s.longitude! } : null;
  return {
    location: `Ray'z ${s.name}, ${fullAddress(s)}`,
    geo: pin,
    phone: s.phone ? formatPhone(s.phone) : null,
    directions: s.directions,
    mapUrl: `${appBaseUrl()}/locations/${s.slug}/directions`,
  };
}

export function appointmentEvent(o: { code: string; startsAt: Date; endsAt: Date; status: string; barber: string; services: string[]; shop: ShopRow; now: Date }): IcsEvent {
  const place = shopPlace(o.shop);
  const manageUrl = `${appBaseUrl()}/a/${o.code}`;
  return {
    uid: `${o.code}@rayzbs.com`,
    start: o.startsAt,
    end: o.endsAt,
    summary: `Ray'z ${o.shop.name}: ${o.services[0] ?? "Haircut"} with ${o.barber}`,
    description: locationDescription({ phone: place.phone, directions: place.directions, manageUrl, mapUrl: place.mapUrl, extra: o.services.length > 1 ? [o.services.join(", ")] : [] }),
    location: place.location,
    geo: place.geo,
    url: manageUrl,
    status: o.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    sequence: sequence(o.now),
    now: o.now,
  };
}

async function appointmentRow(code: string, now: Date) {
  const [row] = await db
    .select({ a: appointments, shop: shops, barber: staff.displayLabel })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .where(eq(appointments.code, code.toUpperCase()));
  if (!row) throw notFound("Appointment");
  const items = await db.query.appointmentItems.findMany({ where: (t, { eq: e }) => e(t.appointmentId, row.a.id), columns: { name: true, kind: true } });
  const services = items.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "service" ? -1 : 1)).map((i) => i.name);
  return { shopName: row.shop.name, event: appointmentEvent({ code: row.a.code, startsAt: row.a.startsAt, endsAt: row.a.endsAt, status: row.a.status, barber: row.barber, services, shop: row.shop, now }) };
}

/** /a/<code>/calendar.ics: anyone with the code (the same as the manage page). */
export async function appointmentIcs(code: string, now = new Date()): Promise<string> {
  const r = await appointmentRow(code, now);
  return icsCalendar([r.event], { name: `Ray'z ${r.shopName}` });
}

/** /a/<code>/calendar/google and /outlook: the same event as an "add event" link. */
export async function appointmentCalendarLink(code: string, app: "google" | "outlook", now = new Date()): Promise<string> {
  const { event: e } = await appointmentRow(code, now);
  return calendarLinks({ title: e.summary, start: e.start, end: e.end, location: e.location ?? "", details: e.description ?? "" })[app];
}

/** /g/<code>/calendar.ics: a family booked together, as one event for the whole visit. */
export async function groupIcs(code: string, now = new Date()): Promise<string> {
  const g = await groupView(code, now);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, g.shop.id) });
  if (!shop) throw notFound("Shop");
  const place = shopPlace(shop);
  const manageUrl = `${appBaseUrl()}/g/${g.code}`;
  const who = g.members.filter((m) => !["cancelled", "no_show"].includes(m.status)).map((m) => `${m.firstName ?? "Guest"} ${formatTime(m.startsAt)} with ${m.barber.displayName}`);
  return icsCalendar(
    [
      {
        uid: `group-${g.code}@rayzbs.com`,
        start: new Date(g.startsAt),
        end: new Date(g.endsAt),
        summary: `Ray'z ${shop.name}: family haircuts`,
        description: locationDescription({ phone: place.phone, directions: place.directions, manageUrl, mapUrl: place.mapUrl, extra: who }),
        location: place.location,
        geo: place.geo,
        url: manageUrl,
        status: g.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
        sequence: sequence(now),
        now,
      },
    ],
    { name: `Ray'z ${shop.name}` },
  );
}
