import { sql } from "drizzle-orm";
import { db } from "@/db";
import { taxJurisdiction, taxJurisdictionLabel } from "@/domain/location-profile";
import { LocationTaxRow } from "@/domain/tax-fees";

export interface LocationTaxFees extends LocationTaxRow {
  status: string;
  cardFeeEnabled: boolean;
  cardFeeRate: number;
  cardFeeAppliesToTip: boolean;
  tickets: number;
  serviceTaxCents: number;
  productTaxCents: number;
  cardFeeCents: number;
}

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;

/** Each location's tax rates and jurisdiction beside its card-fee setup, with what each collected on tickets in the period. */
export async function taxesAndFees(shopIds: string[], from: string, to: string): Promise<LocationTaxFees[]> {
  const rows = (await db.execute(sql`
    select sh.id, sh.name, sh.status, sh.state, sh.city, sh.tax_jurisdiction, sh.service_tax_rate, sh.product_tax_rate, sh.tax_rates_verified,
      sh.card_fee_enabled, sh.card_fee_rate, sh.card_fee_applies_to_tip,
      count(s.id)::int tickets, coalesce(sum(s.service_tax_cents), 0)::int service_tax, coalesce(sum(s.product_tax_cents), 0)::int product_tax, coalesce(sum(s.card_fee_cents), 0)::int card_fee
    from shops sh
    left join sales s on s.shop_id = sh.id and s.status in ('paid', 'refunded', 'partially_refunded') and s.business_date between ${from}::date and ${to}::date
    where sh.id in ${uuids(shopIds)} and (sh.status <> 'archived' or s.id is not null)
    group by sh.id
    order by sh.name`)) as unknown as {
    id: string;
    name: string;
    status: string;
    state: string;
    city: string;
    tax_jurisdiction: unknown;
    service_tax_rate: string;
    product_tax_rate: string;
    tax_rates_verified: boolean;
    card_fee_enabled: boolean;
    card_fee_rate: string;
    card_fee_applies_to_tip: boolean;
    tickets: number;
    service_tax: number;
    product_tax: number;
    card_fee: number;
  }[];
  return rows.map((r) => {
    const j = taxJurisdiction(r.tax_jurisdiction);
    return {
      shopId: r.id,
      shop: r.name,
      status: r.status,
      jurisdiction: taxJurisdictionLabel(r.state, { ...j, city: j.city ?? (r.city || null) }) || "Not set",
      serviceTaxRate: Number(r.service_tax_rate),
      productTaxRate: Number(r.product_tax_rate),
      verified: r.tax_rates_verified,
      cardFeeEnabled: r.card_fee_enabled,
      cardFeeRate: Number(r.card_fee_rate),
      cardFeeAppliesToTip: r.card_fee_applies_to_tip,
      tickets: r.tickets,
      serviceTaxCents: r.service_tax,
      productTaxCents: r.product_tax,
      cardFeeCents: r.card_fee,
    };
  });
}
