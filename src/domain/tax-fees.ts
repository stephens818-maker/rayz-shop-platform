/**
 * Sales tax and card fees are separate models: tax is owed to a jurisdiction and set per location;
 * the card fee is the brand's surcharge to cover processing and is never reported as tax.
 */

export interface LocationTaxRow {
  shopId: string;
  shop: string;
  /** Human label, e.g. "TX · Harris County · Houston". */
  jurisdiction: string;
  serviceTaxRate: number;
  productTaxRate: number;
  verified: boolean;
}

export interface JurisdictionGroup {
  jurisdiction: string;
  shops: LocationTaxRow[];
  /** Locations in one jurisdiction owe the same rate; a split usually means a typo. */
  mismatch: boolean;
}

export function jurisdictionGroups(rows: LocationTaxRow[]): JurisdictionGroup[] {
  const by = new Map<string, LocationTaxRow[]>();
  for (const r of rows) by.set(r.jurisdiction, [...(by.get(r.jurisdiction) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([jurisdiction, shops]) => ({
      jurisdiction,
      shops,
      mismatch: new Set(shops.map((s) => `${s.serviceTaxRate}|${s.productTaxRate}`)).size > 1,
    }));
}

/** "8.25%" from 0.0825, without float noise. */
export const ratePct = (rate: number) => `${Number((rate * 100).toFixed(3))}%`;
