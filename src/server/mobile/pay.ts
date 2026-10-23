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
import { executeChargePlan, recordExistingCharge, reverseChargePlan, type ChargePlanResult } from "@/server/payments/charge-plan";
import { shopAccount } from "@/server/payments/connect";
import { computeCardFee } from "@/server/payments/card-fee";
import { inspectPaymentMethod, retrievePaymentIntent, type CardDetails } from "@/server/payments/processor";
import { ensureStripeCustomer } from "./cards";
import { shopTakesCards } from "./shop-gates";

const UNAVAILABLE = "This shop isn't taking cards in the app yet.";

export interface PaymentPreview {
  shopId: string;
  paymentsEnabled: boolean;
  unavailableCopy: string | null;
  serviceCents: number;
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
  const chargeCents = serviceCents + taxCents + tipCents;
  const fee = await computeCardFee(shop.id, funding, { chargeCents, tipCents }, { wallet });
  return {
    shopId: shop.id,
    paymentsEnabled: true,
    unavailableCopy: null,
    serviceCents,
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

async function bookSale(customerId: string, appt: PaidAppointment, preview: PaymentPreview, plan: ChargePlanResult, card: CardDetails, key: string | null) {
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
    await tx.insert(mobileCheckouts).values({
      appointmentId: appt.id,
      customerId,
      shopId: preview.shopId,
      idempotencyKey: key,
      tipCents: preview.tipCents,
      subtotalCents: preview.serviceCents,
      taxCents: preview.taxCents,
      feeCents: preview.feeCents,
      totalCents: preview.totalCents,
      funding: preview.funding,
      wallet: card.wallet ?? null,
      stripePaymentIntentId: plan.paymentIntentId,
      status: "paid",
      saleId: sale.id,
    });
    if (appt.customerId) await accrueForSale(tx, appt.customerId, sale.id, preview.serviceCents, now);
    return sale.id;
  });
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { firstName: true } });
  await audit(customerActor(customer?.firstName ?? "customer"), "sale.paid", "sale", saleId, { totalCents: preview.totalCents, feeCents: preview.feeCents, source: "app" }, preview.shopId);
  return saleId;
}

async function finishPayment(customerId: string, appt: PaidAppointment, preview: PaymentPreview, plan: ChargePlanResult, card: CardDetails, key: string | null, chargeKey: string) {
  try {
    const saleId = await bookSale(customerId, appt, preview, plan, card, key);
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

/**
 * The customer confirmed this PaymentIntent in PaymentSheet. Record it.
 * Price from the PaymentMethod on the intent. Never create a second charge.
 */
async function payConfirmed(customerId: string, appt: PaidAppointment, input: PayInput, key: string | null) {
  const intent = await retrievePaymentIntent(input.paymentIntentId!);
  if (intent.status !== "succeeded" || intent.amountRefundedCents > 0 || intent.currency !== "usd") {
    throw new AppError("payment_failed", "That payment is not complete.");
  }
  if (intent.metadata.appointmentId !== appt.id && intent.metadata.code !== appt.code) {
    throw new AppError("payment_failed", "That payment isn't for this appointment.");
  }
  if (intent.metadata.appointmentId && intent.metadata.appointmentId !== appt.id) throw new AppError("payment_failed", "That payment isn't for this appointment.");
  if (intent.metadata.code && intent.metadata.code !== appt.code) throw new AppError("payment_failed", "That payment isn't for this appointment.");
  if (!intent.paymentMethodId) throw new AppError("payment_failed", "That payment has no card.");
  const preview = await previewPayment(customerId, appt.code, { paymentMethodId: intent.paymentMethodId, tipCents: input.tipCents });
  await refuseIfClosed(preview);
  if (intent.amountCents !== preview.totalCents) throw new AppError("payment_failed", "The confirmed charge doesn't match the price.");
  const priorPay = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, intent.id) });
  if (priorPay) return paidReceipt(customerId, priorPay.saleId, preview);
  const card = await inspectPaymentMethod(intent.paymentMethodId);
  const chargeKey = `app-pay:${intent.id}`;
  const plan = await recordExistingCharge(
    {
      shopId: preview.shopId,
      staffId: appt.staffId,
      paymentMethodId: intent.paymentMethodId,
      amountCents: preview.totalCents,
      tipCents: preview.tipCents,
      description: `Ray'z appointment ${appt.code}`,
      metadata: { appointmentId: appt.id, code: appt.code },
      idempotencyKey: chargeKey,
      customerId: intent.customerId,
      customerFacing: true,
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
    },
  );
  return finishPayment(customerId, appt, preview, plan, card, key, chargeKey);
}

export async function payAppointment(customerId: string, code: string, input: PayInput, idempotencyKey: string | null) {
  if (!input.paymentMethodId && !input.paymentIntentId) throw new AppError("bad_request", "paymentMethodId is required.");
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.code, code.toUpperCase()) });
  if (!appt || !(await ownsAppointment(customerId, appt.customerId))) throw notFound("Appointment");
  const paid = { id: appt.id, code: appt.code, customerId: appt.customerId, staffId: appt.staffId };
  const existingSale = await db.query.sales.findFirst({ where: and(eq(sales.appointmentId, appt.id), eq(sales.status, "paid")) });
  if (existingSale) {
    const preview = await previewPayment(customerId, code, { paymentMethodId: input.paymentMethodId, tipCents: input.tipCents });
    return paidReceipt(customerId, existingSale.id, preview);
  }
  const key = idempotencyKey?.trim() || null;
  if (key) {
    const prior = await db.query.mobileCheckouts.findFirst({ where: eq(mobileCheckouts.idempotencyKey, key) });
    if (prior?.saleId && prior.status === "paid") {
      const preview = await previewPayment(customerId, code, { paymentMethodId: input.paymentMethodId, tipCents: input.tipCents });
      return paidReceipt(customerId, prior.saleId, preview);
    }
  }
  if (input.paymentIntentId) return payConfirmed(customerId, paid, input, key);
  const preview = await previewPayment(customerId, code, { paymentMethodId: input.paymentMethodId, tipCents: input.tipCents });
  await refuseIfClosed(preview);
  const stripeCustomerId = await ensureStripeCustomer(customerId);
  const card = await inspectPaymentMethod(input.paymentMethodId!);
  const chargeKey = `app-pay:${key ?? `${appt.id}:${preview.totalCents}:${preview.tipCents}`}`;
  const plan = await executeChargePlan({
    shopId: preview.shopId,
    staffId: appt.staffId,
    paymentMethodId: input.paymentMethodId!,
    amountCents: preview.totalCents,
    tipCents: preview.tipCents,
    description: `Ray'z appointment ${appt.code}`,
    metadata: { appointmentId: appt.id, code: appt.code },
    idempotencyKey: chargeKey,
    customerId: stripeCustomerId,
    customerFacing: true,
    surchargeCents: preview.feeCents,
    surchargeLabel: preview.feeLabel ?? undefined,
  });
  return finishPayment(customerId, paid, preview, plan, card, key, chargeKey);
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
