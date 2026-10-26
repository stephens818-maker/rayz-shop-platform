import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, services, shops, staff } from "@/db/schema";
import { rebookInterval } from "@/domain/checkout-prompts";
import { takesOnlineBookings } from "@/domain/location-lifecycle";
import { addDays, localDateOf, todayLocal, type LocalDate } from "@/lib/time";
import { appSwitches } from "./app-switches";
import { loadPromptSettings } from "./checkout-prompts";
import { notFound } from "./errors";
import { cadenceFor } from "./visit-cadence";

const UPCOMING = ["booked", "confirmed", "checked_in", "in_service"] as const;
const dayDiff = (a: LocalDate, b: LocalDate) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * I8: "book again" for me and each child on my account: the last completed visit (shop, barber,
 * services) and when the next is due, by the same rule the counter's rebook prompt uses (their own
 * cadence, else the main service's interval, else the brand's default). Someone already booked
 * still gets an entry, with nextVisit, so the app can show it instead of a nudge.
 */
export async function suggestedRebooks(customerId: string, now = new Date()) {
  const me = await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { id: true, firstName: true } });
  if (!me) throw notFound("Customer");
  const kids = (await appSwitches()).family
    ? await db
        .select({ id: customers.id, firstName: customers.firstName })
        .from(customers)
        .where(and(eq(customers.guardianId, customerId), isNull(customers.deletedAt)))
        .orderBy(asc(customers.createdAt))
    : [];
  const people = [{ ...me, isChild: false }, ...kids.map((k) => ({ ...k, isChild: true }))];
  const ids = people.map((p) => p.id);
  const [settings, cadence] = await Promise.all([loadPromptSettings(), cadenceFor(ids, now)]);
  const today = todayLocal(now);
  const out = [];
  for (const p of people) {
    const [last] = await db
      .select({ a: appointments, shop: shops, barberSlug: staff.publicSlug, barberName: staff.displayLabel, barberActive: staff.active, barberBookable: staff.isBookable })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(and(eq(appointments.customerId, p.id), eq(appointments.status, "completed")))
      .orderBy(desc(appointments.startsAt))
      .limit(1);
    if (!last) continue;
    const [items, [next]] = await Promise.all([
      db
        .select({ serviceId: appointmentItems.serviceId, kind: appointmentItems.kind, name: appointmentItems.name, rebookDays: services.rebookDays, serviceActive: services.active })
        .from(appointmentItems)
        .leftJoin(services, eq(services.id, appointmentItems.serviceId))
        .where(eq(appointmentItems.appointmentId, last.a.id))
        .orderBy(asc(appointmentItems.kind)),
      db
        .select({ code: appointments.code, startsAt: appointments.startsAt })
        .from(appointments)
        .where(and(eq(appointments.customerId, p.id), gte(appointments.startsAt, now), inArray(appointments.status, [...UPCOMING])))
        .orderBy(asc(appointments.startsAt))
        .limit(1),
    ]);
    const main = items.find((i) => i.kind === "service");
    const interval = rebookInterval({ cadenceDays: cadence.get(p.id)?.cadenceDays, serviceDays: main?.rebookDays, defaultDays: settings.rebook.defaultDays });
    const visitDate = localDateOf(last.a.startsAt);
    const suggestedDate = addDays(visitDate, interval.days);
    out.push({
      customer: { id: p.id, firstName: p.firstName, isChild: p.isChild },
      lastVisit: {
        date: visitDate,
        shop: { id: last.shop.id, slug: last.shop.slug, name: last.shop.name, bookable: takesOnlineBookings(last.shop, today) },
        barber: { id: last.a.staffId, slug: last.barberSlug, displayName: last.barberName, bookable: last.barberActive && last.barberBookable },
        services: items.map((i) => ({ serviceId: i.serviceId, kind: i.kind, name: i.name, bookable: !!i.serviceId && i.serviceActive !== false })),
      },
      intervalDays: interval.days,
      intervalSource: interval.source,
      suggestedDate,
      daysUntil: dayDiff(suggestedDate, today),
      nextVisit: next ? { code: next.code, startsAt: next.startsAt.toISOString() } : null,
    });
  }
  return { suggestions: out };
}
