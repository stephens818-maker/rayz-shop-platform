/**
 * The My Earnings contract against Charles's workbook: for every golden row (the committed anonymized
 * one, and the real one where it's on the machine), periodPay, the function GET /me/earnings sends,
 * equals that employee's row of the Payroll Report (Locations, A to S) and their row of the iSolved
 * file to the cent.
 */
import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, LOCATIONS_COLUMNS, exportRowChecks, toCents, type Line, type ShopBlock } from "@/domain/payroll/calc";
import { OT_PAY_LABEL, periodPay, trainingLine } from "@/domain/my-earnings";
import { locationsRow } from "@/server/payroll/locations";
import { FIXTURES, load } from "./payroll-golden-fixtures";

const cell = (l: Line, key: (typeof LOCATIONS_COLUMNS)[number]["key"]) => locationsRow(l)[LOCATIONS_COLUMNS.findIndex((c) => c.key === key)] as number;
const exported = (b: ShopBlock, l: Line, header: (typeof EXPORT_COLUMNS)[number]["header"]) => b.exportRows.find((r) => r.staffId === l.staffId)!.values[EXPORT_COLUMNS.findIndex((c) => c.header === header)];
const hrs = (x: number) => Math.round(x * 100);

for (const fx of FIXTURES)
  describe.skipIf(!fx.present)(`My Earnings = Payroll Report = iSolved, every golden row (${fx.name})`, () => {
    const rows = fx.present ? load(fx.dir).blocks.flatMap((b) => b.lines.map((l) => ({ b, l, where: `${b.shop} row ${b.lines.indexOf(l) + 1}` }))) : [];

    it("has rows, and every iSolved column of every row is the report's", () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const { b, l, where } of rows) expect(exportRowChecks(b, l).filter((c) => !c.matches), where).toEqual([]);
    });

    it("hours: regular (B), O.T. (Q), PTO (P) and training (S) are the report's and the file's", () => {
      for (const { b, l, where } of rows) {
        const { hours } = periodPay([l]);
        expect(hrs(hours.regularHours), where).toBe(hrs(cell(l, "hours")));
        expect(hrs(hours.regularHours), where).toBe(hrs(exported(b, l, "E_Regular_Hours")));
        expect(hrs(hours.otHours), where).toBe(hrs(cell(l, "otHours")));
        expect(hrs(hours.otHours), where).toBe(hrs(exported(b, l, "E_Overtime 1.5_Hours")));
        expect(hrs(hours.ptoHours), where).toBe(hrs(cell(l, "ptoHours")));
        expect(hrs(hours.ptoHours), where).toBe(hrs(exported(b, l, "E_Ray'z Paid Time_Hours")));
        expect(hrs(hours.trainingHours), where).toBe(hrs(cell(l, "trainingHours")));
        expect(hrs(hours.trainingHours), where).toBe(hrs(exported(b, l, "E_Training_Hours")));
      }
    });

    it("hourly pay is the report's Hourly Total (D) and the file's regular hours at their wage; Comm Sales is the report's NetComm (M) and the file's dollars", () => {
      for (const { b, l, where } of rows) {
        const { wages } = periodPay([l]);
        const rate = wages.hourlyRateCents! / 100;
        expect(wages.hourlyPayCents, where).toBe(toCents(cell(l, "hourlyTotal")));
        expect(wages.hourlyPayCents, where).toBe(toCents(exported(b, l, "E_Regular_Hours") * rate));
        expect(wages.commSalesCents, where).toBe(toCents(cell(l, "netComm")));
        expect(wages.commSalesCents, where).toBe(toCents(exported(b, l, "E_Comm Sales_Dollars")));
      }
    });

    it("the greater-of is the report's: commission applies only when Service Total (I) is above zero, and it pays the larger side", () => {
      for (const { l, where } of rows) {
        const { wages } = periodPay([l]);
        expect(wages.appliedRule, where).toBe(cell(l, "serviceTotal") > 0 ? "commission" : "hourly");
        expect(wages.serviceCommissionCents, where).toBe(toCents(cell(l, "commission")));
        expect(Math.abs(wages.greaterOfCents - Math.max(wages.hourlyPayCents, wages.serviceCommissionCents)), where).toBeLessThanOrEqual(1);
        expect(wages.greaterOfCents + wages.productCommissionCents + wages.lateCommissionCents + wages.commSalesAdjustmentCents, where).toBe(wages.hourlyPayCents + wages.commSalesCents);
      }
    });

    it("tips are the report's TIPS (R) and, with declared cash, the file's E_Cash Tips Recd", () => {
      for (const { b, l, where } of rows) {
        const p = periodPay([l]);
        expect(p.tipsCents, where).toBe(toCents(cell(l, "tips")));
        expect(p.tipsCents + p.declaredCashTipsCents, where).toBe(toCents(exported(b, l, "E_Cash Tips Recd_Dollars")));
      }
    });

    it("wages are what iSolved pays for the row: each earning at its rate, overtime at 1.5x as an estimate, to the cent; the report's labor cost keeps OT and training pay in; training is its own line", () => {
      for (const { b, l, where } of rows) {
        const { wages, grossCents, tipsCents, declaredCashTipsCents } = periodPay([l]);
        const rate = wages.hourlyRateCents! / 100;
        const training = wages.trainingRateCents! / 100;
        const ot = toCents(exported(b, l, "E_Overtime 1.5_Hours") * 1.5 * rate);
        expect(wages.otEstimatedCents, where).toBe(ot);
        expect(wages.trainingPayCents, where).toBe(toCents(exported(b, l, "E_Training_Hours") * training));
        expect(wages.ptoPayCents, where).toBe(toCents(exported(b, l, "E_Ray'z Paid Time_Hours") * rate));
        const isolved =
          toCents(exported(b, l, "E_Regular_Hours") * rate) +
          ot +
          toCents(exported(b, l, "E_Comm Sales_Dollars")) +
          toCents(exported(b, l, "E_Ray'z Paid Time_Hours") * rate) +
          toCents(exported(b, l, "E_Training_Hours") * training) +
          wages.guaranteeTopUpCents +
          wages.otPremiumCents;
        expect(wages.wagesCents, where).toBe(isolved);
        expect(grossCents, where).toBe(isolved + toCents(exported(b, l, "E_Cash Tips Recd_Dollars")));
        expect(grossCents, where).toBe(wages.wagesCents + tipsCents + declaredCashTipsCents);
        expect(toCents(l.laborCost), where).toBe(toCents(l.totalWages + l.otPay + l.trainingPay));
        const t = trainingLine([l], { countsTowardOt: true });
        expect([t.payCents, t.rateCents, t.inGreaterOf], where).toEqual([toCents(l.trainingPay), wages.trainingRateCents, false]);
        expect(t.payCents, where).toBe(toCents(exported(b, l, "E_Training_Hours") * training));
        expect(t.hours, where).toBe(exported(b, l, "E_Training_Hours"));
      }
      expect(OT_PAY_LABEL).toMatch(/estimate/i);
    });

    it("Total Wages (N): the report rounds it once, the paycheck rounds D and M each (PY-RD-01), so they're a cent apart at most; a NetComm typed on the report isn't in N", () => {
      let apart = 0;
      for (const { l, where } of rows) {
        if (l.overridden.includes("netComm")) continue;
        const { wages } = periodPay([l]);
        const d = toCents(cell(l, "totalWages")) - (wages.hourlyPayCents + wages.commSalesCents);
        expect(Math.abs(d), where).toBeLessThanOrEqual(1);
        if (d) apart++;
      }
      expect(apart).toBeLessThan(rows.length);
    });

    it("a barber on two shops' lines: one period's pay is each shop's added up, the greater-of worked out per shop", () => {
      const [a, b] = rows.map((r) => r.l).filter((l, i, all) => all.findIndex((x) => x.shopId === l.shopId) === i);
      if (!a || !b) return;
      const both = periodPay([a, b]);
      const one = periodPay([a]);
      const two = periodPay([b]);
      expect(both.grossCents).toBe(one.grossCents + two.grossCents);
      expect(both.wages.wagesCents).toBe(one.wages.wagesCents + two.wages.wagesCents);
      expect(both.wages.greaterOfCents).toBe(one.wages.greaterOfCents + two.wages.greaterOfCents);
      expect(both.hours.regularHours).toBeCloseTo(one.hours.regularHours + two.hours.regularHours, 2);
      expect(both.wages.appliedRule).toBe(one.wages.appliedRule === two.wages.appliedRule ? one.wages.appliedRule : "mixed");
    });
  });
