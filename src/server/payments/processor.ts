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
export function stripe(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
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
  /** apple_pay, google_pay, ...: the card came through a wallet. Null or absent for a card itself. */
  wallet?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
}

/**
 * I10, not decided yet: who is the merchant of record when a charge settles to a shop's (or owner's)
 * connected account. "on_behalf_of" (the default, as before): the shop is, on the statement and for
 * the card network. "destination": the platform is, and the money is transferred to the shop. Both
 * charge on the platform, so saved cards on platform-level Customers work either way.
 */
export type ChargeModel = "on_behalf_of" | "destination";
export function chargeModel(): ChargeModel {
  return process.env.STRIPE_CHARGE_MODEL === "destination" ? "destination" : "on_behalf_of";
}

/** Stripe's surcharge field on the PaymentIntent (a Stripe preview): off until Stripe signs off on it. */
export const surchargeFieldOn = () => process.env.STRIPE_SURCHARGE_FIELD === "true";

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
  pm_card_threeDSecure2Required: { label: "Visa (asks for 3-D Secure)", funding: "credit", brand: "visa", last4: "3220" },
};

/**
 * The simulator's stand-ins for a ConfirmationToken from the app's PaymentSheet (FlowController):
 * ctoken_sim_<test card>, e.g. ctoken_sim_visa_debit, plus wallets.
 */
export const SIM_CONFIRMATION_TOKENS: Record<string, CardDetails & { label: string; paymentMethodId: string }> = {
  ...Object.fromEntries(Object.entries(TEST_CARDS).map(([pm, c]) => [`ctoken_sim_${pm.slice("pm_card_".length)}`, { ...c, paymentMethodId: pm, wallet: null }])),
  ctoken_sim_apple_pay: { label: "Apple Pay (Visa credit)", funding: "credit", brand: "visa", last4: "4242", wallet: "apple_pay", paymentMethodId: "pm_card_visa" },
  ctoken_sim_apple_pay_debit: { label: "Apple Pay (Visa debit)", funding: "debit", brand: "visa", last4: "5556", wallet: "apple_pay", paymentMethodId: "pm_card_visa_debit" },
  ctoken_sim_google_pay: { label: "Google Pay (Mastercard credit)", funding: "credit", brand: "mastercard", last4: "4444", wallet: "google_pay", paymentMethodId: "pm_card_mastercard" },
};

const isConfirmationToken = (id: string) => id.startsWith("ctoken_");
const simCard = (id: string) => TEST_CARDS[id] ?? SIM_CONFIRMATION_TOKENS[id] ?? null;
const simBase = (id: string) => SIM_CONFIRMATION_TOKENS[id]?.paymentMethodId ?? id;

function normalizeFunding(f: string | null | undefined): CardFunding {
  return f === "credit" || f === "debit" || f === "prepaid" ? f : "unknown";
}

type AnyCard = { funding?: string | null; brand?: string | null; last4?: string | null; exp_month?: number | null; exp_year?: number | null; wallet?: { type?: string | null } | null };
const detailsOf = (card: AnyCard): CardDetails => ({
  funding: normalizeFunding(card.funding),
  brand: card.brand ?? "card",
  last4: card.last4 ?? "",
  wallet: card.wallet?.type ?? null,
  expMonth: card.exp_month ?? null,
  expYear: card.exp_year ?? null,
});

/**
 * Inspect a tokenized card *before* charging so the credit-only fee can be disclosed: a
 * PaymentMethod (pm_...) or the app's ConfirmationToken (ctoken_..., read from its payment_method_preview).
 */
export async function inspectPaymentMethod(paymentMethodId: string): Promise<CardDetails> {
  const sim = simCard(paymentMethodId);
  if (sim) {
    const { funding, brand, last4, wallet } = sim;
    return { funding, brand, last4, ...(wallet ? { wallet } : {}) };
  }
  const s = stripe();
  if (!s) throw new AppError("bad_request", "Unknown test card (simulator mode)");
  try {
    if (isConfirmationToken(paymentMethodId)) {
      const ct = await s.confirmationTokens.retrieve(paymentMethodId);
      const card = ct.payment_method_preview?.card;
      if (!card) throw new AppError("bad_request", "Not a card payment method");
      return detailsOf(card);
    }
    const pm = await s.paymentMethods.retrieve(paymentMethodId);
    const card = pm.card ?? (pm as unknown as { card_present?: AnyCard }).card_present;
    if (!card) throw new AppError("bad_request", "Not a card payment method");
    return detailsOf(card);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("bad_request", (e as Stripe.errors.StripeError).message ?? "Couldn't read that card");
  }
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
interface SimIntent {
  id: string;
  status: "succeeded" | "requires_action" | "canceled";
  amountCents: number;
  amountRefundedCents: number;
  card: CardDetails;
  metadata: Record<string, string>;
  destination: Destination | null;
  customerId: string | null;
  statementDescriptorSuffix: string | null;
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

/** The bank wants the cardholder to confirm (3-D Secure). The app runs it with the client secret, then pays again with the intent's id. */
export interface RequiresAction {
  reason: "requires_action";
  paymentIntentId: string;
  clientSecret: string;
}
export const isRequiresAction = (e: unknown): e is AppError & { details: RequiresAction } =>
  e instanceof AppError && (e.details as { reason?: string } | undefined)?.reason === "requires_action";

function simResult(pi: SimIntent): ChargeResult {
  const suffix = pi.id.slice("sim_pi_".length);
  return {
    processor: "simulator",
    paymentIntentId: pi.id,
    card: pi.card,
    destination: pi.destination,
    chargeId: `sim_ch_${suffix}`,
    transferId: pi.destination ? `sim_tr_${suffix}` : null,
    processorFeeCents: pi.destination?.applicationFeeCents ?? null,
  };
}

function stripeResult(pi: Stripe.PaymentIntent, dest: Destination | null): ChargeResult {
  const charge = pi.latest_charge as Stripe.Charge | null;
  // An idempotent replay can hand back an intent that was since refunded; never book that as paid.
  if (charge && charge.amount_refunded > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
  const pmd = charge?.payment_method_details;
  const card = pmd?.card ?? pmd?.card_present;
  const bt = charge?.balance_transaction;
  return {
    processor: "stripe",
    paymentIntentId: pi.id,
    card: card ? detailsOf(card as AnyCard) : { funding: "unknown", brand: "card", last4: "" },
    destination: dest,
    chargeId: charge?.id ?? null,
    transferId: typeof charge?.transfer === "string" ? charge.transfer : (charge?.transfer?.id ?? null),
    processorFeeCents: bt && typeof bt !== "string" ? bt.fee : null,
  };
}

const actionNeeded = (paymentIntentId: string, clientSecret: string) =>
  new AppError("payment_failed", "Your bank wants you to confirm this payment.", { reason: "requires_action", paymentIntentId, clientSecret } satisfies RequiresAction);

/**
 * The one place a PaymentIntent is created. With a destination, it's a destination charge on the
 * platform settled to the shop's connected account: the shop gets the charge less the application
 * fee, and refunds come back out of its account. Whether the shop or the platform is the merchant
 * of record is chargeModel() (I10). `customerId` is a platform-level Stripe Customer, so a saved
 * card can pay at any shop.
 */
export async function chargeCard(opts: {
  /** A PaymentMethod, or a ConfirmationToken (ctoken_...) from the app. */
  paymentMethodId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  destination?: Destination | null;
  customerId?: string | null;
  /** Brand-account charges: the shop's part of the card statement, after the brand's prefix. */
  statementDescriptorSuffix?: string | null;
  /** The credit card surcharge in amountCents, sent as Stripe's surcharge amount when that's on. */
  surchargeCents?: number;
  /** "return": a 3-D Secure check comes back as RequiresAction for the app to run. Otherwise the intent is cancelled. */
  onAction?: "cancel" | "return";
  /** The app finished 3-D Secure on this intent: check it's this charge and that it succeeded, instead of creating one. */
  confirmedIntentId?: string | null;
}): Promise<ChargeResult> {
  const s = stripe();
  const dest = opts.destination ?? null;
  if (dest && (dest.applicationFeeCents < 0 || dest.applicationFeeCents > opts.amountCents)) throw new AppError("bad_request", "The processing fee can't be more than the charge");
  const sameCharge = (amount: number, metadata: Record<string, string>) => amount === opts.amountCents && (!opts.metadata.saleId || metadata.saleId === opts.metadata.saleId);
  if (!s) {
    if (opts.confirmedIntentId) {
      const pi = sim.intents.get(opts.confirmedIntentId);
      if (!pi || !sameCharge(pi.amountCents, pi.metadata)) throw new AppError("conflict", "That payment doesn't match this ticket any more", { reason: "intent_mismatch" });
      if (pi.status === "requires_action") throw actionNeeded(pi.id, `${pi.id}_secret_sim`);
      if (pi.status !== "succeeded") throw new AppError("payment_failed", "That payment didn't go through. Try again.");
      if (pi.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
      return simResult(pi);
    }
    const card = simCard(opts.paymentMethodId);
    if (!card) throw new AppError("payment_failed", "Unknown simulated card");
    await simLatency();
    const base = simBase(opts.paymentMethodId);
    if (base === "pm_card_chargeDeclined") throw new AppError("payment_failed", "Your card was declined.", { reason: "card_declined" });
    const existing = sim.byKey.get(opts.idempotencyKey);
    const pi: SimIntent = existing
      ? sim.intents.get(existing)!
      : {
          id: simId("sim_pi"),
          status: base === "pm_card_threeDSecure2Required" ? "requires_action" : "succeeded",
          amountCents: opts.amountCents,
          amountRefundedCents: 0,
          card: { funding: card.funding, brand: card.brand, last4: card.last4, ...(card.wallet ? { wallet: card.wallet } : {}) },
          metadata: opts.metadata,
          destination: dest,
          customerId: opts.customerId ?? null,
          statementDescriptorSuffix: dest ? null : (opts.statementDescriptorSuffix ?? null),
        };
    if (!existing) {
      sim.intents.set(pi.id, pi);
      sim.byKey.set(opts.idempotencyKey, pi.id);
    }
    if (pi.status === "requires_action") {
      if (opts.onAction === "return") throw actionNeeded(pi.id, `${pi.id}_secret_sim`);
      pi.status = "canceled";
      throw new AppError("payment_failed", "This card needs 3-D Secure authentication. Use the card reader or another card.");
    }
    if (pi.status !== "succeeded") throw new AppError("payment_failed", "That payment didn't go through. Try again.");
    if (pi.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was already refunded. Start the charge again.");
    return simResult(pi);
  }
  if (dest?.accountId.startsWith("sim_")) throw new AppError("payment_failed", "This shop's account is from the simulator. Set it up with Stripe before taking cards.", { reason: "payments_not_ready" });
  try {
    if (opts.confirmedIntentId) {
      const pi = await s.paymentIntents.retrieve(opts.confirmedIntentId, { expand: ["latest_charge.balance_transaction"] });
      if (!sameCharge(pi.amount, pi.metadata)) throw new AppError("conflict", "That payment doesn't match this ticket any more", { reason: "intent_mismatch" });
      if (pi.status === "requires_action" && pi.client_secret) throw actionNeeded(pi.id, pi.client_secret);
      if (pi.status !== "succeeded") throw new AppError("payment_failed", "That payment didn't go through. Try again.");
      return stripeResult(pi, dest);
    }
    const surcharge = surchargeFieldOn() && opts.surchargeCents ? { amount_details: { surcharge: { amount: opts.surchargeCents } } } : {};
    const params: Stripe.PaymentIntentCreateParams = {
      amount: opts.amountCents,
      currency: "usd",
      ...(isConfirmationToken(opts.paymentMethodId) ? { confirmation_token: opts.paymentMethodId } : { payment_method: opts.paymentMethodId }),
      ...(opts.customerId ? { customer: opts.customerId } : {}),
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      confirm: true,
      description: opts.description,
      metadata: opts.metadata,
      ...(dest
        ? { ...(chargeModel() === "on_behalf_of" ? { on_behalf_of: dest.accountId } : {}), transfer_data: { destination: dest.accountId }, application_fee_amount: dest.applicationFeeCents }
        : {}),
      ...(!dest && opts.statementDescriptorSuffix ? { statement_descriptor_suffix: opts.statementDescriptorSuffix } : {}),
      ...(surcharge as object),
      expand: ["latest_charge.balance_transaction"],
    };
    const pi = await s.paymentIntents.create(params, { idempotencyKey: opts.idempotencyKey });
    if (pi.status === "requires_action") {
      if (opts.onAction === "return" && pi.client_secret) throw actionNeeded(pi.id, pi.client_secret);
      await s.paymentIntents.cancel(pi.id).catch(() => {});
      throw new AppError("payment_failed", "This card needs 3-D Secure authentication. Use the card reader or another card.");
    }
    if (pi.status !== "succeeded") throw new AppError("payment_failed", `Payment ${pi.status}`);
    return stripeResult(pi, dest);
  } catch (e) {
    if (e instanceof AppError) throw e;
    const se = e as Stripe.errors.StripeError;
    throw new AppError("payment_failed", se.message ?? "Card payment failed", se.code ? { reason: se.code } : undefined);
  }
}

/** The simulator's stand-in for the cardholder answering 3-D Secure in the app. */
export function simulateNextAction(paymentIntentId: string, pass = true) {
  const pi = sim.intents.get(paymentIntentId);
  if (!pi) throw new Error("Unknown simulated PaymentIntent");
  pi.status = pass ? "succeeded" : "canceled";
  return { ...pi };
}

/** A simulated intent, for the webhook stand-in in tests. */
export function simulatedIntent(paymentIntentId: string) {
  const pi = sim.intents.get(paymentIntentId);
  return pi ? { ...pi } : null;
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
    const { funding, brand, last4 } = TEST_CARDS[testCard];
    return { paymentMethodId: testCard, card: { funding, brand, last4 } };
  },
};
