/**
 * ST-I20 against a real database: off the clock, a barber's non-urgent texts and app alerts are held
 * for their next shift (email isn't), clocking in or ending a break sends them then, and the urgent
 * ones always go at once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let alerts: typeof import("@/server/staff-alerts");
let pay: typeof import("@/domain/payroll");

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  alerts = await import("@/server/staff-alerts");
  pay = await import("@/domain/payroll");
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };

describe("quiet hours for staff alerts (ST-I20)", () => {
  it("holds texts and app alerts off the clock, sends them at clock-in or a break's end, and never holds the urgent ones", async () => {
    const mk = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, "makenna@rayz.test") }))!;
    const cv = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, "coralville") }))!;
    const day = m.time.addDays(pay.payPeriodByIndex(pay.payPeriodFor(m.time.todayLocal()).index + 3).start, 1);
    const next = m.time.addDays(day, 1);
    await m.db.db.delete(S().staffSchedules).where(eq(S().staffSchedules.staffId, mk.id));
    await m.db.db.insert(S().staffSchedules).values({ staffId: mk.id, shopId: cv.id, weekday: m.time.weekdayOf(next), startMin: 10 * 60, endMin: 18 * 60 });
    await m.db.db
      .update(S().staff)
      .set({ phone: "+13195550188", notificationPrefs: { events: { schedule: ["sms", "email", "push"], confirm: ["push"], clock_out: ["push"] } } })
      .where(eq(S().staff.id, mk.id));
    const [phone] = await m.db.db.insert(S().staffDevices).values({ staffId: mk.id, platform: "ios", provider: "expo", token: "ExponentPushToken[quiet-hours]" }).returning();
    const jobs = async (kind: string) =>
      (await m.db.db.select().from(S().notificationJobs).where(m.drizzle.and(eq(S().notificationJobs.kind, kind), m.drizzle.inArray(S().notificationJobs.to, [phone.id, "+13195550188", mk.email!])))).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.channel.localeCompare(b.channel),
      );

    const evening = at(day, 20 * 60);
    expect(await alerts.queueStaffNotice("schedule", mk.id, { body: "Your hours changed.", shopId: cv.id, now: evening })).toBe(3);
    const held = await jobs("staff_schedule");
    expect(held.map((j) => [j.channel, j.runAt.toISOString(), j.heldForStaffId])).toEqual([
      ["email", evening.toISOString(), null],
      ["push", at(next, 10 * 60).toISOString(), mk.id],
      ["sms", at(next, 10 * 60).toISOString(), mk.id],
    ]);

    await alerts.queueStaffNotice("clock_out", mk.id, { body: "Still clocked in?", shopId: cv.id, now: evening });
    expect((await jobs("staff_clock_out")).map((j) => [j.runAt.toISOString(), j.heldForStaffId])).toEqual([[evening.toISOString(), null]]);

    const appt = (await m.db.db.query.appointments.findFirst({ where: eq(S().appointments.staffId, mk.id) }))!;
    await m.db.db.update(S().appointments).set({ startsAt: at(next, 9 * 60), endsAt: at(next, 9 * 60 + 30) }).where(eq(S().appointments.id, appt.id));
    await alerts.queueStaffAlert("confirm", appt.id, { now: evening });
    const confirm = (await jobs("staff_confirm")).filter((j) => j.appointmentId === appt.id);
    expect(confirm.map((j) => j.runAt.toISOString())).toEqual([at(next, 7 * 60).toISOString()]);

    const early = at(next, 9 * 60 + 30);
    const inn = await tc.punch({ staffId: mk.id, shopId: cv.id, type: "in", source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: { staffId: mk.id, label: "Makenna" }, now: early });
    expect(inn.kind).toBe("done");
    expect((await jobs("staff_schedule")).map((j) => [j.channel, j.runAt.toISOString(), j.heldForStaffId])).toEqual([
      ["email", evening.toISOString(), null],
      ["push", early.toISOString(), null],
      ["sms", early.toISOString(), null],
    ]);

    await m.db.db.delete(S().notificationJobs).where(eq(S().notificationJobs.kind, "staff_schedule"));
    const work = at(next, 11 * 60);
    await alerts.queueStaffNotice("schedule", mk.id, { body: "Your hours changed.", shopId: cv.id, now: work });
    expect((await jobs("staff_schedule")).every((j) => j.runAt.getTime() === work.getTime() && !j.heldForStaffId)).toBe(true);

    await m.db.db.delete(S().notificationJobs).where(eq(S().notificationJobs.kind, "staff_schedule"));
    await tc.punch({ staffId: mk.id, shopId: cv.id, type: "break_start", source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, plannedMin: 30, actor: { staffId: mk.id, label: "Makenna" }, now: at(next, 12 * 60) });
    await alerts.queueStaffNotice("schedule", mk.id, { body: "Your hours changed.", shopId: cv.id, now: at(next, 12 * 60 + 5) });
    expect((await jobs("staff_schedule")).filter((j) => j.channel !== "email").map((j) => j.runAt.toISOString())).toEqual([at(next, 12 * 60 + 30).toISOString(), at(next, 12 * 60 + 30).toISOString()]);
    await tc.punch({ staffId: mk.id, shopId: cv.id, type: "break_end", source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: { staffId: mk.id, label: "Makenna" }, now: at(next, 12 * 60 + 20) });
    expect((await jobs("staff_schedule")).filter((j) => j.channel !== "email").map((j) => [j.runAt.toISOString(), j.heldForStaffId])).toEqual([
      [at(next, 12 * 60 + 20).toISOString(), null],
      [at(next, 12 * 60 + 20).toISOString(), null],
    ]);
    await tc.punch({ staffId: mk.id, shopId: cv.id, type: "out", source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: { staffId: mk.id, label: "Makenna" }, now: at(next, 18 * 60) });
  });
});
