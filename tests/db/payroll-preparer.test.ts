/**
 * Separation of duties on the Payroll Report (I8): whoever changes a pay period's figures by hand
 * (an adjustment, late commission, or hours entered, imported or deleted) doesn't approve them.
 * Someone else with Approve and lock does, or the Brand Owner, whose approval of their own changes
 * is recorded as such. Locking what someone else approved stays open to them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { open } from "./render";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { moline: "", jamie: "", p: { start: "", end: "" }, q: { start: "", end: "" } };
const at = (d: string, h: number) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
  for (const l of ["owner", "admin"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  fx.jamie = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, "Jamie") }))!.id;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.moline)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  // Pay periods no other test reaches.
  const p = periodOf(g.calendar, "2028-03-08");
  fx.p = { start: p.start, end: p.end };
  const q = periodOf(g.calendar, m.time.addDays(p.end, 1));
  fx.q = { start: q.start, end: q.end };
  expect(await run.saveRate(fx.jamie, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();
  const days = [1, 2, 3].map((n) => m.time.addDays(fx.p.start, n));
  expect(await run.addTimeEntries(days.map((d) => ({ staffId: fx.jamie, shopId: fx.moline, kind: "worked" as const, startsAt: at(d, 9), endsAt: at(d, 17) })), actor)).toEqual({ added: 3 });
  await lockHours(fx.p.start, fx.p.end);
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const approvals = (start: string) => m.db.db.select().from(m.schema.payrollApprovals).where(eq(m.schema.payrollApprovals.periodStart, start));
const override = (value: number, reason: string) => actions.setOverrideAction({ shopId: fx.moline, periodStart: fx.p.start, staffId: fx.jamie, field: "serviceSales", value, reason });

describe("the preparer doesn't approve their own changes (I8)", () => {
  it("nobody has changed the figures by hand yet: no preparers", async () => {
    expect(await run.preparersOf(fx.p.start, fx.p.end)).toEqual([]);
  });

  it("an adjustment makes its author a preparer, and they can't approve", async () => {
    await signInAs(ids.admin);
    expect(await override(400, "Ticket rung under the wrong barber")).toEqual({ ok: true, data: null });
    expect((await run.preparersOf(fx.p.start, fx.p.end)).map((p) => p.staffId)).toEqual([ids.admin]);
    const r = await actions.approvePayrollAction(fx.p.start, fx.p.end, "");
    expect(r).toMatchObject({ ok: false, error: run.SELF_APPROVAL });
    expect(await actions.approveAndLockAction(fx.p.start, fx.p.end)).toMatchObject({ ok: false, error: run.SELF_APPROVAL });
    expect(await approvals(fx.p.start)).toEqual([]);
  });

  it("the report names the preparer and tells them someone else approves", async () => {
    await signInAs(ids.admin);
    const page = await open("/admin/reports/payroll/report", {}, { period: `${fx.p.start}_${fx.p.end}`, shop: fx.moline });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Figures changed by hand by Dana (admin)");
    expect(page.text).toContain("so someone else with Approve and lock approves them");
  });

  it("someone else approves, and the preparer can still lock what they approved", async () => {
    await signInAs(ids.owner);
    expect(await actions.approvePayrollAction(fx.p.start, fx.p.end, "Checked Dana's adjustment")).toMatchObject({ ok: true });
    const [a] = await approvals(fx.p.start);
    expect(a.approvedBy).toBe(ids.owner);
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "payroll.approve"), eq(m.schema.auditLog.entityId, a.id)));
    expect(logged.details).not.toHaveProperty("selfApproved");
    await signInAs(ids.admin);
    expect(await actions.revokeApprovalAction(fx.p.start, fx.p.end, "One more fix")).toEqual({ ok: true, data: null });
  });

  it("the Brand Owner may approve their own changes, and that's recorded on the trail", async () => {
    await signInAs(ids.owner);
    expect(await override(450, "Recount")).toEqual({ ok: true, data: null });
    expect((await run.preparersOf(fx.p.start, fx.p.end)).map((p) => p.staffId).sort()).toEqual([ids.admin, ids.owner].sort());
    const r = await actions.approvePayrollAction(fx.p.start, fx.p.end, "");
    expect(r).toMatchObject({ ok: true });
    const id = (r as { data: string }).data;
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "payroll.approve"), eq(m.schema.auditLog.entityId, id)));
    expect(logged.details).toMatchObject({ selfApproved: true });
    const page = await open("/admin/reports/payroll/report", {}, { period: `${fx.p.start}_${fx.p.end}`, shop: fx.moline });
    expect(page.text).toContain("including their own changes (Brand Owner)");
    await signInAs(ids.admin);
    expect(await actions.lockPayrollAction(fx.p.start, fx.p.end)).toMatchObject({ ok: true });
  });

  it("hours entered or deleted by hand count too; clock hours and system entries don't", async () => {
    await signInAs(ids.admin);
    const d = m.time.addDays(fx.q.start, 2);
    expect(await actions.addTimeEntryAction({ staffId: fx.jamie, shopId: fx.moline, kind: "worked", date: d, start: "09:00", end: "13:00", note: "" })).toEqual({ ok: true, data: 1 });
    expect((await run.preparersOf(fx.q.start, fx.q.end)).map((p) => p.staffId)).toEqual([ids.admin]);
    const [entry] = await m.db.db.select().from(m.schema.timeEntries).where(m.drizzle.and(eq(m.schema.timeEntries.staffId, fx.jamie), eq(m.schema.timeEntries.createdBy, ids.admin)));
    await signInAs(ids.owner);
    expect(await actions.deleteTimeEntryAction(entry.id)).toEqual({ ok: true, data: null });
    expect((await run.preparersOf(fx.q.start, fx.q.end)).map((p) => p.staffId)).toEqual([ids.owner]);
    expect(await run.preparersOf(m.time.addDays(fx.q.end, 1), m.time.addDays(fx.q.end, 14))).toEqual([]);
  });
});
