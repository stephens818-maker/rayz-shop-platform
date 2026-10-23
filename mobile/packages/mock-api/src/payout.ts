import type { PayoutAccountState } from "@rayz/api";

export interface PayoutFlags {
  exists: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  transfersActive: boolean;
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
  fieldsCollected: boolean;
  currentDeadline: string | null;
  externalLast4: string | null;
  externalType: "bank" | "card" | null;
  instantEligible: boolean;
  instantOptIn: boolean;
}

export function derivePayoutState(flags: PayoutFlags): PayoutAccountState {
  if (!flags.exists || (!flags.fieldsCollected && !flags.detailsSubmitted)) return "not_started";
  if (flags.disabledReason?.startsWith("rejected.")) return "rejected";
  if (!flags.payoutsEnabled && (flags.pastDue.length > 0 || (flags.disabledReason && !flags.disabledReason.startsWith("rejected.")))) return "restricted";
  if (flags.detailsSubmitted && flags.pendingVerification.length > 0 && !flags.payoutsEnabled) return "pending_verification";
  if (flags.currentlyDue.length > 0) return "requirements_due";
  if (flags.payoutsEnabled && flags.transfersActive && flags.currentlyDue.length === 0 && flags.pastDue.length === 0) return "active";
  if (flags.fieldsCollected && !flags.detailsSubmitted) return "in_progress";
  return "in_progress";
}

export function flagsForState(state: PayoutAccountState): PayoutFlags {
  const base: PayoutFlags = {
    exists: true,
    detailsSubmitted: false,
    payoutsEnabled: false,
    transfersActive: false,
    currentlyDue: [],
    pastDue: [],
    pendingVerification: [],
    disabledReason: null,
    fieldsCollected: false,
    currentDeadline: null,
    externalLast4: null,
    externalType: null,
    instantEligible: false,
    instantOptIn: false,
  };
  if (state === "not_started") return { ...base, exists: false };
  if (state === "in_progress") return { ...base, fieldsCollected: true };
  if (state === "pending_verification") return { ...base, detailsSubmitted: true, fieldsCollected: true, pendingVerification: ["individual.id_number"] };
  if (state === "requirements_due") return { ...base, detailsSubmitted: true, fieldsCollected: true, payoutsEnabled: true, transfersActive: true, currentlyDue: ["external_account"], currentDeadline: "2026-11-06" };
  if (state === "restricted") return { ...base, detailsSubmitted: true, fieldsCollected: true, pastDue: ["external_account"], disabledReason: "requirements.past_due" };
  if (state === "rejected") return { ...base, detailsSubmitted: true, fieldsCollected: true, disabledReason: "rejected.fraud" };
  return { ...base, detailsSubmitted: true, fieldsCollected: true, payoutsEnabled: true, transfersActive: true, externalLast4: "6789", externalType: "bank", instantEligible: true };
}

export const PAYOUT_COPY: Record<PayoutAccountState, { title: string; body: string; action: string | null }> = {
  not_started: {
    title: "Set up tip deposits",
    body: "Set up tip deposits so your card tips reach your bank. Until then, they're saved and paid on your paycheck.",
    action: "Set up",
  },
  in_progress: { title: "You're almost done", body: "You're almost done, about 2 minutes left.", action: "Continue" },
  pending_verification: {
    title: "Stripe is checking your info",
    body: "Stripe is checking your info. This usually takes a few minutes, sometimes 1–2 days. Tips are saved meanwhile.",
    action: null,
  },
  requirements_due: { title: "Stripe needs one more thing", body: "Stripe needs one more thing before tip deposits can continue.", action: "Update" },
  restricted: {
    title: "Tip deposits are paused",
    body: "Tip deposits are paused. Your tips are safe and will go out once this is fixed.",
    action: "Fix now",
  },
  active: { title: "Tip deposits are on", body: "Tip deposits are on.", action: null },
  rejected: {
    title: "Deposits weren't approved",
    body: "We couldn't set up deposits. Your tips will be paid on your paycheck. Your manager will follow up.",
    action: null,
  },
};
