/**
 * Nov 12: a void takes the visit off the book and stays on the void report, and a shop login
 * runs the day's work with the person's PIN (no sign-out).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let actions: typeof import("@/app/admin/calendar/actions");
let st: typeof import("@/server/service-times");
let clock: typeof import("@/server/time-clock");

beforeAll(async () => {
  m = await loadModules();
  actions = await import("@/app/admin/calendar/actions");
  st = await import("@/server/service-times");
  clock = await import("@/server/time-clock");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const byEmail = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
let phone = 3195554100;

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
      customer: { firstName: "Voided", phone: String(phone++) },
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

describe("voiding a ticket", () => {
  it("takes a finished visit off the book and keeps who, why, when and the amount", async () => {
    const michelle = await byEmail("michelle@rayz.test");
    const who = { staffId: michelle.id, label: michelle.displayLabel };
    const a = await book();
    const now = new Date();
    await onDay(a.id, now);
    await m.booking.setAppointmentStatus(a.id, "checked_in", who, new Date(now.getTime() - 40 * 60_000));
    await m.booking.setAppointmentStatus(a.id, "in_service", who, new Date(now.getTime() - 30 * 60_000));
    await st.finishService(a.id, who, new Date(now.getTime() - 5 * 60_000));
    const sale = await m.checkout.openSaleForAppointment(a.id, who);
    await m.checkout.voidSale(sale.id, "Wrong ticket", who);

    const row = await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, a.id) });
    expect(row?.status).toBe("cancelled");
    const saved = await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, sale.id) });
    expect(saved).toMatchObject({ status: "voided", voidReason: "Wrong ticket" });
    expect(saved?.voidedAt).toBeTruthy();
    const [logged] = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, sale.id));
    expect(logged).toMatchObject({ kind: "void", reason: "Wrong ticket", createdBy: michelle.id });
    expect(logged.amountCents).toBeGreaterThan(0);
    const audit = await m.db.db.query.auditLog.findFirst({
      where: and(eq(m.schema.auditLog.action, "appointment.cancelled"), eq(m.schema.auditLog.entityId, a.id)),
    });
    expect(audit?.details).toMatchObject({ reason: "ticket voided" });
    expect(audit?.actorLabel).toBe(michelle.displayLabel);
  });

  it("a paid void does the same, and a voided in-chair visit can be cleared", async () => {
    const michelle = await byEmail("michelle@rayz.test");
    const who = { staffId: michelle.id, label: michelle.displayLabel };
    const a = await book();
    const now = new Date();
    await onDay(a.id, now);
    await m.booking.setAppointmentStatus(a.id, "checked_in", who, new Date(now.getTime() - 40 * 60_000));
    await m.booking.setAppointmentStatus(a.id, "in_service", who, new Date(now.getTime() - 30 * 60_000));
    await st.finishService(a.id, who, new Date(now.getTime() - 5 * 60_000));
    const sale = await m.checkout.openSaleForAppointment(a.id, who);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty })),
      tipCents: 0,
      tender: { method: "cash", cashTenderedCents: null },
      actor: who,
    });
    await m.checkout.voidSale(sale.id, "Paid the wrong ticket", who);
    const row = await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, a.id) });
    expect(row?.status).toBe("cancelled");

    const stuck = await book();
    await onDay(stuck.id, now);
    await m.db.db.update(m.schema.appointments).set({ status: "in_service" }).where(eq(m.schema.appointments.id, stuck.id));
    await m.booking.setAppointmentStatus(stuck.id, "cancelled", who);
    expect((await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, stuck.id) }))?.status).toBe("cancelled");
  });
});

describe("shop login", () => {
  it("runs the day's work with a PIN and records who acted", async () => {
    const desk = await byEmail("coralville@rayz.test");
    const michelle = await byEmail("michelle@rayz.test");
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    await clock.setPin(michelle.id, "1357", { staffId: michelle.id, label: michelle.displayLabel });
    const pin = { staffId: michelle.id, pin: "1357" };
    await signInAs(desk.id, shop.id);

    const a = await book();
    const now = new Date();
    await onDay(a.id, now);
    expect((await actions.setStatusAction(a.id, "checked_in")).ok).toBe(false);
    expect(await actions.setStatusAction(a.id, "checked_in", pin)).toEqual({ ok: true, data: null });
    expect(await actions.setStatusAction(a.id, "in_service", pin)).toEqual({ ok: true, data: null });
    expect(await actions.finishServiceAction(a.id, pin)).toEqual({ ok: true, data: null });
    const arrived = await m.db.db.query.auditLog.findFirst({
      where: and(eq(m.schema.auditLog.action, "appointment.checked_in"), eq(m.schema.auditLog.entityId, a.id)),
    });
    expect(arrived?.actorLabel).toBe(michelle.displayLabel);

    const found = await actions.searchCustomersAction("Voided");
    expect(found.ok).toBe(true);

    const svcBook = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    const when = m.time.addDays(m.time.todayLocal(), 5);
    const avail = await m.booking.getAvailability({ shopRef: "coralville", date: when, serviceId: svcBook.id, barberRef: "any" });
    const slot = avail.slots.at(-1);
    if (!slot) throw new Error("no slot to book");
    const booked = await actions.createStaffAppointmentAction(
      {
        shopId: shop.id,
        staffId: slot.barberIds[0],
        date: when,
        startMin: m.time.localMinutesOf(new Date(slot.startsAt)),
        serviceId: svcBook.id,
        addonIds: [],
        customer: { firstName: "Desk", phone: String(phone++) },
      },
      pin,
    );
    expect(booked.ok).toBe(true);

    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    const walked = await (await import("@/app/admin/walk-ins/actions")).walkInAction({
      shopId: shop.id,
      serviceId: svc.id,
      name: "Walk In",
      phone: String(phone++),
      preferredStaffId: null,
      desk: pin,
    });
    expect(walked.ok).toBe(true);

    const sale = await actions.startCheckoutAction(a.id, pin);
    expect(sale.ok).toBe(true);

    const state = await actions.columnClockAction({ staffId: michelle.id, shopId: shop.id });
    expect(state.ok).toBe(true);
    if (!state.ok || !state.data.next.length) throw new Error("no punch available");
    const punch = await actions.columnPunchAction({ staffId: michelle.id, shopId: shop.id, type: state.data.next[0], desk: pin });
    expect(punch.ok).toBe(true);
    const [punched] = await m.db.db
      .select()
      .from(m.schema.timePunches)
      .where(eq(m.schema.timePunches.staffId, michelle.id))
      .orderBy(m.drizzle.desc(m.schema.timePunches.at))
      .limit(1);
    expect(punched.source).toBe("manager");
    expect(punched.createdBy).toBe(michelle.id);

    const opened = await (await import("@/app/admin/drawer/actions")).openDrawerAction({ shopId: shop.id, date: m.time.todayLocal(), openingCents: 15000, desk: pin });
    expect(opened.ok === true || (opened.ok === false && /open/i.test(opened.error))).toBe(true);
  });
});
