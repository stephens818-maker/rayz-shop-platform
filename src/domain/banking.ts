/**
 * An employee's tip payout account on Stripe, as the app sees it: a status, what Stripe still needs
 * in plain words, and where payouts go (type, bank or card name, last 4). Stripe holds identity, tax
 * and bank details; nothing here ever carries a full account, card or SSN number. Pure, so the status
 * flow is tested without Stripe (tests/banking-status.test.ts).
 */

export const BANKING_STATUSES = ["not_set_up", "pending_verification", "ready", "action_needed"] as const;
export type BankingStatus = (typeof BANKING_STATUSES)[number];

export const BANKING_STATUS_LABEL: Record<BankingStatus, string> = {
  not_set_up: "Not set up",
  pending_verification: "Pending verification",
  ready: "Ready",
  action_needed: "Action needed",
};

export const BANKING_STATUS_TONE = { not_set_up: "gray", pending_verification: "blue", ready: "green", action_needed: "amber" } as const;

export interface BankingFacts {
  stripeAccountId: string | null;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  /** Stripe's past due and currently due requirements. */
  requirementsDue: readonly string[];
  disabledReason: string | null;
}

/**
 * Not set up until the employee finishes Stripe's onboarding. Then action needed while Stripe asks
 * for anything (or has rejected the account), pending verification while it checks what was sent,
 * and ready once payouts are on.
 */
export function bankingStatus(a: BankingFacts | null): BankingStatus {
  if (!a?.stripeAccountId || !a.detailsSubmitted) return "not_set_up";
  if (a.requirementsDue.length || a.disabledReason?.startsWith("rejected")) return "action_needed";
  return a.payoutsEnabled ? "ready" : "pending_verification";
}

const REQUIREMENT_LABEL: Record<string, string> = {
  external_account: "A bank account or debit card for payouts",
  "tos_acceptance.date": "Accepting Stripe's terms",
  "tos_acceptance.ip": "Accepting Stripe's terms",
  "individual.first_name": "Your legal first name",
  "individual.last_name": "Your legal last name",
  "individual.email": "Your email address",
  "individual.phone": "Your phone number",
  "individual.ssn_last_4": "The last 4 digits of your Social Security number",
  "individual.id_number": "Your full Social Security number",
  "individual.verification.document": "A photo of your ID",
  "individual.verification.additional_document": "A second document, such as a utility bill",
  "business_profile.url": "A website or social profile",
  "business_profile.mcc": "Your type of work",
};

/** Stripe's requirement keys in plain words, each once (Stripe lists the parts of an address or birth date separately). */
export function requirementLabels(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    if (REQUIREMENT_LABEL[k]) out.add(REQUIREMENT_LABEL[k]);
    else if (k.startsWith("individual.dob")) out.add("Your date of birth");
    else if (k.startsWith("individual.address")) out.add("Your home address");
    else if (k.startsWith("external_account")) out.add(REQUIREMENT_LABEL.external_account);
    else out.add(k.replace(/^individual\./, "").replace(/[._]/g, " "));
  }
  return [...out];
}

export interface PayoutDestination {
  type: "bank_account" | "card";
  last4: string;
  /** The bank's name or the card's brand. */
  name: string | null;
}

interface StripeExternalAccountLike {
  object?: string;
  last4?: string | null;
  bank_name?: string | null;
  brand?: string | null;
  default_for_currency?: boolean | null;
}

/** Only the type, last 4 and name of a Stripe bank account or card; anything else Stripe sends is dropped. */
export function destinationOf(x: StripeExternalAccountLike | null | undefined): PayoutDestination | null {
  if (!x || (x.object !== "bank_account" && x.object !== "card") || !x.last4 || !/^\d{4}$/.test(x.last4)) return null;
  return { type: x.object, last4: x.last4, name: (x.object === "bank_account" ? x.bank_name : x.brand)?.slice(0, 60) || null };
}

/** The account's payout destination: the default one for USD, or the only one. */
export function defaultDestination(list: readonly StripeExternalAccountLike[] | null | undefined): PayoutDestination | null {
  const xs = (list ?? []).filter((x) => destinationOf(x));
  return destinationOf(xs.find((x) => x.default_for_currency) ?? (xs.length === 1 ? xs[0] : null));
}

export function sameDestination(a: PayoutDestination | null, b: PayoutDestination | null): boolean {
  return a?.type === b?.type && a?.last4 === b?.last4 && (a?.name ?? null) === (b?.name ?? null);
}

/** "Chase ••6789" or "Visa debit card ••5556". */
export function destinationLabel(d: Pick<PayoutDestination, "type" | "last4" | "name"> | null): string {
  if (!d) return "None yet";
  const name = d.name ?? (d.type === "card" ? "Debit card" : "Bank account");
  return `${name}${d.type === "card" && d.name ? " card" : ""} ••${d.last4}`;
}
