/**
 * The time clock driving the calendar and online booking on the day itself: a barber not clocked in
 * close to their first client alerts the managers (once), a break holds the overlapping online
 * time and an early clock-out the rest of the day (the shop can still book both), clients booked
 * in that time are flagged with the call-in link to move or rebook them, and online booking says
 * nothing about the clock. One coming day Makenna works at Coralville, walked through in time order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let today: typeof import("@/server/today");
let cal: typeof import("@/server/calendar");
let live: typeof import("@/domain/clock-live");
let fallout: typeof import("@/server/clock-live");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx: Record<string, string> = {};
let cv = "";
let mk: { id: string; displayLabel: string };
let serviceId = "";
let day = "";
let seq = 0;

const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };
const at = (d: string, min: number) => m.time.zonedWallTime(d, min).toJSDate();
const clockTo = (min: number) => {
  const now = at(day, min);
  vi.setSystemTime(now);
  return now;
};
async function punchAt(type: "in" | "out" | "break_start" | "break_end", now: Date) {
  const r = await tc.punch({ staffId: mk.id, shopId: cv, type, source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: { staffId: mk.id, label: mk.displayLabel }, now });
  if (r.kind !== "done") throw new Error(r.message);
  return r;
}
async function appt(first: string, startMin: number, len: number) {
  const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: first, lastName: "Clocktest", email: `${first.toLowerCase()}@clock.test`, emailOptIn: true, homeShopId: cv }).returning();
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({ code: `CLOCK${++seq}`, shopId: cv, staffId: mk.id, customerId: c.id, startsAt: at(day, startMin), endsAt: at(day, startMin + len), status: "booked", source: "staff" })
    .returning();
  return a.id;
}
const alerts = async (now: Date) => {
  await signInAs(ids.michelle);
  const { getStaffContext } = await import("@/server/auth/staff");
  return today.todayAlerts(today.viewerOf((await getStaffContext())!), now);
};
const slots = async (now: Date, staffOverride = false) => (await m.booking.getAvailability({ shopRef: "coralville", date: day, serviceId, barberRef: mk.id, now, staffOverride })).slots;
const overlaps = (s: { startsAt: string; endsAt: string }, fromMin: number, toMin: number) => new Date(s.startsAt) < at(day, toMin) && new Date(s.endsAt) > at(day, fromMin);
const startMins = (ss: { startsAt: string }[]) => ss.map((s) => m.time.localMinutesOf(new Date(s.startsAt)));
const column = async () => {
  const d = await cal.loadDayCalendar(cv, day, null, { shopIds: [cv], brandWide: true }, { show: (_f, raw) => raw ?? null, stars: () => null }, { staffId: null, seesPrivate: true });
  return d.columns.find((c) => c.id === mk.id)!;
};
const emailsOf = (kind: "clock_late_in" | "clock_affected") => m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.and(eq(m.schema.notificationJobs.kind, kind), m.drizzle.like(m.schema.notificationJobs.subject, `${mk.displayLabel} %`)));

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  today = await import("@/server/today");
  cal = await import("@/server/calendar");
  live = await import("@/domain/clock-live");
  fallout = await import("@/server/clock-live");
  for (const k of ["owner", "michelle"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  mk = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
  cv = shop.id;
  serviceId = (await m.catalog.shopCatalog(cv)).find((s) => s.kind === "service")!.id;
  const scheds = await m.db.db.select().from(m.schema.staffSchedules).where(m.drizzle.and(eq(m.schema.staffSchedules.staffId, mk.id), eq(m.schema.staffSchedules.shopId, cv)));
  const base = m.time.todayLocal();
  for (let i = 3; i < 12 && !day; i++) {
    const d = m.time.addDays(base, i);
    const rows = scheds.filter((s) => s.weekday === m.time.weekdayOf(d));
    if (rows.length === 1 && rows[0].startMin <= 9 * 60 && rows[0].endMin >= 17 * 60) day = d;
  }
  expect(day).not.toBe("");
  vi.useFakeTimers({ toFake: ["Date"] });
  clockTo(8 * 60);

  // A longer break hold than the default 30 minutes, so it reaches past the client booked in it.
  await m.db.db.update(m.schema.shops).set({ timeClock: { ...(shop.timeClock as object), breakHoldMinutes: 60 } }).where(eq(m.schema.shops.id, cv));
  const { and, gte, lt } = m.drizzle;
  await m.db.db
    .update(m.schema.appointments)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(eq(m.schema.appointments.staffId, mk.id), gte(m.schema.appointments.startsAt, at(day, 0)), lt(m.schema.appointments.startsAt, at(day, 24 * 60))));
  await m.db.db.delete(m.schema.timeBlocks).where(and(eq(m.schema.timeBlocks.staffId, mk.id), lt(m.schema.timeBlocks.startsAt, at(day, 24 * 60)), gte(m.schema.timeBlocks.endsAt, at(day, 0))));
  // She uses the clock: a shift the day before.
  await punchAt("in", at(m.time.addDays(day, -1), 9 * 60));
  await punchAt("out", at(m.time.addDays(day, -1), 17 * 60));
  fx.first = await appt("Early", 10 * 60, 30);
  fx.duringBreak = await appt("Breaktime", 14 * 60 + 15, 30);
  fx.afterOut = await appt("Late", 16 * 60 + 30, 30);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await m?.db.closeDb();
});

describe("not clocked in for the first client", () => {
  const mine = (a: Awaited<ReturnType<typeof alerts>>) => a.find((x) => x.type === "late_clock_in" && x.shopId === cv && x.key.includes(mk.id));

  it("stays quiet until the alert window, then tells Today and emails the managers once", async () => {
    expect(mine(await alerts(clockTo(9 * 60 + 45)))).toBeUndefined();
    expect(await tc.sendClockFallout(new Date())).toBeGreaterThanOrEqual(0);
    expect(await emailsOf("clock_late_in")).toHaveLength(0);

    const now = clockTo(9 * 60 + 52);
    const alert = mine(await alerts(now))!;
    expect(alert.items?.find((i) => i.label.startsWith(`${mk.displayLabel}:`))).toMatchObject({ label: `${mk.displayLabel}: Early at 10:00 AM`, sub: "in 8m", href: `/admin/calendar?shop=${cv}&appt=${fx.first}` });

    await tc.sendClockFallout(now);
    const sent = await emailsOf("clock_late_in");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((e) => e.to)).not.toContain("makenna@rayz.test");
    expect(sent[0].body).toContain(`/admin/calendar?shop=${cv}&appt=${fx.first}`);
    expect(await m.db.db.query.clockAlertLog.findFirst({ where: eq(m.schema.clockAlertLog.key, `late_in:${mk.id}:${cv}:${day}`) })).toBeTruthy();
    await tc.sendClockFallout(clockTo(9 * 60 + 54));
    expect(await emailsOf("clock_late_in")).toHaveLength(sent.length);
  });

  it("clears once they clock in, and the calendar shows them in, late", async () => {
    const now = clockTo(9 * 60 + 55);
    await punchAt("in", now);
    expect(mine(await alerts(now))).toBeUndefined();
    const col = await column();
    expect(col.clock).toMatchObject({ status: "in", firstInMin: 9 * 60 + 55 });
    expect(col.clock!.lateMin).toBeGreaterThan(0);
  });
});

describe("a break", () => {
  it("holds the overlapping online time, not the shop's, and flags the client booked in it", async () => {
    const before = await slots(clockTo(13 * 60 + 55));
    expect(before.some((s) => overlaps(s, 14 * 60 + 45, 15 * 60))).toBe(true);

    const now = clockTo(14 * 60);
    await punchAt("break_start", now);
    const online = await slots(now);
    expect(online.filter((s) => overlaps(s, 14 * 60, 15 * 60))).toEqual([]);
    expect(online.some((s) => m.time.localMinutesOf(new Date(s.startsAt)) >= 15 * 60)).toBe(true);
    const shopSide = await slots(now, true);
    expect(shopSide.some((s) => overlaps(s, 14 * 60 + 45, 15 * 60))).toBe(true);

    const col = await column();
    expect(col.clock).toMatchObject({ status: "break", holds: [{ startMin: 14 * 60, endMin: 15 * 60, why: "break" }] });
    expect(col.clock!.breaks).toEqual([{ startMin: 14 * 60, endMin: 14 * 60, open: true }]);
    expect(col.appts.find((a) => a.id === fx.duringBreak)!.clockHold).toBe("break");
    expect(col.appts.find((a) => a.id === fx.afterOut)!.clockHold).toBeNull();

    const href = live.callInHref(mk.id, cv, { why: "break", startMin: 14 * 60, endMin: 15 * 60 });
    expect(href).toBe(`/admin/call-ins?staff=${mk.id}&shop=${cv}&from=14%3A00&to=15%3A00`);
    const alert = (await alerts(now)).find((a) => a.key === `clock_affected:${cv}:${mk.id}:${day}:${now.getTime()}`)!;
    expect(alert).toMatchObject({ type: "clock_affected", severity: "high", href, linkLabel: "Reassign or rebook" });
    expect(alert.items?.map((i) => i.label)).toEqual(["2:15 PM Breaktime"]);

    const emails = await emailsOf("clock_affected");
    expect(emails.length).toBeGreaterThan(0);
    expect(emails[0].subject).toBe(`${mk.displayLabel} is on a break: 1 client booked`);
    expect(emails[0].body).toContain(href);
  });

  it("lets go when the break ends", async () => {
    const now = clockTo(14 * 60 + 20);
    await punchAt("break_end", now);
    expect((await slots(now)).some((s) => overlaps(s, 14 * 60 + 45, 15 * 60))).toBe(true);
    const col = await column();
    expect(col.clock).toMatchObject({ status: "in", holds: [] });
    expect(col.clock!.breaks).toEqual([{ startMin: 14 * 60, endMin: 14 * 60 + 20, open: false }]);
    expect((await alerts(now)).some((a) => a.type === "clock_affected" && a.key.includes(mk.id))).toBe(false);
  });
});

describe("an early clock-out", () => {
  it("closes the rest of the day online, flags the clients after it and links the call-in from the clock-out", async () => {
    const now = clockTo(15 * 60);
    await punchAt("out", now);
    expect(await slots(now)).toEqual([]);
    expect(startMins(await slots(now, true)).some((x) => x >= 15 * 60)).toBe(true);

    const col = await column();
    expect(col.clock).toMatchObject({ status: "out", lastOutMin: 15 * 60 });
    expect(col.clock!.earlyOutMin).toBeGreaterThan(0);
    expect(col.clock!.holds).toMatchObject([{ startMin: 15 * 60, why: "clocked_out" }]);
    expect(col.appts.find((a) => a.id === fx.afterOut)!.clockHold).toBe("clocked_out");

    const [f] = await fallout.clockFallout([cv], now);
    expect(f.affected.filter((a) => a.staffId === mk.id)).toMatchObject([{ why: "clocked_out", start: now, appts: [{ id: fx.afterOut }] }]);

    const href = `/admin/call-ins?staff=${mk.id}&shop=${cv}&from=15%3A00`;
    const alert = (await alerts(now)).find((a) => a.key === `clock_affected:${cv}:${mk.id}:${day}:${now.getTime()}`)!;
    expect(alert).toMatchObject({ title: `${mk.displayLabel} clocked out early: 1 client booked in that time`, href });
    const emails = await emailsOf("clock_affected");
    expect(emails.some((e) => e.subject === `${mk.displayLabel} clocked out early: 1 client booked` && e.body.includes(href))).toBe(true);
  });

  it("opens back up when they clock back in", async () => {
    const now = clockTo(15 * 60 + 30);
    await punchAt("in", now);
    expect(startMins(await slots(now)).some((x) => x >= 15 * 60 + 45)).toBe(true);
    expect((await column()).clock).toMatchObject({ status: "in", holds: [] });
  });

  it("never shows clients the clock: just the slots and a plain reason", async () => {
    const now = clockTo(15 * 60 + 40);
    await punchAt("out", now);
    const r = await m.booking.getAvailability({ shopRef: "coralville", date: day, serviceId, barberRef: mk.id, now });
    expect(r.slots).toEqual([]);
    expect(r.reason).toBe("No openings on this day");
    expect(JSON.stringify(r)).not.toMatch(/clock|punch|on break|clocked/i);
  });
});
