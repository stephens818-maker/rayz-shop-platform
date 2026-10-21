"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireStaff, SHOP_COOKIE } from "@/server/auth/staff";

export async function switchShop(shopId: string) {
  const ctx = await requireStaff();
  if (shopId === "all" ? !ctx.combinedView : !ctx.assignedShops.some((s) => s.id === shopId)) return;
  (await cookies()).set(SHOP_COOKIE, shopId, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/admin", "layout");
}
