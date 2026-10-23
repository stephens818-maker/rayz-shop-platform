/**
 * The time clock against a real database: punches pair into shifts and derive clocked hours (unpaid
 * breaks out), each shop's check (device, GPS, network) is enforced and recorded, the front-desk PIN
 * locks after five wrong tries, time off warns first, late against the schedule is flagged, manager
 * edits need a reason and land in the append-only edit log and the audit log with before and after,
 * approvals go employee then manager, a locked period refuses punches, edits and hours, forgotten
 * clock-outs and full-time changes alert managers, the export's totals add up, and pay rates only
 * show with their permission.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { jar, signInAs } from "./session";
import { found, get, open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let tx: typeof import("@/server/time-clock-export");
let run: typeof import("@/server/payroll/run");
let pay: typeof import("@/domain/payroll");
let clockActions: typeof import("@/app/admin/clock/actions");
let sheetActions: typeof import("@/app/admin/timesheets/actions");
let exportRoute: typeof import("@/app/admin/timesheets/export/route");

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  tx = await import("@/server/time-clock-export");
  run = await import("@/server/payroll/run");
  pay = await import("@/domain/payroll");
  clockActions = await import("@/app/admin/clock/actions");
  sheetActions = await import("@/app/admin/timesheets/actions");
  exportRoute = await import("@/app/admin/timesheets/export/route");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, email) }))!;
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, slug) }))!;
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
/** A pay period `k` periods after today's, so each test has its own clean stretch of time. */
const period = (k: number) => pay.payPeriodByIndex(pay.payPeriodFor(m.time.todayLocal()).index + k);
const actorOf = (s: { id: string; displayLabel: string }) => ({ staffId: s.id, label: s.displayLabel });
const editorOf = (s: { id: string; displayLabel: string }, shopIds: string[], isOwner = false) => ({ actor: actorOf(s), staffId: s.id, isOwner, shopIds });
/** Standing in the Coralville shop with location on. */
const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };

async function punchAt(staff: { id: string; displayLabel: string }, shopId: string, type: "in" | "out" | "break_start" | "break_end", now: Date, gps = HERE) {
  const r = await tc.punch({ staffId: staff.id, shopId, type, source: "self", evidence: { deviceShopId: null, ip: null, gps }, deviceId: null, photo: null, actor: actorOf(staff), now });
  if (r.kind !== "done") throw new Error(r.message);
  return r;
}
const entriesOf = (punchInId: string) => m.db.db.select().from(S().timeEntries).where(eq(S().timeEntries.punchInId, punchInId));
const minutesOf = (rows: { startsAt: Date; endsAt: Date }[]) => rows.reduce((a, e) => a + (e.endsAt.getTime() - e.startsAt.getTime()) / 60_000, 0);

describe("punching", () => {
  it("in, a meal break and out pair into one shift; the unpaid break comes out of the hours", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const day = m.time.addDays(period(2).start, 1);
    const inn = await punchAt(mk, cv.id, "in", at(day, 9 * 60));
    expect((await tc.clockState(mk.id, at(day, 10 * 60))).state).toBe("working");
    await expect(punchAt(mk, cv.id, "in", at(day, 10 * 60))).rejects.toThrow(/already clocked in/);
    const other = await shop("moline");
    await expect(punchAt(mk, other.id, "out", at(day, 10 * 60))).rejects.toThrow(/team|clocked in at Coralville/);
    await punchAt(mk, cv.id, "break_start", at(day, 12 * 60));
    expect((await tc.clockState(mk.id, at(day, 12 * 60 + 5))).next).toEqual(["break_end", "out"]);
    await punchAt(mk, cv.id, "break_end", at(day, 12 * 60 + 30));
    await punchAt(mk, cv.id, "out", at(day, 17 * 60));
    const rows = await entriesOf(inn.punchId);
    expect(rows.map((r) => r.source)).toEqual(["clock", "clock"]);
    expect(minutesOf(rows)).toBe(7.5 * 60);
    const [p] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, inn.punchId));
    expect(p).toMatchObject({ method: "gps", source: "self", shopId: cv.id });
    expect(p.distanceM).toBeLessThan(50);
  });

  it("each shop's check is enforced, and refused punches leave nothing behind", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const now = at(m.time.addDays(period(2).start, 2), 9 * 60);
    const before = (await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.staffId, mk.id))).length;
    const moline = { lat: 41.493, lng: -90.487, accuracyM: 10 };
    await expect(punchAt(mk, cv.id, "in", now, moline)).rejects.toThrow(/km away/);
    await expect(tc.punch({ staffId: mk.id, shopId: cv.id, type: "in", source: "self", evidence: { deviceShopId: null, ip: "203.0.113.10", gps: null }, deviceId: null, photo: null, actor: actorOf(mk), now })).rejects.toThrow(
      /didn't share its location/,
    );
    await expect(tc.punch({ staffId: mk.id, shopId: cv.id, type: "in", source: "kiosk", evidence: { deviceShopId: null, ip: null, gps: null }, deviceId: null, photo: null, actor: actorOf(mk), now })).rejects.toThrow(
      /registered time clock devices/,
    );
    expect((await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.staffId, mk.id))).length).toBe(before);
    const ok = await tc.punch({ staffId: mk.id, shopId: cv.id, type: "in", source: "self", evidence: { deviceShopId: cv.id, ip: null, gps: null }, deviceId: null, photo: null, actor: actorOf(mk), now });
    expect(ok.kind).toBe("done");
    const [p] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, (ok as { punchId: string }).punchId));
    expect(p.method).toBe("device");
    await punchAt(mk, cv.id, "out", new Date(now.getTime() + 4 * 3600_000));
  });

  it("clocking in during time off asks first, then is flagged", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const day = m.time.addDays(period(2).start, 3);
    await m.db.db.insert(S().timeBlocks).values({ staffId: mk.id, shopId: null, startsAt: at(day, 0), endsAt: at(m.time.addDays(day, 1), 0), kind: "day_off", category: "time_off", reason: "Vacation" });
    const req = { staffId: mk.id, shopId: cv.id, type: "in" as const, source: "self" as const, evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: actorOf(mk), now: at(day, 9 * 60) };
    const ask = await tc.punch(req);
    expect(ask).toMatchObject({ kind: "confirm" });
    expect((ask as { message: string }).message).toMatch(/time off right now \(Vacation/);
    const done = await tc.punch({ ...req, confirmTimeOff: true });
    expect(done.kind === "done" && done.flags).toContain("during_time_off");
    await punchAt(mk, cv.id, "out", at(day, 11 * 60));
  });

  it("late against the schedule is flagged past the grace minutes", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const rows = await m.db.db.select().from(S().staffSchedules).where(m.drizzle.and(eq(S().staffSchedules.staffId, mk.id), eq(S().staffSchedules.shopId, cv.id)));
    const p = period(3);
    let day = p.start;
    while (!rows.some((r) => r.weekday === m.time.weekdayOf(day))) day = m.time.addDays(day, 1);
    const sched = rows.find((r) => r.weekday === m.time.weekdayOf(day))!;
    const onTime = await punchAt(mk, cv.id, "in", at(day, sched.startMin + 3));
    expect(onTime.flags).toEqual([]);
    await punchAt(mk, cv.id, "out", at(day, sched.endMin));
    const next = m.time.addDays(day, 7);
    const late = await punchAt(mk, cv.id, "in", at(next, sched.startMin + 12));
    expect(late.flags).toEqual(["late"]);
    const [row] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, late.punchId));
    expect(row.offScheduleMin).toBe(12);
    const early = await punchAt(mk, cv.id, "out", at(next, sched.endMin - 30));
    expect(early.flags).toEqual(["early_out"]);
  });

  it("a shift over the end of a pay period splits its hours at midnight and its punches show on both sheets", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const p = period(8);
    const before = await punchAt(mk, cv.id, "in", at(m.time.addDays(p.end, -1), 9 * 60));
    await punchAt(mk, cv.id, "out", at(m.time.addDays(p.end, -1), 10 * 60));
    const inn = await punchAt(mk, cv.id, "in", at(p.end, 21 * 60));
    const out = await punchAt(mk, cv.id, "out", at(m.time.addDays(p.end, 1), 2 * 60));
    const first = await tc.timesheetView(mk.id, p.start, [cv.id]);
    expect(first.punchIds).toEqual(expect.arrayContaining([before.punchId, inn.punchId, out.punchId]));
    expect(first.shops[0].totals.workedCenti).toBe(400);
    expect(first.shops[0].days.at(-1)!.shifts.map((s) => s.inId)).toEqual([inn.punchId]);
    const second = await tc.timesheetView(mk.id, period(9).start, [cv.id]);
    expect(second.punchIds).toEqual(expect.arrayContaining([inn.punchId, out.punchId]));
    expect(second.punchIds).not.toContain(before.punchId);
    expect(second.shops[0].totals.workedCenti).toBe(200);
  });
});

describe("the front-desk clock", () => {
  it("runs only on a registered device, and five wrong PINs lock that person's PIN", async () => {
    const michelle = await staffBy("michelle@rayz.test");
    const cv = await shop("coralville");
    await signInAs(michelle.id);
    jar.device = undefined;
    const reg = await clockActions.registerDeviceAction({ shopId: cv.id, label: "Test iPad" });
    expect(reg.ok).toBe(true);
    expect(jar.device).toBeTruthy();
    const fd = await staffBy("frontdesk@rayz.test");
    await signInAs(fd.id);
    const team = await m.db.db
      .select({ id: S().staff.id })
      .from(S().staffShops)
      .innerJoin(S().staff, eq(S().staff.id, S().staffShops.staffId))
      .where(m.drizzle.and(eq(S().staffShops.shopId, cv.id), eq(S().staff.kind, "person"), eq(S().staff.active, true)));
    const [a, b] = team.map((t) => t.id).filter((id) => id !== fd.id && id !== michelle.id);
    for (let i = 0; i < 4; i++) expect(await clockActions.kioskStatusAction({ staffId: a, pin: "0000" })).toEqual({ ok: false, error: "Wrong PIN." });
    const fifth = await clockActions.kioskStatusAction({ staffId: a, pin: "0000" });
    expect(!fifth.ok && fifth.error).toMatch(/locked for 5 minutes/);
    const locked = await clockActions.kioskStatusAction({ staffId: a, pin: "2468" });
    expect(!locked.ok && locked.error).toMatch(/Too many wrong PINs/);

    const status = await clockActions.kioskStatusAction({ staffId: b, pin: "2468" });
    expect(status.ok).toBe(true);
    const next = status.ok ? status.data.next[0] : "in";
    let punched = await clockActions.kioskPunchAction({ staffId: b, pin: "2468", type: next, photo: null });
    if (punched.ok && punched.data.kind === "confirm") punched = await clockActions.kioskPunchAction({ staffId: b, pin: "2468", type: next, photo: null, confirmTimeOff: true });
    expect(punched.ok).toBe(true);
    const id = punched.ok && punched.data.kind === "done" ? punched.data.punchId : "";
    const [row] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, id));
    expect(row).toMatchObject({ staffId: b, shopId: cv.id, source: "kiosk", method: "device" });
    expect(row.deviceId).toBe(reg.ok ? reg.data : null);

    const moline = await staffBy("manager.moline@rayz.test");
    await signInAs(moline.id);
    const elsewhere = await clockActions.kioskStatusAction({ staffId: b, pin: "2468" });
    expect(!elsewhere.ok && elsewhere.error).toMatch(/isn't registered as one of your shops'/);
    jar.device = undefined;
  });

  it("a phone punch records the address it came from", async () => {
    const kat = await staffBy("kat@rayz.test");
    await signInAs(kat.id);
    jar.ip = "198.51.100.23";
    const mo = await shop("moline");
    const s = await tc.clockState(kat.id);
    const shopId = s.shift?.shopId ?? mo.id;
    let r = await clockActions.punchAction({ shopId, type: s.next[0], gps: null, photo: null });
    if (r.ok && r.data.kind === "confirm") r = await clockActions.punchAction({ shopId, type: s.next[0], gps: null, photo: null, confirmTimeOff: true });
    expect(r.ok).toBe(true);
    const id = r.ok && r.data.kind === "done" ? r.data.punchId : "";
    const [row] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, id));
    expect(row).toMatchObject({ ip: "198.51.100.23", source: "self" });
    jar.ip = undefined;
  });
});

describe("manager edits", () => {
  it("need a reason, are kept with before and after in the edit log and the audit log, and clear approvals", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const michelle = await staffBy("michelle@rayz.test");
    const cv = await shop("coralville");
    const p = period(4);
    const day = m.time.addDays(p.start, 1);
    const inn = await punchAt(mk, cv.id, "in", at(day, 9 * 60));
    const out = await punchAt(mk, cv.id, "out", at(day, 15 * 60));
    await tc.approveOwn(mk.id, cv.id, p.start, actorOf(mk), at(day, 16 * 60));
    const e = editorOf(michelle, [cv.id]);
    const now = at(m.time.addDays(day, 1), 9 * 60);

    await expect(tc.editPunch(e, out.punchId, { at: at(day, 17 * 60) }, "  ", now)).rejects.toThrow(/Say why/);
    await tc.editPunch(e, out.punchId, { at: at(day, 17 * 60) }, "Stayed late for a walk-in; forgot to clock out", now);
    expect(minutesOf(await entriesOf(inn.punchId))).toBe(8 * 60);
    const [log] = await m.db.db.select().from(S().timePunchEdits).where(eq(S().timePunchEdits.punchId, out.punchId));
    expect(log).toMatchObject({ action: "edit", editedBy: michelle.id, reason: "Stayed late for a walk-in; forgot to clock out" });
    expect(log.before).toMatchObject({ type: "out", at: at(day, 15 * 60).toISOString() });
    expect(log.after).toMatchObject({ type: "out", at: at(day, 17 * 60).toISOString() });
    const [aud] = await m.db.db
      .select()
      .from(S().auditLog)
      .where(m.drizzle.and(eq(S().auditLog.action, "timeclock.punch_edit"), eq(S().auditLog.entityId, out.punchId)));
    expect(aud.details).toMatchObject({ before: log.before, after: log.after, reason: log.reason, approvalsCleared: 1 });
    const [sheet] = await m.db.db.select().from(S().timesheets).where(m.drizzle.and(eq(S().timesheets.staffId, mk.id), eq(S().timesheets.periodStart, p.start)));
    expect(sheet.employeeApprovedAt).toBeNull();

    await tc.voidPunch(e, out.punchId, "Wrong day", now);
    expect(await entriesOf(inn.punchId)).toEqual([]);
    await tc.addPunch(e, { staffId: mk.id, shopId: cv.id, type: "out", at: at(day, 16 * 60) }, "Clock-out from the paper log", now);
    expect(minutesOf(await entriesOf(inn.punchId))).toBe(7 * 60);
    const view = await tc.timesheetView(mk.id, p.start, [cv.id]);
    expect(view.edits.map((x) => x.action)).toEqual(["edit", "void", "add"]);
    expect(view.shops[0].totals.workedCenti).toBe(700);

    await expect(m.db.db.update(S().timePunchEdits).set({ reason: "rewritten" }).where(eq(S().timePunchEdits.id, log.id))).rejects.toThrow();
    await expect(m.db.db.delete(S().timePunchEdits).where(eq(S().timePunchEdits.id, log.id))).rejects.toThrow();
  });

  it("nobody edits their own punches (except the owner), or punches at a shop outside their access", async () => {
    const michelle = await staffBy("michelle@rayz.test");
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const day = m.time.addDays(period(4).start, 2);
    const mine = await punchAt(michelle, cv.id, "in", at(day, 9 * 60));
    const now = at(day, 12 * 60);
    await expect(tc.editPunch(editorOf(michelle, [cv.id]), mine.punchId, { at: at(day, 8 * 60) }, "Early start", now)).rejects.toThrow(/your own punches/);
    await signInAs(michelle.id);
    const viaAction = await sheetActions.voidPunchAction({ punchId: mine.punchId, reason: "Mistake" });
    expect(!viaAction.ok && viaAction.error).toMatch(/your own punches/);
    await punchAt(michelle, cv.id, "out", at(day, 11 * 60));
    const moline = await staffBy("manager.moline@rayz.test");
    const theirs = await punchAt(mk, cv.id, "in", at(day, 13 * 60));
    await expect(tc.editPunch(editorOf(moline, [(await shop("moline")).id]), theirs.punchId, { at: at(day, 12 * 60) }, "Fix", now)).rejects.toThrow(/outside your access/);
    await punchAt(mk, cv.id, "out", at(day, 14 * 60));
  });
});

describe("approvals and the period lock", () => {
  it("employee then manager, missed punches first, and a locked period takes no punches, edits or hours", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const michelle = await staffBy("michelle@rayz.test");
    const cv = await shop("coralville");
    const p = period(5);
    const d1 = m.time.addDays(p.start, 1);
    const d2 = m.time.addDays(p.start, 2);
    await punchAt(mk, cv.id, "in", at(d1, 9 * 60));
    await punchAt(mk, cv.id, "out", at(d1, 17 * 60));
    const open = await punchAt(mk, cv.id, "in", at(d2, 9 * 60));
    const inPeriod = at(m.time.addDays(p.start, 4), 12 * 60);
    const e = editorOf(michelle, [cv.id]);

    await expect(tc.approveOwn(mk.id, cv.id, p.start, actorOf(mk), inPeriod)).rejects.toThrow(/Fix the missed punches first/);
    await tc.addPunch(e, { staffId: mk.id, shopId: cv.id, type: "out", at: at(d2, 13 * 60) }, "Forgot to clock out", inPeriod);
    expect(minutesOf(await entriesOf(open.punchId))).toBe(4 * 60);
    await expect(tc.approveAsManager(e, mk.id, cv.id, p.start, null, inPeriod)).rejects.toThrow(/haven't signed off/);
    await tc.approveOwn(mk.id, cv.id, p.start, actorOf(mk), inPeriod);
    await expect(tc.approveAsManager(e, michelle.id, cv.id, p.start, null, inPeriod)).rejects.toThrow(/your own timesheet/);
    await tc.approveAsManager(e, mk.id, cv.id, p.start, null, inPeriod);
    await expect(tc.lockPeriod(e, cv.id, p.start, inPeriod)).rejects.toThrow(/Lock it after it ends/);
    const after = at(m.time.addDays(p.end, 1), 9 * 60);
    await tc.lockPeriod(e, cv.id, p.start, after);
    expect((await tc.timesheetList(p.start, [cv.id])).locks[cv.id]).toBeTruthy();

    await expect(punchAt(mk, cv.id, "in", at(m.time.addDays(p.start, 6), 9 * 60))).rejects.toThrow(/locked/);
    await expect(tc.addPunch(e, { staffId: mk.id, shopId: cv.id, type: "in", at: at(d1, 18 * 60) }, "Second shift", after)).rejects.toThrow(/locked/);
    await expect(tc.voidPunch(e, open.punchId, "No", after)).rejects.toThrow(/locked/);
    const added = await run.addTimeEntries([{ staffId: mk.id, shopId: cv.id, kind: "worked", startsAt: at(d1, 18 * 60), endsAt: at(d1, 19 * 60) }], actorOf(michelle));
    expect(added).toEqual({ error: "that pay period is locked." });
    await expect(tc.approveOwn(mk.id, cv.id, p.start, actorOf(mk), after)).rejects.toThrow(/already locked/);

    await expect(tc.unlockPeriod(e, cv.id, p.start, "")).rejects.toThrow(/Say why/);
    await tc.unlockPeriod(e, cv.id, p.start, "Late tip correction");
    expect((await tc.timesheetList(p.start, [cv.id])).locks[cv.id]).toBeUndefined();
    const unlocks = await m.db.db.select().from(S().auditLog).where(eq(S().auditLog.action, "timesheet.unlock"));
    expect(unlocks.at(-1)?.details).toMatchObject({ periodStart: p.start, reason: "Late tip correction" });
  });
});

describe("payroll export", () => {
  it("regular and overtime per person and shop add up to the totals row, and the download is logged without the numbers", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const p = period(6);
    for (let i = 1; i <= 5; i++) {
      const day = m.time.addDays(p.start, i);
      await punchAt(mk, cv.id, "in", at(day, 8 * 60));
      await punchAt(mk, cv.id, "break_start", at(day, 12 * 60));
      await punchAt(mk, cv.id, "break_end", at(day, 12 * 60 + 15));
      await punchAt(mk, cv.id, "out", at(day, 17 * 60 + 15));
    }
    const { lines, draft } = await tx.exportData(p.start, [cv.id]);
    expect(draft).toBe(true);
    const line = lines.find((l) => l.staffId === mk.id)!;
    expect(line).toMatchObject({ shopId: cv.id, regularCenti: 4000, otCenti: 625, breakCenti: 125, unpaidBreakCenti: 0 });
    const csv = (await import("@/domain/time-clock")).genericCsv(lines).trim().split("\r\n");
    const header = csv[0].split(",");
    const total = csv.at(-1)!.split(",");
    const sum = (col: string) => lines.reduce((a, l) => a + Number(((l as unknown as Record<string, number>)[col] ?? 0) / 100), 0).toFixed(2);
    expect(total[0]).toBe("TOTAL");
    expect(total[header.indexOf("Regular hours")]).toBe(sum("regularCenti"));
    expect(total[header.indexOf("Overtime hours")]).toBe(sum("otCenti"));

    const owner = await staffBy("owner@rayz.test");
    await signInAs(owner.id);
    const res = await get(exportRoute.GET, `/admin/timesheets/export?period=${p.start}&format=isolved&shop=${cv.id}`);
    expect(res.status).toBe(200);
    const rows = res.text.trim().split("\r\n");
    expect(rows[0]).toBe("Key,Name,Location,E_Regular_Hours,E_Overtime 1.5_Hours,E_Cash Tips Recd_Dollars,E_Charge Tips_Dollars,E_Service Sales_Dollars,E_Product Sales_Dollars");
    const profile = (await m.db.db.select().from(S().payrollProfiles).where(eq(S().payrollProfiles.staffId, mk.id)))[0];
    const mine = rows.find((r) => r.startsWith(`${profile.employeeNumber},`))!;
    expect(mine.split(",").slice(3, 5)).toEqual(["40.00", "6.25"]);
    const [aud] = await m.db.db.select().from(S().auditLog).where(eq(S().auditLog.action, "payroll.export_csv"));
    expect(aud.details).toMatchObject({ format: "isolved", draft: true });
    expect(JSON.stringify(aud.details)).not.toContain(profile.employeeNumber!);

    const fd = await staffBy("frontdesk@rayz.test");
    await signInAs(fd.id);
    expect((await get(exportRoute.GET, `/admin/timesheets/export?period=${p.start}&format=isolved`)).status).toBe(403);
    const michelle = await staffBy("michelle@rayz.test");
    await signInAs(michelle.id);
    expect((await get(exportRoute.GET, `/admin/timesheets/export?period=${p.start}`)).status).toBe(403);
  });
});

describe("alerts", () => {
  it("a forgotten clock-out is flagged once and the shop's managers are emailed", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const day = m.time.addDays(period(7).start, 1);
    const inn = await punchAt(mk, cv.id, "in", at(day, 9 * 60));
    const missed = async (now: Date) => (await tc.attendanceRows([cv.id], day, day, [mk.id], now)).reduce((a, r) => a + r.missed, 0);
    expect(await missed(at(day, 12 * 60))).toBe(0);
    const later = at(day, 23 * 60);
    expect(await tc.flagForgottenClockOuts(later)).toBe(1);
    expect(await missed(later)).toBe(1);
    expect(await tc.flagForgottenClockOuts(later)).toBe(0);
    const [p] = await m.db.db.select().from(S().timePunches).where(eq(S().timePunches.id, inn.punchId));
    expect(p.flags).toContain("forgot_out");
    const jobs = await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.kind, "clock_forgot_out"));
    expect(jobs.map((j) => j.to)).toContain("michelle@rayz.test");
    expect(jobs.map((j) => j.to)).not.toContain("makenna@rayz.test");
    const facts = await tc.clockAlertFacts([cv.id], later);
    expect(facts.forgotten.map((f) => f.id)).toContain(inn.punchId);
    const e = editorOf(await staffBy("michelle@rayz.test"), [cv.id]);
    await tc.addPunch(e, { staffId: mk.id, shopId: cv.id, type: "out", at: at(day, 17 * 60) }, "Forgot", later);
    expect((await tc.clockAlertFacts([cv.id], later)).forgotten.map((f) => f.id)).not.toContain(inn.punchId);
  });

  it("crossing the 32-hour rolling average is recorded once and managers are told", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const now = at(m.time.addDays(m.time.todayLocal(), 300), 3 * 60 + 5);
    const ws = (await import("@/domain/payroll/overtime")).weekStartOf(m.time.localDateOf(now));
    const weeks = [1, 2, 3, 4].map((k) => m.time.addDays(ws, -7 * k));
    const rows = weeks.flatMap((w) => [1, 2, 3, 4, 5].map((d) => ({ staffId: mk.id, shopId: cv.id, kind: "worked" as const, source: "manual" as const, startsAt: at(m.time.addDays(w, d), 9 * 60), endsAt: at(m.time.addDays(w, d), 16 * 60) })));
    await m.db.db.insert(S().timeEntries).values(rows);
    expect(await tc.checkFtCrossings(now)).toBeGreaterThanOrEqual(1);
    const [change] = await m.db.db.select().from(S().ftStatusChanges).where(eq(S().ftStatusChanges.staffId, mk.id));
    expect(change).toMatchObject({ fromStatus: "part_time", toStatus: "full_time", weekStart: weeks[0], windowWeeks: 4 });
    expect(Number(change.averageHours)).toBe(35);
    const again = await tc.checkFtCrossings(now);
    expect((await m.db.db.select().from(S().ftStatusChanges).where(eq(S().ftStatusChanges.staffId, mk.id))).length).toBe(1);
    expect(again).toBe(0);
    const jobs = await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.kind, "ft_status_change"));
    expect(jobs.map((j) => j.to)).toContain("michelle@rayz.test");
    const ft = await tc.ftOverview([mk.id], m.time.localDateOf(now), 4);
    expect(ft.rows[0]).toMatchObject({ average: 35, status: "full_time" });
    const eight = await tc.ftOverview([mk.id], m.time.localDateOf(now), 8);
    expect(eight.rows[0]).toMatchObject({ average: 17.5, status: "part_time" });
  });
});

describe("pages and reports", () => {
  it("a barber sees their own timesheet only; managers see the shop's", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const michelle = await staffBy("michelle@rayz.test");
    await signInAs(mk.id);
    expect((await open("/admin/timesheets")).kind).toBe("redirect");
    expect((await open("/admin/timesheets/[staffId]", { staffId: mk.id })).kind).toBe("ok");
    expect((await open("/admin/timesheets/[staffId]", { staffId: michelle.id })).kind).toBe("404");
    expect((await open("/admin/clock")).kind).toBe("ok");
    expect((await open("/admin/time-clock")).kind).toBe("denied");
    await signInAs(michelle.id);
    const list = await open("/admin/timesheets", {}, { period: period(4).start });
    expect(list.kind).toBe("ok");
    expect(found(list.text ?? "", ["Makenna", "Lock the period", "Full time and part time"])).toEqual(["Makenna", "Lock the period", "Full time and part time"]);
    expect(list.text).not.toContain("Payroll export");
    const sheet = await open("/admin/timesheets/[staffId]", { staffId: mk.id }, { period: period(4).start });
    expect(sheet.text).toContain("Clock-out from the paper log");
    const moline = await staffBy("manager.moline@rayz.test");
    await signInAs(moline.id);
    expect((await open("/admin/timesheets/[staffId]", { staffId: mk.id })).kind).toBe("404");
  });

  it("the labor report shows rates and cost only with the pay rates permission", async () => {
    const cv = await shop("coralville");
    const p = period(6);
    const q = { shop: cv.id, from: p.start, to: p.end };
    await signInAs((await staffBy("michelle@rayz.test")).id);
    const mgr = await open("/admin/reports/labor", {}, q);
    expect(mgr.kind).toBe("ok");
    expect(mgr.text).toContain("Labor hours");
    expect(found(mgr.text ?? "", ["Hourly rate", "Labor cost", "Labor % of sales"])).toEqual([]);
    await signInAs((await staffBy("owner@rayz.test")).id);
    const own = await open("/admin/reports/labor", {}, q);
    expect(found(own.text ?? "", ["Hourly rate", "Labor cost", "Labor % of sales"])).toEqual(["Hourly rate", "Labor cost", "Labor % of sales"]);
    const rows = await tx.laborRows([cv.id], p.start, p.end, [(await staffBy("makenna@rayz.test")).id]);
    expect(rows[0]).toMatchObject({ workedMin: 46.25 * 60, otMin: 6.25 * 60, rate: 16 });
    expect(rows[0].regularCost).toBe(64000);
    expect(rows[0].otCost).toBe(15000);
  });
});
