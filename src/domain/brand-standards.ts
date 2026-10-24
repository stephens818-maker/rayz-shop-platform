/**
 * Brand standards vs local control. The brand owns the master catalog, marketing templates,
 * badges and policies; each governed field says whether a location may change it: freely ("open"),
 * within limits ("range", e.g. a price floor and ceiling), or not at all ("locked"). People with
 * access to every shop (the brand) aren't held to them; everyone else, franchisees included, is.
 * Pure: the field registry, the stored settings and the checks. Server actions call the checks.
 */
import { z } from "zod";
import type { LocalPrice } from "@/db/schema";

export type { LocalPrice };
export const LOCAL_PRICES = ["open", "range", "locked"] as const satisfies readonly LocalPrice[];
export const LOCAL_PRICE_LABEL: Record<LocalPrice, string> = {
  open: "Locations set their own price",
  range: "Locations price within the floor and ceiling",
  locked: "Brand price everywhere",
};

/** A catalog item's price standard, as stored on services and products. */
export interface PriceStandard {
  name: string;
  brandPriceCents: number;
  localPrice: LocalPrice;
  priceFloorCents: number | null;
  priceCeilingCents: number | null;
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** The brand's own setting: the brand price must sit inside its range, and the range must be a range. */
export function priceStandardProblem(s: Omit<PriceStandard, "name">): string | null {
  if (s.priceFloorCents != null && s.priceFloorCents < 0) return "The floor can't be negative";
  if (s.priceFloorCents != null && s.priceCeilingCents != null && s.priceFloorCents > s.priceCeilingCents) return "The floor is above the ceiling";
  if (s.localPrice === "range") {
    if (s.priceFloorCents == null && s.priceCeilingCents == null) return "Set a floor, a ceiling or both for a price range";
    if (s.priceFloorCents != null && s.brandPriceCents < s.priceFloorCents) return "The brand price is below the floor";
    if (s.priceCeilingCents != null && s.brandPriceCents > s.priceCeilingCents) return "The brand price is above the ceiling";
  }
  return null;
}

/**
 * A location's price for an item. Null follows the brand price and is always allowed; so is a
 * price equal to the brand's. Otherwise the item's standard decides.
 */
export function localPriceProblem(s: PriceStandard, cents: number | null): string | null {
  if (cents == null || cents === s.brandPriceCents) return null;
  if (s.localPrice === "locked") return `${s.name} is priced by the brand (${dollars(s.brandPriceCents)}) at every location`;
  if (s.localPrice === "range") {
    if (s.priceFloorCents != null && cents < s.priceFloorCents) return `${s.name} can't be priced below the brand's floor of ${dollars(s.priceFloorCents)}`;
    if (s.priceCeilingCents != null && cents > s.priceCeilingCents) return `${s.name} can't be priced above the brand's ceiling of ${dollars(s.priceCeilingCents)}`;
  }
  return null;
}

/** The limits a location's price must stay within, for the price field's hint. */
export function priceLimits(s: PriceStandard): { min: number | null; max: number | null; locked: boolean } {
  if (s.localPrice === "locked") return { min: s.brandPriceCents, max: s.brandPriceCents, locked: true };
  if (s.localPrice === "range") return { min: s.priceFloorCents, max: s.priceCeilingCents, locked: false };
  return { min: null, max: null, locked: false };
}

/** A service's name and duration at a location. */
export function localServiceProblem(s: { name: string; localName: boolean; localDuration: boolean }, o: { nameOverride: string | null; durationMin: number | null }): string | null {
  if (o.nameOverride && !s.localName) return `${s.name} keeps the brand's name at every location`;
  if (o.durationMin != null && !s.localDuration) return `${s.name} keeps the brand's duration at every location`;
  return null;
}

// ───────────────────────────── Shop policies ─────────────────────────────

/** A numeric shop policy: open, kept between min and max, or locked to the brand value. */
const NumberRule = z.object({
  mode: z.enum(["open", "range", "locked"]).default("open"),
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  /** The value every location uses when locked. */
  value: z.number().nullable().default(null),
});
export type NumberRule = z.output<typeof NumberRule>;

/** The numeric shop settings the brand can govern, with the units shown. */
export const SHOP_NUMBER_POLICIES = {
  cancelCutoffMinutes: { label: "Cancellation cutoff", unit: "minutes" },
  minLeadMinutes: { label: "Minimum notice to book online", unit: "minutes" },
  bookingWindowDays: { label: "How far ahead clients can book", unit: "days" },
  bufferMinutes: { label: "Gap between appointments", unit: "minutes" },
  cardFeeRate: { label: "Credit card fee", unit: "fraction (0.03 = 3%)" },
} as const;
export type ShopNumberPolicy = keyof typeof SHOP_NUMBER_POLICIES;

/** Settings that are the brand's or the location's, all or nothing. */
export const SHOP_TOGGLE_POLICIES = {
  cardFeeEnabled: "Whether the location charges the credit card fee",
  cardFeeAppliesToTip: "Whether the card fee applies to the tip",
  tipPresets: "Tip buttons on the customer screen",
  branding: "Booking page color and logo",
  receipt: "Receipt headline and footer",
} as const;
export type ShopTogglePolicy = keyof typeof SHOP_TOGGLE_POLICIES;

/**
 * Brand-owned content. "brand": only the brand edits it (today's behavior); "local": the brand
 * lets locations add their own version where the product offers one.
 */
export const CONTENT_POLICIES = {
  marketingTemplates: "Campaign and blast message templates",
  messageTemplates: "Client message wording (reminders, receipts, rebook links)",
  badges: "Client badges and their thresholds",
  coupons: "Coupons and promotions",
} as const;
export type ContentPolicy = keyof typeof CONTENT_POLICIES;

export type Toggle = "local" | "brand";
export type ContentRule = "brand" | "local";
export interface BrandStandards {
  shop: Record<ShopNumberPolicy, NumberRule>;
  toggles: Record<ShopTogglePolicy, Toggle>;
  content: Record<ContentPolicy, ContentRule>;
}

/** Stored standards read defensively: anything unreadable falls back to open. */
export function brandStandards(raw: unknown): BrandStandards {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const part = (k: string) => (o[k] && typeof o[k] === "object" ? o[k] : {});
  const shop: Record<string, unknown> = {};
  for (const k of Object.keys(SHOP_NUMBER_POLICIES)) {
    const r = NumberRule.safeParse((part("shop") as Record<string, unknown>)[k] ?? {});
    shop[k] = r.success ? r.data : NumberRule.parse({});
  }
  const toggles: Record<string, unknown> = {};
  for (const k of Object.keys(SHOP_TOGGLE_POLICIES)) {
    const v = (part("toggles") as Record<string, unknown>)[k];
    toggles[k] = v === "brand" ? "brand" : "local";
  }
  const content: Record<string, unknown> = {};
  for (const k of Object.keys(CONTENT_POLICIES)) {
    const v = (part("content") as Record<string, unknown>)[k];
    content[k] = v === "local" ? "local" : "brand";
  }
  return { shop, toggles, content } as unknown as BrandStandards;
}

export function numberRuleProblem(label: string, r: NumberRule): string | null {
  if (r.mode === "range") {
    if (r.min == null && r.max == null) return `${label}: set a minimum, a maximum or both`;
    if (r.min != null && r.max != null && r.min > r.max) return `${label}: the minimum is above the maximum`;
  }
  if (r.mode === "locked" && r.value == null) return `${label}: set the value every location uses`;
  return null;
}

export function standardsProblem(s: BrandStandards): string | null {
  for (const [k, meta] of Object.entries(SHOP_NUMBER_POLICIES)) {
    const p = numberRuleProblem(meta.label, s.shop[k as ShopNumberPolicy]);
    if (p) return p;
  }
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

/**
 * What a location may not change in this edit of its settings, as messages. Only changed fields
 * are checked, so a location saving other settings isn't blocked by a value the brand set.
 */
export function shopPolicyProblems(s: BrandStandards, before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, meta] of Object.entries(SHOP_NUMBER_POLICIES)) {
    if (!(k in after) || num(after[k]) === num(before[k])) continue;
    const r = s.shop[k as ShopNumberPolicy];
    const v = num(after[k]);
    if (v == null) continue;
    if (r.mode === "locked" && v !== r.value) out.push(`${meta.label} is set by the brand`);
    else if (r.mode === "range" && ((r.min != null && v < r.min) || (r.max != null && v > r.max)))
      out.push(`${meta.label} must be ${r.min != null && r.max != null ? `between ${r.min} and ${r.max}` : r.min != null ? `at least ${r.min}` : `at most ${r.max}`} ${meta.unit}`);
  }
  const branding = ["accentColor", "logoUrl"];
  for (const [k, label] of Object.entries(SHOP_TOGGLE_POLICIES)) {
    if (s.toggles[k as ShopTogglePolicy] !== "brand") continue;
    const fields = k === "branding" ? branding : [k];
    if (fields.some((f) => f in after && !same(after[f], before[f]))) out.push(`${label}: set by the brand`);
  }
  return out;
}

/** Whether locations may keep their own version of a kind of brand content. */
export const localContentAllowed = (s: BrandStandards, k: ContentPolicy) => s.content[k] === "local";
