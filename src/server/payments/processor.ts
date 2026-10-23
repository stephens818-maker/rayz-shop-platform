import Stripe from "stripe";
import type { CardFunding } from "@/domain/checkout";
import { demoMode } from "@/lib/deployment";
import { AppError } from "@/server/errors";

/**
 * Card processing. With STRIPE_SECRET_KEY set, everything goes to Stripe (test mode).
 * Without keys, a local simulator with the same interface is used so the POS still works end to end.
 * Card numbers never touch our server: Elements tokenizes in the browser, and Terminal reads cards on the device.
 */

let stripeClient: Stripe | null | undefined;
/** Live keys are never used. A demo also ignores anything that is not an sk_test_ key. */
export function assertStripeTestMode() {
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  if (secret.startsWith("sk_live_") || secret.startsWith("rk_live_") || publishable.startsWith("pk_live_")) {
    throw new AppError("forbidden", "Live Stripe keys are refused. Use a test-mode key.");
  }
}

export function stripe(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (key && (key.startsWith("sk_live_") || key.startsWith("rk_live_"))) {
    stripeClient = null;
    return stripeClient;
  }
  // A demo never charges a real card, whatever key it was given.
  const usable = key && (!demoMode() || key.startsWith("sk_test_"));
  stripeClient = usable ? new Stripe(key) : null;
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

export interface ChargeRouting {
  /** Connected account the charge is on behalf of. This is not a transfer by itself. */
  onBehalfOf?: string;
  /** Set only by the destination ChargePlan. Separate charges leave this empty. */
  destinationAccount?: string;
  transferGroup?: string;
}

export interface ChargeResult {
  processor: "stripe" | "simulator";
  paymentIntentId: string;
  chargeId: string | null;
  card: CardDetails;
  routing?: ChargeRouting;
}

/**
 * The simulator behaves like Stripe where it matters for correctness: a repeated idempotency key
 * returns the original PaymentIntent, refunds can't exceed the charge, and calls take a moment so
 * overlapping requests really overlap.
 */
interface SimIntent {
  id: string;
  chargeId: string;
  amountCents: number;
  amountRefundedCents: number;
  card: CardDetails;
  metadata: Record<string, string>;
  routing?: ChargeRouting;
}
interface SimState {
  intents: Map<string, SimIntent>;
  byKey: Map<string, string>;
  refunds: { id: string; paymentIntentId: string; amountCents: number }[];
  refundKeys: Map<string, string>;
}
const simGlobal = globalThis as unknown as { __rayzSim?: SimState };
const sim: SimState = (simGlobal.__rayzSim ??= { intents: new Map(), byKey: new Map(), refunds: [], refundKeys: new Map() });
const simLatency = () => new Promise((r) => setTimeout(r, Number(process.env.SIMULATOR_LATENCY_MS ?? 40)));
const simId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Read-only view of simulated charges and refunds, for tests and the payments health page. */
export function simulatorLedger() {
  return { intents: [...sim.intents.values()].map((i) => ({ ...i })), refunds: [...sim.refunds] };
}

export async function chargeCard(opts: {
  paymentMethodId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  /**
   * Connect routing from executeChargePlan. POS checkout omits this and stays a platform charge.
   * A destination account is applied only when the selected plan is `destination`.
   */
  routing?: ChargeRouting;
}): Promise<ChargeResult> {
  assertStripeTestMode();
  const metadata = { ...opts.metadata };
  const routing = opts.routing;
  if (routing?.onBehalfOf) metadata.onBehalfOf = routing.onBehalfOf;
  if (routing?.destinationAccount) metadata.destinationAccount = routing.destinationAccount;
  const connect = {
    ...(routing?.onBehalfOf ? { on_behalf_of: routing.onBehalfOf } : {}),
    ...(routing?.destinationAccount ? { transfer_data: { destination: routing.destinationAccount } } : {}),
    ...(routing?.transferGroup ? { transfer_group: routing.transferGroup } : {}),
  };
  const s = stripe();
  if (!s) {
    const card = TEST_CARDS[opts.paymentMethodId];
    if (!card) throw new AppError("payment_failed", "Unknown simulated card");
    await simLatency();
    if (opts.paymentMethodId === "pm_card_chargeDeclined") throw new AppError("payment_failed", "Your card was declined.");
    const existing = sim.byKey.get(opts.idempotencyKey);
    const pi = existing
      ? sim.intents.get(existing)!
      : { id: simId("sim_pi"), chargeId: simId("sim_ch"), amountCents: opts.amountCents, amountRefundedCents: 0, card: { funding: card.funding, brand: card.brand, last4: card.last4 }, metadata, routing };
    if (!existing) {
      sim.intents.set(pi.id, pi);
      sim.byKey.set(opts.idempotencyKey, pi.id);
    }
    if (pi.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
    return { processor: "simulator", paymentIntentId: pi.id, chargeId: pi.chargeId, card: pi.card, routing: pi.routing };
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
        metadata,
        expand: ["latest_charge"],
        ...connect,
      },
      { idempotencyKey: opts.idempotencyKey },
    );
    if (pi.status === "requires_action") {
      await s.paymentIntents.cancel(pi.id).catch(() => {});
      throw new AppError("payment_failed", "This card needs 3-D Secure authentication. Use the card reader or another card.");
    }
    if (pi.status !== "succeeded") throw new AppError("payment_failed", `Payment ${pi.status}`);
    const charge = pi.latest_charge as Stripe.Charge | string | null;
    const chargeObj = charge && typeof charge !== "string" ? charge : null;
    // An idempotent replay can hand back an intent that was since refunded; never book that as paid.
    if (chargeObj && chargeObj.amount_refunded > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
    const pmd = chargeObj?.payment_method_details;
    const card = pmd?.card ?? pmd?.card_present;
    return {
      processor: "stripe",
      paymentIntentId: pi.id,
      chargeId: typeof charge === "string" ? charge : chargeObj?.id ?? null,
      card: { funding: normalizeFunding(card?.funding), brand: card?.brand ?? "card", last4: card?.last4 ?? "" },
      routing,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const se = e as Stripe.errors.StripeError;
    throw new AppError("payment_failed", se.message ?? "Card payment failed");
  }
}

export async function refundCard(paymentIntentId: string, amountCents: number, idempotencyKey: string, opts?: { reverseTransfer?: boolean }): Promise<string> {
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) {
    await simLatency();
    const prior = sim.refundKeys.get(idempotencyKey);
    if (prior) return prior;
    const pi = sim.intents.get(paymentIntentId);
    // Intents from an earlier process (e.g. seeded history) aren't in memory; accept those as-is.
    if (pi) {
      if (pi.amountRefundedCents + amountCents > pi.amountCents) throw new AppError("payment_failed", "Refund is more than the remaining charge");
      pi.amountRefundedCents += amountCents;
    }
    const id = simId("sim_re");
    sim.refunds.push({ id, paymentIntentId, amountCents });
    sim.refundKeys.set(idempotencyKey, id);
    return id;
  }
  try {
    const r = await s.refunds.create(
      { payment_intent: paymentIntentId, amount: amountCents, ...(opts?.reverseTransfer ? { reverse_transfer: true } : {}) },
      { idempotencyKey },
    );
    return r.id;
  } catch (e) {
    throw new AppError("payment_failed", (e as Stripe.errors.StripeError).message ?? "Card refund failed");
  }
}

/** Simulates a refund made outside the POS (the Stripe dashboard) and returns the new refunded total. */
export function simulateDashboardRefund(paymentIntentId: string, amountCents: number) {
  const pi = sim.intents.get(paymentIntentId);
  if (!pi) throw new Error("Unknown simulated PaymentIntent");
  pi.amountRefundedCents += amountCents;
  sim.refunds.push({ id: simId("sim_re"), paymentIntentId, amountCents });
  return pi.amountRefundedCents;
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
