/**
 * Bulk catalog upload through the real server action: dry run, save, update by SKU, stock-only
 * uploads, shop scope, XLSX, and what lands in the audit log.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClientPlan } from "@/server/catalog-import";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let upload: typeof import("@/app/admin/catalog/actions").uploadCatalogAction;
const ids: Record<string, string> = {};
const shopId: Record<string, string> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

beforeAll(async () => {
  m = await loadModules();
  for (const l of ["admin", "regional", "michelle", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
  upload = (await import("@/app/admin/catalog/actions")).uploadCatalogAction;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

function form(file: File, opts: { dryRun: boolean; shops?: string[]; all?: boolean }) {
  const f = new FormData();
  f.set("file", file);
  f.set("dryRun", opts.dryRun ? "1" : "0");
  if (opts.all) f.set("allShops", "1");
  for (const s of opts.shops ?? []) f.append("shops", s);
  return f;
}
const csv = (name: string, lines: string[]) => new File([lines.join("\n") + "\n"], name, { type: "text/csv" });
async function send(login: string, file: File, opts: Parameters<typeof form>[1]): Promise<ClientPlan> {
  await signInAs(ids[login]);
  const r = await upload(form(file, opts));
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const productBySku = (sku: string) => m.db.db.query.products.findFirst({ where: eq(m.schema.products.sku, sku) });
const count = async (t: typeof m.schema.products | typeof m.schema.services) => (await m.db.db.select().from(t)).length;

const HEADER = "type,sku,name,category,maker,brand_cost,price,duration_min,tax_category,barcode,active,low_stock_threshold,price_coralville,stock_coralville,stock_moline";

describe("bulk upload", () => {
  it("dry run validates and previews without saving anything", async () => {
    const before = await count(m.schema.products);
    const plan = await send("admin", csv("new.csv", [HEADER, "product,TEST-CLAY-1,Test Clay,Styling,Layrite,9.00,20.00,,product,850099000011,yes,4,18.00,10,6", "product,TEST-BAD,,Styling,,x,,,,,,,,,"]), {
      dryRun: true,
      shops: [shopId.coralville, shopId.moline],
    });
    expect(plan.saved).toBe(false);
    expect(plan.summary).toMatchObject({ rows: 2, create: 1, error: 1 });
    expect(plan.rows[1].errors).toEqual(expect.arrayContaining(['Brand cost "x" isn\'t an amount like 12.50', "New item: name is required", "New item: price is required"]));
    expect(await count(m.schema.products)).toBe(before);
    expect(await productBySku("TEST-CLAY-1")).toBeUndefined();
  });

  it("saving creates items at the chosen shops, skips bad rows, and logs everything", async () => {
    const plan = await send("admin", csv("new.csv", [HEADER, "product,TEST-CLAY-1,Test Clay,Styling,Layrite,9.00,20.00,,product,850099000011,yes,4,18.00,10,6", "product,TEST-BAD,,Styling,,x,,,,,,,,,"]), {
      dryRun: false,
      shops: [shopId.coralville, shopId.moline],
    });
    expect(plan).toMatchObject({ saved: true, summary: { create: 1, error: 1 } });
    const p = (await productBySku("TEST-CLAY-1"))!;
    expect(p).toMatchObject({ name: "Test Clay", brand: "Layrite", costCents: 900, priceCents: 2000, barcode: "850099000011", lowStockThreshold: 4 });
    const at = await m.db.db.select().from(m.schema.shopProducts).where(eq(m.schema.shopProducts.productId, p.id));
    expect(at.map((x) => [x.shopId, x.priceCents, x.stock]).sort()).toEqual(
      [
        [shopId.coralville, 1800, 10],
        [shopId.moline, 2000, 6],
      ].sort(),
    );
    const adj = await m.db.db.select().from(m.schema.inventoryAdjustments).where(eq(m.schema.inventoryAdjustments.productId, p.id));
    expect(adj.map((a) => [a.reason, a.delta, a.staffId]).sort()).toEqual([["upload", 10, ids.admin], ["upload", 6, ids.admin]].sort());
    const audit = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, p.id));
    expect(audit.map((a) => a.action).sort()).toEqual(["catalog.product_create", "inventory.upload_add", "inventory.upload_add"]);
    const run = (await m.db.db.select().from(m.schema.importRuns).where(eq(m.schema.importRuns.id, plan.runId!)))[0];
    expect(run).toMatchObject({ kind: "catalog", inserted: 1, skipped: 1, staffId: ids.admin });
    expect(run.errors[0]).toMatchObject({ row: 3, data: expect.objectContaining({ sku: "TEST-BAD" }) });
    const summary = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "catalog.upload"), eq(m.schema.auditLog.entityId, run.id)));
    expect(summary[0].details).toMatchObject({ create: 1, error: 1, mode: "catalog" });

    const errors = (await import("@/app/admin/import/[runId]/errors/route")).GET;
    const res = await errors(new Request("http://localhost/x"), { params: Promise.resolve({ runId: run.id }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("TEST-BAD");
    await signInAs(ids.michelle);
    expect((await errors(new Request("http://localhost/x"), { params: Promise.resolve({ runId: run.id }) })).status).toBe(403);
  });

  it("re-uploading updates the same item by SKU; shops on the brand price follow it", async () => {
    const before = await count(m.schema.products);
    const plan = await send("admin", csv("again.csv", ["sku,price,brand_cost,stock_moline", "test-clay-1,22.00,9.00,8"]), { dryRun: false, shops: [shopId.coralville, shopId.moline] });
    expect(plan.summary).toMatchObject({ create: 0, update: 1 });
    expect(plan.rows[0].changes).toEqual(
      expect.arrayContaining([
        { field: "price", from: "20.00", to: "22.00" },
        { field: "price", shop: "Moline", from: "20.00", to: "22.00" },
        { field: "stock", shop: "Moline", from: 6, to: 8 },
      ]),
    );
    expect(await count(m.schema.products)).toBe(before);
    const p = (await productBySku("TEST-CLAY-1"))!;
    expect(p.priceCents).toBe(2200);
    const at = await m.db.db.select().from(m.schema.shopProducts).where(eq(m.schema.shopProducts.productId, p.id));
    expect(Object.fromEntries(at.map((x) => [x.shopId, x.priceCents]))).toEqual({ [shopId.coralville]: 1800, [shopId.moline]: 2200 });
    const upd = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "catalog.product_update"), eq(m.schema.auditLog.entityId, p.id)));
    expect(upd[0].details).toMatchObject({ sku: "TEST-CLAY-1", changes: [{ field: "price", from: "20.00", to: "22.00" }] });

    const same = await send("admin", csv("again.csv", ["sku,price,stock_moline", "TEST-CLAY-1,22.00,8"]), { dryRun: true, shops: [shopId.moline] });
    expect(same.rows[0].action).toBe("unchanged");
  });

  it("adds services that are bookable at the chosen shop", async () => {
    await send("admin", csv("svc.csv", ["type,sku,name,category,price,duration_min,price_coralville", "service,TEST-HOT-TOWEL,Beard Steam Test,Shaves,30,30,32"]), { dryRun: false, shops: [shopId.coralville] });
    const svc = (await m.db.db.query.services.findFirst({ where: eq(m.schema.services.sku, "TEST-HOT-TOWEL") }))!;
    expect(svc).toMatchObject({ slug: "beard-steam-test", kind: "service", defaultPriceCents: 3000, defaultDurationMin: 30, taxCategory: "service" });
    const menu = await m.catalog.shopCatalog(shopId.coralville);
    expect(menu.find((s) => s.id === svc.id)).toMatchObject({ priceCents: 3200 });
  });

  it("reads XLSX the same way as CSV", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Catalog");
    ws.addRow(["type", "sku", "name", "maker", "price", "barcode", "stock_coralville"]);
    ws.addRow(["product", "TEST-XLSX-1", "Sheet Pomade", "Reuzel", 19.5, "850099000028", 3]);
    const file = new File([(await wb.xlsx.writeBuffer()) as ArrayBuffer], "items.xlsx");
    const plan = await send("admin", file, { dryRun: true, shops: [] });
    expect(plan.fileErrors).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ sku: "TEST-XLSX-1", action: "create" });
  });

  it("stock-only: inventory managers set stock at their shops; prices and new items are ignored or refused", async () => {
    const p = (await productBySku("TEST-CLAY-1"))!;
    const plan = await send("regional", csv("count.csv", ["sku,price,stock_moline", "TEST-CLAY-1,99.00,3", "TEST-NEW-9,5,1"]), { dryRun: false, all: true });
    expect(plan.rows[0]).toMatchObject({ action: "update", changes: [{ field: "stock", shop: "Moline", from: 8, to: 3 }] });
    expect(plan.rows[0].warnings[0]).toMatch(/Only stock/);
    expect(plan.rows[1].errors[0]).toMatch(/Unknown SKU/);
    expect((await productBySku("TEST-CLAY-1"))!.priceCents).toBe(p.priceCents);
    expect(await productBySku("TEST-NEW-9")).toBeUndefined();
    const run = (await m.db.db.select().from(m.schema.importRuns).where(eq(m.schema.importRuns.id, plan.runId!)))[0];
    expect(run.kind).toBe("catalog_stock");
    const adj = await m.db.db.select().from(m.schema.inventoryAdjustments).where(m.drizzle.and(eq(m.schema.inventoryAdjustments.productId, p.id), eq(m.schema.inventoryAdjustments.staffId, ids.regional)));
    expect(adj).toMatchObject([{ delta: -5, reason: "upload", shopId: shopId.moline }]);
  });

  it("shop scope: columns or shops outside your access block the upload", async () => {
    const plan = await send("michelle", csv("count.csv", ["sku,stock_moline", "TEST-CLAY-1,50"]), { dryRun: true, shops: [shopId.coralville] });
    expect(plan.fileErrors[0]).toMatch(/Moline is outside your shop access/);
    await signInAs(ids.michelle);
    expect(await upload(form(csv("count.csv", ["sku,stock_moline", "TEST-CLAY-1,50"]), { dryRun: false, shops: [shopId.coralville] }))).toMatchObject({ ok: false, error: expect.stringMatching(/outside your shop access/) });
    expect(await upload(form(csv("count.csv", ["sku,stock_coralville", "TEST-CLAY-1,50"]), { dryRun: true, shops: [shopId.moline] }))).toMatchObject({ ok: false, error: "That shop is outside your access" });
    await signInAs(ids.regional);
    expect(await upload(form(csv("x.csv", ["sku,price", "TEST-CLAY-1,1"]), { dryRun: true, all: true }))).toMatchObject({ ok: true });
  });

  it("people without catalog or inventory access can't upload", async () => {
    await signInAs(ids.makenna);
    expect(await upload(form(csv("x.csv", ["sku", "A"]), { dryRun: true }))).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) });
    await signInAs(null);
    await expect(upload(form(csv("x.csv", ["sku", "A"]), { dryRun: true }))).rejects.toMatchObject({ digest: expect.stringContaining("/login") });
  });
});
