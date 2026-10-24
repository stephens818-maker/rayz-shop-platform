/**
 * Who each automated campaign is for at one location, and the clients a blast's or lapsed sequence's segment matches.
 * A client belongs to the location of their last completed visit (their home shop before their
 * first). Only facts are gathered here; consent, unsubscribes, caps and quiet hours are applied
 * when sending.
 */
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, bookingDrafts, services, shops, staff, staffShops } from "@/db/schema";
import { CATCH_UP_DAYS, Segment, TriggerKey, daysToBirthday, milesBetween, rebookReminderDue, type MarketingValues } from "@/domain/marketing";
import { segKey } from "@/domain/report-views";
import { addDays, endOfLocalDay, localMinutesOf, startOfLocalDay, todayLocal } from "@/lib/time";
import { availableMinutesAt } from "../available-minutes";
import { CLIENT_FACTS, PRIMARY_BARBER, segmentConditions } from "../client-filters";
import { cadenceCtes } from "../visit-cadence";
import { consentColumns } from "./consent";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface Target {
  customerId: string;
  shopId: string;
  /** The barber the message is about, or the client's usual barber. */
  staffId: string | null;
  /** With the campaign and client, the idempotency key: the same occasion is never sent twice. */
  occasion: string;
  values?: MarketingValues;
  /** Booking page query: the barber's and service's slugs. */
  link?: { barber?: string | null; service?: string | null };
  /** Where the tracked link goes instead of the booking page, e.g. an openings blast's live times. */
  path?: string;
}

interface ClientRow {
  customer_id: string;
  n: number;
  first_at: string | Date | null;
  last_at: string | Date | null;
  staff_id: string | null;
  birthday: string | null;
  future: boolean;
  /** Usual days between visits (domain/visit-cadence.ts), null under two visit days. */
  cadence: number | null;
  visit_days: number;
  since_days: number | null;
}

const uuids = (xs: readonly string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;

/** Each client of these locations with their visit history; computed once per location per run. */
export async function clientsOf(shopIds: readonly string[], now: Date): Promise<Map<string, ClientRow[]>> {
  const out = new Map<string, ClientRow[]>(shopIds.map((s) => [s, []]));
  if (!shopIds.length) return out;
  const cols = await consentColumns();
  const rows = (await db.execute(sql`
    with v as (
      select a.customer_id, count(*)::int n, min(a.starts_at) first_at, max(a.starts_at) last_at,
        (array_agg(a.shop_id order by a.starts_at desc))[1] last_shop,
        (array_agg(a.staff_id order by a.starts_at desc))[1] last_staff
      from appointments a where a.status = 'completed' and a.customer_id is not null
      group by a.customer_id
    ), ${cadenceCtes("cd", sql``, now)}
    select c.id customer_id, coalesce(v.n, 0) n, v.first_at, v.last_at, coalesce(v.last_staff, c.preferred_staff_id) staff_id, c.birthday::text birthday,
      coalesce(v.last_shop, c.home_shop_id) shop_id,
      exists (select 1 from appointments f where f.customer_id = c.id and f.starts_at > ${now.toISOString()} and f.status in ('booked', 'confirmed', 'checked_in', 'in_service')) future,
      cd.cadence, coalesce(cd.visit_days, 0) visit_days, cd.since_days
    from customers c left join v on v.customer_id = c.id left join cd on cd.customer_id = c.id
    where coalesce(v.last_shop, c.home_shop_id) in ${uuids(shopIds)} ${cols.deleted ? sql`and c.deleted_at is null` : sql``}`)) as unknown as (ClientRow & { shop_id: string })[];
  for (const r of rows) out.get(r.shop_id)?.push(r);
  return out;
}

const ms = (d: string | Date | null) => (d ? new Date(d).getTime() : 0);

export interface TriggerInput {
  key: TriggerKey;
  shop: typeof shops.$inferSelect;
  settings: Record<string, number>;
  clients: ClientRow[];
  now: Date;
}

/** Fill slow days looks at tomorrow from noon, so the offer goes out the afternoon before. */
export const FILL_FROM_MINUTES = 12 * 60;

export async function triggerTargets(i: TriggerInput): Promise<Target[]> {
  const { shop, settings: s, clients, now } = i;
  const t = now.getTime();
  const today = todayLocal(now);
  const mk = (r: ClientRow, occasion: string, extra: Partial<Target> = {}): Target => ({ customerId: r.customer_id, shopId: shop.id, staffId: r.staff_id, occasion, ...extra });
  const lastDay = (r: ClientRow) => new Date(ms(r.last_at)).toISOString().slice(0, 10);
  switch (i.key) {
    case "birthday":
      return clients.flatMap((r) => {
        if (!r.birthday) return [];
        const b = daysToBirthday(r.birthday, today);
        return b.days <= s.daysBefore ? [mk(r, `birthday:${b.year}`)] : [];
      });
    case "lapsed":
    case "win_back":
      return clients.filter((r) => r.n > 0 && !r.future && t - ms(r.last_at) >= s.days * DAY && t - ms(r.last_at) < (s.days + CATCH_UP_DAYS) * DAY).map((r) => mk(r, `${i.key}:${lastDay(r)}`));
    case "first_visit":
      return clients.filter((r) => r.n === 1 && t - ms(r.last_at) >= s.delayHours * HOUR && t - ms(r.last_at) < s.delayHours * HOUR + 7 * DAY).map((r) => mk(r, "first_visit"));
    case "milestone":
      return clients.filter((r) => r.n === s.visits && t - ms(r.last_at) >= HOUR && t - ms(r.last_at) < 7 * DAY).map((r) => mk(r, `milestone:${s.visits}`));
    case "rebook":
      return clients
        .filter(
          (r) =>
            !r.future &&
            r.cadence !== null &&
            r.since_days !== null &&
            rebookReminderDue({ visits: Number(r.visit_days), usualDays: Math.round(Number(r.cadence)), sinceDays: Number(r.since_days) }, s.leadDays),
        )
        .map((r) => mk(r, `rebook:${lastDay(r)}`));
    case "no_show":
      return noShows(shop.id, s.delayHours, now);
    case "abandoned_booking":
      return abandoned(shop.id, s.delayMinutes, now);
    case "announcement":
      return announcements(shop, s, now);
    case "fill_slow_day":
      return slowDays(shop, s, clients, now);
    case "barber_outreach":
      return [];
  }
}

async function noShows(shopId: string, delayHours: number, now: Date): Promise<Target[]> {
  const to = new Date(now.getTime() - delayHours * HOUR);
  const rows = await db
    .select({ id: appointments.id, customerId: appointments.customerId, staffId: appointments.staffId, startsAt: appointments.startsAt })
    .from(appointments)
    .where(and(eq(appointments.shopId, shopId), eq(appointments.status, "no_show"), lte(appointments.startsAt, to), gte(appointments.startsAt, new Date(to.getTime() - 3 * DAY))));
  const out: Target[] = [];
  for (const a of rows) {
    if (!a.customerId) continue;
    const [later] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.customerId, a.customerId), gte(appointments.createdAt, a.startsAt), inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service", "completed"])))
      .limit(1);
    if (!later) out.push({ customerId: a.customerId, shopId, staffId: a.staffId, occasion: `no_show:${a.id}` });
  }
  return out;
}

async function abandoned(shopId: string, delayMinutes: number, now: Date): Promise<Target[]> {
  const to = new Date(now.getTime() - delayMinutes * 60_000);
  const drafts = await db
    .select({ id: bookingDrafts.id, customerId: bookingDrafts.customerId, staffId: bookingDrafts.staffId, serviceId: bookingDrafts.serviceId, createdAt: bookingDrafts.createdAt, barber: staff.publicSlug, service: services.slug })
    .from(bookingDrafts)
    .leftJoin(staff, eq(staff.id, bookingDrafts.staffId))
    .leftJoin(services, eq(services.id, bookingDrafts.serviceId))
    .where(and(eq(bookingDrafts.shopId, shopId), isNull(bookingDrafts.appointmentId), lte(bookingDrafts.updatedAt, to), gte(bookingDrafts.updatedAt, new Date(now.getTime() - 2 * DAY))));
  const out: Target[] = [];
  for (const d of drafts) {
    if (!d.customerId) continue;
    const [booked] = await db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.customerId, d.customerId), gte(appointments.createdAt, d.createdAt))).limit(1);
    if (!booked) out.push({ customerId: d.customerId, shopId, staffId: d.staffId, occasion: `abandoned:${d.id}`, link: { barber: d.barber, service: d.service } });
  }
  return out;
}

/** New barbers at this location and the location itself when it just opened, to clients whose location is within the radius. */
async function announcements(shop: typeof shops.$inferSelect, s: Record<string, number>, now: Date): Promise<Target[]> {
  const since = new Date(now.getTime() - s.withinDays * DAY);
  const barbers = await db
    .select({ id: staff.id, firstName: staff.firstName, slug: staff.publicSlug })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shop.id), eq(staffShops.visibleOnline, true), eq(staff.active, true), eq(staff.isBookable, true), eq(staff.kind, "person"), gte(staff.createdAt, since)));
  const opened = shop.wentLiveAt && shop.wentLiveAt >= since;
  if (!barbers.length && !opened) return [];
  const all = await db.select({ id: shops.id, lat: shops.latitude, lng: shops.longitude, status: shops.status }).from(shops);
  const here = all.find((x) => x.id === shop.id);
  const near = all
    .filter((x) => x.status !== "archived")
    .filter((x) => x.id === shop.id || (here?.lat != null && here.lng != null && x.lat != null && x.lng != null && milesBetween({ lat: here.lat, lng: here.lng }, { lat: x.lat, lng: x.lng }) <= s.radiusMiles))
    .map((x) => x.id);
  const clients = await clientsOf(near, now);
  const out: Target[] = [];
  for (const [shopId, list] of clients) {
    for (const r of list) {
      for (const b of barbers) out.push({ customerId: r.customer_id, shopId: shop.id, staffId: b.id, occasion: `announce:staff:${b.id}`, values: { barber: b.firstName }, link: { barber: b.slug } });
      if (opened && shopId !== shop.id) out.push({ customerId: r.customer_id, shopId: shop.id, staffId: null, occasion: `announce:shop:${shop.id}`, values: { barber: "our barbers" } });
    }
  }
  return out;
}

/** Barbers under the line tomorrow, and their regulars with nothing booked: two or more visits with them here in the last year. */
async function slowDays(shop: typeof shops.$inferSelect, s: Record<string, number>, clients: ClientRow[], now: Date): Promise<Target[]> {
  if (localMinutesOf(now) < FILL_FROM_MINUTES) return [];
  const tomorrow = addDays(todayLocal(now), 1);
  const avail = await availableMinutesAt({ shopIds: [shop.id], from: tomorrow, to: tomorrow }, [{ byShop: true, byStaff: true }]);
  const booked = await db
    .select({ staffId: appointments.staffId, minutes: sql<number>`coalesce(sum(extract(epoch from ${appointments.endsAt} - ${appointments.startsAt}) / 60), 0)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.shopId, shop.id),
        inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service", "completed"]),
        gte(appointments.startsAt, startOfLocalDay(tomorrow)),
        lte(appointments.startsAt, endOfLocalDay(tomorrow)),
      ),
    )
    .groupBy(appointments.staffId);
  const bookedBy = new Map(booked.map((b) => [b.staffId, b.minutes]));
  const free = new Set(clients.filter((c) => !c.future).map((c) => c.customer_id));
  const out: Target[] = [];
  const team = await db
    .select({ id: staff.id, firstName: staff.firstName, slug: staff.publicSlug })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shop.id), eq(staff.active, true), eq(staff.isBookable, true)));
  for (const b of team) {
    const minutes = avail[segKey(shop.id, b.id)] ?? 0;
    if (minutes <= 0 || ((bookedBy.get(b.id) ?? 0) / minutes) * 100 >= s.utilizationPct) continue;
    const regulars = (await db.execute(sql`
      select a.customer_id, max(a.starts_at) last_at from appointments a
      where a.shop_id = ${shop.id} and a.staff_id = ${b.id} and a.status = 'completed' and a.customer_id is not null and a.starts_at > ${new Date(now.getTime() - 365 * DAY).toISOString()}
      group by a.customer_id having count(*) >= 2 order by max(a.starts_at) desc`)) as unknown as { customer_id: string }[];
    for (const r of regulars.filter((x) => free.has(x.customer_id)).slice(0, s.maxPerBarber)) {
      out.push({ customerId: r.customer_id, shopId: shop.id, staffId: b.id, occasion: `fill:${tomorrow}:${b.id}`, values: { barber: b.firstName }, link: { barber: b.slug } });
    }
  }
  return out;
}

// ───────────────────────────── Segments ─────────────────────────────

export interface SegmentMember {
  customerId: string;
  firstName: string;
  shopId: string;
  /** The client's barber as the segment's barber filter reads it: primary, most recent, or (any) most recent. */
  staffId: string | null;
  lastAt: Date | null;
}

export { PRIMARY_BARBER };
/**
 * Booked since the last visit: an appointment after it that wasn't cancelled and wasn't a no-show.
 * Once a lapsed client books they're out; if they cancel or don't show, they're lapsed again.
 */
export const BOOKED_SINCE = sql.raw(
  "exists (select 1 from appointments b where b.customer_id = c.id and b.status not in ('cancelled', 'no_show') and b.starts_at > coalesce(v.last_at, 'epoch'::timestamptz))",
);

/** Clients a segment matches, within these locations. Consent is checked when sending (and counted in the preview). */
export async function segmentMembers(seg: Segment, shopIds: readonly string[], now: Date): Promise<SegmentMember[]> {
  const scope = seg.shopIds.length ? seg.shopIds.filter((s) => shopIds.includes(s)) : [...shopIds];
  if (!scope.length) return [];
  const cols = await consentColumns();
  const where: SQL[] = [sql`coalesce(v.last_shop, c.home_shop_id) in ${uuids(scope)}`, ...(await segmentConditions(seg, now))];
  if (cols.deleted) where.push(sql`c.deleted_at is null`);
  const rows = (await db.execute(sql`
    with ${CLIENT_FACTS}
    select c.id, c.first_name, coalesce(v.last_shop, c.home_shop_id) shop_id, v.last_at,
      ${seg.barberMatch === "primary" ? PRIMARY_BARBER : seg.barberMatch === "recent" ? sql`v.last_staff` : sql`coalesce(v.last_staff, c.preferred_staff_id)`} staff_id
    from customers c left join v on v.customer_id = c.id left join sp on sp.customer_id = c.id
    where ${sql.join(where, sql` and `)}
    order by c.first_name, c.id`)) as unknown as { id: string; first_name: string; shop_id: string; staff_id: string | null; last_at: string | Date | null }[];
  return rows.map((r) => ({ customerId: r.id, firstName: r.first_name, shopId: r.shop_id, staffId: r.staff_id, lastAt: r.last_at ? new Date(r.last_at) : null }));
}

export interface BarberCard {
  id: string;
  firstName: string;
  active: boolean;
  /** Bookable online at each of these locations, so the link can book with them. */
  bookableAt: Set<string>;
  slug: string | null;
}

/** What a message needs to be signed by a barber and book with them. */
export async function barberCards(ids: readonly string[]): Promise<Map<string, BarberCard>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await db
    .select({ id: staff.id, firstName: staff.firstName, active: staff.active, bookable: staff.isBookable, slug: staff.publicSlug, shopId: staffShops.shopId, online: staffShops.visibleOnline })
    .from(staff)
    .leftJoin(staffShops, eq(staffShops.staffId, staff.id))
    .where(inArray(staff.id, list));
  const out = new Map<string, BarberCard>();
  for (const r of rows) {
    const c = out.get(r.id) ?? { id: r.id, firstName: r.firstName, active: r.active, bookableAt: new Set<string>(), slug: r.slug };
    if (r.active && r.bookable && r.online && r.shopId) c.bookableAt.add(r.shopId);
    out.set(r.id, c);
  }
  return out;
}

/** Signed with the client's barber and booking with them when they still take bookings there; otherwise from the shop. */
export function signedBy(card: BarberCard | undefined, shopId: string): Pick<Target, "values" | "link"> {
  if (!card?.active) return { values: { barber: "your barber" } };
  return { values: { barber: card.firstName }, link: card.bookableAt.has(shopId) && card.slug ? { barber: card.slug } : undefined };
}
