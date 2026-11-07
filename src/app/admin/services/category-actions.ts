"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveCategoryOrder } from "@/server/catalog-categories";

export async function saveCategoryOrderAction(kind: "service" | "product", names: string[]) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    await saveCategoryOrder(kind, names, ctx.actor);
    revalidatePath(kind === "service" ? "/admin/services" : "/admin/products");
    return null;
  });
}
