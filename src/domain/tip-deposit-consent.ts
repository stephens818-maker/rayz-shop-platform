/**
 * An employee's consent to be paid their tips by direct deposit through Stripe (ST-C17). Wage laws
 * want paying wages to a bank account or card to be the employee's voluntary written choice, and
 * that it can be withdrawn (Illinois 820 ILCS 115/4, Iowa 91A.3). Each grant records the wording's
 * version and text; a new version needs a fresh yes, and until then their Stripe tips wait as owed.
 */

export const TIP_DEPOSIT_CONSENT_VERSION = "2026-10-27";

export const TIP_DEPOSIT_CONSENT_TEXT =
  "I choose to receive my tips by direct deposit to my own bank account or debit card through Stripe. This is voluntary: I don't have to agree, and I can withdraw at any time from My banking or the staff app. My tips are still wages on my W-2, and payroll withholds tax on them. If I withdraw or don't agree, my tips are paid another way, such as with my paycheck through payroll.";

export type TipDepositConsentSource = "web" | "staff_app";

export interface DepositConsentState {
  depositConsentVersion: string | null;
  depositConsentAt: Date | null;
}

/** The employee agreed to today's wording. */
export const hasDepositConsent = (a: Partial<DepositConsentState> | null | undefined) => !!a?.depositConsentAt && a.depositConsentVersion === TIP_DEPOSIT_CONSENT_VERSION;

export type DepositConsentStatus = "granted" | "needs_renewal" | "not_given";

export function depositConsentStatus(a: Partial<DepositConsentState> | null | undefined): DepositConsentStatus {
  if (hasDepositConsent(a)) return "granted";
  return a?.depositConsentAt ? "needs_renewal" : "not_given";
}

export const DEPOSIT_CONSENT_LABEL: Record<DepositConsentStatus, string> = {
  granted: "Agreed",
  needs_renewal: "Wording changed; agree again",
  not_given: "Not agreed",
};

export const CONSENT_HOLD_REASON = "Waiting for them to agree to Stripe tip deposits; sent on its own once they do";
