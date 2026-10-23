import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { appBaseUrl } from "@/lib/deployment";
import { notFound } from "@/server/errors";
import { assertStripeTestMode, stripe } from "./processor";

/**
 * Stripe-hosted onboarding for a barber's recipient account (ST-I9).
 * controller.stripe_dashboard.type is "none". Account Links are the only way bank details and a tax id are collected.
 * This server stores the account id and never asks for those fields.
 */
export async function createBarberConnectOnboardingLink(staffRef: string) {
  assertStripeTestMode();
  const byId = /^[0-9a-f-]{36}$/i.test(staffRef) ? eq(staff.id, staffRef) : undefined;
  const row = await db.query.staff.findFirst({
    where: byId ? or(byId, eq(staff.publicSlug, staffRef), eq(staff.staffCode, staffRef)) : or(eq(staff.publicSlug, staffRef), eq(staff.staffCode, staffRef)),
  });
  if (!row) throw notFound("Staff");
  const s = stripe();
  if (!s) {
    const stripeAccountId = row.stripeAccountId ?? `acct_sim_staff_${row.publicSlug}`;
    if (!row.stripeAccountId) await db.update(staff).set({ stripeAccountId }).where(eq(staff.id, row.id));
    return {
      staffId: row.id,
      stripeAccountId,
      url: `https://connect.stripe.com/setup/c/${stripeAccountId}`,
      mode: "simulator" as const,
      accountType: "recipient" as const,
    };
  }
  let stripeAccountId = row.stripeAccountId;
  if (!stripeAccountId) {
    const acct = await s.accounts.create({
      country: "US",
      controller: {
        stripe_dashboard: { type: "none" },
        fees: { payer: "application" },
        losses: { payments: "application" },
        requirement_collection: "stripe",
      },
      capabilities: { transfers: { requested: true } },
      metadata: { staffId: row.id, accountType: "recipient" },
    });
    stripeAccountId = acct.id;
    await db.update(staff).set({ stripeAccountId }).where(eq(staff.id, row.id));
  }
  const base = appBaseUrl();
  const link = await s.accountLinks.create({
    account: stripeAccountId,
    type: "account_onboarding",
    refresh_url: `${base}/admin/staff/${row.publicSlug}`,
    return_url: `${base}/admin/staff/${row.publicSlug}`,
  });
  return { staffId: row.id, stripeAccountId, url: link.url, mode: "stripe" as const, accountType: "recipient" as const };
}
