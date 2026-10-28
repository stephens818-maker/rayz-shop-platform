/**
 * Q11 answered (Charles, via claude bot): training hours are on top of clocked production hours, so
 * production + training over 40 in a Chicago Sun–Sat workweek is overtime, every shop added up, and
 * each shop's share counts its training. Against a real database, from punches: the Payroll Report,
 * the iSolved file (E_Overtime 1.5_Hours, format unchanged), training cost inside labor cost, the
 * approve-and-lock gate, /me/earnings' workweeks, and the migration that turns the setting on.
 * Rests on training being hours worked under the FLSA, the CPA's to confirm.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let api: Awaited<ReturnType<typeof staffApp>>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", end: "" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const day = (n: number) => m.time.addDays(fx.start, n);
const span = (d: string, fromMin: number, toMin: number) => ({ startsAt: m.time.zonedWallTime(d, fromMin).toJSDate(), endsAt: m.time.zonedWallTime(d, toMin).toJSDate() });
const view = async () => (await run.buildPayroll(fx.start, fx.end))!;
type View = Awaited<ReturnType<typeof view>>;
const lineOf = (v: View, who: string, shopId: string) => v.blocks.find((b) => b.shopId === shopId)!.lines.find((l) => l.staffId === ids[who])!;
const rowOf = (v: View, who: string, shopId: string) => v.blocks.find((b) => b.shopId === shopId)!.exportRows.find((r) => r.staffId === ids[who])!.values;

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  api = await staffApp();
  for (const l of ["makenna", "michelle"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  // A pay period no other test reaches, starting on a Sunday: two Chicago workweeks.
  const p = periodOf(g.calendar, "2030-09-11");
  [fx.start, fx.end] = [p.start, p.end];
  expect(m.time.addDays(fx.start, 13)).toBe(fx.end);
  for (const who of ["makenna", "michelle"]) expect(await run.saveRate(ids[who], null, { hourlyRate: 15, servicePct: 0.4, productPct: 0.15, trainingRate: 10 }, actor)).toBeNull();

  // Week one, Monday to Thursday 9:00–6:30 at Coralville: 38 production hours each. Then Makenna has
  // a 4-hour class at Coralville on Friday, and Michelle one at Moline on Saturday.
  const prod = (who: string) => [1, 2, 3, 4].map((n) => ({ staffId: ids[who], shopId: shop.coralville, kind: "worked" as const, ...span(day(n), 9 * 60, 18 * 60 + 30) }));
  const entries = [
    ...prod("makenna"),
    ...prod("michelle"),
    { staffId: ids.makenna, shopId: shop.coralville, kind: "training" as const, ...span(day(5), 9 * 60, 13 * 60) },
    { staffId: ids.michelle, shopId: shop.moline, kind: "training" as const, ...span(day(6), 9 * 60, 13 * 60) },
  ];
  expect(await run.addTimeEntries(entries, actor)).toEqual({ added: entries.length });
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("golden: 38 production hours + 4 training hours = 2 OT hours", () => {
  it("on by default", async () => {
    expect((await run.loadSettings()).trainingCountsTowardOt).toBe(true);
  });

  it("the Payroll Report: 36 regular + 2 OT, all 4 training hours at the training rate, outside the greater-of", async () => {
    const l = lineOf(await view(), "makenna", shop.coralville);
    expect(l).toMatchObject({ otHours: 2, hours: 36, trainingHours: 4, trainingRate: 10, trainingPay: 40, otPay: 45, totalWages: 540 });
    expect(l.input.workedHours).toBe(38);
  });

  it("the iSolved file: 2.00 in E_Overtime 1.5_Hours and 4 in E_Training_Hours, the 6 columns unchanged", async () => {
    const v = await view();
    expect(v.blocks.find((b) => b.shopId === shop.coralville)!.exportHeaders).toEqual(["E_Regular_Hours", "E_Overtime 1.5_Hours", "E_Cash Tips Recd_Dollars", "E_Comm Sales_Dollars", "E_Ray'z Paid Time_Hours", "E_Training_Hours"]);
    expect(rowOf(v, "makenna", shop.coralville)).toEqual([36, 2, 0, 0, 0, 4]);
  });

  it("labor cost has the training pay and its share of the OT cost: training cost is $40 + 4/42 of the 2 OT hours at 1.5 × $15", async () => {
    const l = lineOf(await view(), "makenna", shop.coralville);
    expect(l.laborCost).toBe(540 + 45 + 40);
    expect(l.trainingOtHours).toBeCloseTo((2 * 4) / 42, 9);
    expect(l.trainingOtPay).toBeCloseTo(1.5 * 15 * ((2 * 4) / 42), 9);
    expect(l.trainingCost).toBeCloseTo(40 + 1.5 * 15 * ((2 * 4) / 42), 9);
  });
});

describe("golden: training hours at a second shop", () => {
  it("the 2 OT hours are shared by hours with Moline's training counted: 1.81 at Coralville, 0.19 at Moline", async () => {
    const v = await view();
    const co = lineOf(v, "michelle", shop.coralville);
    const mo = lineOf(v, "michelle", shop.moline);
    expect([co.otHours, mo.otHours]).toEqual([1.81, 0.19]);
    expect(rowOf(v, "michelle", shop.coralville)).toEqual([36.19, 1.81, 0, 0, 0, 0]);
    expect(rowOf(v, "michelle", shop.moline).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.19, 0, 0, 0, 3.81]);
    expect(mo).toMatchObject({ hours: 0, otFromTraining: 0.19, trainingOtHours: 0.19 });
    expect(mo.trainingPay).toBeCloseTo(38.1, 9);
    expect(co.trainingCost).toBe(0);
    expect(mo.trainingCost).toBeCloseTo(38.1 + 1.5 * 15 * 0.19, 9);
    expect(v.anomalies.filter((a) => a.kind === "training_overtime" && a.staffId === ids.michelle)).toHaveLength(1);
  });

  it("her workweek in the Payroll Report: 42 hours toward the 40 across both shops, 2 OT", async () => {
    const [w] = (await view()).weeks[ids.michelle];
    expect([w.basis, w.ot]).toEqual([42, 2]);
    expect(w.slices.map((s) => [s.shopId === shop.moline ? "moline" : "coralville", s.worked, s.training, s.ot]).sort()).toEqual([
      ["coralville", 38, 0, 1.81],
      ["moline", 0, 4, 0.19],
    ]);
  });
});

describe("the gate", () => {
  it("training cost reconciles in every shop and in the Locations totals", async () => {
    const v = await view();
    expect(v.mismatches).toEqual([]);
    for (const b of v.blocks) expect(b.totals.trainingCost).toBeCloseTo(b.lines.reduce((a, l) => a + l.trainingCost, 0), 9);
    expect(v.grand.trainingCost).toBeCloseTo(
      v.blocks.reduce((a, b) => a + b.totals.trainingCost, 0),
      9,
    );
    expect(v.grand.trainingCost).toBeGreaterThan(40 + 38.1);
  });
});

describe("/me/earnings counts training hours in weekly OT", () => {
  it("her workweek: 38 production + 4 training = 42 toward the 40, 2 OT, and training's share of it", async () => {
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(m.schema.staff.id, ids.makenna));
    const token = (await api.login("makenna@rayz.test")).accessToken;
    const r = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token });
    expect(r.status, r.text).toBe(200);
    const [w] = r.json.workweeks as J[];
    expect(w).toMatchObject({ weekStart: fx.start, productionHours: 38, trainingHours: 4, basisHours: 42, otHours: 2, regularHours: 40, otIsEstimate: true });
    const { TRAINING_OT_COPY } = await import("@/domain/my-earnings");
    expect(r.json.training).toMatchObject({ hours: 4, payCents: 4000, rateCents: 1000, inGreaterOf: false, countsTowardOt: true, overtimeShareHours: 0.19, overtimeShareCents: 429, otNote: TRAINING_OT_COPY });
    expect(r.json.otEstimatedCents).toBe(4500);
  });
});

describe("locked: the figures stand", () => {
  it("approves and locks through the gate, and the locked lines keep their training cost", async () => {
    const before = await view();
    await lockHours(fx.start, fx.end);
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toMatchObject({ approvalId: expect.any(String) });
    expect(await run.lockPayroll(fx.start, fx.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const after = await view();
    for (const [who, shopId] of [
      ["makenna", shop.coralville],
      ["michelle", shop.moline],
    ]) {
      const [a, b] = [lineOf(before, who, shopId), lineOf(after, who, shopId)];
      expect(b).toMatchObject({ otHours: a.otHours, trainingHours: a.trainingHours, trainingCost: a.trainingCost, laborCost: a.laborCost });
    }
    expect(after.mismatches).toEqual([]);
  });
});

describe("migration core_0146: a brand that saved the setting off gets it on", () => {
  it("off → on; still a setting", async () => {
    const before = await run.loadSettings();
    await brandSettings({ payroll: { ...before, trainingCountsTowardOt: false } });
    expect((await run.loadSettings()).trainingCountsTowardOt).toBe(false);
    const file = readFileSync(path.join(__dirname, "../../drizzle/core_0146_training_toward_ot.sql"), "utf8");
    await m.db.db.execute(m.drizzle.sql.raw(file));
    const after = await run.loadSettings();
    expect(after.trainingCountsTowardOt).toBe(true);
    expect({ ...after, trainingCountsTowardOt: before.trainingCountsTowardOt }).toEqual(before);
  });
});
