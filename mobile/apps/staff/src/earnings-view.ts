import {
  formatCents,
  formatHours,
  PAYOUT_STATUS_LABEL,
  TRANSFER_STATUS_LABEL,
  trainingLine,
  type EarningsResponse,
  type PayrollStatus,
  type PayoutStatus,
  type TransferStatus,
} from "@rayz/api";

/** Display guard. The server owns the amount; the screen never shows a negative. */
export function shownCents(cents: number): number {
  return Math.max(0, Math.round(cents));
}

export function earningsView(input: EarningsResponse, payrollLabel: (status: PayrollStatus) => string) {
  return {
    grossLabel: input.grossLabel,
    totalCents: shownCents(input.totalCents),
    isEstimate: input.isEstimate,
    explanation: input.explanation,
    appliedRule: input.appliedRule,
    hourlyPayCents: shownCents(input.hourlyPayCents),
    serviceCommissionCents: shownCents(input.serviceCommissionCents),
    productCommissionCents: shownCents(input.productCommissionCents),
    commissionCents: shownCents(input.commissionCents),
    topUpCents: shownCents(input.topUpCents),
    greaterOfCents: shownCents(input.greaterOfCents),
    trainingLine: input.trainingHours > 0 ? trainingLine(formatHours(input.trainingHours), formatCents(input.trainingRateCents)) : null,
    trainingPayCents: shownCents(input.trainingPayCents),
    productionHours: input.productionHours,
    trainingHours: input.trainingHours,
    regularHours: input.regularHours,
    otHours: input.otHours,
    otEstimatedCents: shownCents(input.otEstimatedCents),
    otDisclosure: input.otDisclosure,
    cardTipsCents: shownCents(input.cardTipsCents),
    cashTipsCents: shownCents(input.cashTipsCents),
    serviceSalesCents: shownCents(input.serviceSalesCents),
    productSalesCents: shownCents(input.productSalesCents),
    periods: input.periods.map((period) => ({
      id: period.id,
      range: `${period.start} – ${period.end}`,
      payrollLabel: payrollLabel(period.payrollStatus),
      periodStatus: period.periodStatus,
      estimate: period.isEstimate,
    })),
    workweeks: input.workweeks.map((week) => ({
      id: week.weekStart,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      range: `${week.weekStart} – ${week.weekEnd}`,
      productionHours: week.productionHours,
      trainingHours: week.trainingHours,
      regularHours: week.regularHours,
      otHours: week.otHours,
      otLabel: week.otLabel,
    })),
    shops: input.shops.map((shop) => ({
      shopId: shop.shopId,
      shopName: shop.shopName,
      showDeposits: shop.tipTransfersEnabled,
      payrollCopy: shop.tipTransfersEnabled ? null : shop.payrollCopy,
      cardTipsCents: shownCents(shop.cardTipsCents),
      cashTipsCents: shownCents(shop.cashTipsCents),
    })),
    adjustments: input.adjustments.map((row) => ({
      id: row.id,
      copy: row.copy,
      amountCents: shownCents(row.amountCents),
      originalDate: row.originalDate,
      reducesPay: row.reducesPay,
    })),
    refunds: input.refunds.map((row) => ({
      id: row.id,
      copy: row.copy,
      amountCents: shownCents(row.amountCents),
      originalDate: row.originalDate,
      reducesPay: row.reducesPay,
    })),
    cashTipReminder: input.cashTipReminder,
  };
}

export function transferStatusLabel(status: TransferStatus): string {
  return TRANSFER_STATUS_LABEL[status];
}

export function payoutStatusLabel(status: PayoutStatus): string {
  return PAYOUT_STATUS_LABEL[status];
}
