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

  it("stepping back from In chair clears the start; Finish needs a start", async () => {
    const a = await book();
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor);
    await m.booking.setAppointmentStatus(a.id, "in_service", actor);
    await m.booking.setAppointmentStatus(a.id, "checked_in", actor);
    expect((await st.timesOf(a.id)).started).toBeNull();
    await expect(st.finishService(a.id, actor)).rejects.toThrow(/start the service first/i);
  });

  it("a walk-in's arrival is when it was added", async () => {
    const a = await book("any", "walk_in");
    expect((await st.timesOf(a.id)).arrived).not.toBeNull();
  });

  it("checkout stands in for a missed Finish and records the checkout", async () => {
    const a = await book();
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

  it("opening checkout without a start leaves the cut untimed", async () => {
    const a = await book();
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
    await signInAs(makenna.id);
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
