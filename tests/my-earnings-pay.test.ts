/**
 * My Earnings' pay, worked out from the Payroll Report's line (employeePay) so the staff app does no
 * pay math (every golden row: my-earnings-contract.test.ts), and the statuses the app shows for a card tip's transfer and a Stripe payout.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PAYROLL_SETTINGS, computeLine, employeePay, toCents, type LineInput } from "@/domain/payroll/calc";
import { appPayoutStatus, appTransferStatus } from "@/domain/staff-payouts";

const input = (over: Partial<LineInput> = {}): LineInput => ({
  staffId: "b1",
  name: "Barber One",
  shopId: "A",
  employeeNumber: "1001",
  keyIsText: false,
  isolvedName: "ONE, BARBER",
  hourlyRate: 14.5,
  servicePct: 0.4,
  productPct: 0.15,
  trainingRate: null,
  workedHours: 80,
  otHours: 0,
  ptoHours: 0,
  trainingHours: 0,
  serviceSales: 2864.15,
  productSales: 68.4,
  tips: 395.25,
  ...over,
});
const pay = (over: Partial<LineInput> = {}, s = DEFAULT_PAYROLL_SETTINGS) => employeePay(computeLine(input(over), s));

describe("employeePay: the greater-of and every total, from the Payroll Report's line", () => {
  it("hourly higher: 80 h at $14.50 = $1,160.00 against 40% of $2,864.15 = $1,145.66; hourly applies and tops up $14.34", () => {
    const p = pay();
    expect(p).toMatchObject({
      appliedRule: "hourly",
      explanationCode: "hourly_higher",
      hourlyRateCents: 1450,
      hourlyPayCents: 116000,
      serviceCommissionCents: 114566,
      serviceCommissionRate: 0.4,
      productCommissionCents: 1026,
      commissionOverHourlyCents: 0,
      greaterOfCents: 116000,
      topUpCents: 1434,
      commSalesCents: 1026,
      tipsCents: 39525,
      cashTipsReceivedCents: 39525,
    });
    expect(p.wagesCents).toBe(116000 + 1026);
    expect(p.grossCents).toBe(116000 + 1026 + 39525);
  });

  it("commission higher: 40% of $4,000.00 = $1,600.00 beats $1,160.00; Comm Sales is the $440.00 above hourly plus product commission", () => {
    const p = pay({ serviceSales: 4000 });
    expect(p).toMatchObject({ appliedRule: "commission", explanationCode: "commission_higher", serviceCommissionCents: 160000, commissionOverHourlyCents: 44000, greaterOfCents: 160000, topUpCents: 0, commSalesCents: 44000 + 1026 });
    expect(p.hourlyPayCents + p.commSalesCents).toBe(toCents(computeLine(input({ serviceSales: 4000 }), DEFAULT_PAYROLL_SETTINGS).totalWages));
  });

  it("equal: $2,900.00 at 40% is exactly $1,160.00, so hourly applies with nothing on top", () => {
    expect(pay({ serviceSales: 2900 })).toMatchObject({ appliedRule: "hourly", explanationCode: "equal", greaterOfCents: 116000, topUpCents: 0, commissionOverHourlyCents: 0 });
  });

  it("OT, training, paid time, declared cash and a guarantee each add once; the parts add up to wagesCents and grossCents exactly", () => {
    const p = pay({ workedHours: 85, otHours: 5, trainingHours: 3, trainingRate: 10, ptoHours: 8, declaredCashTips: 45.5, guaranteeTopUp: 12.34 });
    expect(p).toMatchObject({ hourlyPayCents: 116000, overtimePayCents: 10875, trainingRateCents: 1000, trainingPayCents: 3000, ptoPayCents: 11600, guaranteeTopUpCents: 1234, declaredCashTipsCents: 4550, cashTipsReceivedCents: 39525 + 4550 });
    expect(p.wagesCents).toBe(p.hourlyPayCents + p.commSalesCents + p.overtimePayCents + p.trainingPayCents + p.ptoPayCents + p.guaranteeTopUpCents + p.otPremiumCents);
    expect(p.grossCents).toBe(p.wagesCents + p.cashTipsReceivedCents);
  });

  it("training at their wage when there's no training rate; no hourly pay at all for a commission-only line", () => {
    expect(pay({ trainingHours: 2 })).toMatchObject({ trainingRateCents: 1450, trainingPayCents: 2900 });
    const c = pay({ zeroHourlyPay: true, serviceSales: 1000 });
    expect(c).toMatchObject({ hourlyRateCents: 0, hourlyPayCents: 0, appliedRule: "commission", serviceCommissionCents: 40000, greaterOfCents: 40000 });
  });

  it("a Comm Sales payroll typed over on the report is what's paid; the difference is its own adjustment, not commission over hourly", () => {
    const over = (serviceSales: number) => pay({ serviceSales, overrides: { netComm: { value: 500, reason: "Corrected on the report" } } });
    expect(over(4000)).toMatchObject({ appliedRule: "commission", commSalesCents: 50000, commissionOverHourlyCents: 44000, greaterOfCents: 160000, commSalesAdjustmentCents: 50000 - 44000 - 1026 });
    expect(over(2864.15)).toMatchObject({ appliedRule: "hourly", commSalesCents: 50000, commissionOverHourlyCents: 0, greaterOfCents: 116000, commSalesAdjustmentCents: 50000 - 1026 });
    expect(pay().commSalesAdjustmentCents).toBe(0);
  });
});

describe("the app's transfer and payout statuses", () => {
  const po = (status: string, stripeStatus: string | null = null, returnedAt: Date | null = null) => ({ status, stripeStatus, returnedAt });

  it("a payout: pending until Stripe has it, then Stripe's in_transit and paid; failed and canceled as Stripe says; failed when the bank returns a paid one", () => {
    expect(["pending", "held", "approved"].map((s) => appPayoutStatus(po(s)))).toEqual(["pending", "pending", "pending"]);
    expect(appPayoutStatus(po("processing"))).toBe("pending");
    expect(appPayoutStatus(po("processing", "pending"))).toBe("pending");
    expect(appPayoutStatus(po("processing", "in_transit"))).toBe("in_transit");
    expect(appPayoutStatus(po("processing", "paid"))).toBe("paid");
    expect(appPayoutStatus(po("paid", "paid"))).toBe("paid");
    expect(appPayoutStatus(po("failed", "failed"))).toBe("failed");
    expect(appPayoutStatus(po("failed", "canceled"))).toBe("canceled");
    expect(appPayoutStatus(po("cancelled"))).toBe("canceled");
    expect(appPayoutStatus(po("failed", "failed", new Date()))).toBe("failed");
  });

  it("a tip transfer: paid once it's in their Stripe account, pending until then (a refused one goes with the next payout), reversed only when Stripe reversed it", () => {
    const t = (status: string, stripeReversedAt: Date | null = null) => ({ status, stripeReversedAt });
    expect(appTransferStatus(t("sent"))).toEqual({ status: "paid", reversedBy: null });
    expect(appTransferStatus(t("pending"))).toEqual({ status: "pending", reversedBy: null });
    expect(appTransferStatus(t("failed"))).toEqual({ status: "pending", reversedBy: null });
    expect(appTransferStatus(t("cancelled"))).toBeNull();
    expect(appTransferStatus(t("sent", new Date()))).toEqual({ status: "reversed", reversedBy: "stripe" });
  });
});
