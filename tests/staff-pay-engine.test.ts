/**
 * The staff app's pay is the Payroll Report's (claude bot's PR #7 review): /api/staff/v1 earnings read
 * the lines buildPayroll makes (overtimeSlices, then computeLine) through payFromReport, and never
 * work out the greater-of, overtime or commission themselves. Product commission is on top of the
 * greater-of, never inside it. Golden: $200 hourly against $150 service commission, plus $10 product
 * commission, pays $210 in the report, the staff API and the iSolved file. Then the contract: for
 * every employee in the golden fixtures, the staff API's pay equals the report and the file to the cent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAYROLL_SETTINGS, EXPORT_COLUMNS, LOCATIONS_COLUMNS, assemble, computeLine, employeePay, toCents, type Line, type LineInput, type ShopBlock } from "@/domain/payroll/calc";
import { payFromReport } from "@/domain/my-earnings";
import { locationsRow } from "@/server/payroll/locations";
import { FIXTURES, load } from "./payroll-golden-fixtures";

const input = (over: Partial<LineInput> = {}): LineInput => ({
  staffId: "dana",
  name: "Dana",
  shopId: "coralville",
  employeeNumber: "9010",
  keyIsText: false,
  isolvedName: "SAMPLE, DANA",
  hourlyRate: 20,
  servicePct: 0.4,
  productPct: 0.1,
  trainingRate: 10,
  workedHours: 10,
  otHours: 0,
  ptoHours: 0,
  trainingHours: 0,
  serviceSales: 375,
  productSales: 100,
  tips: 0,
  ...over,
});
const blockOf = (inputs: LineInput[]) => assemble([{ shopId: "coralville", shop: "Coralville", inputs }], DEFAULT_PAYROLL_SETTINGS).blocks;
const col = (header: (typeof EXPORT_COLUMNS)[number]["header"]) => EXPORT_COLUMNS.findIndex((c) => c.header === header);
/** What iSolved pays for an export row: the hour columns at the rate (OT at 1.5x, training at its rate), the dollar columns as they are. */
const isolvedPays = (v: readonly number[], rate: number, trainingRate: number) =>
  toCents(v[col("E_Regular_Hours")] * rate) +
  toCents(v[col("E_Overtime 1.5_Hours")] * 1.5 * rate) +
  toCents(v[col("E_Comm Sales_Dollars")]) +
  toCents(v[col("E_Ray'z Paid Time_Hours")] * rate) +
  toCents(v[col("E_Training_Hours")] * trainingRate);

describe("golden: $200 hourly vs $150 service commission, plus $10 product commission, pays $210", () => {
  const [b] = blockOf([input()]);
  const l = b.lines[0];

  it("the Payroll Report: hourly is the greater side, and product commission is added on top of it, not inside the max", () => {
    expect(l).toMatchObject({ hourlyTotal: 200, commission: 150, serviceTotal: -50, productTotal: 10, netComm: 10, totalWages: 210, otHours: 0 });
    expect(l.totalWages).not.toBe(Math.max(200, 150 + 10));
  });

  it("the iSolved file: 10 regular hours and $10 Comm Sales, which iSolved pays as $210", () => {
    expect(b.exportRows[0].values).toEqual([10, 0, 0, 10, 0, 0]);
    expect(isolvedPays(b.exportRows[0].values, 20, 10)).toBe(21_000);
  });

  it("the staff API (payFromReport): greater-of $200, product commission $10 on top, $210 in wages and gross", () => {
    const { total, byShop } = payFromReport([b], "dana");
    expect(total.wages).toMatchObject({
      appliedRule: "hourly",
      explanationCode: "hourly_higher",
      hourlyPayCents: 20_000,
      serviceCommissionCents: 15_000,
      productCommissionCents: 1_000,
      greaterOfCents: 20_000,
      topUpCents: 5_000,
      commSalesCents: 1_000,
      otEstimatedCents: 0,
      wagesCents: 21_000,
    });
    expect(total.grossCents).toBe(21_000);
    expect(total.wages.greaterOfCents + total.wages.productCommissionCents).toBe(21_000);
    expect(byShop.get("coralville")).toBe(l);
  });

  it("the other way round: $250 service commission beats $200 hourly, and the $10 product commission is still on top: $260", () => {
    const [c] = blockOf([input({ serviceSales: 625 })]);
    expect(c.lines[0]).toMatchObject({ totalWages: 260, netComm: 60 });
    expect(isolvedPays(c.exportRows[0].values, 20, 10)).toBe(26_000);
    expect(payFromReport([c], "dana").total.wages).toMatchObject({ appliedRule: "commission", greaterOfCents: 25_000, productCommissionCents: 1_000, wagesCents: 26_000 });
  });

  it("with overtime and training: OT and training pay are the report's, outside the greater-of; the file pays the same", () => {
    const [c] = blockOf([input({ workedHours: 42, otHours: 2, trainingHours: 3, serviceSales: 375 })]);
    const x = c.lines[0];
    const w = payFromReport([c], "dana").total.wages;
    expect([w.hourlyPayCents, w.greaterOfCents, w.otEstimatedCents, w.trainingPayCents, w.productCommissionCents]).toEqual([toCents(x.hourlyTotal), toCents(Math.max(x.hourlyTotal, x.commission)), toCents(x.otPay), toCents(x.trainingPay), 1_000]);
    expect(w.wagesCents).toBe(w.greaterOfCents + w.productCommissionCents + w.otEstimatedCents + w.trainingPayCents);
    expect(w.wagesCents).toBe(isolvedPays(c.exportRows[0].values, 20, 10));
  });
});

const cell = (l: Line, key: (typeof LOCATIONS_COLUMNS)[number]["key"]) => locationsRow(l)[LOCATIONS_COLUMNS.findIndex((c) => c.key === key)] as number;
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

for (const fx of FIXTURES)
  describe.skipIf(!fx.present)(`the staff API's pay = the Payroll Report = the iSolved file, every golden employee (${fx.name})`, () => {
    // One employee per iSolved employee number, so someone on two shops' tabs is one person with two lines.
    const g = fx.present ? load(fx.dir, (i) => ({ ...i, staffId: i.employeeNumber ? `emp:${i.employeeNumber}` : i.staffId })) : null;
    const blocks: ShopBlock[] = g?.blocks ?? [];
    const people = [...new Set(blocks.flatMap((b) => b.lines.map((l) => l.staffId)))];
    const rowsOf = (id: string) => blocks.flatMap((b) => b.lines.filter((l) => l.staffId === id).map((l) => ({ b, l, values: b.exportRows.find((r) => r.staffId === id)!.values })));

    it("has employees, some of them on more than one shop", () => {
      expect(people.length).toBeGreaterThan(10);
    });

    it("each shop's figures are that line of the report, exactly", () => {
      for (const id of people) {
        const { byShop } = payFromReport(blocks, id);
        for (const { b, l } of rowsOf(id)) expect(byShop.get(b.shopId), id).toBe(l);
      }
    });

    it("hours, hourly pay, commission, the greater-of, OT, training, tips and gross: the report's to the cent, every shop added up", () => {
      for (const id of people) {
        const rows = rowsOf(id);
        const { total } = payFromReport(blocks, id);
        const w = total.wages;
        const C = (key: (typeof LOCATIONS_COLUMNS)[number]["key"]) => sum(rows, (r) => toCents(cell(r.l, key)));
        expect(w.hourlyPayCents, id).toBe(C("hourlyTotal"));
        expect(w.serviceCommissionCents, id).toBe(C("commission"));
        expect(w.productCommissionCents, id).toBe(sum(rows, (r) => toCents(r.l.productTotal)));
        expect(w.commSalesCents, id).toBe(C("netComm"));
        expect(w.otEstimatedCents, id).toBe(sum(rows, (r) => toCents(r.l.otPay)));
        expect(w.trainingPayCents, id).toBe(sum(rows, (r) => toCents(r.l.trainingPay)));
        expect(total.tipsCents, id).toBe(C("tips"));
        expect(w.greaterOfCents, id).toBe(sum(rows, (r) => employeePay(r.l).greaterOfCents));
        expect(total.hours.otHours, id).toBeCloseTo(sum(rows, (r) => r.l.otHours), 9);
        expect(total.hours.regularHours, id).toBeCloseTo(sum(rows, (r) => r.l.hours), 9);
        // Total Wages (N) is rounded once, the paycheck rounds D and M each; a NetComm typed on the report isn't in N.
        for (const { l } of rows) if (!l.overridden.includes("netComm")) expect(Math.abs(employeePay(l).hourlyPayCents + employeePay(l).commSalesCents - toCents(cell(l, "totalWages"))), id).toBeLessThanOrEqual(1);
      }
    });

    it("what iSolved pays for their rows of the file is their wages in the staff API, to the cent", () => {
      for (const id of people) {
        const rows = rowsOf(id);
        const { total } = payFromReport(blocks, id);
        const pays = sum(rows, (r) => {
          const p = employeePay(r.l);
          return isolvedPays(r.values, p.hourlyRateCents / 100, (p.trainingRateCents ?? p.hourlyRateCents) / 100);
        });
        expect(total.wages.wagesCents, id).toBe(pays + total.wages.guaranteeTopUpCents + total.wages.otPremiumCents);
        expect(total.tipsCents + total.declaredCashTipsCents, id).toBe(sum(rows, (r) => toCents(r.values[col("E_Cash Tips Recd_Dollars")])));
        expect(total.grossCents, id).toBe(total.wages.wagesCents + total.tipsCents + total.declaredCashTipsCents);
      }
    });
  });

describe("the staff API has no pay engine of its own", () => {
  const dir = path.join(__dirname, "../src/server/staff-api");
  const src = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const files = ["earnings.ts", "money.ts", "pay.ts", "app-contract.ts", "handlers.ts"];

  it("no overtime, line or commission engine is called from it: only the report's run (buildPayroll) and payFromReport", () => {
    for (const f of files) {
      const s = src(f);
      for (const engine of ["computeLine", "overtimeSlices", "dailyHours", "commissionBetween", "regularRateAdjustments", "assemble("]) expect(s.includes(engine), `${f}: ${engine}`).toBe(false);
    }
    expect(src("earnings.ts")).toMatch(/payFromReport\(theirBlocks\(view, per\), me\)/);
    expect(src("earnings.ts")).toMatch(/payFromReport\(theirBlocks\(view, per\), staffId\)/);
    expect(src("money.ts")).toMatch(/await myPayOver\(me, from, to\)/);
  });

  it("no greater-of worked out there: no max of hourly pay against commission", () => {
    for (const f of files) expect(src(f), f).not.toMatch(/Math\.max\([^)]*(hourly|commission|serviceTotal)/i);
  });

  it("training counts toward OT by default (Q11, pending CPA confirmation)", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.trainingCountsTowardOt).toBe(true);
    expect(computeLine(input({ workedHours: 38, trainingHours: 4, otHours: 2, trainingOtHours: 4 * (2 / 42) }), DEFAULT_PAYROLL_SETTINGS)).toMatchObject({ otHours: 2, trainingHours: 4, trainingPay: 40 });
  });
});
