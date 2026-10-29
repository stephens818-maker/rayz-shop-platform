import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx, Tx } from "@/db";
import {
  appointmentItems,
  appointments,
  cashDrawers,
  checkoutHandoffs,
  customers,
  giftCardLedger,
  giftCards,
  payments,
  products,
  promoCodes,
  refunds,
  saleItems,
  saleTipShares,
  sales,
  shopProducts,
  shops,
  staff,
  staffShops,
  Shop,
} from "@/db/schema";
import { TipSplitMode, splitBarbers, tipWeights } from "@/domain/handoff";
import { operational } from "@/domain/location-lifecycle";
import { FeeChannel, feeConfigFor } from "@/domain/card-fee-policy";
import {
  CardFeeConfig,
  CardFeeResult,
  LoyaltyBasis,
  CardFunding,
  CartLine,
  Discount,
  LineKind,
  TaxCategory,
  TaxRates,
  computeCheckout,
  feeLabel,
  manualDiscountProblem,
} from "@/domain/checkout";
import {
  StaffTip,
  cleanPayerLabel,
  perBarberTipProblem,
  planSplitTenders,
  splitTenderProblem,
} from "@/domain/combined-checkout";
import { CouponRule, couponDiscount, stackProblem } from "@/domain/coupons";
import { reloadProblem } from "@/domain/gift-cards";
import { membershipDiscounts } from "@/domain/memberships";
import { DEFAULT_LOYALTY, LoyaltyConfig, loyaltyAtShop } from "@/domain/loyalty";
import { giftCardCode } from "@/lib/ids";
import { flags } from "@/lib/flags";
import { formatCents } from "@/lib/money";
import { localDateOf, toZoned, todayLocal } from "@/lib/time";
import { Actor, SYSTEM, audit } from "./audit";
import { staffAtShopDenied } from "./auth/policy";
import { createAppointment, getAvailability } from "./booking";
import { getShop, shopCatalog } from "./catalog";
import { heldCoupons, redeemCoupons, resolveCoupon } from "./coupons";
import { checkoutCoverage, recordMembershipUse } from "./memberships";
import { AppError, forbidden, notFound } from "./errors";
import { postMovements } from "./inventory/ledger";
import { stockLevels } from "./inventory/stock";
import {
  appointmentLines,
  familyTicket,
  familyTicketFor,
  ticketAppointmentIds,
} from "./family-ticket";
import {
  accrueForSale,
  getLoyaltyConfig,
  loyaltyConfigAt,
  loadRedeemableReward,
  loyaltyShares,
  markRewardRedeemed,
} from "./loyalty";
import { assertReaderAt, chargeRoute } from "./payments/connect";
import {
  chargeCard,
  inspectPaymentMethod,
  refundCard,
} from "./payments/processor";
import { assertPromptsAnswered, settlePrompts } from "./checkout-prompts";
import { recordCheckout } from "./service-times";
import { syncTipLedger } from "./tips/ledger";
import { planSaleTransfers, recordDestinationTransfer, reverseUnrecordedTransfer, settleSale } from "./payments/settlement";
import { saleTransferGroup } from "@/domain/charge-split";
import { cashAwaiting, cashTipPayoutsCents } from "./tips/payouts";
import { defaultOpening, movesOutCents } from "./drawer";
import { saleFeeChannel, shopCardFeeConfig, shopFeePolicy } from "./payments/card-fee";

export {
  assignRefundLines,
  refundEverything,
  refundSale,
  refundableState,
  voidSale,
} from "./refunds";

export function pricingConfig(
  shop: Shop,
  loyalty: LoyaltyConfig = DEFAULT_LOYALTY,
  cardFee: CardFeeConfig = shopCardFeeConfig(shop),
): {
  taxRates: TaxRates;
  cardFee: CardFeeConfig;
  tipPresets: number[];
  loyalty: LoyaltyBasis;
} {
  return {
    loyalty: {
      on: loyaltyAtShop(loyalty, shop.id),
      includeProducts: loyalty.includeProducts,
      includeTips: loyalty.includeTips,
    },
    taxRates: {
      serviceRate: Number(shop.serviceTaxRate),
      productRate: Number(shop.productTaxRate),
    },
    cardFee,
    tipPresets: shop.tipPresets,
  };
}

/** Open (or reuse) the ticket for an appointment, pre-filled with its services. */
export async function openSaleForAppointment(
  appointmentId: string,
  actor: Actor,
  tx: DBorTx = db,
  o: { customerId?: string | null } = {},
) {
  const appt = await tx.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) throw notFound("Appointment");
  const existing = await tx.query.sales.findFirst({
    where: and(
      eq(sales.appointmentId, appointmentId),
      inArray(sales.status, ["open", "paid", "partially_refunded", "refunded"]),
    ),
  });
  if (existing) return existing;
  const shared = await familyTicketFor(appointmentId, tx);
  if (shared)
    return (await tx.query.sales.findFirst({ where: eq(sales.id, shared) }))!;
  if (["cancelled", "no_show"].includes(appt.status))
    throw new AppError("conflict", `Appointment is ${appt.status}`);
  await assertOpenForSales(appt.shopId);
  const [sale] = await tx
    .insert(sales)
    .values({
      shopId: appt.shopId,
      appointmentId,
      customerId: o.customerId ?? appt.customerId,
      staffId: appt.staffId,
      businessDate: todayLocal(),
      createdBy: actor.staffId ?? null,
    })
    .returning();
  // Checkout charges today's menu price, so the ticket opens with it rather than the booked estimate.
  await appointmentLines(sale.id, appt, tx);
  if (appt.status !== "in_service") {
    await tx
      .update(appointments)
      .set({
        status: "in_service",
        checkedInAt: appt.checkedInAt ?? new Date(),
      })
      .where(eq(appointments.id, appointmentId));
  }
  return sale;
}

async function assertOpenForSales(shopId: string) {
  const shop = await db.query.shops.findFirst({
    where: eq(shops.id, shopId),
    columns: { status: true },
  });
  if (!shop) throw notFound("Shop");
  if (!operational(shop))
    throw new AppError(
      "conflict",
      "This location is archived, so it can't take new tickets",
    );
}

export async function openBlankSale(
  shopId: string,
  actor: Actor,
  staffId: string | null = null,
) {
  await assertOpenForSales(shopId);
  const [sale] = await db
    .insert(sales)
    .values({
      shopId,
      staffId,
      businessDate: todayLocal(),
      createdBy: actor.staffId ?? null,
    })
    .returning();
  return sale;
}

export async function loadCheckoutContext(saleId: string) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const shop = await getShop(sale.shopId);
  const items = await db
    .select()
    .from(saleItems)
    .where(eq(saleItems.saleId, saleId))
    .orderBy(asc(saleItems.kind));
  const customer = sale.customerId
    ? await db.query.customers.findFirst({
        where: eq(customers.id, sale.customerId),
      })
    : null;
  const appt = sale.appointmentId
    ? await db.query.appointments.findFirst({
        where: eq(appointments.id, sale.appointmentId),
      })
    : null;
  const retail = await db
    .select({
      productId: products.id,
      name: products.name,
      brand: products.brand,
      priceCents: shopProducts.priceCents,
      stock: shopProducts.stock,
      taxCategory: products.taxCategory,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shop.id), eq(shopProducts.active, true)))
    .orderBy(asc(products.brand), asc(products.name));
  const barber = sale.staffId
    ? await db.query.staff.findFirst({ where: eq(staff.id, sale.staffId) })
    : null;
  // What other open tickets hold doesn't count as available here; this ticket's own hold does.
  const levels = await stockLevels([shop.id]);
  const own = new Map<string, number>();
  for (const i of items)
    if (i.kind === "product" && i.refId && sale.status === "open")
      own.set(i.refId, (own.get(i.refId) ?? 0) + i.qty);
  const withAvailable = retail.map((r) => {
    const l = levels.find((x) => x.productId === r.productId);
    return {
      ...r,
      available:
        r.stock -
        Math.max(0, (l?.committed ?? 0) - (own.get(r.productId) ?? 0)),
    };
  });
  const family = await familyTicket(sale);
  if (sale.status !== "open") family.candidates = [];
  const groupDeposit =
    sale.status === "open"
      ? await (
          await import("./booking-groups")
        ).depositForTicket(
          [
            sale.appointmentId,
            ...family.members.map((m) => m.appointmentId),
          ].filter((x): x is string => !!x),
        )
      : null;
  const feePolicy = await shopFeePolicy(shop.id);
  const feeChannel = await saleFeeChannel(sale.id, "pos");
  const { getCardFeeRate, getSalesTaxRate } = await import("./fee-tax-rates");
  const at = new Date();
  const [datedRate, datedTax] = await Promise.all([getCardFeeRate(shop.id, at), getSalesTaxRate(shop.id, at)]);
  const policyForFee = datedRate == null ? feePolicy.policy : { ...feePolicy.policy, rate: datedRate };
  const config = pricingConfig(shop, await loyaltyConfigAt(shop.id), feeConfigFor(policyForFee, feePolicy.state, feeChannel));
  config.taxRates = { serviceRate: datedTax.serviceRate, productRate: datedTax.productRate };
  return {
    sale,
    shop,
    items,
    customer,
    appointment: appt,
    retail: withAvailable,
    barber,
    family,
    groupDeposit,
    feePolicy,
    feeChannel,
    config,
    negativeStock: shop.negativeStock,
  };
}

/** A coupon code checked for this shop, before a client is known. */
export const validatePromo = (
  code: string,
  shopId: string,
  today = todayLocal(),
) => resolveCoupon(code, { shopId, today });

export async function lookupGiftCard(code: string) {
  const g = await db.query.giftCards.findFirst({
    where: eq(giftCards.code, code.trim().toUpperCase()),
  });
  if (!g || g.status !== "active")
    throw new AppError("bad_request", "Gift card not found");
  if (g.expiresAt && g.expiresAt < new Date())
    throw new AppError("bad_request", "Gift card has expired");
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
  /** Services and add-ons: the barber who did it, when it isn't the ticket's barber. Splits the tip. */
  staffId?: string | null;
  /** Family tickets: whose appointment the line is for. Defaults to the ticket's own appointment. */
  appointmentId?: string | null;
  /** A custom charge: a service line with no menu item, priced and named at the register (`name`, `unitPriceCents`). */
  custom?: boolean;
}

export const CUSTOM_CHARGE_MAX_CENTS = 100_000;

export type TenderInput =
  | { method: "cash"; cashTenderedCents?: number | null }
  | {
      method: "card";
      paymentMethodId: string;
      entryMode: "keyed" | "terminal";
      readerId?: string | null;
      /** App payments: the payer's platform-level Stripe Customer, for a saved card. */
      stripeCustomerId?: string | null;
      /** App payments: a 3-D Secure check comes back to the app instead of cancelling the charge. */
      onAction?: "cancel" | "return";
      /** App payments: the intent the app already confirmed with the bank. */
      confirmedIntentId?: string | null;
    }
  | { method: "none" };

/** One part of a split payment: cash or a card, the amount it pays before any surcharge, and who paid it. */
export type SplitTenderInput = Exclude<TenderInput, { method: "none" }> & {
  amountCents: number;
  /** One of the people on the ticket (or the ticket's client). */
  payerCustomerId?: string | null;
  /** Or a short name for someone else ("Grandma"). */
  payerLabel?: string | null;
};

export interface FinalizeInput {
  saleId: string;
  staffId?: string | null;
  lines: CheckoutLineInput[];
  promoCode?: string | null;
  /** More coupons on the same ticket, where they stack. */
  promoCodes?: string[] | null;
  manualDiscount?: {
    type: "percent" | "amount";
    value: number;
    reason: string;
  } | null;
  loyaltyRewardId?: string | null;
  /** A ticket client's membership: covers their plan's services in full and takes its retail discount. */
  membershipId?: string | null;
  tipCents: number;
  giftCard?: { code: string; amountCents: number } | null;
  tender: TenderInput;
  /** Two or more payments (cash, cards, each with its payer) for what's left after any gift card. Replaces `tender`. */
  tenders?: SplitTenderInput[] | null;
  /** tipSplit "per_barber": what each barber gets, adding up to tipCents. */
  tipByStaff?: StaffTip[] | null;
  /** Total the UI showed; refuse to charge if the server computes something different. */
  expectedTotalCents?: number | null;
  /** The appointments the UI showed on the ticket; refuse to charge if people were combined in or split off since. */
  ticketPeople?: string[] | null;
  rebookInWeeks?: number | null;
  /** With more than one barber on the services: split the tip by their services (the default) or evenly. */
  tipSplit?: TipSplitMode | null;
  /** The customer screen paying for its own ticket. Without it, a ticket that's with the client can't be paid. */
  handoffId?: string | null;
  /** Who paid, when it's one payment: the app's account holder (a child's ticket is the parent's to pay). */
  payerCustomerId?: string | null;
  /** More metadata on the card charge, e.g. the app payment it belongs to. */
  chargeMetadata?: Record<string, string>;
  /** Set by the caller from the signed-in person's permissions, never from the request body. */
  canOverridePrice?: boolean;
  /** Set like canOverridePrice: may ring up custom charges. */
  canCustomCharge?: boolean;
  /** Largest manual discount allowed, in whole percent of the ticket (gift cards excluded). Defaults to no limit. */
  maxManualDiscountPct?: number;
  /** Largest manual discount in cents, set like maxManualDiscountPct; null or missing is no dollar limit. */
  maxManualDiscountCents?: number | null;
  /** Largest card surcharge waiver in cents, set like canWaiveCardFee; null or missing is no limit. */
  maxCardFeeWaiverCents?: number | null;
  /** Where the charge is taken, for the card fee's channels. Defaults to pos; a booking deposit ticket is always deposit. */
  channel?: FeeChannel | null;
  /** Staff waive the credit card surcharge, with a reason. `byStaffId` is who waived it when that isn't the actor (a hand-off). */
  waiveCardFee?: { reason: string; byStaffId?: string | null } | null;
  /** Set like canOverridePrice: may waive the card surcharge. */
  canWaiveCardFee?: boolean;
  actor: Actor;
  now?: Date;
}

/**
 * Coupons and a loyalty reward apply to the combined ticket as a whole: a coupon held when booking
 * any of its appointments counts as the booking's, and a reward may come from anyone's card on it.
 */
async function buildDiscounts(
  input: Omit<FinalizeInput, "actor">,
  sale: {
    id: string;
    shopId: string;
    customerId: string | null;
    appointmentId: string | null;
  },
  lines: CartLine[],
  ticket: { appointmentIds: string[]; customerIds: string[] },
) {
  const discounts: Discount[] = [];
  const codes = [
    ...new Set(
      [input.promoCode, ...(input.promoCodes ?? [])]
        .filter((c): c is string => !!c?.trim())
        .map((c) => c.trim().toUpperCase()),
    ),
  ];
  const held = new Set(
    codes.length && ticket.appointmentIds.length
      ? (await heldCoupons(ticket.appointmentIds)).values()
      : [],
  );
  const coupons: CouponRule[] = [];
  const now = input.now ?? new Date();
  // A code held from online booking was checked against the appointment's time; checking out late doesn't lose it.
  const [first] = held.size
    ? await db
        .select({ at: appointments.startsAt })
        .from(appointments)
        .where(inArray(appointments.id, ticket.appointmentIds))
        .orderBy(appointments.startsAt)
        .limit(1)
    : [];
  for (const code of codes) {
    const at = held.has(code) && first ? first.at : now;
    const rule = await resolveCoupon(code, {
      shopId: sale.shopId,
      customerId: sale.customerId,
      saleId: sale.id,
      appointmentId: sale.appointmentId,
      today: todayLocal(now),
      at,
    });
    const promo = await db.query.promoCodes.findFirst({
      where: eq(promoCodes.id, rule.promoId),
      columns: { autoApply: true },
    });
    coupons.push({
      ...rule,
      via: held.has(code) ? "booking" : promo?.autoApply ? "auto" : "code",
    });
  }
  const manual = !!(input.manualDiscount && input.manualDiscount.value > 0);
  const stack = stackProblem(coupons, { manualDiscount: manual });
  if (stack) throw new AppError("bad_request", stack);
  for (const c of coupons) {
    const r = couponDiscount(c, lines);
    if (!r.discount)
      throw new AppError(
        "bad_request",
        r.problem ?? `${c.code} doesn't apply to this ticket`,
      );
    discounts.push(r.discount);
  }
  if (manual) {
    discounts.push({
      source: "manual",
      label: `Discount: ${input.manualDiscount!.reason || "manager"}`,
      type: input.manualDiscount!.type,
      value: input.manualDiscount!.value,
      appliesTo: "all",
    });
  }
  let rewardId: string | null = null;
  let rewardOwnerId: string | null = null;
  if (input.loyaltyRewardId) {
    const owners = [
      ...new Set(
        [sale.customerId, ...ticket.customerIds].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    if (!owners.length)
      throw new AppError(
        "bad_request",
        "Attach a client to use a loyalty reward",
      );
    const cfg = await getLoyaltyConfig();
    if (!loyaltyAtShop(cfg, sale.shopId))
      throw new AppError(
        "bad_request",
        "Loyalty rewards aren't used at this location",
      );
    if (coupons.length && !cfg.stackWithPromos)
      throw new AppError(
        "bad_request",
        "Loyalty rewards can't be combined with promo codes",
      );
    let r: Awaited<ReturnType<typeof loadRedeemableReward>> | null = null;
    for (const who of owners) {
      r = await loadRedeemableReward(db, who, input.loyaltyRewardId).catch(
        () => null,
      );
      if (r) break;
    }
    if (!r) throw new AppError("bad_request", "That reward isn't available");
    discounts.push({
      source: "loyalty",
      label: "Loyalty reward",
      type: "amount",
      value: r.amountCents,
      appliesTo: cfg.redeemableOn === "services" ? "services" : "all",
      refId: r.id,
    });
    rewardId = r.id;
    rewardOwnerId = r.customerId;
  }
  return { discounts, coupons, rewardId, rewardOwnerId };
}

export interface PricedLineMeta {
  catalogPriceCents: number | null;
  overrideReason: string | null;
  custom?: boolean;
  appointmentId: string | null;
}

/**
 * Server-authoritative pricing. Services and add-ons come from the shop's menu and products from its
 * inventory; the client only says what's on the ticket. Gift cards carry the face value being sold.
 */
export async function priceCart(
  input: Omit<FinalizeInput, "actor">,
  funding: CardFunding | null,
  card: { wallet?: boolean | string | null } = {},
) {
  const ctx = await loadCheckoutContext(input.saleId);
  const gift = input.giftCard?.code
    ? await lookupGiftCard(input.giftCard.code)
    : null;

  const menu = await shopCatalog(ctx.shop.id);
  const productIds = input.lines
    .filter((l) => l.kind === "product" && l.refId)
    .map((l) => l.refId!) as string[];
  const inv = productIds.length
    ? await db
        .select({
          productId: shopProducts.productId,
          priceCents: shopProducts.priceCents,
          stock: shopProducts.stock,
          name: products.name,
          brand: products.brand,
          taxCategory: products.taxCategory,
        })
        .from(shopProducts)
        .innerJoin(products, eq(products.id, shopProducts.productId))
        .where(
          and(
            eq(shopProducts.shopId, ctx.shop.id),
            eq(shopProducts.active, true),
            inArray(shopProducts.productId, productIds),
          ),
        )
    : [];
  const reloadIds = input.lines.filter((l) => l.kind === "gift_card" && l.refId).map((l) => l.refId!);
  const reloadCards = reloadIds.length ? await db.select().from(giftCards).where(inArray(giftCards.id, reloadIds)) : [];
  const staffId = input.staffId ?? ctx.sale.staffId;
  const onTicket = new Map<string, string | null>(
    ctx.family.members.map((m) => [m.appointmentId, m.staffId]),
  );
  for (const l of input.lines) {
    if (
      l.appointmentId &&
      l.appointmentId !== ctx.sale.appointmentId &&
      !onTicket.has(l.appointmentId)
    )
      throw new AppError(
        "bad_request",
        "A line is for an appointment that isn't on this ticket",
      );
  }
  const lineStaff = (l: CheckoutLineInput) =>
    l.staffId ?? (l.appointmentId && onTicket.get(l.appointmentId)) ?? staffId;
  for (const id of new Set(
    input.lines
      .filter(
        (l) =>
          l.kind !== "product" &&
          l.kind !== "gift_card" &&
          l.staffId &&
          l.staffId !== staffId,
      )
      .map((l) => l.staffId!),
  )) {
    await assertStaffAtShop(id, ctx.shop.id);
  }
  const meta: PricedLineMeta[] = [];
  const lines: CartLine[] = input.lines.map((l, i) => {
    if (l.qty <= 0 || !Number.isInteger(l.qty))
      throw new AppError("bad_request", "Quantities must be whole numbers");
    let name: string;
    let catalog: number;
    let taxCategory: TaxCategory;
    if (l.custom) {
      if (!input.canCustomCharge) throw forbidden("You don't have permission to ring up a custom charge");
      const label = l.name?.trim().slice(0, 80);
      const cents = l.unitPriceCents ?? 0;
      if (l.kind !== "service") throw new AppError("bad_request", "A custom charge is a service line");
      if (!label) throw new AppError("bad_request", "Say what the custom charge is for");
      if (!Number.isInteger(cents) || cents < 1 || cents > CUSTOM_CHARGE_MAX_CENTS)
        throw new AppError("bad_request", `Custom charges are from $0.01 to ${formatCents(CUSTOM_CHARGE_MAX_CENTS)}`);
      if (l.priceOverride) throw new AppError("bad_request", "A custom charge is priced as it's rung up");
      meta.push({ catalogPriceCents: null, overrideReason: null, appointmentId: l.appointmentId ?? ctx.sale.appointmentId, custom: true });
      return { key: String(i), kind: "service", name: label, unitPriceCents: cents, qty: l.qty, refId: null, staffId: lineStaff(l), taxCategory: "service" };
    }
    if (l.kind === "service" || l.kind === "addon") {
      const s = l.refId
        ? menu.find((x) => x.id === l.refId && x.kind === l.kind)
        : null;
      if (!s)
        throw new AppError(
          "bad_request",
          `${l.name ?? "That service"} isn't on the ${ctx.shop.name} menu`,
        );
      name = s.name;
      catalog = s.priceCents;
      taxCategory = s.taxCategory;
    } else if (l.kind === "product") {
      const p = inv.find((x) => x.productId === l.refId);
      if (!p)
        throw new AppError(
          "bad_request",
          `${l.name ?? "That product"} isn't stocked at this shop`,
        );
      name = `${p.brand} ${p.name}`;
      catalog = p.priceCents;
      taxCategory = p.taxCategory;
    } else {
      const face = l.unitPriceCents ?? 0;
      if (
        !Number.isInteger(face) ||
        face < GIFT_CARD_MIN_CENTS ||
        face > GIFT_CARD_MAX_CENTS
      ) {
        throw new AppError(
          "bad_request",
          `Gift cards are sold from ${formatCents(GIFT_CARD_MIN_CENTS)} to ${formatCents(GIFT_CARD_MAX_CENTS)}`,
        );
      }
      if (l.priceOverride)
        throw new AppError("bad_request", "A gift card's price is its value");
      meta.push({
        catalogPriceCents: null,
        overrideReason: null,
        appointmentId: null,
      });
      if (l.refId) {
        const g = reloadCards.find((c) => c.id === l.refId);
        const problem = reloadProblem(g, { qty: l.qty, now: input.now ?? new Date(), payingWith: gift?.id ?? null, amountCents: face });
        if (problem) throw new AppError("bad_request", problem);
        return { key: String(i), kind: l.kind, name: `Gift card reload ${g!.code} ${formatCents(face)}`, unitPriceCents: face, qty: 1, refId: g!.id };
      }
      return {
        key: String(i),
        kind: l.kind,
        name: `Gift card ${formatCents(face)}`,
        unitPriceCents: face,
        qty: l.qty,
        refId: null,
      };
    }
    let unit = catalog;
    let reason: string | null = null;
    const o = l.priceOverride;
    if (o && o.unitPriceCents !== catalog) {
      if (!input.canOverridePrice)
        throw forbidden("You don't have permission to change prices");
      if (!Number.isInteger(o.unitPriceCents) || o.unitPriceCents < 0)
        throw new AppError(
          "bad_request",
          "Prices must be whole cents and not negative",
        );
      if (!o.reason?.trim())
        throw new AppError(
          "bad_request",
          `Add a reason for changing the price of ${name}`,
        );
      unit = o.unitPriceCents;
      reason = o.reason.trim();
    }
    meta.push({
      catalogPriceCents: catalog,
      overrideReason: reason,
      appointmentId:
        l.appointmentId ??
        (l.kind === "product" ? null : ctx.sale.appointmentId),
    });
    return {
      key: String(i),
      kind: l.kind,
      name,
      unitPriceCents: unit,
      qty: l.qty,
      refId: l.refId ?? null,
      staffId: l.kind === "product" ? null : lineStaff(l),
      taxCategory,
    };
  });
  const problem = manualDiscountProblem(
    input.manualDiscount ?? null,
    lines,
    input.maxManualDiscountPct ?? 100,
    input.maxManualDiscountCents ?? null,
  );
  if (problem) throw forbidden(problem);
  const { discounts, coupons, rewardId, rewardOwnerId } = await buildDiscounts(
    input,
    ctx.sale,
    lines,
    {
      appointmentIds: [
        ctx.sale.appointmentId,
        ...ctx.family.members.map((m) => m.appointmentId),
      ].filter((x): x is string => !!x),
      customerIds: [
        ctx.appointment?.customerId,
        ...ctx.family.members.map((m) => m.customerId),
      ].filter((x): x is string => !!x),
    },
  );

  let membershipUse: { membershipId: string; periodStart: string; visits: number } | null = null;
  if (input.membershipId) {
    const customerOf = new Map<string, string | null>(ctx.family.members.map((m) => [m.appointmentId, m.customerId]));
    if (ctx.appointment) customerOf.set(ctx.appointment.id, ctx.appointment.customerId);
    const onTicket = [ctx.sale.customerId, ...customerOf.values()].filter((x): x is string => !!x);
    const coverage = (await checkoutCoverage(onTicket, ctx.shop.id)).find((c) => c.membershipId === input.membershipId);
    if (!coverage) throw new AppError("bad_request", "That membership can't be used on this ticket");
    const r = membershipDiscounts(
      coverage,
      lines.map((l, i) => ({ ...l, forCustomerId: (meta[i].appointmentId && customerOf.get(meta[i].appointmentId!)) || ctx.sale.customerId })),
    );
    if (!r.discounts.length) throw new AppError("bad_request", `${coverage.planName} doesn't cover anything on this ticket${coverage.visitsLeft === 0 ? ": no visits left this month" : ""}`);
    discounts.push(...r.discounts);
    membershipUse = { membershipId: coverage.membershipId, periodStart: coverage.periodStart, visits: r.visits };
  }

  const channel: FeeChannel = ctx.feeChannel === "deposit" ? "deposit" : (input.channel ?? "pos");
  const cardFee = channel === ctx.feeChannel ? ctx.config.cardFee : feeConfigFor({ ...ctx.feePolicy.policy, rate: ctx.config.cardFee.rate }, ctx.feePolicy.state, channel);
  const waive = input.waiveCardFee ?? null;
  if (waive) {
    if (!input.canWaiveCardFee) throw forbidden("You don't have permission to waive the card surcharge");
    if (cardFee.waiverAllowed === false) throw new AppError("forbidden", "The brand doesn't allow waiving the card surcharge", { reason: "waiver_not_allowed" });
    if (!waive.reason?.trim()) throw new AppError("bad_request", "Add a reason for waiving the card surcharge", { field: "waiveCardFee.reason" });
  }
  const totals = computeCheckout({
    lines,
    discounts,
    taxRates: ctx.config.taxRates,
    tipCents: input.tipCents,
    cardFee,
    cardFeeTaxable: ctx.feePolicy.policy.cardFeeTaxable,
    loyalty: ctx.config.loyalty,
    tender: {
      method: input.tender.method,
      cardFunding: funding,
      cardWallet: card.wallet ?? null,
      walletFeeOn: flags.walletFee(),
      waiveFee: !!waive,
      giftCardCents: gift ? input.giftCard!.amountCents : 0,
      giftCardBalanceCents: gift?.balanceCents ?? 0,
    },
  });
  const used = coupons.map((rule) => ({
    rule,
    discountCents:
      totals.discountBreakdown.find(
        (d) => d.source === "promo" && d.refId === rule.promoId,
      )?.cents ?? 0,
  }));
  const idle = used.find((u) => u.discountCents <= 0);
  if (idle)
    throw new AppError(
      "bad_request",
      `${idle.rule.code} doesn't take anything off this ticket`,
    );
  return {
    ctx,
    totals,
    cardFee,
    channel,
    promoId: coupons[0]?.promoId ?? null,
    coupons: used,
    rewardId,
    rewardOwnerId,
    gift,
    inv,
    meta,
    membershipUse,
  };
}

export async function finalizeSale(input: FinalizeInput) {
  const now = input.now ?? new Date();
  const pre = await loadCheckoutContext(input.saleId);
  if (pre.sale.status !== "open")
    throw new AppError(
      "conflict",
      pre.sale.mergedIntoSaleId
        ? "This ticket was combined into another one"
        : `Sale is already ${pre.sale.status}`,
    );
  if (input.lines.length === 0)
    throw new AppError("bad_request", "Add at least one item");
  if (!Number.isInteger(input.tipCents) || input.tipCents < 0)
    throw new AppError("bad_request", "Tip must be zero or more");
  const staffId = input.staffId ?? pre.sale.staffId;
  if (staffId && staffId !== pre.sale.staffId)
    await assertStaffAtShop(staffId, pre.shop.id);
  const split = input.tenders?.length ? input.tenders : null;
  if (split && input.handoffId)
    throw new AppError(
      "bad_request",
      "Split payments are taken at the counter",
    );
  // The customer screen was only handed over once they were answered.
  if (!input.handoffId) await assertPromptsAnswered(pre.sale.id, now);

  let card: Awaited<ReturnType<typeof inspectPaymentMethod>> | null = null;
  if (!split && input.tender.method === "card")
    card = await inspectPaymentMethod(input.tender.paymentMethodId);
  const splitCards = split
    ? await Promise.all(
        split.map((t) =>
          t.method === "card" ? inspectPaymentMethod(t.paymentMethodId) : null,
        ),
      )
    : [];
  const priced = await priceCart(
    split ? { ...input, tender: { method: "cash" } } : input,
    card?.funding ?? null,
    { wallet: card?.wallet ?? null },
  );
  const { ctx, promoId, coupons, rewardId, rewardOwnerId, gift, meta, membershipUse, cardFee, channel } = priced;
  let totals = priced.totals;
  const people = new Map<string, string>(
    ctx.family.members.flatMap((m) =>
      m.customerId ? [[m.appointmentId, m.customerId] as [string, string]] : [],
    ),
  );
  if (ctx.appointment?.customerId)
    people.set(ctx.appointment.id, ctx.appointment.customerId);
  const personOf = (appointmentId: string | null) =>
    (appointmentId && people.get(appointmentId)) || ctx.sale.customerId!;

  // Each payment of a split carries its own part of the tip and, on a credit card, its own surcharge.
  const legs: Leg[] = [];
  if (split) {
    const parts = split.map((t, i) => ({
      key: String(i),
      method: t.method,
      amountCents: t.amountCents,
      funding: splitCards[i]?.funding ?? null,
      wallet: splitCards[i]?.wallet ?? null,
    }));
    const problem = splitTenderProblem(totals.primaryBaseCents, parts);
    if (problem) throw new AppError("bad_request", problem);
    const plan = planSplitTenders({
      tipCents: Math.min(totals.tipCents, totals.primaryBaseCents),
      cardFee,
      tenders: parts,
      walletFeeOn: flags.walletFee(),
      waive: !!input.waiveCardFee,
    });
    const payers = new Set(
      [ctx.sale.customerId, ...people.values()].filter((x): x is string => !!x),
    );
    for (const [i, t] of split.entries()) {
      if (t.payerCustomerId && !payers.has(t.payerCustomerId))
        throw new AppError("bad_request", "A payer isn't on this ticket");
      const p = plan.parts[i];
      legs.push({
        tender: t,
        chargeCents: p.chargeCents,
        tipCents: p.tipCents,
        feeCents: p.feeCents,
        fee: p.fee,
        funding: splitCards[i]?.funding ?? null,
        payerCustomerId: t.payerCustomerId ?? null,
        payerLabel: t.payerCustomerId ? null : cleanPayerLabel(t.payerLabel),
      });
    }
    const disclosures = [...totals.disclosures];
    if (plan.cardFeeCents > 0)
      disclosures.push(
        `${feeLabel(cardFee)}: ${formatCents(plan.cardFeeCents)}`,
      );
    totals = {
      ...totals,
      cardFeeCents: plan.cardFeeCents,
      cardFeeBaseCents: plan.cardFeeBaseCents,
      cardFeeWaivedCents: plan.cardFeeWaivedCents,
      totalCents: totals.preFeeTotalCents + plan.cardFeeCents,
      primaryChargeCents: plan.chargeCents,
      disclosures,
    };
  } else if (totals.primaryChargeCents > 0 && input.tender.method !== "none") {
    legs.push({
      tender: input.tender,
      chargeCents: totals.primaryChargeCents,
      tipCents: Math.min(totals.tipCents, totals.primaryBaseCents),
      feeCents: totals.cardFeeCents,
      fee: input.tender.method === "card" ? totals.cardFee : null,
      funding: card?.funding ?? null,
      payerCustomerId: input.payerCustomerId ?? null,
      payerLabel: null,
    });
  }
  const waivedCents = legs.reduce((a, l) => a + (l.fee?.waivedCents ?? 0), 0);
  if (input.maxCardFeeWaiverCents != null && waivedCents > input.maxCardFeeWaiverCents)
    throw new AppError("forbidden", `This waives ${formatCents(waivedCents)} of card surcharge, above your ${formatCents(input.maxCardFeeWaiverCents)} limit`, { reason: "waiver_over_limit" });

  if (
    input.expectedTotalCents != null &&
    input.expectedTotalCents !== totals.totalCents
  ) {
    throw new AppError(
      "conflict",
      "Totals changed — please review the ticket again",
      { totalCents: totals.totalCents },
    );
  }
  const rewardCents =
    totals.discountBreakdown.find((d) => d.source === "loyalty")?.cents ?? 0;
  if (rewardId && rewardCents <= 0) {
    throw new AppError(
      "bad_request",
      "The loyalty reward doesn't apply to anything on this ticket, so it wasn't used",
    );
  }
  if (!split && input.tender.method === "none" && totals.primaryBaseCents > 0)
    throw new AppError(
      "bad_request",
      "Choose cash or card for the remaining balance",
    );
  for (const l of legs) {
    if (
      l.tender.method === "cash" &&
      l.tender.cashTenderedCents != null &&
      l.tender.cashTenderedCents < l.chargeCents
    )
      throw new AppError(
        "bad_request",
        "Cash tendered is less than the amount due",
      );
  }
  const serviceBarbers = [
    ...new Set(
      totals.lines
        .filter(
          (l) => (l.kind === "service" || l.kind === "addon") && l.staffId,
        )
        .map((l) => l.staffId!),
    ),
  ];
  if (
    input.tipSplit === "per_barber" &&
    splitBarbers(totals.lines, staffId).length
  ) {
    const problem = perBarberTipProblem(
      input.tipByStaff ?? [],
      serviceBarbers,
      totals.tipCents,
    );
    if (problem) throw new AppError("bad_request", problem);
  }
  // Card charges settle where the shop's payments mode says: the brand's account or the shop's own. A cash-only shop, or one not set up yet, takes cash or gift cards.
  for (const l of legs) {
    if (l.tender.method !== "card") continue;
    l.route = await chargeRoute(
      ctx.shop,
      l.chargeCents,
      l.tender.entryMode === "terminal" ? "terminal" : "keyed",
    );
    l.reader =
      l.tender.entryMode === "terminal" && l.tender.readerId
        ? await assertReaderAt(ctx.shop.id, l.tender.readerId)
        : null;
  }
  const ticketPeopleThen = (
    input.ticketPeople ?? [
      ctx.sale.appointmentId,
      ...ctx.family.members.map((m) => m.appointmentId),
    ]
  )
    .filter((x): x is string => !!x)
    .sort()
    .join(",");

  const businessDate = localDateOf(now);
  const issuedGiftCards: { code: string; amountCents: number }[] = [];
  const reloadedGiftCards: { code: string; amountCents: number; balanceCents: number }[] = [];
  const stockWarnings: string[] = [];
  let rewardsIssued = 0;
  // Only this call's own charges are ever compensated. Each attempt gets its own idempotency keys, so a
  // concurrent submit can never be handed (and then refund) the charge that won.
  const attempt = randomUUID();
  try {
    await db.transaction(async (tx: Tx) => {
      // A second submit of this ticket waits here, then sees it paid and stops before charging.
      const [locked] = await tx
        .select()
        .from(sales)
        .where(eq(sales.id, ctx.sale.id))
        .for("update");
      if (locked.status !== "open")
        throw new AppError(
          "conflict",
          locked.mergedIntoSaleId
            ? "This ticket was combined into another one"
            : "This ticket was already paid",
        );
      // Combined or split while this was being priced: the lines charged would no longer match the people on it.
      const ticketPeopleNow = [
        locked.appointmentId,
        ...(await ticketAppointmentIds(ctx.sale.id, tx)),
      ]
        .filter((x): x is string => !!x)
        .sort()
        .join(",");
      if (ticketPeopleNow !== ticketPeopleThen)
        throw new AppError(
          "conflict",
          "Someone was added to or taken off this ticket. Review it again.",
        );
      const [withClient] = await tx
        .select({ id: checkoutHandoffs.id })
        .from(checkoutHandoffs)
        .where(
          and(
            eq(checkoutHandoffs.saleId, ctx.sale.id),
            eq(checkoutHandoffs.status, "active"),
          ),
        );
      if (withClient && withClient.id !== input.handoffId)
        throw new AppError(
          "conflict",
          "This ticket is with the client on the customer screen. Take it back there, or end the hand-off, first.",
        );
      if (input.handoffId && !withClient)
        throw new AppError(
          "conflict",
          "Staff took this ticket back, so it can't be paid here",
        );

      await tx.delete(saleItems).where(eq(saleItems.saleId, ctx.sale.id));
      const items = await tx
        .insert(saleItems)
        .values(
          totals.lines.map((l, i) => ({
            saleId: ctx.sale.id,
            kind: l.kind,
            refId: l.refId ?? null,
            name: l.name,
            staffId:
              l.kind === "service" || l.kind === "addon"
                ? (l.staffId ?? staffId)
                : null,
            qty: l.qty,
            unitPriceCents: l.unitPriceCents,
            grossCents: l.grossCents,
            discountCents: l.discountCents,
            netCents: l.netCents,
            taxCents: l.taxCents,
            catalogPriceCents: meta[i].catalogPriceCents,
            overrideReason: meta[i].overrideReason,
            appointmentId: meta[i].appointmentId,
          })),
        )
        .returning({ id: saleItems.id });

      if (splitBarbers(totals.lines, staffId).length) {
        const mode = input.tipSplit ?? "services";
        const weights = tipWeights(totals.lines, mode, input.tipByStaff);
        await tx
          .insert(saleTipShares)
          .values(
            weights.map((w) => ({
              saleId: ctx.sale.id,
              staffId: w.staffId,
              weight: w.weight,
            })),
          );
        await audit(
          input.actor,
          "sale.tip_split",
          "sale",
          ctx.sale.id,
          { mode, shares: weights },
          ctx.shop.id,
          tx,
        );
      }

      for (const [i, l] of totals.lines.entries()) {
        if (meta[i].overrideReason) {
          await audit(
            input.actor,
            "sale.price_override",
            "sale",
            ctx.sale.id,
            {
              item: l.name,
              catalogPriceCents: meta[i].catalogPriceCents,
              chargedCents: l.unitPriceCents,
              qty: l.qty,
              reason: meta[i].overrideReason,
            },
            ctx.shop.id,
            tx,
          );
        }
        if (meta[i].custom)
          await audit(input.actor, "sale.custom_charge", "sale", ctx.sale.id, { item: l.name, chargedCents: l.unitPriceCents, qty: l.qty }, ctx.shop.id, tx);
        if (l.kind !== "gift_card") continue;
        if (l.refId) {
          const [g] = await tx
            .update(giftCards)
            .set({ balanceCents: sql`${giftCards.balanceCents} + ${l.unitPriceCents}` })
            .where(and(eq(giftCards.id, l.refId), eq(giftCards.status, "active")))
            .returning();
          if (!g) throw new AppError("conflict", "That gift card was voided before the reload went through");
          await tx.insert(giftCardLedger).values({ giftCardId: g.id, saleId: ctx.sale.id, deltaCents: l.unitPriceCents, kind: "reload", staffId: input.actor.staffId ?? null });
          await audit(input.actor, "giftcard.reload", "gift_card", g.id, { amountCents: l.unitPriceCents, balanceCents: g.balanceCents, saleId: ctx.sale.id }, ctx.shop.id, tx);
          reloadedGiftCards.push({ code: g.code, amountCents: l.unitPriceCents, balanceCents: g.balanceCents });
          continue;
        }
        for (let q = 0; q < l.qty; q++) {
          const code = giftCardCode();
          const [g] = await tx
            .insert(giftCards)
            .values({
              code,
              initialCents: l.unitPriceCents,
              balanceCents: l.unitPriceCents,
              issuedShopId: ctx.shop.id,
              customerId: ctx.sale.customerId,
              source: "sold",
              saleItemId: items[i].id,
            })
            .returning();
          await tx
            .insert(giftCardLedger)
            .values({
              giftCardId: g.id,
              saleId: ctx.sale.id,
              deltaCents: l.unitPriceCents,
              kind: "issue",
              staffId: input.actor.staffId ?? null,
            });
          issuedGiftCards.push({ code, amountCents: l.unitPriceCents });
        }
      }

      if (gift && totals.giftCardAppliedCents > 0) {
        const res = await tx
          .update(giftCards)
          .set({
            balanceCents: sql`${giftCards.balanceCents} - ${totals.giftCardAppliedCents}`,
          })
          .where(
            and(
              eq(giftCards.id, gift.id),
              eq(giftCards.status, "active"),
              sql`${giftCards.balanceCents} >= ${totals.giftCardAppliedCents}`,
            ),
          )
          .returning({ id: giftCards.id });
        if (!res.length)
          throw new AppError(
            "conflict",
            "Gift card balance changed — apply it again",
          );
        await tx
          .insert(giftCardLedger)
          .values({
            giftCardId: gift.id,
            saleId: ctx.sale.id,
            deltaCents: -totals.giftCardAppliedCents,
            kind: "redeem",
            staffId: input.actor.staffId ?? null,
          });
      }

      const sold = new Map<string, number>();
      for (const l of totals.lines.filter((x) => x.kind === "product"))
        sold.set(l.refId!, (sold.get(l.refId!) ?? 0) + l.qty);
      const stock = await postMovements(
        tx,
        [...sold].map(([productId, qty]) => ({
          shopId: ctx.shop.id,
          productId,
          delta: -qty,
          kind: "sale" as const,
          saleId: ctx.sale.id,
        })),
        {
          actor: input.actor,
          at: input.now,
          audit: {
            action: "inventory.sale",
            entity: "sale",
            entityId: ctx.sale.id,
          },
        },
      );
      stockWarnings.push(...stock.warnings);

      if (coupons.length)
        await redeemCoupons(tx, coupons, { ...ctx.sale, staffId }, now);
      if (membershipUse) {
        await recordMembershipUse(
          tx,
          {
            ...membershipUse,
            saleId: ctx.sale.id,
            shopId: ctx.shop.id,
            valueCents: totals.discountBreakdown.filter((d) => d.source === "membership").reduce((a, d) => a + d.cents, 0),
          },
          input.actor,
        );
      }
      if (rewardId && rewardOwnerId)
        await markRewardRedeemed(
          tx,
          rewardId,
          ctx.sale.id,
          rewardOwnerId,
          rewardCents,
          now,
        );
      if (ctx.sale.customerId && totals.loyaltyEligibleCents > 0) {
        const shares = await loyaltyShares(
          tx,
          ctx.sale.customerId,
          totals.loyaltyEligibleCents,
          totals.lines.flatMap((l, i) =>
            l.kind === "service" || l.kind === "addon"
              ? [
                  {
                    customerId: personOf(meta[i].appointmentId),
                    netCents: l.netCents,
                  },
                ]
              : [],
          ),
        );
        for (const sh of shares)
          rewardsIssued += await accrueForSale(
            tx,
            sh.customerId,
            ctx.sale.id,
            sh.cents,
            now,
            ctx.sale.shopId,
          );
      }

      // Everything that can fail on our side has run. Charge last, while still holding the lock; a
      // declined second card undoes the first (the catch below).
      for (const [i, l] of legs.entries()) {
        if (l.tender.method !== "card" || l.chargeCents <= 0) continue;
        l.charge = await chargeCard({
          paymentMethodId: l.tender.paymentMethodId,
          amountCents: l.chargeCents,
          description: `Ray'z ${ctx.shop.name} ticket #${ctx.sale.number}${split ? ` (payment ${i + 1} of ${legs.length})` : ""}`,
          metadata: {
            ...input.chargeMetadata,
            saleId: ctx.sale.id,
            shop: ctx.shop.slug,
            cardFeeCents: String(l.feeCents),
            cardFeeRate: String(cardFee.rate),
            cardFeeLabel: (cardFee.name?.trim() || "Credit card fee").slice(0, 40),
            salesTaxCents: String(totals.taxCents),
            taxRateBps: String(Math.round(ctx.config.taxRates.serviceRate * 10_000)),
            attempt,
          },
          idempotencyKey: split
            ? `sale-${ctx.sale.id}-${attempt}-${i}`
            : `sale-${ctx.sale.id}-${attempt}`,
          destination: l.route?.destination ?? null,
          transferGroup: saleTransferGroup(ctx.sale.id),
          statementDescriptorSuffix: l.route?.descriptorSuffix ?? null,
          customerId: l.tender.stripeCustomerId ?? null,
          surchargeCents: l.feeCents,
          onAction: l.tender.onAction ?? "cancel",
          confirmedIntentId: l.tender.confirmedIntentId ?? null,
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
      for (const l of legs) {
        const c = l.charge ?? null;
        const [paid] = await tx.insert(payments).values({
          saleId: ctx.sale.id,
          shopId: ctx.shop.id,
          businessDate,
          method: l.tender.method,
          status: "succeeded",
          amountCents: l.chargeCents,
          tipCents: l.tipCents,
          cardFeeCents: l.feeCents,
          ...(l.tender.method === "card" && l.fee
            ? {
                feeRate: l.fee.rate.toFixed(5),
                feeFlatCents: l.fee.flatCents,
                feeBasis: l.fee.basis,
                feeBasisCents: l.fee.basisCents,
                feeReason: l.fee.reason,
                feeChannel: channel,
                ...(l.fee.waivedCents > 0
                  ? {
                      feeWaived: true,
                      feeWaivedCents: l.fee.waivedCents,
                      feeWaivedBy: input.waiveCardFee?.byStaffId ?? input.actor.staffId ?? null,
                      feeWaivedReason: input.waiveCardFee!.reason.trim().slice(0, 200),
                    }
                  : {}),
              }
            : {}),
          cashTenderedCents:
            l.tender.method === "cash"
              ? (l.tender.cashTenderedCents ?? l.chargeCents)
              : null,
          processor: c
            ? l.tender.method === "card" && l.tender.entryMode === "terminal"
              ? `${c.processor}_terminal`
              : c.processor
            : null,
          stripePaymentIntentId: c?.paymentIntentId ?? null,
          cardBrand: c?.card.brand ?? null,
          cardLast4: c?.card.last4 ?? null,
          cardFunding: c?.card.funding ?? null,
          entryMode: l.tender.method === "card" ? l.tender.entryMode : null,
          stripeAccountId: c?.destination?.accountId ?? null,
          applicationFeeCents: c?.destination?.applicationFeeCents ?? 0,
          processorFeeCents: c
            ? (c.processorFeeCents ??
              (l.route?.settlement === "platform"
                ? l.route.estimatedFeeCents
                : null))
            : null,
          stripeChargeId: c?.chargeId ?? null,
          settlement: c ? (c.destination ? "connected" : "platform") : null,
          chargeType: c ? (c.transferId ? "destination" : "separate") : null,
          transferGroup: c ? saleTransferGroup(ctx.sale.id) : null,
          terminalReaderId: c ? (l.reader?.id ?? null) : null,
          payerCustomerId: l.payerCustomerId,
          payerLabel: l.payerLabel,
        }).returning({ id: payments.id });
        if (c?.transferId && c.destination)
          await recordDestinationTransfer(tx, {
            paymentId: paid.id,
            saleId: ctx.sale.id,
            shopId: ctx.shop.id,
            accountId: c.destination.accountId,
            amountCents: l.chargeCents,
            feeCents: c.destination.applicationFeeCents,
            transferId: c.transferId,
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
          cardFeeWaivedCents: waivedCents,
          totalCents: totals.totalCents,
          promoCodeId: promoId,
          loyaltyEarnedCents: ctx.sale.customerId
            ? totals.loyaltyEligibleCents
            : 0,
          pricing: {
            ...ctx.config,
            cardFee,
            salesTaxCents: totals.taxCents,
            taxRateBps: Math.round(ctx.config.taxRates.serviceRate * 10_000),
            productTaxRateBps: Math.round(ctx.config.taxRates.productRate * 10_000),
            feeChannel: channel,
            ...(waivedCents > 0 ? { cardFeeWaived: { cents: waivedCents, reason: input.waiveCardFee!.reason.trim().slice(0, 200) } } : {}),
            discounts: totals.discountBreakdown,
            disclosures: totals.disclosures,
            cardFunding: card?.funding ?? null,
            ...(card?.wallet ? { cardWallet: card.wallet } : {}),
            ...(split
              ? {
                  split: legs.map((l) => ({
                    method: l.tender.method,
                    cents: l.chargeCents,
                    tipCents: l.tipCents,
                    feeCents: l.feeCents,
                    funding: l.funding,
                  })),
                }
              : {}),
            ...(input.tipSplit === "per_barber" && input.tipByStaff?.length
              ? { tipByStaff: input.tipByStaff }
              : {}),
          },
          paidAt: now,
        })
        .where(eq(sales.id, ctx.sale.id));

      for (const appointmentId of [
        ctx.sale.appointmentId,
        ...(await ticketAppointmentIds(ctx.sale.id, tx)),
      ]) {
        if (!appointmentId) continue;
        await tx
          .update(appointments)
          .set({ status: "completed", completedAt: now })
          .where(eq(appointments.id, appointmentId));
        await recordCheckout(appointmentId, input.actor, tx, now);
      }
      await audit(
        input.actor,
        "sale.paid",
        "sale",
        ctx.sale.id,
        {
          totalCents: totals.totalCents,
          tipCents: totals.tipCents,
          method: split ? "split" : input.tender.method,
          cardFunding: card?.funding ?? null,
          cardFeeCents: totals.cardFeeCents,
          discounts: totals.discountBreakdown,
          ...(split
            ? {
                tenders: legs.map((l) => ({
                  method: l.tender.method,
                  cents: l.chargeCents,
                  payer: l.payerCustomerId ?? l.payerLabel,
                })),
              }
            : {}),
        },
        ctx.shop.id,
        tx,
      );
      if (waivedCents > 0) {
        await audit(
          input.actor,
          "sale.card_fee_waived",
          "sale",
          ctx.sale.id,
          { waivedCents, reason: input.waiveCardFee!.reason.trim().slice(0, 200), waivedBy: input.waiveCardFee?.byStaffId ?? input.actor.staffId ?? null, channel },
          ctx.shop.id,
          tx,
        );
      }
      if (input.manualDiscount && input.manualDiscount.value > 0) {
        await audit(
          input.actor,
          "sale.discount",
          "sale",
          ctx.sale.id,
          input.manualDiscount,
          ctx.shop.id,
          tx,
        );
      }
      await syncTipLedger(tx, { saleId: ctx.sale.id });
      await planSaleTransfers(tx, ctx.sale.id);
      await (await import("./booking-groups")).onSalePaid(ctx.sale.id, tx);
      // The customer screen asks the client itself; at the counter, a standing choice answers for them.
      if (!input.handoffId) await (await import("./receipts")).sendStandingReceipt(ctx.sale.id, tx, now);
    });
  } catch (e) {
    for (const l of legs)
      if (l.charge)
        await compensateCharge(
          l.charge.paymentIntentId,
          l.chargeCents,
          ctx.sale.id,
          l.charge.transferId && l.charge.destination
            ? { transferId: l.charge.transferId, amountCents: l.chargeCents - l.charge.destination.applicationFeeCents }
            : null,
        );
    throw e;
  }
  if (legs.some((l) => l.charge)) await settleSale(ctx.sale.id);

  await settlePrompts(ctx.sale.id, input.actor, now).catch((e: Error) =>
    console.error("settling checkout prompts failed", e.message),
  );
  let rebooked = null;
  if (input.rebookInWeeks && ctx.appointment) {
    rebooked = await oneTapRebook(
      ctx.appointment.id,
      input.rebookInWeeks,
      input.actor,
    ).catch((e: Error) => ({ error: e.message }));
  }
  // A paid ticket changes visits, spend, rewards and gift cards; a failure here never fails the sale.
  // Loaded here, not at the top: the badge engine is staff-only, and the client API checks out too.
  if (ctx.sale.customerId)
    await import("./badges")
      .then((b) =>
        b.refreshBadges(
          [...new Set([ctx.sale.customerId!, ...people.values()])],
          now,
        ),
      )
      .catch((e: Error) =>
        console.error("badge refresh after checkout failed", e.message),
      );
  await import("./milestones/day")
    .then((m) => m.checkoutMilestones(ctx.sale.id, now))
    .catch((e: Error) =>
      console.error("milestone check after checkout failed", e.message),
    );
  const cards = legs.flatMap((l) => (l.charge ? [l.charge.card] : []));
  return {
    saleId: ctx.sale.id,
    totals,
    issuedGiftCards,
    reloadedGiftCards,
    rewardsIssued,
    rebooked,
    card: cards[0] ?? null,
    cards,
    stockWarnings,
  };
}

interface Leg {
  tender: Exclude<TenderInput, { method: "none" }>;
  chargeCents: number;
  tipCents: number;
  feeCents: number;
  /** How the card's surcharge was worked out; null for cash. */
  fee: CardFeeResult | null;
  funding: CardFunding | null;
  payerCustomerId: string | null;
  payerLabel: string | null;
  route?: Awaited<ReturnType<typeof chargeRoute>>;
  reader?: Awaited<ReturnType<typeof assertReaderAt>> | null;
  charge?: Awaited<ReturnType<typeof chargeCard>>;
}

/**
 * Undo a charge this request made when its transaction didn't commit. If the payment row did land
 * (the commit succeeded but the reply was lost), the charge is real and is left alone.
 */
async function compensateCharge(
  paymentIntentId: string,
  amountCents: number,
  saleId: string,
  destinationTransfer: { transferId: string; amountCents: number } | null,
) {
  const recorded = await db.query.payments
    .findFirst({ where: eq(payments.stripePaymentIntentId, paymentIntentId) })
    .catch(() => null);
  if (recorded) return;
  try {
    await refundCard(paymentIntentId, amountCents, `comp-${paymentIntentId}`);
    if (destinationTransfer)
      await reverseUnrecordedTransfer(`comp-${paymentIntentId}`, destinationTransfer.transferId, destinationTransfer.amountCents);
    await audit(
      SYSTEM,
      "payment.compensated",
      "sale",
      saleId,
      { paymentIntentId, amountCents },
      null,
    );
  } catch (err) {
    await audit(
      SYSTEM,
      "payment.compensation_failed",
      "sale",
      saleId,
      { paymentIntentId, amountCents, error: (err as Error).message },
      null,
    ).catch(() => {});
  }
}

export async function assertStaffAtShop(
  staffId: string,
  shopId: string,
  tx: DBorTx = db,
) {
  const links = await tx
    .select({ shopId: staffShops.shopId })
    .from(staffShops)
    .where(eq(staffShops.staffId, staffId));
  const denied = staffAtShopDenied(
    links.map((l) => l.shopId),
    shopId,
  );
  if (denied) throw new AppError("bad_request", denied);
}

/**
 * One-tap rebook: same barber, same services, same time of day, N weeks out.
 * If that exact slot is taken, take the nearest opening that day with the same barber.
 */
export async function oneTapRebook(
  appointmentId: string,
  weeks: number,
  actor: Actor,
) {
  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) throw notFound("Appointment");
  const items = await db
    .select()
    .from(appointmentItems)
    .where(eq(appointmentItems.appointmentId, appointmentId));
  const service = items.find((i) => i.kind === "service");
  if (!service?.serviceId)
    throw new AppError("bad_request", "Nothing to rebook");
  const addonIds = items
    .filter((i) => i.kind === "addon" && i.serviceId)
    .map((i) => i.serviceId!);
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
  if (!avail.slots.length)
    throw new AppError(
      "slot_unavailable",
      "No openings with this barber that day",
    );
  const best = [...avail.slots].sort(
    (a, b) =>
      Math.abs(new Date(a.startsAt).getTime() - desired.getTime()) -
      Math.abs(new Date(b.startsAt).getTime() - desired.getTime()),
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
    .select({
      cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      tips: sql<number>`coalesce(sum(${payments.tipCents}), 0)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(payments)
    .innerJoin(sales, eq(sales.id, payments.saleId))
    // Squire history is not cash in this drawer.
    .where(
      and(
        eq(payments.shopId, shopId),
        eq(payments.businessDate, date),
        eq(payments.method, "cash"),
        sql`${sales.status} <> 'voided'`,
        eq(sales.isImported, false),
      ),
    );
  const [cashRefunds] = await db
    .select({
      cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int`,
    })
    .from(refunds)
    .where(
      and(
        eq(refunds.shopId, shopId),
        eq(refunds.businessDate, date),
        eq(refunds.method, "cash"),
        eq(refunds.kind, "refund"),
      ),
    );
  const [cardTotals] = await db
    .select({
      cents: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.shopId, shopId),
        eq(payments.businessDate, date),
        eq(payments.method, "card"),
        sql`${payments.status} <> 'voided'`,
        sql`${payments.processor} is distinct from 'squire_import'`,
      ),
    );
  const drawer = await db.query.cashDrawers.findFirst({
    where: and(
      eq(cashDrawers.shopId, shopId),
      eq(cashDrawers.businessDate, date),
    ),
  });
  const opening =
    drawer && (drawer.openedAt || drawer.closedAt)
      ? drawer.openingFloatCents
      : await defaultOpening(shopId);
  const moved = await movesOutCents(shopId, date);
  const payouts = drawer?.closedAt ? drawer.payoutsCents : moved;
  const tipPayouts = drawer?.closedAt
    ? drawer.tipPayoutsCents
    : await cashTipPayoutsCents(shopId, date);
  return {
    date,
    drawer,
    /** Opened today with a counted balance; until then the opening is the shop's default. */
    opened: !!drawer?.openedAt,
    /** Paid-outs less paid-ins recorded during the day. */
    movesOutCents: moved,
    openingFloatCents: opening,
    cashSalesCents: cash.cents,
    cashTipsCents: cash.tips,
    cashTickets: cash.n,
    cashRefundsCents: cashRefunds.cents,
    payoutsCents: payouts,
    /** Cash tip payouts employees acknowledged out of this drawer. */
    tipPayoutsCents: tipPayouts,
    expectedCents:
      opening + cash.cents - cashRefunds.cents - payouts - tipPayouts,
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
  const existing = await db.query.cashDrawers.findFirst({
    where: and(
      eq(cashDrawers.shopId, input.shopId),
      eq(cashDrawers.businessDate, input.date),
    ),
  });
  if (existing?.closedAt)
    throw new AppError("conflict", "Drawer already closed for this day");
  const waiting = await cashAwaiting(input.shopId);
  if (waiting.length)
    throw new AppError(
      "conflict",
      `${waiting.length === 1 ? "A cash tip payout is" : `${waiting.length} cash tip payouts are`} still waiting to be paid: pay, hold or remove ${waiting.length === 1 ? "it" : "them"} first.`,
    );
  const s = await drawerSummary(input.shopId, input.date);
  // A drawer opened with a count keeps that opening; the paid-ins and outs recorded during the day add to what's typed at close.
  const opening = s.opened ? s.openingFloatCents : input.openingFloatCents;
  const payouts = s.movesOutCents + input.payoutsCents;
  const expected =
    opening +
    s.cashSalesCents -
    s.cashRefundsCents -
    payouts -
    s.tipPayoutsCents;
  const values = {
    shopId: input.shopId,
    businessDate: input.date,
    openingFloatCents: opening,
    cashSalesCents: s.cashSalesCents,
    cashRefundsCents: s.cashRefundsCents,
    payoutsCents: payouts,
    tipPayoutsCents: s.tipPayoutsCents,
    expectedCents: expected,
    countedCents: input.countedCents,
    varianceCents: input.countedCents - expected,
    notes: input.notes ?? null,
    closedBy: input.actor.staffId ?? null,
    closedAt: new Date(),
  };
  await db
    .insert(cashDrawers)
    .values(values)
    .onConflictDoUpdate({
      target: [cashDrawers.shopId, cashDrawers.businessDate],
      set: values,
    });
  await audit(
    input.actor,
    "drawer.close",
    "cash_drawer",
    `${input.shopId}:${input.date}`,
    {
      expected,
      counted: input.countedCents,
      variance: input.countedCents - expected,
      tipPayoutsCents: s.tipPayoutsCents,
    },
    input.shopId,
  );
  return {
    expectedCents: expected,
    varianceCents: input.countedCents - expected,
  };
}
