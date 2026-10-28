/**
 * Payroll's hours come from the time clock (Charles: the basic clock ships at launch). The Payroll
 * Report flags missed punches, timesheets no manager has approved, service sales on a day with no
 * hours there, and hours typed in instead of clocked; approve and lock waits until each shop's
 * timesheets are locked for the period. With the setting off, unlocked hours are only a flag.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let run: typeof import("@/server/payroll/run");
let pay: typeof import("@/domain/payroll");

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  run = await import("@/server/payroll/run");
  pay = await import("@/domain/payroll");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, email) }))!;
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, slug) }))!;
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
const period = (k: number) => pay.payPeriodByIndex(pay.payPeriodFor(m.time.todayLocal()).index + k);
const actorOf = (s: { id: string; displayLabel: string }) => ({ staffId: s.id, label: s.displayLabel });
const editorOf = (s: { id: string; displayLabel: string }, shopIds: string[]) => ({ actor: actorOf(s), staffId: s.id, isOwner: false, shopIds });
const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };
const cash = { method: "cash" as const, cashTenderedCents: null };

async function punchAt(staff: { id: string; displayLabel: string }, shopId: string, type: "in" | "out", now: Date) {
  const r = await tc.punch({ staffId: staff.id, shopId, type, source: "self", evidence: { deviceShopId: shopId, ip: null, gps: HERE }, deviceId: null, photo: null, actor: actorOf(staff), now, nonce: { id: crypto.randomUUID(), at: now } });
  if (r.kind !== "done") throw new Error(r.message);
  return r;
}

async function serviceSale(shopId: string, staffId: string, date: string) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 0, tender: cash, actor, now: at(date, 12 * 60) });
  await m.db.db.update(S().sales).set({ businessDate: date }).where(eq(S().sales.id, sale.id));
  await m.db.db.update(S().payments).set({ businessDate: date }).where(eq(S().payments.saleId, sale.id));
}

const CLOCK_KINDS = new Set(["missed_punch", "timesheet_not_approved", "hours_not_locked", "sales_day_without_hours", "hours_not_from_clock", "sales_without_hours"]);
const flagsOf = (v: Awaited<ReturnType<typeof run.buildPayroll>>, staffId: string, shopId: string) => v!.anomalies.filter((a) => a.staffId === staffId && a.shopId === shopId && CLOCK_KINDS.has(a.kind));

describe("hours come from the time clock", () => {
  it("flags missed punches, unapproved timesheets, sales on a day with no hours and typed hours, and holds approve and lock until the hours are locked", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const michelle = await staffBy("michelle@rayz.test");
    const cv = await shop("coralville");
    const p = period(8);
    const [d1, d2, d3, d4] = [1, 2, 3, 4].map((i) => m.time.addDays(p.start, i));
    await punchAt(mk, cv.id, "in", at(d1, 9 * 60));
    await punchAt(mk, cv.id, "out", at(d1, 17 * 60));
    await punchAt(mk, cv.id, "in", at(d2, 9 * 60));
    await serviceSale(cv.id, mk.id, d3);
    expect(await run.addTimeEntries([{ staffId: mk.id, shopId: cv.id, kind: "worked", startsAt: at(d4, 10 * 60), endsAt: at(d4, 12 * 60) }], actorOf(michelle))).toEqual({ added: 1 });

    const v = (await run.buildPayroll(p.start, p.end))!;
    expect(v.settings.hoursFromClock).toBe(true);
    const flags = flagsOf(v, mk.id, cv.id);
    expect(flags.map((a) => a.kind).sort()).toEqual(["hours_not_from_clock", "missed_punch", "sales_day_without_hours", "timesheet_not_approved"]);
    expect(flags.find((a) => a.kind === "missed_punch")!.message).toMatch(/1 missed punch: no clock-out on /);
    expect(flags.find((a) => a.kind === "sales_day_without_hours")!.message).toContain(m.time.formatDate(d3, "EEE MMM d"));
    expect(flags.find((a) => a.kind === "hours_not_from_clock")!.message).toMatch(/2h typed in or imported/);
    expect(v.anomalies.some((a) => a.kind === "hours_not_locked")).toBe(false);
    const open = v.hoursOpen.find((o) => o.shopId === cv.id)!;
    expect(open).toMatchObject({ shop: "Coralville", periods: [{ start: p.start, end: p.end }] });
    expect(open.waiting).toContain(mk.displayLabel);

    const others = v.blocks.map((b) => b.shopId).filter((id) => id !== cv.id);
    await lockHours(p.start, p.end, others);
    const refused = await run.approveAndLock(p.start, p.end, actor);
    expect(refused).toEqual({ error: expect.stringMatching(/Hours come from the time clock, and they aren't locked yet at Coralville\. .*1 timesheet still waiting/) });
    expect(await m.db.db.select().from(S().payrollRuns)).toEqual([]);

    const e = editorOf(michelle, [cv.id]);
    const inPeriod = at(m.time.addDays(p.start, 6), 12 * 60);
    await tc.addPunch(e, { staffId: mk.id, shopId: cv.id, type: "out", at: at(d2, 13 * 60) }, "Forgot to clock out", inPeriod);
    await tc.approveOwn(mk.id, cv.id, p.start, actorOf(mk), inPeriod);
    await tc.approveAsManager(e, mk.id, cv.id, p.start, null, inPeriod);
    await tc.lockPeriod(e, cv.id, p.start, at(m.time.addDays(p.end, 1), 9 * 60));

    const after = (await run.buildPayroll(p.start, p.end))!;
    expect(after.hoursOpen).toEqual([]);
    expect(flagsOf(after, mk.id, cv.id).map((a) => a.kind).sort()).toEqual(["hours_not_from_clock", "sales_day_without_hours"]);
    expect(after.mismatches).toEqual([]);
    expect(await run.approveAndLock(p.start, p.end, actor)).toEqual({ locked: after.blocks.length });
  });

  it("with the setting off, unlocked hours are a flag rather than a block, and typed hours aren't flagged", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const before = await run.loadSettings();
    await brandSettings({ payroll: { ...before, hoursFromClock: false } });
    try {
      const p = period(10);
      const d1 = m.time.addDays(p.start, 1);
      await punchAt(mk, cv.id, "in", at(d1, 9 * 60));
      await punchAt(mk, cv.id, "out", at(d1, 17 * 60));
      expect(await run.addTimeEntries([{ staffId: mk.id, shopId: cv.id, kind: "worked", startsAt: at(m.time.addDays(d1, 1), 10 * 60), endsAt: at(m.time.addDays(d1, 1), 12 * 60) }], actor)).toEqual({ added: 1 });
      const v = (await run.buildPayroll(p.start, p.end))!;
      expect(v.settings.hoursFromClock).toBe(false);
      expect(v.hoursOpen.map((o) => o.shopId)).toContain(cv.id);
      expect(v.anomalies.find((a) => a.kind === "hours_not_locked" && a.shopId === cv.id)?.message).toMatch(/Coralville: the time clock's hours aren't locked for /);
      expect(flagsOf(v, mk.id, cv.id).map((a) => a.kind)).toEqual(["timesheet_not_approved"]);
      expect(await run.approveAndLock(p.start, p.end, actor)).toEqual({ locked: v.blocks.length });
    } finally {
      await brandSettings({ payroll: before });
    }
  });

  it("the Payroll Report says which shops' hours aren't locked and links to their timesheets", async () => {
    await signInAs((await staffBy("owner@rayz.test")).id);
    const page = await open("/admin/payroll/report");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Hours aren't locked on the time clock: approve and lock is blocked");
    expect(page.text).toMatch(/Hours aren't locked on the time clock at \d+ shops?/);
    expect(page.text).toContain("/admin/timesheets?period=");
  });

  it("flags hours on a Sunday at a shop closed Sundays (G-11); they count in the workweek that starts that Sunday", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const p = period(14);
    const sunday = [...Array(14).keys()].map((i) => m.time.addDays(p.start, i)).find((d) => m.time.weekdayOf(d) === 0)!;
    await punchAt(mk, cv.id, "in", at(sunday, 10 * 60));
    await punchAt(mk, cv.id, "out", at(sunday, 14 * 60));
    const sundayFlags = async () => (await run.buildPayroll(p.start, p.end))!.anomalies.filter((a) => a.kind === "sunday_punch" && a.shopId === cv.id);
    const [flag] = await sundayFlags();
    expect(flag).toMatchObject({ staffId: mk.id });
    expect(flag.message).toContain(`hours on 1 Sunday, when the shop is normally closed: ${m.time.formatDate(sunday, "EEE MMM d")} (4h)`);
    expect(flag.message).toContain("count toward OT in the workweek that starts that Sunday");

    await m.db.db.insert(S().shopHours).values({ shopId: cv.id, weekday: 0, openMin: 10 * 60, closeMin: 14 * 60 });
    try {
      expect(await sundayFlags()).toEqual([]);
    } finally {
      await m.db.db.delete(S().shopHours).where(m.drizzle.and(eq(S().shopHours.shopId, cv.id), eq(S().shopHours.weekday, 0)));
    }
  });

  it("leaves the clock checks out of an employee's own pay", async () => {
    const v = (await run.buildPayroll(period(12).start, period(12).end, { clockChecks: false }))!;
    expect(v.hoursOpen).toEqual([]);
    expect(v.anomalies.filter((a) => a.kind === "hours_not_locked" || a.kind === "timesheet_not_approved")).toEqual([]);
  });
});
