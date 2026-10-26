/**
 * Staff self-service time against a real database: recurring blocks take time out of online
 * booking (and skipping one gives it back), part-day time off removes only those hours, pending
 * requests hold online booking, booked appointments are warned about and never dropped, shops that
 * approve automatically do so only when nothing is booked, and only the right people decide.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let st: typeof import("@/server/staff-time");
let series: typeof import("@/server/block-series");
let mine: typeof import("@/app/admin/my-time/actions");
let decide: typeof import("@/app/admin/time-off/actions");

beforeAll(async () => {
  m = await loadModules();
  st = await import("@/server/staff-time");
  series = await import("@/server/block-series");
  mine = await import("@/app/admin/my-time/actions");
  decide = await import("@/app/admin/time-off/actions");
  closed = new Set((await m.db.db.select().from(m.schema.shopClosures)).map((c) => c.date));
  reasons = new Map((await m.db.db.select().from(m.schema.blockReasons)).map((r) => [r.key, r.id]));
}, 180_000);

let reasons = new Map<string, string>();
const rid = (key: string) => reasons.get(key)!;
const ALL = { staffId: null, seesPrivate: true };

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const staffBy = async (where: { email?: string; label?: string }) =>
  (await m.db.db.query.staff.findFirst({ where: where.email ? eq(m.schema.staff.email, where.email) : eq(m.schema.staff.displayLabel, where.label!) }))!;
const as = async (email: string) => signInAs((await staffBy({ email })).id);
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;

let closed = new Set<string>();
/** The next `weekday` (0 = Sunday) at least `ahead` days out that no shop is closed for a holiday, and the day after is open too; each test uses its own weeks. */
const dayOn = (weekday: number, ahead: number) => {
  let d = m.time.addDays(m.time.todayLocal(), ahead);
  while (m.time.weekdayOf(d) !== weekday || closed.has(d) || closed.has(m.time.addDays(d, 1))) d = m.time.addDays(d, 1);
  return d;
};
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();

async function cut(shopSlug: string) {
  return (await m.public.publicServices(shopSlug)).services.find((s) => s.kind === "service")!;
}

/** The barber's bookable starts that day, in local minutes, and how long the cut takes. */
async function starts(shopSlug: string, staffId: string, date: string, staffOverride = false) {
  const svc = await cut(shopSlug);
  const a = await m.booking.getAvailability({ shopRef: shopSlug, date, serviceId: svc.id, barberRef: staffId, staffOverride });
  return { mins: a.slots.map((s) => m.time.localMinutesOf(new Date(s.startsAt))), dur: a.durationMin };
}
/** No bookable start overlaps [from, to). */
const clear = (s: { mins: number[]; dur: number }, from: number, to: number) => s.mins.every((x) => x + s.dur <= from || x >= to);

let phone = 3195557000;
async function book(shopSlug: string, staffId: string, date: string, near: number) {
  const svc = await cut(shopSlug);
  const a = await m.booking.getAvailability({ shopRef: shopSlug, date, serviceId: svc.id, barberRef: staffId });
  const slot = [...a.slots].sort((x, y) => Math.abs(m.time.localMinutesOf(new Date(x.startsAt)) - near) - Math.abs(m.time.localMinutesOf(new Date(y.startsAt)) - near))[0];
  if (!slot) throw new Error(`no slots for ${date}`);
  return m.booking.createAppointment({ shopRef: shopSlug, serviceId: svc.id, barberRef: staffId, startsAt: slot.startsAt, customer: { firstName: "Timeoff", phone: String(phone++), smsOptIn: true }, source: "online", actor });
}
const appt = async (id: string) => (await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, id) }))!;
const request = async (id: string) => (await m.db.db.query.timeOffRequests.findFirst({ where: eq(m.schema.timeOffRequests.id, id) }))!;
const audits = async (entityId: string) =>
  (await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, entityId))).map((a) => a.action).sort();

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error!);

describe("recurring blocks", () => {
  it("a recurring break comes out of online booking every week; skipping one gives that day back; extending and ending it", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    await as("makenna@rayz.test");
    const tue = dayOn(2, 22);
    const wed = m.time.addDays(tue, 1);
    expect(clear(await starts("coralville", makenna.id, tue), 900, 915)).toBe(false);

    const made = ok(await mine.createMySeriesAction({ reasonId: rid("break"), weekdays: [2, 4], startMin: 900, endMin: 915, startsOn: tue }));
    expect(made.saved).toBe(true);
    expect(made.occurrences).toBeGreaterThan(100);
    for (const d of [tue, m.time.addDays(tue, 2), m.time.addDays(tue, 7)]) expect(clear(await starts("coralville", makenna.id, d), 900, 915), d).toBe(true);
    expect(clear(await starts("coralville", makenna.id, wed), 900, 915)).toBe(false);

    const s = (await m.db.db.query.timeBlockSeries.findFirst({ where: m.drizzle.and(eq(m.schema.timeBlockSeries.staffId, makenna.id), eq(m.schema.timeBlockSeries.reasonId, rid("break"))) }))!;
    expect([s.shopId, s.weekdays]).toEqual([null, [2, 4]]);
    const first = (await m.db.db.query.timeBlocks.findFirst({ where: m.drizzle.and(eq(m.schema.timeBlocks.seriesId, s.id), eq(m.schema.timeBlocks.startsAt, at(tue, 900))) }))!;
    expect([first.category, first.reasonId, first.reason]).toEqual(["other", rid("break"), "Break"]);
    ok(await mine.removeMyBlockAction(first.id));
    expect(clear(await starts("coralville", makenna.id, tue), 900, 915)).toBe(false);
    expect(clear(await starts("coralville", makenna.id, m.time.addDays(tue, 7)), 900, 915)).toBe(true);

    // Written ahead in steps: pull the horizon back to next week and let the cron write the rest.
    const nextWeek = m.time.addDays(tue, 7);
    await m.db.db.update(m.schema.timeBlockSeries).set({ materializedThrough: nextWeek }).where(eq(m.schema.timeBlockSeries.id, s.id));
    await m.db.db.delete(m.schema.timeBlocks).where(m.drizzle.and(eq(m.schema.timeBlocks.seriesId, s.id), m.drizzle.gt(m.schema.timeBlocks.startsAt, m.time.endOfLocalDay(nextWeek))));
    expect(clear(await starts("coralville", makenna.id, m.time.addDays(tue, 14)), 900, 915)).toBe(false);
    expect(await series.extendSeries()).toBeGreaterThan(50);
    expect(await series.extendSeries()).toBe(0);
    expect(clear(await starts("coralville", makenna.id, m.time.addDays(tue, 14)), 900, 915)).toBe(true);
    expect(clear(await starts("coralville", makenna.id, tue), 900, 915)).toBe(false);

    await as("kat@rayz.test");
    expect(err(await mine.endMySeriesAction(s.id))).toMatch(/not found/i);
    await as("makenna@rayz.test");
    expect(ok(await mine.endMySeriesAction(s.id)).removed).toBeGreaterThan(100);
    expect(clear(await starts("coralville", makenna.id, nextWeek), 900, 915)).toBe(false);
    expect((await audits(s.id)).sort()).toEqual(["block_series.create", "block_series.end"]);
    expect(await audits(first.id)).toEqual(["block.delete"]);
  });
});

describe("time off", () => {
  it("part of a day removes only those hours; pending holds online booking but not the desk; denied reopens it", async () => {
    const jessica = await staffBy({ label: "Jessica" });
    const cv = await shop("coralville");
    const thu = dayOn(4, 29);
    const ask = () => st.requestTimeOff({ staffId: jessica.id, shopId: cv.id, range: { fromDate: thu, toDate: thu, startMin: 14 * 60, endMin: 17 * 60 }, reasonId: rid("personal") }, { actor, enforceNotice: false });

    const pending = await ask();
    expect(pending).toMatchObject({ done: true, status: "pending" });
    const online = await starts("coralville", jessica.id, thu);
    expect(clear(online, 840, 1020)).toBe(true);
    expect(online.mins.some((x) => x < 600)).toBe(true);
    expect(clear(await starts("coralville", jessica.id, thu, true), 840, 1020)).toBe(false);
    expect((await st.staffingFor([cv.id], thu, thu, ALL, [jessica.id]))[0]).toMatchObject({ status: "working", pending: true });

    await as("michelle@rayz.test");
    ok(await decide.decideTimeOffAction((pending as { requestId: string }).requestId, "deny", "Short that day"));
    expect(clear(await starts("coralville", jessica.id, thu), 840, 1020)).toBe(false);

    const again = (await ask()) as { requestId: string };
    expect(ok(await decide.decideTimeOffAction(again.requestId, "approve", ""))).toEqual({ affected: 0 });
    const block = (await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.requestId, again.requestId) }))!;
    expect([block.category, block.kind, block.startsAt, block.endsAt]).toEqual(["time_off", "block", at(thu, 840), at(thu, 1020)]);
    const after = await starts("coralville", jessica.id, thu);
    expect(clear(after, 840, 1020)).toBe(true);
    expect(after.mins.some((x) => x < 600)).toBe(true);
    expect(clear(await starts("coralville", jessica.id, thu, true), 840, 1020)).toBe(true);
    expect((await st.staffingFor([cv.id], thu, thu, ALL, [jessica.id]))[0]).toMatchObject({ status: "partly_off", offMin: 180, hasTimeOff: true, pending: false });
  });

  it("a shop that approves automatically does so only when nothing is booked; otherwise a manager decides", async () => {
    const jilane = await staffBy({ label: "Jilane" });
    const wed = dayOn(3, 29);
    const thu = m.time.addDays(wed, 1);
    const whole = (d: string) => ({ fromDate: d, toDate: d, startMin: null, endMin: null });

    const auto = (await st.requestTimeOff({ staffId: jilane.id, shopId: null, range: whole(wed), reasonId: rid("vacation") }, { actor, enforceNotice: true })) as { requestId: string; status: string };
    expect(auto.status).toBe("approved");
    expect(await request(auto.requestId)).toMatchObject({ decidedVia: "auto" });
    expect((await starts("moline", jilane.id, wed)).mins).toEqual([]);
    expect(await audits(auto.requestId)).toEqual(["time_off.approve", "time_off.request"]);

    const a = await book("moline", jilane.id, thu, 10 * 60);
    const warned = await st.requestTimeOff({ staffId: jilane.id, shopId: null, range: whole(thu), reasonId: rid("vacation") }, { actor, enforceNotice: true });
    expect(warned.done).toBe(false);
    expect(warned.conflicts.map((c) => c.code)).toEqual([a.code]);
    expect(await m.db.db.query.timeOffRequests.findFirst({ where: m.drizzle.and(eq(m.schema.timeOffRequests.staffId, jilane.id), eq(m.schema.timeOffRequests.fromDate, thu)) })).toBeUndefined();
    const held = await st.requestTimeOff({ staffId: jilane.id, shopId: null, range: whole(thu), reasonId: rid("vacation") }, { actor, confirm: true, enforceNotice: true });
    expect(held).toMatchObject({ done: true, status: "pending", heldForManager: true });
    expect((await appt(a.id)).status).toBe("booked");
    await expect(st.requestTimeOff({ staffId: jilane.id, shopId: null, range: whole(thu), reasonId: rid("sick") }, { actor, enforceNotice: true })).rejects.toThrow(/already time off/);

    // Kat also works at shops where a manager approves: the strictest shop wins.
    const kat = await staffBy({ email: "kat@rayz.test" });
    const katDay = await st.requestTimeOff({ staffId: kat.id, shopId: null, range: whole(dayOn(1, 36)), reasonId: rid("vacation") }, { actor, enforceNotice: true });
    expect(katDay).toMatchObject({ done: true, status: "pending", heldForManager: false });
  });
});

describe("booked appointments are warned about and never dropped", () => {
  it("blocks and time off over bookings need a confirm; approval lists them; a manager moves one and asks the other client to reschedule", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const fri = dayOn(5, 36);
    const first = await book("coralville", makenna.id, fri, 10 * 60);
    const second = await book("coralville", makenna.id, fri, 15 * 60);
    const firstMin = m.time.localMinutesOf(new Date(first.startsAt));

    await as("makenna@rayz.test");
    const warned = ok(await mine.quickBlockAction({ reasonId: rid("personal"), date: fri, startMin: firstMin, minutes: 30 }));
    expect(warned).toEqual({ saved: false, conflicts: [expect.objectContaining({ code: first.code })] });
    expect(await m.db.db.query.timeBlocks.findFirst({ where: m.drizzle.and(eq(m.schema.timeBlocks.staffId, makenna.id), eq(m.schema.timeBlocks.startsAt, at(fri, firstMin))) })).toBeUndefined();
    expect(ok(await mine.quickBlockAction({ reasonId: rid("personal"), date: fri, startMin: firstMin, minutes: 30, confirm: true })).saved).toBe(true);
    expect((await appt(first.id)).status).toBe("booked");

    const off = { shopId: null, fromDate: fri, toDate: fri, allDay: true, reasonId: rid("vacation") };
    const t1 = ok(await mine.requestTimeOffAction(off));
    expect(t1.saved).toBe(false);
    expect(t1.conflicts.map((c) => c.code).sort()).toEqual([first.code, second.code].sort());
    const t2 = ok(await mine.requestTimeOffAction({ ...off, confirm: true }));
    expect(t2).toMatchObject({ saved: true, status: "pending" });
    const req = (await m.db.db.query.timeOffRequests.findFirst({ where: m.drizzle.and(eq(m.schema.timeOffRequests.staffId, makenna.id), eq(m.schema.timeOffRequests.fromDate, fri)) }))!;

    await as("michelle@rayz.test");
    expect(ok(await decide.decideTimeOffAction(req.id, "approve", "Have fun"))).toEqual({ affected: 2 });
    expect([(await appt(first.id)).status, (await appt(second.id)).status]).toEqual(["booked", "booked"]);
    const affected = (await st.affectedByRequests([req])).get(req.id)!;
    expect(affected.map((a) => a.code).sort()).toEqual([first.code, second.code].sort());
    const told = await m.db.db.query.notificationJobs.findFirst({ where: m.drizzle.and(eq(m.schema.notificationJobs.kind, "time_off_decision"), eq(m.schema.notificationJobs.to, "makenna@rayz.test")) });
    expect(told?.subject).toMatch(/Time off approved/);

    await as("makenna@rayz.test");
    expect(err(await decide.reassignAction(first.id, makenna.id))).toMatch(/can't move appointments/);
    await as("michelle@rayz.test");
    const options = ok(await decide.reassignOptionsAction(first.id));
    const to = options.find((o) => o.free)!;
    expect(to).toBeDefined();
    expect(options.some((o) => o.staffId === makenna.id)).toBe(false);
    ok(await decide.reassignAction(first.id, to.staffId));
    expect(await appt(first.id)).toMatchObject({ staffId: to.staffId, status: "booked", startsAt: new Date(first.startsAt) });

    expect(ok(await decide.askRescheduleAction(second.id)).sent).toBeGreaterThan(0);
    expect((await appt(second.id)).status).toBe("booked");
    const asked = (await st.affectedByRequests([req])).get(req.id)!;
    expect(asked.map((a) => [a.code, a.askedAt !== null])).toEqual([[second.code, true]]);
    const text = await m.db.db.query.notificationJobs.findFirst({ where: m.drizzle.and(eq(m.schema.notificationJobs.kind, "time_off_reschedule"), eq(m.schema.notificationJobs.appointmentId, second.id)) });
    expect(text?.body).toMatch(/Your booking stays until you change it/);
    expect(await audits(first.id)).toContain("time_off.reassign");
    expect(await audits(second.id)).toContain("time_off.ask_reschedule");
    expect(await audits(req.id)).toEqual(["time_off.approve", "time_off.request"]);
  });

  it("lunch now is 30 minutes from this minute, with the same warning", async () => {
    await as("makenna@rayz.test");
    let r = ok(await mine.lunchNowAction());
    if (!r.saved) {
      expect(r.conflicts.length).toBeGreaterThan(0);
      r = ok(await mine.lunchNowAction(true));
    }
    expect(r.saved).toBe(true);
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const [b] = await m.db.db.select().from(m.schema.timeBlocks).where(m.drizzle.and(eq(m.schema.timeBlocks.staffId, makenna.id), eq(m.schema.timeBlocks.reason, "Lunch"), m.drizzle.isNull(m.schema.timeBlocks.seriesId))).orderBy(m.drizzle.desc(m.schema.timeBlocks.createdAt)).limit(1);
    expect((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000).toBe(30);
    expect(Math.abs(b.startsAt.getTime() - Date.now())).toBeLessThan(2 * 60_000);
    expect(await audits(b.id)).toEqual(["block.create"]);
  });
});

describe("limits, notice and who decides", () => {
  it("holds barbers to the longest lunch and block and the minimum notice; managers aren't held to the block limits", async () => {
    const wed = dayOn(3, 43);
    await as("makenna@rayz.test");
    expect(err(await mine.quickBlockAction({ reasonId: rid("lunch"), date: wed, startMin: 11 * 60, minutes: 90 }))).toMatch(/Lunch can be at most 60 minutes/);
    expect(err(await mine.quickBlockAction({ reasonId: rid("personal"), date: wed, startMin: 9 * 60, minutes: 150 }))).toMatch(/at most 120 minutes/);
    expect(err(await mine.createMySeriesAction({ reasonId: rid("lunch"), weekdays: [3], startMin: 720, endMin: 810, startsOn: wed }))).toMatch(/at most 60 minutes/);
    expect(err(await mine.quickBlockAction({ reasonId: "", date: wed, startMin: 9 * 60, minutes: 30 }))).toMatch(/Pick a reason/);
    const today = m.time.todayLocal();
    const soon = m.time.addDays(today, 3);
    expect(err(await mine.requestTimeOffAction({ shopId: null, fromDate: soon, toDate: soon, allDay: true, reasonId: rid("vacation") }))).toMatch(/7 days' notice/);
    const tomorrow = m.time.addDays(today, 1);
    expect(ok(await mine.requestTimeOffAction({ shopId: null, fromDate: tomorrow, toDate: tomorrow, allDay: false, startMin: 6 * 60, endMin: 8 * 60, reasonId: rid("sick") })).saved).toBe(true);
    const moline = await shop("moline");
    expect(err(await mine.requestTimeOffAction({ shopId: moline.id, fromDate: wed, toDate: wed, allDay: true, reasonId: rid("vacation") }))).toMatch(/don't work at that shop/);

    expect(err(await decide.saveRulesAction((await shop("coralville")).id, { maxLunchMin: 45 }))).toMatch(/can't change the time off rules/);
    await as("michelle@rayz.test");
    expect(err(await brandAction("setting", "staff_time", { maxLunchMin: 45 }))).toMatch(/every shop/);
    const cv = await shop("coralville");
    ok(await decide.saveRulesAction(cv.id, { maxLunchMin: 45 }));
    expect(ok(await mine.quickBlockAction({ reasonId: rid("lunch"), date: wed, startMin: 11 * 60, minutes: 90 })).saved).toBe(true);
    await as("makenna@rayz.test");
    expect(err(await mine.quickBlockAction({ reasonId: rid("lunch"), date: wed, startMin: 11 * 60, minutes: 50 }))).toMatch(/at most 45 minutes/);
    expect(ok(await mine.quickBlockAction({ reasonId: rid("lunch"), date: wed, startMin: 11 * 60, minutes: 45 })).saved).toBe(true);
    await as("michelle@rayz.test");
    ok(await decide.saveRulesAction(cv.id, {}));
    expect(await audits(cv.id)).toEqual(["staff_time.rules", "staff_time.rules"]);
  });

  it("requesting is separate from approving: barbers and the desk can't decide, nobody decides their own, and other shops are refused", async () => {
    const sat = dayOn(6, 43);
    const whole = { shopId: null, fromDate: sat, toDate: sat, allDay: true, reasonId: rid("vacation") };
    await as("makenna@rayz.test");
    ok(await mine.requestTimeOffAction(whole));
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const mk = (await m.db.db.query.timeOffRequests.findFirst({ where: m.drizzle.and(eq(m.schema.timeOffRequests.staffId, makenna.id), eq(m.schema.timeOffRequests.fromDate, sat)) }))!;
    expect(mk.status).toBe("pending");
    expect(err(await decide.decideTimeOffAction(mk.id, "approve", ""))).toMatch(/can't approve or deny/);
    await as("frontdesk@rayz.test");
    expect(err(await decide.decideTimeOffAction(mk.id, "approve", ""))).toMatch(/can't approve or deny/);
    await as("manager.moline@rayz.test");
    expect(err(await decide.decideTimeOffAction(mk.id, "approve", ""))).toMatch(/shops you don't manage/);

    await as("michelle@rayz.test");
    ok(await mine.requestTimeOffAction({ ...whole, fromDate: dayOn(1, 43), toDate: dayOn(1, 43) }));
    const michelle = await staffBy({ email: "michelle@rayz.test" });
    const own = (await m.db.db.query.timeOffRequests.findFirst({ where: m.drizzle.and(eq(m.schema.timeOffRequests.staffId, michelle.id), eq(m.schema.timeOffRequests.status, "pending")) }))!;
    expect(err(await decide.decideTimeOffAction(own.id, "approve", ""))).toMatch(/your own time off/);
    await as("owner@rayz.test");
    ok(await decide.decideTimeOffAction(own.id, "approve", ""));

    await as("michelle@rayz.test");
    ok(await decide.decideTimeOffAction(mk.id, "approve", ""));
    expect(err(await decide.decideTimeOffAction(mk.id, "deny", ""))).toMatch(/already approved/);
    const block = (await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.requestId, mk.id) }))!;
    expect(block.kind).toBe("day_off");
    expect((await starts("coralville", makenna.id, sat)).mins).toEqual([]);

    await as("makenna@rayz.test");
    expect(err(await mine.removeMyBlockAction(block.id))).toMatch(/Cancel the request instead/);
    ok(await mine.cancelMyRequestAction(mk.id));
    expect((await request(mk.id)).status).toBe("cancelled");
    expect(await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.requestId, mk.id) })).toBeUndefined();
    expect((await starts("coralville", makenna.id, sat)).mins.length).toBeGreaterThan(0);
    expect(await audits(mk.id)).toEqual(["time_off.approve", "time_off.cancel", "time_off.request"]);

    // Kat works at Moline, Rock Island and Silvis: time off at all of them needs someone with all three.
    const kat = await staffBy({ email: "kat@rayz.test" });
    const all = (await st.requestTimeOff({ staffId: kat.id, shopId: null, range: { fromDate: dayOn(2, 43), toDate: dayOn(2, 43), startMin: null, endMin: null }, reasonId: rid("personal") }, { actor, enforceNotice: false })) as { requestId: string };
    for (const who of ["manager.moline@rayz.test", "regional@rayz.test"]) {
      await as(who);
      expect(err(await decide.decideTimeOffAction(all.requestId, "approve", "")), who).toMatch(/shops you don't manage/);
    }
    await as("admin@rayz.test");
    ok(await decide.decideTimeOffAction(all.requestId, "deny", "Covering Rock Island that day"));
    expect(await request(all.requestId)).toMatchObject({ status: "denied", decisionNote: "Covering Rock Island that day", decidedVia: "manager" });
  });
});
