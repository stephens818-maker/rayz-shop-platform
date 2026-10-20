import Stripe from "stripe";
import type { CardFunding } from "@/domain/checkout";
import { AppError } from "@/server/errors";

/**
 * Card processing. With STRIPE_SECRET_KEY set, everything goes to Stripe (test mode).
 * Without keys, a local simulator with the same interface is used so the POS still works end to end.
 * Card numbers never touch our server: Elements tokenizes in the browser, and Terminal reads cards on the device.
 */

let stripeClient: Stripe | null | undefined;
export function stripe(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  stripeClient = key ? new Stripe(key) : null;
  return stripeClient;
}

export function paymentsMode(): "stripe" | "simulator" {
  return stripe() ? "stripe" : "simulator";
}

export interface CardDetails {
  funding: CardFunding;
  brand: string;
  last4: string;
}

/**
 * Stripe's published test PaymentMethods. These drive the Terminal simulator and the no-keys simulator,
 * and also work against real Stripe test mode.
 */
export const TEST_CARDS: Record<string, CardDetails & { label: string }> = {
  pm_card_visa: { label: "Visa (credit)", funding: "credit", brand: "visa", last4: "4242" },
  pm_card_visa_debit: { label: "Visa (debit)", funding: "debit", brand: "visa", last4: "5556" },
  pm_card_mastercard: { label: "Mastercard (credit)", funding: "credit", brand: "mastercard", last4: "4444" },
  pm_card_mastercard_debit: { label: "Mastercard (debit)", funding: "debit", brand: "mastercard", last4: "8210" },
  pm_card_mastercard_prepaid: { label: "Mastercard (prepaid)", funding: "prepaid", brand: "mastercard", last4: "5100" },
  pm_card_amex: { label: "Amex (credit)", funding: "credit", brand: "amex", last4: "8431" },
  pm_card_chargeDeclined: { label: "Declined card", funding: "credit", brand: "visa", last4: "0002" },
};

function normalizeFunding(f: string | null | undefined): CardFunding {
  return f === "credit" || f === "debit" || f === "prepaid" ? f : "unknown";
}

/** Inspect a tokenized card *before* charging so the credit-only fee can be disclosed. */
export async function inspectPaymentMethod(paymentMethodId: string): Promise<CardDetails> {
  if (TEST_CARDS[paymentMethodId]) {
    const { funding, brand, last4 } = TEST_CARDS[paymentMethodId];
    return { funding, brand, last4 };
  }
  const s = stripe();
  if (!s) throw new AppError("bad_request", "Unknown test card (simulator mode)");
  const pm = await s.paymentMethods.retrieve(paymentMethodId);
  const card = pm.card ?? (pm as unknown as { card_present?: Stripe.PaymentMethod.Card }).card_present;
  if (!card) throw new AppError("bad_request", "Not a card payment method");
  return { funding: normalizeFunding(card.funding), brand: card.brand ?? "card", last4: card.last4 ?? "" };
}

export interface ChargeResult {
  processor: "stripe" | "simulator";
  paymentIntentId: string;
  card: CardDetails;
}

export async function chargeCard(opts: {
  paymentMethodId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<ChargeResult> {
  const s = stripe();
  if (!s) {
    const card = TEST_CARDS[opts.paymentMethodId];
    if (!card) throw new AppError("payment_failed", "Unknown simulated card");
    if (opts.paymentMethodId === "pm_card_chargeDeclined") throw new AppError("payment_failed", "Your card was declined.");
    return {
      processor: "simulator",
      paymentIntentId: `sim_pi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      card: { funding: card.funding, brand: card.brand, last4: card.last4 },
    };
  }
  try {
    const pi = await s.paymentIntents.create(
      {
        amount: opts.amountCents,
        currency: "usd",
        payment_method: opts.paymentMethodId,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        confirm: true,
        description: opts.description,
        metadata: opts.metadata,
        expand: ["latest_charge"],
      },
      { idempotencyKey: opts.idempotencyKey },
    );
    if (pi.status === "requires_action") {
      await s.paymentIntents.cancel(pi.id).catch(() => {});
      throw new AppError("payment_failed", "This card needs 3-D Secure authentication. Use the card reader or another card.");
    }
    if (pi.status !== "succeeded") throw new AppError("payment_failed", `Payment ${pi.status}`);
    const charge = pi.latest_charge as Stripe.Charge | null;
    const pmd = charge?.payment_method_details;
    const card = pmd?.card ?? pmd?.card_present;
    return {
      processor: "stripe",
      paymentIntentId: pi.id,
      card: { funding: normalizeFunding(card?.funding), brand: card?.brand ?? "card", last4: card?.last4 ?? "" },
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const se = e as Stripe.errors.StripeError;
    throw new AppError("payment_failed", se.message ?? "Card payment failed");
  }
}

export async function refundCard(paymentIntentId: string, amountCents: number, idempotencyKey: string): Promise<string> {
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) return `sim_re_${Date.now().toString(36)}`;
  const r = await s.refunds.create({ payment_intent: paymentIntentId, amount: amountCents }, { idempotencyKey });
  return r.id;
}

/**
 * Stripe Terminal, simulated. Mirrors the real flow so swapping in the Terminal SDK is mechanical:
 *   1. collectPaymentMethod()  → reader returns a card_present PaymentMethod
 *   2. inspect card_present.funding → add credit-only fee, update the PaymentIntent amount
 *   3. processPayment()        → confirm
 * Here, "presenting" a card picks one of Stripe's test PaymentMethods.
 */
export const terminal = {
  readerLabel: "Simulated WisePOS E (Stripe Terminal)",
  async collectPaymentMethod(testCard: string): Promise<{ paymentMethodId: string; card: CardDetails }> {
    if (!TEST_CARDS[testCard]) throw new AppError("bad_request", "Unknown test card");
    const { funding, brand, last4 } = TEST_CARDS[testCard];
    return { paymentMethodId: testCard, card: { funding, brand, last4 } };
  },
};
