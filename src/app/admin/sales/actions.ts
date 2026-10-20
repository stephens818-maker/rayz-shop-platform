"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { sales } from "@/db/schema";
import { safe } from "@/server/action";
import { assertShopAccess, requireStaff } from "@/server/auth/staff";
import { refundSale, voidSale } from "@/server/checkout";
import { notFound } from "@/server/errors";

async function guard(saleId: string) {
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  assertShopAccess(ctx, sale.shopId);
  return ctx;
}

export async function voidAction(saleId: string, reason: string) {
  return safe(async () => {
    const ctx = await guard(saleId);
    await voidSale(saleId, reason, ctx.actor);
    revalidatePath(`/admin/sales/${saleId}`);
    return null;
  });
}

export async function refundAction(saleId: string, amountCents: number, reason: string, restock: boolean) {
  return safe(async () => {
    const ctx = await guard(saleId);
    await refundSale(saleId, amountCents, reason, restock, ctx.actor);
    revalidatePath(`/admin/sales/${saleId}`);
    return null;
  });
}
