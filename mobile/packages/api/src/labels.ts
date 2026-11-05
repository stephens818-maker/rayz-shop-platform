/** English copy the staff app shows. Payroll vendor names stay out of this file. */

export const GROSS_LABEL = "Gross earnings, before taxes and deductions";
export const PARTIAL_WEEK_OT_LABEL = "Estimated: full workweek not in range.";
export const OT_PAY_LABEL = "Estimated; final pay calculated in payroll.";
export const LATE_ADJUSTMENT_COPY = "Declared after payroll closed; will appear on your next paycheck.";
export const PAYROLL_TIPS_COPY = "Tips paid through payroll.";
export const RETURNED_BY_BANK = "Returned by bank";
export const CASH_TIP_REMINDER = "Declare cash tips by the 10th.";
export const TRAINING_LINE = "Training";

export type PayrollStatus = "not_yet_processed" | "sent_to_payroll" | "paid_in_paycheck";
export type PeriodStatus = "draft" | "approved" | "locked" | "exported";
export type TransferStatus = "pending" | "paid" | "reversed";
export type PayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled";
export type PayoutAccountState =
  | "not_started"
  | "in_progress"
  | "pending_verification"
  | "requirements_due"
  | "restricted"
  | "active"
  | "rejected";

export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = {
  not_yet_processed: "Not yet processed",
  sent_to_payroll: "Sent to payroll",
  paid_in_paycheck: "Paid in paycheck",
};

export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  locked: "Locked",
  exported: "Exported",
};

/** Locked and exported periods are frozen snapshots. Approved is still live. */
export function isSnapshotPeriod(status: PeriodStatus): boolean {
  return status === "locked" || status === "exported";
}

export const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  pending: "Transfer pending",
  paid: "Transfer paid",
  reversed: RETURNED_BY_BANK,
};

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  pending: "Payout pending",
  in_transit: "Payout in transit",
  paid: "Payout paid",
  failed: "Payout failed",
  canceled: "Payout canceled",
};

export const PRESET_LABEL: Record<string, string> = {
  current_period: "Current period",
  last_period: "Last period",
  this_week: "This week",
  last_week: "Last week",
  month_to_date: "Month to date",
  custom: "Custom",
};

export function trainingLine(hoursLabel: string, rateLabel: string): string {
  return `Training: ${hoursLabel} hrs × ${rateLabel}`;
}
