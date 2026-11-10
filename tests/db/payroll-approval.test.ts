/**
 * The Payroll Report's flow against a real database: run → review → approve → lock. The lock needs a
 * current approval; a change after approval makes it stale (and holds the iSolved files) until it's
 * approved again; an approval is taken back only with a reason and never edited or deleted; each
 * shop's iSolved file downloads once approved, as approved; every step is in the period's audit
 * trail. Also: PTO and training hours from the clock or from a manager, and the report downloads.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { open } from "./render";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");
let download: typeof import("@/app/admin/payroll/download/route");
let reportFile: typeof import("@/app/admin/reports/payroll/report/file/route");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { moline: "", jamie: "", start: "", end: "", next: { start: "", end: "" } };
const at = (d: string, h: number) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
  download = await import("@/app/admin/payroll/download/route");
  reportFile = await import("@/app/admin/reports/payroll/report/file/route");
  for (const l of ["owner", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  fx.jamie = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, "Jamie") }))!.id;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.moline)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  // Pay periods no other test reaches.
  const p = periodOf(g.calendar, "2027-08-10");
  [fx.start, fx.end] = [p.start, p.end];
  const q = periodOf(g.calendar, m.time.addDays(p.end, 1));
  fx.next = { start: q.start, end: q.end };
  expect(await run.saveRate(fx.jamie, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();
  const days = [0, 1, 2, 3].map((n) => m.time.addDays(fx.start, n + 1));
  expect(await run.addTimeEntries(days.map((d) => ({ staffId: fx.jamie, shopId: fx.moline, kind: "worked" as const, startsAt: at(d, 9), endsAt: at(d, 17) })), actor)).toEqual({ added: 4 });
  await lockHours(fx.start, fx.end);
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const approvals = () => m.db.db.select().from(m.schema.payrollApprovals).where(eq(m.schema.payrollApprovals.periodStart, fx.start));
const group = async () => (await run.buildPayroll(fx.start, fx.end))!.blocks.find((b) => b.shopId === fx.moline)!.payGroupId;
const get = async (path: string, q: Record<string, string>) => download.GET(new Request(`http://localhost${path}?${new URLSearchParams(q)}`));

describe("run → review → approve → lock", () => {
  it("won't lock, or serve a shop's iSolved file, before the figures are approved", async () => {
    expect(await run.lockPayroll(fx.start, fx.end, actor)).toEqual({ error: "Approve the period's figures before locking it." });
    expect(await run.approvedExport(await group(), fx.start, fx.end)).toBeNull();
    await signInAs(ids.owner);
    const res = await get("/admin/payroll/download", { group: await group(), start: fx.start, end: fx.end });
    expect(res.status).toBe(409);
    const view = (await run.buildPayroll(fx.start, fx.end))!;
    expect(run.approvalStatus(view, await run.approvalOf(view))).toBe("draft");
  });

  it("only someone with Approve and lock can approve", async () => {
    await signInAs(ids.makenna);
    expect(await actions.approvePayrollAction(fx.start, fx.end, "")).toMatchObject({ ok: false });
    expect(await approvals()).toEqual([]);
  });

  it("approves the figures as they stand, once, with their totals, and serves the approved file before the lock", async () => {
    await signInAs(ids.owner);
    const r = await actions.approvePayrollAction(fx.start, fx.end, "Reviewed with the managers");
    expect(r).toMatchObject({ ok: true });
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toEqual({ error: "These figures are already approved. Lock the period to finish." });
    const [a] = await approvals();
    const view = (await run.buildPayroll(fx.start, fx.end))!;
    expect(a).toMatchObject({ figuresHash: run.figuresHash(view.blocks), note: "Reviewed with the managers", revokedAt: null });
    expect(a.totals.employeeCost).toBe(view.blocks.reduce((x, b) => x + b.totals.totalWages, 0));
    expect(run.approvalStatus(view, await run.approvalOf(view))).toBe("approved");

    const f = (await run.approvedExport(await group(), fx.start, fx.end))!;
    expect(f).toMatchObject({ runId: null, approvalId: a.id });
    const res = await get("/admin/payroll/download", { group: await group(), start: fx.start, end: fx.end });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Moline"]);
    const [dl] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.download"));
    expect(dl.details).toMatchObject({ periodStart: fx.start, periodEnd: fx.end, locked: false });
  });

  it("goes stale when a figure changes after approval: the files are held and the lock refused until it's approved again", async () => {
    expect(await run.setOverride(fx.moline, fx.start, fx.jamie, "serviceSales", 500, "Ticket rung under the wrong barber", actor)).toBeNull();
    const view = (await run.buildPayroll(fx.start, fx.end))!;
    expect(run.approvalStatus(view, await run.approvalOf(view))).toBe("stale");
    expect(await run.approvedExport(await group(), fx.start, fx.end)).toBeNull();
    expect(await run.lockPayroll(fx.start, fx.end, actor)).toMatchObject({ error: expect.stringMatching(/changed since .* approved them/) });
    expect(await m.db.db.select().from(m.schema.payrollRuns).where(eq(m.schema.payrollRuns.periodStart, fx.start))).toEqual([]);
  });

  it("takes an approval back only with a reason, and never edits or deletes one", async () => {
    expect(await run.revokeApproval(fx.start, fx.end, "  ", actor)).toBe("Say why the approval is taken back.");
    expect(await actions.revokeApprovalAction(fx.start, fx.end, "Sales changed after review")).toEqual({ ok: true, data: null });
    const [a] = await approvals();
    expect(a).toMatchObject({ revokeReason: "Sales changed after review", revokedBy: ids.owner });
    expect(a.revokedAt).not.toBeNull();
    expect(await run.revokeApproval(fx.start, fx.end, "again", actor)).toBe("This pay period isn't approved.");
    const t = m.schema.payrollApprovals;
    await expect(m.db.db.update(t).set({ revokeReason: "edited" }).where(eq(t.id, a.id))).rejects.toThrow();
    await expect(m.db.db.delete(t).where(eq(t.id, a.id))).rejects.toThrow();
    const view = (await run.buildPayroll(fx.start, fx.end))!;
    expect(run.approvalStatus(view, await run.approvalOf(view))).toBe("draft");
  });

  it("approving changed figures replaces the earlier approval", async () => {
    expect(await run.approvePayroll(fx.start, fx.end, actor)).toMatchObject({ approvalId: expect.any(String) });
    expect(await run.setOverride(fx.moline, fx.start, fx.jamie, "serviceSales", 600, "Recount", actor)).toBeNull();
    const second = await run.approvePayroll(fx.start, fx.end, actor);
    expect(second).toMatchObject({ approvalId: expect.any(String) });
    const list = await approvals();
    expect(list.filter((a) => !a.revokedAt).map((a) => a.id)).toEqual([(second as { approvalId: string }).approvalId]);
    expect(list.find((a) => a.revokeReason === "Approved again with changed figures")).toBeTruthy();
  });

  it("locks with a current approval, keeps it, and refuses to take it back afterwards", async () => {
    await signInAs(ids.owner);
    const view = (await run.buildPayroll(fx.start, fx.end))!;
    const r = await actions.lockPayrollAction(fx.start, fx.end);
    expect(r).toEqual({ ok: true, data: view.blocks.length });
    const after = (await run.buildPayroll(fx.start, fx.end))!;
    const approval = await run.approvalOf(after);
    expect(run.approvalStatus(after, approval)).toBe("locked");
    const locks = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "payroll.lock"), m.drizzle.sql`${m.schema.auditLog.details}->>'periodStart' = ${fx.start}`));
    expect(locks.length).toBe(view.blocks.length);
    for (const l of locks) expect((l.details as { approvalId: string }).approvalId).toBe(approval!.id);
    expect(await run.revokeApproval(fx.start, fx.end, "too late", actor)).toBe("This pay period is locked, so its approval stands.");
    expect((await run.approvedExport(await group(), fx.start, fx.end))!.runId).not.toBeNull();
  });

  it("records every step in the period's audit trail, oldest first", async () => {
    const FLOW = new Set(["payroll.approve", "payroll.approval_revoked", "payroll.lock", "payroll.download", "payroll.override"]);
    const trail = (await run.payrollTrail(fx.start, fx.end)).filter((t) => FLOW.has(t.action));
    const steps = trail.map((t) => t.action).filter((a, i, xs) => a !== "payroll.lock" || xs[i - 1] !== "payroll.lock");
    expect(steps).toEqual([
      "payroll.approve",
      "payroll.download",
      "payroll.override",
      "payroll.approval_revoked",
      "payroll.approve",
      "payroll.override",
      "payroll.approval_revoked",
      "payroll.approve",
      "payroll.lock",
    ]);
    expect(trail.filter((t) => t.action === "payroll.approval_revoked").map((t) => t.details.reason)).toEqual(["Sales changed after review", "Approved again with changed figures"]);
    expect(trail.filter((t) => t.action === "payroll.override").map((t) => t.details.reason)).toEqual(["Ticket rung under the wrong barber", "Recount"]);
  });

  it("shows it all on the Payroll Report under Reports, and downloads the report as xlsx and CSV, audited", async () => {
    await signInAs(ids.owner);
    const page = await open("/admin/reports/payroll/report", {}, { period: `${fx.start}_${fx.end}`, shop: fx.moline });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Jamie");
    expect(page.text).toContain("Approved and locked");
    expect(page.text).toContain("Audit trail");
    expect(page.text).toContain("Took back the approval: Sales changed after review");

    const xlsx = await reportFile.GET(new Request(`http://localhost/admin/reports/payroll/report/file?${new URLSearchParams({ period: `${fx.start}_${fx.end}`, format: "xlsx" })}`));
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await xlsx.arrayBuffer());
    const ws = wb.getWorksheet("Locations")!;
    const headers: string[] = [];
    ws.eachRow((r) => {
      if (r.getCell(1).value === "Employee Name") headers.push((r.values as unknown[]).slice(1).join("|"));
    });
    expect(headers[0]).toContain("|Hourly Total |");
    expect(headers[0]).toContain("|Training  Hours");
    const csv = await reportFile.GET(new Request(`http://localhost/admin/reports/payroll/report/file?${new URLSearchParams({ period: `${fx.start}_${fx.end}`, format: "csv", shop: fx.moline })}`));
    expect(csv.headers.get("content-disposition")).toMatch(/Rayz Payroll Report \d\d\.\d\d\.\d\d-\d\d\.\d\d\.\d\d\.csv/);
    expect(await csv.text()).toMatch(/^Location,Employee Name,Hours,Hourly Wage,Hourly Total,/);
    const files = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.report_file"));
    expect(files.map((f) => (f.details as { format: string }).format).sort()).toEqual(["csv", "xlsx"]);

    await signInAs(ids.makenna);
    const denied = await reportFile.GET(new Request(`http://localhost/admin/reports/payroll/report/file?${new URLSearchParams({ period: `${fx.start}_${fx.end}`, format: "csv" })}`));
    expect(denied.status).toBe(403);
  });
});

describe("PTO and training hours: from the clock, from a manager, or both", () => {
  it("both (the default): time entries count, and a manager can type over them with a reason", async () => {
    const d = m.time.addDays(fx.next.start, 2);
    expect(await run.addTimeEntries([{ staffId: fx.jamie, shopId: fx.moline, kind: "pto", startsAt: at(d, 9), endsAt: at(d, 13) }], actor)).toEqual({ added: 1 });
    const line = async () => (await run.buildPayroll(fx.next.start, fx.next.end))!.blocks.find((b) => b.shopId === fx.moline)!.lines.find((l) => l.staffId === fx.jamie)!;
    expect((await line()).ptoHours).toBe(4);
    expect(await run.setOverride(fx.moline, fx.next.start, fx.jamie, "ptoHours", 6, "Approved in iSolved", actor)).toBeNull();
    expect((await line()).ptoHours).toBe(6);
    expect(await run.setOverride(fx.moline, fx.next.start, fx.jamie, "ptoHours", null, "", actor)).toBeNull();
  });

  it("clock only: nobody types PTO on the report", async () => {
    await brandSettings({ payroll: { ...(await run.loadSettings()), ptoSource: "clock" } });
    expect(await run.setOverride(fx.moline, fx.next.start, fx.jamie, "ptoHours", 6, "Approved in iSolved", actor)).toMatch(/come from the time clock only/);
  });

  it("manager only: clocked PTO isn't paid and is flagged, and the manager's entry is", async () => {
    await brandSettings({ payroll: { ...(await run.loadSettings()), ptoSource: "manager" } });
    const view = (await run.buildPayroll(fx.next.start, fx.next.end))!;
    const l = view.blocks.find((b) => b.shopId === fx.moline)!.lines.find((x) => x.staffId === fx.jamie)!;
    expect(l.ptoHours).toBe(0);
    expect(view.anomalies.filter((a) => a.kind === "hours_source" && a.staffId === fx.jamie)).toHaveLength(1);
    expect(await run.setOverride(fx.moline, fx.next.start, fx.jamie, "ptoHours", 4, "Approved in iSolved", actor)).toBeNull();
    const again = (await run.buildPayroll(fx.next.start, fx.next.end))!.blocks.find((b) => b.shopId === fx.moline)!.lines.find((x) => x.staffId === fx.jamie)!;
    expect(again.ptoHours).toBe(4);
    await brandSettings({ payroll: { ...(await run.loadSettings()), ptoSource: "both" } });
  });
});
