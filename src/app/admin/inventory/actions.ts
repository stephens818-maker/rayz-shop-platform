"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { inventoryAdjustments, products, shopProducts } from "@/db/schema";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, requireStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";

const MGR = ["brand_admin", "shop_manager"] as const;

const ShopProduct = z.object({ costCents: z.number().int().min(0), priceCents: z.number().int().min(0), lowStockThreshold: z.number().int().min(0), active: z.boolean() });

export async function saveShopProductAction(shopId: string, productId: string, raw: z.input<typeof ShopProduct>) {
  return safe(async () => {
    const ctx = await requireStaff([...MGR]);
    assertShopAccess(ctx, shopId);
    const v = ShopProduct.parse(raw);
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
    const ctx = await requireStaff([...MGR]);
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
    const ctx = await requireStaff(["brand_admin"]);
    const v = NewProduct.parse(raw);
    const exists = await db.query.products.findFirst({ where: eq(products.sku, v.sku) });
    if (exists) throw new AppError("conflict", "That SKU already exists");
    const [p] = await db.insert(products).values(v).returning();
    await audit(ctx.actor, "product.create", "product", p.id, v, null);
    revalidatePath("/admin/inventory");
    return { id: p.id };
  });
}
