"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { products, services, shopProducts } from "@/db/schema";
import { Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { assertShopMayEdit, noteShopEdit } from "@/server/brand-sync/engine";
import { AppError } from "@/server/errors";
import {
  AdjustInput,
  ShopInventorySettings,
  ShopLevelsInput,
  adjustStock,
  saveShopInventorySettings,
  saveShopLevels,
  sendLowStockAlerts,
} from "@/server/inventory/adjust";
import { whoOf } from "@/server/inventory/ledger";

async function staffFor(perms: Permission | Permission[], shopId?: string) {
  const ctx = await authorize(perms);
  if (shopId) assertShopAccess(ctx, shopId);
  return { ctx, who: whoOf(ctx) };
}

const refresh = () => {
  revalidatePath("/admin/inventory");
  revalidatePath("/admin/inventory/low-stock");
};

const ShopProduct = z.object({
  costCents: z.number().int().min(0),
  priceCents: z.number().int().min(0),
  active: z.boolean(),
});

/** Price, cost and whether the shop sells it. Stock moves through the ledger; par and reorder point are inventory settings. */
export async function saveShopProductAction(
  shopId: string,
  productId: string,
  raw: z.input<typeof ShopProduct>,
) {
  return safe(async () => {
    const { ctx } = await staffFor(
      ["catalog.prices", "catalog.manage"],
      shopId,
    );
    const v = ShopProduct.parse(raw);
    const before = await db.query.shopProducts.findFirst({
      where: and(
        eq(shopProducts.shopId, shopId),
        eq(shopProducts.productId, productId),
      ),
    });
    if (
      before
        ? before.priceCents !== v.priceCents
        : (
            await db.query.products.findFirst({
              where: eq(products.id, productId),
              columns: { priceCents: true },
            })
          )?.priceCents !== v.priceCents
    )
      await assertShopMayEdit(ctx, "product");
    await db
      .insert(shopProducts)
      .values({ shopId, productId, ...v })
      .onConflictDoUpdate({
        target: [shopProducts.shopId, shopProducts.productId],
        set: v,
      });
    await audit(
      ctx.actor,
      before ? "inventory.update" : "inventory.carry",
      "product",
      productId,
      {
        ...v,
        ...(before
          ? {
              from: {
                costCents: before.costCents,
                priceCents: before.priceCents,
                active: before.active,
              },
            }
          : {}),
      },
      shopId,
    );
    await noteShopEdit("product", [productId], shopId);
    refresh();
    return null;
  });
}

export async function adjustStockAction(raw: z.input<typeof AdjustInput>) {
  return safe(async () => {
    const { who } = await staffFor("inventory.adjust", raw.shopId);
    const r = await adjustStock(who, raw);
    refresh();
    return r;
  });
}

export async function saveShopLevelsAction(
  raw: z.input<typeof ShopLevelsInput>,
) {
  return safe(async () => {
    const { who } = await staffFor("inventory.manage", raw.shopId);
    await saveShopLevels(who, raw);
    refresh();
    return null;
  });
}

export async function saveInventorySettingsAction(
  raw: z.input<typeof ShopInventorySettings>,
) {
  return safe(async () => {
    const { who } = await staffFor(
      ["inventory.manage", "settings.shop"],
      raw.shopId,
    );
    await saveShopInventorySettings(who, raw);
    revalidatePath("/admin/inventory/settings");
    return null;
  });
}

export async function sendLowStockAlertsAction(
  shopIds: string[],
  force = false,
) {
  return safe(async () => {
    const { ctx, who } = await staffFor("inventory.manage");
    for (const id of shopIds) assertShopAccess(ctx, id);
    const r = await sendLowStockAlerts(
      who,
      shopIds.length ? shopIds : ctx.shopIds,
      { force },
    );
    refresh();
    return r;
  });
}

const NewProduct = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  brand: z.string().trim().min(1),
  category: z.string().trim().min(1),
});

export async function createProductAction(raw: z.input<typeof NewProduct>) {
  return safe(async () => {
    const { ctx } = await staffFor("catalog.manage");
    const v = {
      ...NewProduct.parse(raw),
      sku: NewProduct.parse(raw).sku.toUpperCase(),
    };
    const exists =
      (await db.query.products.findFirst({ where: eq(products.sku, v.sku) })) ??
      (await db.query.services.findFirst({ where: eq(services.sku, v.sku) }));
    if (exists) throw new AppError("conflict", "That SKU already exists");
    const [p] = await db.insert(products).values(v).returning();
    await audit(ctx.actor, "product.create", "product", p.id, v, null);
    refresh();
    return { id: p.id };
  });
}
