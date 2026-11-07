/**
 * iSolved's Payroll Run Schedule against a real database: the seeded schedule (core_0149) is every
 * pay group's official pay periods: iSolved's numbers, run dates and check dates, the 12/13/2026
 * holiday shift, Dubuque's own numbering and its end on 10/2/2027. The payroll date presets follow
 * it, a period past a group's schedule is flagged, and an admin extends the schedule past its end.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { open } from "./render";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let periods: typeof import("@/server/payroll/periods");
let actions: typeof import("@/app/admin/payroll/actions");
let cal: typeof import("@/domain/payroll/calendar");
let sched: typeof import("@/domain/payroll/pay-schedule");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const fx = { owner: "", makenna: "" };
const file = () => sched.parseScheduleCsv(readFileSync(join(__dirname, "../../drizzle/seed/isolved-pay-calendar.csv"), "utf8"));

const groups = () => run.ensurePayGroups();
const groupOf = async (shop: string) => (await groups()).find((g) => norm(g.shop) === shop)!;
const stored = (payGroupId: string) => m.db.db.select().from(m.schema.payPeriodDates).where(eq(m.schema.payPeriodDates.payGroupId, payGroupId));
const logs = (action: string) => m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action));
const removeAdded = () => m.db.db.delete(m.schema.paySchedulePeriods).where(eq(m.schema.paySchedulePeriods.source, "admin"));

const SHARED: Record<string, { group: string; code: string | null }> = {
  rockisland: { group: "B - Rock Island", code: "B" },
  moline: { group: "C - Moline", code: "C" },
  utica: { group: "D - Utica", code: "D" },
  kimberly: { group: "E - Kimberly", code: "E" },
  silvis: { group: "F - Silvis", code: "F" },
  coralville: { group: "G - Coralville", code: "G" },
  leclaire: { group: "LeClaire", code: null },
};

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  periods = await import("@/server/payroll/periods");
  actions = await import("@/app/admin/payroll/actions");
  cal = await import("@/domain/payroll/calendar");
  sched = await import("@/domain/payroll/pay-schedule");
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!.id;
  fx.makenna = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!.id;
}, 240_000);

afterAll(async () => {
  if (m) await removeAdded();
  await m?.db.closeDb();
});

describe("the seeded schedule", () => {
  it("is iSolved's 243 periods, every one 14 days Sunday to Saturday with no gaps or overlaps", async () => {
    const rows = await m.db.db.select().from(m.schema.paySchedulePeriods);
    expect(rows).toHaveLength(243);
    expect(rows.every((r) => r.source === "isolved")).toBe(true);
    const asRows = rows.map((r) => ({ group: r.isolvedGroup, number: r.periodNumber, start: r.periodStart, end: r.periodEnd, runDate: r.runDate, checkDate: r.checkDate, note: r.note }));
    expect(sched.scheduleProblems(asRows)).toEqual([]);
    const key = (r: { group: string; start: string }) => `${r.group}|${r.start}`;
    expect(asRows.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(file().sort((a, b) => key(a).localeCompare(key(b))));
  });

  it("refuses a period that isn't 14 days from a Sunday, or overlaps one already there", async () => {
    const base = { isolvedGroup: "Dubuque", groupKey: "dubuque", periodNumber: 21, runDate: "2027-10-20", checkDate: "2027-10-22" };
    await expect(m.db.db.insert(m.schema.paySchedulePeriods).values({ ...base, periodStart: "2027-10-04", periodEnd: "2027-10-17" })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.paySchedulePeriods).values({ ...base, periodStart: "2027-10-03", periodEnd: "2027-10-09" })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.paySchedulePeriods).values({ ...base, periodStart: "2027-09-26", periodEnd: "2027-10-09", runDate: "2027-10-13", checkDate: "2027-10-15" })).rejects.toThrow();
  });
});

describe("every pay group takes its schedule", () => {
  it("each shop is matched to its iSolved pay group, and gets iSolved's code (B to G; LeClaire and Dubuque have none)", async () => {
    const all = await groups();
    for (const [shop, want] of Object.entries(SHARED)) {
      const g = all.find((x) => norm(x.shop) === shop)!;
      expect(g.schedule, shop).toMatchObject({ isolvedGroup: want.group, from: "2026-10-18", through: "2027-12-25", periods: 31, added: 0 });
      expect(g.code, shop).toBe(want.code);
      expect(g.calendar.scheduledThrough).toBe("2027-12-25");
    }
    const dbq = all.find((x) => norm(x.shop) === "dubuque")!;
    expect(dbq.schedule).toMatchObject({ isolvedGroup: "Dubuque", from: "2026-10-04", through: "2027-10-02", periods: 26 });
    expect(dbq.code).toBeNull();
    const synced = await logs("payroll.schedule_synced");
    expect(synced.map((l) => l.entityId).sort()).toEqual(all.map((g) => g.id).sort());
    expect(synced.every((l) => l.actorLabel === "iSolved schedule")).toBe(true);
  });

  it("every period's number, due date (iSolved's run date) and check date are on record, the holiday with its reason", async () => {
    const rows = file();
    for (const shop of [...Object.keys(SHARED), "dubuque"]) {
      const g = await groupOf(shop);
      const mine = rows.filter((r) => sched.scheduleKey(r.group) === shop);
      const have = new Map((await stored(g.id)).map((r) => [r.periodStart, r]));
      for (const r of mine) {
        expect(have.get(r.start), `${shop} ${r.start}`).toMatchObject({ periodEnd: r.end, periodNumber: r.number, submitBy: r.runDate, checkDate: r.checkDate, reason: r.note ? expect.stringMatching(/^iSolved schedule: /) : null });
        expect(cal.periodStarting(g.calendar, r.start), `${shop} ${r.start}`).toMatchObject({ end: r.end, number: r.number, checkDate: r.checkDate, submitBy: r.runDate, beyondSchedule: false });
      }
    }
    const moline = await groupOf("moline");
    expect(cal.periodStarting(moline.calendar, "2026-12-13")).toMatchObject({ number: 27, submitBy: "2026-12-29", checkDate: "2026-12-31", datesMoved: true });
    expect(cal.periodStarting(moline.calendar, "2026-12-27")).toMatchObject({ number: 1, checkDate: "2027-01-15" });
    expect(cal.periodStarting((await groupOf("dubuque")).calendar, "2026-12-13")).toMatchObject({ number: 6, checkDate: "2026-12-31" });
  });

  it("taking it again changes nothing", async () => {
    const before = (await logs("payroll.schedule_synced")).length;
    const g = await groupOf("moline");
    const rows = await stored(g.id);
    await groups();
    expect((await logs("payroll.schedule_synced")).length).toBe(before);
    expect((await stored(g.id)).map((r) => r.updatedAt.getTime()).sort()).toEqual(rows.map((r) => r.updatedAt.getTime()).sort());
  });

  it("a pay group numbered off iSolved's is put back on the schedule's numbers", async () => {
    const g = await groupOf("kimberly");
    await m.db.db.update(m.schema.payGroups).set({ anchorStart: "2026-10-04", anchorNumber: 5, scheduleSyncedAt: null }).where(eq(m.schema.payGroups.id, g.id));
    const k = await groupOf("kimberly");
    expect(k.calendar).toMatchObject({ anchorStart: "2026-10-04", anchorNumber: 22 });
    expect(cal.periodStarting(k.calendar, "2026-10-18")!.number).toBe(23);
    const [log] = (await logs("payroll.schedule_synced")).filter((l) => l.entityId === g.id).sort((a, b) => b.at.getTime() - a.at.getTime());
    expect(log.details).toMatchObject({ realigned: { from: { anchorNumber: 5 }, to: { anchorStart: "2026-10-04", anchorNumber: 22 } } });
    const picker = await periods.payPeriodPicker([k.shopId, (await groupOf("moline")).shopId], "2026-10-28");
    expect(picker).toHaveLength(1);
  });
});

describe("the payroll date presets and defaults are iSolved's periods", () => {
  it("this period is 10/18–10/31 (period 23, check 11/6; Dubuque's 2), and the picker numbers by the schedule", async () => {
    const recent = await periods.recentPayPeriods("2026-10-28");
    expect(recent[0]).toMatchObject({ start: "2026-10-18", end: "2026-10-31", current: true });
    const moline = await groupOf("moline");
    const dbq = await groupOf("dubuque");
    expect(recent[0].groups.find((x) => x.shopId === moline.shopId)).toMatchObject({ number: 23, checkDate: "2026-11-06" });
    expect(recent[0].groups.find((x) => x.shopId === dbq.shopId)).toMatchObject({ number: 2, checkDate: "2026-11-06" });
    expect((await periods.payPeriodPresets("2026-10-28"))[0]).toMatchObject({ id: "pp:2026-10-18_2026-10-31", label: expect.stringMatching(/^This period/) });

    const picker = await periods.payPeriodPicker([moline.shopId, dbq.shopId], "2027-01-05");
    const shared = picker.find((p) => p.shopIds.includes(moline.shopId))!;
    expect(shared.periods.find((p) => p.start === "2026-12-13")).toMatchObject({ number: 27, checkDate: "2026-12-31" });
    expect(shared.periods[0]).toMatchObject({ start: "2026-12-27", number: 1, current: true });
    const own = picker.find((p) => p.shopIds.includes(dbq.shopId))!;
    expect(own.periods.find((p) => p.start === "2026-12-13")).toMatchObject({ number: 6 });
    expect((await periods.calendarForShops([dbq.shopId])).anchorNumber).toBe(1);
  });
});

describe("past the end of the schedule", () => {
  const next = { start: "2027-10-03", end: "2027-10-16" };

  it("Dubuque's period after 10/2/2027 is flagged on the Payroll Report; the shared calendar's isn't", async () => {
    const view = (await run.buildPayroll(next.start, next.end))!;
    const dbq = await groupOf("dubuque");
    const moline = await groupOf("moline");
    expect(view.blocks.find((b) => b.shopId === dbq.shopId)).toMatchObject({ scheduledThrough: "2027-10-02", period: { number: 21, beyondSchedule: true } });
    expect(view.blocks.find((b) => b.shopId === moline.shopId)).toMatchObject({ scheduledThrough: "2027-12-25", period: { beyondSchedule: false } });
    const flags = view.anomalies.filter((a) => a.kind === "past_schedule");
    expect(flags.map((a) => a.shopId)).toEqual([dbq.shopId]);
    expect(flags[0].message).toMatch(/past the end of iSolved's pay schedule for Dubuque \(its last scheduled period ends Sat Oct 2, 2027\)/);
  });

  it("only someone who runs payroll can extend it", async () => {
    const dbq = await groupOf("dubuque");
    await signInAs(fx.makenna);
    expect(await actions.extendPayScheduleAction({ payGroupIds: [dbq.id], through: "2027-12-25" })).toMatchObject({ ok: false });
    expect((await groupOf("dubuque")).schedule!.through).toBe("2027-10-02");
  });

  it("an admin extends Dubuque through the end of 2027 on its pattern: periods 21 to 26, written to its period dates and audited", async () => {
    const dbq = await groupOf("dubuque");
    await signInAs(fx.owner);
    expect(await actions.extendPayScheduleAction({ payGroupIds: [dbq.id], through: "2027-10-02" })).toMatchObject({ ok: false, error: expect.stringMatching(/already runs through Sat Oct 2, 2027/) });
    expect(await actions.extendPayScheduleAction({ payGroupIds: [dbq.id], through: "2027-12-25" })).toMatchObject({ ok: true });
    const after = await groupOf("dubuque");
    expect(after.schedule).toMatchObject({ through: "2027-12-25", periods: 32, added: 6 });
    const added = await m.db.db.select().from(m.schema.paySchedulePeriods).where(and(eq(m.schema.paySchedulePeriods.groupKey, "dubuque"), eq(m.schema.paySchedulePeriods.source, "admin")));
    expect(added.map((r) => r.periodNumber).sort((a, b) => a - b)).toEqual([21, 22, 23, 24, 25, 26]);
    expect(added.every((r) => r.addedBy === fx.owner)).toBe(true);
    const have = new Map((await stored(after.id)).map((r) => [r.periodStart, r]));
    expect(have.get("2027-10-03")).toMatchObject({ periodNumber: 21, submitBy: "2027-10-20", checkDate: "2027-10-22", reason: null });
    expect(cal.periodStarting(after.calendar, next.start)).toMatchObject({ number: 21, beyondSchedule: false });
    const [log] = await logs("payroll.schedule_extended");
    expect(log).toMatchObject({ entityId: dbq.id, actorStaffId: fx.owner, details: { isolvedGroup: "Dubuque", periods: 6, from: "2027-10-03", through: "2027-12-25", numbers: "21–26" } });
    const view = (await run.buildPayroll(next.start, next.end))!;
    expect(view.anomalies.filter((a) => a.kind === "past_schedule")).toEqual([]);
  });

  it("the setup page lists each pay group's schedule", async () => {
    await signInAs(fx.owner);
    const page = await open("/admin/payroll/setup");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("iSolved pay schedule");
    expect(page.text).toContain("B - Rock Island");
    expect(page.text).toContain("2027-12-25");
  });
});
