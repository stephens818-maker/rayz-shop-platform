import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { brandStockMoves, products, shopProducts, shops } from "@/db/schema";
import { highProblem, levelsProblem } from "@/domain/inventory";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { Who, assertShop, postMovements } from "./ledger";

export interface BrandProductRow {
  id: string;
  sku: string;
  brand: string;
  name: string;
  category: string;
  active: boolean;
  /** Supply price: what the brand pays per unit. */
  costCents: number;
  priceCents: number;
  lowStockThreshold: number;
  parLevel: number;
  highStockThreshold: number | null;
  /** Bought centrally, not yet at a shop. */
  unallocated: number;
  /** On hand across every shop that carries it. */
  allocated: number;
  shops: number;
}

/** Every product with brand stock (unallocated) beside what's at the shops (allocated). */
export async function brandProducts(): Promise<BrandProductRow[]> {
  const rows = (await db.execute(sql`
    select p.id, p.sku, p.brand, p.name, p.category, p.active, p.cost_cents, p.price_cents, p.low_stock_threshold, p.par_level, p.high_stock_threshold,
      p.unallocated_stock, coalesce(sum(greatest(sp.stock, 0)), 0)::int allocated, count(sp.shop_id)::int shops
    from products p
    left join shop_products sp on sp.product_id = p.id
    left join catalog_categories cc on cc.kind = 'product' and lower(cc.name) = lower(p.category)
    group by p.id, cc.sort_order
    order by coalesce(cc.sort_order, 100000), p.category, p.brand, p.name`)) as unknown as {
    id: string;
    sku: string;
    brand: string;
    name: string;
    category: string;
    active: boolean;
    cost_cents: number;
    price_cents: number;
    low_stock_threshold: number;
    par_level: number;
    high_stock_threshold: number | null;
    unallocated_stock: number;
    allocated: number;
    shops: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    brand: r.brand,
    name: r.name,
    category: r.category,
    active: r.active,
    costCents: r.cost_cents,
    priceCents: r.price_cents,
    lowStockThreshold: r.low_stock_threshold,
    parLevel: r.par_level,
    highStockThreshold: r.high_stock_threshold,
    unallocated: r.unallocated_stock,
    allocated: r.allocated,
    shops: r.shops,
  }));
}

const units = z.number().int("Whole units").min(0).max(100_000);
export const ProductDetailsInput = z.object({
  productId: z.uuid(),
  sku: z.string().trim().min(1, "Enter a SKU").max(40),
  brand: z.string().trim().min(1, "Enter the brand").max(60),
  category: z.string().trim().min(1).max(60),
  costCents: z.number().int().min(0).max(1_000_000),
  priceCents: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: units,
  parLevel: units,
  highStockThreshold: units.nullable(),
});

/** Brand-level product details: SKU, brand, supply price, retail price and stock thresholds. */
export async function saveProductDetails(who: Who, raw: z.input<typeof ProductDetailsInput>) {
  const v = ProductDetailsInput.parse(raw);
  const problem = levelsProblem(v.lowStockThreshold, v.parLevel) ?? highProblem(v.parLevel, v.highStockThreshold);
  if (problem) throw new AppError("bad_request", problem);
  const [before] = await db.select().from(products).where(eq(products.id, v.productId));
  if (!before) throw notFound("Product");
  const clash = await db.query.products.findFirst({ where: and(sql`lower(${products.sku}) = lower(${v.sku})`, sql`${products.id} <> ${v.productId}`) });
  if (clash) throw new AppError("conflict", `SKU ${v.sku} is already ${clash.brand} ${clash.name}`);
  const set = { sku: v.sku, brand: v.brand, category: v.category, costCents: v.costCents, priceCents: v.priceCents, lowStockThreshold: v.lowStockThreshold, parLevel: v.parLevel, highStockThreshold: v.highStockThreshold };
  await db.update(products).set(set).where(eq(products.id, v.productId));
  const changed = Object.fromEntries(Object.entries(set).filter(([k, x]) => before[k as keyof typeof before] !== x).map(([k, x]) => [k, { from: before[k as keyof typeof before], to: x }]));
  await audit(who.actor, "product.details", "product", v.productId, { changed }, null);
}

export const ReceiveInput = z.object({
  productId: z.uuid(),
  qty: z.number().int("Whole units").min(1, "Enter how many units").max(100_000),
  unitCostCents: z.number().int().min(0).max(1_000_000).nullable(),
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((s) => s || null),
});

async function lockProduct(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], productId: string) {
  const [p] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
  if (!p) throw notFound("Product");
  return p;
}

/** Units bought centrally: they sit in brand stock until allocated to a shop. A unit cost updates the supply price. */
export async function receiveBrandStock(who: Who, raw: z.input<typeof ReceiveInput>) {
  const v = ReceiveInput.parse(raw);
  return db.transaction(async (tx) => {
    const p = await lockProduct(tx, v.productId);
    const balance = p.unallocatedStock + v.qty;
    await tx
      .update(products)
      .set({ unallocatedStock: balance, ...(v.unitCostCents !== null ? { costCents: v.unitCostCents } : {}) })
      .where(eq(products.id, p.id));
    await tx.insert(brandStockMoves).values({ productId: p.id, delta: v.qty, kind: "receive", unitCostCents: v.unitCostCents ?? p.costCents, note: v.note, balanceAfter: balance, staffId: who.actor.staffId ?? null });
    await audit(who.actor, "inventory.brand_receive", "product", p.id, { qty: v.qty, unitCostCents: v.unitCostCents, note: v.note, unallocated: balance }, null, tx);
    return { unallocated: balance };
  });
}

export const AllocateInput = z.object({
  productId: z.uuid(),
  shopId: z.uuid(),
  qty: z.number().int("Whole units").min(1, "Enter how many units").max(100_000),
});

/** Sends brand stock to a shop: out of unallocated, into the shop's stock ledger as a transfer in. A shop that didn't carry it starts to. */
export async function allocateBrandStock(who: Who, raw: z.input<typeof AllocateInput>) {
  const v = AllocateInput.parse(raw);
  assertShop(who, v.shopId);
  return db.transaction(async (tx) => {
    const p = await lockProduct(tx, v.productId);
    if (v.qty > p.unallocatedStock) throw new AppError("bad_request", `Only ${p.unallocatedStock} unallocated`);
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, v.shopId), columns: { id: true, name: true } });
    if (!shop) throw notFound("Shop");
    await tx
      .insert(shopProducts)
      .values({ shopId: v.shopId, productId: p.id, costCents: p.costCents, priceCents: p.priceCents })
      .onConflictDoNothing();
    const balance = p.unallocatedStock - v.qty;
    await tx.update(products).set({ unallocatedStock: balance }).where(eq(products.id, p.id));
    await tx.insert(brandStockMoves).values({ productId: p.id, delta: -v.qty, kind: "allocate", shopId: v.shopId, unitCostCents: p.costCents, balanceAfter: balance, staffId: who.actor.staffId ?? null });
    await postMovements(tx, [{ shopId: v.shopId, productId: p.id, delta: v.qty, kind: "transfer_in", note: "From brand stock", unitCostCents: p.costCents }], {
      actor: who.actor,
      audit: { action: "inventory.allocate", entity: "product", entityId: p.id, details: { qty: v.qty, shop: shop.name, unallocated: balance } },
    });
    return { unallocated: balance };
  });
}
