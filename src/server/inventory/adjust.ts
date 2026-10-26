import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { products, shopProducts, shops } from "@/db/schema";
import {
  ADJUST_DIRECTION,
  ADJUST_REASONS,
  ADJUST_REASON_LABEL,
  levelsProblem,
} from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { enqueueShopEmail } from "../notifications/queue";
import { Who, assertShop, postMovements, setOnHand } from "./ledger";
import { StockRow, stockLevels } from "./stock";

export const AdjustInput = z.object({
  shopId: z.uuid(),
  productId: z.uuid(),
  /** add / remove a number of units, or set on-hand to what's on the shelf. */
  mode: z.enum(["add", "remove", "set"]),
  qty: z.number().int("Enter whole units").min(0).max(100_000),
  reason: z.enum(ADJUST_REASONS),
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((s) => (s ? s : null)),
});

/** A manual stock change with a reason. Damage, theft and back bar only take stock away; found only adds. */
export async function adjustStock(who: Who, raw: z.input<typeof AdjustInput>) {
  const v = AdjustInput.parse(raw);
  assertShop(who, v.shopId);
  const dir = ADJUST_DIRECTION[v.reason];
  if (v.mode === "add" && dir === "out")
    throw new AppError(
      "bad_request",
      `${ADJUST_REASON_LABEL[v.reason]} only takes stock away`,
    );
  if (v.mode === "remove" && dir === "in")
    throw new AppError(
      "bad_request",
      `${ADJUST_REASON_LABEL[v.reason]} only adds stock`,
    );
  if (v.mode !== "set" && v.qty === 0)
    throw new AppError("bad_request", "Enter how many units");
  if (v.reason === "other" && !v.note)
    throw new AppError("bad_request", "Add a note saying what happened");
  return db.transaction(async (tx) => {
    const audited = {
      action: "inventory.adjust",
      entity: "product",
      entityId: v.productId,
      details: { mode: v.mode, qty: v.qty, reason: v.reason, note: v.note },
    };
    const base = {
      shopId: v.shopId,
      productId: v.productId,
      kind: "adjust" as const,
      reason: v.reason,
      note: v.note,
    };
    if (v.mode === "set") {
      const r = await setOnHand(
        tx,
        { ...base, to: v.qty },
        { actor: who.actor, audit: audited },
      );
      if (r.delta > 0 && dir === "out")
        throw new AppError(
          "bad_request",
          `${ADJUST_REASON_LABEL[v.reason]} only takes stock away; the shelf has more than on hand`,
        );
      if (r.delta < 0 && dir === "in")
        throw new AppError(
          "bad_request",
          `${ADJUST_REASON_LABEL[v.reason]} only adds stock; the shelf has less than on hand`,
        );
      return { delta: r.delta, onHand: r.to, warnings: [] as string[] };
    }
    const delta = v.mode === "add" ? v.qty : -v.qty;
    const r = await postMovements(tx, [{ ...base, delta }], {
      actor: who.actor,
      audit: audited,
    });
    return { delta, onHand: r.posted[0].balanceAfter, warnings: r.warnings };
  });
}

const level = z.number().int("Whole units").min(0).max(100_000).nullable();
export const ShopLevelsInput = z.object({
  shopId: z.uuid(),
  productId: z.uuid(),
  reorderPoint: level,
  par: level,
});

/** A shop's own par and reorder point for a product; null goes back to the brand default. */
export async function saveShopLevels(
  who: Who,
  raw: z.input<typeof ShopLevelsInput>,
) {
  const v = ShopLevelsInput.parse(raw);
  assertShop(who, v.shopId);
  const [row] = await db
    .select({ sp: shopProducts, p: products })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(
      and(
        eq(shopProducts.shopId, v.shopId),
        eq(shopProducts.productId, v.productId),
      ),
    );
  if (!row)
    throw new AppError(
      "bad_request",
      "That product isn't carried at this shop",
    );
  const reorder = v.reorderPoint ?? row.p.lowStockThreshold;
  const par = v.par ?? Math.max(row.p.parLevel, reorder);
  const problem = levelsProblem(reorder, par);
  if (problem) throw new AppError("bad_request", problem);
  const set = {
    lowStockThreshold:
      v.reorderPoint === row.p.lowStockThreshold ? null : v.reorderPoint,
    parLevel: v.par === row.p.parLevel ? null : v.par,
  };
  await db
    .update(shopProducts)
    .set(set)
    .where(
      and(
        eq(shopProducts.shopId, v.shopId),
        eq(shopProducts.productId, v.productId),
      ),
    );
  await audit(
    who.actor,
    "inventory.levels",
    "product",
    v.productId,
    {
      from: { reorderPoint: row.sp.lowStockThreshold, par: row.sp.parLevel },
      to: { reorderPoint: set.lowStockThreshold, par: set.parLevel },
    },
    v.shopId,
  );
}

export const ShopInventorySettings = z.object({
  shopId: z.uuid(),
  negativeStock: z.enum(["block", "warn"]),
  inventoryAlertEmail: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((s) => (s ? s : null))
    .refine(
      (s) => s === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s),
      "That email doesn't look right",
    ),
});

export async function saveShopInventorySettings(
  who: Who,
  raw: z.input<typeof ShopInventorySettings>,
) {
  const v = ShopInventorySettings.parse(raw);
  assertShop(who, v.shopId);
  const [before] = await db
    .select({
      negativeStock: shops.negativeStock,
      inventoryAlertEmail: shops.inventoryAlertEmail,
    })
    .from(shops)
    .where(eq(shops.id, v.shopId));
  if (!before) throw notFound("Shop");
  await db
    .update(shops)
    .set({
      negativeStock: v.negativeStock,
      inventoryAlertEmail: v.inventoryAlertEmail,
    })
    .where(eq(shops.id, v.shopId));
  await audit(
    who.actor,
    "inventory.settings",
    "shop",
    v.shopId,
    {
      from: before,
      to: {
        negativeStock: v.negativeStock,
        inventoryAlertEmail: v.inventoryAlertEmail,
      },
    },
    v.shopId,
  );
}

// ───────────────────────────── Low-stock alerts ─────────────────────────────

function alertBody(shop: string, rows: StockRow[]) {
  const lines = rows.map(
    (r) =>
      `• ${r.brand} ${r.name} (${r.sku}): ${r.available} available, reorder at ${r.levels.reorderPoint}, par ${r.levels.par}${r.onOrder ? `, ${r.onOrder} on order` : ""}${r.inTransit ? `, ${r.inTransit} in transit` : ""}${r.preferredVendor ? ` · ${r.preferredVendor.name}` : ""}`,
  );
  return [
    `${rows.length} ${rows.length === 1 ? "product is" : "products are"} at or below the reorder point at ${shop}:`,
    "",
    ...lines,
    "",
    "Suggested purchase orders are ready under Inventory → Purchase orders.",
  ].join("\n");
}

/**
 * Emails each shop's alert address (or the shop email) the products that have newly gone low.
 * A product alerts once, then again only after it's been restocked above the reorder point and
 * dropped again. `force` re-sends everything currently low.
 */
export async function sendLowStockAlerts(
  who: Who | null,
  shopIds: string[],
  o: { force?: boolean; now?: Date } = {},
) {
  const now = o.now ?? new Date();
  const rows = await stockLevels(shopIds);
  const recovered = rows.filter((r) => !r.low && r.lowAlertedAt);
  for (const r of recovered) {
    await db
      .update(shopProducts)
      .set({ lowAlertedAt: null })
      .where(
        and(
          eq(shopProducts.shopId, r.shopId),
          eq(shopProducts.productId, r.productId),
        ),
      );
  }
  const shopRows = shopIds.length
    ? await db
        .select({
          id: shops.id,
          name: shops.name,
          email: shops.email,
          alert: shops.inventoryAlertEmail,
        })
        .from(shops)
        .where(inArray(shops.id, shopIds))
    : [];
  const sent: {
    shopId: string;
    to: string;
    products: number;
    jobId: string;
  }[] = [];
  const skipped: { shopId: string; reason: string }[] = [];
  for (const s of shopRows) {
    const due = rows.filter(
      (r) => r.shopId === s.id && r.low && (o.force || !r.lowAlertedAt),
    );
    if (!due.length) continue;
    const to = s.alert ?? s.email;
    if (!to) {
      skipped.push({ shopId: s.id, reason: "No alert email or shop email" });
      continue;
    }
    const value = due.reduce(
      (a, r) => a + Math.max(0, r.levels.par - r.available) * r.costCents,
      0,
    );
    const jobId = await enqueueShopEmail(
      {
        kind: "low_stock",
        to,
        subject: `Low stock at ${s.name}: ${due.length} ${due.length === 1 ? "product" : "products"} (about ${formatCents(value)} to reach par)`,
        body: alertBody(s.name, due),
        shopId: s.id,
      },
      db,
      now,
    );
    await db
      .update(shopProducts)
      .set({ lowAlertedAt: now })
      .where(
        and(
          eq(shopProducts.shopId, s.id),
          inArray(
            shopProducts.productId,
            due.map((r) => r.productId),
          ),
        ),
      );
    await audit(
      who?.actor ?? { staffId: null, label: "system" },
      "inventory.low_stock_alert",
      "shop",
      s.id,
      {
        to,
        jobId,
        products: due.map((r) => ({
          productId: r.productId,
          available: r.available,
          reorderPoint: r.levels.reorderPoint,
        })),
        force: !!o.force,
      },
      s.id,
    );
    sent.push({ shopId: s.id, to, products: due.length, jobId });
  }
  return { sent, skipped, cleared: recovered.length };
}

export const allShopIds = async () =>
  (
    await db
      .select({ id: shops.id })
      .from(shops)
      .where(sql`true`)
  ).map((s) => s.id);
