import "server-only";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ImportRowError, brandSyncBatches, importRuns, products, services, shopProducts, shopServices, shops } from "@/db/schema";
import { Catalog, PlannedRow, ShopRef, UploadMode, UploadPlan, exportRows, parseUpload, planUpload } from "@/domain/catalog-import";
import { slugify } from "@/lib/ids";
import { Actor, audit } from "./audit";
import { ProductInput, ServiceInput } from "./brand-sync/adapters/catalog";
import { RawChange, commitBrandChange, rollbackSync } from "./brand-sync/engine";
import { AppError, notFound } from "./errors";
import { postMovements, setOnHand } from "./inventory/ledger";

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

const SERVICE_BRAND = new Set(Object.keys(ServiceInput.shape));
const PRODUCT_BRAND = new Set(Object.keys(ProductInput.shape));
/** A patch split into what the brand change scope syncs and what's only the brand's record (SKU, tax category, barcode). */
const splitPatch = <T extends object>(patch: T | undefined, synced: ReadonlySet<string>) => {
  const e = Object.entries(patch ?? {});
  return { synced: Object.fromEntries(e.filter(([k]) => synced.has(k))), rest: Object.fromEntries(e.filter(([k]) => !synced.has(k))) as Partial<T> };
};

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

    const synced: RawChange[] = [];
    const undo: CatalogUndoStep[] = [];
    const before = async <T extends Record<string, unknown>>(row: Promise<T[]>, keys: string[]) => {
      const [x] = await row;
      return Object.fromEntries(keys.map((k) => [k, x?.[k] ?? null]));
    };
    for (const r of plan.rows) {
      const op = r.op;
      if (!op) continue;
      const brandChanges = r.changes.filter((c) => !c.shop);
      if (op.type === "product") {
        let id = op.id;
        if (!id) {
          id = (await tx.insert(products).values(op.create!).returning({ id: products.id }))[0].id;
          undo.push({ t: "created", table: "products", id });
        } else if (op.patch) {
          const { synced: brand, rest } = splitPatch(op.patch, PRODUCT_BRAND);
          if (Object.keys(rest).length) {
            const pid = id;
            undo.push({ t: "patch", table: "products", id, before: await before(tx.select().from(products).where(eq(products.id, pid)), Object.keys(rest)), after: rest });
            await tx.update(products).set(rest).where(eq(products.id, id));
          }
          if (Object.keys(brand).length) synced.push({ type: "product", item: id, value: brand });
        }
        if (op.create || op.patch) await audit(input.actor, op.create ? "catalog.product_create" : "catalog.product_update", "product", id, { sku: r.sku, line: r.line, runId: run.id, ...(op.create ? { values: op.create } : { changes: brandChanges }) }, null, tx);
        for (const s of op.shops) {
          const where = and(eq(shopProducts.shopId, s.shopId), eq(shopProducts.productId, id));
          if (s.create) {
            const { stock, lowStockThreshold, ...rest } = s.create;
            const brandLevel = op.create?.lowStockThreshold ?? (await tx.select({ v: products.lowStockThreshold }).from(products).where(eq(products.id, id)))[0].v;
            await tx.insert(shopProducts).values({ shopId: s.shopId, productId: id, ...rest, lowStockThreshold: lowStockThreshold === brandLevel ? null : lowStockThreshold });
            undo.push({ t: "shop_created", table: "shop_products", shopId: s.shopId, id });
          } else if (s.patch && Object.keys(s.patch).length) {
            undo.push({ t: "shop_patch", table: "shop_products", shopId: s.shopId, id, before: await before(tx.select().from(shopProducts).where(where), Object.keys(s.patch)), after: s.patch });
            await tx.update(shopProducts).set(s.patch).where(where);
          }
          // Sales may have happened since the sheet was made: the upload sets the number, the ledger records the difference.
          if (s.stock && s.stock.to !== s.stock.from) {
            const moved = await setOnHand(tx, { shopId: s.shopId, productId: id, to: s.stock.to, kind: "upload", note: input.filename }, { actor: input.actor, audit: false });
            if (moved.delta) undo.push({ t: "stock", shopId: s.shopId, id, delta: moved.delta });
          }
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
          undo.push({ t: "created", table: "services", id });
        } else if (op.patch) {
          const { synced: brand, rest } = splitPatch(op.patch, SERVICE_BRAND);
          if (Object.keys(rest).length) {
            const sid = id;
            undo.push({ t: "patch", table: "services", id, before: await before(tx.select().from(services).where(eq(services.id, sid)), Object.keys(rest)), after: rest });
            await tx.update(services).set(rest).where(eq(services.id, id));
          }
          if (Object.keys(brand).length) synced.push({ type: "service", item: id, value: brand });
        }
        if (op.create || op.patch) await audit(input.actor, op.create ? "catalog.service_create" : "catalog.service_update", "service", id, { sku: r.sku, line: r.line, runId: run.id, ...(op.create ? { values: op.create } : { changes: brandChanges }) }, null, tx);
        for (const s of op.shops) {
          const where = and(eq(shopServices.shopId, s.shopId), eq(shopServices.serviceId, id));
          if (s.create) {
            await tx.insert(shopServices).values({ shopId: s.shopId, serviceId: id, priceCents: s.create.priceCents });
            undo.push({ t: "shop_created", table: "shop_services", shopId: s.shopId, id });
          } else {
            undo.push({ t: "shop_patch", table: "shop_services", shopId: s.shopId, id, before: await before(tx.select().from(shopServices).where(where), Object.keys(s.patch!)), after: s.patch! });
            await tx.update(shopServices).set(s.patch!).where(where);
          }
          await audit(input.actor, s.create ? "catalog.shop_add" : "catalog.shop_price", "service", id, { sku: r.sku, line: r.line, runId: run.id, ...(s.create ? { values: s.create } : { changes: r.changes.filter((c) => c.shop === shopName(s.shopId)) }) }, s.shopId, tx);
        }
      }
    }
    // Brand prices, lengths and levels go to the shops the upload is for; the others keep theirs until pushed.
    let syncBatchId: string | null = null;
    if (synced.length) {
      const targets = [...new Set([...input.targetShopIds, ...parsed.shopIds])].filter((id) => input.allowedShopIds.includes(id));
      ({ batchId: syncBatchId } = await commitBrandChange({ actor: input.actor, ctx: null }, { changes: synced, scope: targets.length ? "selected" : "brand_only", shopIds: targets, overrides: {}, label: `Catalog upload: ${input.filename}`.slice(0, 120) }, new Date(), tx));
    }
    const { summary } = plan;
    await tx
      .update(importRuns)
      .set({ inserted: summary.create, updated: summary.update, skipped: summary.error, errors, stats: { unchanged: summary.unchanged, stockChanges: summary.stockChanges }, undo, syncBatchId })
      .where(eq(importRuns.id, run.id));
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

/** One thing a saved upload did, kept on the run so it can be undone. */
export type CatalogUndoStep =
  | { t: "created"; table: "products" | "services"; id: string }
  | { t: "patch"; table: "products" | "services"; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { t: "shop_created"; table: "shop_products" | "shop_services"; shopId: string; id: string }
  | { t: "shop_patch"; table: "shop_products" | "shop_services"; shopId: string; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { t: "stock"; shopId: string; id: string; delta: number };

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || String(a) === String(b);

/**
 * Undoes one saved upload in one step: the brand sync it pushed (brand prices, lengths and levels at
 * each shop), then every field it set, put back as it was. Items and shop rows it added are turned off
 * (their history stays), and stock gets a compensating ledger entry for what the upload moved, so
 * sales since still count. Refused, with what changed, if anything it set has changed since.
 */
export async function rollbackCatalogUpload(input: { runId: string; actor: Actor; allowedShopIds: string[]; mode: UploadMode }, now = new Date()) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rayz.catalog_upload'))`);
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, input.runId)).for("update");
    if (!run || !["catalog", "catalog_stock"].includes(run.kind) || run.dryRun) throw notFound("Upload");
    if (run.rolledBackAt) throw new AppError("conflict", "That upload was already undone");
    if (!run.undo) throw new AppError("bad_request", "That upload was saved before uploads could be undone. Upload the sheet you exported before it instead.");
    if (input.mode === "stock" && run.kind !== "catalog_stock") throw new AppError("forbidden", "Only people who manage the catalog can undo a catalog upload");
    const steps = run.undo as CatalogUndoStep[];
    const outside = [...new Set(steps.flatMap((s) => ("shopId" in s ? [s.shopId] : [])))].filter((id) => !input.allowedShopIds.includes(id));
    if (outside.length) throw new AppError("forbidden", "That upload changed shops outside your access");

    if (run.syncBatchId) {
      const [b] = await tx.select({ status: brandSyncBatches.status }).from(brandSyncBatches).where(eq(brandSyncBatches.id, run.syncBatchId));
      if (b?.status === "applied") await rollbackSync({ actor: input.actor, ctx: null }, run.syncBatchId, now, tx);
    }

    const table = { products, services, shop_products: shopProducts, shop_services: shopServices } as const;
    const whereOf = (s: Extract<CatalogUndoStep, { id: string }>) =>
      s.t === "shop_created" || s.t === "shop_patch" || s.t === "stock"
        ? "table" in s && s.table === "shop_services"
          ? and(eq(shopServices.shopId, s.shopId), eq(shopServices.serviceId, s.id))
          : and(eq(shopProducts.shopId, s.shopId), eq(shopProducts.productId, s.id))
        : s.table === "services"
          ? eq(services.id, s.id)
          : eq(products.id, s.id);
    const names = new Map((await allShops(tx)).map((s) => [s.id, s.name]));
    const conflicts: string[] = [];
    for (const s of steps) {
      if (s.t !== "patch" && s.t !== "shop_patch") continue;
      const [cur] = (await tx.select().from(table[s.table]).where(whereOf(s))) as Record<string, unknown>[];
      const where = s.t === "shop_patch" ? `${names.get(s.shopId) ?? "a shop"}: ` : "";
      for (const [k, v] of Object.entries(s.after)) if (!cur || !sameValue(cur[k], v)) conflicts.push(`${where}${(cur?.name ?? cur?.sku ?? "an item") as string} ${k} changed since`);
    }
    if (conflicts.length) {
      const more = conflicts.length > 4 ? ` and ${conflicts.length - 4} more` : "";
      throw new AppError("conflict", `Can't undo: ${conflicts.slice(0, 4).join("; ")}${more}. Change those back first, or upload a new sheet.`, { conflicts });
    }

    let restored = 0;
    for (const s of [...steps].reverse()) {
      if (s.t === "stock") {
        await postMovements(tx, [{ shopId: s.shopId, productId: s.id, delta: -s.delta, kind: "upload", note: `Undo: ${run.filename ?? "catalog upload"}` }], { actor: input.actor, negative: "allow", audit: false });
      } else if (s.t === "patch" || s.t === "shop_patch") {
        await tx.update(table[s.table]).set(s.before).where(whereOf(s));
      } else if (s.t === "shop_created" && s.table === "shop_services") {
        await tx.delete(shopServices).where(whereOf(s));
      } else {
        await tx.update(table[s.table]).set({ active: false }).where(whereOf(s));
      }
      restored++;
    }
    await tx.update(importRuns).set({ rolledBackAt: now, rolledBackBy: input.actor.label }).where(eq(importRuns.id, run.id));
    await audit(input.actor, "catalog.upload_rollback", "import_run", run.id, { filename: run.filename, steps: restored, syncBatchId: run.syncBatchId }, null, tx);
    return { restored, syncUndone: !!run.syncBatchId };
  });
}

/** The catalog in the upload format, for the shops given. */
export async function catalogExport(shopIds: string[]): Promise<string[][]> {
  const list = (await allShops()).filter((s) => shopIds.includes(s.id));
  return exportRows(await loadCatalog(), list);
}
