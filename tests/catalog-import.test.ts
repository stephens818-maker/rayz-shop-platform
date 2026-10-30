import { describe, expect, it } from "vitest";
import { Catalog, PlanOptions, ShopRef, exportRows, parseMoney, parseUpload, planUpload, templateHeaders } from "@/domain/catalog-import";

const coralville: ShopRef = { id: "s-cor", slug: "coralville", name: "Coralville" };
const moline: ShopRef = { id: "s-mol", slug: "moline", name: "Moline" };
const rockIsland: ShopRef = { id: "s-ri", slug: "rock-island", name: "Rock Island" };
const shops = [coralville, moline, rockIsland];

const catalog = (): Catalog => ({
  products: [
    { id: "p1", sku: "REUZEL-BLUE-001", name: "Blue Pomade", brand: "Reuzel", category: "Styling", costCents: 1100, priceCents: 2400, taxCategory: "product", barcode: "850012100001", lowStockThreshold: 3, active: true },
  ],
  services: [{ id: "v1", sku: "RAYZ-CUT", name: "Ray'z Cut", kind: "service", category: "Haircuts", defaultPriceCents: 3000, defaultDurationMin: 30, taxCategory: "service", active: true }],
  shopProducts: [
    { shopId: "s-cor", productId: "p1", costCents: 1100, priceCents: 2400, stock: 5, lowStockThreshold: 3, active: true },
    { shopId: "s-mol", productId: "p1", costCents: 1150, priceCents: 2600, stock: 2, lowStockThreshold: 3, active: true },
  ],
  shopServices: [{ shopId: "s-cor", serviceId: "v1", priceCents: null, enabled: true }],
});

const sheet = (csv: string) => {
  const [h, ...rows] = csv.trim().split("\n").map((l) => l.split(","));
  return parseUpload(h, rows, shops);
};
const all: PlanOptions = { mode: "catalog", targetShopIds: [], allowedShopIds: shops.map((s) => s.id), shops };

describe("bulk upload: reading the sheet", () => {
  it("accepts friendly headers and per-shop columns by slug", () => {
    const p = sheet("Type,SKU,Name,Brand Cost,Price,Tax,UPC,Price - Moline,Stock Rock Island\nproduct,new-1,Gel,5,$12.50,product,012345678905,13,4");
    expect(p.fileErrors).toEqual([]);
    expect(p.rows[0]).toMatchObject({ kind: "product", sku: "NEW-1", costCents: 500, priceCents: 1250, taxCategory: "product", barcode: "012345678905", shopPrice: { "s-mol": 1300 }, shopStock: { "s-ri": 4 } });
    expect(p.shopIds.sort()).toEqual(["s-mol", "s-ri"]);
  });

  it("rejects the file without a sku column, and unknown shop columns", () => {
    expect(sheet("name,price\nGel,5").fileErrors).toContain('The file needs a "sku" column');
    expect(sheet("sku,price_dubuque\nX,5").fileErrors[0]).toMatch(/doesn't match a shop/);
    expect(sheet("sku").fileErrors).toContain("The file has no rows");
  });

  it("flags bad values per row, with spreadsheet line numbers", () => {
    const p = sheet(
      [
        "type,sku,name,price,duration_min,tax_category,barcode,active,low_stock_threshold,stock_coralville",
        "gadget,A1,Thing,abc,7,luxury,12ab,maybe,-1,lots",
        ",,No SKU,5,,,,,,",
        "product,A1,Dup,5,,,,,,",
      ].join("\n"),
    );
    const [bad, noSku, dup] = p.rows;
    expect(bad.line).toBe(2);
    expect(bad.errors.join("|")).toMatch(/Type "gadget"/);
    expect(bad.errors.join("|")).toMatch(/Price "abc"/);
    expect(bad.errors.join("|")).toMatch(/Duration "7"/);
    expect(bad.errors.join("|")).toMatch(/Tax category "luxury"/);
    expect(bad.errors.join("|")).toMatch(/Barcode "12ab"/);
    expect(bad.errors.join("|")).toMatch(/Active "maybe"/);
    expect(bad.errors.join("|")).toMatch(/Low-stock threshold "-1"/);
    expect(bad.errors.join("|")).toMatch(/Coralville stock "lots"/);
    expect(noSku.errors).toContain("SKU is missing");
    expect(dup.errors).toContain("SKU A1 is also on row 2");
  });

  it("parses money strictly", () => {
    expect(parseMoney("1,234.5")).toBe(123450);
    expect(parseMoney("$0.99")).toBe(99);
    for (const bad of ["-1", "1.234", "ten", ""]) expect(parseMoney(bad)).toBeNull();
  });
});

describe("bulk upload: plan and dry run", () => {
  it("new items need a type, a name and a price; services also need a duration", () => {
    const plan = planUpload(sheet("type,sku,name,price,duration_min\n,NEW-1,X,5,\nproduct,NEW-2,,5,\nservice,NEW-3,Fade,25,\naddon,NEW-4,Design,10,15"), catalog(), all);
    expect(plan.rows.map((r) => r.action)).toEqual(["error", "error", "error", "create"]);
    expect(plan.rows[0].errors[0]).toMatch(/add a type/);
    expect(plan.rows[1].errors).toContain("New item: name is required");
    expect(plan.rows[2].errors).toContain("New service: duration_min is required");
    expect(plan.rows[3].op).toMatchObject({ type: "service", create: { kind: "addon", category: "Add-ons", defaultDurationMin: 15, taxCategory: "service" } });
  });

  it("re-uploading matches by SKU (any case) and changes only what differs", () => {
    const plan = planUpload(sheet("sku,name,price,barcode\nreuzel-blue-001,Blue Pomade,25.00,850012100001\nRAYZ-CUT,Ray'z Cut,30,"), catalog(), all);
    const [prod, svc] = plan.rows;
    expect(prod.action).toBe("update");
    expect(prod.changes).toEqual([{ field: "price", from: "24.00", to: "25.00" }]);
    expect(prod.op).toMatchObject({ type: "product", id: "p1", patch: { priceCents: 2500 } });
    expect(svc.action).toBe("unchanged");
    expect(svc.op).toBeNull();
    expect(plan.summary).toMatchObject({ rows: 2, create: 0, update: 1, unchanged: 1, error: 0 });
  });

  it("shops on the brand price follow a brand price change; shops with their own price keep it", () => {
    const plan = planUpload(sheet("sku,price\nREUZEL-BLUE-001,25"), catalog(), { ...all, targetShopIds: ["s-cor", "s-mol"] });
    const op = plan.rows[0].op as Extract<NonNullable<(typeof plan.rows)[0]["op"]>, { type: "product" }>;
    expect(op.shops).toEqual([{ shopId: "s-cor", patch: { priceCents: 2500 } }]);
  });

  it("per-shop price and starting stock, and pushing to a shop that doesn't carry it yet", () => {
    const plan = planUpload(sheet("sku,price_moline,stock_moline,stock_rock_island\nREUZEL-BLUE-001,27,9,4"), catalog(), all);
    const op = plan.rows[0].op as Extract<NonNullable<(typeof plan.rows)[0]["op"]>, { type: "product" }>;
    expect(op.shops).toEqual([
      { shopId: "s-mol", patch: { priceCents: 2700 }, stock: { from: 2, to: 9 } },
      { shopId: "s-ri", create: { costCents: 1100, priceCents: 2400, stock: 4, lowStockThreshold: 3, active: true }, stock: { from: 0, to: 4 } },
    ]);
    expect(plan.summary.stockChanges).toBe(2);
  });

  it("a new product pushed to all target shops gets the brand price there", () => {
    const plan = planUpload(sheet("type,sku,name,maker,brand_cost,price,price_coralville\nproduct,LAYRITE-CEMENT,Cement Clay,Layrite,9,20,18"), catalog(), { ...all, targetShopIds: ["s-cor", "s-mol"] });
    const op = plan.rows[0].op as Extract<NonNullable<(typeof plan.rows)[0]["op"]>, { type: "product" }>;
    expect(op.create).toMatchObject({ sku: "LAYRITE-CEMENT", brand: "Layrite", costCents: 900, priceCents: 2000, taxCategory: "product", active: true });
    expect(op.shops.map((s) => [s.shopId, s.create?.priceCents])).toEqual([
      ["s-cor", 1800],
      ["s-mol", 2000],
    ]);
  });

  it("keeps SKUs unique across products and services, and barcodes unique", () => {
    const plan = planUpload(sheet("type,sku,name,price,barcode,duration_min\nservice,REUZEL-BLUE-001,X,5,,30\nproduct,RAYZ-CUT,Y,5,,\nproduct,NEW-9,Z,5,850012100001,"), catalog(), all);
    expect(plan.rows[0].errors).toContain("SKU REUZEL-BLUE-001 is already a retail product");
    expect(plan.rows[1].errors).toContain("SKU RAYZ-CUT is already a service");
    expect(plan.rows[2].errors).toContain("Barcode 850012100001 already belongs to REUZEL-BLUE-001");
  });

  it("services can't carry stock or barcodes", () => {
    const plan = planUpload(sheet("sku,stock_coralville,barcode\nRAYZ-CUT,4,850012100009"), catalog(), all);
    expect(plan.rows[0].errors).toEqual(["Services and add-ons don't have stock", "Services and add-ons don't have barcodes"]);
  });

  it("shops outside the uploader's access block the whole file", () => {
    const plan = planUpload(sheet("sku,stock_moline\nREUZEL-BLUE-001,3"), catalog(), { ...all, allowedShopIds: ["s-cor"] });
    expect(plan.fileErrors[0]).toMatch(/Moline is outside your shop access/);
  });

  it("stock-only mode: existing products at shops that carry them; prices and new items are not touched", () => {
    const opts: PlanOptions = { mode: "stock", targetShopIds: ["s-cor"], allowedShopIds: ["s-cor"], shops };
    const plan = planUpload(sheet("type,sku,name,price,stock_coralville,low_stock_threshold\n,REUZEL-BLUE-001,Renamed,99,8,4\nproduct,NEW-1,New,5,3,\n,RAYZ-CUT,,,,"), catalog(), opts);
    const [stock, unknown, service] = plan.rows;
    expect(stock.op).toEqual({ type: "product", id: "p1", shops: [{ shopId: "s-cor", stock: { from: 5, to: 8 }, patch: { lowStockThreshold: 4 } }] });
    expect(stock.warnings[0]).toMatch(/Only stock and low-stock levels/);
    expect(unknown.errors[0]).toMatch(/Unknown SKU/);
    expect(service.errors[0]).toMatch(/Only retail products have stock/);
  });

  it("an export uploads back with no changes", () => {
    const cat = catalog();
    const [h, ...rows] = exportRows(cat, shops);
    expect(h).toEqual(templateHeaders(shops));
    const plan = planUpload(parseUpload(h, rows, shops), cat, all);
    expect(plan.fileErrors).toEqual([]);
    expect(plan.rows.map((r) => [r.sku, r.action])).toEqual([
      ["REUZEL-BLUE-001", "unchanged"],
      ["RAYZ-CUT", "unchanged"],
    ]);
  });
});
