import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { taxFormExclusionCsv } from "@/server/tips/accounts";
import { stripePayoutsOn } from "@/server/tips/payout-model";

/**
 * The Stripe Dashboard import that sets every employee account's 1099 to not file (their tips are
 * W-2 wages through payroll). Brand-wide only: it lists every shop's accounts.
 */
export async function GET() {
  const ctx = await routeStaff("tips.approve");
  if (ctx instanceof Response) return ctx;
  if (!ctx.brandWide) return new Response("Only someone with every shop can download this.", { status: 403 });
  if (!stripePayoutsOn()) return new Response("Direct Stripe payouts are switched off on this deployment.", { status: 409 });
  const { csv, accounts } = await taxFormExclusionCsv();
  await audit(ctx.actor, "tips.tax_form_exclusions", "stripe_tax_forms", null, { accounts });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="stripe-1099-not-required.csv"`,
      "cache-control": "no-store",
    },
  });
}
