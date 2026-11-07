/**
 * Picklists the brand edits under Setup → Picklists. Staff pick from them but can still type
 * something else, so a missing entry never blocks a sale.
 */

export const LOOKUP_DEFS = {
  serviceCategories: {
    label: "Service categories",
    hint: "Groups on the booking menu and in reports",
    defaults: ["Haircuts", "Beard", "Shaves", "Kids", "Add-ons"],
  },
  productCategories: {
    label: "Product categories",
    hint: "Retail groups in inventory, purchasing and reports",
    defaults: ["Styling", "Hair care", "Beard care", "Tools"],
  },
  refundReasons: {
    label: "Refund and void reasons",
    hint: "Quick picks on the refund screen; Today flags unusual refunds",
    defaults: ["Client unhappy with service", "Rang up the wrong item", "Duplicate charge", "Product returned"],
  },
  discountReasons: {
    label: "Discount reasons",
    hint: "Quick picks for a manual discount at checkout",
    defaults: ["Military", "First responder", "Senior", "Student", "Make-good", "Staff"],
  },
  priceChangeReasons: {
    label: "Price change reasons",
    hint: "Quick picks when a line's price is changed at checkout",
    defaults: ["Long or thick hair", "Extra time", "Price match", "Make-good"],
  },
  clientSources: {
    label: "Client sources",
    hint: "How a client found us, on their profile and as a client filter",
    defaults: ["Walk-in", "Online booking", "Referral", "Google", "Instagram", "Facebook", "Drove by", "Squire import"],
  },
} as const;

export type LookupKey = keyof typeof LOOKUP_DEFS;
export const LOOKUP_KEYS = Object.keys(LOOKUP_DEFS) as LookupKey[];
export type Lookups = Record<LookupKey, string[]>;
export type SavedLookups = Partial<Record<LookupKey, string[]>>;

export const MAX_ITEMS = 40;
export const MAX_ITEM = 48;

/** Trimmed, blank and repeated (case-insensitive) entries dropped, order kept. */
export function cleanList(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.replace(/\s+/g, " ").trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export function listProblem(items: readonly string[]): string | null {
  const clean = cleanList(items);
  if (!clean.length) return "Keep at least one entry";
  if (clean.length > MAX_ITEMS) return `Keep it to ${MAX_ITEMS} entries`;
  const long = clean.find((x) => x.length > MAX_ITEM);
  if (long) return `"${long.slice(0, 20)}…" is too long (max ${MAX_ITEM} characters)`;
  return null;
}

/** The saved lists, with defaults for any never saved. */
export function resolveLookups(saved: SavedLookups | null | undefined): Lookups {
  return Object.fromEntries(LOOKUP_KEYS.map((k) => [k, saved?.[k]?.length ? cleanList(saved[k]!) : [...LOOKUP_DEFS[k].defaults]])) as Lookups;
}
