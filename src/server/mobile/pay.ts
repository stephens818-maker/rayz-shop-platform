import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customerDependents, customers, mobileCheckouts, payments, saleItems, sales, shops } from "@/db/schema";
import { fundingForSurcharge } from "@/domain/checkout";
import { applyRate } from "@/lib/money";
import { localDateOf } from "@/lib/time";
import { customerActor, audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import { assertLaunched, closedShopCopy, shopLaunchState } from "@/server/launch";
import { accrueForSale } from "@/server/loyalty";
import { recordExistingCharge, reverseChargePlan, type ChargePlanResult } from "@/server/payments/charge-plan";
import { chargeDestination, shopAccount } from "@/server/payments/connect";
import { computeCardFee } from "@/server/payments/card-fee";
import { assertIssuedStripeSecret, cancelPaymentIntent, chargeCard, confirmPaymentIntent, inspectPaymentMethod, refundCard, retrievePaymentIntent, updatePaymentIntent, type CardDetails } from "@/server/payments/processor";
import { ensureStripeCustomer, ephemeralKeyForCustomer } from "./cards";
import { shopTakesCards } from "./shop-gates";

const UNAVAILABLE = "This shop isn't taking cards in the app yet.";

export interface PaymentPreview {
  shopId: string;
  paymentsEnabled: boolean;
  unavailableCopy: string | null;
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  funding: "credit" | "debit" | "prepaid" | "unknown" | null;
  wallet: boolean;
  feeCents: number;
  feeRate: number;
  feeReason: string;
  feeLabel: string | null;
  disclosure: string | null;
  totalCents: number;
  destination: {
    model: "separate_charges_and_transfers";
    shopAccountId: string | null;
    serviceTransferCents: number;
  };
  tipTransfer: {
    amountCents: number;
    disposition: "transfer" | "payroll";
    copy: string | null;
  };
}

async function ownsAppointment(customerId: string, appointmentCustomerId: string | null) {
  if (!appointmentCustomerId) return false;
  if (appointmentCustomerId === customerId) return true;
  const [link] = await db
    .select({ id: customerDependents.id })
    .from(customerDependents)
    .where(and(eq(customerDependents.guardianId, customerId), eq(customerDependents.dependentId, appointmentCustomerId)));
  return Boolean(link);
}

/**
 * Fee is computed before any charge. Tip disposition stays payroll while chargeCard
 * destination-charges the ticket, even when the shop switch is on.
 */
export async function previewPayment(
  customerId: string,
  code: string,
  input: { paymentMethodId?: string; tipCents?: number },
): Promise<PaymentPreview> {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!appt) throw notFound("Appointment");
  if (!(await ownsAppointment(customerId, appt.customerId))) throw notFound("Appointment");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, appt.shopId) });
  if (!shop) throw notFound("Shop");
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appt.id));
  const serviceCents = items.filter((i) => i.kind === "service" || i.kind === "addon").reduce((sum, i) => sum + i.priceCents, 0) || appt.estimateCents;
  const productCents = 0;
  const tipCents = input.tipCents ?? 0;
  if (!Number.isInteger(tipCents) || tipCents < 0) throw new AppError("bad_request", "Tip must be zero or more.");
  const launch = await shopLaunchState(shop.id);
  const account = await shopAccount(shop.id);
  const paymentsEnabled = shopTakesCards(launch.launched, account);
  const taxCents = applyRate(serviceCents, Number(shop.serviceTaxRate));
  const emptyDestination = { model: "separate_charges_and_transfers" as const, shopAccountId: account?.stripeAccountId ?? null, serviceTransferCents: 0 };
  if (!paymentsEnabled) {
    const unavailableCopy = launch.launched ? UNAVAILABLE : await closedShopCopy();
    return {
      shopId: shop.id,
      paymentsEnabled: false,
      unavailableCopy,
      serviceCents,
      productCents,
      taxCents: 0,
      tipCents,
      funding: null,
      wallet: false,
      feeCents: 0,
      feeRate: 0,
      feeReason: "disabled",
      feeLabel: null,
      disclosure: null,
      totalCents: serviceCents,
      destination: emptyDestination,
      tipTransfer: { amountCents: 0, disposition: "payroll", copy: "Tips paid through payroll." },
    };
  }
  let funding: PaymentPreview["funding"] = null;
  let wallet = false;
  if (input.paymentMethodId) {
    const card = await inspectPaymentMethod(input.paymentMethodId);
    // card.wallet and card.funding are Stripe's record. A client-sent wallet flag is not read.
    wallet = Boolean(card.wallet);
    funding = fundingForSurcharge(card.funding, wallet);
  }
  const chargeCents = serviceCents + productCents + taxCents + tipCents;
  const fee = await computeCardFee(shop.id, funding, { chargeCents, tipCents }, { wallet });
  return {
    shopId: shop.id,
    paymentsEnabled: true,
    unavailableCopy: null,
    serviceCents,
    productCents,
    taxCents,
    tipCents,
    funding,
    wallet,
    feeCents: fee.feeCents,
    feeRate: fee.rate,
    feeReason: fee.reason,
    feeLabel: fee.label,
    disclosure: fee.disclosure,
    totalCents: chargeCents + fee.feeCents,
    destination: {
      model: "separate_charges_and_transfers",
      shopAccountId: account?.stripeAccountId ?? null,
      serviceTransferCents: serviceCents + taxCents,
    },
    // chargeCard still destination-charges the whole ticket, so the tip does not transfer yet.
    tipTransfer: { amountCents: tipCents, disposition: "payroll", copy: "Tips paid through payroll." },
  };
}

function duplicateKey(e: unknown) {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

type PayInput = { paymentMethodId?: string; tipCents?: number; paymentIntentId?: string };
type PaidAppointment = { id: string; code: string; customerId: string | null; staffId: string | null };

async function refuseIfClosed(preview: PaymentPreview) {
  if (preview.paymentsEnabled) return;
  const launch = await shopLaunchState(preview.shopId);
  if (!launch.launched) await assertLaunched("payments", new Date(), preview.shopId);
  throw new AppError("payment_failed", UNAVAILABLE, { reason: "payments_not_ready" });
}

async function bookSale(customerId: string, appt: PaidAppointment, preview: PaymentPreview, plan: ChargePlanResult, card: CardDetails, key: string | null, quoteId: string) {
  const now = new Date();
  const businessDate = localDateOf(now);
  const saleId = await db.transaction(async (tx) => {
    const [sale] = await tx
      .insert(sales)
      .values({
        shopId: preview.shopId,
        appointmentId: appt.id,
        customerId: appt.customerId,
        staffId: appt.staffId,
        status: "paid",
        businessDate,
        serviceGrossCents: preview.serviceCents,
        serviceNetCents: preview.serviceCents,
        serviceTaxCents: preview.taxCents,
        tipCents: preview.tipCents,
        cardFeeCents: preview.feeCents,
        totalCents: preview.totalCents,
        loyaltyEarnedCents: preview.serviceCents,
        pricing: { feeReason: preview.feeReason, feeRate: preview.feeRate, funding: preview.funding, wallet: preview.wallet },
        paidAt: now,
      })
      .returning({ id: sales.id });
    const items = await tx.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appt.id));
    if (items.length) {
      let taxLeft = preview.taxCents;
      await tx.insert(saleItems).values(
        items.map((item) => {
          const taxable = item.kind === "service" || item.kind === "addon";
          const taxCents = taxable && taxLeft ? taxLeft : 0;
          if (taxCents) taxLeft = 0;
          return {
            saleId: sale.id,
            kind: item.kind,
            refId: item.serviceId,
            name: item.name,
            staffId: item.kind === "service" || item.kind === "addon" ? appt.staffId : null,
            qty: 1,
            unitPriceCents: item.priceCents,
            grossCents: item.priceCents,
            netCents: item.priceCents,
            taxCents,
          };
        }),
      );
    }
    await tx.insert(payments).values({
      saleId: sale.id,
      shopId: preview.shopId,
      businessDate,
      method: "card",
      status: "succeeded",
      amountCents: preview.totalCents,
      tipCents: preview.tipCents,
      cardFeeCents: preview.feeCents,
      processor: plan.processor,
      stripePaymentIntentId: plan.paymentIntentId,
      cardBrand: card.brand,
      cardLast4: card.last4,
      cardFunding: card.funding,
      entryMode: "keyed",
      stripeAccountId: plan.destinationAccount,
      applicationFeeCents: 0,
      stripeChargeId: plan.chargeId,
      stripeTransferId: plan.transfers.find((row) => row.role === "shop_net")?.stripeTransferId ?? null,
    });
    await tx
      .update(mobileCheckouts)
      .set({
        idempotencyKey: key,
        tipCents: preview.tipCents,
        subtotalCents: preview.serviceCents + preview.productCents,
        taxCents: preview.taxCents,
        feeCents: preview.feeCents,
        totalCents: preview.totalCents,
        funding: preview.funding,
        wallet: card.wallet ?? null,
        status: "paid",
        saleId: sale.id,
      })
      .where(eq(mobileCheckouts.id, quoteId));
    if (appt.customerId) await accrueForSale(tx, appt.customerId, sale.id, preview.serviceCents, now);
    return sale.id;
  });
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { firstName: true } });
  await audit(customerActor(customer?.firstName ?? "customer"), "sale.paid", "sale", saleId, { totalCents: preview.totalCents, feeCents: preview.feeCents, source: "app" }, preview.shopId);
  return saleId;
}

interface StoredPrice {
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  feeRate: number;
  feeReason: string;
  feeLabel: string | null;
  totalCents: number;
  funding: PaymentPreview["funding"];
  wallet: boolean;
  paymentMethodId: string;
}

function priceMetadata(appt: PaidAppointment, preview: PaymentPreview, paymentMethodId: string): Record<string, string> {
  return {
    appointmentId: appt.id,
    code: appt.code,
    serviceCents: String(preview.serviceCents),
    productCents: String(preview.productCents),
    taxCents: String(preview.taxCents),
    tipCents: String(preview.tipCents),
    feeCents: String(preview.feeCents),
    totalCents: String(preview.totalCents),
    paymentMethodId,
    funding: preview.funding ?? "",
    wallet: preview.wallet ? "1" : "0",
    feeReason: preview.feeReason,
    feeRate: String(preview.feeRate),
    feeLabel: preview.feeLabel ?? "",
  };
}

function storedPrice(row: typeof mobileCheckouts.$inferSelect, metadata: Record<string, string>): StoredPrice | null {
  const serviceCents = Number(metadata.serviceCents);
  const productCents = Number(metadata.productCents ?? "0");
  const feeRate = Number(metadata.feeRate ?? "0");
  const funding = metadata.funding === "credit" || metadata.funding === "debit" || metadata.funding === "prepaid" || metadata.funding === "unknown" ? metadata.funding : null;
  const amounts = [serviceCents, productCents, row.taxCents, row.tipCents, row.feeCents, row.totalCents, row.subtotalCents];
  if (amounts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (serviceCents + productCents !== row.subtotalCents) return null;
  if (row.subtotalCents + row.taxCents + row.tipCents + row.feeCents !== row.totalCents) return null;
  if (metadata.tipCents !== String(row.tipCents) || metadata.totalCents !== String(row.totalCents) || metadata.feeCents !== String(row.feeCents)) return null;
  if (!metadata.paymentMethodId) return null;
  return {
    serviceCents,
    productCents,
    taxCents: row.taxCents,
    tipCents: row.tipCents,
    feeCents: row.feeCents,
    feeRate: Number.isFinite(feeRate) ? feeRate : 0,
    feeReason: metadata.feeReason || "applies",
    feeLabel: metadata.feeLabel || null,
    totalCents: row.totalCents,
    funding,
    wallet: metadata.wallet === "1",
    paymentMethodId: metadata.paymentMethodId,
  };
}

function previewFromStored(shopId: string, stored: StoredPrice, shopAccountId: string | null): PaymentPreview {
  return {
    shopId,
    paymentsEnabled: true,
    unavailableCopy: null,
    serviceCents: stored.serviceCents,
    productCents: stored.productCents,
    taxCents: stored.taxCents,
    tipCents: stored.tipCents,
    funding: stored.funding,
    wallet: stored.wallet,
    feeCents: stored.feeCents,
    feeRate: stored.feeRate,
    feeReason: stored.feeReason,
    feeLabel: stored.feeLabel,
    disclosure: null,
    totalCents: stored.totalCents,
    destination: {
      model: "separate_charges_and_transfers",
      shopAccountId,
      serviceTransferCents: stored.serviceCents + stored.productCents + stored.taxCents,
    },
    tipTransfer: { amountCents: stored.tipCents, disposition: "payroll", copy: "Tips paid through payroll." },
  };
}

async function finishPayment(customerId: string, appt: PaidAppointment, preview: PaymentPreview, plan: ChargePlanResult, card: CardDetails, key: string | null, chargeKey: string, quoteId: string) {
  try {
    const saleId = await bookSale(customerId, appt, preview, plan, card, key, quoteId);
    return paidReceipt(customerId, saleId, preview);
  } catch (e) {
    if (duplicateKey(e)) {
      const prior = key ? await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.idempotencyKey, key) }) : null;
      const sale = prior?.saleId ? null : await db.query.sales.findFirst({ where: eq(sales.appointmentId, appt.id) });
      const saleId = prior?.saleId ?? sale?.id;
      if (saleId) return paidReceipt(customerId, saleId, preview);
    } else {
      await reverseChargePlan({ paymentIntentId: plan.paymentIntentId, refundCents: preview.totalCents, idempotencyKey: `undo-${chargeKey}` }).catch(() => undefined);
    }
    throw e;
  }
}

/** A succeeded charge that we will not book. Refund it before anything else is charged. */
async function refundUnrecorded(intentId: string, amountCents: number, shopId: string, reason: string) {
  try {
    await refundCard(intentId, amountCents, `mismatch-${intentId}`, { reverseTransfer: true });
  } catch (e) {
    await audit(customerActor("customer"), "payment.mismatch_refunded", "payment_intent", intentId, { amountCents, reason, refunded: false }, shopId);
    throw new AppError("payment_failed", "The charge didn't match the price, and the refund failed.");
  }
  await audit(customerActor("customer"), "payment.mismatch_refunded", "payment_intent", intentId, { amountCents, reason, refunded: true }, shopId);
}

async function loadOwned(customerId: string, code: string) {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!appt || !(await ownsAppointment(customerId, appt.customerId))) throw notFound("Appointment");
  return appt;
}

/** Price the visit and hand PaymentSheet a client secret. A bare card is not charged here. */
export async function createPaymentIntent(customerId: string, code: string, input: { paymentMethodId?: string; tipCents?: number }) {
  if (!input.paymentMethodId) throw new AppError("bad_request", "Choose a saved card.");
  const preview = await previewPayment(customerId, code, input);
  await refuseIfClosed(preview);
  const appt = await loadOwned(customerId, code);
  const paid = { id: appt.id, code: appt.code, customerId: appt.customerId, staffId: appt.staffId };
  const existingSale = await db.query.sales.findFirst({ where: and(eq(sales.appointmentId, appt.id), eq(sales.status, "paid")) });
  if (existingSale) throw new AppError("conflict", "This visit is already paid.");
  const open = await db.select().from(mobileCheckouts).where(and(eq(mobileCheckouts.appointmentId, appt.id), eq(mobileCheckouts.status, "quoted")));
  for (const row of open) {
    if (!row.stripePaymentIntentId) continue;
    const prior = await retrievePaymentIntent(row.stripePaymentIntentId).catch(() => null);
    const same = prior && prior.status !== "canceled" && prior.paymentMethodId === input.paymentMethodId && row.tipCents === preview.tipCents && row.totalCents === preview.totalCents;
    if (same && prior) {
      const stripeCustomerId = await ensureStripeCustomer(customerId);
      const secret = prior.clientSecret ?? `pi_test_${prior.id.replace(/^sim_pi_/, "")}`;
      assertIssuedStripeSecret(secret);
      return {
        id: prior.id,
        clientSecret: secret,
        ephemeralKey: await ephemeralKeyForCustomer(stripeCustomerId),
        customerId: stripeCustomerId,
        paymentMethodId: input.paymentMethodId,
        funding: preview.funding,
        feeCents: preview.feeCents,
        totalCents: preview.totalCents,
      };
    }
    let nextStatus = "canceled";
    if (prior && prior.status === "succeeded" && prior.amountRefundedCents === 0) {
      await refundUnrecorded(prior.id, prior.amountCents, preview.shopId, "Unused confirmed intent replaced.");
      nextStatus = "refunded";
    } else if (prior && prior.status !== "canceled" && prior.status !== "succeeded") {
      await cancelPaymentIntent(prior.id);
    }
    await db.update(mobileCheckouts).set({ status: nextStatus }).where(eq(mobileCheckouts.id, row.id));
  }
  const card = await inspectPaymentMethod(input.paymentMethodId);
  const stripeCustomerId = await ensureStripeCustomer(customerId);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, preview.shopId) });
  if (!shop) throw notFound("Shop");
  const metadata = priceMetadata(paid, preview, input.paymentMethodId);
  const created = await chargeCard({
    paymentMethodId: input.paymentMethodId,
    amountCents: preview.totalCents,
    description: `Ray'z appointment ${appt.code}`,
    metadata,
    idempotencyKey: `app-intent:${appt.id}:${input.paymentMethodId}:${preview.totalCents}:${Date.now()}`,
    customerId: stripeCustomerId,
    destination: await chargeDestination(shop, preview.totalCents, "keyed"),
    surchargeCents: preview.feeCents,
    surchargeLabel: preview.feeLabel ?? undefined,
    confirm: false,
  });
  if (!created.clientSecret) throw new AppError("payment_failed", "Stripe did not return a client secret.");
  assertIssuedStripeSecret(created.clientSecret);
  await db.insert(mobileCheckouts).values({
    appointmentId: appt.id,
    customerId,
    shopId: preview.shopId,
    tipCents: preview.tipCents,
    subtotalCents: preview.serviceCents + preview.productCents,
    taxCents: preview.taxCents,
    feeCents: preview.feeCents,
    totalCents: preview.totalCents,
    funding: preview.funding,
    wallet: card.wallet ?? null,
    stripePaymentIntentId: created.paymentIntentId,
    status: "quoted",
  });
  return {
    id: created.paymentIntentId,
    clientSecret: created.clientSecret,
    ephemeralKey: await ephemeralKeyForCustomer(stripeCustomerId),
    customerId: stripeCustomerId,
    paymentMethodId: input.paymentMethodId,
    funding: preview.funding,
    feeCents: preview.feeCents,
    totalCents: preview.totalCents,
  };
}

/**
 * Record a PaymentIntent PaymentSheet already confirmed. The tip and the fee are the ones stored
 * with that intent. A client-sent tip is ignored. A succeeded charge is either recorded or refunded.
 */
async function payConfirmed(customerId: string, appt: PaidAppointment, paymentIntentId: string, key: string | null) {
  const quote = await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.stripePaymentIntentId, paymentIntentId) });
  if (!quote || quote.appointmentId !== appt.id || quote.customerId !== customerId) throw new AppError("bad_request", "Confirm the payment sheet before charging.");
  if (quote.status === "paid" && quote.saleId) {
    const intent = await retrievePaymentIntent(paymentIntentId).catch(() => null);
    const stored = intent ? storedPrice(quote, intent.metadata) : null;
    const account = await shopAccount(quote.shopId);
    const preview = stored
      ? previewFromStored(quote.shopId, stored, account?.stripeAccountId ?? null)
      : previewFromStored(quote.shopId, {
          serviceCents: quote.subtotalCents,
          productCents: 0,
          taxCents: quote.taxCents,
          tipCents: quote.tipCents,
          feeCents: quote.feeCents,
          feeRate: 0,
          feeReason: "applies",
          feeLabel: null,
          totalCents: quote.totalCents,
          funding: quote.funding === "credit" || quote.funding === "debit" || quote.funding === "prepaid" || quote.funding === "unknown" ? quote.funding : null,
          wallet: Boolean(quote.wallet),
          paymentMethodId: intent?.paymentMethodId ?? "",
        }, account?.stripeAccountId ?? null);
    return paidReceipt(customerId, quote.saleId, preview);
  }
  if (quote.status === "canceled" || quote.status === "refunded") throw new AppError("bad_request", "Confirm the payment sheet before charging.");
  let intent = await retrievePaymentIntent(paymentIntentId);
  if (intent.currency !== "usd") throw new AppError("payment_failed", "That payment is not complete.");
  if (intent.metadata.appointmentId !== appt.id || (intent.metadata.code && intent.metadata.code !== appt.code)) {
    throw new AppError("payment_failed", "That payment isn't for this appointment.");
  }
  let stored = storedPrice(quote, intent.metadata);
  const actualPm = intent.paymentMethodId;
  if (stored && actualPm && actualPm !== stored.paymentMethodId && intent.status !== "succeeded" && intent.status !== "canceled") {
    const repriced = await previewPayment(customerId, appt.code, { paymentMethodId: actualPm, tipCents: stored.tipCents });
    await refuseIfClosed(repriced);
    const metadata = priceMetadata(appt, repriced, actualPm);
    intent = await updatePaymentIntent(paymentIntentId, {
      amountCents: repriced.totalCents,
      paymentMethodId: actualPm,
      metadata,
      surchargeCents: repriced.feeCents,
      surchargeLabel: repriced.feeLabel ?? undefined,
    });
    const nextCard = await inspectPaymentMethod(actualPm);
    await db
      .update(mobileCheckouts)
      .set({
        tipCents: repriced.tipCents,
        subtotalCents: repriced.serviceCents + repriced.productCents,
        taxCents: repriced.taxCents,
        feeCents: repriced.feeCents,
        totalCents: repriced.totalCents,
        funding: repriced.funding,
        wallet: nextCard.wallet ?? null,
      })
      .where(eq(mobileCheckouts.id, quote.id));
    intent = await confirmPaymentIntent(paymentIntentId);
    const fresh = await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.id, quote.id) });
    stored = fresh ? storedPrice(fresh, intent.metadata) : null;
  }
  if (intent.status !== "succeeded") throw new AppError("bad_request", "Confirm the payment sheet before charging.");
  if (intent.amountRefundedCents > 0) throw new AppError("payment_failed", "That payment was refunded.");
  const chargedPm = intent.paymentMethodId ?? stored?.paymentMethodId ?? null;
  if (stored && chargedPm && chargedPm !== stored.paymentMethodId) {
    const repriced = await previewPayment(customerId, appt.code, { paymentMethodId: chargedPm, tipCents: stored.tipCents });
    if (intent.amountCents !== repriced.totalCents) {
      await refundUnrecorded(intent.id, intent.amountCents, quote.shopId, "Confirmed card and amount did not match the stored price.");
      await db.update(mobileCheckouts).set({ status: "refunded" }).where(eq(mobileCheckouts.id, quote.id));
      throw new AppError("payment_failed", "The charge didn't match the price, so it was refunded.");
    }
    const metadata = priceMetadata(appt, repriced, chargedPm);
    const nextCard = await inspectPaymentMethod(chargedPm);
    await db
      .update(mobileCheckouts)
      .set({
        tipCents: repriced.tipCents,
        subtotalCents: repriced.serviceCents + repriced.productCents,
        taxCents: repriced.taxCents,
        feeCents: repriced.feeCents,
        totalCents: repriced.totalCents,
        funding: repriced.funding,
        wallet: nextCard.wallet ?? null,
      })
      .where(eq(mobileCheckouts.id, quote.id));
    const fresh = await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.id, quote.id) });
    stored = fresh ? storedPrice(fresh, { ...intent.metadata, ...metadata }) : null;
  }
  if (!stored || intent.amountCents !== stored.totalCents) {
    if (intent.amountRefundedCents === 0) {
      await refundUnrecorded(intent.id, intent.amountCents, quote.shopId, "Confirmed amount did not match the stored breakdown.");
      await db.update(mobileCheckouts).set({ status: "refunded" }).where(eq(mobileCheckouts.id, quote.id));
    }
    throw new AppError("payment_failed", "The charge didn't match the price, so it was refunded.");
  }
  const priorPay = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, intent.id) });
  const account = await shopAccount(quote.shopId);
  const preview = previewFromStored(quote.shopId, stored, account?.stripeAccountId ?? intent.destination?.accountId ?? null);
  if (priorPay) return paidReceipt(customerId, priorPay.saleId, preview);
  const card = await inspectPaymentMethod(stored.paymentMethodId);
  const chargeKey = `app-pay:${intent.id}`;
  let plan: ChargePlanResult;
  try {
    plan = await recordExistingCharge(
    {
      shopId: preview.shopId,
      staffId: appt.staffId,
      paymentMethodId: stored.paymentMethodId,
      amountCents: preview.totalCents,
      tipCents: preview.tipCents,
      description: `Ray'z appointment ${appt.code}`,
      metadata: { appointmentId: appt.id, code: appt.code },
      idempotencyKey: chargeKey,
      customerId: intent.customerId,
    },
    {
      processor: intent.processor,
      paymentIntentId: intent.id,
      card,
      destination: intent.destination,
      chargeId: intent.chargeId,
      transferId: intent.transferId,
      processorFeeCents: intent.destination?.applicationFeeCents ?? null,
      destinationCharge: intent.destinationCharge,
      clientSecret: null,
    },
    );
  } catch (e) {
    if (intent.amountRefundedCents === 0) {
      await refundUnrecorded(intent.id, intent.amountCents, quote.shopId, "The charge succeeded but could not be recorded.").catch(() => undefined);
      await db.update(mobileCheckouts).set({ status: "refunded" }).where(eq(mobileCheckouts.id, quote.id));
    }
    throw e;
  }
  return finishPayment(customerId, appt, preview, plan, card, key, chargeKey, quote.id);
}

export async function payAppointment(customerId: string, code: string, input: PayInput, idempotencyKey: string | null) {
  const apptRow = await loadOwned(customerId, code);
  const appt = { id: apptRow.id, code: apptRow.code, customerId: apptRow.customerId, staffId: apptRow.staffId };
  const key = idempotencyKey?.trim() || null;
  if (key) {
    const prior = await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.idempotencyKey, key) });
    if (prior?.saleId && prior.status === "paid") {
      const intent = prior.stripePaymentIntentId ? await retrievePaymentIntent(prior.stripePaymentIntentId).catch(() => null) : null;
      const stored = intent ? storedPrice(prior, intent.metadata) : null;
      const account = await shopAccount(prior.shopId);
      if (stored) return paidReceipt(customerId, prior.saleId, previewFromStored(prior.shopId, stored, account?.stripeAccountId ?? null));
    }
  }
  const existingSale = await db.query.sales.findFirst({ where: and(eq(sales.appointmentId, appt.id), eq(sales.status, "paid")) });
  if (existingSale) throw new AppError("conflict", "This visit is already paid.");
  if (!input.paymentIntentId) {
    const preview = await previewPayment(customerId, code, { paymentMethodId: input.paymentMethodId, tipCents: input.tipCents });
    await refuseIfClosed(preview);
    throw new AppError("bad_request", "Confirm the payment sheet before charging.");
  }
  return payConfirmed(customerId, appt, input.paymentIntentId, key);
}

async function paidReceipt(customerId: string, saleId: string, preview: PaymentPreview) {
  const { customerReceipt } = await import("./receipts");
  const receipt = await customerReceipt(customerId, saleId);
  return {
    id: saleId,
    ...preview,
    paidAt: receipt?.paidAt ?? new Date().toISOString(),
    tender: "card" as const,
  };
}
