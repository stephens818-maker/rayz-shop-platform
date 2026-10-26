import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appointments, brandSettings, checkoutHandoffs, customers, saleTipShares, sales, shops, staff, terminalReaders } from "@/db/schema";
import { feeDisclosure, feeLabel } from "@/domain/checkout";
import { perBarberTipProblem } from "@/domain/combined-checkout";
import { maskEmail, maskPhone } from "@/domain/client-privacy";
import { receiptBranding, takesCards } from "@/domain/connect";
import {
  BrandHandoff,
  RECEIPT_CHANNELS,
  ReceiptChannel,
  ShopHandoff,
  TIP_SPLIT_MODES,
  TipScreen,
  brandHandoff,
  effectiveTips,
  handoffSteps,
  screenTipProblem,
  shopHandoff,
  shopHandoffProblem,
  signatureProblem,
  splitCents,
  tipChoices,
  tipScreenProblem,
  tipWeights,
} from "@/domain/handoff";
import { normalizePhone } from "@/lib/phone";
import { Actor, audit } from "./audit";
import { loadStaffAccess, staffWithAccessTo } from "./auth/access";
import { CheckoutLineInput, TenderInput, finalizeSale, priceCart } from "./checkout";
import { assertPromptsAnswered } from "./checkout-prompts";
import { AppError, forbidden, notFound } from "./errors";
import { settlementAccount } from "./payments/connect";
import { TEST_CARDS, inspectPaymentMethod, paymentsMode, stripe, terminal } from "./payments/processor";
import { deliverReceipt, isOptedOut } from "./receipts";
import { checkPin } from "./time-clock";

// ───────────────────────────── Settings ─────────────────────────────

export async function brandHandoffConfig(): Promise<BrandHandoff> {
  const [b] = await db.select({ h: brandSettings.handoff }).from(brandSettings).where(eq(brandSettings.id, 1));
  return brandHandoff(b?.h);
}

export async function shopHandoffConfig(shopId: string): Promise<{ shop: ShopHandoff; brand: BrandHandoff; tips: TipScreen }> {
  const [s] = await db.select({ h: shops.handoff }).from(shops).where(eq(shops.id, shopId));
  if (!s) throw notFound("Shop");
  const shop = shopHandoff(s.h);
  const brand = await brandHandoffConfig();
  return { shop, brand, tips: effectiveTips(shop, brand) };
}

export async function saveBrandHandoff(tips: TipScreen, actor: Actor) {
  const problem = tipScreenProblem(tips);
  if (problem) throw new AppError("bad_request", problem);
  const before = await brandHandoffConfig();
  const clean: BrandHandoff = { tips: { type: tips.type, values: [...tips.values], allowCustom: tips.allowCustom, allowNoTip: tips.allowNoTip } };
  await db.update(brandSettings).set({ handoff: clean as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "handoff.brand_settings", "brand_settings", "1", { before, after: clean }, null);
  const onReader = (await db.select({ id: shops.id, h: shops.handoff }).from(shops)).filter((s) => {
    const h = shopHandoff(s.h);
    return h.tipEntry === "reader" && !h.tips;
  });
  for (const s of onReader) await syncReaderTipping(s.id, clean.tips).catch((e: Error) => console.error(`Reader tips for shop ${s.id}: ${e.message}`));
  return clean;
}

export async function saveShopHandoff(shopId: string, raw: ShopHandoff, actor: Actor) {
  const problem = shopHandoffProblem(raw);
  if (problem) throw new AppError("bad_request", problem);
  const clean = shopHandoff(raw);
  const [before] = await db.select({ h: shops.handoff, tipPresets: shops.tipPresets }).from(shops).where(eq(shops.id, shopId));
  if (!before) throw notFound("Shop");
  const brand = await brandHandoffConfig();
  const tips = effectiveTips(clean, brand);
  await db
    .update(shops)
    .set({ handoff: clean as unknown as Record<string, unknown>, ...(tips.type === "percent" ? { tipPresets: tips.values } : {}) })
    .where(eq(shops.id, shopId));
  await audit(actor, "handoff.settings", "shop", shopId, { before: shopHandoff(before.h), after: clean }, shopId);
  const reader = clean.tipEntry === "reader" ? await syncReaderTipping(shopId, tips).catch((e: Error) => ({ status: "failed" as const, error: e.message })) : { status: "off" as const };
  return { settings: clean, reader };
}

/**
 * Stripe Terminal readers show their own tip screen from a Terminal configuration on the shop's
 * Location. Readers show at most three presets, so the first three are used. Nothing to do in the
 * simulator or before the shop has a Terminal Location.
 */
export async function syncReaderTipping(shopId: string, tips: TipScreen): Promise<{ status: "synced" | "skipped"; configurationId?: string; reason?: string }> {
  const s = stripe();
  const [shop] = await db.select({ location: shops.stripeTerminalLocationId }).from(shops).where(eq(shops.id, shopId));
  if (!s) return { status: "skipped", reason: "The payment simulator's readers ask for the tip themselves" };
  if (!shop?.location || shop.location.startsWith("sim_")) return { status: "skipped", reason: "This shop has no Stripe Terminal Location yet" };
  const usd = tips.type === "percent" ? { percentages: tips.values.slice(0, 3) } : { fixed_amounts: tips.values.slice(0, 3) };
  const loc = await s.terminal.locations.retrieve(shop.location);
  const existing = "configuration_overrides" in loc && typeof loc.configuration_overrides === "string" ? loc.configuration_overrides : null;
  const cfg = existing ? await s.terminal.configurations.update(existing, { tipping: { usd } }) : await s.terminal.configurations.create({ name: `Ray'z tips ${shopId.slice(0, 8)}`, tipping: { usd } });
  if (!existing) await s.terminal.locations.update(shop.location, { configuration_overrides: cfg.id });
  return { status: "synced", configurationId: cfg.id };
}

// ───────────────────────────── Starting ─────────────────────────────

export const HandoffDraftInput = z.object({
  lines: z
    .array(
      z.object({
        kind: z.enum(["service", "addon", "product", "gift_card"]),
        refId: z.uuid().nullable().optional(),
        name: z.string().max(200).optional(),
        qty: z.number().int().min(1).max(999),
        unitPriceCents: z.number().int().min(0).optional(),
        priceOverride: z.object({ unitPriceCents: z.number().int().min(0), reason: z.string().max(200) }).nullable().optional(),
        staffId: z.uuid().nullable().optional(),
        appointmentId: z.uuid().nullable().optional(),
        custom: z.boolean().optional(),
      }),
    )
    .min(1, "Add at least one item")
    .max(100),
  promoCode: z.string().max(40).nullable(),
  promoCodes: z.array(z.string().max(40)).max(10).nullable().optional(),
  manualDiscount: z.object({ type: z.enum(["percent", "amount"]), value: z.number().min(0), reason: z.string().max(200) }).nullable(),
  loyaltyRewardId: z.uuid().nullable(),
  membershipId: z.uuid().nullable().optional(),
  giftCard: z.object({ code: z.string().max(40), amountCents: z.number().int().min(0) }).nullable(),
  rebookInWeeks: z.number().int().min(1).max(26).nullable(),
  tipSplit: z.enum(TIP_SPLIT_MODES).nullable(),
  /** Staff waived the credit card surcharge, with the reason. */
  waiveCardFee: z.object({ reason: z.string().max(200) }).nullable().optional(),
});
export type HandoffDraftInput = z.infer<typeof HandoffDraftInput>;

/** The ticket as staff handed it over, with what the person who handed it may do (price changes, discounts). */
export interface HandoffDraft extends HandoffDraftInput {
  canOverridePrice: boolean;
  canCustomCharge?: boolean;
  maxManualDiscountPct: number;
  canWaiveCardFee?: boolean;
  /** Who handed it over, so a waiver is theirs. */
  staffId?: string;
}

export interface HandingOver {
  actor: Actor;
  staffId: string;
  canDiscount: boolean;
  canOverridePrice: boolean;
  canCustomCharge?: boolean;
  maxManualDiscountPct: number;
  canWaiveCardFee?: boolean;
}

type Row = typeof checkoutHandoffs.$inferSelect;
export const draftOf = (r: Pick<Row, "draft">) => r.draft as unknown as HandoffDraft;

export function finalizeFields(d: HandoffDraft) {
  return {
    lines: d.lines as CheckoutLineInput[],
    promoCode: d.promoCode,
    promoCodes: d.promoCodes ?? null,
    manualDiscount: d.manualDiscount,
    loyaltyRewardId: d.loyaltyRewardId,
    membershipId: d.membershipId ?? null,
    giftCard: d.giftCard,
    rebookInWeeks: d.rebookInWeeks,
    tipSplit: d.tipSplit,
    canOverridePrice: d.canOverridePrice,
    canCustomCharge: d.canCustomCharge ?? false,
    maxManualDiscountPct: d.maxManualDiscountPct,
    waiveCardFee: d.waiveCardFee?.reason ? { reason: d.waiveCardFee.reason, byStaffId: d.staffId ?? null } : null,
    canWaiveCardFee: d.canWaiveCardFee ?? false,
  };
}

/** Turns the ticket to the client. The draft is priced now, so anything wrong with it is caught at the counter. */
export async function startHandoff(saleId: string, raw: HandoffDraftInput, by: HandingOver, via: "device" | "app" = "device") {
  const input = HandoffDraftInput.parse(raw);
  if (input.manualDiscount && input.manualDiscount.value > 0) {
    if (!by.canDiscount) throw forbidden("You don't have permission to give discounts");
    if (!input.manualDiscount.reason.trim()) throw new AppError("bad_request", "Add a reason for the discount");
  }
  const draft: HandoffDraft = {
    ...input,
    canOverridePrice: by.canOverridePrice,
    canCustomCharge: by.canCustomCharge ?? false,
    maxManualDiscountPct: by.maxManualDiscountPct,
    canWaiveCardFee: by.canWaiveCardFee ?? false,
    staffId: by.staffId,
  };
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  if (sale.status !== "open") throw new AppError("conflict", `This ticket is already ${sale.status}`);
  await assertPromptsAnswered(saleId);
  await priceCart({ saleId, ...finalizeFields(draft), tipCents: 0, tender: { method: "none" } }, null);
  const row = await db.transaction(async (tx) => {
    await tx.select({ id: sales.id }).from(sales).where(eq(sales.id, saleId)).for("update");
    const [active] = await tx.select({ id: checkoutHandoffs.id }).from(checkoutHandoffs).where(and(eq(checkoutHandoffs.saleId, saleId), eq(checkoutHandoffs.status, "active")));
    if (active) throw new AppError("conflict", "This ticket is already with the client on another device. End that hand-off first.");
    const [r] = await tx
      .insert(checkoutHandoffs)
      .values({ saleId, shopId: sale.shopId, startedBy: by.staffId, draft: draft as unknown as Record<string, unknown>, via })
      .returning();
    await audit(by.actor, "handoff.start", "sale", saleId, { handoffId: r.id, lines: draft.lines.length, via }, sale.shopId, tx);
    return r;
  });
  return row;
}

/** The active hand-off for a ticket, if it's with the client right now (on any device). */
export async function activeHandoffFor(saleId: string) {
  const [r] = await db
    .select({ id: checkoutHandoffs.id, startedAt: checkoutHandoffs.startedAt, by: staff.displayLabel, via: checkoutHandoffs.via })
    .from(checkoutHandoffs)
    .innerJoin(staff, eq(staff.id, checkoutHandoffs.startedBy))
    .where(and(eq(checkoutHandoffs.saleId, saleId), eq(checkoutHandoffs.status, "active")));
  return r ?? null;
}

async function loadRow(id: string): Promise<Row> {
  const [r] = await db.select().from(checkoutHandoffs).where(eq(checkoutHandoffs.id, id));
  if (!r) throw notFound("Customer screen");
  return r;
}

async function activeRow(id: string): Promise<Row> {
  const r = await loadRow(id);
  if (r.status === "paid") throw new AppError("conflict", "This ticket is paid. Thank you!");
  if (r.status !== "active") throw new AppError("conflict", "Staff took this ticket back");
  return r;
}

// ───────────────────────────── What the client sees ─────────────────────────────

export interface HandoffView {
  id: string;
  saleId: string;
  status: Row["status"];
  shop: { name: string; logoUrl: string | null; accentColor: string | null; headline: string | null };
  ticketNumber: number;
  barbers: string[];
  lines: { name: string; qty: number; cents: number }[];
  discounts: { label: string; cents: number }[];
  servicesCents: number;
  taxCents: number;
  tipCents: number;
  giftCardCents: number;
  /** What's left to pay today before any credit card surcharge. */
  dueCents: number;
  /** The same paid with a credit card, and the surcharge in it. */
  creditDueCents: number;
  /** The ticket's total before gift cards, as checkout confirms it: without and with the surcharge. */
  totalCents: number;
  creditTotalCents: number;
  creditFeeCents: number;
  feeLabel: string | null;
  feeNotice: string | null;
  tips: { choices: { key: string; label: string; detail: string | null; cents: number }[]; allowCustom: boolean; allowNoTip: boolean };
  tip: { cents: number | null; choice: string | null; source: "screen" | "reader" | null; byStaff: { staffId: string; cents: number }[] | null };
  /** Each barber's part of the tip when the ticket has more than one. */
  split: { label: string; cents: number }[];
  /** With more than one barber the client can tip each on their own line instead of one total. */
  tipBarbers: { staffId: string; label: string; servicesCents: number }[];
  config: Pick<ShopHandoff, "tipEntry" | "signature" | "unlock" | "afterPayment" | "thankYouSeconds">;
  steps: ReturnType<typeof handoffSteps>;
  signed: boolean;
  receipt: { channel: ReceiptChannel | null; masked: string | null; onFile: { phone: string | null; email: string | null } };
  pay: {
    mode: "stripe" | "simulator";
    cards: boolean;
    publishableKey: string | null;
    readers: { id: string; label: string }[];
    readerLabel: string;
    readerTips: boolean;
    testCards: { id: string; label: string }[];
  };
  cashRequested: boolean;
  paidAt: string | null;
  /** When the thank-you screen gives the device back by itself; null waits for a PIN. */
  returnsAt: string | null;
}

export async function handoffView(id: string): Promise<HandoffView> {
  const r = await loadRow(id);
  const d = draftOf(r);
  const [sale, shop, cfg] = await Promise.all([db.query.sales.findFirst({ where: eq(sales.id, r.saleId) }), db.query.shops.findFirst({ where: eq(shops.id, r.shopId) }), shopHandoffConfig(r.shopId)]);
  if (!sale || !shop) throw notFound("Sale");
  const [customer, account, readers] = await Promise.all([
    sale.customerId ? db.query.customers.findFirst({ where: eq(customers.id, sale.customerId) }) : null,
    settlementAccount(shop),
    db
      .select({ id: terminalReaders.id, label: terminalReaders.label })
      .from(terminalReaders)
      .where(and(eq(terminalReaders.shopId, shop.id), eq(terminalReaders.active, true), isNotNull(terminalReaders.stripeReaderId)))
      .orderBy(asc(terminalReaders.createdAt)),
  ]);
  const cards = takesCards(shop.paymentsMode, account);
  const tipCents = r.tipCents ?? 0;
  const paid = r.status === "paid";
  const base = { saleId: r.saleId, ...finalizeFields(d), tipCents };
  // A paid ticket shows what it was paid; an open one is priced live, as checkout will price it.
  const [none, credit] = paid
    ? [null, null]
    : await Promise.all([priceCart({ ...base, tender: { method: "none" } }, null), priceCart({ ...base, tender: { method: "card", paymentMethodId: "", entryMode: "keyed" } }, "credit")]);
  const t = none?.totals;
  const barberIds = [...new Set([sale.staffId, ...d.lines.map((l) => l.staffId)].filter((x): x is string => !!x))];
  const names = new Map(barberIds.length ? (await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, barberIds))).map((x) => [x.id, x.label]) : []);
  const serviceLines = (t?.lines ?? []).filter((l) => l.kind === "service" || l.kind === "addon");
  const splitIds = [...new Set(serviceLines.map((l) => l.staffId).filter((x): x is string => !!x))];
  const byStaff = r.tipByStaff ?? null;
  const weights = splitIds.length > 1 || (splitIds.length === 1 && splitIds[0] !== sale.staffId) ? tipWeights(t!.lines, byStaff ? "per_barber" : (d.tipSplit ?? "services"), byStaff) : [];
  const shares = weights.length ? splitCents(tipCents, weights.map((w) => ({ id: w.staffId, weight: w.weight }))) : new Map<string, number>();
  const [paidItems, paidShares] = paid
    ? await Promise.all([
        db.query.saleItems.findMany({ where: (i, { eq: e }) => e(i.saleId, r.saleId) }),
        db
          .select({ staffId: saleTipShares.staffId, weight: saleTipShares.weight, label: staff.displayLabel })
          .from(saleTipShares)
          .innerJoin(staff, eq(staff.id, saleTipShares.staffId))
          .where(eq(saleTipShares.saleId, r.saleId))
          .orderBy(asc(saleTipShares.staffId)),
      ])
    : [[], []];
  const paidSplit = splitCents(sale.tipCents, paidShares.map((x) => ({ id: x.staffId, weight: x.weight })));
  const pricing = (sale.pricing ?? {}) as { discounts?: { label: string; cents: number }[]; cardFee?: { rate: number } };
  // A ticket a gift card covers never reaches the reader, so its tip is asked for on the screen.
  const readerTips = cfg.shop.tipEntry === "reader" && cards && readers.length > 0 && (!t || t.primaryBaseCents - tipCents > 0);
  const receipt = receiptBranding(shop.receipt);
  // What's on file is offered only where it can be sent: not to a number that replied STOP.
  const [smsStopped, emailStopped] = await Promise.all([customer?.phone ? isOptedOut("sms", customer.phone) : false, customer?.email ? isOptedOut("email", customer.email.toLowerCase()) : false]);
  return {
    id: r.id,
    saleId: r.saleId,
    status: r.status,
    shop: { name: shop.name, logoUrl: receipt.showLogo ? shop.logoUrl : null, accentColor: shop.accentColor, headline: receipt.headline },
    ticketNumber: sale.number,
    barbers: paidShares.length ? paidShares.map((x) => x.label) : (weights.length ? weights.map((w) => w.staffId) : sale.staffId ? [sale.staffId] : []).map((x) => names.get(x) ?? "Your barber"),
    lines: t ? t.lines.map((l) => ({ name: l.name, qty: l.qty, cents: l.grossCents })) : paidItems.map((i) => ({ name: i.name, qty: i.qty, cents: i.grossCents })),
    discounts: t ? t.discountBreakdown.map((x) => ({ label: x.label, cents: x.cents })) : (pricing.discounts ?? []).map((x) => ({ label: x.label, cents: x.cents })),
    servicesCents: t?.serviceGrossCents ?? sale.serviceGrossCents,
    taxCents: t?.taxCents ?? sale.serviceTaxCents + sale.productTaxCents,
    tipCents: paid ? sale.tipCents : tipCents,
    giftCardCents: t?.giftCardAppliedCents ?? 0,
    dueCents: t?.primaryChargeCents ?? sale.totalCents,
    creditDueCents: credit?.totals.primaryChargeCents ?? sale.totalCents,
    totalCents: t?.totalCents ?? sale.totalCents,
    creditTotalCents: credit?.totals.totalCents ?? sale.totalCents,
    creditFeeCents: credit?.totals.cardFeeCents ?? sale.cardFeeCents,
    feeLabel: credit && credit.totals.cardFeeCents > 0 ? feeLabel({ rate: credit.totals.cardFeeRate }) : paid && sale.cardFeeCents > 0 ? feeLabel({ rate: pricing.cardFee?.rate ?? Number(shop.cardFeeRate) }) : null,
    feeNotice: cards ? feeDisclosure({ enabled: shop.cardFeeEnabled, rate: Number(shop.cardFeeRate) }) : null,
    tips: { choices: tipChoices(cfg.tips, t?.serviceGrossCents ?? 0), allowCustom: cfg.tips.allowCustom, allowNoTip: cfg.tips.allowNoTip },
    tip: { cents: r.tipCents, choice: r.tipChoice, source: r.tipSource, byStaff },
    split: paid ? paidShares.map((x) => ({ label: x.label, cents: paidSplit.get(x.staffId) ?? 0 })) : weights.map((w) => ({ label: names.get(w.staffId) ?? "Barber", cents: shares.get(w.staffId) ?? 0 })),
    tipBarbers:
      !paid && splitIds.length > 1
        ? [...splitIds].sort().map((id) => ({ staffId: id, label: names.get(id) ?? "Barber", servicesCents: serviceLines.filter((l) => l.staffId === id).reduce((a, l) => a + l.grossCents, 0) }))
        : [],
    config: { tipEntry: cfg.shop.tipEntry, signature: cfg.shop.signature, unlock: cfg.shop.unlock, afterPayment: cfg.shop.afterPayment, thankYouSeconds: cfg.shop.thankYouSeconds },
    steps: handoffSteps(cfg.shop, { readerTips }),
    signed: !!r.signature,
    receipt: { channel: r.receiptChannel, masked: r.receiptMasked, onFile: { phone: smsStopped ? null : maskPhone(customer?.phone), email: emailStopped ? null : maskEmail(customer?.email) } },
    pay: {
      mode: paymentsMode(),
      cards,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
      readers,
      readerLabel: terminal.readerLabel,
      readerTips,
      testCards: Object.entries(TEST_CARDS).map(([key, c]) => ({ id: key, label: c.label })),
    },
    cashRequested: r.cashRequested,
    paidAt: r.paidAt?.toISOString() ?? null,
    returnsAt: paid && r.endedAt ? r.endedAt.toISOString() : null,
  };
}

// ───────────────────────────── The client's steps ─────────────────────────────

export async function chooseTip(id: string, choice: string, cents: number, byStaff?: { staffId: string; cents: number }[] | null) {
  const r = await activeRow(id);
  const v = await handoffView(id);
  let lines: { staffId: string; cents: number }[] | null = null;
  if (choice === "per_barber") {
    // A line per barber is a custom amount for each, so it follows the custom tip setting.
    if (!v.tips.allowCustom || v.tipBarbers.length < 2) throw new AppError("bad_request", "Choose one of the tips");
    lines = (byStaff ?? []).map((x) => ({ staffId: x.staffId, cents: x.cents }));
    cents = lines.reduce((a, x) => a + (Number.isInteger(x.cents) ? x.cents : 0), 0);
    const problem = perBarberTipProblem(lines, v.tipBarbers.map((b) => b.staffId), cents);
    if (problem) throw new AppError("bad_request", problem);
    if (cents === 0 && !v.tips.allowNoTip) throw new AppError("bad_request", "Choose a tip");
  } else if (choice === "none") {
    if (!v.tips.allowNoTip) throw new AppError("bad_request", "Choose a tip");
    cents = 0;
  } else if (choice === "custom") {
    if (!v.tips.allowCustom) throw new AppError("bad_request", "Choose one of the tips");
  } else {
    const preset = v.tips.choices.find((c) => c.key === choice);
    if (!preset) throw new AppError("bad_request", "Choose one of the tips");
    cents = preset.cents;
  }
  const problem = screenTipProblem(cents);
  if (problem) throw new AppError("bad_request", problem);
  // A signature agrees to an amount, so a different tip is signed for again.
  const resign = r.signature && r.tipCents !== cents ? { signature: null, signedAt: null } : {};
  await db
    .update(checkoutHandoffs)
    .set({ tipCents: cents, tipChoice: choice, tipSource: "screen", tipByStaff: lines, ...resign })
    .where(and(eq(checkoutHandoffs.id, r.id), eq(checkoutHandoffs.status, "active")));
  return handoffView(id);
}

export async function sign(id: string, path: string) {
  const r = await activeRow(id);
  const problem = signatureProblem(path);
  if (problem) throw new AppError("bad_request", problem);
  await db.update(checkoutHandoffs).set({ signature: path, signedAt: new Date() }).where(and(eq(checkoutHandoffs.id, r.id), eq(checkoutHandoffs.status, "active")));
  return handoffView(id);
}

export const ReceiptInput = z.object({ channel: z.enum(RECEIPT_CHANNELS), onFile: z.boolean().default(false), to: z.string().trim().max(200).optional() });

export async function chooseReceipt(id: string, raw: z.input<typeof ReceiptInput>) {
  const r = await activeRow(id);
  const v = ReceiptInput.parse(raw);
  let to: string | null = null;
  let masked: string | null = null;
  if (v.channel !== "none") {
    const sale = await db.query.sales.findFirst({ where: eq(sales.id, r.saleId), columns: { customerId: true } });
    const c = v.onFile && sale?.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, sale.customerId), columns: { phone: true, email: true } }) : null;
    if (v.channel === "sms") {
      to = v.onFile ? (c?.phone ?? null) : normalizePhone(v.to);
      if (!to) throw new AppError("bad_request", v.onFile ? "There's no mobile number on file" : "Enter a 10-digit mobile number");
      masked = maskPhone(to);
    } else {
      to = v.onFile ? (c?.email?.toLowerCase() ?? null) : (v.to ?? "").toLowerCase();
      if (!to || !z.email().safeParse(to).success) throw new AppError("bad_request", v.onFile ? "There's no email on file" : "Enter an email address like name@example.com");
      masked = maskEmail(to);
    }
    if (await isOptedOut(v.channel, to)) {
      throw new AppError(
        "conflict",
        v.channel === "sms" ? "That number has turned off texts from us (it replied STOP). Choose email, or no receipt." : "That email has turned off receipt emails from us. Choose a text, or no receipt.",
      );
    }
  }
  await db
    .update(checkoutHandoffs)
    .set({ receiptChannel: v.channel, receiptTo: to, receiptMasked: masked })
    .where(and(eq(checkoutHandoffs.id, r.id), eq(checkoutHandoffs.status, "active")));
  return handoffView(id);
}

/**
 * The client presents a card on the shop's reader. With tips on the reader, the reader asks for the
 * tip first (the simulated reader passes what was picked on it); then the card's funding decides
 * whether the credit card surcharge applies.
 */
export async function collectOnReader(id: string, o: { testCard: string; readerId: string; tip?: { choice: string; cents: number } | null }) {
  const r = await activeRow(id);
  const v = await handoffView(id);
  if (!v.pay.cards) throw new AppError("bad_request", "This shop isn't taking cards right now");
  if (!v.pay.readers.some((x) => x.id === o.readerId)) throw new AppError("bad_request", "Pick one of this shop's readers");
  if (v.pay.readerTips) {
    if (!o.tip) throw new AppError("bad_request", "The reader asks for a tip first");
    const preset = o.tip.choice === "none" ? { cents: 0 } : o.tip.choice === "custom" ? { cents: o.tip.cents } : v.tips.choices.find((c) => c.key === o.tip!.choice);
    if (!preset) throw new AppError("bad_request", "Choose one of the tips on the reader");
    const problem = screenTipProblem(preset.cents);
    if (problem) throw new AppError("bad_request", problem);
    await db.update(checkoutHandoffs).set({ tipCents: preset.cents, tipChoice: o.tip.choice, tipSource: "reader", tipByStaff: null }).where(eq(checkoutHandoffs.id, r.id));
  }
  const card = await terminal.collectPaymentMethod(o.testCard);
  return { card: { paymentMethodId: card.paymentMethodId, ...card.card }, view: await handoffView(id) };
}

/** A card keyed on the customer screen (Stripe Elements, or a simulator test card): its funding, for the surcharge. */
export async function inspectCard(id: string, paymentMethodId: string) {
  await activeRow(id);
  const card = await inspectPaymentMethod(paymentMethodId);
  return { card: { paymentMethodId, ...card }, view: await handoffView(id) };
}

export type HandoffTender = { method: "card"; paymentMethodId: string; entryMode: "keyed" | "terminal"; readerId?: string | null } | { method: "none" };

/** Pays the ticket from the customer screen: the draft staff handed over, the client's tip, then the receipt they asked for. */
export async function payHandoff(id: string, tender: HandoffTender, expectedTotalCents: number, now = new Date()) {
  const r = await activeRow(id);
  const v = await handoffView(id);
  if (v.steps.includes("tip") && r.tipCents == null) throw new AppError("bad_request", "Choose a tip first");
  if (v.pay.readerTips && tender.method === "card" && tender.entryMode === "terminal" && r.tipSource !== "reader") throw new AppError("bad_request", "Present the card on the reader first");
  if (!v.steps.includes("tip") && tender.method === "card" && tender.entryMode !== "terminal" && r.tipCents == null) throw new AppError("bad_request", "Choose a tip first");
  if (v.config.signature && !r.signature) throw new AppError("bad_request", "Sign first");
  if (!r.receiptChannel) throw new AppError("bad_request", "Choose how you'd like your receipt");
  if (tender.method === "none" && v.dueCents > 0) throw new AppError("bad_request", "Pay with a card, or hand back to pay cash");
  const d = draftOf(r);
  const starter = await db.query.staff.findFirst({ where: eq(staff.id, r.startedBy), columns: { displayLabel: true } });
  const actor: Actor = { staffId: r.startedBy, label: `Customer screen:${starter?.displayLabel ?? "staff"}` };
  const result = await finalizeSale({
    saleId: r.saleId,
    ...finalizeFields(d),
    ...(r.tipByStaff ? { tipSplit: "per_barber" as const, tipByStaff: r.tipByStaff } : {}),
    tipCents: r.tipCents ?? 0,
    tender: tender as TenderInput,
    expectedTotalCents,
    handoffId: r.id,
    actor,
    now,
  });
  const cfg = await shopHandoffConfig(r.shopId);
  const endsAt = cfg.shop.afterPayment === "auto" ? new Date(now.getTime() + cfg.shop.thankYouSeconds * 1000) : null;
  await db.transaction(async (tx) => {
    await tx.update(checkoutHandoffs).set({ status: "paid", paidAt: now, endedAt: endsAt, receiptTo: null }).where(eq(checkoutHandoffs.id, r.id));
    if (r.receiptChannel === "none" || r.receiptTo) {
      // The ticket is paid by now, so a receipt that can't go (a STOP since it was chosen) mustn't undo the payment.
      await tx
        .transaction((sp) => deliverReceipt({ saleId: r.saleId, channel: r.receiptChannel!, to: r.receiptTo, purpose: "handoff", sentBy: null, now }, sp))
        .catch((e) => console.error("handoff: receipt not sent", r.saleId, (e as Error).message));
    }
    await audit(
      actor,
      "handoff.paid",
      "sale",
      r.saleId,
      { handoffId: r.id, tipCents: r.tipCents ?? 0, tipSource: r.tipSource, signed: !!r.signature, receipt: r.receiptChannel, receiptTo: r.receiptMasked },
      r.shopId,
      tx,
    );
  });
  return { saleId: result.saleId, returnsAt: endsAt?.toISOString() ?? null, rebook: result.rebooked && "code" in result.rebooked ? result.rebooked.code : null };
}

/** The client wants to pay cash: the device goes back to the counter, with their tip, to take it. */
export async function requestCash(id: string) {
  const r = await activeRow(id);
  await db.update(checkoutHandoffs).set({ cashRequested: true }).where(eq(checkoutHandoffs.id, r.id));
  return handoffView(id);
}

// ───────────────────────────── Taking it back ─────────────────────────────

/** Who can take the device back here: anyone with access to the shop and a time clock PIN, or only managers. */
export async function unlockPeople(id: string) {
  const r = await loadRow(id);
  const { shop: cfg } = await shopHandoffConfig(r.shopId);
  const ids = await staffWithAccessTo([r.shopId]);
  if (!ids.length) return { rule: cfg.unlock, people: [] };
  const rows = await db
    .select({ id: staff.id, label: staff.displayLabel, pin: staff.clockPinHash })
    .from(staff)
    .where(and(inArray(staff.id, ids), eq(staff.active, true), eq(staff.kind, "person"), isNotNull(staff.clockPinHash)))
    .orderBy(asc(staff.displayLabel));
  const allowed = cfg.unlock === "staff" ? rows : (await Promise.all(rows.map(async (p) => ((await canUnlockAsManager(p.id, r.shopId)) ? p : null)))).filter((p) => !!p);
  return { rule: cfg.unlock, people: allowed.map((p) => ({ id: p.id, label: p.label })) };
}

async function canUnlockAsManager(staffId: string, shopId: string) {
  const a = await loadStaffAccess(staffId);
  if (!a) return false;
  return a.isOwner || !!a.byShop.get(shopId)?.permissions.has("handoff.unlock");
}

/**
 * A staff PIN takes the device back. Before payment the ticket goes back to checkout with the
 * client's tip; after it, to the receipt. Wrong PINs count toward that person's time clock lockout.
 */
export async function unlockHandoff(id: string, staffId: string, pin: string, now = new Date()) {
  const r = await loadRow(id);
  const { people, rule } = await unlockPeople(id);
  if (!people.some((p) => p.id === staffId)) throw forbidden(rule === "manager" ? "A manager's PIN takes this device back" : "Pick someone who works here");
  await checkPin(staffId, pin, now);
  const who = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { displayLabel: true } });
  const actor: Actor = { staffId, label: `PIN:${who?.displayLabel ?? "staff"}` };
  if (r.status === "active") {
    await db.update(checkoutHandoffs).set({ status: "returned", endedAt: now, endedBy: staffId }).where(and(eq(checkoutHandoffs.id, r.id), eq(checkoutHandoffs.status, "active")));
  } else if (!r.endedAt || r.endedAt > now) {
    await db.update(checkoutHandoffs).set({ endedAt: now, endedBy: staffId }).where(eq(checkoutHandoffs.id, r.id));
  }
  await audit(actor, "handoff.unlock", "sale", r.saleId, { handoffId: r.id, rule, paid: r.status === "paid" }, r.shopId);
  return { path: await returnPath(r) };
}

/** After the thank-you screen on a shop that gives the device back by itself. */
export async function finishHandoff(id: string, now = new Date()) {
  const r = await loadRow(id);
  if (r.status !== "paid" || !r.endedAt) throw new AppError("conflict", "A staff PIN takes this device back");
  if (r.endedAt > now) await db.update(checkoutHandoffs).set({ endedAt: now }).where(eq(checkoutHandoffs.id, r.id));
  return { path: await returnPath(r) };
}

async function returnPath(r: Row) {
  if (r.status === "paid") {
    const sale = await db.query.sales.findFirst({ where: eq(sales.id, r.saleId), columns: { appointmentId: true } });
    const next = sale?.appointmentId
      ? await db.query.appointments.findFirst({ where: eq(appointments.rebookedFromId, sale.appointmentId), orderBy: [desc(appointments.createdAt)], columns: { code: true } })
      : null;
    return `/admin/sales/${r.saleId}?done=1${next ? `&rebook=${next.code}` : ""}`;
  }
  return `/admin/checkout/${r.saleId}?resume=${r.id}`;
}

/** Staff end a hand-off from another device, e.g. the client walked off with the tablet. */
export async function endHandoffFromCounter(saleId: string, actor: Actor) {
  const [r] = await db
    .update(checkoutHandoffs)
    .set({ status: "returned", endedAt: new Date(), endedBy: actor.staffId ?? null })
    .where(and(eq(checkoutHandoffs.saleId, saleId), eq(checkoutHandoffs.status, "active")))
    .returning();
  if (!r) throw new AppError("conflict", "This ticket isn't with the client any more");
  await audit(actor, "handoff.end", "sale", saleId, { handoffId: r.id }, r.shopId);
  return r;
}

/** What checkout picks back up after staff took the device back: the ticket as handed over, the tip and whether it's cash. */
export async function resumeDraft(saleId: string, handoffId: string) {
  const [r] = await db.select().from(checkoutHandoffs).where(and(eq(checkoutHandoffs.id, handoffId), eq(checkoutHandoffs.saleId, saleId), eq(checkoutHandoffs.status, "returned")));
  if (!r) return null;
  const d = draftOf(r);
  return {
    lines: d.lines,
    promoCode: d.promoCode,
    promoCodes: d.promoCodes ?? null,
    manualDiscount: d.manualDiscount,
    loyaltyRewardId: d.loyaltyRewardId,
    membershipId: d.membershipId ?? null,
    giftCard: d.giftCard,
    rebookInWeeks: d.rebookInWeeks,
    tipSplit: r.tipByStaff ? ("per_barber" as const) : d.tipSplit,
    tipByStaff: r.tipByStaff ?? null,
    tipCents: r.tipCents,
    tipChoice: r.tipChoice,
    cash: r.cashRequested,
  };
}

/** The customer screen's record on the receipt: tip source, signature and where the receipt went. */
export async function handoffOnSale(saleId: string) {
  const [r] = await db
    .select()
    .from(checkoutHandoffs)
    .where(and(eq(checkoutHandoffs.saleId, saleId), eq(checkoutHandoffs.status, "paid")))
    .orderBy(desc(checkoutHandoffs.paidAt))
    .limit(1);
  const shares = await db
    .select({ staffId: saleTipShares.staffId, weight: saleTipShares.weight, label: staff.displayLabel })
    .from(saleTipShares)
    .innerJoin(staff, eq(staff.id, saleTipShares.staffId))
    .where(eq(saleTipShares.saleId, saleId))
    .orderBy(asc(saleTipShares.staffId));
  return {
    screen: r ? { tipSource: r.tipSource, signature: r.signature, signedAt: r.signedAt, receiptChannel: r.receiptChannel, receiptMasked: r.receiptMasked } : null,
    shares,
  };
}
