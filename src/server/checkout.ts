import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, Tx } from "@/db";
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
  Shop,
} from "@/db/schema";
import {
  CardFeeConfig,
  CardFunding,
  CartLine,
  Discount,
  LineKind,
  TaxRates,
  allocateRefund,
  computeCheckout,
} from "@/domain/checkout";
import { giftCardCode } from "@/lib/ids";
import { localDateOf, toZoned, todayLocal } from "@/lib/time";
import { Actor, audit } from "./audit";
import { createAppointment, getAvailability } from "./booking";
import { getShop } from "./catalog";
import { AppError, notFound } from "./errors";
import { accrueForSale, getLoyaltyConfig, loadRedeemableReward, markRewardRedeemed, restoreRewardsForSale } from "./loyalty";
import { chargeCard, inspectPaymentMethod, refundCard } from "./payments/processor";

export function pricingConfig(shop: Shop): { taxRates: TaxRates; cardFee: CardFeeConfig; tipPresets: number[] } {
  return {
    taxRates: { serviceRate: Number(shop.serviceTaxRate), productRate: Number(shop.productTaxRate) },
    cardFee: {
      enabled: shop.cardFeeEnabled,
      rate: Number(shop.cardFeeRate),
      appliesToTip: shop.cardFeeAppliesToTip,
      mode: shop.cardFeeMode === "cash_discount" ? "cash_discount" : "surcharge",
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
    await db.insert(saleItems).values(
      items.map((i) => ({
        saleId: sale.id,
        kind: i.kind as LineKind,
        refId: i.serviceId,
        name: i.name,
        staffId: appt.staffId,
        qty: 1,
        unitPriceCents: i.priceCents,
        grossCents: i.priceCents,
        netCents: i.priceCents,
      })),
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

export interface CheckoutLineInput {
  kind: LineKind;
  refId?: string | null;
  name: string;
  unitPriceCents: number;
  qty: number;
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
  actor: Actor;
  now?: Date;
}

async function buildDiscounts(input: FinalizeInput, shopId: string, customerId: string | null) {
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

/** Server-authoritative pricing for a cart. Also used as a "quote" endpoint. */
export async function priceCart(input: Omit<FinalizeInput, "actor">, funding: CardFunding | null) {
  const ctx = await loadCheckoutContext(input.saleId);
  const { discounts, promoId, rewardId } = await buildDiscounts(input as FinalizeInput, ctx.shop.id, ctx.sale.customerId);
  const gift = input.giftCard?.code ? await lookupGiftCard(input.giftCard.code) : null;

  // Product prices come from the shop's inventory, never from the client.
  const productIds = input.lines.filter((l) => l.kind === "product" && l.refId).map((l) => l.refId!) as string[];
  const inv = productIds.length
    ? await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, ctx.shop.id), inArray(shopProducts.productId, productIds)))
    : [];
  const lines: CartLine[] = input.lines.map((l, i) => {
    if (l.qty <= 0 || !Number.isInteger(l.qty)) throw new AppError("bad_request", "Quantities must be whole numbers");
    if (l.kind === "product") {
      const p = inv.find((x) => x.productId === l.refId);
      if (!p) throw new AppError("bad_request", `${l.name} isn't stocked at this shop`);
      return { key: String(i), kind: l.kind, name: l.name, unitPriceCents: p.priceCents, qty: l.qty, refId: l.refId };
    }
    if (l.unitPriceCents < 0) throw new AppError("bad_request", "Prices can't be negative");
    return { key: String(i), kind: l.kind, name: l.name, unitPriceCents: l.unitPriceCents, qty: l.qty, refId: l.refId ?? null, staffId: input.staffId ?? ctx.sale.staffId };
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
  return { ctx, totals, promoId, rewardId, gift, inv };
}

export async function finalizeSale(input: FinalizeInput) {
  const now = input.now ?? new Date();
  const pre = await loadCheckoutContext(input.saleId);
  if (pre.sale.status !== "open") throw new AppError("conflict", `Sale is already ${pre.sale.status}`);
  if (input.lines.length === 0) throw new AppError("bad_request", "Add at least one item");

  let card: Awaited<ReturnType<typeof inspectPaymentMethod>> | null = null;
  if (input.tender.method === "card") card = await inspectPaymentMethod(input.tender.paymentMethodId);
  const { ctx, totals, promoId, rewardId, gift, inv } = await priceCart(input, card?.funding ?? null);

  if (input.expectedTotalCents != null && input.expectedTotalCents !== totals.totalCents) {
    throw new AppError("conflict", "Totals changed — please review the ticket again", { totalCents: totals.totalCents });
  }
  if (input.tender.method === "none" && totals.primaryBaseCents > 0) throw new AppError("bad_request", "Choose cash or card for the remaining balance");
  if (input.tender.method === "cash" && input.tender.cashTenderedCents != null && input.tender.cashTenderedCents < totals.primaryChargeCents) {
    throw new AppError("bad_request", "Cash tendered is less than the amount due");
  }

  // 1) Charge the card first (outside the DB transaction). Compensate with a refund if the DB write fails.
  let charge: Awaited<ReturnType<typeof chargeCard>> | null = null;
  if (input.tender.method === "card" && totals.primaryChargeCents > 0) {
    charge = await chargeCard({
      paymentMethodId: input.tender.paymentMethodId,
      amountCents: totals.primaryChargeCents,
      description: `Ray'z ${ctx.shop.name} ticket`,
      metadata: { saleId: ctx.sale.id, shop: ctx.shop.slug, cardFeeCents: String(totals.cardFeeCents) },
      idempotencyKey: `sale-${ctx.sale.id}-${totals.primaryChargeCents}`,
    });
  }

  const businessDate = localDateOf(now);
  const issuedGiftCards: { code: string; amountCents: number }[] = [];
  let rewardsIssued = 0;
  try {
    await db.transaction(async (tx: Tx) => {
      // Lock the sale row so a double-tap can't pay twice.
      const [locked] = await tx.select().from(sales).where(eq(sales.id, ctx.sale.id)).for("update");
      if (locked.status !== "open") throw new AppError("conflict", "Sale was already completed");

      await tx.delete(saleItems).where(eq(saleItems.saleId, ctx.sale.id));
      await tx.insert(saleItems).values(
        totals.lines.map((l) => ({
          saleId: ctx.sale.id,
          kind: l.kind,
          refId: l.refId ?? null,
          name: l.name,
          staffId: l.kind === "service" || l.kind === "addon" ? (input.staffId ?? ctx.sale.staffId) : null,
          qty: l.qty,
          unitPriceCents: l.unitPriceCents,
          grossCents: l.grossCents,
          discountCents: l.discountCents,
          netCents: l.netCents,
          taxCents: l.taxCents,
        })),
      );

      // Gift cards sold on this ticket.
      for (const l of totals.lines.filter((x) => x.kind === "gift_card")) {
        for (let q = 0; q < l.qty; q++) {
          const code = giftCardCode();
          const [g] = await tx
            .insert(giftCards)
            .values({ code, initialCents: l.unitPriceCents, balanceCents: l.unitPriceCents, issuedShopId: ctx.shop.id, customerId: ctx.sale.customerId, source: "sold" })
            .returning();
          await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId: ctx.sale.id, deltaCents: l.unitPriceCents, kind: "issue", staffId: input.actor.staffId ?? null });
          issuedGiftCards.push({ code, amountCents: l.unitPriceCents });
        }
      }

      // Gift card redemption.
      if (gift && totals.giftCardAppliedCents > 0) {
        const res = await tx
          .update(giftCards)
          .set({ balanceCents: sql`${giftCards.balanceCents} - ${totals.giftCardAppliedCents}` })
          .where(and(eq(giftCards.id, gift.id), sql`${giftCards.balanceCents} >= ${totals.giftCardAppliedCents}`))
          .returning({ id: giftCards.id });
        if (!res.length) throw new AppError("conflict", "Gift card balance changed");
        await tx.insert(giftCardLedger).values({ giftCardId: gift.id, saleId: ctx.sale.id, deltaCents: -totals.giftCardAppliedCents, kind: "redeem", staffId: input.actor.staffId ?? null });
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
        const tipOnPrimary = Math.min(totals.tipCents, totals.primaryBaseCents);
        await tx.insert(payments).values({
          saleId: ctx.sale.id,
          shopId: ctx.shop.id,
          businessDate,
          method: input.tender.method === "card" ? "card" : "cash",
          status: "succeeded",
          amountCents: totals.primaryChargeCents,
          tipCents: tipOnPrimary,
          cardFeeCents: totals.cardFeeCents,
          cashTenderedCents: input.tender.method === "cash" ? (input.tender.cashTenderedCents ?? totals.primaryChargeCents) : null,
          processor: charge ? (input.tender.method === "card" && input.tender.entryMode === "terminal" ? `${charge.processor}_terminal` : charge.processor) : null,
          stripePaymentIntentId: charge?.paymentIntentId ?? null,
          cardBrand: charge?.card.brand ?? null,
          cardLast4: charge?.card.last4 ?? null,
          cardFunding: charge?.card.funding ?? null,
          entryMode: input.tender.method === "card" ? input.tender.entryMode : null,
        });
      }

      // Inventory.
      for (const l of totals.lines.filter((x) => x.kind === "product")) {
        const p = inv.find((x) => x.productId === l.refId)!;
        await tx
          .update(shopProducts)
          .set({ stock: sql`${shopProducts.stock} - ${l.qty}` })
          .where(and(eq(shopProducts.shopId, ctx.shop.id), eq(shopProducts.productId, p.productId)));
        await tx.insert(inventoryAdjustments).values({ shopId: ctx.shop.id, productId: p.productId, delta: -l.qty, reason: "sale", saleId: ctx.sale.id, staffId: input.actor.staffId ?? null });
      }

      if (promoId) await tx.update(promoCodes).set({ redemptions: sql`${promoCodes.redemptions} + 1` }).where(eq(promoCodes.id, promoId));
      if (rewardId && ctx.sale.customerId) {
        const cents = totals.discountBreakdown.find((d) => d.source === "loyalty")?.cents ?? 0;
        await markRewardRedeemed(tx, rewardId, ctx.sale.id, ctx.sale.customerId, cents, now);
      }
      if (ctx.sale.customerId && totals.loyaltyEligibleCents > 0) {
        rewardsIssued = await accrueForSale(tx, ctx.sale.customerId, ctx.sale.id, totals.loyaltyEligibleCents, now);
      }

      await tx
        .update(sales)
        .set({
          status: "paid",
          staffId: input.staffId ?? ctx.sale.staffId,
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
        {
          totalCents: totals.totalCents,
          tipCents: totals.tipCents,
          method: input.tender.method,
          cardFunding: card?.funding ?? null,
          cardFeeCents: totals.cardFeeCents,
          discounts: totals.discountBreakdown,
        },
        ctx.shop.id,
        tx,
      );
      if (input.manualDiscount && input.manualDiscount.value > 0) {
        await audit(input.actor, "sale.discount", "sale", ctx.sale.id, input.manualDiscount, ctx.shop.id, tx);
      }
    });
  } catch (e) {
    if (charge) await refundCard(charge.paymentIntentId, totals.primaryChargeCents, `comp-${ctx.sale.id}`).catch(() => {});
    throw e;
  }

  let rebooked = null;
  if (input.rebookInWeeks && ctx.appointment) {
    rebooked = await oneTapRebook(ctx.appointment.id, input.rebookInWeeks, input.actor).catch((e: Error) => ({ error: e.message }));
  }
  return { saleId: ctx.sale.id, totals, issuedGiftCards, rewardsIssued, rebooked, card: charge?.card ?? null };
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

// ───────────────────────────── Voids & refunds ─────────────────────────────

async function drawerClosed(shopId: string, date: string) {
  const d = await db.query.cashDrawers.findFirst({ where: and(eq(cashDrawers.shopId, shopId), eq(cashDrawers.businessDate, date)) });
  return !!d?.closedAt;
}

export async function voidSale(saleId: string, reason: string, actor: Actor, now = new Date()) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  if (!reason.trim()) throw new AppError("bad_request", "A reason is required");
  if (sale.status === "open") {
    await db.update(sales).set({ status: "voided", voidedAt: now, voidReason: reason }).where(eq(sales.id, saleId));
    if (sale.appointmentId) await db.update(appointments).set({ status: "checked_in" }).where(eq(appointments.id, sale.appointmentId));
    await audit(actor, "sale.void_open", "sale", saleId, { reason }, sale.shopId);
    return;
  }
  if (sale.status !== "paid") throw new AppError("conflict", "Only unrefunded sales can be voided; use a refund instead");
  if (sale.businessDate !== localDateOf(now)) throw new AppError("conflict", "Voids are same-day only. Use a refund.");
  if (await drawerClosed(sale.shopId, sale.businessDate)) throw new AppError("conflict", "The drawer is closed for today. Use a refund.");
  await reverseSale(sale, "void", sale.totalCents, reason, actor, true, now);
}

export async function refundSale(saleId: string, amountCents: number, reason: string, restock: boolean, actor: Actor, now = new Date()) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  if (!["paid", "partially_refunded"].includes(sale.status)) throw new AppError("conflict", `Can't refund a ${sale.status} sale`);
  if (!reason.trim()) throw new AppError("bad_request", "A reason is required");
  if (amountCents <= 0) throw new AppError("bad_request", "Refund amount must be positive");
  await reverseSale(sale, "refund", amountCents, reason, actor, restock, now);
}

async function reverseSale(
  sale: typeof sales.$inferSelect,
  kind: "void" | "refund",
  amountCents: number,
  reason: string,
  actor: Actor,
  restock: boolean,
  now: Date,
) {
  const prior = await db.select().from(refunds).where(eq(refunds.saleId, sale.id));
  const already = prior.reduce(
    (a, r) => ({
      serviceNetCents: a.serviceNetCents + r.serviceNetCents,
      productNetCents: a.productNetCents + r.productNetCents,
      giftCardSalesCents: a.giftCardSalesCents + r.giftCardSalesCents,
      taxCents: a.taxCents + r.taxCents,
      tipCents: a.tipCents + r.tipCents,
      cardFeeCents: a.cardFeeCents + r.cardFeeCents,
    }),
    { serviceNetCents: 0, productNetCents: 0, giftCardSalesCents: 0, taxCents: 0, tipCents: 0, cardFeeCents: 0 },
  );
  const refundedSoFar = prior.reduce((a, r) => a + r.amountCents, 0);
  const remaining = sale.totalCents - refundedSoFar;
  if (amountCents > remaining) throw new AppError("bad_request", `Only ${remaining} cents remain refundable`);
  const tax = sale.serviceTaxCents + sale.productTaxCents;
  const parts = allocateRefund(
    { serviceNetCents: sale.serviceNetCents, productNetCents: sale.productNetCents, giftCardSalesCents: sale.giftCardSalesCents, taxCents: tax, tipCents: sale.tipCents, cardFeeCents: sale.cardFeeCents },
    already,
    amountCents,
  );

  // Refund to original tenders: primary (card/cash) first, then gift card.
  const pays = await db.select().from(payments).where(eq(payments.saleId, sale.id)).orderBy(asc(payments.createdAt));
  const order = [...pays.filter((p) => p.method !== "gift_card"), ...pays.filter((p) => p.method === "gift_card")];
  let left = amountCents;
  const plan: { p: (typeof pays)[number]; cents: number; stripeRefundId?: string }[] = [];
  for (const p of order) {
    const avail = p.amountCents - p.refundedCents;
    const take = Math.min(avail, left);
    if (take > 0) plan.push({ p, cents: take });
    left -= take;
    if (left <= 0) break;
  }
  for (const step of plan) {
    if (step.p.method === "card" && step.p.stripePaymentIntentId) {
      step.stripeRefundId = await refundCard(step.p.stripePaymentIntentId, step.cents, `${kind}-${sale.id}-${refundedSoFar}-${step.p.id}`);
    }
  }

  const businessDate = localDateOf(now);
  await db.transaction(async (tx) => {
    let i = 0;
    for (const step of plan) {
      // Component split is recorded on the first refund row; the rest carry only the tender amount.
      const comp = i === 0 ? parts : { serviceNetCents: 0, productNetCents: 0, giftCardSalesCents: 0, taxCents: 0, tipCents: 0, cardFeeCents: 0 };
      await tx.insert(refunds).values({
        saleId: sale.id,
        paymentId: step.p.id,
        shopId: sale.shopId,
        businessDate,
        method: step.p.method,
        amountCents: step.cents,
        ...comp,
        reason,
        kind,
        stripeRefundId: step.stripeRefundId ?? null,
        createdBy: actor.staffId ?? null,
      });
      const newRefunded = step.p.refundedCents + step.cents;
      await tx
        .update(payments)
        .set({ refundedCents: newRefunded, status: kind === "void" ? "voided" : newRefunded >= step.p.amountCents ? "refunded" : "partially_refunded" })
        .where(eq(payments.id, step.p.id));
      if (step.p.method === "gift_card" && step.p.giftCardId) {
        await tx.update(giftCards).set({ balanceCents: sql`${giftCards.balanceCents} + ${step.cents}` }).where(eq(giftCards.id, step.p.giftCardId));
        await tx.insert(giftCardLedger).values({ giftCardId: step.p.giftCardId, saleId: sale.id, deltaCents: step.cents, kind: "refund", staffId: actor.staffId ?? null });
      }
      i++;
    }
    if (restock) {
      const items = await tx.select().from(saleItems).where(and(eq(saleItems.saleId, sale.id), eq(saleItems.kind, "product")));
      const full = kind === "void" || amountCents >= remaining;
      if (full) {
        for (const it of items) {
          if (!it.refId) continue;
          await tx.update(shopProducts).set({ stock: sql`${shopProducts.stock} + ${it.qty}` }).where(and(eq(shopProducts.shopId, sale.shopId), eq(shopProducts.productId, it.refId)));
          await tx.insert(inventoryAdjustments).values({ shopId: sale.shopId, productId: it.refId, delta: it.qty, reason: kind, saleId: sale.id, staffId: actor.staffId ?? null });
        }
      }
    }
    if (kind === "void") {
      // Gift cards sold on a voided ticket are voided too.
      const issued = await tx.select().from(giftCardLedger).where(and(eq(giftCardLedger.saleId, sale.id), eq(giftCardLedger.kind, "issue")));
      for (const g of issued) await tx.update(giftCards).set({ status: "void", balanceCents: 0 }).where(eq(giftCards.id, g.giftCardId));
      await restoreRewardsForSale(tx, sale.id);
      if (sale.promoCodeId) await tx.update(promoCodes).set({ redemptions: sql`greatest(${promoCodes.redemptions} - 1, 0)` }).where(eq(promoCodes.id, sale.promoCodeId));
      if (sale.appointmentId) await tx.update(appointments).set({ status: "in_service", completedAt: null }).where(eq(appointments.id, sale.appointmentId));
    }
    if (sale.customerId && parts.serviceNetCents > 0) {
      await accrueForSale(tx, sale.customerId, sale.id, -parts.serviceNetCents, now);
    }
    const totalRefunded = refundedSoFar + amountCents;
    await tx
      .update(sales)
      .set({
        status: kind === "void" ? "voided" : totalRefunded >= sale.totalCents ? "refunded" : "partially_refunded",
        voidedAt: kind === "void" ? now : sale.voidedAt,
        voidReason: kind === "void" ? reason : sale.voidReason,
      })
      .where(eq(sales.id, sale.id));
    await audit(actor, `sale.${kind}`, "sale", sale.id, { amountCents, reason, parts, tenders: plan.map((s) => ({ method: s.p.method, cents: s.cents })) }, sale.shopId, tx);
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
