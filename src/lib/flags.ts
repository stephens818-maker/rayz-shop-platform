/**
 * Switches for decisions the owner hasn't made yet.
 * - reviewLogin (C18): a sign-in for app store reviewers. On only when FEATURE_REVIEW_LOGIN is exactly "true".
 * - walletFee: the credit-card surcharge also applies to a credit card in Apple Pay or Google Pay.
 *   FEATURE_WALLET_FEE is on only when it is exactly "true". The flag adds a fee, so anything else stays off.
 */
export const flags = {
  reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true",
  walletFee: () => process.env.FEATURE_WALLET_FEE === "true",
};
