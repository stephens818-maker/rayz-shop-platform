import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, Tx } from "@/db";
import { appointments, cashDrawers, giftCardLedger, giftCards, payments, promoCodes, refunds, saleItems, sales } from "@/db/schema";
import {
  LineRefund,
  RefundComponents,
  TenderRefund,
  TenderState,
  ZERO,
  addComponents,
  allocateAmount,
  allocateToTenders,
  componentsFromLines,
  componentsTotal,
  lineRefunds,
} from "@/domain/refunds";
import { formatCents } from "@/lib/money";
import { localDateOf } from "@/lib/time";
import { Actor, SYSTEM, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { Movement, postMovements } from "./inventory/ledger";
import { restoreRewardsForSale, reverseForSale } from "./loyalty";
import { refundCard } from "./payments/processor";

type Sale = typeof sales.$inferSelect;
type Payment = typeof payments.$inferSelect;

export interface RefundRequest {
  saleId: string;
  /** Lines (and how many units of each) to refund. */
  items: { saleItemId: string; qty: number }[];
  tipCents: number;
  /** Give back what's left of the credit card fee. */
  refundCardFee: boolean;
  reason: string;
  restock: boolean;
  actor: Actor;
  now?: Date;
}

/** What's still refundable on a sale, per line and per component. Drives the refund form. */
export async function refundableState(saleId: string, tx: Tx | typeof db = db) {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const items = await tx.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.kind));
  const prior = await tx.select().from(refunds).where(eq(refunds.saleId, saleId));
  const done = prior.reduce<RefundComponents>((a, r) => addComponents(a, r), { ...ZERO });
  const cards = await tx.select().from(giftCards).where(inArray(giftCards.saleItemId, items.length ? items.map((i) => i.id) : ["00000000-0000-0000-0000-000000000000"]));
  return {
    sale,
    items: items.map((i) => ({
      ...i,
      refundableQty: i.qty - i.refundedQty,
      giftCards: cards.filter((c) => c.saleItemId === i.id).map((c) => ({ id: c.id, code: c.code, status: c.status, balanceCents: c.balanceCents, initialCents: c.initialCents })),
    })),
    tipRemainingCents: sale.tipCents - done.tipCents,
    cardFeeRemainingCents: sale.cardFeeCents - done.cardFeeCents,
    refundedCents: prior.reduce((a, r) => a + r.amountCents, 0),
    done,
  };
}

export async function refundSale(req: RefundRequest) {
  const now = req.now ?? new Date();
  if (!req.reason.trim()) throw new AppError("bad_request", "A reason is required");
  if (!Number.isInteger(req.tipCents) || req.tipCents < 0) throw new AppError("bad_request", "Tip refund must be zero or more");
  if (!req.items.length && req.tipCents === 0 && !req.refundCardFee) throw new AppError("bad_request", "Pick what to refund");
  return db.transaction(async (tx) => {
    const sale = await lockSale(tx, req.saleId);
    if (sale.isImported) throw new AppError("conflict", "This ticket was imported from Squire. Refund it in Squire.");
    if (!["paid", "partially_refunded"].includes(sale.status)) throw new AppError("conflict", `Can't refund a ${sale.status.replace("_", " ")} ticket`);
    return reverse(tx, sale, { kind: "refund", source: "staff", items: req.items, tipCents: req.tipCents, refundCardFee: req.refundCardFee, reason: req.reason, restock: req.restock, actor: req.actor, now });
  });
}

/** Everything still refundable on a ticket. */
export async function refundEverything(saleId: string, reason: string, restock: boolean, actor: Actor, now = new Date()) {
  const st = await refundableState(saleId);
  return refundSale({
    saleId,
    items: st.items.filter((i) => i.refundableQty > 0).map((i) => ({ saleItemId: i.id, qty: i.refundableQty })),
    tipCents: st.tipRemainingCents,
    refundCardFee: st.cardFeeRemainingCents > 0,
    reason,
    restock,
    actor,
    now,
  });
}

export async function voidSale(saleId: string, reason: string, actor: Actor, now = new Date()) {
  if (!reason.trim()) throw new AppError("bad_request", "A reason is required");
  await db.transaction(async (tx) => {
    const sale = await lockSale(tx, saleId);
    if (sale.status === "open") {
      await tx.update(sales).set({ status: "voided", voidedAt: now, voidReason: reason }).where(eq(sales.id, saleId));
      if (sale.appointmentId) await tx.update(appointments).set({ status: "checked_in" }).where(eq(appointments.id, sale.appointmentId));
      await audit(actor, "sale.void_open", "sale", saleId, { reason }, sale.shopId, tx);
      return;
    }
    if (sale.isImported) throw new AppError("conflict", "This ticket was imported from Squire and can't be voided here");
    if (sale.status !== "paid") throw new AppError("conflict", "Only unrefunded sales can be voided; use a refund instead");
    if (sale.businessDate !== localDateOf(now)) throw new AppError("conflict", "Voids are same-day only. Use a refund.");
    const drawer = await tx.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, sale.shopId), eq(cashDrawers.businessDate, sale.businessDate)) });
    if (drawer?.closedAt) throw new AppError("conflict", "The drawer is closed for today. Use a refund.");
    const items = await tx.select().from(saleItems).where(eq(saleItems.saleId, saleId));
    await reverse(tx, sale, {
      kind: "void",
      source: "staff",
      items: items.map((i) => ({ saleItemId: i.id, qty: i.qty - i.refundedQty })).filter((i) => i.qty > 0),
      tipCents: sale.tipCents,
      refundCardFee: true,
      reason,
      restock: true,
      actor,
      now,
      strictGiftCards: true,
    });
  });
}

async function lockSale(tx: Tx, saleId: string) {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
  if (!sale) throw notFound("Sale");
  return sale;
}

interface ReverseOpts {
  kind: "refund" | "void";
  source: "staff";
  items: { saleItemId: string; qty: number }[];
  tipCents: number;
  refundCardFee: boolean;
  reason: string;
  restock: boolean;
  actor: Actor;
  now: Date;
  /** Void: refuse if a gift card sold on the ticket has been used at all. */
  strictGiftCards?: boolean;
}

async function reverse(tx: Tx, sale: Sale, o: ReverseOpts) {
  const st = await refundableState(sale.id, tx);
  if (o.tipCents > st.tipRemainingCents) throw new AppError("bad_request", `Only ${formatCents(st.tipRemainingCents)} of tip is left to refund`);
  let lines: LineRefund[];
  try {
    lines = lineRefunds(
      st.items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, qty: i.qty, refundedQty: i.refundedQty, netCents: i.netCents, taxCents: i.taxCents })),
      o.items.filter((i) => i.qty > 0),
    );
  } catch (e) {
    throw new AppError("bad_request", (e as Error).message);
  }

  // A gift card sold on the ticket is refunded by voiding it, and only for what's still on it.
  const voided: { code: string; refundedCents: number }[] = [];
  for (const l of lines.filter((x) => x.kind === "gift_card")) {
    const cards = await tx
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.saleItemId, l.itemId), eq(giftCards.status, "active")))
      .orderBy(desc(giftCards.balanceCents))
      .for("update");
    if (cards.length < l.qty) throw new AppError("conflict", `Only ${cards.length} of the gift cards on this line are still active`);
    let cents = 0;
    for (const g of cards.slice(0, l.qty)) {
      if (g.balanceCents <= 0) throw new AppError("conflict", `Gift card ${g.code} has been fully spent, so it can't be refunded`);
      if (o.strictGiftCards && g.balanceCents < g.initialCents) {
        throw new AppError("conflict", `Gift card ${g.code} has already been used. Refund the ticket instead; only the unused ${formatCents(g.balanceCents)} goes back.`);
      }
      await tx.update(giftCards).set({ status: "void", balanceCents: 0 }).where(eq(giftCards.id, g.id));
      await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId: sale.id, deltaCents: -g.balanceCents, kind: "void", staffId: o.actor.staffId ?? null });
      voided.push({ code: g.code, refundedCents: g.balanceCents });
      cents += g.balanceCents;
    }
    l.netCents = cents;
  }

  // A dashboard refund takes value without naming a line, so never give back more of a component than is left.
  const left = remainingComponents(sale, st.done);
  const asked = componentsFromLines(lines, o.tipCents, o.refundCardFee ? st.cardFeeRemainingCents : 0);
  const components = Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, Math.max(0, Math.min(v, left[k as keyof RefundComponents]))])) as unknown as RefundComponents;
  if (o.kind === "refund" && componentsTotal(components) <= 0) throw new AppError("bad_request", "Nothing left to refund on what you picked");

  const pays = await tx.select().from(payments).where(eq(payments.saleId, sale.id)).orderBy(asc(payments.createdAt)).for("update");
  let plan: TenderRefund[];
  try {
    plan = allocateToTenders(components, await tenderStates(tx, sale.id, pays));
  } catch (e) {
    throw new AppError("bad_request", (e as Error).message);
  }

  // The card refund runs while this transaction holds the sale and payment locks, so the webhook
  // for it waits and then finds nothing new to record.
  const stripeIds = new Map<string, string>();
  for (const step of plan) {
    const p = pays.find((x) => x.id === step.tenderId)!;
    if (p.method === "card" && p.stripePaymentIntentId) {
      stripeIds.set(p.id, await refundCard(p.stripePaymentIntentId, step.amountCents, `refund-${p.id}-${p.refundedCents}-${step.amountCents}-${randomUUID()}`));
    }
  }

  const itemsJson = lines.map((l) => ({ saleItemId: l.itemId, name: l.name, qty: l.qty, cents: l.netCents + l.taxCents }));
  await recordSteps(tx, sale, pays, plan, { kind: o.kind, source: o.source, reason: o.reason, actor: o.actor, now: o.now, items: itemsJson, stripeIds });

  const restock: Movement[] = [];
  for (const l of lines) {
    await tx.update(saleItems).set({ refundedQty: sql`${saleItems.refundedQty} + ${l.qty}` }).where(eq(saleItems.id, l.itemId));
    const item = st.items.find((i) => i.id === l.itemId)!;
    if (l.kind === "product" && o.restock && item.refId) {
      restock.push({ shopId: sale.shopId, productId: item.refId, delta: l.qty, kind: o.kind, saleId: sale.id });
    }
  }
  await postMovements(tx, restock, { actor: o.actor, at: o.now, audit: { action: `inventory.${o.kind}`, entity: "sale", entityId: sale.id, details: { reason: o.reason } } });

  const result = await settle(tx, sale, components, o.kind, o.reason, o.now);
  await audit(
    o.actor,
    `sale.${o.kind}`,
    "sale",
    sale.id,
    { amountCents: componentsTotal(components), reason: o.reason, components, items: itemsJson, giftCardsVoided: voided, tenders: plan.map((s) => ({ method: s.method, cents: s.amountCents })), loyalty: result.loyalty },
    sale.shopId,
    tx,
  );
  return { refundedCents: componentsTotal(components), components, tenders: plan.map((s) => ({ method: s.method, cents: s.amountCents })), giftCardsVoided: voided, status: result.status };
}

function remainingComponents(sale: Sale, done: RefundComponents): RefundComponents {
  return {
    serviceNetCents: sale.serviceNetCents - done.serviceNetCents,
    productNetCents: sale.productNetCents - done.productNetCents,
    giftCardSalesCents: sale.giftCardSalesCents - done.giftCardSalesCents,
    taxCents: sale.serviceTaxCents + sale.productTaxCents - done.taxCents,
    tipCents: sale.tipCents - done.tipCents,
    cardFeeCents: sale.cardFeeCents - done.cardFeeCents,
  };
}

async function tenderStates(tx: Tx, saleId: string, pays: Payment[]): Promise<TenderState[]> {
  const byPayment = await tx
    .select({ paymentId: refunds.paymentId, tip: sql<number>`coalesce(sum(${refunds.tipCents}),0)::int`, fee: sql<number>`coalesce(sum(${refunds.cardFeeCents}),0)::int` })
    .from(refunds)
    .where(eq(refunds.saleId, saleId))
    .groupBy(refunds.paymentId);
  return pays
    .filter((p) => p.status !== "voided")
    .map((p) => {
      const r = byPayment.find((x) => x.paymentId === p.id);
      return {
        id: p.id,
        method: p.method as TenderState["method"],
        availableCents: p.amountCents - p.refundedCents,
        tipAvailableCents: p.tipCents - (r?.tip ?? 0),
        feeAvailableCents: p.cardFeeCents - (r?.fee ?? 0),
      };
    });
}

async function recordSteps(
  tx: Tx,
  sale: Sale,
  pays: Payment[],
  plan: TenderRefund[],
  o: { kind: "refund" | "void"; source: "staff" | "stripe_dashboard"; reason: string; actor: Actor; now: Date; items: unknown; stripeIds: Map<string, string> },
) {
  const businessDate = localDateOf(o.now);
  for (const [i, step] of plan.entries()) {
    const p = pays.find((x) => x.id === step.tenderId)!;
    await tx.insert(refunds).values({
      saleId: sale.id,
      paymentId: p.id,
      shopId: sale.shopId,
      businessDate,
      method: p.method,
      amountCents: step.amountCents,
      ...step.components,
      reason: o.reason,
      kind: o.kind,
      source: o.source,
      items: i === 0 ? o.items : null,
      stripeRefundId: o.stripeIds.get(p.id) ?? null,
      createdBy: o.actor.staffId ?? null,
    });
    const refunded = p.refundedCents + step.amountCents;
    await tx
      .update(payments)
      .set({ refundedCents: refunded, status: o.kind === "void" ? "voided" : refunded >= p.amountCents ? "refunded" : "partially_refunded" })
      .where(eq(payments.id, p.id));
    if (p.method === "gift_card" && p.giftCardId) {
      await tx.update(giftCards).set({ balanceCents: sql`${giftCards.balanceCents} + ${step.amountCents}` }).where(eq(giftCards.id, p.giftCardId));
      await tx.insert(giftCardLedger).values({ giftCardId: p.giftCardId, saleId: sale.id, deltaCents: step.amountCents, kind: "refund", staffId: o.actor.staffId ?? null });
    }
  }
}

/** Loyalty, promo, appointment, and sale status after a reversal. */
async function settle(tx: Tx, sale: Sale, components: RefundComponents, kind: "refund" | "void", reason: string, now: Date) {
  const [{ refunded }] = await tx.select({ refunded: sql<number>`coalesce(sum(${refunds.amountCents}),0)::int` }).from(refunds).where(eq(refunds.saleId, sale.id));
  const full = kind === "void" || refunded >= sale.totalCents;
  let loyalty = null;
  if (sale.customerId && sale.loyaltyEarnedCents > 0 && components.serviceNetCents > 0) {
    loyalty = await reverseForSale(tx, sale.customerId, sale.id, Math.min(components.serviceNetCents, sale.loyaltyEarnedCents), now);
  }
  if (full) {
    // The client didn't get the reward's value as cash, so a full reversal gives the reward back.
    await restoreRewardsForSale(tx, sale.id);
    if (sale.promoCodeId) await tx.update(promoCodes).set({ redemptions: sql`greatest(${promoCodes.redemptions} - 1, 0)` }).where(eq(promoCodes.id, sale.promoCodeId));
  }
  if (kind === "void" && sale.appointmentId) await tx.update(appointments).set({ status: "in_service", completedAt: null }).where(eq(appointments.id, sale.appointmentId));
  const status = kind === "void" ? "voided" : full ? "refunded" : "partially_refunded";
  await tx
    .update(sales)
    .set({ status, voidedAt: kind === "void" ? now : sale.voidedAt, voidReason: kind === "void" ? reason : sale.voidReason })
    .where(eq(sales.id, sale.id));
  return { status, loyalty };
}

/**
 * A refund made outside the POS (Stripe dashboard). `amountRefundedCents` is Stripe's running total
 * for the charge; anything above what we've already recorded is booked as a refund on that card,
 * split across what's left of the ticket, with the same loyalty and gift-card handling as the POS.
 */
export async function recordProcessorRefund(paymentIntentId: string, amountRefundedCents: number, ref: { eventId: string; stripeRefundId?: string | null }, now = new Date()) {
  const p0 = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, paymentIntentId) });
  if (!p0) return { recorded: 0, reason: "unknown_payment" as const };
  return db.transaction(async (tx) => {
    const sale = await lockSale(tx, p0.saleId);
    const pays = await tx.select().from(payments).where(eq(payments.saleId, sale.id)).orderBy(asc(payments.createdAt)).for("update");
    const p = pays.find((x) => x.id === p0.id)!;
    const delta = Math.min(amountRefundedCents, p.amountCents) - p.refundedCents;
    if (delta <= 0) return { recorded: 0, reason: "already_recorded" as const };

    const st = await refundableState(sale.id, tx);
    const tender = (await tenderStates(tx, sale.id, pays)).find((t) => t.id === p.id)!;
    const left = remainingComponents(sale, st.done);
    const remaining: RefundComponents = { ...left, tipCents: Math.min(tender.tipAvailableCents, left.tipCents), cardFeeCents: Math.min(tender.feeAvailableCents, left.cardFeeCents) };
    const components = allocateAmount(remaining, delta);
    const cut = await cutSoldGiftCards(tx, sale.id, components.giftCardSalesCents);
    const recorded = componentsTotal(components);
    await recordSteps(tx, sale, pays, [{ tenderId: p.id, method: "card", amountCents: recorded, components }], {
      kind: "refund",
      source: "stripe_dashboard",
      reason: "Refunded in the Stripe dashboard",
      actor: SYSTEM,
      now,
      items: null,
      stripeIds: new Map(ref.stripeRefundId ? [[p.id, ref.stripeRefundId]] : []),
    });
    const result = await settle(tx, sale, components, "refund", "Refunded in the Stripe dashboard", now);
    await audit(SYSTEM, "sale.refund", "sale", sale.id, { source: "stripe_dashboard", eventId: ref.eventId, amountCents: recorded, components, giftCardsCut: cut, loyalty: result.loyalty }, sale.shopId, tx);
    return { recorded, reason: "recorded" as const, components, status: result.status };
  });
}

/** Take value off gift cards sold on the ticket (largest balance first), voiding any that hit zero. */
async function cutSoldGiftCards(tx: Tx, saleId: string, cents: number) {
  if (cents <= 0) return [];
  const items = await tx.select({ id: saleItems.id }).from(saleItems).where(and(eq(saleItems.saleId, saleId), eq(saleItems.kind, "gift_card")));
  if (!items.length) return [];
  const cards = await tx
    .select()
    .from(giftCards)
    .where(and(inArray(giftCards.saleItemId, items.map((i) => i.id)), eq(giftCards.status, "active")))
    .orderBy(desc(giftCards.balanceCents))
    .for("update");
  let left = cents;
  const out: { code: string; cutCents: number }[] = [];
  for (const g of cards) {
    if (left <= 0) break;
    const take = Math.min(left, g.balanceCents);
    if (take <= 0) continue;
    await tx
      .update(giftCards)
      .set({ balanceCents: g.balanceCents - take, status: g.balanceCents - take === 0 ? "void" : g.status })
      .where(eq(giftCards.id, g.id));
    await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId, deltaCents: -take, kind: "refund_cut" });
    out.push({ code: g.code, cutCents: take });
    left -= take;
  }
  return out;
}
