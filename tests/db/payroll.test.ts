/**
 * Payroll against a real database: cross-shop overtime from clocked time at two shops, OT pay in
 * labor cost, the reconciliation gate blocking approve-and-lock, the lock freezing hours and
 * overrides, the locked file (OT hours only), Dubuque on its own calendar, and who may lock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const START = "2026-12-13";
const END = "2026-12-26";
const at = (date: string, h: number) => DateTime.fromISO(date, { zone: "America/Chicago" }).set({ hour: h }).toJSDate();
const staffBy = async (label: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!;
const shop = (slug: string) => m.catalog.getShop(slug);

describe("payroll period", () => {
  it("splits one week's OT across two shops by share of hours and counts OT pay as labor cost", async () => {
    const jamie = await staffBy("Jamie");
    const moline = (await shop("moline"))!;
    const ri = (await shop("rock-island"))!;
    expect(await run.saveRate(jamie.id, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();
    const entries = [
      ...["2026-12-13", "2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17"].map((d) => ({ staffId: jamie.id, shopId: moline.id, kind: "worked" as const, startsAt: at(d, 9), endsAt: at(d, 14) })),
      ...["2026-12-18", "2026-12-19"].map((d) => ({ staffId: jamie.id, shopId: ri.id, kind: "worked" as const, startsAt: at(d, 8), endsAt: at(d, 18) })),
    ];
    expect(await run.addTimeEntries(entries, actor)).toEqual({ added: 7 });

    const v = (await run.buildPayroll(START, END))!;
    const line = (s: string) => v.blocks.find((b) => b.shopId === s)!.lines.find((l) => l.staffId === jamie.id)!;
    expect([line(moline.id).input.workedHours, line(moline.id).otHours, line(moline.id).hours]).toEqual([25, 2.78, 22.22]);
    expect([line(ri.id).input.workedHours, line(ri.id).otHours, line(ri.id).hours]).toEqual([20, 2.22, 17.78]);
    expect(line(moline.id).otPay).toBe(1.5 * 16 * 2.78);
    expect(line(moline.id).laborCost).toBe(line(moline.id).totalWages + 1.5 * 16 * 2.78);
    expect(v.weeks[jamie.id].find((w) => w.weekStart === START)).toMatchObject({ basis: 45, ot: 5 });
    expect(v.mismatches).toEqual([]);
    const mol = v.blocks.find((b) => b.shopId === moline.id)!;
    expect(mol.period).toMatchObject({ number: 1, checkDate: "2027-01-01" });
  });

  it("puts Dubuque in the same dates under its own period number", async () => {
    const v = (await run.buildPayroll("2026-11-29", "2026-12-12"))!;
    expect(v.blocks.find((b) => b.shop === "Dubuque")!.period).toMatchObject({ number: 5, checkDate: "2026-12-18" });
    expect(v.blocks.find((b) => b.shop === "Moline")!.period).toMatchObject({ number: 26, checkDate: "2026-12-18" });
  });

  it("blocks approve-and-lock while any total doesn't reconcile, and shows why", async () => {
    const moline = (await shop("moline"))!;
    const [a, b] = [await staffBy("Jamie"), await staffBy("Kat")];
    await run.savePayrollSettings({ ...(await run.loadSettings()), roundExport2dp: true }, actor);
    for (const s of [a, b]) expect(await run.setOverride(moline.id, START, s.id, "tips", 1.005, "test", actor)).toBeNull();
    const v = (await run.buildPayroll(START, END))!;
    expect(v.mismatches.map((x) => [x.check, x.column])).toContainEqual(["export", "E_Cash Tips Recd_Dollars"]);
    const r = await run.approveAndLock(START, END, actor);
    expect(r).toMatchObject({ error: expect.stringMatching(/don't reconcile/) });
    expect(await m.db.db.select().from(m.schema.payrollRuns)).toEqual([]);

    for (const s of [a, b]) await run.setOverride(moline.id, START, s.id, "tips", null, "", actor);
    await run.savePayrollSettings({ ...(await run.loadSettings()), roundExport2dp: false }, actor);
    expect((await run.buildPayroll(START, END))!.mismatches).toEqual([]);
  });

  it("only someone with Approve and lock can lock", async () => {
    const barber = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
    await signInAs(barber.id);
    expect(await actions.approveAndLockAction(START, END)).toMatchObject({ ok: false });
    expect(await m.db.db.select().from(m.schema.payrollRuns)).toEqual([]);
  });

  it("locks every shop in the period, freezes hours and overrides, and serves the approved file with OT hours only", async () => {
    const owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!;
    await signInAs(owner.id);
    const before = (await run.buildPayroll(START, END))!;
    expect(await actions.approveAndLockAction(START, END)).toEqual({ ok: true, data: before.blocks.length });
    expect(await run.approveAndLock(START, END, actor)).toEqual({ error: "This pay period is already locked." });

    const jamie = await staffBy("Jamie");
    const moline = (await shop("moline"))!;
    const after = (await run.buildPayroll(START, END))!;
    expect(after.locked).toBe("all");
    expect(after.blocks.find((b) => b.shopId === moline.id)!.totals).toEqual(before.blocks.find((b) => b.shopId === moline.id)!.totals);

    expect(await run.addTimeEntries([{ staffId: jamie.id, shopId: moline.id, kind: "worked", startsAt: at("2026-12-20", 9), endsAt: at("2026-12-20", 17) }], actor)).toEqual({
      error: "that pay period is locked.",
    });
    expect(await run.setOverride(moline.id, START, jamie.id, "tips", 5, "late", actor)).toBe("This pay period is locked.");
    expect((await run.buildPayroll(START, END))!.blocks.find((b) => b.shopId === moline.id)!.totals).toEqual(before.blocks.find((b) => b.shopId === moline.id)!.totals);

    const group = after.blocks.find((b) => b.shopId === moline.id)!.payGroupId;
    const f = (await run.lockedExport(group, START, END))!;
    expect(f.fileName).toBe("Moline - period 01 (2026-12-13 to 2026-12-26).xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Moline")!;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((c) => ws.getCell(1, c).value)).toEqual(["Key", null, "E_Regular_Hours", "E_Overtime 1.5_Hours", "E_Cash Tips Recd_Dollars", "E_Comm Sales_Dollars", "E_Ray'z Paid Time_Hours", "E_Training_Hours"]);
    const profile = (await m.db.db.query.payrollProfiles.findFirst({ where: eq(m.schema.payrollProfiles.staffId, jamie.id) }))!;
    let row = 0;
    ws.eachRow((r, n) => {
      if (n > 1 && String(r.getCell(1).value) === profile.employeeNumber) row = n;
    });
    expect(row).toBeGreaterThan(1);
    expect(ws.getCell(row, 3).value).toBe(22.22);
    expect(ws.getCell(row, 4).value).toBe(2.78);
    const values: unknown[] = [];
    ws.eachRow((r, n) => n > 1 && values.push(...(r.values as unknown[]).slice(3)));
    expect(values).not.toContain(1.5 * 16 * 2.78);

    const audits = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "payroll.lock"));
    expect(audits.length).toBe(before.blocks.length);
  });

  it("an unlocked period has nothing to download", async () => {
    const v = (await run.buildPayroll("2026-12-27", "2027-01-09"))!;
    expect(await run.lockedExport(v.blocks[0].payGroupId, "2026-12-27", "2027-01-09")).toBeNull();
  });
});
