import { allocateProportionally, applyRate, formatCents, formatRate } from "@/lib/money";

export type LineKind = "service" | "addon" | "product" | "gift_card";
export type CardFunding = "credit" | "debit" | "prepaid" | "unknown";
export type PrimaryMethod = "cash" | "card" | "none";

export interface CartLine {
  key: string;
  kind: LineKind;
  name: string;
  unitPriceCents: number;
  qty: number;
  staffId?: string | null;
  refId?: string | null;
  /** Which shop rate applies. Defaults by kind: services and add-ons at the service rate, products at the product rate. */
  taxCategory?: TaxCategory;
}

export type TaxCategory = "service" | "product" | "exempt";

export type DiscountTarget = "services" | "products" | "all";

export interface Discount {
  source: "promo" | "manual" | "loyalty";
  label: string;
  /** percent: value is whole percent (10 = 10%). amount: value is cents. */
  type: "percent" | "amount";
  value: number;
  appliesTo: DiscountTarget;
  refId?: string | null;
}

export interface TaxRates {
  /** Fractions, e.g. 0.07. Configured per shop, never hard-coded. */
  serviceRate: number;
  productRate: number;
}

export interface CardFeeConfig {
  enabled: boolean;
  /** Fraction, e.g. 0.03. Clamped to MAX_CARD_FEE_RATE. */
  rate: number;
  /** Whether the fee is charged on the tip portion paid by card. */
  appliesToTip: boolean;
}

export const MAX_CARD_FEE_RATE = 0.03;

export interface TenderPlan {
  giftCardCents?: number;
  /** Max redeemable from the gift card (its balance). */
  giftCardBalanceCents?: number;
  method: PrimaryMethod;
  /** From Stripe: PaymentMethod.card.funding (or card_present.funding for Terminal). */
  cardFunding?: CardFunding | null;
}

export interface CheckoutInput {
  lines: CartLine[];
  discounts?: Discount[];
  taxRates: TaxRates;
  tipCents?: number;
  cardFee: CardFeeConfig;
  tender: TenderPlan;
}

export interface LineResult extends CartLine {
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
}

export interface CheckoutTotals {
  lines: LineResult[];
  serviceGrossCents: number;
  productGrossCents: number;
  giftCardSalesCents: number;
  discountCents: number;
  discountBreakdown: { label: string; source: Discount["source"]; cents: number; refId?: string | null }[];
  serviceNetCents: number;
  productNetCents: number;
  serviceTaxCents: number;
  productTaxCents: number;
  taxCents: number;
  tipCents: number;
  /** Everything the customer owes before any card fee. */
  preFeeTotalCents: number;
  giftCardAppliedCents: number;
  /** Amount charged to the primary method, excluding the card fee. */
  primaryBaseCents: number;
  cardFeeBaseCents: number;
  cardFeeCents: number;
  cardFeeRate: number;
  totalCents: number;
  primaryChargeCents: number;
  /** Net service dollars after discounts, before tax. Products, tips and gift cards never count. */
  loyaltyEligibleCents: number;
  disclosures: string[];
}

const isService = (k: LineKind) => k === "service" || k === "addon";
const taxBucket = (l: CartLine): TaxCategory | null => (l.kind === "gift_card" ? null : (l.taxCategory ?? (isService(l.kind) ? "service" : "product")));

function eligible(line: CartLine, target: DiscountTarget) {
  if (line.kind === "gift_card") return false;
  if (target === "all") return true;
  if (target === "services") return isService(line.kind);
  return line.kind === "product";
}

/**
 * A manual discount must stay within the person's limit: a percent no higher than it, or an
 * amount no more than that share of the ticket (gift cards excluded).
 */
export function manualDiscountProblem(d: { type: "percent" | "amount"; value: number } | null, lines: CartLine[], maxPct: number): string | null {
  if (!d || !(d.value > 0)) return null;
  if (maxPct <= 0) return "You can't give manual discounts";
  if (d.type === "percent") return d.value > maxPct ? `Your discount limit is ${maxPct}%` : null;
  const gross = lines.filter((l) => l.kind !== "gift_card").reduce((a, l) => a + Math.max(0, Math.round(l.unitPriceCents * l.qty)), 0);
  const cap = Math.floor((gross * maxPct) / 100);
  return d.value > cap ? `Your discount limit is ${maxPct}% of the ticket (${formatCents(cap)} here)` : null;
}

export function feeLabel(cfg: Pick<CardFeeConfig, "rate">): string {
  return `Credit card surcharge (${formatRate(cfg.rate)})`;
}

/**
 * Wallet buttons are often labeled credit. Use the funding Stripe actually returns.
 * Debit, prepaid, unknown, or missing funding is never surcharged, even when the wallet fee flag is on.
 * A wallet whose card Stripe calls credit still follows that flag.
 */
export function fundingForSurcharge(funding: CardFunding | null | undefined, wallet: boolean): CardFunding | null {
  if (!wallet) return funding ?? null;
  if (funding === "credit") return "credit";
  return funding ?? "unknown";
}

export function feeDisclosure(cfg: Pick<CardFeeConfig, "rate" | "enabled">): string | null {
  if (!cfg.enabled || cfg.rate <= 0) return null;
  const r = formatRate(Math.min(cfg.rate, MAX_CARD_FEE_RATE));
  return `A ${r} surcharge applies to credit card payments only. It does not exceed our cost of acceptance. No surcharge on debit, prepaid, gift card, or cash.`;
}

export type CardFeeBasis = "charge_excluding_tip" | "charge_including_tip";

export interface CardFeeResult {
  feeCents: number;
  /** The rate used, after clamping to MAX_CARD_FEE_RATE; 0 when no fee applies. */
  rate: number;
  basis: CardFeeBasis;
  /** The amount the rate was applied to. */
  basisCents: number;
  /** A surcharge is the shop's option, never required: staff may drop any fee that applies. Nothing to waive when the fee is 0. */
  waivable: boolean;
  /** Why no fee applies, when it doesn't. */
  reason: "applies" | "disabled" | "not_credit" | "wallet_fee_off" | "zero_amount";
  label: string | null;
  disclosure: string | null;
}

/**
 * The credit-card surcharge on one card charge. `chargeCents` is what goes on the card before the
 * fee, tip included; the tip is treated as the last thing paid, so at most `chargeCents` of it is on the card.
 */
export function cardFeeFor(cfg: CardFeeConfig, funding: CardFunding | null | undefined, amounts: { chargeCents: number; tipCents?: number }, opts: { wallet?: boolean; walletFeeOn?: boolean } = {}): CardFeeResult {
  const rate = Math.min(Math.max(cfg.rate, 0), MAX_CARD_FEE_RATE);
  const basis: CardFeeBasis = cfg.appliesToTip ? "charge_including_tip" : "charge_excluding_tip";
  const charge = Math.max(0, Math.round(amounts.chargeCents));
  const tipOnCharge = Math.min(Math.max(0, Math.round(amounts.tipCents ?? 0)), charge);
  const basisCents = charge - (cfg.appliesToTip ? 0 : tipOnCharge);
  const disclosure = feeDisclosure({ ...cfg, rate });
  const none = (reason: CardFeeResult["reason"]): CardFeeResult => ({ feeCents: 0, rate: 0, basis, basisCents: 0, waivable: false, reason, label: null, disclosure });
  if (!cfg.enabled || rate <= 0) return none("disabled");
  if (funding !== "credit") return none("not_credit");
  if (opts.wallet && !opts.walletFeeOn) return none("wallet_fee_off");
  const feeCents = applyRate(basisCents, rate);
  if (feeCents <= 0) return none("zero_amount");
  return { feeCents, rate, basis, basisCents, waivable: true, reason: "applies", label: feeLabel({ rate }), disclosure };
}

export function computeCheckout(input: CheckoutInput): CheckoutTotals {
  const lines: LineResult[] = input.lines.map((l) => ({
    ...l,
    grossCents: Math.max(0, Math.round(l.unitPriceCents * l.qty)),
    discountCents: 0,
    netCents: 0,
    taxCents: 0,
  }));

  // Percent discounts first (on gross), then fixed amounts, each capped at what's left.
  const discounts = [...(input.discounts ?? [])].sort((a, b) =>
    a.type === b.type ? 0 : a.type === "percent" ? -1 : 1,
  );
  const discountBreakdown: CheckoutTotals["discountBreakdown"] = [];
  for (const d of discounts) {
    const idx = lines.map((l, i) => (eligible(l, d.appliesTo) ? i : -1)).filter((i) => i >= 0);
    const remaining = idx.map((i) => lines[i].grossCents - lines[i].discountCents);
    const base = remaining.reduce((a, b) => a + b, 0);
    if (base <= 0) continue;
    let amount =
      d.type === "percent" ? applyRate(base, Math.min(100, Math.max(0, d.value)) / 100) : Math.max(0, Math.round(d.value));
    amount = Math.min(amount, base);
    if (amount <= 0) continue;
    const parts = allocateProportionally(amount, remaining);
    idx.forEach((li, k) => (lines[li].discountCents += parts[k]));
    discountBreakdown.push({ label: d.label, source: d.source, cents: amount, refId: d.refId });
  }

  for (const l of lines) l.netCents = l.grossCents - l.discountCents;

  const sum = (f: (l: LineResult) => boolean, g: (l: LineResult) => number) =>
    lines.filter(f).reduce((a, l) => a + g(l), 0);

  const serviceGrossCents = sum((l) => isService(l.kind), (l) => l.grossCents);
  const productGrossCents = sum((l) => l.kind === "product", (l) => l.grossCents);
  const giftCardSalesCents = sum((l) => l.kind === "gift_card", (l) => l.grossCents);
  const serviceNetCents = sum((l) => isService(l.kind), (l) => l.netCents);
  const productNetCents = sum((l) => l.kind === "product", (l) => l.netCents);

  // Tax is computed on each tax category's net total (one rounding per category), then spread to lines.
  const serviceTaxCents = applyRate(sum((l) => taxBucket(l) === "service", (l) => l.netCents), input.taxRates.serviceRate);
  const productTaxCents = applyRate(sum((l) => taxBucket(l) === "product", (l) => l.netCents), input.taxRates.productRate);
  const svcIdx = lines.map((l, i) => (taxBucket(l) === "service" ? i : -1)).filter((i) => i >= 0);
  const prdIdx = lines.map((l, i) => (taxBucket(l) === "product" ? i : -1)).filter((i) => i >= 0);
  allocateProportionally(serviceTaxCents, svcIdx.map((i) => lines[i].netCents)).forEach((t, k) => (lines[svcIdx[k]].taxCents = t));
  allocateProportionally(productTaxCents, prdIdx.map((i) => lines[i].netCents)).forEach((t, k) => (lines[prdIdx[k]].taxCents = t));

  const taxCents = serviceTaxCents + productTaxCents;
  const discountCents = discountBreakdown.reduce((a, d) => a + d.cents, 0);
  const tipCents = Math.max(0, Math.round(input.tipCents ?? 0));
  const preFeeTotalCents = serviceNetCents + productNetCents + giftCardSalesCents + taxCents + tipCents;

  // Gift cards can't buy gift cards.
  const giftPayable = preFeeTotalCents - giftCardSalesCents;
  const requestedGift = Math.max(0, input.tender.giftCardCents ?? 0);
  const giftCardAppliedCents = Math.min(
    requestedGift,
    input.tender.giftCardBalanceCents ?? requestedGift,
    giftPayable,
  );
  const primaryBaseCents = preFeeTotalCents - giftCardAppliedCents;

  const cfg = input.cardFee;
  const cardFeeRate = Math.min(Math.max(cfg.rate, 0), MAX_CARD_FEE_RATE);
  const fee = input.tender.method === "card" ? cardFeeFor(cfg, input.tender.cardFunding, { chargeCents: primaryBaseCents, tipCents }) : null;
  const cardFeeBaseCents = fee?.reason === "applies" ? fee.basisCents : 0;
  const cardFeeCents = fee?.feeCents ?? 0;

  const disclosures: string[] = [];
  const d = feeDisclosure({ ...cfg, rate: cardFeeRate });
  if (d) disclosures.push(d);
  if (fee?.label) disclosures.push(`${fee.label}: ${formatCents(cardFeeCents)}`);

  return {
    lines,
    serviceGrossCents,
    productGrossCents,
    giftCardSalesCents,
    discountCents,
    discountBreakdown,
    serviceNetCents,
    productNetCents,
    serviceTaxCents,
    productTaxCents,
    taxCents,
    tipCents,
    preFeeTotalCents,
    giftCardAppliedCents,
    primaryBaseCents,
    cardFeeBaseCents,
    cardFeeCents,
    cardFeeRate,
    totalCents: preFeeTotalCents + cardFeeCents,
    primaryChargeCents: primaryBaseCents + cardFeeCents,
    loyaltyEligibleCents: serviceNetCents,
    disclosures,
  };
}

/** Suggested tip amounts, based on the pre-discount service subtotal (what the barber did). */
export function tipSuggestions(serviceGrossCents: number, percents: number[]): { percent: number; cents: number }[] {
  return percents.map((p) => ({ percent: p, cents: Math.round((serviceGrossCents * p) / 100) }));
}
