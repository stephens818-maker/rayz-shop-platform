/**
 * One brand catalog: category order drives the shop menu, brand product details (SKU, supply price,
 * high line), brand stock received centrally and allocated to shops through the ledger, and the
 * taxes-vs-card-fees view.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Who } from "@/server/inventory/ledger";
import { brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let C: typeof import("@/server/catalog-categories");
let BS: typeof import("@/server/inventory/brand-stock");
let TF: typeof import("@/server/taxes-fees");
let catalog: typeof import("@/server/catalog");
const shopId: Record<string, string> = {};
let who: Who;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);

beforeAll(async () => {
  m = await loadModules();
  C = await import("@/server/catalog-categories");
  BS = await import("@/server/inventory/brand-stock");
  TF = await import("@/server/taxes-fees");
  catalog = await import("@/server/catalog");
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
  who = { actor, name: "test", shopIds: Object.values(shopId) };
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("category order", () => {
  it("orders the shop menu by the brand's category order, and refuses a stale list", async () => {
    const before = await C.listCategories("service");
    expect(before.length).toBeGreaterThan(1);
    const reversed = [...before].reverse().map((c) => c.name);
    try {
      await C.saveCategoryOrder("service", reversed, actor);
      expect((await C.listCategories("service")).map((c) => c.name)).toEqual(reversed);
      const menu = (await catalog.shopCatalog(shopId.coralville)).filter((s) => s.kind === "service");
      const rank = (cat: string) => reversed.findIndex((n) => n.toLowerCase() === cat.toLowerCase());
      const ranks = menu.map((s) => rank(s.category));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

      await expect(C.saveCategoryOrder("service", reversed.slice(1), actor)).rejects.toThrow(/changed while you were ordering/);
      await expect(C.saveCategoryOrder("service", [...reversed.slice(1), reversed[1]], actor)).rejects.toThrow(/changed/);
      const log = await m.db.db.query.auditLog.findFirst({ where: eq(m.schema.auditLog.action, "catalog.category_order"), orderBy: (a, { desc }) => desc(a.at) });
      expect(log?.details).toMatchObject({ order: reversed });
    } finally {
      await C.saveCategoryOrder("service", before.map((c) => c.name), actor);
    }
  });
});

let seq = 0;
async function product(o: { cost?: number; high?: number | null } = {}) {
  seq++;
  const [p] = await m.db.db
    .insert(m.schema.products)
    .values({ sku: `BRAND-TEST-${seq}`, name: `Brand Clay ${seq}`, brand: "Testco", category: "Styling", costCents: o.cost ?? 900, priceCents: 2400, lowStockThreshold: 2, parLevel: 6, highStockThreshold: o.high ?? null })
    .returning();
  return p;
}

describe("brand products", () => {
  it("saves SKU, brand, supply price and a high line, refusing a taken SKU or a high below par", async () => {
    const p = await product();
    const other = await product();
    const base = { productId: p.id, sku: `BRAND-NEW-${seq}`, brand: "Newco", category: "Styling", costCents: 1100, priceCents: 2600, lowStockThreshold: 2, parLevel: 6, highStockThreshold: 12 };
    await brandSet("product", p.id, base);
    const row = (await BS.brandProducts()).find((r) => r.id === p.id)!;
    expect(row).toMatchObject({ sku: base.sku, brand: "Newco", costCents: 1100, priceCents: 2600, highStockThreshold: 12, unallocated: 0, allocated: 0, shops: 0 });
    await expect(brandSet("product", p.id, { ...base, sku: other.sku.toLowerCase() })).rejects.toThrow(/already/);
    await expect(brandSet("product", p.id, { ...base, highStockThreshold: 4 })).rejects.toThrow(/below par/);
    const log = await m.db.db.query.auditLog.findFirst({ where: and(eq(m.schema.auditLog.action, "product.details"), eq(m.schema.auditLog.entityId, p.id)) });
    expect(log?.details).toMatchObject({ changed: { brand: { from: "Testco", to: "Newco" } } });
  });

  it("receives into unallocated stock, then allocates to a shop through the ledger", async () => {
    const p = await product({ high: 5 });
    expect(await BS.receiveBrandStock(who, { productId: p.id, qty: 10, unitCostCents: 850, note: "Invoice 42" })).toEqual({ unallocated: 10 });
    expect((await m.db.db.query.products.findFirst({ where: eq(m.schema.products.id, p.id) }))!.costCents).toBe(850);

    await expect(BS.allocateBrandStock(who, { productId: p.id, shopId: shopId.coralville, qty: 11 })).rejects.toThrow(/Only 10 unallocated/);
    await expect(BS.allocateBrandStock({ ...who, shopIds: [shopId.coralville] }, { productId: p.id, shopId: shopId.moline, qty: 1 })).rejects.toThrow(/outside your access/);
    expect(await BS.allocateBrandStock(who, { productId: p.id, shopId: shopId.coralville, qty: 7 })).toEqual({ unallocated: 3 });

    const sp = (await m.db.db.query.shopProducts.findFirst({ where: and(eq(m.schema.shopProducts.shopId, shopId.coralville), eq(m.schema.shopProducts.productId, p.id)) }))!;
    expect(sp.stock).toBe(7);
    const ledger = await m.db.db.select().from(m.schema.inventoryLedger).where(and(eq(m.schema.inventoryLedger.shopId, shopId.coralville), eq(m.schema.inventoryLedger.productId, p.id)));
    expect(ledger.map((l) => [l.kind, l.delta])).toEqual([["transfer_in", 7]]);
    const moves = await m.db.db.select().from(m.schema.brandStockMoves).where(eq(m.schema.brandStockMoves.productId, p.id)).orderBy(m.schema.brandStockMoves.createdAt);
    expect(moves.map((x) => [x.kind, x.delta, x.balanceAfter])).toEqual([
      ["receive", 10, 10],
      ["allocate", -7, 3],
    ]);
    expect((await BS.brandProducts()).find((r) => r.id === p.id)).toMatchObject({ unallocated: 3, allocated: 7, shops: 1 });

    const pos = (await m.stock.stockLevels([shopId.coralville], { productIds: [p.id] }))[0];
    expect(pos).toMatchObject({ high: 5, over: true });
  });
});

describe("taxes and card fees", () => {
  it("lists each location's tax rates and jurisdiction apart from its card fee, with what each collected", async () => {
    const ids = Object.values(shopId);
    const rows = await TF.taxesAndFees(ids, "2000-01-01", "2100-01-01");
    expect(rows.length).toBeGreaterThan(0);
    const shops = await m.db.db.select().from(m.schema.shops);
    for (const r of rows) {
      const s = shops.find((x) => x.id === r.shopId)!;
      expect(r.serviceTaxRate).toBe(Number(s.serviceTaxRate));
      expect(r.cardFeeRate).toBe(Number(s.cardFeeRate));
      expect(r.jurisdiction).not.toBe("");
    }
    const totals = (await m.db.db.execute(
      m.drizzle.sql`select coalesce(sum(service_tax_cents + product_tax_cents), 0)::int tax, coalesce(sum(card_fee_cents), 0)::int fee from sales where status in ('paid', 'refunded', 'partially_refunded')`,
    )) as unknown as { tax: number; fee: number }[];
    expect(rows.reduce((a, r) => a + r.serviceTaxCents + r.productTaxCents, 0)).toBe(totals[0].tax);
    expect(rows.reduce((a, r) => a + r.cardFeeCents, 0)).toBe(totals[0].fee);
  });
});
