import { allocateProportionally, applyRate, formatCents, formatRate } from "@/lib/money";
import { loyaltyEligibleCents } from "./loyalty";

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
  /** Which shop rate applies. Defaults by kind: services and add-ons at the service rate, products at the product rate. "exempt" is never taxed. */
  taxCategory?: TaxCategory;
}

export type TaxCategory = "service" | "product" | "exempt";

export type DiscountTarget = "services" | "products" | "all";

export interface Discount {
  source: "promo" | "manual" | "loyalty" | "membership";
  label: string;
  /** percent: value is whole percent (10 = 10%). amount: value is cents. */
  type: "percent" | "amount";
  value: number;
  appliesTo: DiscountTarget;
  refId?: string | null;
  /** Only lines for these services, add-ons or products (by refId); absent is every line appliesTo allows. */
  lineRefIds?: string[] | null;
  /** Only these lines (by key), e.g. a member's own services on a family ticket. */
  lineKeys?: string[] | null;
}

export interface TaxRates {
  /** Fractions, e.g. 0.07. Configured per shop, never hard-coded. */
  serviceRate: number;
  productRate: number;
}

export type CardFeeType = "percent" | "flat" | "both";
export type CardFeeRefundRule = "proportional" | "keep";

/**
 * The surcharge as it applies to one charge. The optional fields come from the brand's card fee
 * policy (src/domain/card-fee-policy.ts); left out, the fee is a plain percent as before it existed.
 */
export interface CardFeeConfig {
  enabled: boolean;
  /** Fraction, e.g. 0.03. There is no built-in cap; a shop's state limit, when one is saved, is the only ceiling. */
  rate: number;
  /** Whether the fee is charged on the tip portion paid by card. */
  appliesToTip: boolean;
  type?: CardFeeType;
  /** The flat part, for type flat or both. */
  flatCents?: number;
  /** Most one charge's fee can be. */
  capCents?: number | null;
  /** Least one charge's fee can be, still never above the legal limit. */
  minCents?: number | null;
  /** Apple Pay and Google Pay, each on or off. Left out, a wallet pays it only when walletFeeOn. */
  wallets?: { applePay: boolean; googlePay: boolean };
  /** The highest rate allowed where the shop is. Null or left out: no ceiling. */
  maxRate?: number | null;
  /** The name shown at checkout and on receipts. Left out: "Credit card fee". */
  name?: string | null;
  /** Turned off for this charge: the channel isn't one the fee applies to, or the shop's state isn't allowed. */
  off?: "channel_off" | "state_not_allowed";
  /** The brand's own notice; null uses the built-in one. "{fee}" becomes the rate or amount. */
  notice?: string | null;
  /** Whether staff may waive it on a ticket. Left out, they may. */
  waiverAllowed?: boolean;
  refundRule?: CardFeeRefundRule;
}

/** A rate above this is a typo, not a card-network rule. Charles sets the real rate; nothing hardcodes 3%. */
export const FEE_RATE_SANITY_MAX = 1;

export interface TenderPlan {
  giftCardCents?: number;
  /** Max redeemable from the gift card (its balance). */
  giftCardBalanceCents?: number;
  method: PrimaryMethod;
  /** From Stripe: PaymentMethod.card.funding (or card_present.funding for Terminal). */
  cardFunding?: CardFunding | null;
  /** The card came through Apple Pay or Google Pay ("apple_pay", "google_pay"): no surcharge unless walletFeeOn and the brand has that wallet on. */
  cardWallet?: boolean | string | null;
  walletFeeOn?: boolean;
  /** Staff waived the surcharge on this ticket. */
  waiveFee?: boolean;
}

/** Loyalty at the ticket's location: whether it runs there, and what counts beyond services. */
export interface LoyaltyBasis {
  on: boolean;
  includeProducts: boolean;
  includeTips: boolean;
}

export interface CheckoutInput {
  lines: CartLine[];
  discounts?: Discount[];
  taxRates: TaxRates;
  tipCents?: number;
  cardFee: CardFeeConfig;
  /** When true, sales tax is also charged on the credit card fee. Default false, pending the CPA. The fee is worked out first. */
  cardFeeTaxable?: boolean;
  tender: TenderPlan;
  /** Left out: services only, as before the brand could count products and tips. */
  loyalty?: LoyaltyBasis;
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
  /** The surcharge staff waived, what it would have been. */
  cardFeeWaivedCents: number;
  /** Why the surcharge is what it is on the primary card; null without a card. */
  cardFee: CardFeeResult | null;
  totalCents: number;
  primaryChargeCents: number;
  /** Net service dollars after discounts, before tax, plus products and tips when the brand counts them; 0 where loyalty doesn't run. Gift cards never count. */
  loyaltyEligibleCents: number;
  disclosures: string[];
}

const isService = (k: LineKind) => k === "service" || k === "addon";
const taxBucket = (l: CartLine): "service" | "product" | null => {
  if (l.kind === "gift_card" || l.taxCategory === "exempt") return null;
  return l.taxCategory ?? (isService(l.kind) ? "service" : "product");
};

function eligible(line: CartLine, target: DiscountTarget, refIds?: string[] | null, keys?: string[] | null) {
  if (line.kind === "gift_card") return false;
  if (keys && !keys.includes(line.key)) return false;
  if (refIds) return !!line.refId && refIds.includes(line.refId);
  if (target === "all") return true;
  if (target === "services") return isService(line.kind);
  return line.kind === "product";
}

/**
 * A manual discount must stay within the person's limits: a percent no higher than theirs, or an
 * amount no more than that share of the ticket (gift cards excluded), and never more dollars off
 * than their dollar limit when they have one.
 */
export function manualDiscountProblem(d: { type: "percent" | "amount"; value: number } | null, lines: CartLine[], maxPct: number, maxCents: number | null = null): string | null {
  if (!d || !(d.value > 0)) return null;
  if (maxPct <= 0 || maxCents === 0) return "You can't give manual discounts";
  const gross = lines.filter((l) => l.kind !== "gift_card").reduce((a, l) => a + Math.max(0, Math.round(l.unitPriceCents * l.qty)), 0);
  if (d.type === "percent") {
    if (d.value > maxPct) return `Your discount limit is ${maxPct}%`;
    if (maxCents !== null && Math.round((gross * d.value) / 100) > maxCents) return `Your discount limit is ${formatCents(maxCents)} a ticket`;
    return null;
  }
  const cap = Math.floor((gross * maxPct) / 100);
  if (d.value > cap) return `Your discount limit is ${maxPct}% of the ticket (${formatCents(cap)} here)`;
  return maxCents !== null && d.value > maxCents ? `Your discount limit is ${formatCents(maxCents)} a ticket` : null;
}

type FeeShape = Pick<CardFeeConfig, "rate"> & Partial<Pick<CardFeeConfig, "type" | "flatCents" | "maxRate">>;

/** A saved state ceiling, or no ceiling. */
export const feeMaxRate = (cfg: Pick<CardFeeConfig, "maxRate">) => (cfg.maxRate == null ? Number.POSITIVE_INFINITY : Math.max(0, cfg.maxRate));

function feeParts(cfg: FeeShape) {
  const type = cfg.type ?? "percent";
  const rate = type === "flat" ? 0 : Math.min(Math.max(cfg.rate, 0), feeMaxRate(cfg));
  const flatCents = type === "percent" ? 0 : Math.max(0, Math.round(cfg.flatCents ?? 0));
  return { type, rate, flatCents };
}

/** "3%", "$0.30" or "3% + $0.30". */
export function describeFee(cfg: FeeShape): string {
  const p = feeParts(cfg);
  return p.type === "flat" ? formatCents(p.flatCents) : p.type === "both" ? `${formatRate(p.rate)} + ${formatCents(p.flatCents)}` : formatRate(p.rate);
}

export function feeLabel(cfg: FeeShape & { name?: string | null }): string {
  const name = cfg.name?.trim() || "Credit card fee";
  return `${name} (${describeFee(cfg)})`;
}

export const DEFAULT_FEE_NOTICE = "A {fee} credit card fee applies to credit card payments only. It does not exceed our cost of acceptance. No fee on debit, prepaid, gift card, or cash.";

/** The notice shown at checkout and printed on receipts: the brand's own wording, or the built-in one. */
export function feeDisclosure(cfg: Pick<CardFeeConfig, "rate" | "enabled"> & Partial<CardFeeConfig>): string | null {
  const p = feeParts(cfg);
  if (!cfg.enabled || cfg.off || (p.rate <= 0 && p.flatCents <= 0)) return null;
  return (cfg.notice?.trim() || DEFAULT_FEE_NOTICE).replaceAll("{fee}", describeFee(cfg));
}

export type CardFeeBasis = "charge_excluding_tip" | "charge_including_tip";

export interface CardFeeResult {
  feeCents: number;
  /** The percent part used, after clamping to the legal limit; 0 when no fee applies. */
  rate: number;
  /** The flat part used; 0 when no fee applies. */
  flatCents: number;
  /** feeCents (or what was waived) over basisCents. */
  effectiveRate: number;
  basis: CardFeeBasis;
  /** The amount the rate was applied to. */
  basisCents: number;
  /** A surcharge is the shop's option, never required: staff may drop one that applies, unless the brand turned waivers off. */
  waivable: boolean;
  /** What a waived fee would have been. */
  waivedCents: number;
  /** What held the fee back from rate + flat: the brand's cap or minimum, or the legal limit. */
  limitedBy: "cap" | "min" | "legal" | null;
  /** Why no fee applies, when it doesn't. */
  reason: "applies" | "disabled" | "channel_off" | "state_not_allowed" | "not_credit" | "wallet_fee_off" | "zero_amount" | "waived";
  label: string | null;
  disclosure: string | null;
}

function walletAllowed(cfg: CardFeeConfig, wallet: boolean | string, walletFeeOn: boolean): boolean {
  if (!walletFeeOn) return false;
  if (!cfg.wallets) return true;
  if (wallet === "apple_pay") return cfg.wallets.applePay;
  if (wallet === "google_pay") return cfg.wallets.googlePay;
  return wallet === true && cfg.wallets.applePay && cfg.wallets.googlePay;
}

/**
 * The credit-card surcharge on one card charge. `chargeCents` is what goes on the card before the
 * fee, tip included; the tip is treated as the last thing paid, so at most `chargeCents` of it is on the card.
 * Percent and flat add up, then the minimum and the cap apply, and the legal limit always has the last word.
 */
export function cardFeeFor(
  cfg: CardFeeConfig,
  funding: CardFunding | null | undefined,
  amounts: { chargeCents: number; tipCents?: number },
  opts: { wallet?: boolean | string | null; walletFeeOn?: boolean; waive?: boolean } = {},
): CardFeeResult {
  const { rate, flatCents } = feeParts(cfg);
  const basis: CardFeeBasis = cfg.appliesToTip ? "charge_including_tip" : "charge_excluding_tip";
  const charge = Math.max(0, Math.round(amounts.chargeCents));
  const tipOnCharge = Math.min(Math.max(0, Math.round(amounts.tipCents ?? 0)), charge);
  const basisCents = charge - (cfg.appliesToTip ? 0 : tipOnCharge);
  const disclosure = feeDisclosure(cfg);
  const none = (reason: CardFeeResult["reason"]): CardFeeResult => ({
    feeCents: 0,
    rate: 0,
    flatCents: 0,
    effectiveRate: 0,
    basis,
    basisCents: 0,
    waivable: false,
    waivedCents: 0,
    limitedBy: null,
    reason,
    label: null,
    disclosure,
  });
  if (!cfg.enabled || (rate <= 0 && flatCents <= 0)) return none("disabled");
  if (cfg.off) return none(cfg.off);
  if (funding !== "credit") return none("not_credit");
  if (opts.wallet && !walletAllowed(cfg, opts.wallet, !!opts.walletFeeOn)) return none("wallet_fee_off");
  if (basisCents <= 0) return none("zero_amount");
  const raw = applyRate(basisCents, rate) + flatCents;
  let fee = raw;
  let limitedBy: CardFeeResult["limitedBy"] = null;
  if (cfg.minCents && cfg.minCents > 0 && fee < cfg.minCents) [fee, limitedBy] = [Math.round(cfg.minCents), "min"];
  if (cfg.capCents && cfg.capCents > 0 && fee > cfg.capCents) [fee, limitedBy] = [Math.round(cfg.capCents), "cap"];
  const legal = applyRate(basisCents, feeMaxRate(cfg));
  if (fee > legal) [fee, limitedBy] = [legal, "legal"];
  if (fee <= 0) return none("zero_amount");
  const waivable = cfg.waiverAllowed !== false;
  const base = { rate, flatCents, effectiveRate: fee / basisCents, basis, basisCents, waivable, limitedBy, disclosure };
  if (opts.waive && waivable) return { ...base, feeCents: 0, waivedCents: fee, reason: "waived", label: null };
  return { ...base, feeCents: fee, waivedCents: 0, reason: "applies", label: feeLabel(cfg) };
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
    const idx = lines.map((l, i) => (eligible(l, d.appliesTo, d.lineRefIds, d.lineKeys) ? i : -1)).filter((i) => i >= 0);
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
  let serviceTaxCents = applyRate(sum((l) => taxBucket(l) === "service", (l) => l.netCents), input.taxRates.serviceRate);
  let productTaxCents = applyRate(sum((l) => taxBucket(l) === "product", (l) => l.netCents), input.taxRates.productRate);
  const svcIdx = lines.map((l, i) => (taxBucket(l) === "service" ? i : -1)).filter((i) => i >= 0);
  const prdIdx = lines.map((l, i) => (taxBucket(l) === "product" ? i : -1)).filter((i) => i >= 0);
  allocateProportionally(serviceTaxCents, svcIdx.map((i) => lines[i].netCents)).forEach((t, k) => (lines[svcIdx[k]].taxCents = t));
  allocateProportionally(productTaxCents, prdIdx.map((i) => lines[i].netCents)).forEach((t, k) => (lines[prdIdx[k]].taxCents = t));

  let taxCents = serviceTaxCents + productTaxCents;
  const discountCents = discountBreakdown.reduce((a, d) => a + d.cents, 0);
  const tipCents = Math.max(0, Math.round(input.tipCents ?? 0));
  let preFeeTotalCents = serviceNetCents + productNetCents + giftCardSalesCents + taxCents + tipCents;

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
  const cardFeeRate = (cfg.type ?? "percent") === "flat" ? 0 : Math.min(Math.max(cfg.rate, 0), feeMaxRate(cfg));
  // The fee is worked out on the card's share of the subtotal (and the tip, when the shop says so), before sales tax.
  const preTaxOnCard = Math.max(0, primaryBaseCents - taxCents);
  const fee =
    input.tender.method === "card"
      ? cardFeeFor(cfg, input.tender.cardFunding, { chargeCents: preTaxOnCard, tipCents }, { wallet: input.tender.cardWallet, walletFeeOn: input.tender.walletFeeOn, waive: input.tender.waiveFee })
      : null;
  const cardFeeBaseCents = fee?.reason === "applies" ? fee.basisCents : 0;
  const cardFeeCents = fee?.feeCents ?? 0;
  let feeTaxCents = 0;
  if (input.cardFeeTaxable && cardFeeCents > 0) {
    feeTaxCents = applyRate(cardFeeCents, serviceNetCents > 0 ? input.taxRates.serviceRate : input.taxRates.productRate);
    if (serviceNetCents > 0) serviceTaxCents += feeTaxCents;
    else productTaxCents += feeTaxCents;
    taxCents += feeTaxCents;
    preFeeTotalCents += feeTaxCents;
  }

  const disclosures: string[] = [];
  const d = feeDisclosure(cfg);
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
    cardFeeWaivedCents: fee?.waivedCents ?? 0,
    cardFee: fee,
    totalCents: preFeeTotalCents + cardFeeCents,
    primaryChargeCents: primaryBaseCents + feeTaxCents + cardFeeCents,
    loyaltyEligibleCents: !input.loyalty ? serviceNetCents : input.loyalty.on ? loyaltyEligibleCents({ serviceNetCents, productNetCents, tipCents }, input.loyalty) : 0,
    disclosures,
  };
}

/** Suggested tip amounts, based on the pre-discount service subtotal (what the barber did). */
export function tipSuggestions(serviceGrossCents: number, percents: number[]): { percent: number; cents: number }[] {
  return percents.map((p) => ({ percent: p, cents: Math.round((serviceGrossCents * p) / 100) }));
}
