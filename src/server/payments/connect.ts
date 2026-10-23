import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff } from "@/db/schema";
import { appBaseUrl } from "@/lib/deployment";
import { AppError, notFound } from "@/server/errors";
import { assertStripeTestMode, stripe } from "./processor";

/**
 * Hosted Stripe Connect onboarding for one shop. The platform account is the only Stripe account
 * we hold keys for. Each shop gets a connected account id on `shops.stripe_account_id`.
 * `owner_entity_id` is left null until franchise entities exist; it is copied onto the account metadata.
 */
export async function createConnectOnboardingLink(shopRef: string) {
  assertStripeTestMode();
  const shop = await db.query.shops.findFirst({ where: eq(shops.slug, shopRef) });
  const row =
    shop ??
    (/^[0-9a-f-]{36}$/i.test(shopRef) ? await db.query.shops.findFirst({ where: eq(shops.id, shopRef) }) : undefined);
  if (!row) throw notFound("Shop");
  const s = stripe();
  if (!s) {
    const stripeAccountId = row.stripeAccountId ?? `acct_sim_${row.slug}`;
    if (!row.stripeAccountId) await db.update(shops).set({ stripeAccountId }).where(eq(shops.id, row.id));
    return {
      shopId: row.id,
      stripeAccountId,
      ownerEntityId: row.ownerEntityId,
      url: `https://connect.stripe.com/setup/e/${stripeAccountId}`,
      mode: "simulator" as const,
    };
  }
  let stripeAccountId = row.stripeAccountId;
  if (!stripeAccountId) {
    const acct = await s.accounts.create({
      type: "express",
      country: "US",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { shopId: row.id, ownerEntityId: row.ownerEntityId ?? "" },
    });
    stripeAccountId = acct.id;
    await db.update(shops).set({ stripeAccountId }).where(eq(shops.id, row.id));
  }
  const base = appBaseUrl();
  const link = await s.accountLinks.create({
    account: stripeAccountId,
    type: "account_onboarding",
    refresh_url: `${base}/admin/shops/${row.slug}`,
    return_url: `${base}/admin/shops/${row.slug}`,
  });
  return { shopId: row.id, stripeAccountId, ownerEntityId: row.ownerEntityId, url: link.url, mode: "stripe" as const };
}

/**
 * Optional Express onboarding for a barber. Not required, and not used for W-2 tips.
 * Tip transfers stay off (not for W-2 employees, pending CPA) until FEATURE_TIP_TO_BARBER is set.
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
      url: `https://connect.stripe.com/setup/e/${stripeAccountId}`,
      mode: "simulator" as const,
    };
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

export function assertInternalSecret(req: Request) {
  const secret = process.env.IMPORT_SECRET || process.env.CRON_SECRET;
  const header = req.headers.get("x-import-secret") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!secret || header !== secret) throw new AppError("unauthorized", "Not authorized");
}
