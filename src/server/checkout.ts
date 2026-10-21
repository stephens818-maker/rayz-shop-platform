import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx, Tx } from "@/db";
import {
  appointmentItems,
  appointments,
  cashDrawers,
  customers,
  giftCardLedger,
  giftCards,
  inventoryAdjustments,
  payments,
  products,
  promoCodes,
  refunds,
  saleItems,
  sales,
  shopProducts,
  staff,
  staffShops,
  Shop,
} from "@/db/schema";
import {
  CardFeeConfig,
  CardFunding,
  CartLine,
  Discount,
  LineKind,
  TaxRates,
  computeCheckout,
} from "@/domain/checkout";
import { giftCardCode } from "@/lib/ids";
import { formatCents } from "@/lib/money";
import { localDateOf, toZoned, todayLocal } from "@/lib/time";
import { Actor, SYSTEM, audit } from "./audit";
import { staffAtShopDenied } from "./auth/policy";
import { createAppointment, getAvailability } from "./booking";
import { getShop, shopCatalog } from "./catalog";
import { AppError, forbidden, notFound } from "./errors";
import { accrueForSale, getLoyaltyConfig, loadRedeemableReward, markRewardRedeemed } from "./loyalty";
import { chargeCard, inspectPaymentMethod, refundCard } from "./payments/processor";

export { refundEverything, refundSale, refundableState, voidSale } from "./refunds";

export function pricingConfig(shop: Shop): { taxRates: TaxRates; cardFee: CardFeeConfig; tipPresets: number[] } {
  return {
    taxRates: { serviceRate: Number(shop.serviceTaxRate), productRate: Number(shop.productTaxRate) },
    cardFee: {
      enabled: shop.cardFeeEnabled,
      rate: Number(shop.cardFeeRate),
      appliesToTip: shop.cardFeeAppliesToTip,
    },
    tipPresets: shop.tipPresets,
  };
}

/** Open (or reuse) the ticket for an appointment, pre-filled with its services. */
export async function openSaleForAppointment(appointmentId: string, actor: Actor) {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, appointmentId) });
  if (!appt) throw notFound("Appointment");
  const existing = await db.query.sales.findFirst({
    where: and(eq(sales.appointmentId, appointmentId), inArray(sales.status, ["open", "paid", "partially_refunded", "refunded"])),
  });
  if (existing) return existing;
  if (["cancelled", "no_show"].includes(appt.status)) throw new AppError("conflict", `Appointment is ${appt.status}`);
  const [sale] = await db
    .insert(sales)
    .values({
      shopId: appt.shopId,
      appointmentId,
      customerId: appt.customerId,
      staffId: appt.staffId,
      businessDate: todayLocal(),
      createdBy: actor.staffId ?? null,
    })
    .returning();
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appointmentId));
  if (items.length) {
    // Checkout charges today's menu price, so the ticket opens with it rather than the booked estimate.
    const menu = await shopCatalog(appt.shopId);
    await db.insert(saleItems).values(
      items.map((i) => {
        const price = menu.find((s) => s.id === i.serviceId)?.priceCents ?? i.priceCents;
        return { saleId: sale.id, kind: i.kind as LineKind, refId: i.serviceId, name: i.name, staffId: appt.staffId, qty: 1, unitPriceCents: price, grossCents: price, netCents: price };
      }),
    );
  }
  if (appt.status !== "in_service") {
    await db.update(appointments).set({ status: "in_service", checkedInAt: appt.checkedInAt ?? new Date() }).where(eq(appointments.id, appointmentId));
  }
  return sale;
}

export async function openBlankSale(shopId: string, actor: Actor, staffId: string | null = null) {
  const [sale] = await db
    .insert(sales)
    .values({ shopId, staffId, businessDate: todayLocal(), createdBy: actor.staffId ?? null })
    .returning();
  return sale;
}

export async function loadCheckoutContext(saleId: string) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const shop = await getShop(sale.shopId);
  const items = await db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).orderBy(asc(saleItems.kind));
  const customer = sale.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, sale.customerId) }) : null;
  const appt = sale.appointmentId ? await db.query.appointments.findFirst({ where: eq(appointments.id, sale.appointmentId) }) : null;
  const retail = await db
    .select({ productId: products.id, name: products.name, brand: products.brand, priceCents: shopProducts.priceCents, stock: shopProducts.stock })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shop.id), eq(shopProducts.active, true)))
    .orderBy(asc(products.brand), asc(products.name));
  const barber = sale.staffId ? await db.query.staff.findFirst({ where: eq(staff.id, sale.staffId) }) : null;
  return { sale, shop, items, customer, appointment: appt, retail, barber, config: pricingConfig(shop) };
}

export async function validatePromo(code: string, shopId: string, today = todayLocal()): Promise<Discount & { refId: string }> {
  const p = await db.query.promoCodes.findFirst({ where: eq(promoCodes.code, code.trim().toUpperCase()) });
  if (!p || !p.active) throw new AppError("bad_request", "Promo code not found");
  if (p.shopId && p.shopId !== shopId) throw new AppError("bad_request", "Promo code isn't valid at this shop");
  if (p.startsOn && today < p.startsOn) throw new AppError("bad_request", "Promo code isn't active yet");
  if (p.endsOn && today > p.endsOn) throw new AppError("bad_request", "Promo code has expired");
  if (p.maxRedemptions !== null && p.redemptions >= p.maxRedemptions) throw new AppError("bad_request", "Promo code has been fully redeemed");
  return {
    source: "promo",
    label: `Promo ${p.code}`,
    type: p.type === "percent" ? "percent" : "amount",
    value: p.value,
    appliesTo: (p.appliesTo as Discount["appliesTo"]) ?? "services",
    refId: p.id,
  };
}

export async function lookupGiftCard(code: string) {
  const g = await db.query.giftCards.findFirst({ where: eq(giftCards.code, code.trim().toUpperCase()) });
  if (!g || g.status !== "active") throw new AppError("bad_request", "Gift card not found");
  if (g.expiresAt && g.expiresAt < new Date()) throw new AppError("bad_request", "Gift card has expired");
  return { id: g.id, code: g.code, balanceCents: g.balanceCents };
}

export const GIFT_CARD_MIN_CENTS = 500;
export const GIFT_CARD_MAX_CENTS = 50_000;

export interface CheckoutLineInput {
  kind: LineKind;
  refId?: string | null;
  name?: string;
  qty: number;
  /** Gift cards only: the face value being sold. Services, add-ons, and products are priced from the shop menu. */
  unitPriceCents?: number;
  /** Charge something other than the menu price. Managers only; audited with the reason. */
  priceOverride?: { unitPriceCents: number; reason: string } | null;
}

export type TenderInput =
  | { method: "cash"; cashTenderedCents?: number | null }
  | { method: "card"; paymentMethodId: string; entryMode: "keyed" | "terminal" }
  | { method: "none" };

export interface FinalizeInput {
  saleId: string;
  staffId?: string | null;
  lines: CheckoutLineInput[];
  promoCode?: string | null;
  manualDiscount?: { type: "percent" | "amount"; value: number; reason: string } | null;
  loyaltyRewardId?: string | null;
  tipCents: number;
  giftCard?: { code: string; amountCents: number } | null;
  tender: TenderInput;
  /** Total the UI showed; refuse to charge if the server computes something different. */
  expectedTotalCents?: number | null;
  rebookInWeeks?: number | null;
  /** Set by the caller from the signed-in role, never from the request body. */
  canOverridePrice?: boolean;
  actor: Actor;
  now?: Date;
}

async function buildDiscounts(input: Omit<FinalizeInput, "actor">, shopId: string, customerId: string | null) {
  const discounts: (Discount & { refId?: string | null })[] = [];
  let promoId: string | null = null;
  if (input.promoCode) {
    const d = await validatePromo(input.promoCode, shopId);
    discounts.push(d);
    promoId = d.refId;
  }
  if (input.manualDiscount && input.manualDiscount.value > 0) {
    discounts.push({
      source: "manual",
      label: `Discount: ${input.manualDiscount.reason || "manager"}`,
      type: input.manualDiscount.type,
      value: input.manualDiscount.value,
      appliesTo: "all",
    });
  }
  let rewardId: string | null = null;
  if (input.loyaltyRewardId) {
    if (!customerId) throw new AppError("bad_request", "Attach a client to use a loyalty reward");
    const cfg = await getLoyaltyConfig();
    if (promoId && !cfg.stackWithPromos) throw new AppError("bad_request", "Loyalty rewards can't be combined with promo codes");
    const r = await loadRedeemableReward(db, customerId, input.loyaltyRewardId);
    discounts.push({ source: "loyalty", label: "Loyalty reward", type: "amount", value: r.amountCents, appliesTo: cfg.redeemableOn === "services" ? "services" : "all", refId: r.id });
    rewardId = r.id;
  }
  return { discounts, promoId, rewardId };
}

export interface PricedLineMeta {
  catalogPriceCents: number | null;
  overrideReason: string | null;
}

/**
 * Server-authoritative pricing. Services and add-ons come from the shop's menu and products from its
 * inventory; the client only says what's on the ticket. Gift cards carry the face value being sold.
 */
export async function priceCart(input: Omit<FinalizeInput, "actor">, funding: CardFunding | null) {
  const ctx = await loadCheckoutContext(input.saleId);
  const { discounts, promoId, rewardId } = await buildDiscounts(input, ctx.shop.id, ctx.sale.customerId);
  const gift = input.giftCard?.code ? await lookupGiftCard(input.giftCard.code) : null;

  const menu = await shopCatalog(ctx.shop.id);
  const productIds = input.lines.filter((l) => l.kind === "product" && l.refId).map((l) => l.refId!) as string[];
  const inv = productIds.length
    ? await db
        .select({ productId: shopProducts.productId, priceCents: shopProducts.priceCents, stock: shopProducts.stock, name: products.name, brand: products.brand })
        .from(shopProducts)
        .innerJoin(products, eq(products.id, shopProducts.productId))
        .where(and(eq(shopProducts.shopId, ctx.shop.id), eq(shopProducts.active, true), inArray(shopProducts.productId, productIds)))
    : [];
  const staffId = input.staffId ?? ctx.sale.staffId;
  const meta: PricedLineMeta[] = [];
  const lines: CartLine[] = input.lines.map((l, i) => {
    if (l.qty <= 0 || !Number.isInteger(l.qty)) throw new AppError("bad_request", "Quantities must be whole numbers");
    let name: string;
    let catalog: number;
    if (l.kind === "service" || l.kind === "addon") {
      const s = l.refId ? menu.find((x) => x.id === l.refId && x.kind === l.kind) : null;
      if (!s) throw new AppError("bad_request", `${l.name ?? "That service"} isn't on the ${ctx.shop.name} menu`);
      name = s.name;
      catalog = s.priceCents;
    } else if (l.kind === "product") {
      const p = inv.find((x) => x.productId === l.refId);
      if (!p) throw new AppError("bad_request", `${l.name ?? "That product"} isn't stocked at this shop`);
      name = `${p.brand} ${p.name}`;
      catalog = p.priceCents;
    } else {
      const face = l.unitPriceCents ?? 0;
      if (!Number.isInteger(face) || face < GIFT_CARD_MIN_CENTS || face > GIFT_CARD_MAX_CENTS) {
        throw new AppError("bad_request", `Gift cards are sold from ${formatCents(GIFT_CARD_MIN_CENTS)} to ${formatCents(GIFT_CARD_MAX_CENTS)}`);
      }
      if (l.priceOverride) throw new AppError("bad_request", "A gift card's price is its value");
      meta.push({ catalogPriceCents: null, overrideReason: null });
      return { key: String(i), kind: l.kind, name: `Gift card ${formatCents(face)}`, unitPriceCents: face, qty: l.qty, refId: null };
    }
    let unit = catalog;
    let reason: string | null = null;
    const o = l.priceOverride;
    if (o && o.unitPriceCents !== catalog) {
      if (!input.canOverridePrice) throw forbidden("Only a manager can change a price");
      if (!Number.isInteger(o.unitPriceCents) || o.unitPriceCents < 0) throw new AppError("bad_request", "Prices must be whole cents and not negative");
      if (!o.reason?.trim()) throw new AppError("bad_request", `Add a reason for changing the price of ${name}`);
      unit = o.unitPriceCents;
      reason = o.reason.trim();
    }
    meta.push({ catalogPriceCents: catalog, overrideReason: reason });
    return { key: String(i), kind: l.kind, name, unitPriceCents: unit, qty: l.qty, refId: l.refId ?? null, staffId: l.kind === "product" ? null : staffId };
  });

  const totals = computeCheckout({
    lines,
    discounts,
    taxRates: ctx.config.taxRates,
    tipCents: input.tipCents,
    cardFee: ctx.config.cardFee,
    tender: {
      method: input.tender.method,
      cardFunding: funding,
      giftCardCents: gift ? input.giftCard!.amountCents : 0,
      giftCardBalanceCents: gift?.balanceCents ?? 0,
    },
  });
  return { ctx, totals, promoId, rewardId, gift, inv, meta };
}

export async function finalizeSale(input: FinalizeInput) {
  const now = input.now ?? new Date();
  const pre = await loadCheckoutContext(input.saleId);
  if (pre.sale.status !== "open") throw new AppError("conflict", `Sale is already ${pre.sale.status}`);
  if (input.lines.length === 0) throw new AppError("bad_request", "Add at least one item");
  if (!Number.isInteger(input.tipCents) || input.tipCents < 0) throw new AppError("bad_request", "Tip must be zero or more");
  const staffId = input.staffId ?? pre.sale.staffId;
  if (staffId && staffId !== pre.sale.staffId) await assertStaffAtShop(staffId, pre.shop.id);

  let card: Awaited<ReturnType<typeof inspectPaymentMethod>> | null = null;
  if (input.tender.method === "card") card = await inspectPaymentMethod(input.tender.paymentMethodId);
  const { ctx, totals, promoId, rewardId, gift, inv, meta } = await priceCart(input, card?.funding ?? null);

  if (input.expectedTotalCents != null && input.expectedTotalCents !== totals.totalCents) {
    throw new AppError("conflict", "Totals changed — please review the ticket again", { totalCents: totals.totalCents });
  }
  const rewardCents = totals.discountBreakdown.find((d) => d.source === "loyalty")?.cents ?? 0;
  if (rewardId && rewardCents <= 0) {
    throw new AppError("bad_request", "The loyalty reward doesn't apply to anything on this ticket, so it wasn't used");
  }
  if (input.tender.method === "none" && totals.primaryBaseCents > 0) throw new AppError("bad_request", "Choose cash or card for the remaining balance");
  if (input.tender.method === "cash" && input.tender.cashTenderedCents != null && input.tender.cashTenderedCents < totals.primaryChargeCents) {
    throw new AppError("bad_request", "Cash tendered is less than the amount due");
  }

  const businessDate = localDateOf(now);
  const issuedGiftCards: { code: string; amountCents: number }[] = [];
  let rewardsIssued = 0;
  // Only this call's own charge is ever compensated. Each attempt gets its own idempotency key, so a
  // concurrent submit can never be handed (and then refund) the charge that won.
  let charge: Awaited<ReturnType<typeof chargeCard>> | null = null;
  const attempt = randomUUID();
  try {
    await db.transaction(async (tx: Tx) => {
      // A second submit of this ticket waits here, then sees it paid and stops before charging.
      const [locked] = await tx.select().from(sales).where(eq(sales.id, ctx.sale.id)).for("update");
      if (locked.status !== "open") throw new AppError("conflict", "This ticket was already paid");

      await tx.delete(saleItems).where(eq(saleItems.saleId, ctx.sale.id));
      const items = await tx
        .insert(saleItems)
        .values(
          totals.lines.map((l, i) => ({
            saleId: ctx.sale.id,
            kind: l.kind,
            refId: l.refId ?? null,
            name: l.name,
            staffId: l.kind === "service" || l.kind === "addon" ? staffId : null,
            qty: l.qty,
            unitPriceCents: l.unitPriceCents,
            grossCents: l.grossCents,
            discountCents: l.discountCents,
            netCents: l.netCents,
            taxCents: l.taxCents,
            catalogPriceCents: meta[i].catalogPriceCents,
            overrideReason: meta[i].overrideReason,
          })),
        )
        .returning({ id: saleItems.id });

      for (const [i, l] of totals.lines.entries()) {
        if (meta[i].overrideReason) {
          await audit(
            input.actor,
            "sale.price_override",
            "sale",
            ctx.sale.id,
            { item: l.name, catalogPriceCents: meta[i].catalogPriceCents, chargedCents: l.unitPriceCents, qty: l.qty, reason: meta[i].overrideReason },
            ctx.shop.id,
            tx,
          );
        }
        if (l.kind !== "gift_card") continue;
        for (let q = 0; q < l.qty; q++) {
          const code = giftCardCode();
          const [g] = await tx
            .insert(giftCards)
            .values({ code, initialCents: l.unitPriceCents, balanceCents: l.unitPriceCents, issuedShopId: ctx.shop.id, customerId: ctx.sale.customerId, source: "sold", saleItemId: items[i].id })
            .returning();
          await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId: ctx.sale.id, deltaCents: l.unitPriceCents, kind: "issue", staffId: input.actor.staffId ?? null });
          issuedGiftCards.push({ code, amountCents: l.unitPriceCents });
        }
      }

      if (gift && totals.giftCardAppliedCents > 0) {
        const res = await tx
          .update(giftCards)
          .set({ balanceCents: sql`${giftCards.balanceCents} - ${totals.giftCardAppliedCents}` })
          .where(and(eq(giftCards.id, gift.id), eq(giftCards.status, "active"), sql`${giftCards.balanceCents} >= ${totals.giftCardAppliedCents}`))
          .returning({ id: giftCards.id });
        if (!res.length) throw new AppError("conflict", "Gift card balance changed — apply it again");
        await tx.insert(giftCardLedger).values({ giftCardId: gift.id, saleId: ctx.sale.id, deltaCents: -totals.giftCardAppliedCents, kind: "redeem", staffId: input.actor.staffId ?? null });
      }

      for (const l of totals.lines.filter((x) => x.kind === "product")) {
        const p = inv.find((x) => x.productId === l.refId)!;
        const res = await tx
          .update(shopProducts)
          .set({ stock: sql`${shopProducts.stock} - ${l.qty}` })
          .where(and(eq(shopProducts.shopId, ctx.shop.id), eq(shopProducts.productId, p.productId), sql`${shopProducts.stock} >= ${l.qty}`))
          .returning({ stock: shopProducts.stock });
        if (!res.length) throw new AppError("conflict", `Not enough ${l.name} in stock. Recount it in Inventory if the shelf disagrees.`);
        await tx.insert(inventoryAdjustments).values({ shopId: ctx.shop.id, productId: p.productId, delta: -l.qty, reason: "sale", saleId: ctx.sale.id, staffId: input.actor.staffId ?? null });
      }

      if (promoId) {
        const [p] = await tx.select().from(promoCodes).where(eq(promoCodes.id, promoId)).for("update");
        if (p.maxRedemptions !== null && p.redemptions >= p.maxRedemptions) throw new AppError("conflict", "Promo code has been fully redeemed");
        await tx.update(promoCodes).set({ redemptions: p.redemptions + 1 }).where(eq(promoCodes.id, promoId));
      }
      if (rewardId && ctx.sale.customerId) await markRewardRedeemed(tx, rewardId, ctx.sale.id, ctx.sale.customerId, rewardCents, now);
      if (ctx.sale.customerId && totals.loyaltyEligibleCents > 0) {
        rewardsIssued = await accrueForSale(tx, ctx.sale.customerId, ctx.sale.id, totals.loyaltyEligibleCents, now);
      }

      // Everything that can fail on our side has run. Charge last, while still holding the lock.
      if (input.tender.method === "card" && totals.primaryChargeCents > 0) {
        charge = await chargeCard({
          paymentMethodId: input.tender.paymentMethodId,
          amountCents: totals.primaryChargeCents,
          description: `Ray'z ${ctx.shop.name} ticket #${ctx.sale.number}`,
          metadata: { saleId: ctx.sale.id, shop: ctx.shop.slug, cardFeeCents: String(totals.cardFeeCents), attempt },
          idempotencyKey: `sale-${ctx.sale.id}-${attempt}`,
        });
      }

      if (gift && totals.giftCardAppliedCents > 0) {
        await tx.insert(payments).values({
          saleId: ctx.sale.id,
          shopId: ctx.shop.id,
          businessDate,
          method: "gift_card",
          status: "succeeded",
          amountCents: totals.giftCardAppliedCents,
          tipCents: Math.max(0, totals.tipCents - totals.primaryBaseCents),
          giftCardId: gift.id,
        });
      }
      if (totals.primaryChargeCents > 0) {
        const c = charge as Awaited<ReturnType<typeof chargeCard>> | null;
        await tx.insert(payments).values({
          saleId: ctx.sale.id,
          shopId: ctx.shop.id,
          businessDate,
          method: input.tender.method === "card" ? "card" : "cash",
          status: "succeeded",
          amountCents: totals.primaryChargeCents,
          tipCents: Math.min(totals.tipCents, totals.primaryBaseCents),
          cardFeeCents: totals.cardFeeCents,
          cashTenderedCents: input.tender.method === "cash" ? (input.tender.cashTenderedCents ?? totals.primaryChargeCents) : null,
          processor: c ? (input.tender.method === "card" && input.tender.entryMode === "terminal" ? `${c.processor}_terminal` : c.processor) : null,
          stripePaymentIntentId: c?.paymentIntentId ?? null,
          cardBrand: c?.card.brand ?? null,
          cardLast4: c?.card.last4 ?? null,
          cardFunding: c?.card.funding ?? null,
          entryMode: input.tender.method === "card" ? input.tender.entryMode : null,
        });
      }

      await tx
        .update(sales)
        .set({
          status: "paid",
          staffId,
          businessDate,
          serviceGrossCents: totals.serviceGrossCents,
          productGrossCents: totals.productGrossCents,
          giftCardSalesCents: totals.giftCardSalesCents,
          discountCents: totals.discountCents,
          serviceNetCents: totals.serviceNetCents,
          productNetCents: totals.productNetCents,
          serviceTaxCents: totals.serviceTaxCents,
          productTaxCents: totals.productTaxCents,
          tipCents: totals.tipCents,
          cardFeeCents: totals.cardFeeCents,
          totalCents: totals.totalCents,
          promoCodeId: promoId,
          loyaltyEarnedCents: ctx.sale.customerId ? totals.loyaltyEligibleCents : 0,
          pricing: { ...ctx.config, discounts: totals.discountBreakdown, disclosures: totals.disclosures, cardFunding: card?.funding ?? null },
          paidAt: now,
        })
        .where(eq(sales.id, ctx.sale.id));

      if (ctx.sale.appointmentId) {
        await tx.update(appointments).set({ status: "completed", completedAt: now }).where(eq(appointments.id, ctx.sale.appointmentId));
      }
      await audit(
        input.actor,
        "sale.paid",
        "sale",
        ctx.sale.id,
        { totalCents: totals.totalCents, tipCents: totals.tipCents, method: input.tender.method, cardFunding: card?.funding ?? null, cardFeeCents: totals.cardFeeCents, discounts: totals.discountBreakdown },
        ctx.shop.id,
        tx,
      );
      if (input.manualDiscount && input.manualDiscount.value > 0) {
        await audit(input.actor, "sale.discount", "sale", ctx.sale.id, input.manualDiscount, ctx.shop.id, tx);
      }
    });
  } catch (e) {
    const own = charge as Awaited<ReturnType<typeof chargeCard>> | null;
    if (own) await compensateCharge(own.paymentIntentId, totals.primaryChargeCents, ctx.sale.id);
    throw e;
  }

  let rebooked = null;
  if (input.rebookInWeeks && ctx.appointment) {
    rebooked = await oneTapRebook(ctx.appointment.id, input.rebookInWeeks, input.actor).catch((e: Error) => ({ error: e.message }));
  }
  const c = charge as Awaited<ReturnType<typeof chargeCard>> | null;
  return { saleId: ctx.sale.id, totals, issuedGiftCards, rewardsIssued, rebooked, card: c?.card ?? null };
}

/**
 * Undo a charge this request made when its transaction didn't commit. If the payment row did land
 * (the commit succeeded but the reply was lost), the charge is real and is left alone.
 */
async function compensateCharge(paymentIntentId: string, amountCents: number, saleId: string) {
  const recorded = await db.query.payments.findFirst({ where: eq(payments.stripePaymentIntentId, paymentIntentId) }).catch(() => null);
  if (recorded) return;
  try {
    await refundCard(paymentIntentId, amountCents, `comp-${paymentIntentId}`);
    await audit(SYSTEM, "payment.compensated", "sale", saleId, { paymentIntentId, amountCents }, null);
  } catch (err) {
    await audit(SYSTEM, "payment.compensation_failed", "sale", saleId, { paymentIntentId, amountCents, error: (err as Error).message }, null).catch(() => {});
  }
}

export async function assertStaffAtShop(staffId: string, shopId: string, tx: DBorTx = db) {
  const links = await tx.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId));
  const denied = staffAtShopDenied(links.map((l) => l.shopId), shopId);
  if (denied) throw new AppError("bad_request", denied);
}

/**
 * One-tap rebook: same barber, same services, same time of day, N weeks out.
 * If that exact slot is taken, take the nearest opening that day with the same barber.
 */
export async function oneTapRebook(appointmentId: string, weeks: number, actor: Actor) {
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, appointmentId) });
  if (!appt) throw notFound("Appointment");
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appointmentId));
  const service = items.find((i) => i.kind === "service");
  if (!service?.serviceId) throw new AppError("bad_request", "Nothing to rebook");
  const addonIds = items.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!);
  // Add whole calendar weeks in Chicago time so DST doesn't shift the hour.
  const desired = toZoned(appt.startsAt).plus({ weeks }).toJSDate();
  const avail = await getAvailability({
    shopRef: appt.shopId,
    date: localDateOf(desired),
    serviceId: service.serviceId,
    addonIds,
    barberRef: appt.staffId,
    staffOverride: true,
  });
  if (!avail.slots.length) throw new AppError("slot_unavailable", "No openings with this barber that day");
  const best = [...avail.slots].sort(
    (a, b) => Math.abs(new Date(a.startsAt).getTime() - desired.getTime()) - Math.abs(new Date(b.startsAt).getTime() - desired.getTime()),
  )[0];
  return createAppointment({
    shopRef: appt.shopId,
    serviceId: service.serviceId,
    addonIds,
    barberRef: appt.staffId,
    startsAt: best.startsAt,
    customerId: appt.customerId,
    source: "rebook",
    rebookedFromId: appt.id,
    actor,
  });
}

// ───────────────────────────── Cash drawer ─────────────────────────────

export async function drawerSummary(shopId: string, date: string) {
  const [cash] = await db
    .select({ cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`, tips: sql<number>`coalesce(sum(${payments.tipCents}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId))
    .where(and(eq(payments.shopId, shopId), eq(payments.businessDate, date), eq(payments.method, "cash"), sql`${sales.status} <> 'voided'`));
  const [cashRefunds] = await db
    .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .where(and(eq(refunds.shopId, shopId), eq(refunds.businessDate, date), eq(refunds.method, "cash"), eq(refunds.kind, "refund")));
  const [cardTotals] = await db
    .select({ cents: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int`, n: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(eq(payments.shopId, shopId), eq(payments.businessDate, date), eq(payments.method, "card"), sql`${payments.status} <> 'voided'`));
  const drawer = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, shopId), eq(cashDrawers.businessDate, date)) });
  const opening = drawer?.openingFloatCents ?? 15_000;
  const payouts = drawer?.payoutsCents ?? 0;
  return {
    date,
    drawer,
    openingFloatCents: opening,
    cashSalesCents: cash.cents,
    cashTipsCents: cash.tips,
    cashTickets: cash.n,
    cashRefundsCents: cashRefunds.cents,
    payoutsCents: payouts,
    expectedCents: opening + cash.cents - cashRefunds.cents - payouts,
    cardCents: cardTotals.cents,
    cardTickets: cardTotals.n,
  };
}

export async function closeDrawer(input: {
  shopId: string;
  date: string;
  openingFloatCents: number;
  payoutsCents: number;
  countedCents: number;
  notes?: string | null;
  actor: Actor;
}) {
  const existing = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, input.shopId), eq(cashDrawers.businessDate, input.date)) });
  if (existing?.closedAt) throw new AppError("conflict", "Drawer already closed for this day");
  const s = await drawerSummary(input.shopId, input.date);
  const expected = input.openingFloatCents + s.cashSalesCents - s.cashRefundsCents - input.payoutsCents;
  const values = {
    shopId: input.shopId,
    businessDate: input.date,
    openingFloatCents: input.openingFloatCents,
    cashSalesCents: s.cashSalesCents,
    cashRefundsCents: s.cashRefundsCents,
    payoutsCents: input.payoutsCents,
    expectedCents: expected,
    countedCents: input.countedCents,
    varianceCents: input.countedCents - expected,
    notes: input.notes ?? null,
    closedBy: input.actor.staffId ?? null,
    closedAt: new Date(),
  };
  await db.insert(cashDrawers).values(values).onConflictDoUpdate({ target: [cashDrawers.shopId, cashDrawers.businessDate], set: values });
  await audit(input.actor, "drawer.close", "cash_drawer", `${input.shopId}:${input.date}`, { expected, counted: input.countedCents, variance: input.countedCents - expected }, input.shopId);
  return { expectedCents: expected, varianceCents: input.countedCents - expected };
}
