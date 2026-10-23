import { GROSS_LABEL, PARTIAL_WEEK_OT_LABEL, PAYROLL_STATUS_LABEL, type EarningsResponse } from "@rayz/api";
import { describe, expect, it } from "vitest";
import { earningsView, payoutStatusLabel, shownCents, transferStatusLabel } from "./earnings-view";

function sample(overrides: Partial<EarningsResponse> = {}): EarningsResponse {
  const base: EarningsResponse = {
    from: "2026-10-12",
    to: "2026-10-18",
    grossLabel: GROSS_LABEL,
    isEstimate: false,
    periods: [
      { id: "2026-10-04", start: "2026-10-04", end: "2026-10-17", periodStatus: "locked", payrollStatus: "sent_to_payroll", isEstimate: false, snapshotId: "snap", computedAt: "2026-10-18T15:00:00.000Z" },
      { id: "2026-10-18", start: "2026-10-18", end: "2026-10-31", periodStatus: "draft", payrollStatus: "not_yet_processed", isEstimate: true, snapshotId: null, computedAt: null },
    ],
    snapshotId: null,
    computedAt: null,
    appliedRule: "hourly",
    explanationCode: "hourly_higher",
    explanation: "Hourly pay is higher this range.",
    topUpCents: 100,
    hourlyPayCents: 57000,
    hourlyRateCents: 1500,
    serviceCommissionCents: 0,
    productCommissionCents: 0,
    commissionCents: 0,
    serviceCommissionRate: 0.5,
    productCommissionRate: 0.1,
    greaterOfCents: 57000,
    productionHours: 38,
    trainingHours: 4,
    trainingRateCents: 1200,
    trainingPayCents: 4800,
    regularHours: 40,
    otHours: 2,
    otEstimatedCents: 1200,
    otDisclosure: "Estimated; final pay calculated in payroll.",
    serviceSalesCents: 0,
    productSalesCents: 0,
    cardTipsCents: 800,
    cashTipsCents: 200,
    giftCardTipsCents: 0,
    totalTipsCents: 1000,
    totalCents: 63000,
    workweeks: [
      {
        weekStart: "2026-10-12",
        weekEnd: "2026-10-18",
        timezone: "America/Chicago",
        productionHours: 38,
        trainingHours: 4,
        regularHours: 40,
        otHours: 2,
        partial: false,
        otLabelCode: "ot_estimated",
        otLabel: "Estimated; final pay calculated in payroll.",
        postings: [],
      },
    ],
    shops: [
      { shopId: "moline", shopName: "Moline", tipTransfersEnabled: false, payrollCopy: "Tips paid through payroll.", cardTipsCents: 360, cashTipsCents: 0, serviceSalesCents: 1800, productSalesCents: 0 },
    ],
    adjustments: [],
    refunds: [
      { id: "ref1", kind: "card_tip_refund", shopId: "c", amountCents: 300, originalDate: "2026-09-22", postedDate: "2026-10-23", lateDeclaration: true, reducesPay: false, copy: "Declared after payroll closed; will appear on your next paycheck." },
    ],
    cashTipReminder: "Declare cash tips by the 10th.",
  };
  return { ...base, ...overrides };
}

describe("earnings view", () => {
  it("shows the server gross total and the training line without recomputing pay", () => {
    const view = earningsView(sample(), (status) => PAYROLL_STATUS_LABEL[status]);
    expect(view.grossLabel).toBe("Gross earnings, before taxes and deductions");
    expect(view.totalCents).toBe(63000);
    expect(view.trainingLine).toBe("Training: 4 hrs × $12.00");
    expect(view.trainingPayCents).toBe(4800);
    expect(view.periods.map((period) => period.payrollLabel)).toEqual(["Sent to payroll", "Not yet processed"]);
    expect(view.shops[0].showDeposits).toBe(false);
    expect(view.shops[0].payrollCopy).toBe("Tips paid through payroll.");
    expect(view.refunds[0].reducesPay).toBe(false);
    expect(view.refunds[0].amountCents).toBe(300);
    expect(JSON.stringify(view).toLowerCase()).not.toContain("net pay");
    expect(JSON.stringify(view).toLowerCase()).not.toContain("isolved");
  });

  it("passes a partial-week overtime label through and never shows negative pay", () => {
    const view = earningsView(
      sample({
        totalCents: -5,
        workweeks: [
          {
            weekStart: "2026-10-19",
            weekEnd: "2026-10-25",
            timezone: "America/Chicago",
            productionHours: 8,
            trainingHours: 0,
            regularHours: 8,
            otHours: 0,
            partial: true,
            otLabelCode: "partial_week",
            otLabel: PARTIAL_WEEK_OT_LABEL,
            postings: [],
          },
        ],
      }),
      (status) => PAYROLL_STATUS_LABEL[status],
    );
    expect(view.totalCents).toBe(0);
    expect(view.workweeks[0].otLabel).toBe("Estimated: full workweek not in range.");
    expect(shownCents(-1)).toBe(0);
  });

  it("has a label for every transfer and payout status", () => {
    expect(["pending", "paid", "reversed"].map((status) => transferStatusLabel(status as "pending"))).toEqual([
      "Transfer pending",
      "Transfer paid",
      "Returned by bank",
    ]);
    expect(["pending", "in_transit", "paid", "failed", "canceled"].map((status) => payoutStatusLabel(status as "pending")).every((label) => label.length > 0)).toBe(true);
  });
});
