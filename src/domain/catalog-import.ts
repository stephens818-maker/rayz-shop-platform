/**
 * Bulk catalog upload: retail products and services from a CSV or XLSX sheet. Pure: parsing,
 * validation and the plan of what will change. The server loads the catalog, calls these inside a
 * transaction, and applies the plan, so the preview and the save can't disagree.
 */

export type TaxCategory = "service" | "product" | "exempt";
export type CatalogKind = "product" | "service" | "addon";
export const CATALOG_KINDS: CatalogKind[] = ["product", "service", "addon"];
export const TAX_CATEGORIES: TaxCategory[] = ["service", "product", "exempt"];
export const MAX_UPLOAD_ROWS = 5000;

export interface ShopRef {
  id: string;
  slug: string;
  name: string;
}

/** The columns, in template order. Per-shop columns follow: price_<shop>, stock_<shop>. */
export const BASE_COLUMNS = [
  { key: "type", hint: "product, service or addon. Needed for new items." },
  { key: "sku", hint: "Required. Matches existing items, so re-uploading updates them." },
  { key: "name", hint: "Needed for new items." },
  { key: "category", hint: "e.g. Styling, Haircuts." },
  { key: "maker", hint: "Products: who makes it, e.g. Reuzel." },
  { key: "brand_cost", hint: "Products: what the brand pays, e.g. 9.50." },
  { key: "price", hint: "Brand-level price, e.g. 24.00. Needed for new items." },
  { key: "duration_min", hint: "Services and add-ons: minutes. Needed for new services." },
  { key: "tax_category", hint: "service, product or exempt. Defaults by type." },
  { key: "barcode", hint: "Products: UPC or EAN, 8 to 14 digits." },
  { key: "active", hint: "yes or no. Defaults to yes for new items." },
  { key: "low_stock_threshold", hint: "Products: reorder when stock is at or below this." },
] as const;
type BaseKey = (typeof BASE_COLUMNS)[number]["key"];

const ALIASES: Record<string, BaseKey> = {
  kind: "type",
  item_type: "type",
  item: "name",
  product: "name",
  brand: "maker",
  vendor: "maker",
  manufacturer: "maker",
  cost: "brand_cost",
  unit_cost: "brand_cost",
  brand_price: "price",
  retail_price: "price",
  duration: "duration_min",
  minutes: "duration_min",
  tax: "tax_category",
  upc: "barcode",
  ean: "barcode",
  enabled: "active",
  low_stock: "low_stock_threshold",
  reorder_at: "low_stock_threshold",
  reorder_point: "low_stock_threshold",
};

export const normalizeHeader = (h: string) =>
  h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const shopColumn = (kind: "price" | "stock", shop: Pick<ShopRef, "slug">) => `${kind}_${normalizeHeader(shop.slug)}`;
export const templateHeaders = (shops: ShopRef[]) => [...BASE_COLUMNS.map((c) => c.key), ...shops.flatMap((s) => [shopColumn("price", s), shopColumn("stock", s)])];

export interface UploadRow {
  /** Spreadsheet row number; the header is row 1. */
  line: number;
  raw: Record<string, string>;
  sku: string;
  kind?: CatalogKind;
  name?: string;
  category?: string;
  maker?: string;
  costCents?: number;
  priceCents?: number;
  durationMin?: number;
  taxCategory?: TaxCategory;
  barcode?: string;
  active?: boolean;
  lowStockThreshold?: number;
  shopPrice: Record<string, number>;
  shopStock: Record<string, number>;
  errors: string[];
  warnings: string[];
}

export interface ParsedUpload {
  rows: UploadRow[];
  /** Problems with the whole file; nothing is saved while there are any. */
  fileErrors: string[];
  ignoredColumns: string[];
  /** Shops that have a column in the file. */
  shopIds: string[];
}

export function parseMoney(v: string): number | null {
  const s = v.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
const parseCount = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
const BOOL: Record<string, boolean> = { yes: true, y: true, true: true, "1": true, active: true, no: false, n: false, false: false, "0": false, inactive: false };

/** Reads the sheet. Blank cells mean "leave as it is" for items that already exist. */
export function parseUpload(headers: string[], records: string[][], shops: ShopRef[]): ParsedUpload {
  const fileErrors: string[] = [];
  const ignoredColumns: string[] = [];
  const base = new Map<number, BaseKey>();
  const perShop = new Map<number, { kind: "price" | "stock"; shop: ShopRef }>();
  const seen = new Set<string>();
  headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (!n) return;
    const key = (BASE_COLUMNS.find((c) => c.key === n)?.key ?? ALIASES[n]) as BaseKey | undefined;
    const m = n.match(/^(price|stock)_(.+)$/);
    const shop = m ? shops.find((s) => normalizeHeader(s.slug) === m[2] || normalizeHeader(s.name) === m[2]) : undefined;
    const id = key ?? (m && shop ? `${m[1]}_${shop.id}` : null);
    if (!id) {
      if (m) fileErrors.push(`Column "${h}" doesn't match a shop. Use ${shops.map((s) => shopColumn(m[1] as "price", s)).join(", ")}.`);
      else ignoredColumns.push(h);
      return;
    }
    if (seen.has(id)) return fileErrors.push(`Column "${h}" appears twice`);
    seen.add(id);
    if (key) base.set(i, key);
    else perShop.set(i, { kind: m![1] as "price" | "stock", shop: shop! });
  });
  if (![...base.values()].includes("sku")) fileErrors.push('The file needs a "sku" column');
  const body = records.filter((r) => r.some((c) => c?.trim()));
  if (!body.length) fileErrors.push("The file has no rows");
  if (body.length > MAX_UPLOAD_ROWS) fileErrors.push(`Upload at most ${MAX_UPLOAD_ROWS} rows at a time (this file has ${body.length})`);

  const skus = new Map<string, number>();
  const barcodes = new Map<string, number>();
  const rows: UploadRow[] = [];
  records.forEach((rec, idx) => {
    if (!rec.some((c) => c?.trim())) return;
    const line = idx + 2;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => (raw[h] = (rec[i] ?? "").trim()));
    const r: UploadRow = { line, raw, sku: "", shopPrice: {}, shopStock: {}, errors: [], warnings: [] };
    const err = (m: string) => r.errors.push(m);
    for (const [i, key] of base) {
      const v = (rec[i] ?? "").trim();
      if (!v) continue;
      switch (key) {
        case "sku":
          r.sku = v.toUpperCase();
          if (!/^[A-Z0-9][A-Z0-9._\-/]{0,39}$/.test(r.sku)) err(`SKU "${v}" can only use letters, numbers, dashes, dots and slashes (up to 40)`);
          break;
        case "type": {
          const k = v.toLowerCase().replace(/[\s-]/g, "");
          const kind = k === "retail" ? "product" : k === "addon" || k === "add_on" ? "addon" : (CATALOG_KINDS.find((x) => x === k) ?? null);
          if (!kind) err(`Type "${v}" should be product, service or addon`);
          else r.kind = kind;
          break;
        }
        case "name":
          if (v.length > 120) err("Name is longer than 120 characters");
          r.name = v;
          break;
        case "category":
          r.category = v.slice(0, 60);
          break;
        case "maker":
          r.maker = v.slice(0, 60);
          break;
        case "brand_cost":
        case "price": {
          const c = parseMoney(v);
          if (c === null) err(`${key === "price" ? "Price" : "Brand cost"} "${v}" isn't an amount like 12.50`);
          else if (key === "price") r.priceCents = c;
          else r.costCents = c;
          break;
        }
        case "duration_min": {
          const d = parseCount(v);
          if (d === null || d < 5 || d > 480 || d % 5) err(`Duration "${v}" should be minutes in steps of 5, from 5 to 480`);
          else r.durationMin = d;
          break;
        }
        case "tax_category": {
          const t = TAX_CATEGORIES.find((x) => x === v.toLowerCase());
          if (!t) err(`Tax category "${v}" should be service, product or exempt`);
          else r.taxCategory = t;
          break;
        }
        case "barcode": {
          const b = v.replace(/\s/g, "");
          if (!/^\d{8,14}$/.test(b)) err(`Barcode "${v}" should be 8 to 14 digits`);
          else r.barcode = b;
          break;
        }
        case "active": {
          const b = BOOL[v.toLowerCase()];
          if (b === undefined) err(`Active "${v}" should be yes or no`);
          else r.active = b;
          break;
        }
        case "low_stock_threshold": {
          const n = parseCount(v);
          if (n === null || n > 10000) err(`Low-stock threshold "${v}" should be a whole number`);
          else r.lowStockThreshold = n;
          break;
        }
      }
    }
    for (const [i, { kind, shop }] of perShop) {
      const v = (rec[i] ?? "").trim();
      if (!v) continue;
      if (kind === "price") {
        const c = parseMoney(v);
        if (c === null) err(`${shop.name} price "${v}" isn't an amount like 12.50`);
        else r.shopPrice[shop.id] = c;
      } else {
        const n = parseCount(v);
        if (n === null || n > 100000) err(`${shop.name} stock "${v}" should be a whole number`);
        else r.shopStock[shop.id] = n;
      }
    }
    if (!r.sku) err("SKU is missing");
    else if (skus.has(r.sku)) err(`SKU ${r.sku} is also on row ${skus.get(r.sku)}`);
    else skus.set(r.sku, line);
    if (r.barcode) {
      if (barcodes.has(r.barcode)) err(`Barcode ${r.barcode} is also on row ${barcodes.get(r.barcode)}`);
      else barcodes.set(r.barcode, line);
    }
    rows.push(r);
  });
  return { rows, fileErrors, ignoredColumns, shopIds: [...new Set([...perShop.values()].map((p) => p.shop.id))] };
}

// ───────────────────────────── Plan ─────────────────────────────

export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  costCents: number;
  priceCents: number;
  taxCategory: TaxCategory;
  barcode: string | null;
  lowStockThreshold: number;
  active: boolean;
}
export interface ExistingService {
  id: string;
  sku: string | null;
  name: string;
  kind: "service" | "addon";
  category: string;
  defaultPriceCents: number;
  defaultDurationMin: number;
  taxCategory: TaxCategory;
  active: boolean;
}
export interface ExistingShopProduct {
  shopId: string;
  productId: string;
  costCents: number;
  priceCents: number;
  stock: number;
  lowStockThreshold: number;
  active: boolean;
}
export interface ExistingShopService {
  shopId: string;
  serviceId: string;
  priceCents: number | null;
  enabled: boolean;
}
export interface Catalog {
  products: ExistingProduct[];
  services: ExistingService[];
  shopProducts: ExistingShopProduct[];
  shopServices: ExistingShopService[];
}

/** "catalog": brand-level items and prices. "stock": stock and low-stock levels at your shops only. */
export type UploadMode = "catalog" | "stock";
export interface PlanOptions {
  mode: UploadMode;
  /** Shops to push items to (catalog mode) or update (stock mode). */
  targetShopIds: string[];
  /** Shops the uploader has access to. */
  allowedShopIds: string[];
  shops: ShopRef[];
}

type Value = string | number | boolean | null;
export interface Change {
  field: string;
  shop?: string;
  from: Value;
  to: Value;
}

type ProductValues = Omit<ExistingProduct, "id">;
type ServiceValues = Omit<ExistingService, "id"> & { sku: string };
type ShopProductValues = Omit<ExistingShopProduct, "shopId" | "productId">;

export type ItemOp =
  | {
      type: "product";
      id: string | null;
      create?: ProductValues;
      patch?: Partial<ProductValues>;
      shops: { shopId: string; create?: ShopProductValues; patch?: Partial<Omit<ShopProductValues, "stock">>; stock?: { from: number; to: number } }[];
    }
  | {
      type: "service";
      id: string | null;
      create?: ServiceValues;
      patch?: Partial<ServiceValues>;
      shops: { shopId: string; create?: { priceCents: number | null }; patch?: { priceCents: number | null } }[];
    };

export interface PlannedRow {
  line: number;
  sku: string;
  name: string;
  kind: CatalogKind | null;
  action: "create" | "update" | "unchanged" | "error";
  changes: Change[];
  errors: string[];
  warnings: string[];
  op: ItemOp | null;
  raw: Record<string, string>;
}

export interface UploadPlan {
  rows: PlannedRow[];
  fileErrors: string[];
  warnings: string[];
  summary: { rows: number; create: number; update: number; unchanged: number; error: number; stockChanges: number };
}

const money = (c: number | null | undefined) => (c === null || c === undefined ? null : (c / 100).toFixed(2));

export function planUpload(parsed: ParsedUpload, catalog: Catalog, opts: PlanOptions): UploadPlan {
  const fileErrors = [...parsed.fileErrors];
  const warnings: string[] = [];
  const shopName = (id: string) => opts.shops.find((s) => s.id === id)?.name ?? id;
  const outside = [...new Set([...opts.targetShopIds, ...parsed.shopIds])].filter((s) => !opts.allowedShopIds.includes(s));
  if (outside.length) fileErrors.push(`${outside.map(shopName).join(", ")} ${outside.length === 1 ? "is" : "are"} outside your shop access. Remove those columns or shops.`);
  if (parsed.ignoredColumns.length) warnings.push(`Ignored columns: ${parsed.ignoredColumns.join(", ")}`);
  if (opts.mode === "catalog" && !opts.targetShopIds.length && !parsed.shopIds.length) warnings.push("No shops picked: items are saved at brand level but not added to any shop.");

  const productBySku = new Map(catalog.products.map((p) => [p.sku.toUpperCase(), p]));
  const serviceBySku = new Map(catalog.services.filter((s) => s.sku).map((s) => [s.sku!.toUpperCase(), s]));
  const barcodeOwner = new Map(catalog.products.filter((p) => p.barcode).map((p) => [p.barcode!, p.sku.toUpperCase()]));
  const spKey = (shopId: string, id: string) => `${shopId}|${id}`;
  const sp = new Map(catalog.shopProducts.map((x) => [spKey(x.shopId, x.productId), x]));
  const ss = new Map(catalog.shopServices.map((x) => [spKey(x.shopId, x.serviceId), x]));

  const rows = parsed.rows.map((r): PlannedRow => {
    const errors = [...r.errors];
    const rowWarnings = [...r.warnings];
    const changes: Change[] = [];
    const exP = productBySku.get(r.sku);
    const exS = serviceBySku.get(r.sku);
    const kind: CatalogKind | null = r.kind ?? (exP ? "product" : exS ? exS.kind : null);
    const out = (op: ItemOp | null, create: boolean): PlannedRow => ({
      line: r.line,
      sku: r.sku,
      name: r.name ?? exP?.name ?? exS?.name ?? "",
      kind,
      action: errors.length ? "error" : create ? "create" : changes.length ? "update" : "unchanged",
      changes: errors.length ? [] : changes,
      errors,
      warnings: rowWarnings,
      op: errors.length || (!create && !changes.length) ? null : op,
      raw: r.raw,
    });
    if (!r.sku) return out(null, false);
    if (!kind) {
      errors.push("New item: add a type (product, service or addon)");
      return out(null, false);
    }
    if (kind === "product" && exS) errors.push(`SKU ${r.sku} is already a ${exS.kind}`);
    if (kind !== "product" && exP) errors.push(`SKU ${r.sku} is already a retail product`);
    const rowShops = [...new Set([...Object.keys(r.shopPrice), ...Object.keys(r.shopStock)])];
    const targets = [...new Set([...opts.targetShopIds, ...rowShops])].filter((s) => opts.allowedShopIds.includes(s));

    // ── Stock only: existing products at shops that already carry them.
    if (opts.mode === "stock") {
      if (kind !== "product" || !exP) {
        errors.push(exP || exS ? "Only retail products have stock" : "Unknown SKU. Adding items needs catalog access.");
        return out(null, false);
      }
      if (Object.keys(r.shopPrice).length || [r.name, r.category, r.maker, r.costCents, r.priceCents, r.durationMin, r.taxCategory, r.barcode, r.active].some((v) => v !== undefined))
        rowWarnings.push("Only stock and low-stock levels are saved; other columns are ignored");
      const shops: Extract<ItemOp, { type: "product" }>["shops"] = [];
      for (const shopId of targets) {
        const cur = sp.get(spKey(shopId, exP.id));
        const stockTo = r.shopStock[shopId];
        if (!cur) {
          if (stockTo !== undefined) errors.push(`${shopName(shopId)} doesn't carry this product yet`);
          continue;
        }
        const o: (typeof shops)[number] = { shopId };
        if (stockTo !== undefined && stockTo !== cur.stock) {
          o.stock = { from: cur.stock, to: stockTo };
          changes.push({ field: "stock", shop: shopName(shopId), from: cur.stock, to: stockTo });
        }
        if (r.lowStockThreshold !== undefined && r.lowStockThreshold !== cur.lowStockThreshold) {
          o.patch = { lowStockThreshold: r.lowStockThreshold };
          changes.push({ field: "low_stock_threshold", shop: shopName(shopId), from: cur.lowStockThreshold, to: r.lowStockThreshold });
        }
        if (o.stock || o.patch) shops.push(o);
      }
      return out({ type: "product", id: exP.id, shops }, false);
    }

    // ── Products
    if (kind === "product") {
      if (r.durationMin !== undefined) rowWarnings.push("duration_min is ignored for products");
      if (r.barcode) {
        const owner = barcodeOwner.get(r.barcode);
        if (owner && owner !== r.sku) errors.push(`Barcode ${r.barcode} already belongs to ${owner}`);
      }
      let next: ProductValues;
      let patch: Partial<ProductValues> | undefined;
      if (!exP) {
        if (!r.name) errors.push("New item: name is required");
        if (r.priceCents === undefined) errors.push("New item: price is required");
        next = {
          sku: r.sku,
          name: r.name ?? "",
          brand: r.maker ?? "",
          category: r.category ?? "Styling",
          costCents: r.costCents ?? 0,
          priceCents: r.priceCents ?? 0,
          taxCategory: r.taxCategory ?? "product",
          barcode: r.barcode ?? null,
          lowStockThreshold: r.lowStockThreshold ?? 3,
          active: r.active ?? true,
        };
      } else {
        const want: Partial<ProductValues> = { name: r.name, brand: r.maker, category: r.category, costCents: r.costCents, priceCents: r.priceCents, taxCategory: r.taxCategory, barcode: r.barcode, lowStockThreshold: r.lowStockThreshold, active: r.active };
        patch = {};
        for (const [k, v] of Object.entries(want) as [keyof ProductValues, Value][]) {
          if (v === undefined || v === exP[k]) continue;
          (patch as Record<string, Value>)[k] = v;
          const isMoney = k === "costCents" || k === "priceCents";
          changes.push({ field: k === "costCents" ? "brand_cost" : k === "priceCents" ? "price" : k === "brand" ? "maker" : k === "lowStockThreshold" ? "low_stock_threshold" : k === "taxCategory" ? "tax_category" : k, from: isMoney ? money(exP[k] as number) : exP[k], to: isMoney ? money(v as number) : v });
        }
        next = { ...exP, ...patch };
      }
      const shops: Extract<ItemOp, { type: "product" }>["shops"] = [];
      for (const shopId of targets) {
        const cur = exP ? sp.get(spKey(shopId, exP.id)) : undefined;
        const name = shopName(shopId);
        const stockTo = r.shopStock[shopId];
        if (!cur) {
          const create = { costCents: next.costCents, priceCents: r.shopPrice[shopId] ?? next.priceCents, stock: stockTo ?? 0, lowStockThreshold: next.lowStockThreshold, active: true };
          shops.push({ shopId, create, stock: create.stock ? { from: 0, to: create.stock } : undefined });
          if (exP) changes.push({ field: "added to shop", shop: name, from: null, to: `${money(create.priceCents)}, stock ${create.stock}` });
          continue;
        }
        const o: (typeof shops)[number] = { shopId };
        const p: Partial<Omit<ShopProductValues, "stock">> = {};
        // Shops on the brand price follow it; a shop's own price stays unless the sheet sets one.
        const price = r.shopPrice[shopId] ?? (patch?.priceCents !== undefined && cur.priceCents === exP!.priceCents ? patch.priceCents : undefined);
        if (price !== undefined && price !== cur.priceCents) {
          p.priceCents = price;
          changes.push({ field: "price", shop: name, from: money(cur.priceCents), to: money(price) });
        }
        if (patch?.costCents !== undefined && cur.costCents === exP!.costCents) {
          p.costCents = patch.costCents;
          changes.push({ field: "cost", shop: name, from: money(cur.costCents), to: money(patch.costCents) });
        }
        if (r.lowStockThreshold !== undefined && r.lowStockThreshold !== cur.lowStockThreshold) {
          p.lowStockThreshold = r.lowStockThreshold;
          changes.push({ field: "low_stock_threshold", shop: name, from: cur.lowStockThreshold, to: r.lowStockThreshold });
        }
        if (Object.keys(p).length) o.patch = p;
        if (stockTo !== undefined && stockTo !== cur.stock) {
          o.stock = { from: cur.stock, to: stockTo };
          changes.push({ field: "stock", shop: name, from: cur.stock, to: stockTo });
        }
        if (o.patch || o.stock) shops.push(o);
      }
      return out({ type: "product", id: exP?.id ?? null, create: exP ? undefined : next, patch: patch && Object.keys(patch).length ? patch : undefined, shops }, !exP);
    }

    // ── Services and add-ons
    if (Object.keys(r.shopStock).length || r.lowStockThreshold !== undefined) errors.push("Services and add-ons don't have stock");
    if (r.barcode) errors.push("Services and add-ons don't have barcodes");
    if (r.costCents !== undefined || r.maker !== undefined) rowWarnings.push("brand_cost and maker are ignored for services");
    let next: ServiceValues;
    let patch: Partial<ServiceValues> | undefined;
    if (!exS) {
      if (!r.name) errors.push("New item: name is required");
      if (r.priceCents === undefined) errors.push("New item: price is required");
      if (r.durationMin === undefined) errors.push("New service: duration_min is required");
      next = {
        sku: r.sku,
        name: r.name ?? "",
        kind: kind,
        category: r.category ?? (kind === "addon" ? "Add-ons" : "Haircuts"),
        defaultPriceCents: r.priceCents ?? 0,
        defaultDurationMin: r.durationMin ?? 30,
        taxCategory: r.taxCategory ?? "service",
        active: r.active ?? true,
      };
    } else {
      const want: Partial<ServiceValues> = { name: r.name, kind: r.kind as "service" | "addon" | undefined, category: r.category, defaultPriceCents: r.priceCents, defaultDurationMin: r.durationMin, taxCategory: r.taxCategory, active: r.active };
      patch = {};
      for (const [k, v] of Object.entries(want) as [keyof ServiceValues, Value][]) {
        if (v === undefined || v === exS[k as keyof ExistingService]) continue;
        (patch as Record<string, Value>)[k] = v;
        const isMoney = k === "defaultPriceCents";
        const from = exS[k as keyof ExistingService] as Value;
        changes.push({ field: k === "defaultPriceCents" ? "price" : k === "defaultDurationMin" ? "duration_min" : k === "taxCategory" ? "tax_category" : k === "kind" ? "type" : k, from: isMoney ? money(from as number) : from, to: isMoney ? money(v as number) : v });
      }
      next = { ...exS, sku: exS.sku ?? r.sku, ...patch };
    }
    const shops: Extract<ItemOp, { type: "service" }>["shops"] = [];
    for (const shopId of targets) {
      const cur = exS ? ss.get(spKey(shopId, exS.id)) : undefined;
      const given = r.shopPrice[shopId];
      const price = given === undefined || given === next.defaultPriceCents ? null : given;
      if (!cur) {
        shops.push({ shopId, create: { priceCents: price } });
        if (exS) changes.push({ field: "added to shop", shop: shopName(shopId), from: null, to: money(price ?? next.defaultPriceCents) });
      } else if (given !== undefined && price !== cur.priceCents) {
        shops.push({ shopId, patch: { priceCents: price } });
        changes.push({ field: "price", shop: shopName(shopId), from: money(cur.priceCents ?? exS!.defaultPriceCents), to: money(given) });
      }
    }
    return out({ type: "service", id: exS?.id ?? null, create: exS ? undefined : next, patch: patch && Object.keys(patch).length ? patch : undefined, shops }, !exS);
  });

  const count = (a: PlannedRow["action"]) => rows.filter((r) => r.action === a).length;
  return {
    rows,
    fileErrors,
    warnings,
    summary: {
      rows: rows.length,
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      error: count("error"),
      stockChanges: rows.reduce((a, r) => a + (r.op?.type === "product" ? r.op.shops.filter((s) => s.stock).length : 0), 0),
    },
  };
}

// ───────────────────────────── Export ─────────────────────────────

/** The catalog in upload format, so an export can be edited and uploaded back unchanged. */
export function exportRows(catalog: Catalog, shops: ShopRef[]): string[][] {
  const headers = templateHeaders(shops);
  const sp = new Map(catalog.shopProducts.map((x) => [`${x.shopId}|${x.productId}`, x]));
  const ss = new Map(catalog.shopServices.map((x) => [`${x.shopId}|${x.serviceId}`, x]));
  const yes = (b: boolean) => (b ? "yes" : "no");
  const out: string[][] = [headers];
  for (const p of [...catalog.products].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
    const cols: Record<string, string> = {
      type: "product",
      sku: p.sku,
      name: p.name,
      category: p.category,
      maker: p.brand,
      brand_cost: money(p.costCents)!,
      price: money(p.priceCents)!,
      duration_min: "",
      tax_category: p.taxCategory,
      barcode: p.barcode ?? "",
      active: yes(p.active),
      low_stock_threshold: String(p.lowStockThreshold),
    };
    for (const s of shops) {
      const x = sp.get(`${s.id}|${p.id}`);
      cols[shopColumn("price", s)] = x ? money(x.priceCents)! : "";
      cols[shopColumn("stock", s)] = x ? String(x.stock) : "";
    }
    out.push(headers.map((h) => cols[h] ?? ""));
  }
  for (const v of [...catalog.services].filter((s) => s.sku).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    const cols: Record<string, string> = {
      type: v.kind,
      sku: v.sku!,
      name: v.name,
      category: v.category,
      price: money(v.defaultPriceCents)!,
      duration_min: String(v.defaultDurationMin),
      tax_category: v.taxCategory,
      active: yes(v.active),
    };
    for (const s of shops) {
      const x = ss.get(`${s.id}|${v.id}`);
      cols[shopColumn("price", s)] = x ? money(x.priceCents ?? v.defaultPriceCents)! : "";
    }
    out.push(headers.map((h) => cols[h] ?? ""));
  }
  return out;
}
