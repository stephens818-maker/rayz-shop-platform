import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, calendarFeeds, customers, shops, staff } from "@/db/schema";
import { icsCalendar } from "@/domain/ics";
import { appBaseUrl } from "@/lib/deployment";
import { hashToken } from "@/domain/rebook-token";
import { randomToken } from "./auth/tokens";
import { audit, type Actor } from "./audit";
import { appointmentEvent } from "./calendar-invites";

/** A subscribed calendar shows this far ahead, and keeps cancelled ones this far back so they disappear. */
export const FEED_DAYS_AHEAD = 180;
const FEED_DAYS_BACK = 7;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const feedUrl = (token: string) => `${appBaseUrl()}/cal/${token}.ics`;

export async function feedStatus(customerId: string): Promise<{ on: boolean; createdAt: Date | null; lastFetchedAt: Date | null }> {
  const f = await db.query.calendarFeeds.findFirst({ where: and(eq(calendarFeeds.customerId, customerId), isNull(calendarFeeds.revokedAt)) });
  return { on: !!f, createdAt: f?.createdAt ?? null, lastFetchedAt: f?.lastFetchedAt ?? null };
}

/**
 * A new private feed URL: the old one stops working. The URL is shown once (only its hash is
 * kept), so a lost one is replaced, not looked up.
 */
export async function createFeed(customerId: string, actor: Actor, now = new Date()): Promise<{ url: string }> {
  const token = randomToken(32);
  await db.transaction(async (tx) => {
    await tx.update(calendarFeeds).set({ revokedAt: now }).where(and(eq(calendarFeeds.customerId, customerId), isNull(calendarFeeds.revokedAt)));
    const [f] = await tx.insert(calendarFeeds).values({ customerId, tokenHash: hashToken(token), createdAt: now }).returning({ id: calendarFeeds.id });
    await audit(actor, "calendar_feed.created", "calendar_feed", f.id, { customerId }, null, tx);
  });
  return { url: feedUrl(token) };
}

export async function revokeFeed(customerId: string, actor: Actor, now = new Date()): Promise<boolean> {
  const off = await db
    .update(calendarFeeds)
    .set({ revokedAt: now })
    .where(and(eq(calendarFeeds.customerId, customerId), isNull(calendarFeeds.revokedAt)))
    .returning({ id: calendarFeeds.id });
  for (const f of off) await audit(actor, "calendar_feed.revoked", "calendar_feed", f.id, { customerId });
  return off.length > 0;
}

/**
 * /cal/<token>.ics: the customer's and their children's appointments from a week ago to six months
 * ahead. Cancelled ones stay in as CANCELLED so calendars drop them. Null for an unknown or revoked token.
 */
export async function feedIcs(token: string, now = new Date()): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  const f = await db.query.calendarFeeds.findFirst({ where: and(eq(calendarFeeds.tokenHash, hashToken(token)), isNull(calendarFeeds.revokedAt)) });
  if (!f) return null;
  await db.update(calendarFeeds).set({ lastFetchedAt: now }).where(eq(calendarFeeds.id, f.id));
  const people = await db
    .select({ id: customers.id, firstName: customers.firstName })
    .from(customers)
    .where(or(eq(customers.id, f.customerId), eq(customers.guardianId, f.customerId)));
  const names = new Map(people.map((p) => [p.id, p.firstName]));
  const rows = await db
    .select({ a: appointments, shop: shops, barber: staff.displayLabel })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .where(
      and(
        inArray(appointments.customerId, [...names.keys()]),
        gte(appointments.startsAt, new Date(now.getTime() - FEED_DAYS_BACK * 86_400_000)),
        lte(appointments.startsAt, new Date(now.getTime() + FEED_DAYS_AHEAD * 86_400_000)),
        inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service", "completed", "cancelled"]),
      ),
    )
    .orderBy(appointments.startsAt)
    .limit(200);
  const items = rows.length
    ? await db.select({ appointmentId: appointmentItems.appointmentId, name: appointmentItems.name, kind: appointmentItems.kind }).from(appointmentItems).where(inArray(appointmentItems.appointmentId, rows.map((r) => r.a.id)))
    : [];
  const events = rows.map((r) => {
    const services = items
      .filter((i) => i.appointmentId === r.a.id)
      .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "service" ? -1 : 1))
      .map((i) => i.name);
    const e = appointmentEvent({ code: r.a.code, startsAt: r.a.startsAt, endsAt: r.a.endsAt, status: r.a.status, barber: r.barber, services, shop: r.shop, now });
    const who = r.a.customerId !== f.customerId ? names.get(r.a.customerId!) : null;
    return who ? { ...e, summary: `${e.summary} (${who})` } : e;
  });
  return icsCalendar(events, { name: "Ray'z appointments" });
}
