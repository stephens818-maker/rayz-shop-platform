import { and, eq, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { products, saleItems, sales, shopProducts } from "@/db/schema";
import { Levels, availableQty, effectiveLevels, isLow, projectedQty } from "@/domain/inventory";
import { AppError } from "../errors";

/** Open tickets older than this no longer hold their retail. */
export const HOLD_HOURS = 24;

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;

export interface StockRow {
  shopId: string;
  shop: string;
  productId: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  /** The shop sells it. */
  active: boolean;
  onHand: number;
  /** On open tickets and in transfers being picked. */
  committed: number;
  available: number;
  /** Ordered from vendors (approved, sent or partly received), not yet here. */
  onOrder: number;
  /** Sent from another shop, not yet received here. */
  inTransit: number;
  projected: number;
  levels: Levels;
  /** The shop's own levels, or null where it follows the brand. */
  reorderOverride: number | null;
  parOverride: number | null;
  brandLevels: { reorderPoint: number; par: number };
  costCents: number;
  priceCents: number;
  /** On hand at cost; negative stock counts as zero. */
  valueCents: number;
  low: boolean;
  /** Overstock line: the shop's own, else the brand's. Null when neither is set. */
  high: number | null;
  /** On hand above the high line. */
  over: boolean;
  preferredVendor: { id: string; name: string } | null;
  lowAlertedAt: Date | null;
}

type Raw = {
  shop_id: string;
  shop: string;
  product_id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  active: boolean;
  stock: number;
  cost_cents: number;
  price_cents: number;
  sp_low: number | null;
  sp_par: number | null;
  p_low: number;
  p_par: number;
  sp_high: number | null;
  p_high: number | null;
  committed: number;
  on_order: number;
  in_transit: number;
  vendor_id: string | null;
  vendor: string | null;
  low_alerted_at: string | null;
};

/** Stock position for every product carried at these shops. */
export async function stockLevels(shopIds: string[], o: { productIds?: string[]; tx?: DBorTx } = {}): Promise<StockRow[]> {
  if (!shopIds.length) return [];
  const tx = o.tx ?? db;
  const productFilter = o.productIds ? sql`and sp.product_id in ${uuids(o.productIds)}` : sql``;
  const raw = (await tx.execute(sql`
    with tickets as (
      select s.shop_id, si.ref_id product_id, sum(si.qty)::int n
      from sale_items si join sales s on s.id = si.sale_id
      where s.status = 'open' and si.kind = 'product' and s.created_at > now() - make_interval(hours => ${HOLD_HOURS}) and s.shop_id in ${uuids(shopIds)}
      group by 1, 2
    ), picking as (
      select t.from_shop_id shop_id, l.product_id, sum(l.qty)::int n
      from stock_transfer_lines l join stock_transfers t on t.id = l.transfer_id
      where t.status = 'draft' and t.from_shop_id in ${uuids(shopIds)}
      group by 1, 2
    ), ordered as (
      select po.shop_id, l.product_id, sum(greatest(l.qty_ordered - l.qty_received, 0))::int n
      from purchase_order_lines l join purchase_orders po on po.id = l.purchase_order_id
      where po.status in ('approved', 'sent', 'partially_received') and po.shop_id in ${uuids(shopIds)}
      group by 1, 2
    ), transit as (
      select t.to_shop_id shop_id, l.product_id, sum(l.qty)::int n
      from stock_transfer_lines l join stock_transfers t on t.id = l.transfer_id
      where t.status = 'sent' and t.to_shop_id in ${uuids(shopIds)}
      group by 1, 2
    )
    select sp.shop_id, sh.name shop, p.id product_id, p.sku, p.name, p.brand, p.category, sp.active, sp.stock, sp.cost_cents, sp.price_cents,
      sp.low_stock_threshold sp_low, sp.par_level sp_par, p.low_stock_threshold p_low, p.par_level p_par, sp.high_stock_threshold sp_high, p.high_stock_threshold p_high, sp.low_alerted_at,
      coalesce(tk.n, 0) + coalesce(pk.n, 0) committed, coalesce(od.n, 0) on_order, coalesce(tr.n, 0) in_transit,
      v.id vendor_id, v.name vendor
    from shop_products sp
      join products p on p.id = sp.product_id
      join shops sh on sh.id = sp.shop_id
      left join tickets tk on tk.shop_id = sp.shop_id and tk.product_id = sp.product_id
      left join picking pk on pk.shop_id = sp.shop_id and pk.product_id = sp.product_id
      left join ordered od on od.shop_id = sp.shop_id and od.product_id = sp.product_id
      left join transit tr on tr.shop_id = sp.shop_id and tr.product_id = sp.product_id
      left join vendor_products vp on vp.product_id = p.id and vp.preferred
      left join vendors v on v.id = vp.vendor_id and v.active
    where sp.shop_id in ${uuids(shopIds)} ${productFilter}
    order by sh.name, p.brand, p.name`)) as unknown as Raw[];
  return raw.map((r) => {
    const levels = effectiveLevels({ lowStockThreshold: r.p_low, parLevel: r.p_par }, { lowStockThreshold: r.sp_low, parLevel: r.sp_par });
    const pos = { onHand: r.stock, committed: r.committed, onOrder: r.on_order, inTransit: r.in_transit };
    const high = r.sp_high ?? r.p_high;
    return {
      shopId: r.shop_id,
      shop: r.shop,
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      brand: r.brand,
      category: r.category,
      active: r.active,
      ...pos,
      available: availableQty(pos),
      projected: projectedQty(pos),
      levels,
      reorderOverride: r.sp_low,
      parOverride: r.sp_par,
      brandLevels: { reorderPoint: r.p_low, par: Math.max(r.p_par, r.p_low) },
      costCents: r.cost_cents,
      priceCents: r.price_cents,
      valueCents: Math.max(0, r.stock) * r.cost_cents,
      low: r.active && isLow(pos, levels),
      high,
      over: r.active && high !== null && r.stock > high,
      preferredVendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor! } : null,
      lowAlertedAt: r.low_alerted_at ? new Date(r.low_alerted_at) : null,
    };
  });
}

/** Rows where on-hand doesn't equal the sum of the ledger. Always empty unless something bypassed the database guard. */
export async function inventoryDrift(tx: DBorTx = db) {
  return (await tx.execute(sql`select shop_id "shopId", product_id "productId", stock, ledger_total "ledgerTotal" from inventory_drift`)) as unknown as {
    shopId: string;
    productId: string;
    stock: number;
    ledgerTotal: number;
  }[];
}

/**
 * Keeps an open ticket's retail lines saved, so what's in the cart counts as committed at the shop
 * until it's paid, voided or a day old. Checkout rewrites every line when the ticket is paid.
 */
export async function holdRetail(saleId: string, lines: { productId: string; qty: number }[]) {
  await db.transaction(async (tx) => {
    const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).for("update");
    if (!sale || sale.status !== "open") throw new AppError("conflict", "Ticket is closed");
    const qty = new Map<string, number>();
    for (const l of lines) {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new AppError("bad_request", "Quantities must be whole numbers");
      qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.qty);
    }
    await tx.delete(saleItems).where(and(eq(saleItems.saleId, saleId), eq(saleItems.kind, "product")));
    if (!qty.size) return;
    const stocked = await tx
      .select({ productId: shopProducts.productId, priceCents: shopProducts.priceCents, brand: products.brand, name: products.name })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .where(and(eq(shopProducts.shopId, sale.shopId), eq(shopProducts.active, true)));
    const rows = [...qty].flatMap(([productId, n]) => {
      const p = stocked.find((s) => s.productId === productId);
      return p ? [{ saleId, kind: "product" as const, refId: productId, name: `${p.brand} ${p.name}`, qty: n, unitPriceCents: p.priceCents, grossCents: p.priceCents * n, netCents: p.priceCents * n }] : [];
    });
    if (rows.length) await tx.insert(saleItems).values(rows);
  });
}
