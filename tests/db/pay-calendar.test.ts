/**
 * iSolved's pay calendar against a real database: each shop's pay group carries its iSolved pay group
 * code (B is Rock Island, C is Moline); every period around today has its check date and submit-by
 * date on record; a period's dates move only with a reason, for every shop with that period, never
 * once it's locked; and a calendar change re-writes the stored dates from the new offsets.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { open } from "./render";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");
let cal: typeof import("@/domain/payroll/calendar");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const fx = { owner: "", moline: "", far: { start: "", end: "" }, lockedAt: { start: "", end: "" } };

const groups = () => run.ensurePayGroups();
const groupOf = async (shop: string) => (await groups()).find((g) => norm(g.shop) === shop)!;
const stored = (payGroupId: string, periodStart: string) =>
  m.db.db.query.payPeriodDates.findFirst({ where: and(eq(m.schema.payPeriodDates.payGroupId, payGroupId), eq(m.schema.payPeriodDates.periodStart, periodStart)) });
const saveGroup = async (shop: string, over: Partial<Parameters<typeof run.savePayGroup>[1]> = {}) => {
  const g = await groupOf(shop);
  return run.savePayGroup(g.id, { label: g.label, legalEntity: g.legalEntity, exportTab: g.exportTab, code: g.code, calendar: g.calendar, ...over }, actor);
};

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
  cal = await import("@/domain/payroll/calendar");
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  const g = await groupOf("moline");
  // Pay periods no other test reaches.
  const p = cal.periodOf(g.calendar, "2028-03-08");
  fx.far = { start: p.start, end: p.end };
  const q = cal.periodOf(g.calendar, "2028-05-10");
  fx.lockedAt = { start: q.start, end: q.end };
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("iSolved pay group codes", () => {
  it("Rock Island is B and Moline is C; Ray'z is one legal entity", async () => {
    const all = await groups();
    expect((await groupOf("rockisland")).code).toBe("B");
    expect((await groupOf("moline")).code).toBe("C");
    // The rest come from iSolved's Payroll Run Schedule (tests/db/pay-schedule.test.ts).
    expect(all.filter((g) => g.code).map((g) => g.code).sort()).toEqual(["B", "C", "D", "E", "F", "G"]);
    expect(new Set(all.map((g) => g.legalEntity))).toEqual(new Set(["Ray'z Inc."]));
  });

  it("are saved capitalized, letters or digits only, one shop per code", async () => {
    expect(await saveGroup("moline", { code: "c " })).toBeNull();
    expect((await groupOf("moline")).code).toBe("C");
    expect(await saveGroup("moline", { code: "B" })).toBe("Rock Island already has pay group code B.");
    expect(await saveGroup("moline", { code: "C-1" })).toMatch(/1 to 4 letters or digits/);
    expect(await saveGroup("moline", { code: "ABCDE" })).toMatch(/1 to 4 letters or digits/);
    expect(await saveGroup("moline", { code: "" })).toBeNull();
    expect((await groupOf("moline")).code).toBeNull();
    expect(await saveGroup("moline", { code: "C" })).toBeNull();
    const { code: _, ...noCode } = await groupOf("moline");
    expect(await run.savePayGroup(noCode.id, { label: noCode.label, legalEntity: noCode.legalEntity, exportTab: noCode.exportTab, calendar: noCode.calendar }, actor)).toBeNull();
    expect((await groupOf("moline")).code).toBe("C");
    const [log] = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(and(eq(m.schema.auditLog.action, "payroll.pay_group"), eq(m.schema.auditLog.entityId, noCode.id)))
      .orderBy(m.drizzle.desc(m.schema.auditLog.at))
      .limit(1);
    expect(log.details).toMatchObject({ isolvedCode: "C" });
  });

  it("a code can't be taken twice, even around the app", async () => {
    const rock = await groupOf("rockisland");
    await expect(m.db.db.update(m.schema.payGroups).set({ isolvedCode: "C" }).where(eq(m.schema.payGroups.id, rock.id))).rejects.toThrow();
    await expect(m.db.db.update(m.schema.payGroups).set({ isolvedCode: "b" }).where(eq(m.schema.payGroups.id, rock.id))).rejects.toThrow();
  });
});

describe("each period's check and submit-by dates are on record", () => {
  it("the current period and the ones ahead are stored: due 4 days after the end, check 6, unless iSolved's schedule moved them (a holiday)", async () => {
    const g = await groupOf("moline");
    const today = m.time.todayLocal();
    for (const p of cal.periodsAround(g.calendar, today, 1, 6)) {
      const row = await stored(g.id, p.start);
      if (p.datesMoved) expect(row).toMatchObject({ periodEnd: p.end, periodNumber: p.number, submitBy: p.submitBy, checkDate: p.checkDate, reason: expect.stringMatching(/^iSolved schedule/) });
      else expect(row).toMatchObject({ periodEnd: p.end, periodNumber: p.number, submitBy: m.time.addDays(p.end, 4), checkDate: m.time.addDays(p.end, 6), reason: null });
    }
  });

  it("moving a period's dates needs a reason and the right order, and applies to every shop with that period", async () => {
    const { start, end } = fx.far;
    const moved = { checkDate: m.time.addDays(end, 5), submitBy: m.time.addDays(end, 3) };
    expect(await run.savePeriodDates(start, end, { ...moved, reason: " " }, actor)).toMatch(/Say why/);
    expect(await run.savePeriodDates(start, end, { checkDate: m.time.addDays(end, 2), submitBy: m.time.addDays(end, 3), reason: "Holiday" }, actor)).toMatch(/before the submit-by date/);
    expect(await run.savePeriodDates(start, end, { checkDate: m.time.addDays(end, 6), submitBy: m.time.addDays(end, -1), reason: "Holiday" }, actor)).toMatch(/before the period's last day/);
    expect(await run.savePeriodDates(start, m.time.addDays(end, 1), { ...moved, reason: "Holiday" }, actor)).toBe("No pay group has that pay period.");
    expect(await run.savePeriodDates(start, end, { ...moved, reason: "Good Friday, per iSolved" }, actor)).toBeNull();

    const all = await groups();
    const withIt = all.filter((g) => cal.periodStarting(g.calendar, start)?.end === end);
    expect(withIt.length).toBeGreaterThan(1);
    for (const g of withIt) {
      expect(await stored(g.id, start)).toMatchObject({ ...moved, reason: "Good Friday, per iSolved" });
      expect(cal.periodStarting(g.calendar, start)).toMatchObject({ ...moved, datesMoved: true });
    }
    const block = (await run.buildPayroll(start, end))!.blocks.find((b) => b.shopId === fx.moline)!;
    expect(block).toMatchObject({ payGroupCode: "C", period: { ...moved, datesMoved: true } });
    const choice = (await run.periodChoices(new Date(`${start}T18:00:00Z`))).find((c) => c.start === start)!;
    expect(choice.groups.find((g) => g.code === "C")).toMatchObject({ ...moved, datesMoved: true });

    const [log] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.period_dates")).orderBy(m.drizzle.desc(m.schema.auditLog.at)).limit(1);
    expect(log.details).toMatchObject({
      periodStart: start,
      from: { checkDate: m.time.addDays(end, 6), submitBy: m.time.addDays(end, 4) },
      to: moved,
      reason: "Good Friday, per iSolved",
      payGroups: withIt.length,
    });
  });

  it("only someone who runs payroll can move them", async () => {
    const makenna = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!.id;
    await signInAs(makenna);
    const { start, end } = fx.far;
    expect(await actions.savePeriodDatesAction({ start, end, checkDate: m.time.addDays(end, 6), submitBy: m.time.addDays(end, 4), reason: "" })).toMatchObject({ ok: false });
    expect((await stored((await groupOf("moline")).id, start))?.reason).toBe("Good Friday, per iSolved");
  });

  it("a calendar change re-writes the calendar's dates; a moved period keeps its own", async () => {
    const g = await groupOf("moline");
    const today = m.time.todayLocal();
    const cur = cal.periodOf(g.calendar, today);
    try {
      expect(await saveGroup("moline", { calendar: { ...g.calendar, submitOffsetDays: 3 } })).toBeNull();
      expect(await stored(g.id, cur.start)).toMatchObject({ submitBy: m.time.addDays(cur.end, 3), checkDate: m.time.addDays(cur.end, 6) });
      expect(await stored(g.id, fx.far.start)).toMatchObject({ checkDate: m.time.addDays(fx.far.end, 5), reason: "Good Friday, per iSolved" });
    } finally {
      expect(await saveGroup("moline", { calendar: { ...g.calendar, submitOffsetDays: 4 } })).toBeNull();
    }
    expect(await stored(g.id, cur.start)).toMatchObject({ submitBy: m.time.addDays(cur.end, 4) });
    expect(await saveGroup("moline", { calendar: { ...g.calendar, submitOffsetDays: 7 } })).toMatch(/no later than the check date/);
  });

  it("the setup page lists them, and the Payroll Report says when hours are due in iSolved", async () => {
    await signInAs(fx.owner);
    const setup = await open("/admin/payroll/setup");
    expect(setup.kind).toBe("ok");
    expect(setup.text).toContain("Pay period dates");
    expect(setup.text).toContain("iSolved code");
    const report = await open("/admin/reports/payroll/report", {}, { period: `${fx.far.start}_${fx.far.end}`, shop: fx.moline });
    expect(report.kind).toBe("ok");
    const due = m.time.formatDate(m.time.addDays(fx.far.end, 3), "EEE MMM d");
    expect(report.text).toMatch(new RegExp(`due in iSolved ${due}`));
    expect(report.text).toContain("iSolved C");
  });

  it("dates back to the calendar's clear the reason, with no reason needed", async () => {
    const { start, end } = fx.far;
    expect(await run.savePeriodDates(start, end, { checkDate: m.time.addDays(end, 6), submitBy: m.time.addDays(end, 4), reason: "" }, actor)).toBeNull();
    const g = await groupOf("moline");
    expect(cal.periodStarting(g.calendar, start)).toMatchObject({ checkDate: m.time.addDays(end, 6), datesMoved: false });
    const row = await stored(g.id, start);
    expect(row?.reason ?? null).toBeNull();
  });

  it("a locked period keeps its dates", async () => {
    const g = await groupOf("moline");
    const { start, end } = fx.lockedAt;
    const p = cal.periodStarting(g.calendar, start)!;
    const [r] = await m.db.db
      .insert(m.schema.payrollRuns)
      .values({ payGroupId: g.id, periodStart: start, periodEnd: end, periodNumber: p.number, checkDate: p.checkDate, settings: {}, snapshot: {} })
      .returning();
    try {
      expect(await run.savePeriodDates(start, end, { checkDate: m.time.addDays(end, 5), submitBy: m.time.addDays(end, 3), reason: "Holiday" }, actor)).toBe(
        "This pay period is locked, so its check date is part of the record.",
      );
    } finally {
      await m.db.db.delete(m.schema.payrollRuns).where(eq(m.schema.payrollRuns.id, r.id));
    }
  });
});
