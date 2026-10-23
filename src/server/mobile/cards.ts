import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { customerPaymentMethods, customers } from "@/db/schema";
import { AppError, notFound } from "@/server/errors";
import { assertStripeTestMode, stripe, TEST_CARDS, type CardDetails } from "@/server/payments/processor";

const RAW_CARD_KEYS = ["number", "cvc", "cvv", "pan", "cardNumber", "exp", "expiry", "expMonth", "expYear"];

export function rejectRawCard(body: Record<string, unknown>) {
  for (const key of RAW_CARD_KEYS) {
    if (key in body) throw new AppError("bad_request", "Card numbers stay in Stripe. Use the hosted card form.");
  }
}

const TEST_BY_FUNDING: Record<string, string> = {
  credit: "pm_card_visa",
  debit: "pm_card_visa_debit",
  prepaid: "pm_card_mastercard_prepaid",
};

export interface SavedCard {
  id: string;
  customerId: string;
  brand: string;
  last4: string;
  funding: "credit" | "debit" | "prepaid" | "unknown";
  wallet: boolean;
  expMonth: number | null;
  expYear: number | null;
}

function present(row: typeof customerPaymentMethods.$inferSelect): SavedCard {
  const funding = row.funding === "credit" || row.funding === "debit" || row.funding === "prepaid" ? row.funding : "unknown";
  return {
    id: row.stripePaymentMethodId,
    customerId: row.customerId,
    brand: row.brand,
    last4: row.last4,
    funding,
    wallet: Boolean(row.wallet),
    expMonth: row.expMonth,
    expYear: row.expYear,
  };
}

/** Platform Stripe Customer. The name sent to Stripe is the first name only. */
export async function ensureStripeCustomer(customerId: string): Promise<string> {
  assertStripeTestMode();
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { id: true, firstName: true, stripeCustomerId: true, deletedAt: true },
  });
  if (!customer || customer.deletedAt) throw notFound("Customer");
  if (customer.stripeCustomerId) return customer.stripeCustomerId;
  const s = stripe();
  const stripeCustomerId = s
    ? (
        await s.customers.create({
          name: customer.firstName.trim().split(/\s+/)[0] || "Customer",
          metadata: { customerId: customer.id },
        })
      ).id
    : `cus_sim_${customer.id.replace(/-/g, "").slice(0, 16)}`;
  await db.update(customers).set({ stripeCustomerId }).where(eq(customers.id, customer.id));
  return stripeCustomerId;
}

async function rememberCard(customerId: string, paymentMethodId: string, card: CardDetails, wallet: boolean, exp?: { expMonth: number | null; expYear: number | null }) {
  const values = {
    customerId,
    stripePaymentMethodId: paymentMethodId,
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    expMonth: exp?.expMonth ?? 12,
    expYear: exp?.expYear ?? 2030,
    wallet: wallet ? "apple_pay" : null,
    detachedAt: null,
  };
  await db
    .insert(customerPaymentMethods)
    .values(values)
    .onConflictDoUpdate({
      target: customerPaymentMethods.stripePaymentMethodId,
      set: { customerId, brand: values.brand, last4: values.last4, funding: values.funding, wallet: values.wallet, detachedAt: null, expMonth: values.expMonth, expYear: values.expYear },
    });
}

/**
 * SetupIntent plus a PaymentSheet ephemeral key. Card numbers are refused.
 * With Stripe keys, the card is saved only after Stripe confirms the SetupIntent.
 * Without keys, a published test PaymentMethod stands in so the fee preview can run.
 */
export async function setupCard(customerId: string, input: { funding?: "credit" | "debit" | "prepaid"; wallet?: boolean; paymentMethodId?: string }) {
  assertStripeTestMode();
  const stripeCustomerId = await ensureStripeCustomer(customerId);
  const s = stripe();
  if (s) {
    const setup = await s.setupIntents.create({
      customer: stripeCustomerId,
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
    });
    const ephemeral = await s.ephemeralKeys.create({ customer: stripeCustomerId }, { apiVersion: Stripe.API_VERSION });
    return {
      paymentMethod: null,
      clientSecret: setup.client_secret,
      ephemeralKey: ephemeral.secret,
      customerId: stripeCustomerId,
    };
  }
  const paymentMethodId = input.paymentMethodId && TEST_CARDS[input.paymentMethodId] ? input.paymentMethodId : TEST_BY_FUNDING[input.funding ?? "credit"];
  const card = TEST_CARDS[paymentMethodId];
  if (!card) throw new AppError("bad_request", "Unknown test card.");
  await rememberCard(customerId, paymentMethodId, card, Boolean(card.wallet));
  const saved = await db.query.customerPaymentMethods.findFirst({ where: eq(customerPaymentMethods.stripePaymentMethodId, paymentMethodId) });
  const shown = saved ? present(saved) : null;
  return {
    paymentMethod: shown
      ? { id: shown.id, brand: shown.brand, last4: shown.last4, funding: shown.funding, wallet: shown.wallet, expMonth: shown.expMonth, expYear: shown.expYear }
      : null,
    clientSecret: `seti_test_${randomBytes(8).toString("hex")}`,
    ephemeralKey: `ek_test_${randomBytes(8).toString("hex")}`,
    customerId: stripeCustomerId,
  };
}

export async function listCards(customerId: string) {
  const s = stripe();
  if (s) {
    const stripeCustomerId = await ensureStripeCustomer(customerId);
    const listed = await s.paymentMethods.list({ customer: stripeCustomerId, type: "card" });
    for (const pm of listed.data) {
      const card = pm.card;
      if (!card) continue;
      const funding = card.funding === "credit" || card.funding === "debit" || card.funding === "prepaid" ? card.funding : "unknown";
      await rememberCard(customerId, pm.id, { funding, brand: card.brand, last4: card.last4 }, Boolean(card.wallet), {
        expMonth: card.exp_month,
        expYear: card.exp_year,
      });
    }
  }
  const rows = await db
    .select()
    .from(customerPaymentMethods)
    .where(and(eq(customerPaymentMethods.customerId, customerId), isNull(customerPaymentMethods.detachedAt)));
  return { paymentMethods: rows.map(present) };
}

export async function detachCard(customerId: string, paymentMethodId: string) {
  const row = await db.query.customerPaymentMethods.findFirst({
    where: and(eq(customerPaymentMethods.customerId, customerId), eq(customerPaymentMethods.stripePaymentMethodId, paymentMethodId), isNull(customerPaymentMethods.detachedAt)),
  });
  if (!row) throw notFound("Card");
  const s = stripe();
  if (s && !paymentMethodId.startsWith("pm_card_")) {
    await s.paymentMethods.detach(paymentMethodId).catch(() => undefined);
  }
  await db.update(customerPaymentMethods).set({ detachedAt: new Date() }).where(eq(customerPaymentMethods.id, row.id));
}
