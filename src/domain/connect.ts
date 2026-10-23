/**
 * Stripe Connect, merchant-of-record model: one Ray'z platform account and one connected account
 * per shop. A card charge is a destination charge settled on behalf of the shop's account
 * (on_behalf_of + transfer_data.destination). The platform keeps an application fee equal to the
 * shop's processing fee, so revenue, tips, surcharges, refunds, fees and payouts all land in
 * the shop's own account. Pure: the states, the fee schedule and their labels.
 */

export interface AccountFlags {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  deauthorizedAt: Date | string | null;
}

export type AccountState = "not_started" | "onboarding" | "in_review" | "restricted" | "enabled" | "disconnected";

export const ACCOUNT_STATE_LABEL: Record<AccountState, string> = {
  not_started: "Not set up",
  onboarding: "Onboarding not finished",
  in_review: "Stripe is reviewing",
  restricted: "Needs attention",
  enabled: "Taking card payments",
  disconnected: "Disconnected",
};

export function accountState(a: AccountFlags | null | undefined): AccountState {
  if (!a) return "not_started";
  if (a.deauthorizedAt) return "disconnected";
  if (a.chargesEnabled && a.payoutsEnabled && !a.requirementsDue.length) return "enabled";
  if (a.chargesEnabled) return "restricted";
  if (!a.detailsSubmitted) return "onboarding";
  return a.requirementsDue.length || a.disabledReason ? "restricted" : "in_review";
}

/** Card payments need the account's charges capability; payouts can lag behind. */
export const canCharge = (a: AccountFlags | null | undefined) => !!a && !a.deauthorizedAt && a.chargesEnabled;

export interface FeeRate {
  /** Fraction, e.g. 0.029. */
  rate: number;
  fixedCents: number;
}
export type EntryMode = "keyed" | "terminal";

/** Stripe's standard US card pricing: online and keyed 2.9% + 30¢, in person (Terminal) 2.7% + 5¢. */
export const DEFAULT_PROCESSING_FEES: Record<EntryMode, FeeRate> = { keyed: { rate: 0.029, fixedCents: 30 }, terminal: { rate: 0.027, fixedCents: 5 } };

/** "2.9%+30" → { rate: 0.029, fixedCents: 30 }. Null for anything else. */
export function parseFeeRate(s: string | null | undefined): FeeRate | null {
  const m = s?.replace(/\s|¢/g, "").match(/^(\d+(?:\.\d+)?)%(?:\+(\d+))?$/);
  if (!m) return null;
  const rate = Number((Number(m[1]) / 100).toFixed(6));
  if (!(rate >= 0 && rate < 0.2)) return null;
  return { rate, fixedCents: m[2] ? Number(m[2]) : 0 };
}

/**
 * The application fee on one charge: the shop's processing fee, never more than the charge.
 * Refunds don't give it back, the same as Stripe's own fee on a standard account.
 */
export function processingFeeCents(amountCents: number, fee: FeeRate): number {
  if (amountCents <= 0) return 0;
  return Math.min(amountCents, Math.round(amountCents * fee.rate) + fee.fixedCents);
}

export const formatFeeRate = (f: FeeRate) => `${+(f.rate * 100).toFixed(2)}%${f.fixedCents ? ` + ${f.fixedCents}¢` : ""}`;

/** Readable names for the Stripe requirement fields shown in setup. */
export function requirementLabel(field: string): string {
  const known: Record<string, string> = {
    external_account: "Bank account for payouts",
    "business_profile.url": "Business website",
    "business_profile.mcc": "Business category",
    "business_profile.product_description": "What the business sells",
    tos_acceptance: "Accept Stripe's terms",
    "tos_acceptance.date": "Accept Stripe's terms",
    "tos_acceptance.ip": "Accept Stripe's terms",
    "company.tax_id": "Business tax ID (EIN)",
    "company.name": "Legal business name",
    "company.address": "Business address",
    "company.phone": "Business phone",
    representative: "Account representative",
  };
  if (known[field]) return known[field];
  const tail = field.split(".").pop() ?? field;
  if (/^(person_|individual)/.test(field)) return `Owner details (${tail.replace(/_/g, " ")})`;
  return tail.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const OWNER_KIND_LABEL = { brand: "Brand-owned", franchisee: "Franchisee" } as const;

export function ownerEntityProblem(v: { name: string; kind: string; contactEmail?: string | null }): string | null {
  if (v.name.trim().length < 2) return "Give the owner a name";
  if (v.kind !== "brand" && v.kind !== "franchisee") return "Pick brand-owned or franchisee";
  if (v.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.contactEmail)) return "That email doesn't look right";
  return null;
}
