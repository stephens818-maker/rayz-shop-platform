/**
 * Final pay off-cycle (N9): someone who leaves is paid for the pay period of their last day on their
 * own, by someone who didn't change the figures by hand. Each shop gets a one-row iSolved file; the
 * regular run leaves them out (nothing is paid twice) while the W-2 tip check still counts their
 * tips; anything that changes afterwards is flagged; the approval is never edited or deleted.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { open } from "./render";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let fp: typeof import("@/server/payroll/final-pay");
let actions: typeof import("@/app/admin/payroll/actions");
let fileRoute: typeof import("@/app/admin/payroll/final-pay/file/route");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { moline: "", jamie: "", other: "", start: "", end: "", lastDay: "", id: "", group: "" };
const at = (d: string, h: number) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  fp = await import("@/server/payroll/final-pay");
  actions = await import("@/app/admin/payroll/actions");
  fileRoute = await import("@/app/admin/payroll/final-pay/file/route");
  for (const l of ["owner", "admin", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  fx.jamie = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, "Jamie") }))!.id;
  const choices = await run.periodChoices();
  const prev = choices[choices.findIndex((c) => c.current) + 1];
  [fx.start, fx.end] = [prev.start, prev.end];
  fx.lastDay = m.time.addDays(fx.start, 4);
  expect(await run.saveRate(fx.jamie, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();
  expect(await run.saveProfile(fx.jamie, { employeeNumber: "9101", keyIsText: false, isolvedName: "JAMIE, TEST", exportPosition: null }, actor)).toBeNull();
  const days = [1, 2, 3].map((n) => m.time.addDays(fx.start, n));
  expect(await run.addTimeEntries(days.map((d) => ({ staffId: fx.jamie, shopId: fx.moline, kind: "worked" as const, startsAt: at(d, 9), endsAt: at(d, 17) })), actor)).toEqual({ added: 3 });
  const [other] = await m.db.db
    .select({ id: m.schema.staffShops.staffId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), m.drizzle.ne(m.schema.staff.id, fx.jamie)));
  fx.other = other.id;
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const moline = async () => (await run.buildPayroll(fx.start, fx.end))!;

describe("final pay off-cycle (N9)", () => {
  it("works out their figures for the period of their last day, as the Payroll Report has them", async () => {
    expect(await fp.previewFinalPay(fx.jamie, m.time.addDays(m.time.todayLocal(), 1))).toEqual({ error: expect.stringMatching(/can't be in the future/) });
    const p = await fp.previewFinalPay(fx.jamie, fx.lastDay);
    if ("error" in p) throw new Error(p.error);
    expect(p).toMatchObject({ start: fx.start, end: fx.end, lastDay: fx.lastDay });
    const x = p.shops.find((s) => s.shopId === fx.moline)!;
    expect(x.line.hours + x.line.otHours).toBeGreaterThanOrEqual(24);
    expect(x.exportRow).toMatchObject({ staffId: fx.jamie, key: 9101 });
    fx.group = x.payGroupId;
  });

  it("isn't approved by someone who changed the period's figures by hand", async () => {
    await signInAs(ids.admin);
    expect(await actions.addTimeEntryAction({ staffId: fx.other, shopId: fx.moline, kind: "worked", date: m.time.addDays(fx.start, 2), start: "09:00", end: "12:00", note: "Forgot to clock in" })).toEqual({ ok: true, data: 1 });
    expect(await actions.approveFinalPayAction({ staffId: fx.jamie, lastDay: fx.lastDay, note: "" })).toMatchObject({ ok: false, error: run.SELF_APPROVAL });
    await signInAs(ids.makenna);
    expect(await actions.approveFinalPayAction({ staffId: fx.jamie, lastDay: fx.lastDay, note: "" })).toMatchObject({ ok: false });
    expect(await m.db.db.select().from(m.schema.payrollFinalPays)).toEqual([]);
  });

  it("approves it once, recorded, and serves each shop's one-row iSolved file", async () => {
    await signInAs(ids.owner);
    const r = await actions.approveFinalPayAction({ staffId: fx.jamie, lastDay: fx.lastDay, note: "Moved away" });
    expect(r).toMatchObject({ ok: true });
    fx.id = (r as { data: string }).data;
    expect(await fp.previewFinalPay(fx.jamie, fx.lastDay)).toEqual({ error: expect.stringMatching(/final pay for .* was approved/) });
    const [logged] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.final_pay"));
    expect(logged.details).toMatchObject({ staffId: fx.jamie, lastDay: fx.lastDay, periodStart: fx.start, note: "Moved away" });

    const res = await fileRoute.GET(new Request(`http://localhost/admin/payroll/final-pay/file?${new URLSearchParams({ id: fx.id, group: fx.group })}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/final pay Jamie/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets[0];
    const keys: unknown[] = [];
    ws.eachRow((row, n) => {
      if (n > 1 && row.getCell(1).value !== null) keys.push(row.getCell(1).value);
    });
    expect(keys).toEqual([9101]);
    await signInAs(ids.makenna);
    expect((await fileRoute.GET(new Request(`http://localhost/admin/payroll/final-pay/file?${new URLSearchParams({ id: fx.id, group: fx.group })}`))).status).toBe(403);
  });

  it("the regular run leaves them out of the rows and files, flags it, and the tip check still balances for them", async () => {
    const v = await moline();
    const b = v.blocks.find((x) => x.shopId === fx.moline)!;
    expect(b.lines.map((l) => l.staffId)).not.toContain(fx.jamie);
    expect(b.exportRows.map((r) => r.staffId)).not.toContain(fx.jamie);
    expect(v.finalPays.map((f) => f.staffId)).toEqual([fx.jamie]);
    expect(v.anomalies.find((a) => a.kind === "final_pay")?.message).toMatch(/Jamie was paid off-cycle for this period \(final pay, last day/);
    expect(v.tips.mismatches.filter((x) => x.detail.includes("Jamie"))).toEqual([]);
    expect(v.mismatches.filter((x) => x.shopId === fx.moline && x.check !== "tips")).toEqual([]);
  });

  it("flags what changes after the final pay, to settle in iSolved", async () => {
    const d = m.time.addDays(fx.start, 5);
    expect(await run.addTimeEntries([{ staffId: fx.jamie, shopId: fx.moline, kind: "worked", startsAt: at(d, 9), endsAt: at(d, 13) }], actor)).toEqual({ added: 1 });
    const v = await moline();
    expect(v.finalPays[0].drift).toContainEqual(expect.objectContaining({ field: "workedHours", shop: "Moline" }));
    expect(v.anomalies.find((a) => a.kind === "final_pay_changed")?.message).toMatch(/Jamie \(Moline\): Hours worked was .* in their final pay and is .* now/);
  });

  it("is kept as approved: never changed or deleted", async () => {
    const t = m.schema.payrollFinalPays;
    await expect(m.db.db.update(t).set({ note: "edited" }).where(eq(t.id, fx.id))).rejects.toThrow();
    await expect(m.db.db.delete(t).where(eq(t.id, fx.id))).rejects.toThrow();
  });

  it("lists it on the Final pay page with each shop's file", async () => {
    await signInAs(ids.owner);
    const page = await open("/admin/payroll/final-pay");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Approved final pays");
    expect(page.text).toContain("Moline file");
  });
});
