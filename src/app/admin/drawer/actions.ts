"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { assertShopAccess, requireStaff } from "@/server/auth/staff";
import { closeDrawer } from "@/server/checkout";

export async function closeDrawerAction(input: { shopId: string; date: string; openingFloatCents: number; payoutsCents: number; countedCents: number; notes: string }) {
  return safe(async () => {
    const ctx = await requireStaff(["brand_admin", "shop_manager"]);
    assertShopAccess(ctx, input.shopId);
    const r = await closeDrawer({ ...input, actor: ctx.actor });
    revalidatePath("/admin/drawer");
    return r;
  });
}
