/**
 * The payroll reports (Reports → Payroll) against a real database: brand-only by default and never
 * on a shop login; the summary, commission and labor reports tying to the Payroll Report to the
 * cent; full time above 32 hours a week and the overtime watch; punches, edits and approvals on the
 * timesheet detail; the iSolved file per pay period going draft → approved → sent (refused until
 * locked and reconciled, undoable with a reason, audited); the workbook with a tab per shop; PDF
 * export; and a shop's view never naming another shop.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportTable } from "@/domain/report-views";
import type { IsolvedPeriod } from "@/server/payroll/reports";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let P: typeof import("@/domain/permissions");
let tc: typeof import("@/server/time-clock");
let isolved: typeof import("@/app/admin/reports/payroll/isolved/actions");
let fileRoute: typeof import("@/app/admin/reports/payroll/isolved/file/route");
let exportRoute: typeof import("@/app/admin/reports/export/route");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const fx = { a: "", b: "", aLabel: "", bLabel: "", moline: "", start: "", end: "", tipSale: "" };
const cash = { method: "cash" as const, cashTenderedCents: null };
const at = (d: string, h = 12) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);
const day = (n: number) => m.time.addDays(fx.start, n);
const PAGES = ["summary", "timesheets", "tips", "commission", "full-time", "labor-cost", "overtime", "isolved", "tips-paid", "w2-codes", "fica-tip-credit", "paid-leave"];
const OTHER_SHOPS = ["Rock Island", "Coralville", "Dubuque", "Kimberly", "Le Claire", "Silvis", "Utica"];

async function sell(staffId: string, d: string, o: { product?: boolean; tipCents?: number; with?: string } = {}) {
  const sale = await m.checkout.openBlankSale(fx.moline, actor, staffId);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const svc = (await m.catalog.shopCatalog(fx.moline)).find((s) => s.slug === "rayz-cut-shampoo")!;
  const product = ctx.retail.find((p) => p.stock > 0)!;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [
      { kind: "service", refId: svc.id, qty: 1 },
      ...(o.with ? [{ kind: "service" as const, refId: svc.id, qty: 1, staffId: o.with }] : []),
      ...(o.product ? [{ kind: "product" as const, refId: product.productId, qty: 1 }] : []),
    ],
    tipCents: o.tipCents ?? 0,
    tipSplit: o.with ? "even" : undefined,
    tender: cash,
    actor,
    now: at(d),
  });
  return sale.id;
}

/** `hours` a day starting at 8 on each of the days. */
const worked = (staffId: string, days: string[], hours: number) => days.map((d) => ({ staffId, shopId: fx.moline, kind: "worked" as const, startsAt: at(d, 8), endsAt: at(d, 8 + hours) }));

async function report(key: Parameters<typeof L.loadReport>[0], o: { shop?: string[]; preset?: string; from?: string; to?: string; params?: Record<string, string> } = {}) {
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const rctx = await (await import("@/server/report-access")).reportContext(ctx, key);
  const scope = await S.resolveScope(rctx, { shop: o.shop ?? [fx.moline], ...(o.from ? { from: o.from, to: o.to } : { preset: o.preset ?? `pp:${fx.start}_${fx.end}` }) }, key);
  return { scope, data: await L.loadReport(key, { scope, loc: scope.loc, viewer: rctx, params: o.params ?? {} }) };
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id)!;
const col = (t: ReportTable, label: string) => {
  const j = t.columns.findIndex((c) => c.label === label);
  if (j < 0) throw new Error(`No column ${label} in ${t.id}: ${t.columns.map((c) => c.label).join(", ")}`);
  return j;
};
const body = (t: ReportTable) => t.rows.filter((_, i) => !t.rowStyles?.[i]);
const rowOf = (t: ReportTable, label: string) => body(t).find((r) => r[0] === label)!;
const molineLines = async () => (await run.buildPayroll(fx.start, fx.end))!.blocks.find((b) => b.shopId === fx.moline)!.lines;
const cents = (x: number) => Math.round(x * 100);

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  P = await import("@/domain/permissions");
  tc = await import("@/server/time-clock");
  isolved = await import("@/app/admin/reports/payroll/isolved/actions");
  fileRoute = await import("@/app/admin/reports/payroll/isolved/file/route");
  exportRoute = await import("@/app/admin/reports/export/route");
  for (const l of ["owner", "admin", "manager.moline", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;

  const links = await m.db.db
    .select({ id: m.schema.staff.id, label: m.schema.staff.displayLabel, n: m.drizzle.sql<number>`(select count(*) from staff_shops x where x.staff_id = ${m.schema.staff.id})::int` })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  const solo = links.filter((l) => l.n === 1 && !Object.values(ids).includes(l.id));
  [fx.a, fx.b, fx.aLabel, fx.bLabel] = [solo[0].id, solo[1].id, solo[0].label, solo[1].label];

  // A Moline pay period the seed never reaches. A works 45 hours the first week (5 overtime) and 40
  // the second, after 40-hour weeks before it: full time. B works 24 and then 37: part time, close.
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.moline)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2027-06-16");
  [fx.start, fx.end] = [p.start, p.end];
  const days = (from: number, n: number) => Array.from({ length: n }, (_, k) => day(from + k));
  const entries = [
    ...worked(fx.a, days(-14, 5), 8),
    ...worked(fx.a, days(-7, 5), 8),
    ...worked(fx.a, days(0, 5), 9),
    ...worked(fx.a, days(7, 5), 8),
    ...worked(fx.b, days(1, 3), 8),
    ...worked(fx.b, [...days(8, 4), day(12)], 7.4),
  ];
  expect(await run.addTimeEntries(entries, actor)).toMatchObject({ added: entries.length });
  expect(await run.saveRate(fx.a, null, { hourlyRate: 15, servicePct: 0.5, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
  expect(await run.saveRate(fx.b, null, { hourlyRate: 12, servicePct: 0.3, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
  fx.tipSale = await sell(fx.a, day(1), { product: true, tipCents: 700, with: fx.b });
  await sell(fx.a, day(2));
  await sell(fx.b, day(3), { tipCents: 300 });
  await signInAs(ids.owner);
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("who can see them", () => {
  it("brand owner, brand admin and bookkeeper by default; no location role; never a shop login", async () => {
    const keys = P.PAYROLL_REPORTS.flatMap((k) => [P.reportView(k), P.reportExport(k)]);
    expect(keys).toHaveLength(24);
    for (const t of P.ROLE_TEMPLATES) {
      const has = keys.filter((k) => t.permissions.includes(k));
      expect([t.key, has.length]).toEqual([t.key, ["brand_owner", "brand_admin", "bookkeeper"].includes(t.key) ? 24 : 0]);
    }
    for (const k of keys) expect(P.SHOP_LOGIN_NEVER.has(k)).toBe(true);
    const roles = await m.db.db.select({ key: m.schema.roles.key, permissions: m.schema.roles.permissions }).from(m.schema.roles);
    for (const r of roles.filter((x) => x.key !== P.OWNER_ROLE_KEY))
      expect([r.key, keys.filter((k) => (r.permissions as string[]).includes(k)).length]).toEqual([r.key, ["brand_admin", "bookkeeper"].includes(r.key ?? "") ? 24 : 0]);

    await signInAs(ids["manager.moline"]);
    for (const p of PAGES) expect([p, (await open(`/admin/reports/payroll/${p}`)).kind]).toEqual([p, "denied"]);
    await signInAs(ids.owner);
    for (const p of PAGES) {
      const page = await open(`/admin/reports/payroll/${p}`, {}, { preset: `pp:${fx.start}_${fx.end}`, shop: fx.moline });
      expect([p, page.kind]).toEqual([p, "ok"]);
      if (p !== "isolved") expect([p, page.text?.includes(fx.aLabel)]).toEqual([p, true]);
    }
  });
});

describe("payroll summary", () => {
  it("per employee: hours from the time clock, rate, pay, commission, tips, and the total to iSolved, to the cent", async () => {
    const lines = await molineLines();
    const a = lines.find((l) => l.staffId === fx.a)!;
    expect([a.hours, a.otHours]).toEqual([80, 5]);
    const { data } = await report("payroll_summary");
    const t = table(data, "employees");
    const row = rowOf(t, fx.aLabel);
    expect(row[col(t, "Regular hours")]).toBe(80);
    expect(row[col(t, "OT hours")]).toBe(5);
    expect(row[col(t, "Hourly rate")]).toBe(1500);
    expect(row[col(t, "Gross hourly pay")]).toBe(cents(a.hourlyTotal) + cents(a.otPay));
    expect(row[col(t, "Service commission")]).toBe(cents(a.commission));
    expect(row[col(t, "Product commission")]).toBe(cents(a.productTotal));
    expect(row[col(t, "Commission to iSolved (E_Comm Sales)")]).toBe(cents(a.netComm));
    expect(Number(row[col(t, "Card tips")]) + Number(row[col(t, "Cash tips")]) + Number(row[col(t, "Tip adjustments")])).toBe(cents(a.tips));
    expect(row[col(t, "Cash tips")]).toBe(350);
    expect(row[col(t, "Total to iSolved")]).toBe(cents(a.laborCost) + cents(a.tips));
    const all = lines.reduce((s, l) => s + cents(l.laborCost) + cents(l.tips), 0);
    expect(body(t).reduce((s, r) => s + Number(r[col(t, "Total to iSolved")]), 0)).toBe(all);
    expect(data.stats.find((s) => s.label === "Pay periods")?.hint).toBe("Draft");
  });

  it("hides rates, hourly pay and the total without See pay rates and labor cost", async () => {
    await signInAs(ids.admin);
    const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
    const { data } = await report("payroll_summary");
    const labels = table(data, "employees").columns.map((c) => c.label);
    expect(labels.includes("Hourly rate")).toBe(ctx.permissions.has("payroll.rates"));
    expect(labels.includes("Total to iSolved")).toBe(ctx.permissions.has("payroll.rates"));
    await signInAs(ids.owner);
  });
});

describe("commission", () => {
  it("by service and product, each employee's lines adding up to their payroll commission to the cent", async () => {
    const lines = await molineLines();
    const { data } = await report("payroll_commission");
    const t = table(data, "items");
    for (const l of lines.filter((x) => [fx.a, fx.b].includes(x.staffId))) {
      const mine = body(t).filter((r) => r[0] === l.name);
      const sum = (type: string) => mine.filter((r) => r[2] === type).reduce((s, r) => s + Number(r[col(t, "Commission")]), 0);
      expect([l.name, sum("Service"), sum("Product")]).toEqual([l.name, cents(l.commission), cents(l.productTotal)]);
    }
    const cut = body(t).find((r) => r[0] === fx.aLabel && r[2] === "Service")!;
    expect(cut[col(t, "Rate")]).toBeCloseTo(0.5, 5);
    const e = table(data, "employees");
    expect(rowOf(e, fx.aLabel)[col(e, "Commission to iSolved (E_Comm Sales)")]).toBe(cents(lines.find((l) => l.staffId === fx.a)!.netComm));
  });
});

describe("labor cost vs sales", () => {
  it("each shop's labor cost as a percent of its revenue", async () => {
    const lines = await molineLines();
    const { data } = await report("payroll_labor");
    const t = table(data, "shops");
    const row = rowOf(t, "Moline");
    const labor = lines.reduce((s, l) => s + cents(l.laborCost), 0);
    const revenue = lines.reduce((s, l) => s + cents(l.service) + cents(l.product), 0);
    expect(row[col(t, "Labor cost")]).toBe(labor);
    expect(row[col(t, "Revenue")]).toBe(revenue);
    expect(row[col(t, "Labor % of revenue")]).toBeCloseTo(labor / revenue, 6);
  });
});

describe("full time and overtime", () => {
  it("flags people averaging more than 32 hours a week", async () => {
    const { data } = await report("payroll_full_time");
    const t = table(data, "employees");
    expect(rowOf(t, fx.aLabel)[col(t, "Status")]).toBe("Full time");
    expect(rowOf(t, fx.aLabel)[col(t, "Average a week")]).toBeCloseTo((40 + 40 + 45 + 40) / 4, 2);
    expect(rowOf(t, fx.bLabel)[col(t, "Status")]).toMatch(/Part time/);
    expect(data.bars?.[0].reference?.value).toBe(32 * 60);
  });

  it("watches overtime by workweek: over, close, and everyone with show=all", async () => {
    const { data } = await report("payroll_overtime", { from: fx.start, to: fx.end });
    const t = table(data, "weeks");
    const find = (label: string, week: string) => body(t).find((r) => r[1] === label && r[0] === week);
    expect(find(fx.aLabel, fx.start)?.[col(t, "Status")]).toBe("In overtime");
    expect(find(fx.aLabel, fx.start)?.[col(t, "OT hours")]).toBe(5);
    expect(find(fx.bLabel, day(7))?.[col(t, "Status")]).toBe("Close to overtime");
    expect(find(fx.bLabel, fx.start)).toBeUndefined();
    const all = table((await report("payroll_overtime", { from: fx.start, to: fx.end, params: { show: "all" } })).data, "weeks");
    expect(body(all).find((r) => r[1] === fx.bLabel && r[0] === fx.start)?.[col(all, "Status")]).toBe("Under");
  });
});

describe("tips", () => {
  it("card vs cash, pending, and how a shared ticket's tip was split", async () => {
    const { data } = await report("payroll_tips");
    const t = table(data, "employees");
    expect(rowOf(t, fx.aLabel)[col(t, "Cash tips")]).toBe(350);
    expect(rowOf(t, fx.bLabel)[col(t, "Cash tips")]).toBe(650);
    const splits = table(data, "splits");
    const mine = body(splits).filter((r) => [fx.aLabel, fx.bLabel].includes(String(r[3])));
    expect(mine.map((r) => [r[2], r[3], r[col(splits, "Share")]])).toEqual(
      expect.arrayContaining([
        ["Shared", fx.aLabel, 0.5],
        ["Shared", fx.bLabel, 0.5],
      ]),
    );
    expect(JSON.stringify(data.tables.map((x) => x.rows))).not.toMatch(/\b(acct|ba|card|pm)_[A-Za-z0-9]/);
  });
});

describe("W-2 codes and the 45B credit", () => {
  const byEmployee = (t: ReportTable, label: string) => body(t).find((r) => r[col(t, "Employee")] === label)!;

  it("qualified tips for code TP and the overtime premium for code TT, by workweek, tie to the Payroll Report", async () => {
    const a = (await molineLines()).find((l) => l.staffId === fx.a)!;
    const { data } = await report("payroll_w2_codes");
    const t = table(data, "employees");
    const row = byEmployee(t, fx.aLabel);
    expect(row[col(t, "Qualified tips, box 12 TP")]).toBe(cents(a.tips) + cents(a.declaredCashTips));
    expect(Number(row[col(t, "Charged tips (TP)")]) + Number(row[col(t, "Cash tips (TP)")])).toBe(cents(a.tips));
    expect(row[col(t, "Overtime hours")]).toBe(5);
    expect(row[col(t, "OT premium at base rate, box 12 TT")]).toBe(0.5 * 1500 * 5);
    expect(Number(row[col(t, "OT premium at blended regular rate")])).toBeGreaterThan(0.5 * 1500 * 5);
    expect(row[col(t, "Check")]).toMatch(/No tipped occupation code/);
    const weeks = table(data, "workweeks");
    const mine = body(weeks).filter((r) => r[col(weeks, "Employee")] === fx.aLabel);
    expect(mine.map((r) => [r[col(weeks, "Week of")], r[col(weeks, "Overtime hours")], r[col(weeks, "OT premium (TT)")]])).toEqual([[fx.start, 5, 3750]]);

    const have = await m.db.db.query.payrollProfiles.findFirst({ where: eq(m.schema.payrollProfiles.staffId, fx.a) });
    const prof = { employeeNumber: have?.employeeNumber ?? null, keyIsText: have?.keyIsText ?? false, isolvedName: have?.isolvedName ?? null, exportPosition: have?.exportPosition ?? null };
    expect(await run.saveProfile(fx.a, { ...prof, tippedOccupationCode: "BAR-BER" }, actor)).toMatch(/occupation code/);
    expect(await run.saveProfile(fx.a, { ...prof, tippedOccupationCode: "302" }, actor)).toBeNull();
    const again = table((await report("payroll_w2_codes")).data, "employees");
    expect(byEmployee(again, fx.aLabel)[col(again, "Tipped occupation code")]).toBe("302");
  });

  it("45B: tips over the $7.25 an hour floor count, at 7.65%, by month of the paycheck (ST-C13)", async () => {
    const a = (await molineLines()).find((l) => l.staffId === fx.a)!;
    const { data } = await report("payroll_fica_tip_credit");
    const t = table(data, "employees");
    const row = byEmployee(t, fx.aLabel);
    const hours = a.hours + a.otHours + a.trainingHours;
    expect(row[col(t, "Hours worked")]).toBe(hours);
    expect(row[col(t, "Cash wages")]).toBe(cents(a.laborCost));
    expect(row[col(t, "Reported tips")]).toBe(cents(a.tips));
    const shortfall = Math.max(0, Math.round(725 * hours) - cents(a.laborCost));
    expect(row[col(t, "Needed to reach the floor")]).toBe(shortfall);
    expect(row[col(t, "Tips that count")]).toBe(Math.max(0, cents(a.tips) - shortfall));
    expect(row[col(t, "Estimated credit")]).toBe(Math.round(Math.max(0, cents(a.tips) - shortfall) * 0.0765));
    // One pay period here, so its month has the same figures; the month nets every period paid in it.
    const months = table(data, "months");
    const mine = body(months).filter((r) => r[col(months, "Employee")] === fx.aLabel);
    expect(mine).toHaveLength(1);
    for (const h of ["Hours worked", "Reported tips", "Needed to reach the floor", "Tips that count", "Estimated credit"]) expect([h, mine[0][col(months, h)]]).toEqual([h, row[col(t, h)]]);
    expect(String(mine[0][col(months, "Month")])).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
  });
});

describe("Illinois and Iowa wage-hour rules (ST-I16)", () => {
  it("Moline is in Illinois: its minimum wage is checked, and the period splits by legal entity and work state", async () => {
    const v = (await run.buildPayroll(fx.start, fx.end))!;
    const moline = v.blocks.find((b) => b.shopId === fx.moline)!;
    expect(moline.workState).toBe("IL");
    const low = v.anomalies.filter((a) => a.kind === "below_minimum_wage" && a.shopId === fx.moline);
    expect(low.map((a) => a.staffId)).toContain(fx.b);
    expect(low.map((a) => a.staffId)).not.toContain(fx.a);
    expect(low.find((a) => a.staffId === fx.b)!.message).toMatch(/Illinois minimum wage of \$15\.00/);
    const il = v.byEntityState.find((r) => r.workState === "IL" && r.shops.includes("Moline"))!;
    expect(il.employer).toBe("Ray'z Inc.");
    expect(il.laborCost).toBeCloseTo(moline.totals.laborCost, 2);
    const ia = v.byEntityState.find((r) => r.workState === "IA");
    if (ia) expect(ia.shops).not.toContain("Moline");
  });

  it("Illinois paid leave: an hour per 40 worked at Illinois shops, to 40 a year, plus what carried in, less what was used", async () => {
    const { data } = await report("payroll_paid_leave", { from: `${fx.end.slice(0, 4)}-01-01`, to: fx.end });
    const t = table(data, "paid_leave");
    const row = body(t).find((r) => r[col(t, "Employee")] === fx.aLabel)!;
    expect(row[col(t, "State")]).toBe("IL");
    const worked = Number(row[col(t, "Hours worked")]);
    expect(worked).toBeGreaterThanOrEqual(165);
    expect(row[col(t, "Earned")]).toBe(Math.round(Math.min(40, worked / 40) * 100) / 100);
    expect(row[col(t, "Balance")]).toBeCloseTo(Number(row[col(t, "Carried in")]) + Number(row[col(t, "Earned")]) - Number(row[col(t, "Used")]), 2);
    const kimberly = (await m.catalog.getShop("kimberly"))!.id;
    const iowa = await report("payroll_paid_leave", { shop: [kimberly], from: `${fx.end.slice(0, 4)}-01-01`, to: fx.end });
    expect(body(table(iowa.data, "paid_leave")).filter((r) => r[0] !== "Total")).toEqual([]);
  });
});

describe("the iSolved export", () => {
  const periodOf = async () => ((await report("payroll_isolved")).data as unknown as { periods: IsolvedPeriod[] }).periods.find((p) => p.start === fx.start)!;
  const download = async (start = fx.start, end = fx.end) => fileRoute.GET(new Request(`http://localhost/admin/reports/payroll/isolved/file?start=${start}&end=${end}&shop=${fx.moline}`));
  const sends = () => m.db.db.select().from(m.schema.payrollExportSends).where(eq(m.schema.payrollExportSends.periodStart, fx.start));
  const audits = (action: string) => m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, action), eq(m.schema.auditLog.entityId, `${fx.start}_${fx.end}`)));

  it("previews the file row by row with tips matching the payouts, as a draft that can't be marked sent", async () => {
    const { data } = await report("payroll_isolved");
    const f = table(data, "file");
    const lines = await molineLines();
    const a = lines.find((l) => l.staffId === fx.a)!;
    const er = (await run.buildPayroll(fx.start, fx.end))!.blocks.find((b) => b.shopId === fx.moline)!.exportRows.find((r) => r.staffId === fx.a)!;
    const row = body(f).find((r) => r[1] === er.isolvedName)!;
    expect(row[col(f, "E_Regular_Hours")]).toBe(80);
    expect(row[col(f, "E_Overtime 1.5_Hours")]).toBe(5);
    expect(row[col(f, "E_Comm Sales_Dollars")]).toBe(cents(a.netComm));
    expect(["On file", "Missing"]).toContain(row[col(f, "Employee key")]);
    expect(JSON.stringify(f.rows)).not.toContain(a.input.employeeNumber || "\u0000");
    const p = await periodOf();
    expect(p).toMatchObject({ status: "draft", blocked: expect.stringMatching(/lock/) });
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toMatchObject({ ok: false, error: expect.stringMatching(/lock/) });
    expect(await sends()).toEqual([]);

    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/filename="DRAFT - iSolved - period \d+ /);
  });

  it("goes approved once locked, then sent; can't be sent twice; undo needs a reason; every step audited", async () => {
    expect(await run.approveAndLock(fx.start, fx.end, actor)).toMatchObject({ locked: expect.any(Number) });
    expect(await periodOf()).toMatchObject({ status: "approved", blocked: null });

    await signInAs(ids.makenna);
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toMatchObject({ ok: false });
    await signInAs(ids.owner);
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "Uploaded to iSolved")).toEqual({ ok: true, data: null });
    expect(await periodOf()).toMatchObject({ status: "sent", sentBy: expect.any(String) });
    const [sent] = await sends();
    expect(sent.shops.find((s) => s.shopId === fx.moline)).toMatchObject({ rows: expect.any(Number), headers: expect.arrayContaining(["E_Regular_Hours"]) });
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toMatchObject({ ok: false, error: expect.stringMatching(/already marked sent/) });
    expect(await audits("payroll.isolved_sent")).toHaveLength(1);

    const page = await open("/admin/reports/payroll/isolved", {}, { preset: `pp:${fx.start}_${fx.end}`, shop: fx.moline });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("iSolved export");
    expect(page.text).toContain("Sent to iSolved");

    expect(await isolved.undoIsolvedSentAction(fx.start, fx.end, "")).toMatchObject({ ok: false });
    expect(await isolved.undoIsolvedSentAction(fx.start, fx.end, "Upload bounced in iSolved")).toEqual({ ok: true, data: null });
    expect(await periodOf()).toMatchObject({ status: "approved" });
    expect(await audits("payroll.isolved_unsent")).toHaveLength(1);
    expect(await isolved.markIsolvedSentAction(fx.start, fx.end, "")).toEqual({ ok: true, data: null });
  });

  it("downloads one workbook with a tab per shop in the selection; refused without the permissions", async () => {
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/filename="iSolved - period \d+ \(.+\)\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
    expect(wb.worksheets).toHaveLength(1);
    const lines = await molineLines();
    expect(wb.worksheets[0].actualRowCount).toBeGreaterThanOrEqual(lines.length);
    expect(await audits("payroll.isolved_file")).toHaveLength(2);

    const brand = await fileRoute.GET(new Request(`http://localhost/admin/reports/payroll/isolved/file?start=${fx.start}&end=${fx.end}&shop=all`));
    const all = new ExcelJS.Workbook();
    await all.xlsx.load(Buffer.from(await brand.arrayBuffer()) as unknown as ExcelJS.Buffer);
    const blocks = (await run.buildPayroll(fx.start, fx.end))!.blocks;
    expect(all.worksheets).toHaveLength(blocks.length);
    expect(new Set(all.worksheets.map((w) => w.name)).size).toBe(blocks.length);

    expect((await download("2027-06-01", "2027-06-02")).status).toBe(404);
    await signInAs(ids["manager.moline"]);
    expect((await download()).status).toBe(403);
    await signInAs(ids.owner);
  });
});

describe("export and scope", () => {
  it("exports any payroll report as a PDF and CSV, audited", async () => {
    const q = `type=payroll_summary&preset=pp:${fx.start}_${fx.end}&shop=${fx.moline}`;
    const pdf = await exportRoute.GET(new Request(`http://localhost/admin/reports/export?${q}&format=pdf`));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const csv = await exportRoute.GET(new Request(`http://localhost/admin/reports/export?${q}&table=employees`));
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain(fx.aLabel);
  });

  it("a shop's view never names another shop", async () => {
    for (const key of P.PAYROLL_REPORTS) {
      const { data } = await report(key, key === "payroll_timesheets" || key === "payroll_overtime" ? { from: fx.start, to: fx.end } : {});
      const text = JSON.stringify(data.tables.map((t) => t.rows));
      expect([key, OTHER_SHOPS.filter((s) => text.includes(s))]).toEqual([key, []]);
    }
  });
});

describe("timesheet detail", () => {
  it("lists punches and breaks, every manager edit with its reason, and each timesheet's approvals", async () => {
    const d = m.time.addDays(fx.end, 7);
    const editor = { actor: { staffId: ids.owner, label: "Owner" }, staffId: ids.owner, isOwner: true, shopIds: [fx.moline] };
    const later = at(m.time.addDays(d, 1));
    for (const [type, h] of [
      ["in", 9],
      ["break_start", 12],
      ["break_end", 13],
      ["out", 17],
    ] as const)
      await tc.addPunch(editor, { staffId: fx.b, shopId: fx.moline, type, at: at(d, h) }, "Forgot to clock", later);
    const { data } = await report("payroll_timesheets", { from: d, to: d });
    const s = table(data, "shifts");
    const row = rowOf(table(data, "shifts"), d);
    expect(row[col(s, "Employee")]).toBe(fx.bLabel);
    expect(row[col(s, "Break minutes")]).toBe(60);
    expect(row[col(s, "Edited")]).toBe(true);
    const e = table(data, "edits");
    expect(body(e).filter((r) => r[col(e, "Employee")] === fx.bLabel && r[col(e, "Reason")] === "Forgot to clock")).toHaveLength(4);
    const ap = table(data, "approvals");
    expect(body(ap).find((r) => r[col(ap, "Employee")] === fx.bLabel)?.[col(ap, "Manager approved")]).toBe("Waiting");
  });
});
