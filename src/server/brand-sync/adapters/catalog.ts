import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { products, services, shopProducts, shopServices } from "@/db/schema";
import { money } from "@/domain/brand-sync";
import {
  effectiveLevels,
  highProblem,
  levelsProblem,
} from "@/domain/inventory";
import { durationProblem } from "@/domain/timing";
import { slugify } from "@/lib/ids";
import { audit } from "../../audit";
import { AppError, notFound } from "../../errors";
import type { SyncAdapter } from "../types";

// ───────────────────────────── Services ─────────────────────────────

export const ServiceInput = z.object({
  name: z.string().trim().min(1, "Give the service a name"),
  kind: z.enum(["service", "addon"]),
  category: z.string().trim().min(1),
  description: z.string().trim().nullable(),
  defaultPriceCents: z.number().int().min(0),
  defaultDurationMin: z.number().int().min(5).max(480),
  active: z.boolean(),
  sortOrder: z.number().int(),
});
export type ServiceBrand = z.output<typeof ServiceInput>;
/** At a shop: whether it's offered there, and its price and length. */
export type ServiceValue = { offered: true; priceCents: number; durationMin: number } | { offered: false; priceCents: null; durationMin: null };
const NOT_OFFERED: ServiceValue = { offered: false, priceCents: null, durationMin: null };

export const serviceAdapter: SyncAdapter<ServiceBrand, ServiceValue> = {
  type: "service",
  noun: "Service",
  area: "services",
  store: "native",
  live: true,
  brandPerms: ["catalog.manage"],
  lockable: true,
  paths: ["/admin/services", "/admin/catalog"],
  async items(tx) {
    const rows = await tx
      .select({ id: services.id, name: services.name, category: services.category, kind: services.kind })
      .from(services)
      .where(eq(services.active, true))
      .orderBy(asc(services.kind), asc(services.sortOrder), asc(services.name));
    return rows.map((r) => ({ id: r.id, label: r.name, hint: r.kind === "addon" ? `Add-on · ${r.category}` : r.category }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rows = await tx.select().from(services).where(inArray(services.id, [...ids]));
    return new Map(
      rows.map((s) => [
        s.id,
        { name: s.name, kind: s.kind, category: s.category, description: s.description, defaultPriceCents: s.defaultPriceCents, defaultDurationMin: s.defaultDurationMin, active: s.active, sortOrder: s.sortOrder },
      ]),
    );
  },
  view: (b) => ({ offered: true, priceCents: b.defaultPriceCents, durationMin: b.defaultDurationMin }),
  async parse(_who, raw, item, before, tx) {
    const m = ServiceInput.parse(
      before ? { ...before, ...(raw as object) } : raw,
    );
    const [svc] = before ? await tx.select({ step: services.durationStepMin }).from(services).where(eq(services.id, item)) : [];
    // A timing save that changes the step with the length sends the new step too.
    const step = (raw as { durationStepMin?: unknown }).durationStepMin;
    const problem = durationProblem(
      m.defaultDurationMin,
      typeof step === "number" ? step : (svc?.step ?? 5),
    );
    if (problem) throw new AppError("bad_request", problem);
    if (!before && !slugify(m.name)) throw new AppError("bad_request", "Name needs letters or numbers");
    return m;
  },
  async shops(tx, ids, shopIds, brand) {
    const rows = ids.length && shopIds.length ? await tx.select().from(shopServices).where(and(inArray(shopServices.serviceId, [...ids]), inArray(shopServices.shopId, [...shopIds]))) : [];
    const byKey = new Map(rows.map((r) => [`${r.shopId}|${r.serviceId}`, r]));
    const out = new Map<string, { value: ServiceValue; follows: boolean }>();
    for (const id of ids) {
      const b = brand.get(id);
      for (const shopId of shopIds) {
        const r = byKey.get(`${shopId}|${id}`);
        if (!r || !r.enabled || !b) out.set(`${shopId}|${id}`, { value: NOT_OFFERED, follows: false });
        else
          out.set(`${shopId}|${id}`, {
            value: { offered: true, priceCents: r.priceCents ?? b.defaultPriceCents, durationMin: r.durationMin ?? b.defaultDurationMin },
            follows: r.priceCents === null && r.durationMin === null,
          });
      }
    }
    return out;
  },
  async write(tx, who, item, brand, shops) {
    if (brand?.to === null) {
      await tx.update(services).set({ active: false }).where(eq(services.id, item));
      await audit(who.actor, "service.update", "service", item, { active: false, via: "brand_sync.rollback" }, null, tx);
    } else if (brand) {
      if (brand.from) await tx.update(services).set(brand.to).where(eq(services.id, item));
      else {
        const base = slugify(brand.to.name);
        const [taken] = await tx.select({ id: services.id }).from(services).where(eq(services.slug, base));
        await tx.insert(services).values({ id: item, ...brand.to, slug: taken ? `${base}-${Date.now().toString(36).slice(-4)}` : base });
      }
      await audit(who.actor, brand.from ? "service.update" : "service.create", "service", item, brand.to, null, tx);
    }
    for (const [shopId, w] of shops) {
      if (w.follow || w.value.offered) {
        const set = w.follow ? { enabled: true, priceCents: null, durationMin: null } : { enabled: true, priceCents: w.value.priceCents, durationMin: w.value.durationMin };
        await tx
          .insert(shopServices)
          .values({ shopId, serviceId: item, ...set })
          .onConflictDoUpdate({ target: [shopServices.shopId, shopServices.serviceId], set });
      } else await tx.update(shopServices).set({ enabled: false }).where(and(eq(shopServices.shopId, shopId), eq(shopServices.serviceId, item)));
    }
  },
  describe: (v): Record<string, string> => (v.offered ? { Offered: "Yes", Price: money(v.priceCents), Length: `${v.durationMin} min` } : { Offered: "No" }),
  short: (v) => (v.offered ? `${money(v.priceCents)} · ${v.durationMin} min` : "Not offered"),
};

// ───────────────────────────── Products ─────────────────────────────

const units = z.number().int("Whole units").min(0).max(100_000);
export const ProductInput = z.object({
  sku: z.string().trim().min(1, "Enter a SKU").max(40),
  brand: z.string().trim().min(1, "Enter the brand").max(60),
  category: z.string().trim().min(1).max(60),
  costCents: z.number().int().min(0).max(1_000_000),
  priceCents: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: units,
  parLevel: units,
  highStockThreshold: units.nullable(),
  /** Left as it is when not sent. */
  active: z.boolean().optional(),
});
export type ProductBrand = z.output<typeof ProductInput>;
/** At a shop that carries it: its retail price and stock levels. */
export type ProductValue = {
  priceCents: number;
  reorderPoint: number;
  par: number;
};

export const productAdapter: SyncAdapter<ProductBrand, ProductValue> = {
  type: "product",
  noun: "Product",
  area: "products",
  store: "native",
  live: false,
  brandPerms: ["catalog.manage"],
  lockable: true,
  note: "Only shops that carry the product get its retail price and stock levels. The SKU, maker, category and supply price stay brand-wide: the brand buys it once for every shop.",
  paths: ["/admin/products", "/admin/inventory"],
  async items(tx) {
    const rows = await tx
      .select({ id: products.id, name: products.name, brand: products.brand, category: products.category })
      .from(products)
      .where(eq(products.active, true))
      .orderBy(asc(products.brand), asc(products.name));
    return rows.map((r) => ({ id: r.id, label: `${r.brand} ${r.name}`, hint: r.category }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rows = await tx.select().from(products).where(inArray(products.id, [...ids]));
    return new Map(
      rows.map((p) => [
        p.id,
        { sku: p.sku, brand: p.brand, category: p.category, costCents: p.costCents, priceCents: p.priceCents, lowStockThreshold: p.lowStockThreshold, parLevel: p.parLevel, highStockThreshold: p.highStockThreshold, active: p.active },
      ]),
    );
  },
  view: (b) => ({ priceCents: b.priceCents, ...effectiveLevels(b) }),
  async parse(_who, raw, item, before, tx) {
    if (!before) throw notFound("Product");
    const v = ProductInput.parse({ ...before, ...(raw as object) });
    const problem = levelsProblem(v.lowStockThreshold, v.parLevel) ?? highProblem(v.parLevel, v.highStockThreshold);
    if (problem) throw new AppError("bad_request", problem);
    const [clash] = await tx
      .select({ brand: products.brand, name: products.name })
      .from(products)
      .where(and(sql`lower(${products.sku}) = lower(${v.sku})`, ne(products.id, item)));
    if (clash) throw new AppError("conflict", `SKU ${v.sku} is already ${clash.brand} ${clash.name}`);
    return { ...v, active: v.active ?? before.active };
  },
  async shops(tx, ids, shopIds, brand) {
    if (!ids.length || !shopIds.length) return new Map();
    const rows = await tx
      .select({
        shopId: shopProducts.shopId,
        productId: shopProducts.productId,
        price: shopProducts.priceCents,
        low: shopProducts.lowStockThreshold,
        par: shopProducts.parLevel,
      })
      .from(shopProducts)
      .where(and(inArray(shopProducts.productId, [...ids]), inArray(shopProducts.shopId, [...shopIds]), eq(shopProducts.active, true)));
    const out = new Map<string, { value: ProductValue; follows: boolean }>();
    for (const r of rows) {
      const b = brand.get(r.productId);
      if (b)
        out.set(`${r.shopId}|${r.productId}`, {
          value: {
            priceCents: r.price,
            ...effectiveLevels(b, {
              lowStockThreshold: r.low,
              parLevel: r.par,
            }),
          },
          follows: false,
        });
    }
    return out;
  },
  async write(tx, who, item, brand, shops) {
    if (brand?.to) {
      await tx.update(products).set(brand.to).where(eq(products.id, item));
      const from = brand.from as Record<string, unknown> | null;
      const changed = Object.fromEntries(
        Object.entries(brand.to)
          .filter(([k, x]) => from?.[k] !== x)
          .map(([k, x]) => [k, { from: from?.[k] ?? null, to: x }]),
      );
      await audit(who.actor, "product.details", "product", item, { changed }, null, tx);
    }
    if (!shops.size) return;
    const levels =
      brand?.to ??
      (
        await tx
          .select({
            lowStockThreshold: products.lowStockThreshold,
            parLevel: products.parLevel,
          })
          .from(products)
          .where(eq(products.id, item))
      )[0];
    for (const [shopId, w] of shops)
      await tx
        .update(shopProducts)
        .set({
          priceCents: w.value.priceCents,
          // The brand's level is stored as null, so the shop keeps following the brand's later.
          lowStockThreshold:
            levels && w.value.reorderPoint === levels.lowStockThreshold
              ? null
              : w.value.reorderPoint,
          parLevel:
            levels && w.value.par === levels.parLevel ? null : w.value.par,
        })
        .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, item)));
  },
  describe: (v) => ({
    "Retail price": money(v.priceCents),
    "Reorder point": String(v.reorderPoint),
    Par: String(v.par),
  }),
  short: (v) =>
    `${money(v.priceCents)} · reorder ${v.reorderPoint}, par ${v.par}`,
};
