import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, Tx } from "@/db";
import { reverseCoupons } from "./coupons";
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
  proportionalCardFee,
  componentsTotal,
  lineRefunds,
} from "@/domain/refunds";
import type { CardFeeRefundRule, LoyaltyBasis } from "@/domain/checkout";
import { limitLabel } from "@/domain/permissions";
import { loyaltyEligibleCents } from "@/domain/loyalty";
import { formatCents } from "@/lib/money";
import { localDateOf } from "@/lib/time";
import { Actor, SYSTEM, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { Movement, postMovements } from "./inventory/ledger";
import { restoreRewardsForSale, reverseSaleLoyalty } from "./loyalty";
import { ticketAppointmentIds } from "./family-ticket";
import { refundCard } from "./payments/processor";
import { sendUpdatedReceipt } from "./receipts";
import { syncTipLedger } from "./tips/ledger";
import { planRefundReversals, settleSale } from "./payments/settlement";

const NONE = "00000000-0000-0000-0000-000000000000";

type Sale = typeof sales.$inferSelect;
type Payment = typeof payments.$inferSelect;

export interface RefundRequest {
  saleId: string;
  /** Lines (and how many units of each) to refund. */
  items: { saleItemId: string; qty: number }[];
  tipCents: number;
  /** Give back what's left of the credit card fee (true), its share of what's refunded ("proportional"), or none of it. */
  refundCardFee: boolean | "proportional";
  reason: string;
  restock: boolean;
  actor: Actor;
  /** The most this refund may give back, in cents: the refunder's limit or the approving manager's. */
  maxCents?: number | null;
  now?: Date;
}

/**
 * The brand's rule for the card surcharge on a refund, as it stood when the sale was paid. "keep"
 * gives none of it back on a refund (a void still reverses it); null is a sale from before the rule.
 */
export function feeRefundRule(sale: Pick<Sale, "pricing">): CardFeeRefundRule | null {
  const r = (sale.pricing as { cardFee?: { refundRule?: string } } | null)?.cardFee?.refundRule;
  return r === "keep" || r === "proportional" ? r : null;
}

/** What's still refundable on a sale, per line and per component. Drives the refund form. */
export async function refundableState(saleId: string, tx: Tx | typeof db = db) {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const items = await tx.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.kind));
  const prior = await tx.select().from(refunds).where(eq(refunds.saleId, saleId));
  const done = prior.reduce<RefundComponents>((a, r) => addComponents(a, r), { ...ZERO });
  const reloaded = items.filter((i) => i.kind === "gift_card" && i.refId).map((i) => i.refId!);
  const cards = await tx
    .select()
    .from(giftCards)
    .where(or(inArray(giftCards.saleItemId, items.length ? items.map((i) => i.id) : [NONE]), inArray(giftCards.id, reloaded.length ? reloaded : [NONE])));
  return {
    sale,
    items: items.map((i) => ({
      ...i,
      refundableQty: i.qty - i.refundedQty,
      giftCards: cards
        .filter((c) => c.saleItemId === i.id || (i.kind === "gift_card" && i.refId === c.id))
        .map((c) => ({ id: c.id, code: c.code, status: c.status, balanceCents: c.balanceCents, initialCents: c.initialCents, reload: i.refId === c.id })),
    })),
    tipRemainingCents: sale.tipCents - done.tipCents,
    cardFeeRemainingCents: sale.cardFeeCents - done.cardFeeCents,
    feeRefundRule: feeRefundRule(sale),
    refundedCents: prior.reduce((a, r) => a + r.amountCents, 0),
    /** Card refunds made in the Stripe dashboard that staff haven't said were for what yet. */
    awaiting: prior.filter((r) => r.awaitingLines).map((r) => ({ id: r.id, amountCents: r.amountCents, paymentId: r.paymentId, createdAt: r.createdAt })),
    done,
  };
}

function awaitingProblem(st: { awaiting: { amountCents: number }[] }) {
  const a = st.awaiting[0];
  return a ? new AppError("conflict", `A ${formatCents(a.amountCents)} card refund made in the Stripe dashboard needs its lines first. Say what it was for, then refund anything else.`, { reason: "awaiting_lines" }) : null;
}

export async function refundSale(req: RefundRequest) {
  const now = req.now ?? new Date();
  if (!req.reason.trim()) throw new AppError("bad_request", "A reason is required");
  if (!Number.isInteger(req.tipCents) || req.tipCents < 0) throw new AppError("bad_request", "Tip refund must be zero or more");
  if (!req.items.length && req.tipCents === 0 && !req.refundCardFee) throw new AppError("bad_request", "Pick what to refund");
  const r = await db.transaction(async (tx) => {
    const sale = await lockSale(tx, req.saleId);
    if (sale.isImported) throw new AppError("conflict", "This ticket was imported from Squire. Refund it in Squire.");
    if (!["paid", "partially_refunded"].includes(sale.status)) throw new AppError("conflict", `Can't refund a ${sale.status.replace("_", " ")} ticket`);
    return reverse(tx, sale, { kind: "refund", source: "staff", items: req.items, tipCents: req.tipCents, refundCardFee: req.refundCardFee, reason: req.reason, restock: req.restock, actor: req.actor, maxCents: req.maxCents, now });
  });
  await settleSale(req.saleId);
  return r;
}

/** Everything still refundable on a ticket. */
export async function refundEverything(saleId: string, reason: string, restock: boolean, actor: Actor, now = new Date(), maxCents: number | null = null) {
  const st = await refundableState(saleId);
  return refundSale({
    saleId,
    items: st.items.filter((i) => i.refundableQty > 0).map((i) => ({ saleItemId: i.id, qty: i.refundableQty })),
    tipCents: st.tipRemainingCents,
    refundCardFee: st.cardFeeRemainingCents > 0 && st.feeRefundRule !== "keep",
    reason,
    restock,
    actor,
    maxCents,
    now,
  });
}

export async function voidSale(saleId: string, reason: string, actor: Actor, now = new Date(), maxCents: number | null = null) {
  if (!reason.trim()) throw new AppError("bad_request", "A reason is required");
  await db.transaction(async (tx) => {
    const sale = await lockSale(tx, saleId);
    if (sale.status === "open") {
      await tx.update(sales).set({ status: "voided", voidedAt: now, voidReason: reason, voidApprovedBy: actor.approvedBy?.staffId ?? null }).where(eq(sales.id, saleId));
      const booked = [sale.appointmentId, ...(await ticketAppointmentIds(saleId, tx))].filter((x): x is string => !!x);
      if (booked.length) await tx.update(appointments).set({ status: "checked_in" }).where(inArray(appointments.id, booked));
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
      maxCents,
      now,
      strictGiftCards: true,
    });
    if (actor.approvedBy) await tx.update(sales).set({ voidApprovedBy: actor.approvedBy.staffId }).where(eq(sales.id, saleId));
  });
  await settleSale(saleId);
}

/** Over the limit: a manager whose limit covers it approves with their PIN. */
function overLimit(perm: "sales.refund" | "sales.void", cents: number, limitCents: number, approved: boolean) {
  const what = perm === "sales.void" ? "void" : "refund";
  return new AppError(
    "forbidden",
    approved
      ? `This ${what} is ${limitLabel(cents)}, above ${limitLabel(limitCents)}, the most you and the approving manager can give back. Pick a manager whose limit covers it.`
      : `This ${what} is ${limitLabel(cents)}, above your ${limitLabel(limitCents)} limit. A manager whose limit covers it approves with their PIN.`,
    { approval: perm, overLimit: true, limitCents },
  );
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
  refundCardFee: boolean | "proportional";
  reason: string;
  restock: boolean;
  actor: Actor;
  maxCents?: number | null;
  now: Date;
  /** Void: refuse if a gift card sold on the ticket has been used at all. */
  strictGiftCards?: boolean;
}

async function reverse(tx: Tx, sale: Sale, o: ReverseOpts) {
  const st = await refundableState(sale.id, tx);
  const waiting = awaitingProblem(st);
  if (waiting) throw waiting;
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
  const reloadsTaken: { code: string; refundedCents: number }[] = [];
  for (const l of lines.filter((x) => x.kind === "gift_card")) {
    const item = st.items.find((i) => i.id === l.itemId);
    if (item?.refId) {
      // A reload on an existing card is refunded by taking it back off the card; the card stays live.
      const [g] = await tx.select().from(giftCards).where(eq(giftCards.id, item.refId)).for("update");
      if (!g || g.status !== "active") throw new AppError("conflict", "The reloaded gift card isn't active any more");
      const take = Math.min(g.balanceCents, item.unitPriceCents);
      if (take <= 0) throw new AppError("conflict", `Gift card ${g.code} has been fully spent, so the reload can't be refunded`);
      if (o.strictGiftCards && take < item.unitPriceCents)
        throw new AppError("conflict", `Gift card ${g.code} has less on it than the reload. Refund the ticket instead; only ${formatCents(take)} goes back.`);
      await tx.update(giftCards).set({ balanceCents: g.balanceCents - take }).where(eq(giftCards.id, g.id));
      await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId: sale.id, deltaCents: -take, kind: "reload_refund", staffId: o.actor.staffId ?? null });
      reloadsTaken.push({ code: g.code, refundedCents: take });
      l.netCents = take;
      continue;
    }
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
  const asked = componentsFromLines(lines, o.tipCents, o.refundCardFee === true ? st.cardFeeRemainingCents : 0);
  if (o.kind === "refund" && st.feeRefundRule === "keep") asked.cardFeeCents = 0;
  else if (o.refundCardFee === "proportional") {
    const withTip = !!(sale.pricing as { cardFee?: { appliesToTip?: boolean } } | null)?.cardFee?.appliesToTip;
    const base = (c: RefundComponents) => c.serviceNetCents + c.productNetCents + c.giftCardSalesCents + c.taxCents + (withTip ? c.tipCents : 0);
    asked.cardFeeCents = proportionalCardFee({ feeLeftCents: st.cardFeeRemainingCents, refundBaseCents: base(asked), baseLeftCents: base(left) });
  }
  const components = Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, Math.max(0, Math.min(v, left[k as keyof RefundComponents]))])) as unknown as RefundComponents;
  if (o.kind === "refund" && componentsTotal(components) <= 0) throw new AppError("bad_request", "Nothing left to refund on what you picked");
  if (o.maxCents != null && componentsTotal(components) > o.maxCents) throw overLimit(o.kind === "void" ? "sales.void" : "sales.refund", componentsTotal(components), o.maxCents, !!o.actor.approvedBy);

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
      stripeIds.set(p.id, await refundCard(p.stripePaymentIntentId, step.amountCents, `refund-${p.id}-${p.refundedCents}-${step.amountCents}-${randomUUID()}`, { reverseTransfer: p.chargeType === "destination" && !!p.stripeAccountId }));
    }
  }

  const itemsJson = lines.map((l) => ({ saleItemId: l.itemId, name: l.name, kind: l.kind, qty: l.qty, cents: l.netCents + l.taxCents, netCents: l.netCents }));
  await recordSteps(tx, sale, pays, plan, { kind: o.kind, source: o.source, reason: o.reason, actor: o.actor, now: o.now, items: itemsJson, stripeIds });
  await syncTipLedger(tx, { saleId: sale.id });
  await planRefundReversals(tx, sale.id);

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
  const receipt = await sendUpdatedReceipt(sale.id, o.kind === "void" ? { kind: "void" } : { kind: "refund", refundedCents: componentsTotal(components) }, tx, o.now);
  await audit(
    o.actor,
    `sale.${o.kind}`,
    "sale",
    sale.id,
    {
      amountCents: componentsTotal(components),
      reason: o.reason,
      components,
      items: itemsJson,
      giftCardsVoided: voided,
      ...(reloadsTaken.length ? { giftCardReloadsRefunded: reloadsTaken } : {}),
      tenders: plan.map((s) => ({ method: s.method, cents: s.amountCents })),
      loyalty: result.loyalty,
      receipt: receipt && receipt.status !== "none" ? { status: receipt.status, to: receipt.masked } : null,
    },
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
      approvedBy: o.actor.approvedBy?.staffId ?? null,
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
  const counted = (sale.pricing as { loyalty?: Partial<LoyaltyBasis> } | null)?.loyalty;
  const back = loyaltyEligibleCents(components, { includeProducts: !!counted?.includeProducts, includeTips: !!counted?.includeTips });
  if (sale.customerId && sale.loyaltyEarnedCents > 0 && (back > 0 || full)) {
    loyalty = await reverseSaleLoyalty(tx, sale.id, sale.customerId, Math.min(back, sale.loyaltyEarnedCents), now, { full });
  }
  if (full) {
    // The client didn't get the reward's value as cash, so a full reversal gives the reward back.
    await restoreRewardsForSale(tx, sale.id);
    // Tickets from before coupon redemptions were recorded only have the one promo code.
    if (!(await reverseCoupons(tx, sale.id, now)) && sale.promoCodeId) await tx.update(promoCodes).set({ redemptions: sql`greatest(${promoCodes.redemptions} - 1, 0)` }).where(eq(promoCodes.id, sale.promoCodeId));
  }
  const booked = kind === "void" ? [sale.appointmentId, ...(await ticketAppointmentIds(sale.id, tx))].filter((x): x is string => !!x) : [];
  if (booked.length) await tx.update(appointments).set({ status: "in_service", completedAt: null }).where(inArray(appointments.id, booked));
  const status = kind === "void" ? "voided" : full ? "refunded" : "partially_refunded";
  await tx
    .update(sales)
    .set({ status, voidedAt: kind === "void" ? now : sale.voidedAt, voidReason: kind === "void" ? reason : sale.voidReason })
    .where(eq(sales.id, sale.id));
  return { status, loyalty };
}

const DASHBOARD_REASON = "Refunded in the Stripe dashboard";

/**
 * A refund made outside the POS (Stripe dashboard). `amountRefundedCents` is Stripe's running total
 * for the charge; anything above what we've already recorded is booked as money back on that card
 * with no lines. Guessing which lines it was for would move loyalty, gift card balances, commission
 * and tip pay on a guess, so none of them change until staff assign lines (assignRefundLines).
 */
export async function recordProcessorRefund(paymentIntentId: string, amountRefundedCents: number, ref: { eventId: string; stripeRefundId?: string | null }, now = new Date()) {
  const p0 = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, paymentIntentId) });
  if (!p0) return { recorded: 0, reason: "unknown_payment" as const };
  const out = await db.transaction(async (tx) => {
    const sale = await lockSale(tx, p0.saleId);
    const [p] = await tx.select().from(payments).where(eq(payments.id, p0.id)).for("update");
    const delta = Math.min(amountRefundedCents, p.amountCents) - p.refundedCents;
    if (delta <= 0) return { recorded: 0, reason: "already_recorded" as const };

    const [row] = await tx
      .insert(refunds)
      .values({
        saleId: sale.id,
        paymentId: p.id,
        shopId: sale.shopId,
        businessDate: localDateOf(now),
        method: p.method,
        amountCents: delta,
        reason: DASHBOARD_REASON,
        kind: "refund",
        source: "stripe_dashboard",
        stripeRefundId: ref.stripeRefundId ?? null,
        awaitingLines: true,
      })
      .returning({ id: refunds.id });
    const refunded = p.refundedCents + delta;
    await tx.update(payments).set({ refundedCents: refunded, status: refunded >= p.amountCents ? "refunded" : "partially_refunded" }).where(eq(payments.id, p.id));
    const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${refunds.amountCents}),0)::int` }).from(refunds).where(eq(refunds.saleId, sale.id));
    const status = total >= sale.totalCents ? "refunded" : "partially_refunded";
    await tx.update(sales).set({ status }).where(eq(sales.id, sale.id));
    await audit(SYSTEM, "sale.refund", "sale", sale.id, { source: "stripe_dashboard", eventId: ref.eventId, amountCents: delta, refundId: row.id, awaitingLines: true }, sale.shopId, tx);
    await planRefundReversals(tx, sale.id);
    return { recorded: delta, reason: "recorded" as const, refundId: row.id, status };
  });
  if (out.recorded) await settleSale(p0.saleId);
  return out;
}

export interface AssignLinesRequest {
  refundId: string;
  items: { saleItemId: string; qty: number }[];
  tipCents: number;
  /** As on a POS refund: all that's left of the surcharge, its share of the lines, or none. */
  refundCardFee: boolean | "proportional";
  restock: boolean;
  actor: Actor;
  now?: Date;
}

/**
 * Says what a Stripe dashboard refund was for. The lines picked must cover what went back on the
 * card; if they come to more, the refund is spread over them and they stay open for the rest.
 * Then everything a POS refund does happens: lines marked refunded (when covered in full),
 * products back in stock if asked, gift cards sold on the ticket cut, tip pay and loyalty
 * adjusted, and the updated receipt sent.
 */
export async function assignRefundLines(req: AssignLinesRequest) {
  const now = req.now ?? new Date();
  if (!Number.isInteger(req.tipCents) || req.tipCents < 0) throw new AppError("bad_request", "Tip must be zero or more");
  return db.transaction(async (tx) => {
    const r0 = await tx.query.refunds.findFirst({ where: eq(refunds.id, req.refundId) });
    if (!r0) throw notFound("Refund");
    const sale = await lockSale(tx, r0.saleId);
    const [r] = await tx.select().from(refunds).where(eq(refunds.id, r0.id)).for("update");
    if (!r.awaitingLines) throw new AppError("conflict", "This refund's lines are already assigned");
    const pays = await tx.select().from(payments).where(eq(payments.saleId, sale.id)).orderBy(asc(payments.createdAt)).for("update");
    const st = await refundableState(sale.id, tx);
    let lines: LineRefund[];
    try {
      lines = lineRefunds(
        st.items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, qty: i.qty, refundedQty: i.refundedQty, netCents: i.netCents, taxCents: i.taxCents })),
        req.items.filter((i) => i.qty > 0),
      );
    } catch (e) {
      throw new AppError("bad_request", (e as Error).message);
    }
    for (const l of lines.filter((x) => x.kind === "gift_card")) {
      const item = st.items.find((i) => i.id === l.itemId)!;
      const live = item.giftCards.filter((g) => g.status === "active").map((g) => (g.reload ? Math.min(g.balanceCents, item.unitPriceCents) : g.balanceCents));
      l.netCents = live.sort((a, b) => b - a).slice(0, l.qty).reduce((a, b) => a + b, 0);
    }

    const tender = (await tenderStates(tx, sale.id, pays)).find((t) => t.id === r.paymentId);
    const left = remainingComponents(sale, st.done);
    const cap: RefundComponents = tender ? { ...left, tipCents: Math.min(tender.tipAvailableCents, left.tipCents), cardFeeCents: Math.min(tender.feeAvailableCents, left.cardFeeCents) } : left;
    if (req.tipCents > cap.tipCents) throw new AppError("bad_request", `Only ${formatCents(cap.tipCents)} of tip is left on that card`);
    const asked = componentsFromLines(lines, req.tipCents, req.refundCardFee === true ? cap.cardFeeCents : 0);
    if (st.feeRefundRule === "keep") asked.cardFeeCents = 0;
    else if (req.refundCardFee === "proportional") {
      const withTip = !!(sale.pricing as { cardFee?: { appliesToTip?: boolean } } | null)?.cardFee?.appliesToTip;
      const base = (c: RefundComponents) => c.serviceNetCents + c.productNetCents + c.giftCardSalesCents + c.taxCents + (withTip ? c.tipCents : 0);
      asked.cardFeeCents = proportionalCardFee({ feeLeftCents: cap.cardFeeCents, refundBaseCents: base(asked), baseLeftCents: base(left) });
    }
    const clamped = Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, Math.max(0, Math.min(v, cap[k as keyof RefundComponents]))])) as unknown as RefundComponents;
    const picked = componentsTotal(clamped);
    if (picked < r.amountCents)
      throw new AppError("bad_request", `What you picked comes to ${formatCents(picked)}, but ${formatCents(r.amountCents)} went back on the card. Pick more lines, or add the tip or surcharge.`, { pickedCents: picked });
    const whole = picked === r.amountCents;
    const components = whole ? clamped : allocateAmount(clamped, r.amountCents);

    // Spread thinner than the lines' value, they stay refundable for the rest (capped per component above).
    const itemsJson = lines.map((l) => ({ saleItemId: l.itemId, name: l.name, kind: l.kind, qty: l.qty, cents: l.netCents + l.taxCents, netCents: l.netCents, ...(whole ? {} : { partial: true }) }));
    await tx
      .update(refunds)
      .set({ ...components, items: itemsJson, awaitingLines: false, linesAssignedAt: now, linesAssignedBy: req.actor.staffId ?? null })
      .where(eq(refunds.id, r.id));
    const restock: Movement[] = [];
    for (const l of lines) {
      if (whole) await tx.update(saleItems).set({ refundedQty: sql`${saleItems.refundedQty} + ${l.qty}` }).where(eq(saleItems.id, l.itemId));
      const item = st.items.find((i) => i.id === l.itemId)!;
      if (l.kind === "product" && req.restock && item.refId) restock.push({ shopId: sale.shopId, productId: item.refId, delta: l.qty, kind: "refund", saleId: sale.id });
    }
    await postMovements(tx, restock, { actor: req.actor, at: now, audit: { action: "inventory.refund", entity: "sale", entityId: sale.id, details: { reason: DASHBOARD_REASON } } });
    const cut = await cutSoldGiftCards(tx, sale.id, components.giftCardSalesCents);
    await syncTipLedger(tx, { saleId: sale.id });
    const result = await settle(tx, sale, components, "refund", DASHBOARD_REASON, now);
    await sendUpdatedReceipt(sale.id, { kind: "refund", refundedCents: r.amountCents }, tx, now);
    await audit(req.actor, "sale.refund_lines", "sale", sale.id, { refundId: r.id, amountCents: r.amountCents, components, items: itemsJson, giftCardsCut: cut, loyalty: result.loyalty }, sale.shopId, tx);
    return { components, status: result.status, giftCardsCut: cut };
  });
}

/** Take value off gift cards sold on the ticket (largest balance first), voiding any that hit zero. */
async function cutSoldGiftCards(tx: Tx, saleId: string, cents: number) {
  if (cents <= 0) return [];
  const items = await tx
    .select({ id: saleItems.id, refId: saleItems.refId, unitPriceCents: saleItems.unitPriceCents })
    .from(saleItems)
    .where(and(eq(saleItems.saleId, saleId), eq(saleItems.kind, "gift_card")));
  if (!items.length) return [];
  const reloads = new Map(items.filter((i) => i.refId).map((i) => [i.refId!, i.unitPriceCents]));
  const cards = await tx
    .select()
    .from(giftCards)
    .where(and(or(inArray(giftCards.saleItemId, items.map((i) => i.id)), inArray(giftCards.id, reloads.size ? [...reloads.keys()] : [NONE])), eq(giftCards.status, "active")))
    .orderBy(desc(giftCards.balanceCents))
    .for("update");
  let left = cents;
  const out: { code: string; cutCents: number }[] = [];
  for (const g of cards) {
    if (left <= 0) break;
    const reload = reloads.get(g.id);
    // A reloaded card gives back at most the reload, and stays live for what was on it before.
    const take = Math.min(left, g.balanceCents, reload ?? Infinity);
    if (take <= 0) continue;
    await tx
      .update(giftCards)
      .set({ balanceCents: g.balanceCents - take, status: g.balanceCents - take === 0 && reload == null ? "void" : g.status })
      .where(eq(giftCards.id, g.id));
    await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId, deltaCents: -take, kind: reload == null ? "refund_cut" : "reload_refund" });
    out.push({ code: g.code, cutCents: take });
    left -= take;
  }
  return out;
}
