import type {
  PayoutAccountState,
  PayoutStatus,
  PayrollStatus,
  PeriodStatus,
  TransferStatus,
} from "./labels";

/** Hand-typed contracts for endpoints the shop platform does not publish yet. Amounts are integer cents. The app does not compute them. */

export interface ShopGate {
  id: string;
  shopId: string;
  slug: string;
  launched: boolean;
  launchAt: string | null;
  closedCopy: string | null;
  booking: "native" | "external" | "closed";
  externalBookingUrl: string | null;
  payments: boolean;
  /** Customer config keeps this false. The staff clock is not on /api/v1. */
  clockIn: boolean;
  /** shops.tip_to_barber. A destination charge still does not transfer the tip. */
  tipTransfers: boolean;
}

export interface AppConfig {
  timezone: "America/Chicago";
  timeFormat: "12h" | "24h";
  launched: boolean;
  launchAt: string | null;
  pilot: boolean;
  pilotShops: string[];
  closedShopCopy: string;
  /** Sunday unless a response actually includes this field. */
  weekStartDay?: number;
  minVersion: { ios: string; android: string };
  forceUpdateBelow: { ios: string; android: string };
  minSupportedVersion: { ios: string; android: string };
  latestVersion: { ios: string; android: string };
  supportPhone: string;
  supportEmail: string;
  privacyUrl: string;
  termsUrl: string;
  deletionUrl: string;
  featureFlags: { payments: boolean; family: boolean; pushMarketing: boolean };
  shops: ShopGate[];
}

export interface StaffConfig {
  timezone: "America/Chicago";
  timeFormat: "12h" | "24h";
  /** Sunday unless a response actually includes this field. */
  weekStartDay?: number;
  appName: string;
  minSupportedVersion: { ios: string; android: string };
  latestVersion: { ios: string; android: string };
  /** Default on. A shop can still turn tip transfers off. */
  tipTransfersDefault: boolean;
  supportPhone: string;
  supportEmail: string;
  privacyUrl: string;
  termsUrl: string;
  shops: ShopGate[];
}

export type EarningsQuery =
  | { period: "current" }
  | { periodId: string }
  | { from: string; to: string };

export interface WorkweekPosting {
  periodId: string;
  productionHours: number;
  trainingHours: number;
  regularHours: number;
  otHours: number;
}

export interface EarningsWorkweek {
  weekStart: string;
  weekEnd: string;
  timezone: "America/Chicago";
  productionHours: number;
  trainingHours: number;
  regularHours: number;
  otHours: number;
  partial: boolean;
  otLabelCode: "partial_week" | "ot_estimated" | null;
  otLabel: string | null;
  postings: WorkweekPosting[];
}

export interface EarningsPeriodChip {
  id: string;
  start: string;
  end: string;
  periodStatus: PeriodStatus;
  payrollStatus: PayrollStatus;
  isEstimate: boolean;
  snapshotId: string | null;
  computedAt: string | null;
}

export interface EarningsShopSlice {
  shopId: string;
  shopName: string;
  tipTransfersEnabled: boolean;
  payrollCopy: string | null;
  cardTipsCents: number;
  cashTipsCents: number;
  serviceSalesCents: number;
  productSalesCents: number;
}

export interface EarningsAdjustment {
  id: string;
  kind: "late_cash_tip" | "card_tip_refund";
  shopId: string;
  amountCents: number;
  originalDate: string;
  postedDate: string;
  lateDeclaration: true;
  reducesPay: false;
  copy: string;
}

export interface EarningsResponse {
  from: string;
  to: string;
  grossLabel: string;
  isEstimate: boolean;
  periods: EarningsPeriodChip[];
  snapshotId: string | null;
  computedAt: string | null;
  appliedRule: "hourly" | "commission";
  explanationCode: "hourly_higher" | "commission_higher" | "equal";
  explanation: string;
  topUpCents: number;
  hourlyPayCents: number;
  hourlyRateCents: number;
  serviceCommissionCents: number;
  productCommissionCents: number;
  commissionCents: number;
  serviceCommissionRate: number;
  productCommissionRate: number;
  greaterOfCents: number;
  productionHours: number;
  trainingHours: number;
  trainingRateCents: number;
  trainingPayCents: number;
  regularHours: number;
  otHours: number;
  otEstimatedCents: number;
  otDisclosure: string;
  serviceSalesCents: number;
  productSalesCents: number;
  cardTipsCents: number;
  cashTipsCents: number;
  giftCardTipsCents: number;
  totalTipsCents: number;
  /** Gross. Never net of taxes or deductions. */
  totalCents: number;
  workweeks: EarningsWorkweek[];
  shops: EarningsShopSlice[];
  adjustments: EarningsAdjustment[];
  refunds: EarningsAdjustment[];
  cashTipReminder: string;
}

export interface EarningsDay {
  date: string;
  cardTipsCents: number;
  cashTipsCents: number;
  serviceSalesCents: number;
  productSalesCents: number;
  productionHours: number;
  trainingHours: number;
  tickets: number;
}

export interface EarningsDaysResponse {
  from: string;
  to: string;
  days: EarningsDay[];
}

export interface TipTransferView {
  status: TransferStatus;
  amountCents: number;
  arrivalDate: string | null;
}

export interface TipPayoutView {
  status: PayoutStatus;
  amountCents: number;
  arrivalDate: string | null;
  bankLast4: string | null;
  failureMessage: string | null;
}

export interface EarningsTicket {
  saleId: string;
  shopId: string;
  shopName: string;
  clientFirstName: string;
  startedAt: string;
  serviceName: string;
  serviceCents: number;
  productCents: number;
  cardTipCents: number;
  cashTipCents: number;
  tipDisposition: "stripe" | "payroll";
  transfer: TipTransferView | null;
  payout: TipPayoutView | null;
  lateDeclaration: boolean;
  originalDate: string | null;
}

export interface EarningsTicketsResponse {
  from: string;
  to: string;
  date: string | null;
  tickets: EarningsTicket[];
  refunds: EarningsAdjustment[];
}

export interface PayoutListItem {
  id: string;
  amountCents: number;
  status: PayoutStatus;
  arrivalDate: string | null;
  bankLast4: string | null;
  failureMessage: string | null;
  feeCents: number;
  instant: boolean;
}

export interface TransferListItem {
  id: string;
  saleId: string;
  shopId: string;
  amountCents: number;
  status: TransferStatus;
  arrivalDate: string | null;
  payoutStatus: PayoutStatus | null;
  payoutArrivalDate: string | null;
}

export interface PayoutsResponse {
  from: string;
  to: string;
  bankLast4: string | null;
  tipTransfersEnabled: boolean;
  payrollCopy: string | null;
  transfers: TransferListItem[];
  payouts: PayoutListItem[];
}

export interface PayPeriodListItem {
  id: string;
  start: string;
  end: string;
  periodStatus: PeriodStatus;
  payrollStatus: PayrollStatus;
  current: boolean;
}

export interface PayoutAccount {
  state: PayoutAccountState;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  currentDeadline: string | null;
  disabledReason: string | null;
  externalLast4: string | null;
  externalType: "bank" | "card" | null;
  instantEligible: boolean;
  instantOptIn: boolean;
  /** Server-owned. The app does not branch on Express vs recipient. */
  collection: "embedded";
}

export interface PaymentPreview {
  shopId: string;
  paymentsEnabled: boolean;
  unavailableCopy: string | null;
  serviceCents: number;
  taxCents: number;
  tipCents: number;
  funding: "credit" | "debit" | "prepaid" | "unknown" | null;
  wallet: boolean;
  feeCents: number;
  feeRate: number;
  feeReason: string;
  feeLabel: string | null;
  disclosure: string | null;
  totalCents: number;
  destination: {
    model: "separate_charges_and_transfers";
    shopAccountId: string | null;
    serviceTransferCents: number;
  };
  tipTransfer: {
    amountCents: number;
    /** Stays payroll until chargeCard stops destination-charging the ticket. */
    disposition: "payroll" | "transfer";
    copy: string | null;
  };
}

export interface CustomerReceiptRefund {
  id: string;
  amountCents: number;
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  shopPortionCents?: number | null;
  tipPortionCents?: number | null;
  from: "shop" | "tip" | "shop_and_tip" | null;
}

export interface ReceiptSettlement {
  shopCents: number;
  tipCents: number;
  tipStatus: "executed" | "reversed" | "planned" | "with_shop";
}

export interface CustomerReceipt {
  id: string;
  shopName: string;
  serviceName: string | null;
  serviceCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  totalCents: number;
  tender: string;
  paidAt: string | null;
  grossLabel: string;
  barberFirstName?: string | null;
  settlement?: ReceiptSettlement | null;
  refunds: CustomerReceiptRefund[];
}

export interface CustomerReceiptList {
  receipts: { id: string; shopName: string; paidAt: string | null; totalCents: number; serviceName: string | null }[];
  limit: number;
  nextCursor: string | null;
}
