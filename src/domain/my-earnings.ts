import type { GreaterOfCode } from "@/domain/payroll/calc";

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
