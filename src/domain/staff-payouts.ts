/**
 * How the brand pays employees their tips outside payroll, as brand settings (staff_payouts): the
 * kind of Stripe account each barber gets, what happens to tips nobody can be paid yet, when a refund
 * takes a tip back, which date a tip belongs to, and the yearly tax form check. Also the seven states
 * of a barber's Stripe account and the identity the iSolved tips-paid export is final on. Pure, so
 * every rule is tested without Stripe or a database (tests/staff-payouts.test.ts).
 *
 * Money only moves through the money-movement module, which stays abstract until the separate
 * charges and transfers design (ST-C11) is signed off: with no transfer path, tips are owed and go
 * through payroll at the pay period cutoff.
 */
import { addDays, type LocalDate } from "@/lib/time";
import { formatCents } from "@/lib/money";
import type { InstantFeeRate } from "./tips";

// ───────────────────────────── Settings ─────────────────────────────

/** Who sees a Stripe Dashboard for the barber's account: none (embedded components in the app) or Stripe Express. */
export const ACCOUNT_DASHBOARDS = ["none", "express"] as const;
export type AccountDashboard = (typeof ACCOUNT_DASHBOARDS)[number];
/** Stripe's service agreement: recipient (receives transfers only, no card payments) or full. */
export const SERVICE_AGREEMENTS = ["recipient", "full"] as const;
export type ServiceAgreement = (typeof SERVICE_AGREEMENTS)[number];
/** Onboarding inside the app (Stripe's embedded component) or on Stripe's hosted page (an Account Link). */
export const ONBOARDING_MODES = ["embedded", "hosted"] as const;
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];
/** Tips of a barber who can't be paid directly: owed, then paid through payroll at the pay period cutoff; or held until their account is active. */
export const OWED_VIA = ["payroll", "hold"] as const;
export type OwedVia = (typeof OWED_VIA)[number];
/** When a refund takes the tip back from the barber: only a full refund inside the window, any refund that gives tip back, or never. */
export const REVERSAL_RULES = ["full_refund_in_window", "any_refund", "never"] as const;
export type ReversalRule = (typeof REVERSAL_RULES)[number];
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
  tipDate: TipDateRule;
  taxForms: TaxFormFiling;
  /** The month (1 to 12) the yearly tax form check comes due, before Stripe files for the year just ended. */
  taxCheckMonth: number;
  /** An employee must see and accept Stripe's instant payout fee before instant payouts turn on. */
  instantFeeAck: boolean;
}

export const DEFAULT_STAFF_PAYOUT_SETTINGS: StaffPayoutSettings = {
  dashboard: "none",
  serviceAgreement: "recipient",
  onboarding: "embedded",
  owedVia: "payroll",
  reversalRule: "full_refund_in_window",
  reversalWindowDays: 7,
  tipDate: "sale_date",
  taxForms: "will_not_file",
  taxCheckMonth: 1,
  instantFeeAck: true,
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
    tipDate: pick(TIP_DATE_RULES, r.tipDate, d.tipDate),
    taxForms: pick(TAX_FORM_FILING, r.taxForms, d.taxForms),
    taxCheckMonth: int(r.taxCheckMonth, 1, 12, d.taxCheckMonth),
    instantFeeAck: typeof r.instantFeeAck === "boolean" ? r.instantFeeAck : d.instantFeeAck,
  };
}

export const DASHBOARD_LABEL: Record<AccountDashboard, string> = { none: "None: everything in the Ray'z app", express: "Stripe Express dashboard" };
export const SERVICE_AGREEMENT_LABEL: Record<ServiceAgreement, string> = { recipient: "Recipient (receives tips only)", full: "Full" };
export const ONBOARDING_LABEL: Record<OnboardingMode, string> = { embedded: "In the app (embedded), with Stripe's page as the fallback", hosted: "Stripe's hosted page" };
export const OWED_VIA_LABEL: Record<OwedVia, string> = {
  payroll: "Owed, then paid through payroll at the pay period cutoff",
  hold: "Held until their Stripe account is active",
};
export const REVERSAL_RULE_LABEL: Record<ReversalRule, string> = {
  full_refund_in_window: "Only a full refund within the window",
  any_refund: "Any refund that gives tip back",
  never: "Never: the shop absorbs every refunded tip",
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

export type ReversalOutcome = "reverse" | "absorb_partial" | "absorb_window" | "absorb_rule";
export const ABSORB_KIND: Record<Exclude<ReversalOutcome, "reverse">, "partial_refund" | "outside_window" | "rule"> = {
  absorb_partial: "partial_refund",
  absorb_window: "outside_window",
  absorb_rule: "rule",
};
export const ABSORPTION_KINDS = ["partial_refund", "outside_window", "rule", "dispute"] as const;
export type AbsorptionKind = (typeof ABSORPTION_KINDS)[number];
export const ABSORPTION_LABEL: Record<AbsorptionKind, string> = {
  partial_refund: "Partial refund",
  outside_window: "Refund after the window",
  rule: "Refund (brand never reverses tips)",
  dispute: "Card dispute",
};

/**
 * Whether a refund that gave tip back takes it from the barber, or the shop absorbs it. Full: the
 * payment is fully refunded once this refund is counted with the earlier ones. The window counts
 * calendar days from the sale's business date to the refund's.
 */
export function reversalOutcome(s: Pick<StaffPayoutSettings, "reversalRule" | "reversalWindowDays">, r: { saleDate: LocalDate; refundDate: LocalDate; fullyRefunded: boolean }): ReversalOutcome {
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
