"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { inventoryAdjustments, products, services, shopProducts } from "@/db/schema";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, assertCan, authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";

const ShopProduct = z.object({ costCents: z.number().int().min(0), priceCents: z.number().int().min(0), lowStockThreshold: z.number().int().min(0), active: z.boolean() });

/** Price, cost and whether the shop sells it need price access; the reorder point is inventory. */
export async function saveShopProductAction(shopId: string, productId: string, raw: z.input<typeof ShopProduct>) {
  return safe(async () => {
    const ctx = await authorize(["catalog.prices", "catalog.manage", "inventory.manage"]);
    assertShopAccess(ctx, shopId);
    const v = ShopProduct.parse(raw);
    const before = await db.query.shopProducts.findFirst({ where: and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId)) });
    const pricing = !before || before.costCents !== v.costCents || before.priceCents !== v.priceCents || before.active !== v.active;
    if (pricing) assertCan(ctx, ["catalog.prices", "catalog.manage"], "You can change stock and reorder points, but not prices or what the shop sells");
    if (before && before.lowStockThreshold !== v.lowStockThreshold) assertCan(ctx, ["inventory.manage", "catalog.manage"], "You don't have permission to change reorder points");
    await db
      .insert(shopProducts)
      .values({ shopId, productId, ...v })
      .onConflictDoUpdate({ target: [shopProducts.shopId, shopProducts.productId], set: v });
    await audit(ctx.actor, "inventory.update", "product", productId, v, shopId);
    revalidatePath("/admin/inventory");
    return null;
  });
}

export async function adjustStockAction(shopId: string, productId: string, mode: "receive" | "count" | "damage", qty: number) {
  return safe(async () => {
    const ctx = await authorize("inventory.manage");
    assertShopAccess(ctx, shopId);
    if (!Number.isInteger(qty) || qty < 0) throw new AppError("bad_request", "Enter a whole number");
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(shopProducts).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId))).for("update");
      if (!row) throw new AppError("not_found", "Product isn't stocked here");
      const delta = mode === "receive" ? qty : mode === "damage" ? -qty : qty - row.stock;
      if (delta === 0) return;
      await tx.update(shopProducts).set({ stock: sql`${shopProducts.stock} + ${delta}` }).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId)));
      await tx.insert(inventoryAdjustments).values({ shopId, productId, delta, reason: mode, staffId: ctx.staff.id });
      await audit(ctx.actor, `inventory.${mode}`, "product", productId, { delta, from: row.stock }, shopId, tx);
    });
    revalidatePath("/admin/inventory");
    return null;
  });
}

const NewProduct = z.object({ sku: z.string().trim().min(1), name: z.string().trim().min(1), brand: z.string().trim().min(1), category: z.string().trim().min(1) });

export async function createProductAction(raw: z.input<typeof NewProduct>) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    const v = { ...NewProduct.parse(raw), sku: NewProduct.parse(raw).sku.toUpperCase() };
    const exists = (await db.query.products.findFirst({ where: eq(products.sku, v.sku) })) ?? (await db.query.services.findFirst({ where: eq(services.sku, v.sku) }));
    if (exists) throw new AppError("conflict", "That SKU already exists");
    const [p] = await db.insert(products).values(v).returning();
    await audit(ctx.actor, "product.create", "product", p.id, v, null);
    revalidatePath("/admin/inventory");
    return { id: p.id };
  });
}
