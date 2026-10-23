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
/** Live charges are allowed only when the deployment says so. This branch stays in test mode. */
export function stripeLiveAllowed(): boolean {
  return process.env.STRIPE_MODE === "live";
}

/**
 * Live keys are refused unless STRIPE_MODE=live.
 * A demo does not throw: `stripe()` drops the live key and the simulator runs, so the key is never used.
 */
export function assertStripeTestMode() {
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  const live = secret.startsWith("sk_live_") || secret.startsWith("rk_live_") || publishable.startsWith("pk_live_");
  if (live && !stripeLiveAllowed() && !demoMode()) throw new AppError("forbidden", "Live Stripe keys are refused. Use a test-mode key.");
}

/** A secret we hand to an app. Test mode never issues a live-mode secret. */
export function assertIssuedStripeSecret(secret: string | null | undefined) {
  if (!secret || stripeLiveAllowed()) return;
  if (secret.startsWith("pi_live_") || secret.startsWith("ek_live_") || secret.startsWith("seti_live_") || secret.startsWith("pk_live_")) {
    throw new AppError("forbidden", "Live Stripe keys are refused. Use a test-mode key.");
  }
}

export function stripe(): Stripe | null {
  assertStripeTestMode();
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
  /** Stripe `card.wallet.type` (`apple_pay`, `google_pay`, …), or null when the card is not a wallet. */
  wallet?: string | null;
}

/**
 * Stripe's published test PaymentMethods. These drive the Terminal simulator and the no-keys simulator,
 * and also work against real Stripe test mode.
 */
export const TEST_CARDS: Record<string, CardDetails & { label: string }> = {
  pm_card_visa: { label: "Visa (credit)", funding: "credit", brand: "visa", last4: "4242", wallet: null },
  pm_card_visa_debit: { label: "Visa (debit)", funding: "debit", brand: "visa", last4: "5556", wallet: null },
  pm_card_mastercard: { label: "Mastercard (credit)", funding: "credit", brand: "mastercard", last4: "4444", wallet: null },
  pm_card_mastercard_debit: { label: "Mastercard (debit)", funding: "debit", brand: "mastercard", last4: "8210", wallet: null },
  pm_card_mastercard_prepaid: { label: "Mastercard (prepaid)", funding: "prepaid", brand: "mastercard", last4: "5100", wallet: null },
  pm_card_amex: { label: "Amex (credit)", funding: "credit", brand: "amex", last4: "8431", wallet: null },
  pm_card_chargeDeclined: { label: "Declined card", funding: "credit", brand: "visa", last4: "0002", wallet: null },
  /** Simulator stand-in for a Stripe PaymentMethod whose card.wallet.type is apple_pay. Not a client-supplied flag. */
  pm_card_applepay_visa: { label: "Apple Pay Visa (credit)", funding: "credit", brand: "visa", last4: "4242", wallet: "apple_pay" },
  pm_card_applepay_visa_debit: { label: "Apple Pay Visa (debit)", funding: "debit", brand: "visa", last4: "5556", wallet: "apple_pay" },
};

function normalizeFunding(f: string | null | undefined): CardFunding {
  return f === "credit" || f === "debit" || f === "prepaid" ? f : "unknown";
}

function cardDetailsOf(card: { funding?: string | null; brand?: string | null; last4?: string | null; wallet?: string | { type?: string | null } | null }): CardDetails {
  const wallet = !card.wallet ? null : typeof card.wallet === "string" ? card.wallet : (card.wallet.type ?? null);
  return { funding: normalizeFunding(card.funding), brand: card.brand ?? "card", last4: card.last4 ?? "", wallet };
}

/** Inspect a tokenized card *before* charging so the credit-only fee can be disclosed. Funding and wallet come from Stripe's PaymentMethod, never from the client. */
export async function inspectPaymentMethod(paymentMethodId: string): Promise<CardDetails> {
  if (TEST_CARDS[paymentMethodId]) return cardDetailsOf(TEST_CARDS[paymentMethodId]);
  const s = stripe();
  if (!s) throw new AppError("bad_request", "Unknown test card (simulator mode)");
  const pm = await s.paymentMethods.retrieve(paymentMethodId);
  const card = pm.card ?? (pm as unknown as { card_present?: Stripe.PaymentMethod.Card }).card_present;
  if (!card) throw new AppError("bad_request", "Not a card payment method");
  return cardDetailsOf(card);
}

export interface ChargeResult {
  processor: "stripe" | "simulator";
  paymentIntentId: string;
  card: CardDetails;
  /** The shop's connected account the charge settled to, and the platform's application fee. */
  destination: Destination | null;
  chargeId: string | null;
  transferId: string | null;
  /** What Stripe charged the platform for this charge, when the balance transaction says. */
  processorFeeCents: number | null;
  /**
   * True when this PaymentIntent used transfer_data (a destination charge).
   * The shop already received the whole ticket, tip included. Do not create another transfer.
   */
  destinationCharge: boolean;
  /** Present for an unconfirmed PaymentSheet intent. Null once the charge has finished. */
  clientSecret: string | null;
}

/** Where a card charge settles: a shop's connected account, with the processing fee kept by the platform. */
export interface Destination {
  accountId: string;
  applicationFeeCents: number;
}

/**
 * The simulator behaves like Stripe where it matters for correctness: a repeated idempotency key
 * returns the original PaymentIntent, refunds can't exceed the charge, and calls take a moment so
 * overlapping requests really overlap.
 */
export interface SurchargeLine {
  productName: string;
  productCode: string;
  unitCost: number;
  quantity: number;
}

interface SimIntent {
  id: string;
  amountCents: number;
  amountRefundedCents: number;
  card: CardDetails;
  metadata: Record<string, string>;
  destination: Destination | null;
  customerId: string | null;
  paymentMethodId: string;
  status: "requires_confirmation" | "succeeded" | "canceled";
  /** Simulator secrets are pi_test_ with no `_secret_`, so the app treats them as sandbox. */
  clientSecret: string;
  /** Credit-card surcharge sent to Stripe as its own amount. Zero when the card is not credit. */
  surchargeCents: number;
  lineItems: SurchargeLine[];
}
interface SimState {
  intents: Map<string, SimIntent>;
  byKey: Map<string, string>;
  refunds: { id: string; paymentIntentId: string; amountCents: number; reverseTransfer: boolean }[];
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

/**
 * Visa wants the credit surcharge as its own amount, separate from the sale.
 * The SDK types don't include `amount_details.surcharge` yet, so the field is added beside the line items.
 * A known debit, prepaid, or unknown test card never gets one, even if the caller passed cents.
 */
export function surchargeDisclosure(paymentMethodId: string, amountCents: number, surchargeCents: number | undefined, label: string | undefined): { surchargeCents: number; lineItems: SurchargeLine[] } | null {
  const cents = surchargeCents ?? 0;
  if (!Number.isInteger(cents) || cents <= 0) return null;
  if (cents > amountCents) throw new AppError("bad_request", "Surcharge is larger than the charge");
  const known = TEST_CARDS[paymentMethodId];
  if (known && known.funding !== "credit") return null;
  const saleCents = amountCents - cents;
  const name = label?.trim() || "Credit card surcharge";
  return {
    surchargeCents: cents,
    lineItems: [
      ...(saleCents > 0 ? [{ productName: "Services", productCode: "services", unitCost: saleCents, quantity: 1 }] : []),
      { productName: name, productCode: "surcharge", unitCost: cents, quantity: 1 },
    ],
  };
}

function stripeAmountDetails(disclosure: { surchargeCents: number; lineItems: SurchargeLine[] }): Stripe.PaymentIntentCreateParams["amount_details"] {
  const details: Stripe.PaymentIntentCreateParams.AmountDetails & { surcharge?: { amount: number } } = {
    line_items: disclosure.lineItems.map((line) => ({
      product_name: line.productName,
      product_code: line.productCode,
      unit_cost: line.unitCost,
      quantity: line.quantity,
    })),
    surcharge: { amount: disclosure.surchargeCents },
  };
  return details;
}

/**
 * The one place a PaymentIntent is created. With a destination, it's a destination charge on the
 * platform settled on behalf of the shop's connected account: the shop is the merchant on the
 * statement, gets the charge less the application fee, and refunds come back out of its account.
 * `customerId` is a platform-level Stripe Customer, so a saved card can pay at any shop.
 * `surchargeCents` is the credit-card surcharge, sent as its own Stripe line. Debit is never surcharged.
 */
export async function chargeCard(opts: {
  paymentMethodId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  destination?: Destination | null;
  customerId?: string | null;
  surchargeCents?: number;
  surchargeLabel?: string;
  /** False leaves the intent for PaymentSheet to confirm. Staff checkout confirms immediately. */
  confirm?: boolean;
}): Promise<ChargeResult> {
  assertStripeTestMode();
  const s = stripe();
  const dest = opts.destination ?? null;
  const disclosure = surchargeDisclosure(opts.paymentMethodId, opts.amountCents, opts.surchargeCents, opts.surchargeLabel);
  if (dest && (dest.applicationFeeCents < 0 || dest.applicationFeeCents > opts.amountCents)) throw new AppError("bad_request", "The processing fee can't be more than the charge");
  if (!s) {
    const card = TEST_CARDS[opts.paymentMethodId];
    if (!card) throw new AppError("payment_failed", "Unknown simulated card");
    await simLatency();
    if (opts.paymentMethodId === "pm_card_chargeDeclined") throw new AppError("payment_failed", "Your card was declined.");
    const existing = sim.byKey.get(opts.idempotencyKey);
    const createdId = simId("sim_pi");
    const pi: SimIntent = existing
      ? sim.intents.get(existing)!
      : {
          id: createdId,
          amountCents: opts.amountCents,
          amountRefundedCents: 0,
          card: cardDetailsOf(card),
          metadata: opts.metadata,
          destination: dest,
          customerId: opts.customerId ?? null,
          paymentMethodId: opts.paymentMethodId,
          status: opts.confirm === false ? "requires_confirmation" : "succeeded",
          clientSecret: `pi_test_${createdId.slice("sim_pi_".length)}`,
          surchargeCents: disclosure?.surchargeCents ?? 0,
          lineItems: disclosure?.lineItems ?? [],
        };
    if (!existing) {
      sim.intents.set(pi.id, pi);
      sim.byKey.set(opts.idempotencyKey, pi.id);
    }
    if (pi.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
    if (opts.confirm !== false && pi.status === "requires_confirmation") pi.status = "succeeded";
    const suffix = pi.id.slice("sim_pi_".length);
    const clientSecret = pi.status === "succeeded" ? null : pi.clientSecret;
    assertIssuedStripeSecret(pi.clientSecret);
    return {
      processor: "simulator",
      paymentIntentId: pi.id,
      card: pi.card,
      destination: pi.destination,
      chargeId: pi.status === "succeeded" ? `sim_ch_${suffix}` : null,
      transferId: pi.status === "succeeded" && pi.destination ? `sim_tr_${suffix}` : null,
      processorFeeCents: pi.destination?.applicationFeeCents ?? null,
      destinationCharge: !!pi.destination,
      clientSecret,
    };
  }
  if (dest?.accountId.startsWith("sim_")) throw new AppError("payment_failed", "This shop's account is from the simulator. Set it up with Stripe before taking cards.", { reason: "payments_not_ready" });
  try {
    const pi = await s.paymentIntents.create(
      {
        amount: opts.amountCents,
        currency: "usd",
        payment_method: opts.paymentMethodId,
        ...(opts.customerId ? { customer: opts.customerId } : {}),
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        confirm: opts.confirm !== false,
        description: opts.description,
        metadata: opts.metadata,
        ...(disclosure ? { amount_details: stripeAmountDetails(disclosure) } : {}),
        ...(dest ? { on_behalf_of: dest.accountId, transfer_data: { destination: dest.accountId }, application_fee_amount: dest.applicationFeeCents } : {}),
        expand: ["latest_charge.balance_transaction"],
      },
      { idempotencyKey: opts.idempotencyKey },
    );
    assertIssuedStripeSecret(pi.client_secret);
    if (opts.confirm === false) {
      if (!pi.client_secret) throw new AppError("payment_failed", "Stripe did not return a client secret.");
      const card = await inspectPaymentMethod(opts.paymentMethodId);
      return {
        processor: "stripe",
        paymentIntentId: pi.id,
        card,
        destination: dest,
        chargeId: null,
        transferId: null,
        processorFeeCents: null,
        destinationCharge: !!dest,
        clientSecret: pi.client_secret,
      };
    }
    if (pi.status === "requires_action") {
      await s.paymentIntents.cancel(pi.id).catch(() => {});
      throw new AppError("payment_failed", "This card needs 3-D Secure authentication. Use the card reader or another card.");
    }
    if (pi.status !== "succeeded") throw new AppError("payment_failed", `Payment ${pi.status}`);
    const charge = pi.latest_charge as Stripe.Charge | null;
    // An idempotent replay can hand back an intent that was since refunded; never book that as paid.
    if (charge && charge.amount_refunded > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
    const pmd = charge?.payment_method_details;
    const card = pmd?.card ?? pmd?.card_present;
    const bt = charge?.balance_transaction;
    const transferId = typeof charge?.transfer === "string" ? charge.transfer : (charge?.transfer?.id ?? null);
    const transferDataDestination = pi.transfer_data?.destination;
    const transferDataAccount = typeof transferDataDestination === "string" ? transferDataDestination : (transferDataDestination?.id ?? null);
    return {
      processor: "stripe",
      paymentIntentId: pi.id,
      card: { funding: normalizeFunding(card?.funding), brand: card?.brand ?? "card", last4: card?.last4 ?? "" },
      destination: dest,
      chargeId: charge?.id ?? null,
      transferId,
      processorFeeCents: bt && typeof bt !== "string" ? bt.fee : null,
      destinationCharge: !!transferDataAccount || !!transferId || !!dest,
      clientSecret: null,
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const se = e as Stripe.errors.StripeError;
    throw new AppError("payment_failed", se.message ?? "Card payment failed");
  }
}

export interface RetrievedIntent {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string | null;
  card: CardDetails;
  destination: Destination | null;
  chargeId: string | null;
  transferId: string | null;
  customerId: string | null;
  metadata: Record<string, string>;
  destinationCharge: boolean;
  amountRefundedCents: number;
  processor: "stripe" | "simulator";
  clientSecret: string | null;
}

/**
 * Read a PaymentIntent the customer already confirmed (PaymentSheet). Does not create a charge.
 * Simulator intents are the ones `chargeCard` stored. Live mode retrieves from Stripe test mode.
 */
export async function retrievePaymentIntent(paymentIntentId: string): Promise<RetrievedIntent> {
  assertStripeTestMode();
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) {
    const pi = sim.intents.get(paymentIntentId);
    if (!pi) throw new AppError("payment_failed", "Unknown payment.");
    const suffix = pi.id.slice("sim_pi_".length);
    const settled = (pi.status ?? "succeeded") === "succeeded";
    return {
      id: pi.id,
      status: pi.status ?? "succeeded",
      amountCents: pi.amountCents,
      currency: "usd",
      paymentMethodId: pi.paymentMethodId,
      card: pi.card,
      destination: pi.destination,
      chargeId: settled ? `sim_ch_${suffix}` : null,
      transferId: settled && pi.destination ? `sim_tr_${suffix}` : null,
      customerId: pi.customerId,
      metadata: pi.metadata,
      destinationCharge: !!pi.destination,
      amountRefundedCents: pi.amountRefundedCents,
      processor: "simulator",
      clientSecret: pi.clientSecret,
    };
  }
  const pi = await s.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method", "latest_charge"] });
  const pm = typeof pi.payment_method === "string" ? null : pi.payment_method;
  const paymentMethodId = typeof pi.payment_method === "string" ? pi.payment_method : (pm?.id ?? null);
  const card = pm?.card ? cardDetailsOf(pm.card) : paymentMethodId ? await inspectPaymentMethod(paymentMethodId) : { funding: "unknown" as const, brand: "card", last4: "", wallet: null };
  const charge = typeof pi.latest_charge === "string" || !pi.latest_charge ? null : pi.latest_charge;
  const transferId = !charge || typeof charge.transfer === "string" ? (typeof charge?.transfer === "string" ? charge.transfer : null) : (charge.transfer?.id ?? null);
  const destAccount = !pi.transfer_data?.destination ? null : typeof pi.transfer_data.destination === "string" ? pi.transfer_data.destination : pi.transfer_data.destination.id;
  const customerId = !pi.customer ? null : typeof pi.customer === "string" ? pi.customer : pi.customer.id;
  return {
    id: pi.id,
    status: pi.status,
    amountCents: pi.amount,
    currency: pi.currency,
    paymentMethodId,
    card,
    destination: destAccount ? { accountId: destAccount, applicationFeeCents: pi.application_fee_amount ?? 0 } : null,
    chargeId: charge?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : null),
    transferId,
    customerId,
    metadata: pi.metadata ?? {},
    destinationCharge: !!destAccount || !!transferId,
    amountRefundedCents: charge?.amount_refunded ?? 0,
    processor: "stripe",
    clientSecret: pi.status === "succeeded" ? null : (pi.client_secret ?? null),
  };
}

function simIntent(paymentIntentId: string): SimIntent {
  const pi = sim.intents.get(paymentIntentId);
  if (!pi) throw new AppError("payment_failed", "Unknown payment.");
  return pi;
}

/** Change the amount and card on an unconfirmed PaymentIntent. Does not create a new one. */
export async function updatePaymentIntent(paymentIntentId: string, opts: { amountCents: number; paymentMethodId: string; metadata: Record<string, string>; surchargeCents?: number; surchargeLabel?: string }): Promise<RetrievedIntent> {
  assertStripeTestMode();
  const disclosure = surchargeDisclosure(opts.paymentMethodId, opts.amountCents, opts.surchargeCents, opts.surchargeLabel);
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) {
    const pi = simIntent(paymentIntentId);
    if (pi.status !== "requires_confirmation") throw new AppError("conflict", "That payment can no longer be changed.");
    const card = TEST_CARDS[opts.paymentMethodId];
    if (!card) throw new AppError("payment_failed", "Unknown simulated card");
    pi.amountCents = opts.amountCents;
    pi.paymentMethodId = opts.paymentMethodId;
    pi.card = cardDetailsOf(card);
    pi.metadata = opts.metadata;
    pi.surchargeCents = disclosure?.surchargeCents ?? 0;
    pi.lineItems = disclosure?.lineItems ?? [];
    return retrievePaymentIntent(paymentIntentId);
  }
  await s.paymentIntents.update(paymentIntentId, {
    amount: opts.amountCents,
    payment_method: opts.paymentMethodId,
    metadata: opts.metadata,
    ...(disclosure ? { amount_details: stripeAmountDetails(disclosure) } : {}),
  });
  return retrievePaymentIntent(paymentIntentId);
}

/** Drop an unused PaymentIntent so a new price can replace it. */
export async function cancelPaymentIntent(paymentIntentId: string): Promise<void> {
  assertStripeTestMode();
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) {
    const pi = sim.intents.get(paymentIntentId);
    if (!pi || pi.status === "canceled") return;
    if (pi.status === "succeeded") throw new AppError("conflict", "That payment already went through.");
    pi.status = "canceled";
    return;
  }
  await s.paymentIntents.cancel(paymentIntentId).catch((err: Stripe.errors.StripeError) => {
    if (err.code === "payment_intent_unexpected_state") return;
    throw new AppError("payment_failed", err.message ?? "Could not cancel the payment.");
  });
}

/** What PaymentSheet does on device. Tests call this to mark a sandbox intent confirmed. */
export async function confirmPaymentIntent(paymentIntentId: string): Promise<RetrievedIntent> {
  assertStripeTestMode();
  const s = stripe();
  if (!s || paymentIntentId.startsWith("sim_")) {
    const pi = simIntent(paymentIntentId);
    if (pi.status === "canceled") throw new AppError("payment_failed", "That payment was canceled.");
    if (pi.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was already refunded.");
    if (pi.paymentMethodId === "pm_card_chargeDeclined") throw new AppError("payment_failed", "Your card was declined.");
    pi.status = "succeeded";
    return retrievePaymentIntent(paymentIntentId);
  }
  const current = await retrievePaymentIntent(paymentIntentId);
  if (current.status === "succeeded") return current;
  await s.paymentIntents.confirm(paymentIntentId, current.paymentMethodId ? { payment_method: current.paymentMethodId } : {});
  return retrievePaymentIntent(paymentIntentId);
}

/** Test helper. Moves a simulated intent after it was created. Refused when a Stripe client is configured. */
export function adjustSimulatedIntent(paymentIntentId: string, patch: { amountCents?: number; paymentMethodId?: string }) {
  if (process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") || process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    throw new Error("adjustSimulatedIntent is for the simulator");
  }
  const pi = simIntent(paymentIntentId);
  if (patch.amountCents != null) pi.amountCents = patch.amountCents;
  if (patch.paymentMethodId) {
    const card = TEST_CARDS[patch.paymentMethodId];
    if (!card) throw new Error("Unknown simulated card");
    pi.paymentMethodId = patch.paymentMethodId;
    pi.card = cardDetailsOf(card);
  }
}

/**
 * `reverseTransfer`: the charge went to a shop's connected account, so the refund is pulled back
 * from that account. The application fee isn't returned, the same as Stripe's fee on a refund.
 */
export async function refundCard(paymentIntentId: string, amountCents: number, idempotencyKey: string, opts: { reverseTransfer?: boolean } = {}): Promise<string> {
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
    sim.refunds.push({ id, paymentIntentId, amountCents, reverseTransfer: !!opts.reverseTransfer });
    sim.refundKeys.set(idempotencyKey, id);
    return id;
  }
  try {
    const r = await s.refunds.create(
      { payment_intent: paymentIntentId, amount: amountCents, ...(opts.reverseTransfer ? { reverse_transfer: true, refund_application_fee: false } : {}) },
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
  sim.refunds.push({ id: simId("sim_re"), paymentIntentId, amountCents, reverseTransfer: !!pi.destination });
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
    return { paymentMethodId: testCard, card: cardDetailsOf(TEST_CARDS[testCard]) };
  },
};
