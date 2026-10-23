import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { appBaseUrl } from "@/lib/deployment";
import { notFound } from "@/server/errors";
import { assertStripeTestMode, stripe } from "./processor";

/**
 * Optional Express onboarding for a barber. Not required.
 * Tip transfers stay off (not for W-2 employees, pending CPA) until FEATURE_TIP_TO_BARBER is set.
 * Employee tips go through iSolved payroll.
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
    return { staffId: row.id, stripeAccountId, url: `https://connect.stripe.com/setup/e/${stripeAccountId}`, mode: "simulator" as const };
  }
  let stripeAccountId = row.stripeAccountId;
  if (!stripeAccountId) {
    const acct = await s.accounts.create({
      type: "express",
      country: "US",
      capabilities: { transfers: { requested: true } },
      metadata: { staffId: row.id },
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
  return { staffId: row.id, stripeAccountId, url: link.url, mode: "stripe" as const };
}
