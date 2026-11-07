/**
 * GET /api/v1/me/home. The signed-in customer's next visit, a rebook nudge, loyalty, family and
 * the shop they usually use, with that shop's live wait. No card numbers and no surnames.
 */
import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, shops } from "@/db/schema";
import { getAppointmentByCode, liveWait } from "./booking";
import { notFound } from "./errors";
import { loyaltyBalance } from "./loyalty";
import { suggestedRebooks } from "./suggested-rebook";

const UPCOMING = ["booked", "confirmed", "checked_in", "in_service"] as const;

export async function customerHome(customerId: string, now = new Date()) {
  const me = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { id: true, firstName: true, deletedAt: true },
  });
  if (!me || me.deletedAt) throw notFound("Customer");
  const kids = await db
    .select({ id: customers.id, firstName: customers.firstName, birthYear: customers.birthYear, smsOptIn: customers.smsOptIn })
    .from(customers)
    .where(and(eq(customers.guardianId, customerId), isNull(customers.deletedAt)))
    .orderBy(asc(customers.createdAt));
  const ids = [me.id, ...kids.map((k) => k.id)];
  const [next] = await db
    .select({ code: appointments.code })
    .from(appointments)
    .where(and(inArray(appointments.customerId, ids), gte(appointments.startsAt, now), inArray(appointments.status, [...UPCOMING])))
    .orderBy(asc(appointments.startsAt))
    .limit(1);
  const [loyalty, suggested, nextAppointment] = await Promise.all([
    loyaltyBalance(customerId, now),
    suggestedRebooks(customerId, now),
    next ? getAppointmentByCode(next.code, now) : Promise.resolve(null),
  ]);
  const suggestions = suggested.suggestions;
  const mine = suggestions.find((s) => s.customer.id === customerId) ?? suggestions[0] ?? null;
  const favorite = mine
    ? await db.query.shops.findFirst({ where: eq(shops.id, mine.lastVisit.shop.id), columns: { slug: true, name: true } })
    : null;
  const wait = favorite ? await liveWait(favorite.slug, now) : null;
  const service = mine?.lastVisit.services.find((s) => s.kind === "service") ?? mine?.lastVisit.services[0];
  const [past] = mine
    ? await db
        .select({ code: appointments.code })
        .from(appointments)
        .where(and(eq(appointments.customerId, mine.customer.id), eq(appointments.status, "completed")))
        .orderBy(desc(appointments.startsAt))
        .limit(1)
    : [];
  return {
    nextAppointment,
    rebook: mine && past
      ? {
          code: past.code,
          barberName: mine.lastVisit.barber.displayName,
          serviceName: service?.name ?? "Haircut",
          weeks: Math.max(1, Math.round(mine.intervalDays / 7)),
          suggestedDate: mine.suggestedDate,
          shopSlug: mine.lastVisit.shop.slug,
        }
      : null,
    loyalty: {
      progressCents: loyalty.progressCents,
      thresholdCents: loyalty.thresholdCents,
      rewardCents: loyalty.rewardCents,
      availableCents: loyalty.availableCents,
      lifetimeEarnedCents: loyalty.lifetimeEarnedCents,
      badge: null,
    },
    family: kids.map((k) => ({ id: k.id, guardianId: customerId, firstName: k.firstName, birthYear: k.birthYear, smsOptIn: k.smsOptIn })),
    favoriteShop: favorite && wait ? { slug: favorite.slug, name: favorite.name, waitMinutes: wait.waitMinutes } : null,
  };
}
