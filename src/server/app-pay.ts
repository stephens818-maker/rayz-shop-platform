import type Stripe from "stripe";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appPayments, checkoutHandoffs, customerDevices, customers, notificationJobs, payments, refreshTokens, sales, shops } from "@/db/schema";
import { type CardFunding, cardFeeFor } from "@/domain/checkout";
import { flags } from "@/lib/flags";
import { formatCents } from "@/lib/money";
import { assertSwitch } from "./app-switches";
import { type Actor, SYSTEM, audit, customerActor } from "./audit";
import { type TenderInput, finalizeSale, priceCart } from "./checkout";
import { AppError, notFound } from "./errors";
import { householdHead, householdIds } from "./family";
import { type HandingOver, type HandoffDraftInput, type HandoffView, chooseTip, draftOf, finalizeFields, handoffView, startHandoff } from "./handoff";
import { myReceipt } from "./my-receipts";
import { pushDevices } from "./notifications/queue";
import { shopCardFeeConfig } from "./payments/card-fee";
import { SIM_CONFIRMATION_TOKENS, inspectPaymentMethod, isRequiresAction, refundCard, simulatedIntent, stripe } from "./payments/processor";
import { cardForPayment, ensureStripeCustomer, merchantDisplayName } from "./payments/saved-cards";
import { deliverReceipt } from "./receipts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signed in to the app now: a live session or a registered phone. */
async function onTheApp(holderId: string, now: Date) {
  const [[session], [device]] = await Promise.all([
    db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.customerId, holderId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, now)))
      .limit(1),
    db
      .select({ id: customerDevices.id })
      .from(customerDevices)
      .where(and(eq(customerDevices.customerId, holderId), isNull(customerDevices.revokedAt)))
      .limit(1),
  ]);
  return !!(session || device);
}

/**
 * Staff send the ticket as it stands to the client's phone (C7): priced now, tipped and paid in
 * the app. It's with the client until they pay or staff end it from the counter, as a customer
 * screen is. A child's ticket goes to the parent, who pays with their own cards (I1).
 */
export async function sendToApp(saleId: string, draft: HandoffDraftInput, by: HandingOver, now = new Date()) {
  await assertSwitch("payments");
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { id: true, shopId: true, customerId: true, number: true } });
  if (!sale) throw notFound("Sale");
  if (!sale.customerId) throw new AppError("bad_request", "Add the client to the ticket first");
  const holder = await householdHead(sale.customerId);
  const [c] = await db.select({ first: customers.firstName, deletedAt: customers.deletedAt }).from(customers).where(eq(customers.id, holder));
  if (!c || c.deletedAt || !(await onTheApp(holder, now)))
    throw new AppError("conflict", "This client isn't signed in to the Ray'z app. Hand them the customer screen or take payment here.", { reason: "not_on_app" });
  const h = await startHandoff(saleId, draft, by, "app");
  const v = await handoffView(h.id);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, sale.shopId), columns: { name: true } });
  const devices = await pushDevices(sale.customerId);
  if (devices.length)
    await db.insert(notificationJobs).values(
      devices.map((to) => ({
        kind: "ticket",
        channel: "push" as const,
        to,
        shopId: sale.shopId,
        customerId: sale.customerId,
        subject: `Ray'z ${shop?.name ?? ""}`.trim(),
        body: `Your ticket #${sale.number} is ready: ${formatCents(v.dueCents)}. Tap to tip and pay.`,
        runAt: now,
      })),
    );
  return { id: h.id, notified: devices.length };
}

type Row = typeof checkoutHandoffs.$inferSelect;

/** An app hand-off the signed-in client may see: their own ticket or one of their children's. */
async function ownTicket(customerId: string, id: string): Promise<{ row: Row; holder: string }> {
  if (!UUID.test(id)) throw notFound("Ticket");
  const [hit] = await db
    .select({ row: checkoutHandoffs, customerId: sales.customerId })
    .from(checkoutHandoffs)
    .innerJoin(sales, eq(sales.id, checkoutHandoffs.saleId))
    .where(and(eq(checkoutHandoffs.id, id), eq(checkoutHandoffs.via, "app")));
  if (!hit?.customerId) throw notFound("Ticket");
  const ids = await householdIds(customerId);
  if (!ids.includes(hit.customerId)) throw notFound("Ticket");
  return { row: hit.row, holder: ids[0] };
}

export type AppTicketStatus = "open" | "paid" | "withdrawn";
const statusOf = (s: Row["status"]): AppTicketStatus => (s === "active" ? "open" : s === "paid" ? "paid" : "withdrawn");

export interface AppTicket {
  id: string;
  status: AppTicketStatus;
  saleId: string;
  shop: { name: string; logoUrl: string | null };
  ticketNumber: number;
  barbers: string[];
  lines: HandoffView["lines"];
  discounts: HandoffView["discounts"];
  servicesCents: number;
  taxCents: number;
  giftCardCents: number;
  /** What's left to pay before any card surcharge, the tip chosen so far included. */
  dueCents: number;
  tip: { cents: number | null; choice: string | null };
  tips: HandoffView["tips"];
  tipBarbers: HandoffView["tipBarbers"];
  /** The shop's credit card surcharge. Only credit pays it; never debit or prepaid, and not wallets unless walletFee. */
  cardFee: { enabled: boolean; rate: number; appliesToTip: boolean; walletFee: boolean; notice: string | null };
  pay: { mode: "stripe" | "simulator"; cards: boolean; publishableKey: string | null; merchantDisplayName: string; applePayMerchantId: string | null; testTokens: { id: string; label: string }[] };
  paidAt: string | null;
}

async function toAppTicket(v: HandoffView, row: Row): Promise<AppTicket> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId), columns: { cardFeeEnabled: true, cardFeeRate: true, cardFeeAppliesToTip: true } });
  const fee = shop ? shopCardFeeConfig(shop) : { enabled: false, rate: 0, appliesToTip: false };
  return {
    id: v.id,
    status: statusOf(row.status),
    saleId: v.saleId,
    shop: { name: v.shop.name, logoUrl: v.shop.logoUrl },
    ticketNumber: v.ticketNumber,
    barbers: v.barbers,
    lines: v.lines,
    discounts: v.discounts,
    servicesCents: v.servicesCents,
    taxCents: v.taxCents,
    giftCardCents: v.giftCardCents,
    dueCents: v.dueCents,
    tip: { cents: v.tip.cents, choice: v.tip.choice },
    tips: v.tips,
    tipBarbers: v.tipBarbers,
    cardFee: { enabled: fee.enabled && fee.rate > 0, rate: fee.rate, appliesToTip: fee.appliesToTip, walletFee: flags.walletFee(), notice: v.feeNotice },
    pay: {
      mode: v.pay.mode,
      cards: v.pay.cards,
      publishableKey: v.pay.publishableKey,
      merchantDisplayName: merchantDisplayName(),
      applePayMerchantId: process.env.APPLE_PAY_MERCHANT_ID?.trim() || null,
      testTokens: v.pay.mode === "simulator" ? Object.entries(SIM_CONFIRMATION_TOKENS).map(([id, c]) => ({ id, label: c.label })) : [],
    },
    paidAt: v.paidAt,
  };
}

/** Tickets waiting in the app for the client and their children, newest first. */
export async function myOpenTickets(customerId: string) {
  const ids = await householdIds(customerId);
  const rows = await db
    .select({ id: checkoutHandoffs.id, startedAt: checkoutHandoffs.startedAt, number: sales.number, shop: shops.name, customerId: sales.customerId, first: customers.firstName })
    .from(checkoutHandoffs)
    .innerJoin(sales, eq(sales.id, checkoutHandoffs.saleId))
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(eq(checkoutHandoffs.via, "app"), eq(checkoutHandoffs.status, "active"), inArray(sales.customerId, ids)))
    .orderBy(desc(checkoutHandoffs.startedAt));
  const out = [];
  for (const r of rows) {
    const v = await handoffView(r.id);
    out.push({ id: r.id, shop: r.shop, ticketNumber: r.number, forFirstName: r.customerId === ids[0] ? null : r.first, dueCents: v.dueCents, sentAt: r.startedAt.toISOString() });
  }
  return out;
}

export async function myTicket(customerId: string, id: string): Promise<AppTicket> {
  const { row } = await ownTicket(customerId, id);
  return toAppTicket(await handoffView(row.id), row);
}

export interface TipChoiceInput {
  tipChoice: string;
  tipCents?: number;
  tipByStaff?: { staffId: string; cents: number }[] | null;
}

function openOrThrow(row: Row) {
  if (row.status === "paid") throw new AppError("conflict", "This ticket is paid. Thank you!", { reason: "paid" });
  if (row.status !== "active") throw new AppError("conflict", "The shop took this ticket back. Pay at the counter, or ask them to send it again.", { reason: "withdrawn" });
}

/** A saved card must be the holder's own; a ConfirmationToken comes from the app's PaymentSheet just now. */
async function cardFor(customerId: string, ref: string) {
  if (ref.startsWith("pm_")) {
    const { card } = await cardForPayment(customerId, ref);
    return { saved: true, card: await inspectPaymentMethod(card.stripePaymentMethodId).catch(() => ({ funding: card.funding, brand: card.brand, last4: card.last4, wallet: card.wallet })) };
  }
  if (!ref.startsWith("ctoken_")) throw new AppError("bad_request", "Pay with a saved card (pm_...) or the app's confirmation token (ctoken_...)", { field: "paymentMethodId" });
  return { saved: false, card: await inspectPaymentMethod(ref) };
}

async function priceWith(row: Row, ref: string, card: { funding: CardFunding; wallet?: string | null }) {
  const d = draftOf(row);
  const fresh = (await db.select().from(checkoutHandoffs).where(eq(checkoutHandoffs.id, row.id)))[0] ?? row;
  const tipCents = fresh.tipCents ?? 0;
  const priced = await priceCart(
    {
      saleId: row.saleId,
      ...finalizeFields(d),
      ...(fresh.tipByStaff ? { tipSplit: "per_barber" as const, tipByStaff: fresh.tipByStaff } : {}),
      tipCents,
      tender: { method: "card", paymentMethodId: ref, entryMode: "keyed" },
    },
    card.funding,
    { wallet: !!card.wallet },
  );
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId), columns: { cardFeeEnabled: true, cardFeeRate: true, cardFeeAppliesToTip: true } });
  const t = priced.totals;
  const fee = cardFeeFor(
    shopCardFeeConfig(shop!),
    card.funding,
    { chargeCents: t.primaryBaseCents, tipCents: Math.min(t.tipCents, t.primaryBaseCents) },
    { wallet: !!card.wallet, walletFeeOn: flags.walletFee() },
  );
  return { totals: t, fee, fresh };
}

export interface AppQuote {
  card: { brand: string; last4: string; funding: string; wallet: string | null; saved: boolean };
  tipCents: number;
  /** Before the surcharge, the tip included. */
  dueCents: number;
  feeCents: number;
  /** applies, not_credit (debit and prepaid), wallet_fee_off (Apple Pay, Google Pay), disabled, zero_amount. */
  feeReason: string;
  feeLabel: string | null;
  /** What goes on the card. */
  chargeCents: number;
  /** Send back as expectedTotalCents to pay. */
  totalCents: number;
  disclosures: string[];
}

/**
 * The fee shown before the client authorizes (C7): with the card picked in FlowController (a saved
 * card or a ConfirmationToken), its funding decides the surcharge, then our own Pay button confirms.
 */
export async function quoteTicket(customerId: string, id: string, input: TipChoiceInput & { paymentMethodId: string }): Promise<AppQuote> {
  await assertSwitch("payments");
  const { row } = await ownTicket(customerId, id);
  openOrThrow(row);
  await chooseTip(row.id, input.tipChoice, input.tipCents ?? 0, input.tipByStaff ?? null);
  const { saved, card } = await cardFor(customerId, input.paymentMethodId);
  const { totals: t, fee, fresh } = await priceWith(row, input.paymentMethodId, card);
  return {
    card: { brand: card.brand, last4: card.last4, funding: card.funding, wallet: card.wallet ?? null, saved },
    tipCents: fresh.tipCents ?? 0,
    dueCents: t.primaryBaseCents,
    feeCents: t.cardFeeCents,
    feeReason: fee.reason,
    feeLabel: t.cardFeeCents > 0 ? fee.label : null,
    chargeCents: t.primaryChargeCents,
    totalCents: t.totalCents,
    disclosures: t.disclosures,
  };
}

export type AppPayResult = { status: "paid"; receipt: Awaited<ReturnType<typeof myReceipt>> } | { status: "requires_action"; paymentIntentId: string; clientSecret: string };

async function paidBy(paymentIntentId: string) {
  return db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, paymentIntentId), columns: { id: true, saleId: true } });
}

/** Gives back an intent that succeeded for a ticket that was paid or changed some other way meanwhile. */
async function refundStray(ap: typeof appPayments.$inferSelect, actor: Actor) {
  if (!ap.stripePaymentIntentId || (await paidBy(ap.stripePaymentIntentId))) return false;
  const s = stripe();
  let succeeded = false;
  let reverse = false;
  if (s && !ap.stripePaymentIntentId.startsWith("sim_")) {
    const pi = await s.paymentIntents.retrieve(ap.stripePaymentIntentId).catch(() => null);
    succeeded = pi?.status === "succeeded";
    reverse = !!pi?.transfer_data;
  } else {
    const pi = simulatedIntent(ap.stripePaymentIntentId);
    succeeded = pi?.status === "succeeded";
    reverse = !!pi?.destination;
  }
  if (!succeeded) return false;
  await refundCard(ap.stripePaymentIntentId, ap.amountCents, `app-stray-${ap.id}`, { reverseTransfer: reverse });
  await db.update(appPayments).set({ status: "refunded", updatedAt: new Date() }).where(eq(appPayments.id, ap.id));
  await audit(actor, "app_payment.refunded_stray", "sale", ap.saleId, { appPaymentId: ap.id, paymentIntentId: ap.stripePaymentIntentId, amountCents: ap.amountCents }, ap.shopId);
  return true;
}

async function finish(
  ap: typeof appPayments.$inferSelect,
  row: Row,
  holder: string,
  actor: Actor,
  o: { confirmedIntentId?: string | null; expectedTotalCents?: number | null },
  now: Date,
): Promise<AppPayResult> {
  const d = draftOf(row);
  const stripeCustomerId = await ensureStripeCustomer(holder);
  const tender: TenderInput = {
    method: "card",
    paymentMethodId: ap.paymentMethodRef,
    entryMode: "keyed",
    stripeCustomerId,
    onAction: "return",
    confirmedIntentId: o.confirmedIntentId ?? null,
  };
  try {
    await finalizeSale({
      saleId: row.saleId,
      ...finalizeFields(d),
      ...(ap.tipByStaff ? { tipSplit: "per_barber" as const, tipByStaff: ap.tipByStaff } : {}),
      tipCents: ap.tipCents,
      tender,
      expectedTotalCents: o.expectedTotalCents ?? null,
      handoffId: row.id,
      payerCustomerId: holder,
      chargeMetadata: { appPaymentId: ap.id },
      actor,
      now,
    });
  } catch (e) {
    if (isRequiresAction(e)) {
      await db.update(appPayments).set({ status: "requires_action", stripePaymentIntentId: e.details.paymentIntentId, updatedAt: now }).where(eq(appPayments.id, ap.id));
      return { status: "requires_action", paymentIntentId: e.details.paymentIntentId, clientSecret: e.details.clientSecret };
    }
    if (o.confirmedIntentId) {
      const done = await paidBy(o.confirmedIntentId);
      if (done) return settled(ap, row, holder, actor, now);
      await refundStray({ ...ap, stripePaymentIntentId: o.confirmedIntentId }, actor).catch((err: Error) => console.error("app payment: stray refund failed", ap.id, err.message));
    }
    const code = e instanceof AppError ? ((e.details as { reason?: string } | undefined)?.reason ?? e.code) : "internal";
    await db
      .update(appPayments)
      .set({ status: "failed", failureCode: code, updatedAt: now })
      .where(and(eq(appPayments.id, ap.id), sql`${appPayments.status} <> 'refunded'`));
    throw e;
  }
  return settled(ap, row, holder, actor, now);
}

async function settled(ap: typeof appPayments.$inferSelect, row: Row, holder: string, actor: Actor, now: Date): Promise<AppPayResult> {
  const [p] = await db
    .select({ pi: payments.stripePaymentIntentId, fee: payments.cardFeeCents, funding: payments.cardFunding })
    .from(payments)
    .where(and(eq(payments.saleId, row.saleId), eq(payments.method, "card")));
  await db.transaction(async (tx) => {
    const [done] = await tx
      .update(appPayments)
      .set({
        status: "succeeded",
        stripePaymentIntentId: p?.pi ?? ap.stripePaymentIntentId,
        cardFeeCents: p?.fee ?? ap.cardFeeCents,
        cardFunding: p?.funding ?? ap.cardFunding,
        failureCode: null,
        updatedAt: now,
      })
      .where(and(eq(appPayments.id, ap.id), sql`${appPayments.status} <> 'succeeded'`))
      .returning({ id: appPayments.id });
    const [h] = await tx
      .update(checkoutHandoffs)
      .set({ status: "paid", paidAt: now, endedAt: now, tipCents: ap.tipCents, tipChoice: ap.tipChoice, tipSource: "screen", tipByStaff: ap.tipByStaff })
      .where(and(eq(checkoutHandoffs.id, row.id), eq(checkoutHandoffs.status, "active")))
      .returning({ id: checkoutHandoffs.id });
    if (!done && !h) return;
    await tx
      .transaction((sp) => deliverReceipt({ saleId: row.saleId, channel: "app", to: holder, purpose: "handoff", sentBy: null, now }, sp))
      .catch((e) => console.error("app payment: receipt not sent", row.saleId, (e as Error).message));
    await audit(actor, "handoff.paid", "sale", row.saleId, { handoffId: row.id, via: "app", appPaymentId: ap.id, tipCents: ap.tipCents, cardFeeCents: p?.fee ?? 0 }, row.shopId, tx);
  });
  return { status: "paid", receipt: await myReceipt(holder, row.saleId) };
}

/**
 * Pays the ticket in the app. Sent with the card picked and the total the quote showed; a changed
 * total is refused (409) so the client sees the new one first. A bank check comes back as
 * requires_action: the app runs it with the client secret, then calls again with paymentIntentId.
 */
export async function payTicket(
  customerId: string,
  id: string,
  input: TipChoiceInput & { paymentMethodId?: string | null; paymentIntentId?: string | null; expectedTotalCents?: number | null },
  now = new Date(),
): Promise<AppPayResult> {
  await assertSwitch("payments");
  const { row, holder } = await ownTicket(customerId, id);
  const actor = customerActor(holder);
  if (input.paymentIntentId) {
    const [ap] = await db
      .select()
      .from(appPayments)
      .where(and(eq(appPayments.stripePaymentIntentId, input.paymentIntentId), eq(appPayments.handoffId, row.id)));
    if (!ap) throw notFound("Payment");
    if (ap.status === "succeeded" || (await paidBy(input.paymentIntentId))) return settled(ap, row, holder, actor, now);
    openOrThrow(row);
    return finish(ap, row, holder, actor, { confirmedIntentId: input.paymentIntentId }, now);
  }
  openOrThrow(row);
  if (!input.paymentMethodId) throw new AppError("bad_request", "Pick a card", { field: "paymentMethodId" });
  if (input.expectedTotalCents == null) throw new AppError("bad_request", "Send the total you showed (expectedTotalCents)", { field: "expectedTotalCents" });
  await chooseTip(row.id, input.tipChoice, input.tipCents ?? 0, input.tipByStaff ?? null);
  const { card } = await cardFor(customerId, input.paymentMethodId);
  const { totals: t, fresh } = await priceWith(row, input.paymentMethodId, card);
  if (input.expectedTotalCents !== t.totalCents) throw new AppError("conflict", "Totals changed — please review the ticket again", { totalCents: t.totalCents });
  const [ap] = await db
    .insert(appPayments)
    .values({
      handoffId: row.id,
      saleId: row.saleId,
      shopId: row.shopId,
      payerCustomerId: holder,
      paymentMethodRef: input.paymentMethodId,
      amountCents: t.primaryChargeCents,
      cardFeeCents: t.cardFeeCents,
      tipCents: fresh.tipCents ?? 0,
      tipChoice: fresh.tipChoice,
      tipByStaff: fresh.tipByStaff,
      cardFunding: card.funding,
      wallet: card.wallet ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return finish(ap, fresh, holder, actor, { expectedTotalCents: input.expectedTotalCents }, now);
}

/** payment_intent.succeeded for an app payment the app didn't come back to finish (it closed after 3-D Secure). */
export async function completeFromWebhook(pi: Pick<Stripe.PaymentIntent, "id" | "metadata">, now = new Date()) {
  const apId = pi.metadata?.appPaymentId;
  if (!apId || !UUID.test(apId)) return { outcome: pi.metadata?.saleId ? ((await paidBy(pi.id)) ? "recorded" : "pos_unrecorded") : "not_ours" };
  const [ap] = await db.select().from(appPayments).where(eq(appPayments.id, apId));
  if (!ap) return { outcome: "unknown_app_payment" };
  if (ap.status === "succeeded" || (await paidBy(pi.id))) return { outcome: "already_paid" };
  const [row] = await db.select().from(checkoutHandoffs).where(eq(checkoutHandoffs.id, ap.handoffId));
  const holder = ap.payerCustomerId;
  if (!row || !holder || row.status !== "active") {
    const refunded = await refundStray({ ...ap, stripePaymentIntentId: pi.id }, SYSTEM);
    return { outcome: refunded ? "refunded_stray" : "nothing_to_do" };
  }
  await db
    .update(appPayments)
    .set({ stripePaymentIntentId: pi.id })
    .where(and(eq(appPayments.id, ap.id), isNull(appPayments.stripePaymentIntentId)));
  const r = await finish({ ...ap, stripePaymentIntentId: pi.id }, row, holder, SYSTEM, { confirmedIntentId: pi.id }, now).catch((e: Error) => ({ status: "failed" as const, error: e.message }));
  return { outcome: r.status === "paid" ? "paid" : r.status };
}

/** payment_intent.payment_failed for an app payment: the client hears it didn't go through. */
export async function failFromWebhook(pi: Pick<Stripe.PaymentIntent, "id" | "metadata" | "last_payment_error">, now = new Date()) {
  const apId = pi.metadata?.appPaymentId;
  if (!apId || !UUID.test(apId)) return { outcome: "not_ours" };
  const [ap] = await db
    .update(appPayments)
    .set({ status: "failed", failureCode: pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? "payment_failed", updatedAt: now })
    .where(and(eq(appPayments.id, apId), or(eq(appPayments.status, "pending"), eq(appPayments.status, "requires_action"))))
    .returning();
  if (!ap) return { outcome: "nothing_to_do" };
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, ap.saleId), columns: { number: true, customerId: true, shopId: true } });
  const devices = sale ? await pushDevices(sale.customerId) : [];
  if (devices.length)
    await db.insert(notificationJobs).values(
      devices.map((to) => ({
        kind: "ticket",
        channel: "push" as const,
        to,
        shopId: sale!.shopId,
        customerId: sale!.customerId,
        subject: "Ray'z Barber Shop",
        body: `Your payment for ticket #${sale!.number} didn't go through. Open the app to try another card.`,
        runAt: now,
      })),
    );
  return { outcome: "failed" };
}
