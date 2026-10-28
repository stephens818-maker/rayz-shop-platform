/**
 * The rollout Charles approved (2026-10-28): one pilot shop goes live while Squire stays as its
 * backup, and the rest switch after one clean pay period. A pay period where the pilot's payroll
 * comes from its punches and tickets here and every other shop's from its Squire Commissions report:
 * approve, lock and export it; the second wave can't switch until an owner signs off the pilot's
 * clean period; handing the pilot back takes the sign-off with it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let rollout: typeof import("@/server/rollout");
let plan: typeof import("@/server/rollout-plan");
let cut: typeof import("@/server/cutover");
let actions: typeof import("@/app/admin/rollout/actions");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", end: "", jamie: "", coralA: "", coralB: "", others: [] as { shopId: string; name: string; staffId: string }[] };
const at = (d: string, h: number) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);
const HEAD = "Name,Hours Worked,Personnel ID,Card,Cash,GC Used,GC Bought,Card Fees (on Total),Commission Splits Fee,Total,Commission %,Due to Barbers,Squire Tips,POS Tips,Gift Card Tips,Tips,Total to Barber,Tax,Due to Shop";
const line = (name: string, hours: number, total: number, tips: number, tax: number) => `${name},${hours.toFixed(2)},,0,0,0,0,0,0,"$${total.toFixed(2)}",0%,0,0,0,0,"$${tips.toFixed(2)}",0,"$${tax.toFixed(2)}",0`;
const afterEnd = () => new Date(at(m.time.addDays(fx.end, 3), 12));
const view = async () => (await run.buildPayroll(fx.start, fx.end))!;

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  rollout = await import("@/server/rollout");
  plan = await import("@/server/rollout-plan");
  cut = await import("@/server/cutover");
  actions = await import("@/app/admin/rollout/actions");
  ids.owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.name] = s.id;
  fx.jamie = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, "Jamie") }))!.id;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.Moline)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  // A pay period no other test reaches.
  const p = periodOf(g.calendar, "2027-10-20");
  [fx.start, fx.end] = [p.start, p.end];

  const people = await m.db.db
    .select({ staffId: m.schema.staffShops.staffId, shopId: m.schema.staffShops.shopId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staff.kind, "person"), m.drizzle.ne(m.schema.staff.id, fx.jamie)));
  const used = new Set<string>();
  const pick = (shopId: string) => {
    const x = people.find((q) => q.shopId === shopId && !used.has(q.staffId))!;
    used.add(x.staffId);
    return x.staffId;
  };
  fx.coralA = pick(shop.Coralville);
  fx.coralB = pick(shop.Coralville);
  const set = (staffId: string, squireName: string) => m.db.db.update(m.schema.staff).set({ squireName }).where(eq(m.schema.staff.id, staffId));
  await set(fx.coralA, "Coral Barber A");
  await set(fx.coralB, "Coral Barber B");
  await set(fx.jamie, "Jamie Floater");
  for (const name of ["Kimberly", "Le Claire", "Rock Island", "Silvis", "Utica"]) {
    const staffId = pick(shop[name]);
    await set(staffId, `${name} Barber A`);
    fx.others.push({ shopId: shop[name], name, staffId });
  }
  await run.saveRate(fx.jamie, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor);
  await run.saveRate(fx.coralA, null, { hourlyRate: 15.5, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor);
  const days = [1, 2, 3].map((n) => m.time.addDays(fx.start, n));
  expect(await run.addTimeEntries(days.map((d) => ({ staffId: fx.jamie, shopId: shop.Moline, kind: "worked" as const, startsAt: at(d, 9), endsAt: at(d, 17) })), actor)).toEqual({ added: 3 });
  // Clocked at Coralville in a period paid from Squire data: Squire's hours are the record.
  expect(await run.addTimeEntries([{ staffId: fx.coralA, shopId: shop.Coralville, kind: "worked", startsAt: at(days[0], 9), endsAt: at(days[0], 17) }], actor)).toEqual({ added: 1 });
  await lockHours(fx.start, fx.end);
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("rollout: per-shop go-live flags", () => {
  it("before any plan, every shop's payroll comes from here, as it always has", async () => {
    const v = await view();
    expect(v.blocks.every((b) => b.source === "platform")).toBe(true);
    expect(v.squireMissing).toEqual([]);
    expect((await rollout.rolloutView()).active).toBe(false);
  });

  it("one pilot, payroll from here starting on a pay period's first day", async () => {
    await expect(rollout.savePlan(actor, shop.Moline, { wave: 1, plannedOn: fx.start, payrollFrom: m.time.addDays(fx.start, 1), squireBackupUntil: null, note: null })).rejects.toThrow(/first day of a pay period/);
    await signInAs(ids.owner);
    expect(await actions.savePlanAction(shop.Moline, { wave: 1, plannedOn: fx.start, payrollFrom: fx.start, squireBackupUntil: m.time.addDays(fx.end, 14), note: "Pilot" })).toEqual({ ok: true, data: null });
    await expect(rollout.savePlan(actor, shop.Silvis, { wave: 1, plannedOn: null, payrollFrom: null, squireBackupUntil: null, note: null })).rejects.toThrow(/Moline is the pilot/);
    // Dubuque was never on Squire: its payroll comes from here from the start.
    await rollout.savePlan(actor, shop.Dubuque, { wave: 2, plannedOn: null, payrollFrom: fx.start, squireBackupUntil: null, note: "Never on Squire" });
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "rollout.plan"));
    expect(logged.details).toMatchObject({ wave: 1, payrollFrom: fx.start, firstPlan: true });

    const r = await rollout.rolloutView();
    const moline = r.shops.find((s) => s.shop.id === shop.Moline)!;
    expect(moline).toMatchObject({ wave: 1, stage: "live", squireBackup: true });
    expect(moline.periods.find((p) => p.start === fx.start)).toBeUndefined();
    expect(r.shops.find((s) => s.shop.id === shop.Kimberly)).toMatchObject({ wave: 2, plan: null });
  });

  it("with a rollout planned, the other shops' payroll comes from Squire data, and approval waits for each one's report", async () => {
    const v = await view();
    expect(v.blocks.find((b) => b.shopId === shop.Moline)!.source).toBe("platform");
    expect(v.blocks.find((b) => b.shopId === shop.Dubuque)!.source).toBe("platform");
    expect(v.squireMissing.map((x) => x.shop).sort()).toEqual(["Coralville", "Kimberly", "Le Claire", "Rock Island", "Silvis", "Utica"]);
    expect(run.approvalBlocked(v)).toMatch(/Squire's report isn't imported for/);
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toEqual({ error: expect.stringMatching(/comes from Squire this period, and Squire's Commissions report isn't imported for them yet/) });
    expect(v.anomalies.filter((a) => a.kind === "rollout_source").map((a) => a.message)).toContainEqual(expect.stringMatching(/^Coralville books here, but its payroll for this period comes from Squire data/));
  });

  it("imports a shop's Squire Commissions report only for a period paid from Squire, and nothing when a line has a problem", async () => {
    await expect(rollout.importSquireReport(actor, shop.Moline, fx.start, { name: "x.csv", text: [HEAD, line("Jamie Floater", 1, 1, 0, 0)].join("\n") })).rejects.toThrow(/comes from this platform/);
    const bad = await actions.importSquireAction(shop.Coralville, fx.start, { name: "bad.csv", text: [HEAD, line("Coral Barber A", 40, 2000, 300, 200), line("Somebody Else", 10, 100, 0, 0)].join("\n") });
    expect(bad).toEqual({ ok: true, data: { errors: ['Line 3: no one here matches "Somebody Else". Set their Squire name under Staff, then import again.'] } });
    expect(await m.db.db.select().from(m.schema.payrollSquireImports)).toEqual([]);

    const report = [HEAD, line("Coral Barber A", 40, 2000, 300, 200), line("Coral Barber B", 30.5, 1500, 150.25, 150), line("Jamie Floater", 8, 400, 50, 40), HEAD, line("Coral Barber A", 40, 120, 0, 12)].join("\n");
    expect(await actions.importSquireAction(shop.Coralville, fx.start, { name: "coralville.csv", text: report })).toEqual({ ok: true, data: { rows: 3, notes: [] } });
    for (const o of fx.others) {
      const r = await rollout.importSquireReport(actor, o.shopId, fx.start, { name: `${o.name}.csv`, text: [HEAD, line(`${o.name} Barber A`, 70, 3000, 400, 90)].join("\n") });
      expect(r).toEqual({ rows: 1, notes: [] });
    }
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.squire_import"));
    expect(logged.details).toMatchObject({ periodStart: fx.start, rows: 3, serviceCents: 390000, tipsCents: 50025 });
  });

  it("pays the pilot from its punches and the rest from Squire's figures: tips Squire paid are already received in iSolved, punches at a Squire shop don't count", async () => {
    const v = await view();
    expect(v.squireMissing).toEqual([]);
    const moline = v.blocks.find((b) => b.shopId === shop.Moline)!;
    expect(moline.lines.find((l) => l.staffId === fx.jamie)!.input).toMatchObject({ workedHours: 24, serviceSales: 0 });
    const coral = v.blocks.find((b) => b.shopId === shop.Coralville)!;
    expect(coral).toMatchObject({ source: "squire", squireImport: { fileName: "coralville.csv", rows: 3 } });
    const a = coral.lines.find((l) => l.staffId === fx.coralA)!;
    expect(a.input).toMatchObject({ workedHours: 40, serviceSales: 2000, productSales: 120, tips: 300, tipsInPayroll: 0, salesTax: 212 });
    expect(a).toMatchObject({ commission: 800, tipsOutside: 300 });
    expect(coral.exportHeaders ?? []).not.toContain("Tips already paid out");
    expect(coral.exportRows.find((r) => r.staffId === fx.coralA)!.values.slice(0, 3)).toEqual([40, 0, 300]);
    expect(v.mismatches).toEqual([]);
    expect(v.tips.rows.filter((r) => r.shopId === shop.Coralville)).toEqual([]);
    expect(v.anomalies.filter((x) => x.kind === "hours_not_from_clock" || x.kind === "missed_punch").filter((x) => x.shopId !== shop.Moline)).toEqual([]);
    expect(v.anomalies.find((x) => x.kind === "cross_source_ot")?.message).toMatch(/^Jamie worked at Moline \(time clock\) and Coralville \(Squire data\) for the same employer: 32h in all\./);
  });

  it("takes OT, PTO and training typed on the report at a shop paid from Squire, which has no clock", async () => {
    expect(await run.setOverride(shop.Coralville, fx.start, fx.coralA, "otHours", 2, "Week 2 was 42 hours in Squire's timesheet", actor)).toBeNull();
    expect(await run.setOverride(shop.Coralville, fx.start, fx.coralA, "ptoHours", 8, "Paid day off", actor)).toBeNull();
    const a = (await view()).blocks.find((b) => b.shopId === shop.Coralville)!.lines.find((l) => l.staffId === fx.coralA)!;
    expect(a).toMatchObject({ hours: 38, otHours: 2, ptoHours: 8 });
  });

  it("approves, locks and exports the mixed period; each shop keeps where its figures came from", async () => {
    const r = await run.approveAndLock(fx.start, fx.end, actor);
    expect(r).toMatchObject({ locked: expect.any(Number) });
    const runs = await m.db.db.select().from(m.schema.payrollRuns).where(eq(m.schema.payrollRuns.periodStart, fx.start));
    const groups = await run.ensurePayGroups();
    const sourceOf = (shopId: string) => (runs.find((x) => x.payGroupId === groups.find((g) => g.shopId === shopId)!.id)!.snapshot as { source?: string }).source;
    expect(sourceOf(shop.Moline)).toBe("platform");
    expect(sourceOf(shop.Coralville)).toBe("squire");
    const v = await view();
    expect(v.locked).toBe("all");
    expect(v.blocks.find((b) => b.shopId === shop.Coralville)!.lockCheck!.drift).toEqual([]);

    const f = (await run.lockedExport(groups.find((g) => g.shopId === shop.Coralville)!.id, fx.start, fx.end))!;
    expect(f).toMatchObject({ runId: expect.any(String), body: expect.anything() });

    await expect(rollout.importSquireReport(actor, shop.Coralville, fx.start, { name: "again.csv", text: [HEAD, line("Coral Barber A", 1, 1, 0, 0)].join("\n") })).rejects.toThrow(/locked/);
    await expect(rollout.savePlan(actor, shop.Kimberly, { wave: 2, plannedOn: null, payrollFrom: fx.start, squireBackupUntil: null, note: null })).rejects.toThrow(/is locked\. Pick the first one that's still open/);
  });

  it("the second wave can't switch its booking until an owner signs off the pilot's clean pay period", async () => {
    await m.db.db.update(m.schema.shops).set({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-silvis" }).where(eq(m.schema.shops.id, shop.Silvis));
    await expect(cut.signOffAndSwitch(actor, shop.Silvis)).rejects.toThrow(/Silvis is in the second wave: it switches after Moline's first clean pay period on this platform is signed off/);
    expect((await rollout.rolloutView()).shops.find((s) => s.shop.id === shop.Silvis)!.switchBlocked).toMatch(/second wave/);

    expect((await rollout.cleanPeriodCheck(shop.Moline, fx.start, at(fx.end, 12))).checks.find((c) => !c.ok)?.label).toBe("The period is over");
    const r = await rollout.cleanPeriodCheck(shop.Moline, fx.start, afterEnd());
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    await expect(rollout.signCleanPeriod(actor, shop.Kimberly, fx.start, "Paychecks were right", afterEnd())).rejects.toThrow(/Only the pilot shop/);
    await expect(rollout.signCleanPeriod(actor, shop.Moline, fx.start, "ok", afterEnd())).rejects.toThrow(/Say what you checked/);
    await rollout.signCleanPeriod(actor, shop.Moline, fx.start, "Paychecks right, iSolved took the file, no complaints", afterEnd());
    const [row] = await m.db.db.select().from(m.schema.shopRollouts).where(eq(m.schema.shopRollouts.shopId, shop.Moline));
    expect(row).toMatchObject({ cleanPeriodStart: fx.start, cleanPeriodEnd: fx.end, cleanNote: "Paychecks right, iSolved took the file, no complaints" });
    expect(await plan.switchRefusal(shop.Silvis)).toBeNull();
    // Past the rollout gate: now it's the cutover's own steps.
    await expect(cut.signOffAndSwitch(actor, shop.Silvis)).rejects.toThrow(/Record when Squire booking was turned off first/);
    await expect(rollout.savePlan(actor, shop.Moline, { wave: 2, plannedOn: null, payrollFrom: fx.start, squireBackupUntil: null, note: null })).rejects.toThrow(/stays the pilot/);
  });

  it("handing the pilot back to Squire takes its sign-off with it: the second wave waits again", async () => {
    await cut.handBack(actor, shop.Moline, "https://getsquire.com/booking/rayz-moline");
    const [row] = await m.db.db.select().from(m.schema.shopRollouts).where(eq(m.schema.shopRollouts.shopId, shop.Moline));
    expect(row.cleanSignedAt).toBeNull();
    expect(await plan.switchRefusal(shop.Silvis)).toMatch(/second wave/);
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "cutover.hand_back"));
    expect(logged.details).toMatchObject({ cleanPeriodSignOffCleared: true });
  });
});
