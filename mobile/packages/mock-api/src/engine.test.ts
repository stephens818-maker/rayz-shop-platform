import { describe, expect, it } from "vitest";
import { GROSS_LABEL, PARTIAL_WEEK_OT_LABEL, PAYROLL_TIPS_COPY, rangeForPreset } from "@rayz/api";
import { greaterOf, payrollCsv, payrollPdf } from "./engine";
import { SHOP_CORALVILLE, SHOP_MOLINE, STAFF_CASEY, STAFF_KAT, STAFF_MAKENNA, TODAY } from "./fixtures";
import { createWorld, declareCashTip, earningsDays, earningsFor } from "./world";

const presets = ["current_period", "last_period", "this_week", "last_week", "month_to_date"] as const;

describe("My Earnings server math", () => {
  it("computes greater-of at the edges and leaves training out of it", () => {
    const base = { productionMinutes: 10 * 60, hourlyRateCents: 2000, serviceSalesCents: 40_000, productSalesCents: 0, serviceCommissionRate: 0.5, productCommissionRate: 0.1 };
    const equal = greaterOf(base);
    expect(equal.hourlyPayCents).toBe(20_000);
    expect(equal.commissionCents).toBe(20_000);
    expect(equal.appliedRule).toBe("hourly");
    expect(equal.topUpCents).toBe(0);
    expect(equal.explanationCode).toBe("equal");

    const hourly = greaterOf({ ...base, serviceSalesCents: 10_000 });
    expect(hourly.appliedRule).toBe("hourly");
    expect(hourly.topUpCents).toBe(15_000);
    expect(hourly.greaterOfCents).toBe(20_000);

    const commission = greaterOf({ ...base, hourlyRateCents: 1500, serviceSalesCents: 40_000 });
    expect(commission.hourlyPayCents).toBe(15_000);
    expect(commission.appliedRule).toBe("commission");
    expect(commission.topUpCents).toBe(0);
    expect(commission.greaterOfCents).toBe(20_000);
  });

  it("treats 38 production hours plus 4 training hours as 2 overtime hours", () => {
    const world = createWorld();
    const range = rangeForPreset("last_week", TODAY);
    const earnings = earningsFor(world, STAFF_MAKENNA, range);
    const week = earnings.workweeks.find((w) => w.weekStart === "2026-10-12");
    expect(week).toMatchObject({
      productionHours: 38,
      trainingHours: 4,
      regularHours: 40,
      otHours: 2,
      partial: false,
      otLabelCode: "ot_estimated",
    });
    expect(week?.postings.map((p) => p.periodId).sort()).toEqual(["2026-10-04", "2026-10-18"]);
    expect(week?.postings.find((p) => p.periodId === "2026-10-18")).toMatchObject({ trainingHours: 4, otHours: 2, productionHours: 0 });
    expect(earnings.trainingPayCents).toBe(4 * 1200);
    expect(earnings.hourlyPayCents).toBe(38 * 1500);
    expect(earnings.greaterOfCents).toBe(38 * 1500);
    expect(earnings.greaterOfCents).not.toBe(earnings.hourlyPayCents + earnings.trainingPayCents);
    expect(earnings.otEstimatedCents).toBe(2 * 600);
    expect(earnings.totalCents).toBe(earnings.greaterOfCents + earnings.trainingPayCents + earnings.otEstimatedCents + earnings.totalTipsCents);
    expect(earnings.grossLabel).toBe(GROSS_LABEL);
    expect(earnings.periods.map((p) => p.id).sort()).toEqual(["2026-10-04", "2026-10-18"]);
  });

  it("labels overtime when a custom range clips a workweek and crosses two periods", () => {
    const world = createWorld();
    const earnings = earningsFor(world, STAFF_MAKENNA, { from: "2026-10-16", to: "2026-10-20" });
    expect(earnings.periods.map((p) => p.payrollStatus)).toEqual(["sent_to_payroll", "not_yet_processed"]);
    const clipped = earnings.workweeks.filter((w) => w.partial);
    expect(clipped.length).toBeGreaterThanOrEqual(2);
    for (const week of clipped) expect(week.otLabel).toBe(PARTIAL_WEEK_OT_LABEL);
  });

  it("uses the partial-week label on month to date and not on a fully covered week", () => {
    const world = createWorld();
    const earnings = earningsFor(world, STAFF_MAKENNA, rangeForPreset("month_to_date", TODAY));
    const full = earnings.workweeks.find((w) => w.weekStart === "2026-10-12");
    const clipped = earnings.workweeks.find((w) => w.weekStart === "2026-10-19");
    expect(full?.partial).toBe(false);
    expect(full?.otLabel).not.toBe(PARTIAL_WEEK_OT_LABEL);
    expect(clipped?.partial).toBe(true);
    expect(clipped?.otLabel).toBe(PARTIAL_WEEK_OT_LABEL);
    for (const preset of presets) {
      const range = rangeForPreset(preset, TODAY);
      const view = earningsFor(world, STAFF_MAKENNA, range);
      expect(view.from).toBe(range.from);
      expect(view.grossLabel).toBe(GROSS_LABEL);
    }
  });

  it("keeps a locked snapshot exact and posts a late cash tip forward without a clawback", () => {
    const world = createWorld();
    const locked = earningsFor(world, STAFF_MAKENNA, { from: "2026-09-20", to: "2026-10-03" });
    expect(locked.isEstimate).toBe(false);
    expect("payrollStatus" in locked).toBe(false);
    expect(locked.periods[0].payrollStatus).toBe("paid_in_paycheck");
    expect(locked.cardTipsCents).toBe(1300);
    expect(locked.cashTipsCents).toBe(200);
    expect(locked.totalCents).toBe(locked.greaterOfCents + locked.trainingPayCents + locked.otEstimatedCents + locked.totalTipsCents);
    const days = earningsDays(world, STAFF_MAKENNA, { from: locked.from, to: locked.to });
    expect(days.reduce((n, d) => n + d.cardTipsCents, 0)).toBe(locked.cardTipsCents);
    expect(days.reduce((n, d) => n + d.cashTipsCents, 0)).toBe(locked.cashTipsCents);

    const sale = world.sales.find((s) => s.id === "sale_sep22");
    sale!.cardTipCents = 1;
    const again = earningsFor(world, STAFF_MAKENNA, { from: "2026-09-20", to: "2026-10-03" });
    expect(again.cardTipsCents).toBe(1300);
    expect(again.refunds.reduce((n, r) => n + r.amountCents, 0)).toBe(0);

    const before = earningsFor(world, STAFF_MAKENNA, { from: "2026-10-18", to: "2026-10-31" });
    declareCashTip(world, STAFF_MAKENNA, { shopId: SHOP_CORALVILLE, amountCents: 2500, originalDate: "2026-10-12", postedOn: TODAY });
    const afterLocked = earningsFor(world, STAFF_MAKENNA, { from: "2026-09-20", to: "2026-10-03" });
    expect(afterLocked.cashTipsCents).toBe(locked.cashTipsCents);
    const open = earningsFor(world, STAFF_MAKENNA, { from: "2026-10-18", to: "2026-10-31" });
    expect(open.cashTipsCents).toBe(before.cashTipsCents + 2500);
    const late = open.adjustments.find((a) => a.amountCents === 2500);
    expect(late).toMatchObject({ lateDeclaration: true, originalDate: "2026-10-12", reducesPay: false });
    expect(late?.copy).toBe("Declared after payroll closed; will appear on your next paycheck.");
    expect(open.totalCents).toBeGreaterThan(0);
    expect(open.refunds.every((r) => r.reducesPay === false)).toBe(true);
    expect(open.cardTipsCents).toBe(before.cardTipsCents);
  });

  it("matches the payroll report file to the cent and stays gross", () => {
    const world = createWorld();
    const earnings = earningsFor(world, STAFF_MAKENNA, { from: "2026-09-20", to: "2026-10-03" });
    const csv = payrollCsv(earnings);
    expect(csv.startsWith(GROSS_LABEL)).toBe(true);
    expect(csv).toContain("paid_in_paycheck");
    expect(csv).toContain(String(earnings.totalCents));
    expect(csv).toContain(String(earnings.cardTipsCents));
    expect(csv).toContain(String(earnings.cashTipsCents));
    expect(csv.toLowerCase()).not.toContain("isolved");
    expect(csv.toLowerCase()).not.toContain("net pay");
    const pdf = new TextDecoder().decode(payrollPdf(earnings));
    expect(pdf).toContain(GROSS_LABEL);
    expect(pdf).toContain(String(earnings.totalCents));
    expect(pdf.toLowerCase()).not.toContain("isolved");
  });

  it("shows both shops for one barber and payroll copy when the tip flag is off", () => {
    const world = createWorld();
    const casey = earningsFor(world, STAFF_CASEY, rangeForPreset("this_week", TODAY));
    expect(casey.shops.map((s) => s.shopId).sort()).toEqual([SHOP_CORALVILLE, SHOP_MOLINE].sort());
    expect(casey.shops.find((s) => s.shopId === SHOP_MOLINE)?.payrollCopy).toBe(PAYROLL_TIPS_COPY);
    expect(casey.shops.find((s) => s.shopId === SHOP_CORALVILLE)?.tipTransfersEnabled).toBe(true);
    const kat = earningsFor(world, STAFF_KAT, rangeForPreset("this_week", TODAY));
    expect(kat.shops.every((s) => s.shopId === SHOP_MOLINE)).toBe(true);
    expect(kat.shops[0].payrollCopy).toBe(PAYROLL_TIPS_COPY);
    expect(kat.cardTipsCents).toBe(480);
    const makennaIds = new Set(earningsFor(world, STAFF_MAKENNA, rangeForPreset("this_week", TODAY)).shops.map((s) => s.shopId));
    expect(casey.cardTipsCents).not.toBe(0);
    expect(makennaIds.has(SHOP_MOLINE)).toBe(false);
  });
});
