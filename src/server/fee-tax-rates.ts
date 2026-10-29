/**
 * Effective-dated credit card fee and sales tax. The newest row at or before `at` wins.
 * A shop's card fee falls back to the brand's row, then to the shop's current column, then null (no fee).
 * Sales tax falls back to the shop's current columns (0 until someone enters a rate).
 */
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { cardFeeRates, salesTaxRates, shops } from "@/db/schema";

export async function recordCardFeeRate(tx: DBorTx, row: { shopId: string | null; rate: number; label?: string | null; at?: Date; followsBrand?: boolean }) {
  await tx.insert(cardFeeRates).values({
    shopId: row.shopId,
    rate: row.rate.toFixed(5),
    label: row.label ?? null,
    followsBrand: row.followsBrand ?? false,
    effectiveAt: row.at ?? new Date(),
  });
}

export async function recordSalesTaxRate(tx: DBorTx, row: { shopId: string; serviceRate: number; productRate: number; at?: Date }) {
  await tx.insert(salesTaxRates).values({
    shopId: row.shopId,
    serviceRate: row.serviceRate.toFixed(5),
    productRate: row.productRate.toFixed(5),
    effectiveAt: row.at ?? new Date(),
  });
}

/** Shop rate effective at `at`, then the brand's, then the shop's current column, then null. */
export async function getCardFeeRate(shopId: string, at: Date, tx: DBorTx = db): Promise<number | null> {
  const [shop] = await tx
    .select({ rate: cardFeeRates.rate, followsBrand: cardFeeRates.followsBrand })
    .from(cardFeeRates)
    .where(and(eq(cardFeeRates.shopId, shopId), lte(cardFeeRates.effectiveAt, at)))
    .orderBy(desc(cardFeeRates.effectiveAt))
    .limit(1);
  if (shop && !shop.followsBrand) return Number(shop.rate);
  const [brand] = await tx
    .select({ rate: cardFeeRates.rate })
    .from(cardFeeRates)
    .where(and(isNull(cardFeeRates.shopId), lte(cardFeeRates.effectiveAt, at)))
    .orderBy(desc(cardFeeRates.effectiveAt))
    .limit(1);
  if (brand) return Number(brand.rate);
  const [col] = await tx.select({ rate: shops.cardFeeRate }).from(shops).where(eq(shops.id, shopId));
  return col?.rate == null ? null : Number(col.rate);
}

/** The shop's service and product rates effective at `at`, in fraction and basis points. */
export async function getSalesTaxRate(shopId: string, at: Date, tx: DBorTx = db): Promise<{ serviceRate: number; productRate: number; taxRateBps: number; productTaxRateBps: number }> {
  const [row] = await tx
    .select({ service: salesTaxRates.serviceRate, product: salesTaxRates.productRate })
    .from(salesTaxRates)
    .where(and(eq(salesTaxRates.shopId, shopId), lte(salesTaxRates.effectiveAt, at)))
    .orderBy(desc(salesTaxRates.effectiveAt))
    .limit(1);
  const [col] = row ? [null] : await tx.select({ service: shops.serviceTaxRate, product: shops.productTaxRate }).from(shops).where(eq(shops.id, shopId));
  const serviceRate = Number(row?.service ?? col?.service ?? 0);
  const productRate = Number(row?.product ?? col?.product ?? 0);
  return { serviceRate, productRate, taxRateBps: Math.round(serviceRate * 10_000), productTaxRateBps: Math.round(productRate * 10_000) };
}
