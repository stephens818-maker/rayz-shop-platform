/**
 * Switches for decisions the owner hasn't made yet, each off unless its env var is exactly "true";
 * staffStripePayouts and tipToBarber, which the owner has decided, are on unless their env var is "false" (exactly, for
 * staffStripePayouts; in any case, for the tipToBarber kill switch).
 * - reviewLogin (C18): a sign-in for app store reviewers.
 * - walletFee: whether the credit-card surcharge also applies to credit cards paid through Apple Pay or Google Pay.
 * - staffStripePayouts (ST-C7, ST-I9): tips paid straight to each employee's own Stripe recipient account (Charles,
 *   2026-10-27). Each direct payout still goes to iSolved as tips already received, so it's in W-2 wages and withheld on
 *   from regular pay. "false" turns the rail off: tips go through payroll (the iSolved export) or cash.
 * - staffTapToPay (ST-I4): Stripe Terminal Tap to Pay in the staff app. Needs Apple's Tap to Pay entitlement and each shop's
 *   Terminal location; until then checkout stays at the front desk.
 * - staffReviewLogin (ST-I19): the Demo Shop reviewer login for the staff app's App Store and Google Play review.
 * - tipToBarber (I10, ST-C11): on at launch (Charles, 2026-10-28: his CPA approved direct Stripe tip payouts, as Squire
 *   pays them). Each card tip of a separate charge is transferred to its barber's recipient account at the sale
 *   (settlement.ts, with source_transaction), and their Stripe payout pays it out of that balance. "false" turns it off
 *   brand-wide, and a shop's Tips to barbers switch (shops.tip_to_barber, tipToBarberAt) turns it off there: the tip stays
 *   in the shop's transfer and is paid through payroll. Either way every tip goes to iSolved under E_Cash Tips Recd. Live
 *   money also needs MONEY_MOVEMENT_LIVE.
 */
export const flags = {
  reviewLogin: () => process.env.FEATURE_REVIEW_LOGIN === "true",
  walletFee: () => process.env.FEATURE_WALLET_FEE === "true",
  staffStripePayouts: () => process.env.FEATURE_STAFF_STRIPE_PAYOUTS !== "false",
  staffTapToPay: () => process.env.FEATURE_STAFF_TAP_TO_PAY === "true",
  staffReviewLogin: () => process.env.FEATURE_STAFF_REVIEW_LOGIN === "true",
  tipToBarber: () => process.env.FEATURE_TIP_TO_BARBER?.trim().toLowerCase() !== "false",
};
