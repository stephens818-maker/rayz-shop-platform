/**
 * Training pay (Charles, Oct 28) against a real database: training hours × the employee's own training
 * rate, effective-dated on their Staff page (then Payroll setup's, then their hourly rate, flagged);
 * its own line outside the greater-of, in Labor Cost and the totals, checked by the approve-and-lock
 * gate and exported in E_Training_Hours; overtime past a shop's clocked hours comes off training
 * (C2); and its own line in /me/earnings. Rates are history: a change starts after the last locked
 * period, and only one that hasn't started can be deleted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");
let api: Awaited<ReturnType<typeof staffApp>>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", end: "" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const day = (n: number) => m.time.addDays(fx.start, n);
const span = (d: string, fromH: number, toH: number) => ({ startsAt: m.time.zonedWallTime(d, fromH * 60).toJSDate(), endsAt: m.time.zonedWallTime(d, toH * 60).toJSDate() });
const view = async () => (await run.buildPayroll(fx.start, fx.end))!;
const lineAt = (v: Awaited<ReturnType<typeof view>>, shopId: string) => v.blocks.find((b) => b.shopId === shopId)!.lines.find((l) => l.staffId === ids.makenna)!;
const flags = (v: Awaited<ReturnType<typeof view>>, kind: string) => v.anomalies.filter((a) => a.kind === kind && a.staffId === ids.makenna);

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
  api = await staffApp();
  for (const l of ["owner", "makenna", "michelle"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  // A pay period no other test reaches, starting on a Sunday: two Chicago workweeks.
  const p = periodOf(g.calendar, "2029-03-14");
  [fx.start, fx.end] = [p.start, p.end];
  expect(m.time.addDays(fx.start, 13)).toBe(fx.end);
  expect(await run.saveRate(ids.makenna, null, { hourlyRate: 15, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();

  // Week one: Monday to Friday 9–5 at Coralville, a 3-hour training Wednesday evening there, and a
  // Saturday of training at Moline: 51 hours, the last 8 of them training at a shop she didn't clock
  // in at. Week two: Monday 9–5 and 2 hours of training Tuesday, at Coralville.
  const worked = [1, 2, 3, 4, 5, 8].map((n) => ({ staffId: ids.makenna, shopId: shop.coralville, kind: "worked" as const, ...span(day(n), 9, 17) }));
  const training = [
    { staffId: ids.makenna, shopId: shop.coralville, kind: "training" as const, ...span(day(3), 18, 21) },
    { staffId: ids.makenna, shopId: shop.moline, kind: "training" as const, ...span(day(6), 9, 17) },
    { staffId: ids.makenna, shopId: shop.coralville, kind: "training" as const, ...span(day(9), 9, 11) },
  ];
  expect(await run.addTimeEntries([...worked, ...training], actor)).toEqual({ added: 9 });
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the training rate: her Staff page's, then Payroll setup's, then her hourly rate", () => {
  it("with no training rate anywhere, training is paid at her hourly rate and flagged", async () => {
    const v = await view();
    const l = lineAt(v, shop.coralville);
    expect(l).toMatchObject({ trainingHours: 5, trainingRate: 15, trainingPay: 75 });
    expect(l.input.trainingRateSource).toBe("hourly");
    expect(flags(v, "no_training_rate").map((a) => a.message)).toContain("Makenna (Coralville): 5h of training paid at their hourly rate ($15.00), because they have no training rate. Set one on their Staff page.");
  });

  it("Payroll setup's training rate is the fallback, unflagged", async () => {
    expect(await run.saveRate(ids.makenna, null, { hourlyRate: 15, servicePct: 0.4, productPct: 0.15, trainingRate: 9 }, actor)).toBeNull();
    const v = await view();
    const l = lineAt(v, shop.coralville);
    expect(l).toMatchObject({ trainingRate: 9, trainingPay: 45 });
    expect(l.input.trainingRateSource).toBe("payroll_setup");
    expect(flags(v, "no_training_rate")).toEqual([]);
  });

  it("her Staff page's rates, each day's training at the rate in effect that day, a change mid-period flagged as mixed", async () => {
    await signInAs(ids.owner);
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: fx.start, rateCents: 1000 })).toEqual({ ok: true, data: null });
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: day(7), rateCents: 1250 })).toEqual({ ok: true, data: null });
    const v = await view();
    const l = lineAt(v, shop.coralville);
    expect(l.trainingHours).toBe(5);
    expect(l.trainingPay).toBeCloseTo(3 * 10 + 2 * 12.5, 6);
    expect(l.input.trainingRateSource).toBe("staff");
    expect(l.input.mixedRates).toContain("trainingRate");
    expect(flags(v, "mixed_rates").map((a) => a.message).join("\n")).toMatch(/each day's training at that day's training rate/);
    const audits = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.training_rate_add"));
    expect(audits.map((a) => (a.details as { rateCents: number }).rateCents).sort()).toEqual([1000, 1250]);
  });

  it("only a brand-wide payroll admin sets one, never their own; one a day; and the database refuses an edit", async () => {
    await signInAs(ids.owner);
    expect(await actions.addTrainingRateAction({ staffId: ids.owner, effectiveFrom: day(2), rateCents: 1000 })).toMatchObject({ ok: false, error: "Your own training rate is set by another payroll admin." });
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: day(7), rateCents: 1300 })).toMatchObject({ ok: false, error: expect.stringMatching(/already a training rate starting that day/) });
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: day(2), rateCents: 50_001 })).toMatchObject({ ok: false, error: "The training rate is $0 to $500 an hour" });
    for (const who of ["michelle", "makenna"]) {
      await signInAs(ids[who]);
      expect(await actions.addTrainingRateAction({ staffId: ids.owner, effectiveFrom: day(2), rateCents: 1000 }), who).toMatchObject({ ok: false });
    }
    const t = m.schema.staffTrainingRates;
    await expect(m.db.db.update(t).set({ rateCents: 2000 }).where(eq(t.staffId, ids.makenna))).rejects.toThrow();
  });

  it("a rate that hasn't started can be deleted, audited", async () => {
    await signInAs(ids.owner);
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: day(12), rateCents: 2000 })).toEqual({ ok: true, data: null });
    const t = m.schema.staffTrainingRates;
    const [later] = await m.db.db.select().from(t).where(m.drizzle.and(eq(t.staffId, ids.makenna), eq(t.effectiveFrom, day(12))));
    expect(await actions.deleteTrainingRateAction({ staffId: ids.makenna, versionId: later.id })).toEqual({ ok: true, data: null });
    expect(await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.training_rate_delete"))).toHaveLength(1);
  });
});

describe("on the Payroll Report: its own line outside the greater-of, in Labor Cost, the gate and E_Training_Hours", () => {
  it("overtime past the hours she clocked at Moline comes off her training there, never negative regular hours (C2), flagged", async () => {
    const v = await view();
    const moline = lineAt(v, shop.moline);
    expect(moline.otHours).toBeGreaterThan(0);
    expect(moline.hours).toBe(0);
    expect(moline.otFromTraining).toBe(moline.otHours);
    expect(moline.trainingHours).toBe(8 - moline.otHours);
    const all = [lineAt(v, shop.coralville), moline];
    expect(all.reduce((a, l) => a + l.otHours, 0)).toBe(11);
    expect(all.reduce((a, l) => a + l.hours + l.otHours + l.trainingHours, 0)).toBeCloseTo(61, 6);
    expect(flags(v, "training_overtime").map((a) => a.message).join("\n")).toMatch(/training on top of clocked hours that went over the weekly 40 \(C2\)/);
  });

  it("training pay is in Labor Cost and the shop totals, not in Total Wages or the greater-of, and the gate passes", async () => {
    const v = await view();
    for (const shopId of [shop.coralville, shop.moline]) {
      const l = lineAt(v, shopId);
      expect(l.laborCost).toBeCloseTo(l.totalWages + l.otPay + l.trainingPay + (l.guaranteeTopUp ?? 0) + (l.otPremiumOwed ?? 0), 6);
      expect(l.totalWages).toBeCloseTo(Math.max(l.hours * l.wage, l.commission), 6);
      const b = v.blocks.find((x) => x.shopId === shopId)!;
      expect(b.totals.laborCost).toBeCloseTo(
        b.lines.reduce((a, x) => a + x.laborCost, 0),
        6,
      );
    }
    expect(v.mismatches).toEqual([]);
  });

  it("exports training hours in E_Training_Hours, the format unchanged", async () => {
    const v = await view();
    const b = v.blocks.find((x) => x.shopId === shop.coralville)!;
    expect(b.exportHeaders).toHaveLength(6);
    expect(b.exportHeaders?.[5]).toBe("E_Training_Hours");
    const row = b.exportRows.find((r) => r.staffId === ids.makenna)!;
    expect(row.values[5]).toBe(lineAt(v, shop.coralville).trainingHours);
    expect(row.values).not.toContain(lineAt(v, shop.coralville).trainingPay);
  });
});

describe("in /me/earnings: its own line, never part of the greater-of", () => {
  it("top level and per shop, the report's training pay to the cent", async () => {
    // My Earnings covers the shops she works at, so Moline is one of hers here.
    await m.db.db.insert(m.schema.staffShops).values({ staffId: ids.makenna, shopId: shop.moline }).onConflictDoNothing();
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(m.schema.staff.id, ids.makenna));
    const token = (await api.login("makenna@rayz.test")).accessToken;
    const r = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token });
    expect(r.status, r.text).toBe(200);
    const v = await view();
    const cents = (x: number) => Math.round(x * 100);
    const co = lineAt(v, shop.coralville);
    const mo = lineAt(v, shop.moline);
    expect(r.json.training.hours).toBeCloseTo(co.trainingHours + mo.trainingHours, 6);
    expect(r.json.training).toMatchObject({
      code: "training",
      rateCents: null,
      payCents: cents(co.trainingPay) + cents(mo.trainingPay),
      inGreaterOf: false,
      paidAsOvertimeHours: mo.otFromTraining,
      countsTowardOt: true,
    });
    const part = (id: string) => (r.json.shops as J[]).find((x) => x.shopId === id).training;
    expect(part(shop.coralville)).toMatchObject({ hours: 5, payCents: 5500, inGreaterOf: false });
    expect(part(shop.moline)).toMatchObject({ paidAsOvertimeHours: mo.otFromTraining, inGreaterOf: false });
  });
});

describe("training toward overtime is configurable (C2, Q11), on by default", () => {
  it("off: training stays out of the weekly 40, no overtime comes off it, and the app says so", async () => {
    const before = await run.loadSettings();
    expect(before.trainingCountsTowardOt).toBe(true);
    await brandSettings({ payroll: { ...before, trainingCountsTowardOt: false } });
    try {
      const v = await view();
      const moline = lineAt(v, shop.moline);
      expect(moline).toMatchObject({ otHours: 0, trainingHours: 8 });
      expect(moline.otFromTraining ?? 0).toBe(0);
      expect(lineAt(v, shop.coralville).otHours).toBe(0);
      expect(flags(v, "training_in_hours").length).toBeGreaterThan(0);
      expect(v.mismatches).toEqual([]);
      const token = (await api.login("makenna@rayz.test")).accessToken;
      const r = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token });
      expect(r.json.training).toMatchObject({ countsTowardOt: false, paidAsOvertimeHours: 0 });
      const { TRAINING_NO_OT_COPY } = await import("@/domain/my-earnings");
      expect(r.json.training.otNote).toBe(TRAINING_NO_OT_COPY);
    } finally {
      await brandSettings({ payroll: before });
    }
  });
});

describe("locked: the figures stand, and the rates it used stay in the history", () => {
  it("approves and locks through the gate; the locked line keeps its training pay; no rate starts or is deleted inside it", async () => {
    const before = await view();
    await lockHours(fx.start, fx.end);
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toMatchObject({ approvalId: expect.any(String) });
    expect(await run.lockPayroll(fx.start, fx.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const after = await view();
    for (const shopId of [shop.coralville, shop.moline]) {
      const [a, b] = [lineAt(before, shopId), lineAt(after, shopId)];
      expect(b).toMatchObject({ trainingHours: a.trainingHours, trainingPay: a.trainingPay, laborCost: a.laborCost });
    }

    await signInAs(ids.owner);
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: day(10), rateCents: 1400 })).toMatchObject({ ok: false, error: expect.stringMatching(/after the last locked pay period/) });
    const t = m.schema.staffTrainingRates;
    const [used] = await m.db.db.select().from(t).where(m.drizzle.and(eq(t.staffId, ids.makenna), eq(t.effectiveFrom, day(7))));
    expect(await actions.deleteTrainingRateAction({ staffId: ids.makenna, versionId: used.id })).toMatchObject({ ok: false, error: expect.stringMatching(/locked pay period .* used this training rate/) });
    await expect(m.db.db.delete(t).where(eq(t.id, used.id))).rejects.toThrow();
    await expect(m.db.db.insert(t).values({ staffId: ids.makenna, effectiveFrom: day(10), rateCents: 1400 })).rejects.toThrow();
    expect(await actions.addTrainingRateAction({ staffId: ids.makenna, effectiveFrom: m.time.addDays(fx.end, 1), rateCents: 1400 })).toEqual({ ok: true, data: null });
  });
});
