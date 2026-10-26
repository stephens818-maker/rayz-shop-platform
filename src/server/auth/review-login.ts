import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, otpCodes, shops } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit, SYSTEM } from "@/server/audit";
import { AppError } from "@/server/errors";
import { sha256 } from "./tokens";

/**
 * C18 scaffold, NOT APPROVED: the App Review sign-in. Off unless APP_REVIEW_LOGIN=true, and then
 * only with APP_REVIEW_PHONE and a 6-digit APP_REVIEW_CODE. That one phone signs in with that
 * fixed code instead of a texted one (nothing is sent, and the code is never shown), onto a
 * sandbox profile ("App Review"). Every code request is audit-logged. Its bookings stay at
 * APP_REVIEW_SHOP when that's set, and notify nobody. It can't pay against live Stripe keys.
 * APP_REVIEW_EMAIL, when set, is the monitored inbox reviewers can sign in with by an emailed
 * code instead; it lands on the same sandbox profile.
 */
const env = (k: string) => process.env[k]?.trim() || null;

export function reviewLoginOn(): boolean {
  return process.env.APP_REVIEW_LOGIN === "true" && !!normalizePhone(env("APP_REVIEW_PHONE")) && /^\d{6}$/.test(env("APP_REVIEW_CODE") ?? "");
}

export function reviewPhone(): string | null {
  return reviewLoginOn() ? normalizePhone(env("APP_REVIEW_PHONE")) : null;
}

export function reviewEmail(): string | null {
  return reviewLoginOn() ? normalizeEmail(env("APP_REVIEW_EMAIL")) : null;
}

export function isReviewIdentifier(identifier: string): boolean {
  return !!identifier && (identifier === reviewPhone() || identifier === reviewEmail());
}

/** The sandbox profile, made on first use. */
export async function reviewProfile() {
  const phone = reviewPhone();
  if (!phone) throw new AppError("forbidden", "The review sign-in is off");
  const [hit] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.phone, phone), isNull(customers.guardianId), isNull(customers.deletedAt)))
    .limit(1);
  const email = reviewEmail();
  if (hit) {
    if (email && hit.email !== email) await db.update(customers).set({ email, emailVerifiedAt: new Date() }).where(eq(customers.id, hit.id));
    return hit;
  }
  const shopSlug = env("APP_REVIEW_SHOP");
  const [shop] = shopSlug ? await db.select({ id: shops.id }).from(shops).where(eq(shops.slug, shopSlug)) : [];
  const [row] = await db
    .insert(customers)
    .values({
      firstName: "App",
      lastName: "Review",
      phone,
      email,
      emailVerifiedAt: email ? new Date() : null,
      source: "App Review",
      homeShopId: shop?.id ?? null,
      ageConfirmedAt: new Date(),
      identityVerifiedAt: new Date(),
    })
    .returning();
  await audit(SYSTEM, "review.profile_created", "customer", row.id, {}, null);
  return row;
}

/** In place of sending a code: the fixed review code, stored hashed like any other. */
export async function issueReviewCode(identifier: string, ip: string | null) {
  await reviewProfile();
  await db.insert(otpCodes).values({ identifier, codeHash: sha256(`${identifier}:${env("APP_REVIEW_CODE")}`), purpose: "sign_in", provider: "review", expiresAt: new Date(Date.now() + 10 * 60_000) });
  await audit(SYSTEM, "review.sign_in_code", "otp", identifier, { ip }, null);
  return { channel: "sms", expiresInSeconds: 600 } as { channel: "sms" | "email"; expiresInSeconds: number; devCode?: string };
}

export async function isReviewAccount(customerId: string): Promise<boolean> {
  const phone = reviewPhone();
  if (!phone) return false;
  const [c] = await db.select({ phone: customers.phone }).from(customers).where(eq(customers.id, customerId));
  return c?.phone === phone;
}

/** The review account books only at APP_REVIEW_SHOP when one is named. */
export async function assertReviewShop(shopRef: string) {
  const slug = env("APP_REVIEW_SHOP");
  if (!slug) return;
  const [s] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(or(eq(shops.slug, shopRef), sql`${shops.id}::text = ${shopRef}`));
  const [review] = await db.select({ id: shops.id }).from(shops).where(eq(shops.slug, slug));
  if (!s || s.id !== review?.id) throw new AppError("forbidden", "The App Review account books at the review shop only.", { reason: "review_account" });
}

/** Live Stripe keys never take a card from the review account. */
export async function assertReviewCanPay(customerId: string) {
  if (!(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_")) return;
  if (await isReviewAccount(customerId)) throw new AppError("forbidden", "Payments are turned off for the App Review account.", { reason: "review_account" });
}
