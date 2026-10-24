/**
 * Switches for decisions the owner hasn't made yet. Each is off unless its env var is exactly "true".
 * - reviewLogin (C18): a sign-in for app store reviewers.
 * - walletFee: whether the credit-card surcharge also applies to credit cards paid through Apple Pay or Google Pay.
 */
export const flags = { reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true", walletFee: () => process.env.FEATURE_WALLET_FEE === "true" };
