/**
 * Receipt tax lines. A line appears only when that tax was charged. The default wording is the
 * jurisdiction. A shop can replace each label, and can split the service tax into state and city lines.
 * The charged rates stay the shop's service and product rates. This only names the lines.
 */
import { allocateProportionally } from "@/lib/money";

const STATE_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "the District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

export interface TaxDisplay {
  stateRate: number | null;
  cityRate: number | null;
  stateLabel: string | null;
  cityLabel: string | null;
  productLabel: string | null;
}

export const EMPTY_TAX_DISPLAY: TaxDisplay = { stateRate: null, cityRate: null, stateLabel: null, cityLabel: null, productLabel: null };

const rateOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 0.2 ? v : null);
const labelOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);

/** Labels and an optional state/city split saved on shops.receipt.taxDisplay. */
export function taxDisplayOf(receipt: unknown): TaxDisplay {
  const root = receipt && typeof receipt === "object" ? (receipt as { taxDisplay?: unknown }).taxDisplay : null;
  if (!root || typeof root !== "object") return { ...EMPTY_TAX_DISPLAY };
  const r = root as Record<string, unknown>;
  return { stateRate: rateOf(r.stateRate), cityRate: rateOf(r.cityRate), stateLabel: labelOf(r.stateLabel), cityLabel: labelOf(r.cityLabel), productLabel: labelOf(r.productLabel) };
}

export function defaultStateTaxLabel(state: string): string {
  const code = state.trim().toUpperCase();
  const name = STATE_NAME[code] ?? (code || "this state");
  return `State of ${name} sales tax`;
}

export function defaultCityTaxLabel(city: string): string {
  const name = city.trim();
  return name ? `City of ${name} sales tax` : "City sales tax";
}

export interface ReceiptTaxInput {
  state: string;
  city: string;
  serviceTaxCents: number;
  productTaxCents: number;
  serviceRate: number;
  productRate: number;
  stateRate?: number | null;
  cityRate?: number | null;
  stateLabel?: string | null;
  cityLabel?: string | null;
  productLabel?: string | null;
}

export interface ReceiptTaxLine {
  label: string;
  cents: number;
  rate: number;
}

/** The tax rows on a receipt. Nothing is listed when that tax is zero. */
export function receiptTaxLines(o: ReceiptTaxInput): ReceiptTaxLine[] {
  const lines: ReceiptTaxLine[] = [];
  const stateLabel = labelOf(o.stateLabel) ?? defaultStateTaxLabel(o.state);
  const cityLabel = labelOf(o.cityLabel) ?? defaultCityTaxLabel(o.city);
  const stateRate = rateOf(o.stateRate);
  const cityRate = rateOf(o.cityRate);
  if (o.serviceTaxCents > 0) {
    if (stateRate && cityRate) {
      const [stateCents, cityCents] = allocateProportionally(o.serviceTaxCents, [stateRate, cityRate]);
      if (stateCents > 0) lines.push({ label: stateLabel, cents: stateCents, rate: stateRate });
      if (cityCents > 0) lines.push({ label: cityLabel, cents: cityCents, rate: cityRate });
    } else if (cityRate) lines.push({ label: cityLabel, cents: o.serviceTaxCents, rate: cityRate });
    else lines.push({ label: stateLabel, cents: o.serviceTaxCents, rate: stateRate ?? o.serviceRate });
  }
  if (o.productTaxCents > 0) {
    const productLabel = labelOf(o.productLabel) ?? (o.serviceTaxCents > 0 ? "Product sales tax" : stateLabel);
    lines.push({ label: productLabel, cents: o.productTaxCents, rate: o.productRate });
  }
  return lines;
}

/** Rates frozen on the ticket when it opened, otherwise the shop's current rates. */
export function saleTaxRates(pricing: unknown, shop: { serviceTaxRate: string | number; productTaxRate: string | number }): { serviceRate: number; productRate: number } {
  const p = pricing && typeof pricing === "object" ? (pricing as { taxRates?: { serviceRate?: unknown; productRate?: unknown }; openedRates?: { taxRates?: { serviceRate?: unknown; productRate?: unknown } } }) : {};
  const t = p.openedRates?.taxRates ?? p.taxRates;
  const n = (v: unknown, fallback: string | number) => (typeof v === "number" && Number.isFinite(v) ? v : Number(fallback));
  return { serviceRate: n(t?.serviceRate, shop.serviceTaxRate), productRate: n(t?.productRate, shop.productTaxRate) };
}

export function shopReceiptTaxLines(
  shop: { state: string; city: string; serviceTaxRate: string | number; productTaxRate: string | number; receipt: unknown },
  amounts: { serviceTaxCents: number; productTaxCents: number },
  pricing?: unknown,
): ReceiptTaxLine[] {
  const rates = saleTaxRates(pricing, shop);
  return receiptTaxLines({ state: shop.state, city: shop.city, ...amounts, ...rates, ...taxDisplayOf(shop.receipt) });
}
