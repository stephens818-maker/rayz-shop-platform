/**
 * Switches for decisions the owner hasn't made yet. Each is off unless its env var is exactly "true".
 * - reviewLogin (C18): a sign-in for app store reviewers.
 * - walletFee: whether the credit-card surcharge also applies to credit cards paid through Apple Pay or Google Pay.
 * - staffStripePayouts (ST-C7, on hold): tips paid straight to each employee's own Stripe Express account. Ray'z staff are
 *   hourly W-2 employees whose tips may need payroll withholding, so off means tips go through payroll (the iSolved export).
 */
export const flags = {
  reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true",
  walletFee: () => process.env.FEATURE_WALLET_FEE === "true",
  staffStripePayouts: () => process.env.FEATURE_STAFF_STRIPE_PAYOUTS === "true",
};
