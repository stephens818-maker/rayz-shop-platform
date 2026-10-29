/**
 * The credit card fee (surcharge) policy: set by the brand, with an optional override per shop.
 *
 * Guardrails that no setting can get around: the fee only ever applies to credit cards (never
 * debit, prepaid, gift cards or cash), and it's off in any state not on the allowlist. New shops
 * start at 3%. There is no cap. A shop can change the rate or turn the fee off. A state ceiling
 * applies only when one is saved.
 */
import { CardFeeConfig, CardFeeRefundRule, CardFeeType, FEE_RATE_SANITY_MAX, describeFee } from "./checkout";

export const FEE_CHANNELS = ["pos", "app", "deposit", "card_on_file"] as const;
export type FeeChannel = (typeof FEE_CHANNELS)[number];
export const FEE_CHANNEL_LABEL: Record<FeeChannel, string> = {
  pos: "POS (counter and customer screen)",
  app: "In the app",
  deposit: "Booking deposits",
  card_on_file: "Charges to a card on file",
};

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "PR", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

/** States where we don't surcharge by default; to be confirmed by Charles (state law changes). */
export const SURCHARGE_BLOCKED_STATES = ["CT", "MA", "ME", "PR"] as const;
/** State ceilings start empty. A lower limit is saved here only when Charles enters one. */
export const DEFAULT_STATE_MAX_RATES: Record<string, number> = {};

/** Which shops the brand's surcharge is used at. A new location is in "all", and not in "selected" until it's ticked. */
export const FEE_APPLY_TO = ["all", "selected", "none"] as const;
export type FeeApplyTo = (typeof FEE_APPLY_TO)[number];
export const FEE_APPLY_TO_LABEL: Record<FeeApplyTo, string> = { all: "All shops", selected: "Selected shops", none: "No shops" };

export const FEE_NOTICE_MAX = 400;
export const FEE_FLAT_MAX_CENTS = 1000;

export interface CardFeePolicy {
  enabled: boolean;
  type: CardFeeType;
  /** Fraction, e.g. 0.03; for type percent or both. 0 means no rate has been entered. */
  rate: number;
  /** Shown at checkout, on receipts and in the apps. */
  label: string;
  /** Sales tax on the fee itself. Off until the CPA says otherwise. The fee is worked out first. */
  cardFeeTaxable: boolean;
  /** For type flat or both. */
  flatCents: number;
  appliesToTip: boolean;
  capCents: number | null;
  minCents: number | null;
  channels: Record<FeeChannel, boolean>;
  /**
   * Card types beyond credit. Debit and prepaid stay off: card network rules and federal law don't
   * allow surcharging them, so saving them on is refused. Wallets also need FEATURE_WALLET_FEE.
   */
  funding: { debit: boolean; prepaid: boolean; applePay: boolean; googlePay: boolean };
  /** Brand only: whether staff may waive the fee on a ticket, with a reason. */
  waiverAllowed: boolean;
  /** Brand only: on a refund, give back the fee's share of what's refunded, or keep it. A void always gives it back. */
  refundRule: CardFeeRefundRule;
  /** The notice at checkout and on receipts; null uses the built-in wording. "{fee}" becomes the rate or amount. */
  notice: string | null;
  /** Brand only: the states (two-letter codes) where the fee may apply. A shop elsewhere, or with no state, charges none. */
  states: string[];
  /** Brand only: lower limits for states that set one. */
  stateMaxRates: Record<string, number>;
  /** Brand only: the shops that use the fee. A shop it doesn't apply to charges none, whatever its own setting says. */
  appliesTo: FeeApplyTo;
  /** Brand only: the shops for "selected". */
  shopIds: string[];
  /** Brand only: whether people who edit a shop's checkout settings may change that shop's own fee. Otherwise they only see it. */
  shopsCanEdit: boolean;
}

/** What a shop may change. Waivers, refunds, the state rules and which shops use it are the brand's alone. */
export type CardFeeOverride = Partial<Pick<CardFeePolicy, "enabled" | "type" | "rate" | "flatCents" | "appliesToTip" | "capCents" | "minCents" | "notice" | "label" | "cardFeeTaxable">> & {
  channels?: Partial<CardFeePolicy["channels"]>;
  funding?: Partial<CardFeePolicy["funding"]>;
};
export const OVERRIDE_KEYS = ["enabled", "type", "rate", "flatCents", "appliesToTip", "capCents", "minCents", "notice", "label", "cardFeeTaxable", "channels", "funding"] as const;

/** New shops start at 3%. There is no cap. A shop can change the rate or turn the fee off. */
export const DEFAULT_FEE_LABEL = "Credit card fee";
export const DEFAULT_CARD_FEE_RATE = 0.03;

export const DEFAULT_CARD_FEE_POLICY: CardFeePolicy = {
  enabled: true,
  type: "percent",
  rate: DEFAULT_CARD_FEE_RATE,
  label: DEFAULT_FEE_LABEL,
  cardFeeTaxable: false,
  flatCents: 0,
  appliesToTip: false,
  capCents: null,
  minCents: null,
  channels: { pos: true, app: true, deposit: true, card_on_file: true },
  funding: { debit: false, prepaid: false, applePay: false, googlePay: false },
  waiverAllowed: true,
  refundRule: "proportional",
  notice: null,
  states: US_STATES.filter((s) => !(SURCHARGE_BLOCKED_STATES as readonly string[]).includes(s)),
  stateMaxRates: DEFAULT_STATE_MAX_RATES,
  appliesTo: "all",
  shopIds: [],
  shopsCanEdit: false,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const centsOrNull = (v: unknown, d: number | null) => (v === null ? null : typeof v === "number" && Number.isInteger(v) && v > 0 ? v : d);

function mergeLayer(base: CardFeePolicy, raw: unknown, brand: boolean): CardFeePolicy {
  if (!isObj(raw)) return base;
  const ch = isObj(raw.channels) ? raw.channels : {};
  const fu = isObj(raw.funding) ? raw.funding : {};
  const out: CardFeePolicy = {
    ...base,
    enabled: bool(raw.enabled, base.enabled),
    type: raw.type === "percent" || raw.type === "flat" || raw.type === "both" ? raw.type : base.type,
    rate: num(raw.rate, base.rate),
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 40) : base.label,
    cardFeeTaxable: bool(raw.cardFeeTaxable, base.cardFeeTaxable),
    flatCents: Math.max(0, Math.round(num(raw.flatCents, base.flatCents))),
    appliesToTip: bool(raw.appliesToTip, base.appliesToTip),
    capCents: "capCents" in raw ? centsOrNull(raw.capCents, base.capCents) : base.capCents,
    minCents: "minCents" in raw ? centsOrNull(raw.minCents, base.minCents) : base.minCents,
    channels: Object.fromEntries(FEE_CHANNELS.map((c) => [c, bool(ch[c], base.channels[c])])) as CardFeePolicy["channels"],
    funding: {
      debit: bool(fu.debit, base.funding.debit),
      prepaid: bool(fu.prepaid, base.funding.prepaid),
      applePay: bool(fu.applePay, base.funding.applePay),
      googlePay: bool(fu.googlePay, base.funding.googlePay),
    },
    notice: "notice" in raw ? (typeof raw.notice === "string" && raw.notice.trim() ? raw.notice.trim().slice(0, FEE_NOTICE_MAX) : null) : base.notice,
  };
  if (!brand) return out;
  return {
    ...out,
    waiverAllowed: bool(raw.waiverAllowed, base.waiverAllowed),
    refundRule: raw.refundRule === "keep" || raw.refundRule === "proportional" ? raw.refundRule : base.refundRule,
    states: Array.isArray(raw.states) ? [...new Set(raw.states.filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()))].filter((s) => (US_STATES as readonly string[]).includes(s)).sort() : base.states,
    stateMaxRates: isObj(raw.stateMaxRates)
      ? Object.fromEntries(Object.entries(raw.stateMaxRates).flatMap(([k, v]) => (typeof v === "number" && v >= 0 && v <= FEE_RATE_SANITY_MAX ? [[k.toUpperCase(), v]] : [])))
      : base.stateMaxRates,
    appliesTo: (FEE_APPLY_TO as readonly unknown[]).includes(raw.appliesTo) ? (raw.appliesTo as FeeApplyTo) : base.appliesTo,
    shopIds: Array.isArray(raw.shopIds) ? [...new Set(raw.shopIds.filter((s): s is string => typeof s === "string" && UUID.test(s)).map((s) => s.toLowerCase()))].sort() : base.shopIds,
    shopsCanEdit: bool(raw.shopsCanEdit, base.shopsCanEdit),
  };
}

/** The brand's policy (brand_settings.card_fee); missing keys use the defaults. */
export const brandCardFeePolicy = (raw: unknown): CardFeePolicy => mergeLayer(DEFAULT_CARD_FEE_POLICY, raw, true);

/** A shop's policy: the brand's, with the shop's override (shops.card_fee_override) on top. */
export const shopCardFeePolicy = (brand: CardFeePolicy, override: unknown): CardFeePolicy => mergeLayer(brand, override, false);

/** Only the keys a shop may set, and only those that differ from the brand's. Null when nothing does. */
export function cleanOverride(brand: CardFeePolicy, raw: unknown): CardFeeOverride | null {
  if (!isObj(raw)) return null;
  const merged = shopCardFeePolicy(brand, raw);
  const out: Record<string, unknown> = {};
  for (const k of OVERRIDE_KEYS) {
    if (!(k in raw)) continue;
    if (k === "channels" || k === "funding") {
      const diff = Object.fromEntries(Object.entries(merged[k]).filter(([kk, v]) => v !== (brand[k] as Record<string, boolean>)[kk]));
      if (Object.keys(diff).length) out[k] = diff;
    } else if (merged[k] !== brand[k]) out[k] = merged[k];
  }
  return Object.keys(out).length ? (out as CardFeeOverride) : null;
}

export const normalState = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** Where the shop is decides whether the fee may apply there at all, and the highest rate. */
export function stateRule(p: Pick<CardFeePolicy, "states" | "stateMaxRates">, shopState: string | null | undefined): { allowed: boolean; maxRate: number | null } {
  const st = normalState(shopState);
  const cap = p.stateMaxRates[st];
  return { allowed: !!st && p.states.includes(st), maxRate: cap == null ? null : cap };
}

/** The fee config for one charge: this shop's policy on this channel. */
export function feeConfigFor(p: CardFeePolicy, shopState: string | null | undefined, channel: FeeChannel): CardFeeConfig {
  const st = stateRule(p, shopState);
  return {
    enabled: p.enabled,
    type: p.type,
    rate: st.maxRate == null ? p.rate : Math.min(p.rate, st.maxRate),
    name: p.label,
    flatCents: p.flatCents,
    appliesToTip: p.appliesToTip,
    capCents: p.capCents,
    minCents: p.minCents,
    wallets: { applePay: p.funding.applePay, googlePay: p.funding.googlePay },
    maxRate: st.maxRate,
    ...(!p.channels[channel] ? { off: "channel_off" as const } : !st.allowed ? { off: "state_not_allowed" as const } : {}),
    notice: p.notice,
    waiverAllowed: p.waiverAllowed,
    refundRule: p.refundRule,
  };
}

/** Why a policy (the brand's, or a shop's merged with it) can't be saved, or null. */
export function policyProblem(p: CardFeePolicy): string | null {
  if (p.funding.debit || p.funding.prepaid) return "Surcharges are only allowed on credit cards. Card network rules and federal law don't allow them on debit or prepaid cards.";
  if (!Number.isFinite(p.rate) || p.rate < 0) return "The rate can't be negative";
  if (p.rate > FEE_RATE_SANITY_MAX) return "Enter the credit card fee rate as a percent from 0 to 100";
  if (!Number.isInteger(p.flatCents) || p.flatCents < 0 || p.flatCents > FEE_FLAT_MAX_CENTS) return `The flat fee is from $0.00 to $${(FEE_FLAT_MAX_CENTS / 100).toFixed(2)}`;
  if (p.enabled && p.type !== "flat" && p.rate <= 0) return "Enter a credit card fee rate before turning it on";
  if (p.enabled && p.type !== "percent" && p.flatCents <= 0) return "Set a flat amount above $0.00, or choose percent";
  if (p.capCents != null && (!Number.isInteger(p.capCents) || p.capCents <= 0)) return "The cap must be more than $0.00";
  if (p.minCents != null && (!Number.isInteger(p.minCents) || p.minCents <= 0)) return "The minimum must be more than $0.00";
  if (p.capCents != null && p.minCents != null && p.minCents > p.capCents) return "The minimum can't be more than the cap";
  if (p.notice != null && p.notice.length > FEE_NOTICE_MAX) return `The notice is at most ${FEE_NOTICE_MAX} characters`;
  const bad = p.states.find((s) => !(US_STATES as readonly string[]).includes(s));
  if (bad) return `${bad} isn't a US state code`;
  const over = Object.entries(p.stateMaxRates).find(([, r]) => !(r >= 0 && r <= FEE_RATE_SANITY_MAX));
  if (over) return `The limit for ${over[0]} must be from 0% to 100%`;
  return null;
}

export const feeAppliesToShop = (brand: Pick<CardFeePolicy, "appliesTo" | "shopIds">, shopId: string) =>
  brand.appliesTo === "all" || (brand.appliesTo === "selected" && brand.shopIds.includes(shopId));

/** What a shop charges: its own policy, turned off where the brand doesn't apply the fee. */
export function effectiveShopPolicy(brand: CardFeePolicy, override: unknown, shopId: string): CardFeePolicy {
  const p = shopCardFeePolicy(brand, override);
  return feeAppliesToShop(brand, shopId) ? p : { ...p, enabled: false };
}

/** Why a shop charges no surcharge: the brand doesn't apply it there, it's turned off, or the shop's state isn't allowed. */
export type ShopFeeOff = "not_applied" | "turned_off" | "state_not_allowed";
export const SHOP_FEE_OFF_LABEL: Record<ShopFeeOff, string> = {
  not_applied: "Not applied by the brand",
  turned_off: "Turned off",
  state_not_allowed: "State not allowed",
};

export interface ShopFeeState {
  on: boolean;
  off: ShopFeeOff | null;
  /** The brand applies the fee at this shop. */
  applied: boolean;
  /** No override: the shop uses the brand's settings. */
  inherits: boolean;
  /** The settings the shop sets itself, when it doesn't inherit. */
  ownKeys: string[];
  /** "3%", "$0.30" or "3% + $0.30", after the state's limit. */
  fee: string;
  appliesToTip: boolean;
}

export function shopFeeState(brand: CardFeePolicy, override: unknown, shopId: string, shopState: string | null | undefined): ShopFeeState {
  const p = shopCardFeePolicy(brand, override);
  const applied = feeAppliesToShop(brand, shopId);
  const off: ShopFeeOff | null = !applied ? "not_applied" : !p.enabled ? "turned_off" : !stateRule(p, shopState).allowed ? "state_not_allowed" : null;
  const own = cleanOverride(brand, override);
  return { on: !off, off, applied, inherits: !own, ownKeys: own ? Object.keys(own) : [], fee: describeFee(feeConfigFor(p, shopState, "pos")), appliesToTip: p.appliesToTip };
}

/** Everything that decides what a shop charges, on every channel: if this changes, the shop's fee changed. */
export const shopFeeFingerprint = (p: CardFeePolicy, shopState: string | null | undefined) => JSON.stringify(FEE_CHANNELS.map((c) => feeConfigFor(p, shopState, c)));

export const BULK_FEE_ACTIONS = ["enable", "disable", "brand_rate", "reset", "push"] as const;
export type BulkFeeAction = (typeof BULK_FEE_ACTIONS)[number];
export const BULK_FEE_ACTION_LABEL: Record<BulkFeeAction, string> = {
  enable: "Enable",
  disable: "Disable",
  brand_rate: "Apply brand rate",
  reset: "Reset to brand default",
  push: "Push brand settings",
};

/**
 * Which shops the brand applies the fee to after turning it on or off at some. Turning one off under
 * "all" lists every other shop, so locations added later aren't included until they're ticked.
 */
export function withShopsApplied(brand: Pick<CardFeePolicy, "appliesTo" | "shopIds">, ids: readonly string[], on: boolean, allShopIds: readonly string[]): Pick<CardFeePolicy, "appliesTo" | "shopIds"> {
  if (brand.appliesTo === "all" && on) return { appliesTo: "all", shopIds: brand.shopIds };
  if (brand.appliesTo === "none" && !on) return { appliesTo: "none", shopIds: brand.shopIds };
  const set = new Set(brand.appliesTo === "all" ? allShopIds : brand.appliesTo === "selected" ? brand.shopIds : []);
  for (const id of ids) if (on) set.add(id);
    else set.delete(id);
  return { appliesTo: "selected", shopIds: [...set].sort() };
}

/**
 * A shop's override after a bulk action. Enable turns the shop's own "off" back on; Apply brand rate
 * drops its own fee type, rate and flat amount; Reset and Push drop the override altogether.
 * Disable leaves it alone (the brand stops applying the fee there instead).
 */
export function bulkOverride(action: BulkFeeAction, brand: CardFeePolicy, override: unknown): CardFeeOverride | null {
  const cur = cleanOverride(brand, override);
  if (action === "reset" || action === "push") return null;
  if (action === "disable") return cur;
  if (action === "enable") return shopCardFeePolicy(brand, cur).enabled ? cur : cleanOverride(brand, { ...cur, enabled: true });
  const { type: _t, rate: _r, flatCents: _f, ...rest } = cur ?? {};
  return cleanOverride(brand, rest);
}

/** What's different between two policies, for the audit log. */
export function policyDiff(before: unknown, after: unknown): Record<string, { from: unknown; to: unknown }> {
  const a = (isObj(before) ? before : {}) as Record<string, unknown>;
  const b = (isObj(after) ? after : {}) as Record<string, unknown>;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) out[k] = { from: a[k] ?? null, to: b[k] ?? null };
  return out;
}
