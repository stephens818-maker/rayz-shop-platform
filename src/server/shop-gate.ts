import { and, eq, gt, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { appointments, notificationJobs, sales, shops } from "@/db/schema";
import { Actor, audit } from "@/server/audit";
import { notFound } from "@/server/errors";
import { shopLaunchState } from "@/server/launch";
import { SHOP_GATED_NOTIFICATION_KINDS } from "@/server/notifications/queue";

/**
 * Closing a shop sets its gate in the future. Appointments, sales, clients, and payments stay.
 * Pending Rayz reminders for that shop are cancelled so Squire can be the only sender again.
 * Opening the gate does not delete Squire history already imported. It schedules Rayz
 * reminders for future bookings that do not already have one.
 */
export const SHOP_GATE_CLOSED_AT = new Date("9999-12-31T00:00:00.000Z");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function shopByRef(shopRef: string) {
  const where = UUID_RE.test(shopRef) ? or(eq(shops.id, shopRef), eq(shops.slug, shopRef)) : eq(shops.slug, shopRef);
  const shop = await db.query.shops.findFirst({ where, columns: { id: true, slug: true } });
  if (!shop) throw notFound("Shop");
  return shop;
}

async function keptCounts(shopId: string) {
  const appointmentRows = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.shopId, shopId));
  const saleRows = await db.select({ id: sales.id }).from(sales).where(eq(sales.shopId, shopId));
  return { appointments: appointmentRows.length, sales: saleRows.length };
}

/** Roll a live shop back to Squire. Nothing already stored is deleted. */
export async function closeShopGate(shopRef: string, actor: Actor, now = new Date()) {
  const shop = await shopByRef(shopRef);
  const before = await keptCounts(shop.id);
  await db.update(shops).set({ launchAt: SHOP_GATE_CLOSED_AT }).where(eq(shops.id, shop.id));
  await db
    .update(notificationJobs)
    .set({ status: "cancelled" })
    .where(and(eq(notificationJobs.shopId, shop.id), eq(notificationJobs.status, "pending"), inArray(notificationJobs.kind, [...SHOP_GATED_NOTIFICATION_KINDS])));
  const after = await keptCounts(shop.id);
  await audit(
    actor,
    "shop.launch_close",
    "shop",
    shop.id,
    {
      launchAt: SHOP_GATE_CLOSED_AT.toISOString(),
      appointments: after.appointments,
      sales: after.sales,
      appointmentsBefore: before.appointments,
      salesBefore: before.sales,
    },
    shop.id,
  );
  return shopLaunchState(shop.id, now);
}

/** Open one shop on Rayz. Future bookings that have no pending reminder get one. Existing rows stay. */
export async function openShopGate(shopRef: string, at: Date, actor: Actor, now = new Date()) {
  const shop = await shopByRef(shopRef);
  const before = await keptCounts(shop.id);
  await db.update(shops).set({ launchAt: at }).where(eq(shops.id, shop.id));
  if (now.getTime() >= at.getTime()) await backfillShopReminders(shop.id, now);
  const after = await keptCounts(shop.id);
  await audit(
    actor,
    "shop.launch_open",
    "shop",
    shop.id,
    { launchAt: at.toISOString(), appointments: after.appointments, sales: after.sales, appointmentsBefore: before.appointments },
    shop.id,
  );
  return shopLaunchState(shop.id, now);
}

async function backfillShopReminders(shopId: string, now: Date) {
  const { messageContext } = await import("@/server/booking");
  const { scheduleAppointmentNotifications } = await import("@/server/notifications/queue");
  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.shopId, shopId), eq(appointments.status, "booked"), gt(appointments.startsAt, now)));
  for (const row of rows) {
    const pending = await db
      .select({ id: notificationJobs.id })
      .from(notificationJobs)
      .where(
        and(eq(notificationJobs.appointmentId, row.id), eq(notificationJobs.status, "pending"), inArray(notificationJobs.kind, ["reminder_24h", "reminder_2h"])),
      )
      .limit(1);
    if (pending.length) continue;
    const ctx = await messageContext(row.id);
    if (!ctx.customerId) continue;
    await scheduleAppointmentNotifications("imported", ctx, db, now);
  }
}
