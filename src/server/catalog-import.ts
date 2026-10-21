import "server-only";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ImportRowError, importRuns, products, services, shopProducts, shopServices, shops } from "@/db/schema";
import { Catalog, PlannedRow, ShopRef, UploadMode, UploadPlan, exportRows, parseUpload, planUpload } from "@/domain/catalog-import";
import { slugify } from "@/lib/ids";
import { Actor, audit } from "./audit";
import { AppError } from "./errors";
import { setOnHand } from "./inventory/ledger";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** First sheet of a CSV or XLSX file as header + rows of text. */
export async function readSheet(name: string, bytes: Uint8Array): Promise<{ headers: string[]; records: string[][] }> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new AppError("bad_request", "That file is over 5 MB. Split it into smaller uploads.");
  if (/\.xlsx$/i.test(name)) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      throw new AppError("bad_request", "That file couldn't be read as an Excel workbook");
    }
    const ws = wb.worksheets.find((w) => w.name.toLowerCase() !== "instructions") ?? wb.worksheets[0];
    if (!ws) return { headers: [], records: [] };
    const width = ws.columnCount;
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const out: string[] = [];
      for (let c = 1; c <= width; c++) out.push(row.getCell(c).text ?? "");
      rows.push(out);
    });
    const [headers = [], ...records] = rows;
    return { headers, records };
  }
  if (!/\.(csv|txt)$/i.test(name)) throw new AppError("bad_request", "Upload a .csv or .xlsx file");
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const [headers = [], ...records] = parsed.data;
  return { headers, records };
}

export async function loadCatalog(tx: DBorTx = db): Promise<Catalog> {
  const [p, s, sp, ss] = await Promise.all([
    tx.select().from(products),
    tx.select().from(services),
    tx.select().from(shopProducts),
    tx.select({ shopId: shopServices.shopId, serviceId: shopServices.serviceId, priceCents: shopServices.priceCents, enabled: shopServices.enabled }).from(shopServices),
  ]);
  const brandLevel = new Map(p.map((x) => [x.id, x.lowStockThreshold]));
  // Shops without their own reorder point follow the brand's.
  const shopProductsAt = sp.map((x) => ({ ...x, lowStockThreshold: x.lowStockThreshold ?? brandLevel.get(x.productId) ?? 3 }));
  return { products: p, services: s, shopProducts: shopProductsAt, shopServices: ss };
}

export const allShops = (tx: DBorTx = db): Promise<ShopRef[]> => tx.select({ id: shops.id, slug: shops.slug, name: shops.name }).from(shops).orderBy(asc(shops.name));

export interface UploadInput {
  filename: string;
  bytes: Uint8Array;
  mode: UploadMode;
  targetShopIds: string[];
  allowedShopIds: string[];
  dryRun: boolean;
  actor: Actor;
}

export type ClientPlan = Omit<UploadPlan, "rows"> & { rows: Omit<PlannedRow, "op" | "raw">[]; runId: string | null; saved: boolean };

const toClient = (plan: UploadPlan, runId: string | null, saved: boolean): ClientPlan => ({
  ...plan,
  rows: plan.rows.map(({ line, sku, name, kind, action, changes, errors, warnings }) => ({ line, sku, name, kind, action, changes, errors, warnings })),
  runId,
  saved,
});

/**
 * Preview or save an upload. Saving re-plans inside one transaction (uploads are serialised), saves
 * every row without errors, skips the rest, and logs the run plus an audit entry per item.
 */
export async function uploadCatalog(input: UploadInput): Promise<ClientPlan> {
  const sheet = await readSheet(input.filename, input.bytes);
  const shopList = await allShops();
  const parsed = parseUpload(sheet.headers, sheet.records, shopList);
  const opts = { mode: input.mode, targetShopIds: input.targetShopIds, allowedShopIds: input.allowedShopIds, shops: shopList };
  if (input.dryRun) return toClient(planUpload(parsed, await loadCatalog(), opts), null, false);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rayz.catalog_upload'))`);
    const plan = planUpload(parsed, await loadCatalog(tx), opts);
    if (plan.fileErrors.length) throw new AppError("bad_request", plan.fileErrors[0]);
    const shopName = (id: string) => shopList.find((s) => s.id === id)?.name ?? id;
    const takenSlugs = new Set((await tx.select({ slug: services.slug }).from(services)).map((r) => r.slug));
    const [{ maxSort }] = await tx.select({ maxSort: sql<number>`coalesce(max(${services.sortOrder}), 0)::int` }).from(services);
    let sort = maxSort;
    const errors: ImportRowError[] = plan.rows.filter((r) => r.action === "error").map((r) => ({ row: r.line, reason: "invalid", message: r.errors.join("; "), data: r.raw }));
    const [run] = await tx
      .insert(importRuns)
      .values({ kind: input.mode === "stock" ? "catalog_stock" : "catalog", filename: input.filename, dryRun: false, totalRows: plan.summary.rows, staffId: input.actor.staffId ?? null })
      .returning({ id: importRuns.id });

    for (const r of plan.rows) {
      const op = r.op;
      if (!op) continue;
      const brandChanges = r.changes.filter((c) => !c.shop);
      if (op.type === "product") {
        let id = op.id;
        if (!id) id = (await tx.insert(products).values(op.create!).returning({ id: products.id }))[0].id;
        else if (op.patch) await tx.update(products).set(op.patch).where(eq(products.id, id));
        if (op.create || op.patch) await audit(input.actor, op.create ? "catalog.product_create" : "catalog.product_update", "product", id, { sku: r.sku, line: r.line, runId: run.id, ...(op.create ? { values: op.create } : { changes: brandChanges }) }, null, tx);
        for (const s of op.shops) {
          const where = and(eq(shopProducts.shopId, s.shopId), eq(shopProducts.productId, id));
          if (s.create) {
            const { stock: _opening, lowStockThreshold, ...rest } = s.create;
            const brandLevel = op.create?.lowStockThreshold ?? (await tx.select({ v: products.lowStockThreshold }).from(products).where(eq(products.id, id)))[0].v;
            await tx.insert(shopProducts).values({ shopId: s.shopId, productId: id, ...rest, lowStockThreshold: lowStockThreshold === brandLevel ? null : lowStockThreshold });
          } else if (s.patch && Object.keys(s.patch).length) await tx.update(shopProducts).set(s.patch).where(where);
          // Sales may have happened since the sheet was made: the upload sets the number, the ledger records the difference.
          if (s.stock && s.stock.to !== s.stock.from) await setOnHand(tx, { shopId: s.shopId, productId: id, to: s.stock.to, kind: "upload", note: input.filename }, { actor: input.actor, audit: false });
          const changes = r.changes.filter((c) => c.shop === shopName(s.shopId));
          await audit(input.actor, s.create ? "inventory.upload_add" : "inventory.upload", "product", id, { sku: r.sku, line: r.line, runId: run.id, ...(s.create ? { values: s.create } : { changes }) }, s.shopId, tx);
        }
      } else {
        let id = op.id;
        if (!id) {
          let slug = slugify(op.create!.name) || slugify(op.create!.sku);
          for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(op.create!.name)}-${n}`;
          takenSlugs.add(slug);
          sort += 10;
          id = (await tx.insert(services).values({ ...op.create!, slug, sortOrder: sort }).returning({ id: services.id }))[0].id;
        } else if (op.patch) await tx.update(services).set(op.patch).where(eq(services.id, id));
        if (op.create || op.patch) await audit(input.actor, op.create ? "catalog.service_create" : "catalog.service_update", "service", id, { sku: r.sku, line: r.line, runId: run.id, ...(op.create ? { values: op.create } : { changes: brandChanges }) }, null, tx);
        for (const s of op.shops) {
          if (s.create) await tx.insert(shopServices).values({ shopId: s.shopId, serviceId: id, priceCents: s.create.priceCents });
          else await tx.update(shopServices).set(s.patch!).where(and(eq(shopServices.shopId, s.shopId), eq(shopServices.serviceId, id)));
          await audit(input.actor, s.create ? "catalog.shop_add" : "catalog.shop_price", "service", id, { sku: r.sku, line: r.line, runId: run.id, ...(s.create ? { values: s.create } : { changes: r.changes.filter((c) => c.shop === shopName(s.shopId)) }) }, s.shopId, tx);
        }
      }
    }
    const { summary } = plan;
    await tx.update(importRuns).set({ inserted: summary.create, updated: summary.update, skipped: summary.error, errors, stats: { unchanged: summary.unchanged, stockChanges: summary.stockChanges } }).where(eq(importRuns.id, run.id));
    const single = input.targetShopIds.length === 1 && input.mode === "stock" ? input.targetShopIds[0] : null;
    await audit(
      input.actor,
      "catalog.upload",
      "import_run",
      run.id,
      { filename: input.filename, mode: input.mode, shops: input.targetShopIds.map(shopName), ...summary },
      single,
      tx,
    );
    return toClient(plan, run.id, true);
  });
}

/** The catalog in the upload format, for the shops given. */
export async function catalogExport(shopIds: string[]): Promise<string[][]> {
  const list = (await allShops()).filter((s) => shopIds.includes(s.id));
  return exportRows(await loadCatalog(), list);
}
