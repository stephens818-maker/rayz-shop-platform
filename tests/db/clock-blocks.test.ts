/**
 * Time clock punches writing real calendar block-outs (time_blocks, source "clock"), walked through
 * one coming day of Makenna's at Coralville: "Not in yet" until she clocks in, a Lunch break with a
 * planned length, an early clock-out, each linked to its punches and moved, trimmed, reopened or
 * removed when a manager edits, adds or voids a punch. Managers can override or remove them (audit
 * logged); barbers can't. Clients booked in one go into the call-in rebook flow for that block.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let cb: typeof import("@/server/clock-blocks");
let cal: typeof import("@/server/calendar");
let st: typeof import("@/server/staff-time");
let callIns: typeof import("@/server/call-ins");
let calActions: typeof import("@/app/admin/calendar/actions");
let myActions: typeof import("@/app/admin/my-time/actions");
let ciActions: typeof import("@/app/admin/call-ins/actions");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
let cv = "";
let mk: { id: string; displayLabel: string };
let mi: { id: string; displayLabel: string };
let serviceId = "";
let day = "";
let start = 0;
let seq = 0;
const fx: Record<string, string> = {};

const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };
const at = (min: number, d = day) => m.time.zonedWallTime(d, min).toJSDate();
const clockTo = (min: number) => {
  const now = at(min);
  vi.setSystemTime(now);
  return now;
};
const actorOf = (s: { id: string; displayLabel: string }) => ({ staffId: s.id, label: s.displayLabel });
const manager = () => ({ actor: actorOf(mi), staffId: mi.id, isOwner: false, shopIds: [cv] });
async function punchAt(type: "in" | "out" | "break_start" | "break_end", now: Date, extra: { breakReasonId?: string | null; plannedMin?: number | null } = {}) {
  const r = await tc.punch({ staffId: mk.id, shopId: cv, type, source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: actorOf(mk), now, ...extra });
  if (r.kind !== "done") throw new Error(r.message);
  return r;
}
async function appt(first: string, startMin: number, len: number) {
  const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: first, lastName: "Blocktest", email: `${first.toLowerCase()}@blocks.test`, homeShopId: cv }).returning();
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({ code: `CBLK${++seq}`, shopId: cv, staffId: mk.id, customerId: c.id, startsAt: at(startMin), endsAt: at(startMin + len), status: "booked", source: "staff" })
    .returning();
  return a.id;
}
const rows = () =>
  m.db.db
    .select()
    .from(m.schema.timeBlocks)
    .where(m.drizzle.and(eq(m.schema.timeBlocks.staffId, mk.id), eq(m.schema.timeBlocks.source, "clock"), m.drizzle.gte(m.schema.timeBlocks.startsAt, at(0)), m.drizzle.lt(m.schema.timeBlocks.startsAt, at(24 * 60))))
    .orderBy(m.schema.timeBlocks.startsAt);
const byKind = async (prefix: string) => (await rows()).find((b) => b.clockKey?.startsWith(prefix));
const audits = (id: string) => m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.entity, "time_block"), eq(m.schema.auditLog.entityId, id))).orderBy(m.schema.auditLog.at);
const slots = async (now: Date, staffOverride = false) => (await m.booking.getAvailability({ shopRef: "coralville", date: day, serviceId, barberRef: mk.id, now, staffOverride })).slots;
/** Any opening overlapping the time, on the staff side (no lead time), where blocks apply just the same. */
const free = async (now: Date, fromMin: number, toMin: number) => (await slots(now, true)).some((s) => new Date(s.startsAt) < at(toMin) && new Date(s.endsAt) > at(fromMin));
const column = async () => {
  const d = await cal.loadDayCalendar(cv, day, null, { shopIds: [cv], brandWide: true }, { show: (_f, raw) => raw ?? null, stars: () => null }, { staffId: null, seesPrivate: true });
  return d.columns.find((c) => c.id === mk.id)!;
};
const reasonId = async (key: string) => (await m.db.db.query.blockReasons.findFirst({ where: eq(m.schema.blockReasons.key, key) }))!.id;

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  cb = await import("@/server/clock-blocks");
  cal = await import("@/server/calendar");
  st = await import("@/server/staff-time");
  callIns = await import("@/server/call-ins");
  calActions = await import("@/app/admin/calendar/actions");
  myActions = await import("@/app/admin/my-time/actions");
  ciActions = await import("@/app/admin/call-ins/actions");
  mk = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
  mi = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "michelle@rayz.test") }))!;
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
  cv = shop.id;
  serviceId = (await m.catalog.shopCatalog(cv)).find((s) => s.kind === "service")!.id;
  const scheds = await m.db.db.select().from(m.schema.staffSchedules).where(m.drizzle.and(eq(m.schema.staffSchedules.staffId, mk.id), eq(m.schema.staffSchedules.shopId, cv)));
  const base = m.time.todayLocal();
  for (let i = 3; i < 12 && !day; i++) {
    const d = m.time.addDays(base, i);
    const r = scheds.filter((s) => s.weekday === m.time.weekdayOf(d));
    if (r.length === 1 && r[0].startMin <= 9 * 60 + 30 && r[0].endMin >= 17 * 60) {
      day = d;
      start = r[0].startMin;
    }
  }
  expect(day).not.toBe("");
  vi.useFakeTimers({ toFake: ["Date"] });
  clockTo(start - 120);

  await m.db.db.update(m.schema.shops).set({ timeClock: { ...(shop.timeClock as object), notInBlock: true } }).where(eq(m.schema.shops.id, cv));
  const { and, gte, lt } = m.drizzle;
  await m.db.db
    .update(m.schema.appointments)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(eq(m.schema.appointments.staffId, mk.id), gte(m.schema.appointments.startsAt, at(0)), lt(m.schema.appointments.startsAt, at(24 * 60))));
  await m.db.db.delete(m.schema.timeBlocks).where(and(eq(m.schema.timeBlocks.staffId, mk.id), lt(m.schema.timeBlocks.startsAt, at(24 * 60)), gte(m.schema.timeBlocks.endsAt, at(0))));
  // She uses the clock: a shift the day before.
  await punchAt("in", at(9 * 60, m.time.addDays(day, -1)));
  await punchAt("out", at(17 * 60, m.time.addDays(day, -1)));
  fx.first = await appt("Opener", start + 15, 30);
  fx.lunch = await appt("Noon", 12 * 60 + 10, 30);
  fx.late = await appt("Closer", 15 * 60 + 30, 30);
  fx.second = await appt("Second", 16 * 60 + 10, 30);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await m?.db.closeDb();
});

describe("not in yet (the shop turned it on)", () => {
  it("blocks from the scheduled start while she isn't clocked in, softly, and flags her first client", async () => {
    const now = clockTo(start + 10);
    expect((await cb.refreshClockBlocks(now, [cv])).created).toBeGreaterThanOrEqual(1);
    const b = (await byKind("not_in:"))!;
    expect(b).toMatchObject({ reason: "Not in yet", startsAt: at(start), clockOpen: true, punchId: null, endPunchId: null, category: "other" });
    expect(b.endsAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 15 * 60_000 - 1);
    expect(await free(now, start, start + 25)).toBe(false);

    const col = await column();
    expect(col.blocks.find((x) => x.id === b.id)).toMatchObject({ label: "Not in yet", clock: { kind: "not_in", open: true, punchMin: null } });
    expect(col.appts.find((a) => a.id === fx.first)!.clockHold).toEqual({ kind: "not_in", blockId: b.id });
    expect((await audits(b.id)).map((a) => a.action)).toEqual(["block.create"]);
    expect((await audits(b.id))[0].details).toMatchObject({ clock: "not_in", via: "clock", reason: "Not in yet" });
  });

  it("is trimmed to the clock-in and linked to it", async () => {
    const now = clockTo(start + 20);
    const r = await punchAt("in", now);
    const b = (await byKind("not_in:"))!;
    expect(b).toMatchObject({ startsAt: at(start), endsAt: now, clockOpen: false, endPunchId: r.punchId });
    expect((await audits(b.id)).map((a) => a.action)).toEqual(["block.create", "block.update"]);
    expect((await column()).appts.find((a) => a.id === fx.first)!.clockHold).toBeNull();
  });
});

describe("a break", () => {
  it("checks the reason and planned length", async () => {
    const now = clockTo(11 * 60 + 58);
    await expect(punchAt("break_start", now, { plannedMin: 3 })).rejects.toThrow(/5/);
    await expect(punchAt("break_start", now, { breakReasonId: await reasonId("vacation") })).rejects.toThrow(/only/);
    expect(await byKind("break:")).toBeUndefined();
  });

  it("with Lunch picked and 20 minutes planned blocks 12:00–12:20 as Lunch, linked to the break-start punch, in who's blocked", async () => {
    const now = clockTo(12 * 60);
    const r = await punchAt("break_start", now, { breakReasonId: await reasonId("lunch"), plannedMin: 20 });
    const b = (await byKind("break:"))!;
    expect(b).toMatchObject({ clockKey: `break:${r.punchId}`, punchId: r.punchId, reason: "Lunch", category: "lunch", startsAt: now, endsAt: at(12 * 60 + 20), clockOpen: true, shopId: cv });
    const p = await m.db.db.query.timePunches.findFirst({ where: eq(m.schema.timePunches.id, r.punchId) });
    expect(p).toMatchObject({ plannedMin: 20, reasonId: await reasonId("lunch") });
    expect(await free(now, 12 * 60, 12 * 60 + 20)).toBe(false);
    expect((await audits(b.id))[0]).toMatchObject({ action: "block.create", actorStaffId: mk.id, details: expect.objectContaining({ punchId: r.punchId, clock: "break", reason: "Lunch", via: "clock" }) });

    const [row] = await st.staffingFor([cv], day, day, { staffId: null, seesPrivate: true }, [mk.id]);
    expect(row.blocks.map((x) => x.label)).toContain("Lunch");
    expect((await column()).appts.find((a) => a.id === fx.lunch)!.clockHold).toEqual({ kind: "break", blockId: b.id });
  });

  it("runs on past the plan while the break lasts, without an audit entry each time it moves", async () => {
    const now = clockTo(12 * 60 + 30);
    await cb.refreshClockBlocks(now, [cv]);
    const b = (await byKind("break:"))!;
    expect(b.clockOpen).toBe(true);
    expect(b.endsAt.getTime()).toBeGreaterThanOrEqual(at(12 * 60 + 45).getTime());
    expect((await audits(b.id)).map((a) => a.action)).toEqual(["block.create"]);
  });

  it("is trimmed to the break end", async () => {
    const now = clockTo(12 * 60 + 35);
    const r = await punchAt("break_end", now);
    const b = (await byKind("break:"))!;
    expect(b).toMatchObject({ endsAt: now, clockOpen: false, endPunchId: r.punchId });
    expect(await free(now, 12 * 60 + 45, 13 * 60)).toBe(true);
    fx.breakStart = b.punchId!;
    fx.breakEnd = r.punchId;
  });
});

describe("punch edits move the block they're linked to", () => {
  it("moving the break start moves the same block, audited as the manager", async () => {
    const now = clockTo(12 * 60 + 50);
    const before = (await byKind("break:"))!;
    await tc.editPunch(manager(), fx.breakStart, { at: at(11 * 60 + 55) }, "Started a little earlier", now);
    const b = (await byKind("break:"))!;
    expect(b).toMatchObject({ id: before.id, startsAt: at(11 * 60 + 55), endsAt: at(12 * 60 + 35) });
    expect((await audits(b.id)).at(-1)).toMatchObject({ action: "block.update", actorStaffId: mi.id });
  });

  it("voiding the break end reopens it; adding the missed one trims it again", async () => {
    const now = clockTo(12 * 60 + 52);
    await tc.voidPunch(manager(), fx.breakEnd, "Punched by mistake", now);
    let b = (await byKind("break:"))!;
    expect(b).toMatchObject({ clockOpen: true, endPunchId: null });
    expect(b.endsAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 15 * 60_000 - 1);
    const added = await tc.addPunch(manager(), { staffId: mk.id, shopId: cv, type: "break_end", at: at(12 * 60 + 40) }, "Came back at 12:40", now);
    b = (await byKind("break:"))!;
    expect(b).toMatchObject({ clockOpen: false, endsAt: at(12 * 60 + 40), endPunchId: added });
  });

  it("voiding the break start removes the block", async () => {
    const now = clockTo(12 * 60 + 54);
    const b = (await byKind("break:"))!;
    await tc.voidPunch(manager(), fx.breakStart, "Never took the break", now);
    expect(await byKind("break:")).toBeUndefined();
    expect((await audits(b.id)).at(-1)).toMatchObject({ action: "block.delete", actorStaffId: mi.id });
  });
});

describe("an early clock-out", () => {
  it("blocks to the end of the shift as Clocked out, linked to the clock-out", async () => {
    const now = clockTo(15 * 60);
    const r = await punchAt("out", now);
    const b = (await byKind("out:"))!;
    expect(b).toMatchObject({ reason: "Clocked out", punchId: r.punchId, startsAt: now, clockOpen: false, endPunchId: null });
    expect(m.time.localMinutesOf(b.endsAt)).toBeGreaterThanOrEqual(17 * 60);
    expect(await slots(now)).toEqual([]);
    expect((await column()).appts.find((a) => a.id === fx.late)!.clockHold).toEqual({ kind: "clocked_out", blockId: b.id });
  });

  it("is trimmed when she clocks back in, and put back when that clock-in is voided", async () => {
    let now = clockTo(15 * 60 + 20);
    const r = await punchAt("in", now);
    expect(await byKind("out:")).toMatchObject({ endsAt: now, endPunchId: r.punchId });
    now = clockTo(15 * 60 + 22);
    await tc.voidPunch(manager(), r.punchId, "Clocked in on the wrong phone", now);
    const b = (await byKind("out:"))!;
    expect(b.endPunchId).toBeNull();
    expect(m.time.localMinutesOf(b.endsAt)).toBeGreaterThanOrEqual(17 * 60);
  });
});

describe("only managers change a clock block, and every change is in the audit log", () => {
  it("a barber can't override, remove or release it, from the calendar or My time", async () => {
    const b = (await byKind("out:"))!;
    await signInAs(mk.id);
    expect(await calActions.overrideClockBlockAction(b.id, { date: day, startMin: 15 * 60, endMin: 16 * 60 })).toMatchObject({ ok: false, error: expect.stringMatching(/Only a manager/) });
    expect(await calActions.deleteBlockAction(b.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a manager/) });
    expect(await calActions.releaseClockBlockAction(b.id)).toMatchObject({ ok: false });
    expect(await myActions.removeMyBlockAction(b.id)).toMatchObject({ ok: false, error: expect.stringMatching(/time clock/) });
    expect(await byKind("out:")).toMatchObject({ id: b.id, overriddenAt: null });
  });

  it("a manager's times stick: punch edits don't move it until it's put back to the clock", async () => {
    const b = (await byKind("out:"))!;
    const now = clockTo(15 * 60 + 35);
    await signInAs(mi.id);
    expect(await calActions.overrideClockBlockAction(b.id, { date: day, startMin: 15 * 60, endMin: 16 * 60, note: "Covering the front desk till 4" })).toMatchObject({ ok: true });
    let row = (await byKind("out:"))!;
    expect(row).toMatchObject({ endsAt: at(16 * 60), overriddenBy: mi.id, clockOpen: false });
    expect(row.overriddenAt).not.toBeNull();
    const o = (await audits(b.id)).find((a) => a.action === "block.clock_override")!;
    expect(o).toMatchObject({ actorStaffId: mi.id, details: expect.objectContaining({ overrideNote: "Covering the front desk till 4", via: "manager" }) });
    expect((o.details as { before: { endsAt: string } }).before.endsAt).toBe(b.endsAt.toISOString());

    const back = await tc.addPunch(manager(), { staffId: mk.id, shopId: cv, type: "in", at: at(15 * 60 + 30) }, "Back from the bank", now);
    row = (await byKind("out:"))!;
    expect(row.endsAt).toEqual(at(16 * 60));

    expect(await calActions.resetClockBlockAction(b.id)).toMatchObject({ ok: true });
    row = (await byKind("out:"))!;
    expect(row).toMatchObject({ overriddenAt: null, endsAt: at(15 * 60 + 30), endPunchId: back });
    expect((await audits(b.id)).map((a) => a.action)).toContain("block.clock_reset");
  });

  it("a manager's release reopens the time for good: the clock doesn't write it again", async () => {
    const b = (await byKind("out:"))!;
    const now = clockTo(15 * 60 + 40);
    expect(await calActions.deleteBlockAction(b.id)).toMatchObject({ ok: true });
    expect(await byKind("out:")).toBeUndefined();
    expect(await m.db.db.query.clockBlockReleases.findFirst({ where: eq(m.schema.clockBlockReleases.clockKey, b.clockKey!) })).toMatchObject({ releasedBy: mi.id });
    expect((await audits(b.id)).at(-1)).toMatchObject({ action: "block.clock_release", actorStaffId: mi.id });
    await cb.syncClockBlocks([mk.id], { from: at(0), to: at(24 * 60 - 1) }, { now });
    expect(await byKind("out:")).toBeUndefined();
  });
});

describe("clients booked in a clock block go to the rebook flow", () => {
  it("opens a call-in on the block itself, adds clients booked later, and cancelling it leaves the block to the clock", async () => {
    const now = clockTo(16 * 60);
    await punchAt("break_start", now);
    const b = (await byKind("break:"))!;
    expect(b.clockOpen).toBe(true);

    const view = await callIns.clockBlockCallIn(b.id, { shopIds: [cv], viewer: { staffId: mi.id, seesPrivate: true }, now });
    expect(view).toMatchObject({ id: b.id, label: "Break", open: true, over: false, callInId: null, booked: [{ name: "Second B." }] });
    expect(await callIns.clockBlockCallIn(b.id, { shopIds: [], viewer: { staffId: mi.id, seesPrivate: true }, now })).toBeNull();

    await signInAs(mi.id);
    const r = await ciActions.callInFromClockBlockAction(b.id);
    expect(r).toMatchObject({ ok: true, data: { affected: 1, existing: false } });
    const id = (r as { data: { callInId: string } }).data.callInId;
    const ci = (await m.db.db.query.callIns.findFirst({ where: eq(m.schema.callIns.id, id) }))!;
    expect(ci).toMatchObject({ blockId: b.id, staffId: mk.id, shopId: cv, kind: "other", reason: "Break", startsAt: now });
    const listed = await m.db.db.select().from(m.schema.appointmentOutreach).where(eq(m.schema.appointmentOutreach.callInId, id));
    expect(listed.map((x) => x.appointmentId)).toEqual([fx.second]);
    expect(await m.db.db.select().from(m.schema.timeBlocks).where(m.drizzle.and(eq(m.schema.timeBlocks.staffId, mk.id), eq(m.schema.timeBlocks.category, "time_off"), m.drizzle.gte(m.schema.timeBlocks.startsAt, at(0))))).toEqual([]);

    fx.third = await appt("Third", 16 * 60, 10);
    const again = await ciActions.callInFromClockBlockAction(b.id);
    expect(again).toMatchObject({ ok: true, data: { callInId: id, affected: 1, existing: true } });

    await callIns.cancelCallIn(id, actorOf(mi), now);
    expect(await byKind("break:")).toMatchObject({ id: b.id });
  });

  it("nobody outside the block's shop can open it, or even see it", async () => {
    const b = (await byKind("break:"))!;
    const moline = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "manager.moline@rayz.test") }))!;
    await signInAs(moline.id);
    expect(await ciActions.callInFromClockBlockAction(b.id)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) });
    expect(await calActions.overrideClockBlockAction(b.id, { date: day, startMin: 16 * 60, endMin: 17 * 60 })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) });
  });
});
