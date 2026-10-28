/**
 * The staff app's pay is the Payroll Report's (claude bot's PR #7 review), against a real database:
 * /api/staff/v1 earnings read the lines buildPayroll makes, and never work out the greater-of or OT
 * themselves. Golden: $200 hourly against $150 service commission, plus $10 product commission on
 * top (not inside the max), pays $210 in the Payroll Report, the iSolved file, GET /me/earnings,
 * GET /earnings and the earnings CSV. Then Q11 (pending CPA confirmation): 38 production hours plus 4
 * training hours in one Chicago Sun–Sat workweek is 2 OT hours in the report and the app alike, and
 * the same 4 training hours in the next workweek are none.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let api: Awaited<ReturnType<typeof staffApp>>;
let token = "";
let today = "";
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const shop: Record<string, string> = {};
const ids: Record<string, string> = {};
const weeks = { same: { start: "", end: "" }, next: { start: "", end: "" } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const span = (d: string, fromMin: number, toMin: number) => ({ startsAt: m.time.zonedWallTime(d, fromMin).toJSDate(), endsAt: m.time.zonedWallTime(d, toMin).toJSDate() });
const get = async (p: string) => {
  const r = await api.call("GET", p, { token });
  expect(r.status, `${p} ${r.text}`).toBe(200);
  return r.json as J;
};
const lineOf = async (from: string, to: string) => {
  const v = (await run.buildPayroll(from, to, { clockChecks: false }))!;
  const b = v.blocks.find((x) => x.shopId === shop.coralville)!;
  return { line: b.lines.find((l) => l.staffId === ids.dana)!, row: b.exportRows.find((r) => r.staffId === ids.dana)!.values, view: v };
};

async function isolvedRow(from: string, to: string, isolvedName: string) {
  const { isolvedWorkbook } = await import("@/server/payroll/reports");
  const file = (await isolvedWorkbook(from, to, [shop.coralville]))!;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.body as never);
  const rows = wb.worksheets.flatMap((ws) => {
    const out: (string | number | null)[][] = [];
    ws.eachRow((row) => void out.push((row.values as ExcelJS.CellValue[]).slice(1).map((v) => (v === undefined || v === null ? null : typeof v === "number" ? v : String(v)))));
    return out;
  });
  const header = rows.find((x) => x.includes("E_Regular_Hours"))!;
  const mine = rows.find((x) => x.includes(isolvedName))!;
  expect(mine, isolvedName).toBeTruthy();
  return (h: string) => Number(mine[header.indexOf(h)] ?? 0);
}

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  api = await staffApp();
  today = m.time.todayLocal();
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  const seeded = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;

  // A barber with no seeded history, so the period holds only what's rung up here.
  const [dana] = await m.db.db
    .insert(m.schema.staff)
    .values({ staffCode: "PE-DANA", firstName: "Dana", displayLabel: "Dana", publicSlug: "pe-dana", email: "dana@rayz.test", passwordHash: seeded.passwordHash, roleId: seeded.roleId, shopScope: seeded.shopScope, isBookable: true, permissionOverrides: { "compensation.own": true } })
    .returning();
  ids.dana = dana.id;
  await m.db.db.insert(m.schema.staffShops).values({ staffId: dana.id, shopId: shop.coralville, isPrimary: true });
  if (seeded.shopScope !== "all") await m.db.db.insert(m.schema.staffAccessShops).values({ staffId: dana.id, shopId: shop.coralville });
  expect(await run.saveRate(dana.id, null, { hourlyRate: 20, servicePct: 0.4, productPct: 0.1, trainingRate: 10 }, actor)).toBeNull();

  // Today: 10 hours, and one ticket of a $375 service and a $100 product.
  await m.db.db.insert(m.schema.timeEntries).values({ staffId: dana.id, shopId: shop.coralville, ...span(today, 30, 630), source: "manual" });
  const sale = await m.checkout.openBlankSale(shop.coralville, actor, dana.id);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const svc = (await m.catalog.shopCatalog(shop.coralville)).find((x) => x.slug === "rayz-cut-shampoo")!;
  const product = ctx.retail.find((p) => p.stock > 0)!;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [
      { kind: "service", refId: svc.id, qty: 1, priceOverride: { unitPriceCents: 37_500, reason: "golden test" } },
      { kind: "product", refId: product.productId, qty: 1, priceOverride: { unitPriceCents: 10_000, reason: "golden test" } },
    ],
    tipCents: 0,
    tender: { method: "cash", cashTenderedCents: null },
    canOverridePrice: true,
    actor,
  });

  // Two pay periods no other test reaches, each two Chicago workweeks from a Sunday. In each, Monday
  // to Thursday 9:00–6:30 is 38 production hours; then a 4-hour class, on the first week's Saturday
  // in one and the second week's Monday in the other.
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const a = periodOf(g.calendar, "2031-06-11");
  const b = periodOf(g.calendar, m.time.addDays(a.end, 1));
  weeks.same = { start: a.start, end: a.end };
  weeks.next = { start: b.start, end: b.end };
  const entries = [weeks.same, weeks.next].flatMap((p, i) => [
    ...[1, 2, 3, 4].map((n) => ({ staffId: dana.id, shopId: shop.coralville, kind: "worked" as const, ...span(m.time.addDays(p.start, n), 9 * 60, 18 * 60 + 30) })),
    { staffId: dana.id, shopId: shop.coralville, kind: "training" as const, ...span(m.time.addDays(p.start, i === 0 ? 6 : 8), 9 * 60, 13 * 60) },
  ]);
  for (const p of [weeks.same, weeks.next]) expect([new Date(`${p.start}T12:00:00Z`).getUTCDay(), m.time.addDays(p.start, 13)]).toEqual([0, p.end]);
  expect(await run.addTimeEntries(entries, actor)).toEqual({ added: entries.length });
  token = (await api.login("dana@rayz.test")).accessToken;
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("golden: $200 hourly vs $150 service commission, plus $10 product commission, pays $210 everywhere", () => {
  it("the Payroll Report: hourly is the greater side, product commission on top of it: Total Wages $210, NetComm $10", async () => {
    const e = await get("me/earnings?period=current");
    const { line, view } = await lineOf(e.from, e.to);
    expect(line.input).toMatchObject({ serviceSales: 375, productSales: 100 });
    expect(line).toMatchObject({ hours: 10, otHours: 0, hourlyTotal: 200, commission: 150, serviceTotal: -50, productTotal: 10, netComm: 10, totalWages: 210 });
    const { payrollReportData } = await import("@/server/payroll/reports");
    const report = await payrollReportData({ scope: { shopIds: [shop.coralville], from: e.from, to: e.to }, loc: { view: "combined", shops: [{ id: shop.coralville, name: "Coralville" }] } as never, perms: new Set(["payroll.rates"]) as never });
    const table = report.tables.find((t) => t.id === `loc-${e.from}_${e.to}-${shop.coralville}`)!;
    const labels = table.columns.map((c) => c.label);
    const row = (table.rows as J[][]).find((x) => x[0] === "Dana")!;
    const R = (label: string) => row[labels.indexOf(label)] as number;
    expect([R("Hourly Total"), R("Commission$"), R("Product Total"), R("NetComm"), R("Total Wages")]).toEqual([20_000, 15_000, 1_000, 1_000, 21_000]);
    expect(view.mismatches).toEqual([]);
  });

  it("the iSolved file: 10 regular hours and $10 Comm Sales, which iSolved pays as $210", async () => {
    const e = await get("me/earnings?period=current");
    const { row } = await lineOf(e.from, e.to);
    expect(row).toEqual([10, 0, 0, 10, 0, 0]);
    const f = await isolvedRow(e.from, e.to, "DANA");
    expect([f("E_Regular_Hours"), f("E_Overtime 1.5_Hours"), f("E_Comm Sales_Dollars")]).toEqual([10, 0, 10]);
    expect(f("E_Regular_Hours") * 20 + f("E_Comm Sales_Dollars")).toBe(210);
  });

  it("GET /me/earnings: greater-of $200, product commission $10 on top, $210 wages, its line the report's", async () => {
    const e = await get("me/earnings?period=current");
    expect(e).toMatchObject({ appliedRule: "hourly", hourlyPayCents: 20_000, serviceCommissionCents: 15_000, productCommissionCents: 1_000, greaterOfCents: 20_000, topUpCents: 5_000, commSalesCents: 1_000, otEstimatedCents: 0, wagesCents: 21_000, totalCents: 21_000 });
    const { employeePay } = await import("@/domain/payroll/calc");
    const { line } = await lineOf(e.from, e.to);
    expect(e.shops.find((x: J) => x.shopId === shop.coralville).pay).toEqual(JSON.parse(JSON.stringify(employeePay(line))));
  });

  it("GET /earnings over the same dates: the same line, not a commission of its own", async () => {
    const e = await get("me/earnings?period=current");
    const r = await get(`earnings?from=${e.from}&to=${e.to}`);
    expect(r.commission).toEqual({ serviceCents: 15_000, productCents: 1_000, totalCents: 16_000 });
    expect(r.pay).toMatchObject({ appliedRule: "hourly", greaterOfCents: 20_000, productCommissionCents: 1_000, wagesCents: 21_000, isEstimate: true });
    for (const k of ["hourlyPayCents", "serviceCommissionCents", "productCommissionCents", "greaterOfCents", "topUpCents", "commSalesCents", "otEstimatedCents", "trainingPayCents", "wagesCents"]) expect(r.pay[k], k).toBe(e[k]);
  });

  it("the earnings CSV: greater-of $200 and $210 gross", async () => {
    const r = await api.call("GET", "me/earnings/report?period=current", { token });
    expect(r.status, r.text).toBe(200);
    const [, head, body] = r.text.trim().split("\n");
    const at = (k: string) => Number(body.split(",")[head.split(",").indexOf(k)]);
    expect([at("hourly_pay_cents"), at("service_commission_cents"), at("product_commission_cents"), at("top_up_cents"), at("greater_of_cents"), at("gross_total_cents")]).toEqual([20_000, 15_000, 1_000, 5_000, 20_000, 21_000]);
  });
});

describe("Q11 (pending CPA confirmation): training counts toward the 40 in its own Sun–Sat workweek", () => {
  it("on by default", async () => {
    expect((await run.loadSettings()).trainingCountsTowardOt).toBe(true);
  });

  it("38 production + 4 training in the same week: 2 OT hours in the report, the file and the app", async () => {
    const { start, end } = weeks.same;
    const { line, row } = await lineOf(start, end);
    expect(line).toMatchObject({ hours: 36, otHours: 2, trainingHours: 4, trainingPay: 40, otPay: 60, hourlyTotal: 720 });
    expect(row).toEqual([36, 2, 0, 0, 0, 4]);
    const e = await get(`me/earnings?periodId=${start}`);
    expect(e.workweeks[0]).toMatchObject({ weekStart: start, productionHours: 38, trainingHours: 4, basisHours: 42, otHours: 2 });
    expect([e.otHours, e.otEstimatedCents, e.trainingPayCents, e.greaterOfCents]).toEqual([2, 6_000, 4_000, 72_000]);
    expect(e.wagesCents).toBe(72_000 + 6_000 + 4_000);
    const r = await get(`earnings?from=${start}&to=${end}`);
    expect([r.pay.otEstimatedCents, r.pay.trainingPayCents, r.pay.wagesCents]).toEqual([6_000, 4_000, e.wagesCents]);
  });

  it("control: the same 4 training hours in the next week give 0 OT; each week is under 40", async () => {
    const { start, end } = weeks.next;
    const { line, row } = await lineOf(start, end);
    expect(line).toMatchObject({ hours: 38, otHours: 0, trainingHours: 4, trainingPay: 40, otPay: 0, trainingOtHours: 0, hourlyTotal: 760 });
    expect(row).toEqual([38, 0, 0, 0, 0, 4]);
    const e = await get(`me/earnings?periodId=${start}`);
    expect((e.workweeks as J[]).map((w) => [w.weekStart, w.basisHours, w.otHours])).toEqual([
      [start, 38, 0],
      [m.time.addDays(start, 7), 4, 0],
    ]);
    expect([e.otHours, e.otEstimatedCents, e.trainingPayCents, e.wagesCents]).toEqual([0, 0, 4_000, 76_000 + 4_000]);
    const r = await get(`earnings?from=${start}&to=${end}`);
    expect([r.pay.otEstimatedCents, r.pay.wagesCents]).toEqual([0, e.wagesCents]);
  });
});
