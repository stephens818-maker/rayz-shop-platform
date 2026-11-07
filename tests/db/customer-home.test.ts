/**
 * Customer home, live wait and rebook. smsOptIn stays off unless the customer opts in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { actor, loadModules, type Mods } from "./setup";

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("customer home, live wait and rebook", () => {
  it("reports a live wait with no names, and refuses an unknown shop", async () => {
    const live = await m.booking.liveWait("coralville");
    expect(live.waitMinutes).toBeGreaterThanOrEqual(0);
    expect(live.chairsFree).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(live)).not.toMatch(/phone|lastName/i);
    await expect(m.booking.liveWait("not-a-shop")).rejects.toThrow(/not found/i);
  });

  it("shows the next visit, and a new customer is not opted into texts", async () => {
    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    let slot: { startsAt: string } | undefined;
    for (let i = 3; i < 20 && !slot; i++) {
      const date = m.time.addDays(m.time.todayLocal(), i);
      const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
      slot = a.slots[0];
    }
    const made = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: "any",
      startsAt: slot!.startsAt,
      customer: { firstName: "Home", phone: "3195550188" },
      source: "online",
      actor,
    });
    const customerId = made.customer!.id;
    const row = await m.db.db.query.customers.findFirst({ where: m.drizzle.eq(m.schema.customers.id, customerId) });
    expect(row!.smsOptIn).toBe(false);
    const homeMod = await import("@/server/customer-home");
    const home = await homeMod.customerHome(customerId);
    expect(home.nextAppointment?.code).toBe(made.code);
    expect(home.rebook).toBeNull();
    expect(home.family).toEqual([]);

    const past = new Date(Date.now() - 21 * 86_400_000);
    await m.db.db.update(m.schema.appointments).set({ status: "completed", startsAt: past, endsAt: new Date(past.getTime() + 40 * 60_000) }).where(m.drizzle.eq(m.schema.appointments.id, made.id));
    const again = await m.booking.rebookAppointment(made.code, { customerId, actor });
    expect(again.source).toBe("rebook");
    expect(again.code).not.toBe(made.code);
    expect(again.barber.id).toBe(made.barber.id);
    const second = await m.booking.rebookAppointment(made.code, { customerId, actor });
    expect(second.code).toBe(again.code);
  });
});
