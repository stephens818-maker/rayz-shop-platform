import { employeePay, type EmployeePay, type GreaterOfCode, type Line } from "@/domain/payroll/calc";

/**
 * The staff app's My Earnings copy (the Rayz App builder's contract, 2026-10-28). The server sends
 * every label with the figures so the app shows them as they are and does no pay math of its own.
 */

export const GROSS_LABEL = "Gross earnings, before taxes and deductions";
export const OT_PAY_LABEL = "Estimated; final pay calculated in payroll.";
export const PARTIAL_WEEK_OT_LABEL = "Estimated: full workweek not in range.";
export const PAYROLL_TIPS_COPY = "Tips paid through payroll.";
export const CASH_TIPS_COPY = "Tips paid in cash at the shop.";
export const LATE_TIP_COPY = "Came in after that pay period closed, so it's paid in this one.";
export const SHOP_COVERS_REFUND_COPY = "Refunded to the client after it reached you. The shop covers it; your pay isn't reduced.";
export const LATE_DECLARATION_COPY = "Declared after that pay period closed, so it's paid in this one.";
export const TRAINING_LABEL = "Training: your training hours at your training rate. Paid on top of hourly or commission pay, never part of the greater-of.";
export const TRAINING_OT_COPY = "Training on top of your clocked hours counts toward the 40 hours for overtime.";
export const TRAINING_NO_OT_COPY = "Training doesn't count toward overtime.";
export const REFUNDED_AFTER_EXPORT_COPY = "Refunded to the client after that pay period was sent to payroll. The shop covers it: your pay isn't reduced and nothing is taken back.";

export type EarningsRule = "hourly" | "commission" | "mixed";
export type EarningsCode = GreaterOfCode | "mixed";

export const EXPLANATION: Record<EarningsCode, string> = {
  hourly_higher: "Hourly pay is higher than service commission.",
  commission_higher: "Service commission is higher than hourly pay.",
  equal: "Hourly pay and service commission are equal. Hourly pay is used.",
  mixed: "Worked out separately at each shop: see each shop's figures.",
};

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** Where employees declare cash tips: the brand's own deadline (IRS: by the 10th of the next month). */
export const cashTipReminder = (d: { enabled: boolean; lockDay: number }) => (d.enabled ? `Declare each month's cash tips by the ${ordinal(d.lockDay)} of the next month.` : null);

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const sameOrNull = <T>(xs: readonly T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);

/** Their hours on their lines of the Payroll Report: production is the clock's worked hours, regular the report's B. */
export function hoursOf(lines: readonly Pick<Line, "hours" | "otHours" | "trainingHours" | "ptoHours">[]) {
  const L = (f: (l: (typeof lines)[number]) => number) => r2(sum(lines, f));
  return { productionHours: L((l) => l.hours + l.otHours), regularHours: L((l) => l.hours), otHours: L((l) => l.otHours), trainingHours: L((l) => l.trainingHours), ptoHours: L((l) => l.ptoHours) };
}

/**
 * Their pay for one pay period, from their lines of the Payroll Report (one per shop they're on in
 * it), each through employeePay: what GET /me/earnings sends, and the only place it's worked out.
 * Overtime pay is an estimate: iSolved works out the final 1.5x from the hours exported.
 */
export function periodPay(lines: readonly Line[]) {
  const pays = lines.map(employeePay);
  const rules = [...new Set(pays.map((p) => p.appliedRule))];
  const codes = [...new Set(pays.map((p) => p.explanationCode))];
  const appliedRule: EarningsRule = rules.length > 1 ? "mixed" : (rules[0] ?? "hourly");
  const explanationCode: EarningsCode = rules.length > 1 || codes.length > 1 ? "mixed" : (codes[0] ?? "equal");
  const P = (f: (p: EmployeePay) => number) => sum(pays, f);
  return {
    pays,
    wages: {
      appliedRule,
      explanationCode,
      explanation: EXPLANATION[explanationCode],
      topUpCents: P((p) => p.topUpCents),
      hourlyPayCents: P((p) => p.hourlyPayCents),
      hourlyRateCents: sameOrNull(pays.map((p) => p.hourlyRateCents)),
      serviceCommissionCents: P((p) => p.serviceCommissionCents),
      productCommissionCents: P((p) => p.productCommissionCents),
      commissionCents: P((p) => p.serviceCommissionCents + p.productCommissionCents),
      lateCommissionCents: P((p) => p.lateCommissionCents),
      commSalesCents: P((p) => p.commSalesCents),
      commSalesAdjustmentCents: P((p) => p.commSalesAdjustmentCents),
      serviceCommissionRate: sameOrNull(pays.map((p) => p.serviceCommissionRate)),
      productCommissionRate: sameOrNull(pays.map((p) => p.productCommissionRate)),
      greaterOfCents: P((p) => p.greaterOfCents),
      guaranteeTopUpCents: P((p) => p.guaranteeTopUpCents),
      otPremiumCents: P((p) => p.otPremiumCents),
      wagesCents: P((p) => p.wagesCents),
      trainingRateCents: sameOrNull(pays.map((p) => p.trainingRateCents)),
      trainingPayCents: P((p) => p.trainingPayCents),
      ptoPayCents: P((p) => p.ptoPayCents),
      otEstimatedCents: P((p) => p.overtimePayCents),
    },
    tipsCents: P((p) => p.tipsCents),
    declaredCashTipsCents: P((p) => p.declaredCashTipsCents),
    grossCents: P((p) => p.grossCents),
    hours: hoursOf(lines),
  };
}

export type PeriodPay = ReturnType<typeof periodPay>;

/**
 * Training as its own line of My Earnings (Charles, Oct 28): the report's Training Pay, training hours
 * at the training rate, outside the greater-of and part of wagesCents. rateCents is null when it
 * differs between their shops or changed during the period. paidAsOvertimeHours: training on top of
 * clocked hours that went over the 40 at a shop where they clocked less, paid as OT hours instead.
 */
export function trainingLine(lines: readonly Line[], o: { countsTowardOt: boolean }) {
  const pays = lines.map(employeePay);
  const trained = pays.filter((_, i) => lines[i].trainingHours > 0);
  return {
    code: "training" as const,
    label: TRAINING_LABEL,
    hours: r2(sum(lines, (l) => l.trainingHours)),
    rateCents: sameOrNull((trained.length ? trained : pays).map((p) => p.trainingRateCents)),
    payCents: sum(pays, (p) => p.trainingPayCents),
    inGreaterOf: false as const,
    paidAsOvertimeHours: r2(sum(lines, (l) => l.otFromTraining ?? 0)),
    countsTowardOt: o.countsTowardOt,
    otNote: o.countsTowardOt ? TRAINING_OT_COPY : TRAINING_NO_OT_COPY,
  };
}

export type TrainingLine = ReturnType<typeof trainingLine>;
