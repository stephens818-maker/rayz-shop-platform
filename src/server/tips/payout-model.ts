/**
 * Which tip payout rails this deployment runs (ST-C7). Payroll (the iSolved export) and cash from
 * the drawer always work; direct Stripe payouts to each employee's own Express account are on
 * unless FEATURE_STAFF_STRIPE_PAYOUTS=false. Every reader of the tip policy goes through `railed`,
 * so with the rail off no screen offers Stripe, no batch pays by it, and nothing onboards an
 * employee to it; the stored policy keeps its Stripe choice so switching back on picks up where the
 * brand left it.
 */
import { BrandTipPolicy, PayoutRails, withPayoutRails } from "@/domain/tips";
import { flags } from "@/lib/flags";
import { AppError } from "@/server/errors";

export const payoutRails = (): PayoutRails => ({ stripe: flags.staffStripePayouts() });
export const stripePayoutsOn = () => payoutRails().stripe;
export const railed = (p: BrandTipPolicy): BrandTipPolicy => withPayoutRails(p, payoutRails());

export const STRIPE_PAYOUTS_HELD = "Direct Stripe tip payouts to employees are switched off on this deployment. Tips are paid through payroll (iSolved) instead.";

export function assertStripePayouts() {
  if (!stripePayoutsOn()) throw new AppError("forbidden", STRIPE_PAYOUTS_HELD, { feature: "staff_stripe_payouts", enabled: false });
}
