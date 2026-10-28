/**
 * How the brand pays employees their tips outside payroll, as brand settings (staff_payouts): the
 * kind of Stripe account each barber gets, what happens to tips nobody can be paid yet, when a refund
 * takes a tip back, which date a tip belongs to, and the yearly tax form check. Also the seven states
 * of a barber's Stripe account and the identity the iSolved tips-paid export is final on. Pure, so
 * every rule is tested without Stripe or a database (tests/staff-payouts.test.ts).
 *
 * Money only moves through the money-movement module (ST-C11, separate charges and transfers): a
 * transfer from the platform balance, then a payout. Whatever can't be sent that way yet (live keys
 * before MONEY_MOVEMENT_LIVE, a shop whose card tips settle to its own account) is owed and goes
 * through payroll at the pay period cutoff.
 */
import { addDays, type LocalDate } from "@/lib/time";
import { formatCents } from "@/lib/money";
import type { InstantFeeRate } from "./tips";

// ───────────────────────────── Settings ─────────────────────────────

/**
 * Every barber gets a Connect recipient account (ST-I9, Oct 28): controller.stripe_dashboard.type
 * "none", so no Stripe Dashboard login (never Express), set up with Stripe's embedded components in
 * the app, the platform paying Stripe's fees so 1099 tax reporting stays off. These are fixed, not
 * choices: a stored "express", "full" or "hosted" from before reads as the fixed value. Stripe's
 * hosted page (an Account Link) stays only as the fallback where the embedded component can't load.
 */
export const ACCOUNT_DASHBOARDS = ["none"] as const;
export type AccountDashboard = (typeof ACCOUNT_DASHBOARDS)[number];
/** Stripe's recipient service agreement: receives transfers only, no card payments. */
export const SERVICE_AGREEMENTS = ["recipient"] as const;
export type ServiceAgreement = (typeof SERVICE_AGREEMENTS)[number];
/** Onboarding inside the app with Stripe's embedded component, with Stripe's hosted page as the fallback. */
export const ONBOARDING_MODES = ["embedded"] as const;
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];
/** Tips of a barber who can't be paid directly: owed, then paid through payroll at the pay period cutoff; or held until their account is active. */
export const OWED_VIA = ["payroll", "hold"] as const;
export type OwedVia = (typeof OWED_VIA)[number];
/** When a refund takes the tip back from the barber: only a full refund inside the window, any refund that gives tip back, or never. */
export const REVERSAL_RULES = ["full_refund_in_window", "any_refund", "never"] as const;
export type ReversalRule = (typeof REVERSAL_RULES)[number];
/**
 * A tip refunded after it was paid or put in a payout (or its pay period is past): always the shop's
 * cost (ST-C15). Taking back wages already paid is a deduction (IL 820 ILCS 115/9, Iowa 91A.5), so
 * there's no setting for it; an old saved "deduct" reads as the shop's cost.
 */
export const AFTER_PAYOUT_RULES = ["shop_cost"] as const;
export type AfterPayoutRule = (typeof AFTER_PAYOUT_RULES)[number];
/**
 * A refund (or lost dispute) bigger than the sale's portion of the charge, once its tip is with the
 * barber: tips are never clawed back, so the tip part is either the platform's loss, logged
 * (platform), or the shop's, taken from its next transfers (shop). A brand setting sent to the shops
 * picked (shops.tip_refund_overflow), not part of StaffPayoutSettings. Confirm with Charles.
 */
export const TIP_REFUND_OVERFLOW = ["platform", "shop"] as const;
export type TipRefundOverflow = (typeof TIP_REFUND_OVERFLOW)[number];
export const DEFAULT_TIP_REFUND_OVERFLOW: TipRefundOverflow = "platform";
/** Which day a tip belongs to: the sale's business date, or the payment's (a tip added after the sale). */
export const TIP_DATE_RULES = ["sale_date", "payment_date"] as const;
export type TipDateRule = (typeof TIP_DATE_RULES)[number];
/** What Stripe does with 1099 forms for the barbers' accounts. Their tips are W-2 wages, so it never files. */
export const TAX_FORM_FILING = ["will_not_file"] as const;
export type TaxFormFiling = (typeof TAX_FORM_FILING)[number];

export const REVERSAL_WINDOW_DAYS = { min: 0, max: 120 } as const;

export interface StaffPayoutSettings {
  dashboard: AccountDashboard;
  serviceAgreement: ServiceAgreement;
  onboarding: OnboardingMode;
  owedVia: OwedVia;
  reversalRule: ReversalRule;
  /** A full refund within this many days of the sale takes the tip back; later, the shop absorbs it. */
  reversalWindowDays: number;
  afterPayoutRefunds: AfterPayoutRule;
  tipDate: TipDateRule;
  taxForms: TaxFormFiling;
  /** The month (1 to 12) the yearly tax form check comes due, before Stripe files for the year just ended. */
  taxCheckMonth: number;
  /** An employee must see and accept Stripe's instant payout fee before instant payouts turn on. */
  instantFeeAck: boolean;
  /**
   * Employees may pick "tips on my paycheck" (payroll) themselves instead of Stripe deposits (ST-C17).
   * Off until Charles decides: a shop, a pay plan or the owed-tips fallback can still pay through payroll.
   */
  tipsOnPaycheck: boolean;
}

export const DEFAULT_STAFF_PAYOUT_SETTINGS: StaffPayoutSettings = {
  dashboard: "none",
  serviceAgreement: "recipient",
  onboarding: "embedded",
  owedVia: "payroll",
  reversalRule: "never",
  reversalWindowDays: 7,
  afterPayoutRefunds: "shop_cost",
  tipDate: "sale_date",
  taxForms: "will_not_file",
  taxCheckMonth: 1,
  instantFeeAck: true,
  tipsOnPaycheck: false,
};

const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
const int = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);

export function staffPayoutSettings(raw: unknown): StaffPayoutSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof StaffPayoutSettings, unknown>>;
  const d = DEFAULT_STAFF_PAYOUT_SETTINGS;
  return {
    dashboard: pick(ACCOUNT_DASHBOARDS, r.dashboard, d.dashboard),
    serviceAgreement: pick(SERVICE_AGREEMENTS, r.serviceAgreement, d.serviceAgreement),
    onboarding: pick(ONBOARDING_MODES, r.onboarding, d.onboarding),
    owedVia: pick(OWED_VIA, r.owedVia, d.owedVia),
    reversalRule: pick(REVERSAL_RULES, r.reversalRule, d.reversalRule),
    reversalWindowDays: int(r.reversalWindowDays, REVERSAL_WINDOW_DAYS.min, REVERSAL_WINDOW_DAYS.max, d.reversalWindowDays),
    afterPayoutRefunds: pick(AFTER_PAYOUT_RULES, r.afterPayoutRefunds, d.afterPayoutRefunds),
    tipDate: pick(TIP_DATE_RULES, r.tipDate, d.tipDate),
    taxForms: pick(TAX_FORM_FILING, r.taxForms, d.taxForms),
    taxCheckMonth: int(r.taxCheckMonth, 1, 12, d.taxCheckMonth),
    instantFeeAck: typeof r.instantFeeAck === "boolean" ? r.instantFeeAck : d.instantFeeAck,
    tipsOnPaycheck: typeof r.tipsOnPaycheck === "boolean" ? r.tipsOnPaycheck : d.tipsOnPaycheck,
  };
}

export const DASHBOARD_LABEL: Record<AccountDashboard, string> = { none: "None: no Stripe login, everything in the Ray'z app" };
export const SERVICE_AGREEMENT_LABEL: Record<ServiceAgreement, string> = { recipient: "Recipient (receives tips only)" };
export const ONBOARDING_LABEL: Record<OnboardingMode, string> = { embedded: "In the app (embedded), with Stripe's page as the fallback" };
export const TIP_REFUND_OVERFLOW_LABEL: Record<TipRefundOverflow, string> = {
  platform: "The platform absorbs it, logged as a platform loss",
  shop: "The shop: taken from its next transfers",
};
export const OWED_VIA_LABEL: Record<OwedVia, string> = {
  payroll: "Owed, then paid through payroll at the pay period cutoff",
  hold: "Held until their Stripe account is active",
};
export const REVERSAL_RULE_LABEL: Record<ReversalRule, string> = {
  full_refund_in_window: "Only a full refund within the window",
  any_refund: "Any refund that gives tip back",
  never: "Never: the shop absorbs every refunded tip",
};
export const AFTER_PAYOUT_LABEL: Record<AfterPayoutRule, string> = {
  shop_cost: "The shop's cost: never taken back from a later payout or paycheck",
};
export const TIP_DATE_LABEL: Record<TipDateRule, string> = { sale_date: "The sale's date", payment_date: "The payment's date" };
export const TAX_FORMS_LABEL: Record<TaxFormFiling, string> = { will_not_file: "Will not file (tips are W-2 wages through payroll)" };

// ───────────────────────────── The barber's Stripe account ─────────────────────────────

export const ACCOUNT_STATES = ["not_started", "in_progress", "pending_verification", "requirements_due", "restricted", "active", "rejected"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const ACCOUNT_STATE_LABEL: Record<AccountState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  pending_verification: "Pending verification",
  requirements_due: "Requirements due",
  restricted: "Restricted",
  active: "Active",
  rejected: "Rejected",
};
export const ACCOUNT_STATE_TONE: Record<AccountState, "gray" | "blue" | "amber" | "red" | "green"> = {
  not_started: "gray",
  in_progress: "blue",
  pending_verification: "blue",
  requirements_due: "amber",
  restricted: "red",
  active: "green",
  rejected: "red",
};
export const ACCOUNT_STATE_HINT: Record<AccountState, string> = {
  not_started: "No Stripe account yet. It's made when they start payout setup.",
  in_progress: "They started Stripe's setup and haven't finished it.",
  pending_verification: "Everything's in; Stripe is checking it.",
  requirements_due: "Stripe can pay them, and needs more information by a deadline.",
  restricted: "Stripe stopped transfers until they add what it asks for.",
  active: "Stripe can send them their tips.",
  rejected: "Stripe closed the account. Their tips go through payroll.",
};

/** Stripe's transfers capability as last reported; null on accounts saved before it was tracked. */
export type CapabilityStatus = "active" | "inactive" | "pending" | "unrequested" | "disabled";

export interface AccountFacts {
  stripeAccountId: string | null;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  transfersCapability?: CapabilityStatus | string | null;
  /** Past due and currently due. */
  requirementsDue: readonly string[];
  /** Past due only, where known. */
  requirementsPastDue?: readonly string[];
  requirementsPending?: readonly string[];
  disabledReason: string | null;
  deauthorizedAt?: Date | string | null;
}

/**
 * The account's state from Stripe's view of it, first match wins: no account; rejected (or
 * disconnected from the platform); setup not finished; transfers stopped (restricted); transfers on
 * with something due (requirements due); transfers not on yet (pending verification); else active.
 * Accounts saved before the transfers capability was tracked read it from payouts_enabled.
 */
export function accountState(a: AccountFacts | null): AccountState {
  if (!a?.stripeAccountId) return "not_started";
  if (a.deauthorizedAt || a.disabledReason?.startsWith("rejected")) return "rejected";
  if (!a.detailsSubmitted) return "in_progress";
  const transfers = a.transfersCapability ?? (a.payoutsEnabled ? "active" : a.requirementsDue.length ? "inactive" : "pending");
  const pendingOnly = a.disabledReason === "requirements.pending_verification";
  if (transfers !== "active" && !pendingOnly && (a.disabledReason || (a.requirementsPastDue ?? []).length || (transfers === "inactive" && a.requirementsDue.length))) return "restricted";
  if (transfers === "active" && a.requirementsDue.length) return "requirements_due";
  if (transfers !== "active" || !a.payoutsEnabled) return "pending_verification";
  return "active";
}

/** Stripe can send tips to the account: active, or active with something due before a deadline. */
export const canReceiveIn = (s: AccountState) => s === "active" || s === "requirements_due";

/** The four statuses the staff app and My banking already show, from the seven. */
export function bankingStatusOf(s: AccountState): "not_set_up" | "pending_verification" | "ready" | "action_needed" {
  if (s === "not_started" || s === "in_progress") return "not_set_up";
  if (s === "pending_verification") return "pending_verification";
  if (s === "active") return "ready";
  return "action_needed";
}

/** The moves the state machine expects from Stripe's events. Anything else is still saved (Stripe is the source of truth) and flagged in the audit. */
const EXPECTED: Record<AccountState, readonly AccountState[]> = {
  not_started: ["in_progress", "pending_verification", "active", "rejected"],
  in_progress: ["pending_verification", "requirements_due", "restricted", "active", "rejected"],
  pending_verification: ["active", "requirements_due", "restricted", "rejected", "in_progress"],
  requirements_due: ["active", "restricted", "pending_verification", "rejected"],
  restricted: ["pending_verification", "requirements_due", "active", "rejected"],
  active: ["requirements_due", "restricted", "pending_verification", "rejected"],
  rejected: [],
};
export const expectedTransition = (from: AccountState, to: AccountState) => from === to || EXPECTED[from].includes(to);

// ───────────────────────────── Refunds and disputes ─────────────────────────────

export type ReversalOutcome = "reverse" | "absorb_partial" | "absorb_window" | "absorb_rule" | "absorb_after_payout";
export const ABSORB_KIND: Record<Exclude<ReversalOutcome, "reverse">, "partial_refund" | "outside_window" | "rule" | "after_payout"> = {
  absorb_partial: "partial_refund",
  absorb_window: "outside_window",
  absorb_rule: "rule",
  absorb_after_payout: "after_payout",
};
export const ABSORPTION_KINDS = ["partial_refund", "outside_window", "rule", "after_payout", "dispute"] as const;
export type AbsorptionKind = (typeof ABSORPTION_KINDS)[number];
export const ABSORPTION_LABEL: Record<AbsorptionKind, string> = {
  partial_refund: "Partial refund",
  outside_window: "Refund after the window",
  rule: "Refund (brand never reverses tips)",
  after_payout: "Refund after the tip was paid",
  dispute: "Card dispute",
};

/**
 * Whether a refund that gave tip back takes it from the barber, or the shop absorbs it. A tip already
 * paid or in a payout (or from an earlier pay period) is always the shop's. Otherwise, full: the
 * payment is fully refunded once this refund is counted with the earlier ones; the window counts
 * calendar days from the sale's business date to the refund's.
 */
export function reversalOutcome(
  s: Pick<StaffPayoutSettings, "reversalRule" | "reversalWindowDays">,
  r: { saleDate: LocalDate; refundDate: LocalDate; fullyRefunded: boolean; afterPayout?: boolean },
): ReversalOutcome {
  if (r.afterPayout) return "absorb_after_payout";
  if (s.reversalRule === "never") return "absorb_rule";
  if (s.reversalRule === "any_refund") return "reverse";
  if (!r.fullyRefunded) return "absorb_partial";
  return r.refundDate <= addDays(r.saleDate, s.reversalWindowDays) ? "reverse" : "absorb_window";
}

// ───────────────────────────── The iSolved tips-paid export ─────────────────────────────

export interface TipsPaidBuckets {
  /** Every tip, reversal and adjustment of the period in the tip ledger. */
  earnedCents: number;
  /** In Stripe payouts that are paid. */
  transferredCents: number;
  /** Paid in cash from the drawer, or before tip payouts. */
  cashCents: number;
  /** In payroll payouts: paid with the paycheck. */
  payrollCents: number;
  /** Not paid yet: unclaimed, waiting for approval, or held. */
  owedCents: number;
  /** In a payout that's approved or sent, not paid yet. */
  inFlightCents: number;
}

export type TipsPaidStatus = "final" | "draft";
export const TIPS_PAID_STATUS_LABEL: Record<TipsPaidStatus, string> = { final: "Final", draft: "Draft" };

/** What the ledger's buckets miss of what was earned; 0 when every cent is accounted for. */
export const tipsPaidGap = (b: TipsPaidBuckets) => b.earnedCents - (b.transferredCents + b.cashCents + b.payrollCents + b.owedCents + b.inFlightCents);

/**
 * A row is final once its pay period is locked, nothing is still in flight, and earned equals
 * transferred (Stripe and cash) + owed + paid through payroll to the cent. Anything else is a draft,
 * with the reasons.
 */
export function tipsPaidStatus(b: TipsPaidBuckets, locked: boolean): { status: TipsPaidStatus; problems: string[] } {
  const problems: string[] = [];
  if (!locked) problems.push("the pay period isn't approved and locked yet");
  if (b.inFlightCents) problems.push(`${formatCents(b.inFlightCents)} is sent and not paid yet`);
  if (b.owedCents < 0) problems.push(`owed nets to ${formatCents(b.owedCents)}: never taken back, only offset by this employee's later unpaid tips`);
  const gap = tipsPaidGap(b);
  if (gap) problems.push(`${formatCents(Math.abs(gap))} of tips ${gap > 0 ? "isn't in any bucket" : "is counted twice"}`);
  return { status: problems.length ? "draft" : "final", problems };
}

// ───────────────────────────── Instant payouts ─────────────────────────────

/** Stripe's instant payout fee in words, as the employee accepts it: "1.5% (at least $0.50) per instant payout". */
export function instantFeeTerms(rate: InstantFeeRate): string {
  return `${rate.pct}%${rate.minCents ? ` (at least ${formatCents(rate.minCents)})` : ""} per instant payout`;
}

/** Instant payouts are on for the employee: they asked, the brand allows them, and they accepted the current fee where the brand asks them to. */
export function instantOn(o: { asked: boolean; allowed: boolean; ackRequired: boolean; acceptedTerms: string | null }, terms: string): boolean {
  return o.asked && o.allowed && (!o.ackRequired || o.acceptedTerms === terms);
}

// ───────────────────────────── The yearly tax form check ─────────────────────────────

/**
 * The check for the year just ended is due from the first of the brand's check month until it's
 * recorded: Stripe files 1099s in January, so the barbers' accounts must be confirmed not to file
 * (and the import done) before then.
 */
export function taxCheckDue(today: LocalDate, month: number, checkedYears: readonly number[]): { due: boolean; taxYear: number } {
  const year = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const taxYear = year - 1;
  return { due: m >= month && !checkedYears.includes(taxYear), taxYear };
}

// ───────────────────────────── Employers ─────────────────────────────

/** An employer's tax id as anyone sees it: the last four digits only, "EIN ••6789". The full number stays in iSolved and Stripe. */
export function employerTaxIdLabel(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `EIN ••${last4}` : "EIN not on file";
}

/** Only four digits are kept of an EIN; a full one typed in is cut to its last four. */
export function taxIdLast4(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

/** A payout held for the employee's Stripe setup, or until direct payouts are turned on: either way it's owed, and goes on payroll at the cutoff if it isn't sent first. */
export function heldLabel(p: { status: string; holdKind: string | null }): string | null {
  if (p.status !== "held") return null;
  if (p.holdKind === "stripe_setup") return "Waiting for your Stripe setup";
  if (p.holdKind === "transfers_pending") return "Owed: paid through payroll unless sent first";
  return null;
}

/** A card tip's transfer to the barber's Stripe account at the sale (I10), as the barber reads it. */
export const TIP_TRANSFER_LABEL = {
  pending: "On its way to your Stripe account",
  sent: "In your Stripe account",
  failed: "Couldn't be sent at the sale, so it's paid with your next tip payout",
  cancelled: "Refunded before it was sent",
} as const satisfies Record<"pending" | "sent" | "failed" | "cancelled", string>;

/** Where a tip already in their Stripe account stands before a payout takes it to their bank. */
export const NOT_IN_PAYOUT_LABEL = "Not in a payout yet";

/** The staff app's statuses (My Earnings): a tip's transfer to their Stripe account, and the Stripe payout to their bank or card. */
export type AppTransferStatus = "pending" | "paid" | "reversed";
export type AppPayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled";

/**
 * A Stripe tip payout as the app shows it: Stripe's own status once it has the payout (in transit
 * until the bank has it), pending before then (waiting for approval, a hold or the batch), and failed
 * when a payout already paid came back from the bank.
 */
export function appPayoutStatus(p: { status: string; stripeStatus: string | null; returnedAt: Date | null }): AppPayoutStatus {
  if (p.returnedAt) return "failed";
  if (p.status === "paid") return "paid";
  if (p.status === "failed") return p.stripeStatus === "canceled" ? "canceled" : "failed";
  if (p.status === "cancelled") return "canceled";
  if (p.status === "processing" && (p.stripeStatus === "in_transit" || p.stripeStatus === "paid")) return p.stripeStatus;
  return "pending";
}

/**
 * A card tip's transfer to their Stripe account at the sale, as the app shows it, or null for one
 * that never happened (a refund before it was sent took it all). Ray'z never reverses a tip transfer:
 * reversed means only that Stripe reversed it (transfer.reversed). A payout their bank returned
 * doesn't touch the transfer: the money is back in their Stripe balance and goes with their next
 * payout, and the payout shows failed. One Stripe refused at the sale is pending: it's paid with their
 * next tip payout.
 */
export function appTransferStatus(t: { status: string; stripeReversedAt: Date | null }): { status: AppTransferStatus; reversedBy: "stripe" | null } | null {
  if (t.status === "cancelled") return null;
  if (t.stripeReversedAt) return { status: "reversed", reversedBy: "stripe" };
  return { status: t.status === "sent" ? "paid" : "pending", reversedBy: null };
}

/** One card tip on its way to their bank, start to finish (tipTransferStatus on tickets and /me/payouts). */
export const TIP_TRANSFER_STATUSES = ["pending", "destination_charge", "transferred", "paid_out", "failed"] as const;
export type TipTransferStatus = (typeof TIP_TRANSFER_STATUSES)[number];

/**
 * transferred and paid_out need a real tip transfer: its payment_transfers row sent, which the
 * database only allows with Stripe's transfer id (payment_transfers_sent). Until then it's pending.
 * paid_out once the Stripe payout carrying it is paid (a payout their bank returned isn't: the money
 * is back in their Stripe balance, so the tip is transferred again). failed when Stripe refused the
 * transfer at the last try, or reversed it. destination_charge: a card tip charged before separate
 * charges and transfers (a destination charge, or older history with no charge type), which has no
 * tip transfer and never will. Null where no transfer to their Stripe account is meant: cash and
 * gift-card tips, card tips paid through payroll, and a tip a refund took before it was sent.
 */
export function tipTransferStatus(o: {
  method: string;
  /** The card payment the tip came on; null when there's none. */
  charge: { chargeType: "destination" | "separate" | null } | null;
  transfer: { status: string; stripeTransferId: string | null; stripeReversedAt: Date | null } | null;
  payout: { status: string; stripeStatus: string | null; returnedAt: Date | null } | null;
}): TipTransferStatus | null {
  const t = o.transfer;
  if (!t) return o.method === "card" && o.charge && o.charge.chargeType !== "separate" ? "destination_charge" : null;
  if (t.status === "cancelled") return null;
  if (t.status === "failed" || t.stripeReversedAt) return "failed";
  if (t.status !== "sent" || !t.stripeTransferId) return "pending";
  return o.payout && appPayoutStatus(o.payout) === "paid" ? "paid_out" : "transferred";
}
