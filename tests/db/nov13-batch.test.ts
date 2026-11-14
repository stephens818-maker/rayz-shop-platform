/**
 * Nov 13: a $0 void is on the void report, a voided visit is not listed as Cancelled,
 * and a correct front-desk PIN is timed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let reports: typeof import("@/server/reports");
let list: typeof import("@/server/appointment-list");
let clock: typeof import("@/server/time-clock");

beforeAll(async () => {
  m = await loadModules();
  reports = await import("@/server/reports");
  list = await import("@/server/appointment-list");
  clock = await import("@/server/time-clock");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const byEmail = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
let phone = 3195555100;

async function book() {
  const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
  for (let i = 3; i < 30; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
    if (!a.slots.length) continue;
    const slot = a.slots[a.slots.length - 1];
    return m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: slot.barberIds[0],
      startsAt: slot.startsAt,
      customer: { firstName: "Zero", phone: String(phone++) },
      source: "online",
      actor,
    });
  }
  throw new Error("no slots");
}

async function onDay(id: string, when: Date) {
  const day = m.time.localDateOf(when);
  for (let i = 0; i < 24; i++) {
    const start = m.time.zonedWallTime(day, 8 * 60 + i * 30).toJSDate();
    try {
      await m.db.db.update(m.schema.appointments).set({ startsAt: start, endsAt: new Date(start.getTime() + 20 * 60_000) }).where(eq(m.schema.appointments.id, id));
      return;
    } catch (e) {
      const cause = (e as { cause?: { constraint_name?: string } }).cause;
      if (cause?.constraint_name !== "appointments_no_double_booking" && !String(e).includes("appointments_no_double_booking")) throw e;
    }
  }
  throw new Error("no free time");
}

describe("a $0 void", () => {
  it("stays on the void report and leaves the appointment list", async () => {
    const michelle = await byEmail("michelle@rayz.test");
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const who = { staffId: michelle.id, label: michelle.displayLabel };
    const a = await book();
    const now = new Date();
    await onDay(a.id, now);
    await m.booking.setAppointmentStatus(a.id, "checked_in", who, now);
    const sale = await m.checkout.openSaleForAppointment(a.id, who);
    await m.db.db.delete(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, sale.id));
    await m.db.db.update(m.schema.sales).set({ totalCents: 0, serviceNetCents: 0, serviceGrossCents: 0, serviceTaxCents: 0 }).where(eq(m.schema.sales.id, sale.id));
    await m.checkout.voidSale(sale.id, "Empty ticket", who);
    await m.db.db.delete(m.schema.refunds).where(eq(m.schema.refunds.saleId, sale.id));
    const [row] = await m.db.db.select({ number: m.schema.sales.number, status: m.schema.sales.status }).from(m.schema.sales).where(eq(m.schema.sales.id, sale.id));
    const day = m.time.todayLocal(now);
    const scope = { shopIds: [shop.id], from: day, to: day };
    const log = await reports.refundLog(scope);
    const hit = log.find((r) => r.number === row.number && r.kind === "void");
    expect(hit).toMatchObject({ amountCents: 0, reason: "Empty ticket" });
    const totals = await reports.refundTotals(scope);
    expect(totals.filter((t) => t.kind === "void").reduce((n, t) => n + t.n, 0)).toBeGreaterThan(0);
    const privacy = { show: (_field: string, value: string | null) => value ?? "" };
    const missed = await list.loadAppointmentList(shop.id, day, 1, { staffId: null, status: "missed", privacy });
    const all = await list.loadAppointmentList(shop.id, day, 1, { staffId: null, status: "all", privacy });
    expect(missed.rows.some((r) => r.id === a.id)).toBe(false);
    expect(all.rows.some((r) => r.id === a.id)).toBe(false);

    const kept = await book();
    await onDay(kept.id, now);
    await m.booking.setAppointmentStatus(kept.id, "cancelled", who, now);
    const still = await list.loadAppointmentList(shop.id, day, 1, { staffId: null, status: "missed", privacy });
    expect(still.rows.some((r) => r.id === kept.id)).toBe(true);
  });
});

describe("front-desk PIN", () => {
  it("times a correct PIN", async () => {
    process.env.CLOCK_HMAC_SECRET ??= "test-clock-secret-0123456789abcdef";
    const michelle = await byEmail("michelle@rayz.test");
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    await clock.setPin(michelle.id, "1357", { staffId: michelle.id, label: michelle.displayLabel });
    const t0 = performance.now();
    const state = await clock.acceptKioskPin(michelle.id, "1357", { deviceId: null, shopId: shop.id, via: "kiosk_web", by: "Front desk" });
    const ms = performance.now() - t0;
    console.log(`PIN confirm ${ms.toFixed(0)} ms`);
    expect(state.next.length).toBeGreaterThan(0);
  });
});
