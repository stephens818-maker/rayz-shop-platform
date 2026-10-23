import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, shops } from "@/db/schema";
import { getAppointmentByCode } from "@/server/booking";
import { loyaltyBalance } from "@/server/loyalty";
import { listFamily } from "./family";
import { liveWait } from "./live-wait";

const REBOOK_WEEKS = 3;

export async function customerHome(customerId: string, now = new Date()) {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { id: true, homeShopId: true, firstName: true },
  });
  const upcoming = await db
    .select({ code: appointments.code })
    .from(appointments)
    .where(and(eq(appointments.customerId, customerId), gte(appointments.startsAt, now), inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service"])))
    .orderBy(asc(appointments.startsAt))
    .limit(1);
  const past = await db
    .select({ code: appointments.code })
    .from(appointments)
    .where(and(eq(appointments.customerId, customerId), eq(appointments.status, "completed")))
    .orderBy(desc(appointments.startsAt))
    .limit(1);
  const next = upcoming[0] ? await getAppointmentByCode(upcoming[0].code, now) : null;
  const completed = past[0] ? await getAppointmentByCode(past[0].code, now) : null;
  const loyalty = await loyaltyBalance(customerId, now);
  const family = await listFamily(customerId);
  let shop = customer?.homeShopId ? await db.query.shops.findFirst({ where: eq(shops.id, customer.homeShopId), columns: { slug: true, name: true } }) : null;
  if (!shop && next) shop = { slug: next.shop.slug, name: next.shop.name };
  if (!shop && completed) shop = { slug: completed.shop.slug, name: completed.shop.name };
  if (!shop) {
    const [first] = await db.select({ slug: shops.slug, name: shops.name }).from(shops).where(eq(shops.active, true)).orderBy(asc(shops.slug)).limit(1);
    shop = first ?? null;
  }
  const wait = shop ? await liveWait(shop.slug, now) : { waitMinutes: 0 };
  const serviceName = completed?.items.find((item) => item.kind === "service")?.name ?? completed?.items[0]?.name ?? null;
  return {
    nextAppointment: next ? { appointment: next } : null,
    rebook: completed && serviceName ? { code: completed.code, barberName: completed.barber.displayName.trim().split(/\s+/)[0], serviceName, weeks: REBOOK_WEEKS } : null,
    loyalty: {
      progressCents: loyalty.progressCents,
      thresholdCents: loyalty.thresholdCents,
      rewardCents: loyalty.rewardCents,
      availableCents: loyalty.availableCents,
      lifetimeEarnedCents: loyalty.lifetimeEarnedCents,
      badge: null,
    },
    family: family.members,
    favoriteShop: shop ? { slug: shop.slug, name: shop.name, waitMinutes: wait.waitMinutes } : null,
  };
}
