import type { PayoutAccountState } from "@rayz/api";

/** Barber-facing copy. The screen says tip deposits, never a dashboard or account type. */
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

export const PAYOUT_STATES: PayoutAccountState[] = [
  "not_started",
  "in_progress",
  "pending_verification",
  "requirements_due",
  "restricted",
  "active",
  "rejected",
];
