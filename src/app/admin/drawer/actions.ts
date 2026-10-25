"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { closeDrawer } from "@/server/checkout";
import { openDrawer, openDrawerNoSale, recordDrawerMove } from "@/server/drawer";

export async function closeDrawerAction(input: { shopId: string; date: string; openingFloatCents: number; payoutsCents: number; countedCents: number; notes: string }) {
  return safe(async () => {
    const ctx = await authorize("drawer.manage");
    assertShopAccess(ctx, input.shopId);
    const r = await closeDrawer({ ...input, actor: ctx.actor });
    revalidatePath("/admin/drawer");
    return r;
  });
}

export async function openDrawerAction(input: { shopId: string; date: string; openingCents: number }) {
  return safe(async () => {
    const ctx = await authorize("drawer.manage");
    assertShopAccess(ctx, input.shopId);
    await openDrawer({ ...input, actor: ctx.actor });
    revalidatePath("/admin/drawer");
    return null;
  });
}

export async function drawerMoveAction(input: { shopId: string; date: string; kind: "paid_in" | "paid_out"; amountCents: number; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("drawer.manage");
    assertShopAccess(ctx, input.shopId);
    await recordDrawerMove({ ...input, actor: ctx.actor });
    revalidatePath("/admin/drawer");
    return null;
  });
}

export async function noSaleAction(input: { shopId: string; date: string; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("drawer.no_sale");
    assertShopAccess(ctx, input.shopId);
    await openDrawerNoSale({ ...input, actor: ctx.actor });
    revalidatePath("/admin/drawer");
    return null;
  });
}
