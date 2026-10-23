/**
 * Switches for decisions the owner hasn't made yet.
 * - reviewLogin (C18): a sign-in for app store reviewers. On only when FEATURE_REVIEW_LOGIN is exactly "true".
 * - walletFee: the credit-card surcharge also applies to a credit card in Apple Pay or Google Pay.
 *   FEATURE_WALLET_FEE accepts 1, true, and on, matching the mobile mock. Anything else is off.
 */
function envOn(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export const flags = { reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true", walletFee: () => envOn("FEATURE_WALLET_FEE") };
