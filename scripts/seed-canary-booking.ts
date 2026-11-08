/**
 * Opt-in only. Adds one future booked visit with no tip, so a person can try void-with-tip,
 * drag-to-resize, and Start/Finish on the sandbox after Charles says to.
 *
 * Does not run from the demo seed, a deploy, or this file being imported. Refuses unless
 * SEED_CANARY_BOOKING=1. Does not change any other row. If the visit is already there, it
 * leaves it alone.
 *
 *   SEED_CANARY_BOOKING=1 npx tsx scripts/seed-canary-booking.ts
 *
 * The client must already exist (last name Zzcanary). This script does not create people.
 */
async function main() {
  if (process.env.SEED_CANARY_BOOKING !== "1") {
    console.error("Refusing to add a canary booking. Set SEED_CANARY_BOOKING=1 after Charles approves. Demo and sandbox data are left as they are.");
    process.exit(1);
  }
  await import("dotenv/config");
  const { and, desc, eq } = await import("drizzle-orm");
  const { db, closeDb } = await import("@/db");
  const { appointmentItems, appointments, customers, services, shops, staff, staffShops } = await import("@/db/schema");
  const { addDays, todayLocal } = await import("@/lib/time");
  const { zonedWallTime } = await import("@/lib/time");

  const CODE = "FUTNO0TIP";
  const KEY = "canary-no-tip-future";
  try {
    const [existing] = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.code, CODE));
    if (existing) {
      console.log(`${CODE} is already booked. Nothing changed.`);
      return;
    }
    const [client] = await db
      .select({ id: customers.id, firstName: customers.firstName })
      .from(customers)
      .where(eq(customers.lastName, "Zzcanary"))
      .limit(1);
    if (!client) {
      console.error("No client with last name Zzcanary. Nothing was added.");
      process.exit(1);
    }
    const [last] = await db
      .select({ shopId: appointments.shopId, staffId: appointments.staffId })
      .from(appointments)
      .where(eq(appointments.customerId, client.id))
      .orderBy(desc(appointments.startsAt))
      .limit(1);
    let shopId = last?.shopId;
    let staffId = last?.staffId;
    if (!shopId || !staffId) {
      const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.status, "live")).limit(1);
      const [person] = shop
        ? await db
            .select({ id: staff.id })
            .from(staffShops)
            .innerJoin(staff, eq(staff.id, staffShops.staffId))
            .where(and(eq(staffShops.shopId, shop.id), eq(staff.active, true), eq(staff.kind, "person")))
            .limit(1)
        : [];
      shopId = shop?.id;
      staffId = person?.id;
    }
    if (!shopId || !staffId) {
      console.error("No shop and barber to book. Nothing was added.");
      process.exit(1);
    }
    const [service] = await db
      .select({ id: services.id, name: services.name, priceCents: services.defaultPriceCents, durationMin: services.defaultDurationMin })
      .from(services)
      .where(eq(services.active, true))
      .limit(1);
    const day = addDays(todayLocal(), 21);
    const start = zonedWallTime(day, 15 * 60 + 15).toJSDate();
    const end = new Date(start.getTime() + (service?.durationMin ?? 30) * 60_000);
    const [row] = await db
      .insert(appointments)
      .values({
        code: CODE,
        shopId,
        staffId,
        customerId: client.id,
        startsAt: start,
        endsAt: end,
        status: "booked",
        source: "staff",
        estimateCents: service?.priceCents ?? 0,
        bookingTipCents: 0,
        notes: "Canary booking with no tip. Added only after approval.",
        idempotencyKey: KEY,
      })
      .onConflictDoNothing()
      .returning({ id: appointments.id });
    if (row && service) {
      await db.insert(appointmentItems).values({ appointmentId: row.id, serviceId: service.id, kind: "service", name: service.name, priceCents: service.priceCents, durationMin: service.durationMin });
    }
    console.log(row ? `Booked ${CODE} for ${client.firstName} on ${day} at 3:15pm, tip $0.` : `${CODE} was already there. Nothing changed.`);
  } finally {
    await closeDb();
  }
}

void main();
