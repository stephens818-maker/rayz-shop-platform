/**
 * Switches for decisions the owner hasn't made yet, each off unless its env var is exactly "true";
 * staffStripePayouts, which the owner has decided, is on unless its env var is exactly "false".
 * - reviewLogin (C18): a sign-in for app store reviewers.
 * - walletFee: whether the credit-card surcharge also applies to credit cards paid through Apple Pay or Google Pay.
 * - staffStripePayouts (ST-C7, ST-I9): tips paid straight to each employee's own Stripe Express account (Charles,
 *   2026-10-27). Each direct payout still goes to iSolved as tips already received, so it's in W-2 wages and withheld on
 *   from regular pay. "false" turns the rail off: tips go through payroll (the iSolved export) or cash.
 * - staffTapToPay (ST-I4): Stripe Terminal Tap to Pay in the staff app. Needs Apple's Tap to Pay entitlement and each shop's
 *   Terminal location; until then checkout stays at the front desk.
 */
export const flags = {
  reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true",
  walletFee: () => process.env.FEATURE_WALLET_FEE === "true",
  staffStripePayouts: () => process.env.FEATURE_STAFF_STRIPE_PAYOUTS !== "false",
  staffTapToPay: () => process.env.FEATURE_STAFF_TAP_TO_PAY === "true",
};
