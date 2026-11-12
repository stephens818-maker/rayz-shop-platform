/**
 * Service times against a real database: check-in, Start and Finish stamp the times with who did
 * them, checkout stands in for a missed Finish, managers correct times with an audited reason and
 * count or leave out a time, barbers only touch their own appointments, and other shops are refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let st: typeof import("@/server/service-times");
let actions: typeof import("@/app/admin/calendar/actions");

beforeAll(async () => {
  m = await loadModules();
  st = await import("@/server/service-times");
  actions = await import("@/app/admin/calendar/actions");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const byEmail = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
const wall = (d: Date) => DateTime.fromJSDate(d, { zone: "America/Chicago" }).toFormat("HH:mm");
let phone = 3195552000;

/** A Coralville booking at least 3 days out, with this barber (or anyone). */
async function book(barberId = "any", source: "online" | "walk_in" = "online") {
  const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
  for (let i = 3; i < 30; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: barberId });
    if (!a.slots.length) continue;
    const slot = a.slots[a.slots.length - 1];
    return m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: barberId === "any" ? slot.barberIds[0] : barberId, startsAt: slot.startsAt, customer: { firstName: "Timed", phone: String(phone++) }, source, actor });
  }
  throw new Error("no slots");
}

/** Move a future booking onto the day the check-in uses, so the "not today" rule still lets these tests run. */
async function onDay(id: string, when: Date) {
  const day = m.time.localDateOf(when);
  for (let i = 0; i < 24; i++) {
    const start = m.time.zonedWallTime(day, 8 * 60 + i * 30).toJSDate();
    try {
      await m.db.db.update(m.schema.appointments).set({ startsAt: start, endsAt: plus(start, 20) }).where(eq(m.schema.appointments.id, id));
      return;
    } catch (e) {
      const cause = (e as { cause?: { constraint_name?: string } }).cause;
      if (cause?.constraint_name !== "appointments_no_double_booking" && !String(e).includes("appointments_no_double_booking")) throw e;
    }
  }
  throw new Error("no free time on that day");
}

/** A finished, timed appointment from the seeded history at Coralville, so wall-clock corrections land in the past. */
async function pastTimed() {
  const s = m.schema;
  const cv = (await m.db.db.query.shops.findFirst({ where: eq(s.shops.slug, "coralville") }))!;
  const [row] = await m.db.db
    .select({ id: s.appointments.id, startedAt: s.appointmentTimes.startedAt })
    .from(s.appointments)
    .innerJoin(s.appointmentTimes, eq(s.appointmentTimes.appointmentId, s.appointments.id))
    .where(m.drizzle.and(eq(s.appointments.shopId, cv.id), m.drizzle.isNotNull(s.appointmentTimes.finishedAt), m.drizzle.lt(s.appointments.startsAt, m.time.startOfLocalDay(m.time.todayLocal())), m.drizzle.isNull(s.appointmentTimes.review)))
    .limit(1);
  return row as { id: string; startedAt: Date };
}

describe("capturing service times", () => {
  it("check-in is the arrival, In chair is the start, Finish is the end, each with who did it", async () => {
    const makenna = await byEmail("makenna@rayz.test");
    const desk = await byEmail("frontdesk@rayz.test");
    const a = await book(makenna.id);
    const t0 = new Date(Date.now() - 90 * 60_000);
    await onDay(a.id, t0);
    await m.booking.setAppointmentStatus(a.id, "checked_in", { staffId: desk.id, label: "desk" }, t0);
    await m.booking.setAppointmentStatus(a.id, "in_service", { staffId: makenna.id, label: "makenna" }, plus(t0, 12));
    await st.finishService(a.id, { staffId: makenna.id, label: "makenna" }, plus(t0, 52));
    const v = await st.timesOf(a.id, plus(t0, 60));
    expect([v.waitMin, v.actualMin]).toEqual([12, 40]);
    expect(v.arrived?.by).toBe(desk.displayLabel);
    expect(v.started?.by).toBe(makenna.displayLabel);
    expect(v.finished).toMatchObject({ via: "finish", by: makenna.displayLabel });
    await expect(st.finishService(a.id, actor, plus(t0, 55))).rejects.toThrow(/already finished/i);
  });

  it("Start waits for check-in, and a later check-in keeps the start", async () => {
    const a = await book();
    await onDay(a.id, new Date());
    await expect(st.startService(a.id, actor)).rejects.toThrow(/check the client in first/i);
    await expect(m.booking.setAppointmentStatus(a.id, "in_service", actor)).rejects.toThrow(/can't move from booked/i);
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor);
    await m.booking.setAppointmentStatus(a.id, "in_service", actor);
    const started = (await st.timesOf(a.id)).started;
    expect(started).not.toBeNull();
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor);
    expect((await st.timesOf(a.id)).started?.at).toEqual(started!.at);
    const row = await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, a.id) });
    expect(row?.status).toBe("in_service");
  });

  it("a walk-in's arrival is when it was added", async () => {
    const a = await book("any", "walk_in");
    expect((await st.timesOf(a.id)).arrived).not.toBeNull();
  });

  it("checkout stands in for a missed Finish and records the checkout", async () => {
    const a = await book();
    const t0 = new Date(Date.now() - 40 * 60_000);
    await onDay(a.id, t0);
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor, t0);
    await st.startService(a.id, actor, new Date(Date.now() - 35 * 60_000));
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor });
    const v = await st.timesOf(a.id);
    expect(v.finished?.via).toBe("checkout");
    expect(v.checkedOut).not.toBeNull();
    expect(v.actualMin).toBeGreaterThanOrEqual(35);
  });

  it("an early visit that already started and finished can be paid before its scheduled time", async () => {
    const a = await book();
    const past = new Date(Date.now() - 50 * 60_000);
    await onDay(a.id, past);
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor, past);
    await st.startService(a.id, actor, new Date(past.getTime() + 5 * 60_000));
    await st.finishService(a.id, actor, new Date(past.getTime() + 40 * 60_000));
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor });
    const paid = await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, sale.id) });
    expect(paid?.status).toBe("paid");
  });

  it("a visit on another day can't be checked in today", async () => {
    const a = await book();
    await expect(m.booking.setAppointmentStatus(a.id, "checked_in", actor)).rejects.toThrow(/not today/i);
    await expect(st.startService(a.id, actor)).rejects.toThrow(/not today/i);
  });

  it("a finished visit can be cleared after its ticket is voided, and not before", async () => {
    const a = await book();
    const now = new Date();
    await onDay(a.id, now);
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor, now);
    await m.booking.setAppointmentStatus(a.id, "in_service", actor, now);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    await m.db.db.update(m.schema.sales).set({ status: "paid" }).where(eq(m.schema.sales.id, sale.id));
    await m.booking.setAppointmentStatus(a.id, "completed", actor, now);
    await expect(m.booking.setAppointmentStatus(a.id, "cancelled", actor)).rejects.toThrow(/void the ticket/i);
    await m.db.db.update(m.schema.sales).set({ status: "voided" }).where(eq(m.schema.sales.id, sale.id));
    await m.booking.setAppointmentStatus(a.id, "cancelled", actor);
    const row = await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, a.id) });
    expect(row?.status).toBe("cancelled");
  });

  it("a visit that hasn't started and is still scheduled later can't be paid", async () => {
    const a = await book();
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    await expect(m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor })).rejects.toThrow(/hasn't started yet/i);
  });

  it("opening checkout without a start leaves the cut untimed", async () => {
    const a = await book();
    await m.db.db.update(m.schema.appointments).set({ startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 20 * 60_000) }).where(eq(m.schema.appointments.id, a.id));
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor });
    const v = await st.timesOf(a.id);
    expect([v.started, v.finished, v.actualMin]).toEqual([null, null, null]);
    expect(v.checkedOut).not.toBeNull();
  });
});

describe("who can start, finish and correct", () => {
  it("a barber starts and finishes their own appointment but not someone else's", async () => {
    const makenna = await byEmail("makenna@rayz.test");
    const cv = (await m.catalog.getShop("coralville"))!;
    const colleague = (await m.catalog.shopBarbers(cv.id)).find((b) => b.id !== makenna.id)!;
    const own = await book(makenna.id);
    const other = await book(colleague.id);
    const now = new Date();
    await onDay(own.id, now);
    await onDay(other.id, now);
    await signInAs(makenna.id);
    await m.booking.setAppointmentStatus(own.id, "checked_in", actor);
    await m.booking.setAppointmentStatus(other.id, "checked_in", actor);
    expect(await actions.setStatusAction(own.id, "in_service")).toEqual({ ok: true, data: null });
    expect(await actions.setStatusAction(other.id, "in_service")).toMatchObject({ ok: false, error: expect.stringMatching(/your own/i) });
    await new Promise((r) => setTimeout(r, 20));
    expect(await actions.finishServiceAction(own.id)).toEqual({ ok: true, data: null });
    expect((await st.timesOf(own.id)).finished?.by).toBe(makenna.displayLabel);
  });

  it("a manager corrects times with a reason that's logged; a barber can't; another shop's manager is refused", async () => {
    const michelle = await byEmail("michelle@rayz.test");
    const makenna = await byEmail("makenna@rayz.test");
    const moline = await byEmail("manager.moline@rayz.test");
    const p = await pastTimed();
    const fix = { startedAt: wall(p.startedAt), finishedAt: wall(plus(p.startedAt, 30)), reason: "Forgot to tap Finish" };

    await signInAs(makenna.id);
    expect((await actions.correctServiceTimesAction(p.id, fix)).ok).toBe(false);
    await signInAs(moline.id);
    expect((await actions.correctServiceTimesAction(p.id, fix)).ok).toBe(false);
    await signInAs(michelle.id);
    expect((await actions.correctServiceTimesAction(p.id, { ...fix, reason: " " })).ok).toBe(false);
    expect(await actions.correctServiceTimesAction(p.id, fix)).toEqual({ ok: true, data: null });

    const v = await st.timesOf(p.id);
    expect(v.actualMin).toBe(30);
    expect(v.finished).toMatchObject({ via: "correction", by: michelle.displayLabel });
    expect(v.corrected?.by).toBe(michelle.displayLabel);
    const log = await m.db.db.query.auditLog.findFirst({ where: m.drizzle.and(eq(m.schema.auditLog.action, "service_times.correct"), eq(m.schema.auditLog.entityId, p.id)) });
    expect(log?.details).toMatchObject({ reason: "Forgot to tap Finish", minutes: { to: 30 } });
  });

  it("a manager leaves a time out of averages and puts it back", async () => {
    const michelle = await byEmail("michelle@rayz.test");
    const p = await pastTimed();
    await signInAs(michelle.id);
    expect((await actions.reviewServiceTimeAction(p.id, "exclude", "Customer changed style mid-cut")).ok).toBe(true);
    expect(await st.timesOf(p.id)).toMatchObject({ review: "exclude", counts: false, reviewNote: "Customer changed style mid-cut" });
    expect((await actions.reviewServiceTimeAction(p.id, null, null)).ok).toBe(true);
    expect((await st.timesOf(p.id)).review).toBeNull();
  });
});
