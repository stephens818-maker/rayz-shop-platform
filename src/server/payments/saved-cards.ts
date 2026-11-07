import { assertReviewCanPay } from "@/server/auth/review-login";
import type Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { customerCards, customerSquireIds, customers } from "@/db/schema";
import { SYSTEM, audit, customerActor } from "@/server/audit";
import { AppError, forbidden, notFound } from "@/server/errors";
import { householdHead } from "@/server/family";
import { flags } from "@/lib/flags";
import { type CardDetails, TEST_CARDS, inspectPaymentMethod, paymentsMode, stripe } from "./processor";

/** A client keeps at most this many cards. */
export const MAX_SAVED_CARDS = 10;

export type SavedCard = typeof customerCards.$inferSelect;

/** Cards belong to the account holder: a child's are the parent's (I1). */
export async function cardHolder(customerId: string, tx: DBorTx = db) {
  return householdHead(customerId, tx);
}

/** The holder's platform-level Stripe Customer, made on first use. Nothing about them is sent to Stripe but our id. */
export async function ensureStripeCustomer(holderId: string, tx: DBorTx = db): Promise<string> {
  const [c] = await tx
    .select({ id: customers.id, guardianId: customers.guardianId, stripe: customers.stripeCustomerId, deletedAt: customers.deletedAt })
    .from(customers)
    .where(eq(customers.id, holderId));
  if (!c || c.deletedAt) throw notFound("Account");
  if (c.guardianId) throw new AppError("bad_request", "Cards are saved on the parent's account");
  if (c.stripe && (paymentsMode() === "simulator" || !c.stripe.startsWith("sim_"))) return c.stripe;
  const s = stripe();
  const id = s
    ? (
        await s.customers.create({ metadata: { customerId: holderId } }, { idempotencyKey: `customer-${holderId}-${c.stripe ?? "new"}` }).catch((e: Stripe.errors.StripeError) => {
          throw new AppError("payment_failed", `Stripe didn't set up your wallet: ${e.message}`);
        })
      ).id
    : `sim_cus_${randomBytes(6).toString("hex")}`;
  const [row] = await tx
    .update(customers)
    .set({ stripeCustomerId: id })
    .where(and(eq(customers.id, holderId), c.stripe ? eq(customers.stripeCustomerId, c.stripe) : isNull(customers.stripeCustomerId)))
    .returning({ stripe: customers.stripeCustomerId });
  if (row?.stripe) return row.stripe;
  const [again] = await tx.select({ stripe: customers.stripeCustomerId }).from(customers).where(eq(customers.id, holderId));
  return again!.stripe!;
}

export interface CardSetup {
  mode: "stripe" | "simulator";
  publishableKey: string | null;
  customerId: string;
  ephemeralKeySecret: string | null;
  setupIntentId: string;
  setupIntentClientSecret: string;
  merchantDisplayName: string;
  merchantCountryCode: "US";
  applePayMerchantId: string | null;
  googlePayTestEnv: boolean;
  testCards: { id: string; label: string }[];
}

export const merchantDisplayName = () => process.env.STRIPE_MERCHANT_DISPLAY_NAME?.trim() || "Ray'z Barber Shop";

/** PaymentSheet settings for the app's config. */
export function appPaymentsConfig() {
  return {
    mode: paymentsMode(),
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
    merchantDisplayName: merchantDisplayName(),
    merchantCountryCode: "US" as const,
    applePayMerchantId: process.env.APPLE_PAY_MERCHANT_ID?.trim() || null,
    googlePayTestEnv: !(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_"),
    walletFee: flags.walletFee(),
  };
}

export function publicCard(c: SavedCard) {
  return {
    id: c.id,
    paymentMethodId: c.stripePaymentMethodId,
    brand: c.brand,
    last4: c.last4,
    funding: c.funding,
    expMonth: c.expMonth,
    expYear: c.expYear,
    wallet: c.wallet,
    isDefault: c.isDefault,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * What PaymentSheet needs to save a card (C6): the Customer, an ephemeral key for the app's Stripe
 * SDK version, and a SetupIntent. Without Stripe keys, simulator ids and the test cards to pick from.
 */
export async function startCardSetup(customerId: string, o: { stripeVersion?: string | null } = {}): Promise<CardSetup> {
  const holder = await cardHolder(customerId);
  await assertReviewCanPay(holder);
  const stripeCustomer = await ensureStripeCustomer(holder);
  const s = stripe();
  const { publishableKey, merchantDisplayName: name, merchantCountryCode, applePayMerchantId, googlePayTestEnv } = appPaymentsConfig();
  const base = { publishableKey, customerId: stripeCustomer, merchantDisplayName: name, merchantCountryCode, applePayMerchantId, googlePayTestEnv };
  if (!s) {
    const si = `sim_seti_${randomBytes(6).toString("hex")}`;
    return {
      ...base,
      mode: "simulator",
      ephemeralKeySecret: null,
      setupIntentId: si,
      setupIntentClientSecret: `${si}_secret_sim`,
      testCards: Object.entries(TEST_CARDS)
        .filter(([id]) => id !== "pm_card_threeDSecure2Required")
        .map(([id, c]) => ({ id, label: c.label })),
    };
  }
  if (!o.stripeVersion) throw new AppError("bad_request", "Send the Stripe API version your app's Stripe SDK uses (stripeVersion)", { field: "stripeVersion" });
  try {
    const [key, si] = await Promise.all([
      s.ephemeralKeys.create({ customer: stripeCustomer }, { apiVersion: o.stripeVersion }),
      s.setupIntents.create({ customer: stripeCustomer, usage: "off_session", automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { customerId: holder } }),
    ]);
    return { ...base, mode: "stripe", ephemeralKeySecret: key.secret ?? null, setupIntentId: si.id, setupIntentClientSecret: si.client_secret!, testCards: [] };
  } catch (e) {
    throw new AppError("payment_failed", `Stripe didn't start saving the card: ${(e as Stripe.errors.StripeError).message}`);
  }
}

async function upsertCard(holderId: string, pmId: string, card: CardDetails, tx: DBorTx = db): Promise<{ card: SavedCard; added: boolean }> {
  const [existing] = await tx
    .select()
    .from(customerCards)
    .where(and(eq(customerCards.customerId, holderId), eq(customerCards.stripePaymentMethodId, pmId)));
  if (existing && !existing.detachedAt) return { card: existing, added: false };
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(customerCards)
    .where(and(eq(customerCards.customerId, holderId), isNull(customerCards.detachedAt)));
  if (n >= MAX_SAVED_CARDS) throw new AppError("conflict", `You can save up to ${MAX_SAVED_CARDS} cards. Remove one first.`);
  const values = {
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    expMonth: card.expMonth ?? null,
    expYear: card.expYear ?? null,
    wallet: card.wallet ?? null,
    isDefault: n === 0,
    detachedAt: null,
  };
  const [row] = existing
    ? await tx.update(customerCards).set(values).where(eq(customerCards.id, existing.id)).returning()
    : await tx
        .insert(customerCards)
        .values({ customerId: holderId, stripePaymentMethodId: pmId, ...values })
        .returning();
  return { card: row, added: true };
}

/**
 * Records the card the app just saved: the SetupIntent it completed (Stripe), or a test card
 * (simulator). Checked against the holder's own Stripe Customer, so nobody saves someone else's card.
 * setup_intent.succeeded records the same card if the app never calls back.
 */
export async function saveCard(customerId: string, input: { setupIntentId?: string | null; paymentMethodId?: string | null }) {
  const holder = await cardHolder(customerId);
  await assertReviewCanPay(holder);
  const stripeCustomer = await ensureStripeCustomer(holder);
  const s = stripe();
  let pmId: string;
  let card: CardDetails;
  if (!s) {
    pmId = input.paymentMethodId ?? "";
    if (!TEST_CARDS[pmId] || pmId === "pm_card_chargeDeclined" || pmId === "pm_card_threeDSecure2Required")
      throw new AppError("bad_request", "Pick one of the test cards", { field: "paymentMethodId" });
    card = await inspectPaymentMethod(pmId);
  } else {
    try {
      if (input.setupIntentId) {
        const si = await s.setupIntents.retrieve(input.setupIntentId, { expand: ["payment_method"] });
        const owner = typeof si.customer === "string" ? si.customer : si.customer?.id;
        if (owner !== stripeCustomer) throw forbidden("That card isn't being saved to your account");
        if (si.status !== "succeeded") throw new AppError("conflict", "The card isn't saved yet. Finish adding it in the app.", { reason: si.status });
        const pm = si.payment_method as Stripe.PaymentMethod | null;
        if (!pm?.card) throw new AppError("bad_request", "Only cards can be saved");
        pmId = pm.id;
        card = await inspectPaymentMethod(pm.id);
      } else if (input.paymentMethodId) {
        const pm = await s.paymentMethods.retrieve(input.paymentMethodId);
        const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
        if (owner !== stripeCustomer) throw forbidden("That card isn't saved to your account");
        if (!pm.card) throw new AppError("bad_request", "Only cards can be saved");
        pmId = pm.id;
        card = await inspectPaymentMethod(pm.id);
      } else throw new AppError("bad_request", "Send the setupIntentId the app completed", { field: "setupIntentId" });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("payment_failed", (e as Stripe.errors.StripeError).message ?? "Couldn't read the card from Stripe");
    }
  }
  const r = await upsertCard(holder, pmId, card);
  if (r.added) await audit(customerActor(holder), "card.saved", "customer", holder, { brand: card.brand, last4: card.last4, funding: card.funding, wallet: card.wallet ?? null, via: "app" }, null);
  return r.card;
}

/** setup_intent.succeeded: the same as the app's call back, for when it never came. */
export async function recordSetupIntent(si: Stripe.SetupIntent) {
  const owner = typeof si.customer === "string" ? si.customer : si.customer?.id;
  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  if (!owner || !pmId) return { outcome: "no_card" };
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.stripeCustomerId, owner));
  if (!c) return { outcome: "unknown_customer" };
  const card = await inspectPaymentMethod(pmId).catch(() => null);
  if (!card) return { outcome: "not_a_card" };
  const r = await upsertCard(c.id, pmId, card);
  if (r.added) await audit(SYSTEM, "card.saved", "customer", c.id, { brand: card.brand, last4: card.last4, funding: card.funding, via: "webhook" }, null);
  return { outcome: r.added ? "saved" : "already_saved" };
}

export async function listCards(customerId: string): Promise<SavedCard[]> {
  const holder = await cardHolder(customerId);
  return db
    .select()
    .from(customerCards)
    .where(and(eq(customerCards.customerId, holder), isNull(customerCards.detachedAt)))
    .orderBy(desc(customerCards.isDefault), desc(customerCards.createdAt));
}

async function ownCard(holder: string, cardId: string, tx: DBorTx = db) {
  const [c] = await tx
    .select()
    .from(customerCards)
    .where(and(eq(customerCards.id, cardId), eq(customerCards.customerId, holder), isNull(customerCards.detachedAt)));
  if (!c) throw notFound("Card");
  return c;
}

export async function setDefaultCard(customerId: string, cardId: string) {
  const holder = await cardHolder(customerId);
  return db.transaction(async (tx) => {
    const c = await ownCard(holder, cardId, tx);
    await tx
      .update(customerCards)
      .set({ isDefault: false })
      .where(and(eq(customerCards.customerId, holder), eq(customerCards.isDefault, true)));
    const [row] = await tx.update(customerCards).set({ isDefault: true }).where(eq(customerCards.id, c.id)).returning();
    return row;
  });
}

/** Removes a card: detached from the Stripe Customer, so it can't be charged again. The newest other card becomes the default. */
export async function removeCard(customerId: string, cardId: string) {
  const holder = await cardHolder(customerId);
  const c = await ownCard(holder, cardId);
  const s = stripe();
  if (s && !TEST_CARDS[c.stripePaymentMethodId])
    await s.paymentMethods.detach(c.stripePaymentMethodId).catch((e: Stripe.errors.StripeError) => {
      // Already detached (in the dashboard, or by the client elsewhere) is what we wanted.
      if (e.code !== "resource_missing" && !/not attached/i.test(e.message)) throw new AppError("payment_failed", `Stripe didn't remove the card: ${e.message}`);
    });
  await markCardDetached(holder, c.stripePaymentMethodId);
  await audit(customerActor(holder), "card.removed", "customer", holder, { brand: c.brand, last4: c.last4 }, null);
}

async function markCardDetached(holder: string | null, pmId: string, tx: DBorTx = db) {
  const rows = await tx
    .update(customerCards)
    .set({ detachedAt: new Date(), isDefault: false })
    .where(and(eq(customerCards.stripePaymentMethodId, pmId), isNull(customerCards.detachedAt), ...(holder ? [eq(customerCards.customerId, holder)] : [])))
    .returning({ customerId: customerCards.customerId, wasDefault: sql<boolean>`true` });
  for (const h of new Set(rows.map((r) => r.customerId))) {
    const [hasDefault] = await tx
      .select({ id: customerCards.id })
      .from(customerCards)
      .where(and(eq(customerCards.customerId, h), eq(customerCards.isDefault, true), isNull(customerCards.detachedAt)));
    if (hasDefault) continue;
    const [next] = await tx
      .select({ id: customerCards.id })
      .from(customerCards)
      .where(and(eq(customerCards.customerId, h), isNull(customerCards.detachedAt)))
      .orderBy(desc(customerCards.createdAt))
      .limit(1);
    if (next) await tx.update(customerCards).set({ isDefault: true }).where(eq(customerCards.id, next.id));
  }
  return rows.length;
}

/** payment_method.detached: removed in Stripe (the dashboard, or expired and replaced). */
export async function recordDetached(pmId: string) {
  const n = await markCardDetached(null, pmId);
  return { outcome: n ? "detached" : "unknown_card" };
}

/** A saved card the holder may pay with, or why not. */
export async function cardForPayment(customerId: string, pmId: string) {
  const holder = await cardHolder(customerId);
  const [c] = await db
    .select()
    .from(customerCards)
    .where(and(eq(customerCards.customerId, holder), eq(customerCards.stripePaymentMethodId, pmId), isNull(customerCards.detachedAt)));
  if (!c) throw forbidden("That card isn't saved on your account");
  return { card: c, holder };
}

/**
 * Account deletion: the Stripe Customer goes, and every card on it with it. Past payments keep
 * their brand and last four on the ticket, as receipts need.
 */
export async function forgetStripeCustomer(holderId: string, tx: DBorTx = db) {
  const [c] = await tx.select({ stripe: customers.stripeCustomerId }).from(customers).where(eq(customers.id, holderId));
  const s = stripe();
  if (c?.stripe && s && !c.stripe.startsWith("sim_"))
    await s.customers.del(c.stripe).catch((e: Stripe.errors.StripeError) => {
      if (e.code !== "resource_missing") throw new AppError("payment_failed", `Stripe didn't delete the saved cards: ${e.message}`);
    });
  await tx
    .update(customerCards)
    .set({ detachedAt: new Date(), isDefault: false })
    .where(and(eq(customerCards.customerId, holderId), isNull(customerCards.detachedAt)));
  await tx.update(customers).set({ stripeCustomerId: null }).where(eq(customers.id, holderId));
  return !!c?.stripe;
}

/** C14: a client who came over from Squire has no cards here; Squire's can't be copied, so the app asks them to add one. */
export async function reAddCardPrompt(customerId: string) {
  const holder = await cardHolder(customerId);
  const [[imported], [card]] = await Promise.all([
    db.select({ id: customerSquireIds.squireId }).from(customerSquireIds).where(eq(customerSquireIds.customerId, holder)).limit(1),
    db.select({ id: customerCards.id }).from(customerCards).where(eq(customerCards.customerId, holder)).limit(1),
  ]);
  return !!imported && !card;
}
