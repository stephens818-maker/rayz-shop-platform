"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import {
  AllocateInput,
  ReceiveInput,
  allocateBrandStock,
  receiveBrandStock,
} from "@/server/inventory/brand-stock";
import { whoOf } from "@/server/inventory/ledger";

const refresh = () => {
  revalidatePath("/admin/products");
  revalidatePath("/admin/inventory");
};

/** Brand stock belongs to no shop, so receiving it needs access to all of them. */
export async function receiveBrandStockAction(
  raw: z.input<typeof ReceiveInput>,
) {
  return safe(async () => {
    const ctx = await authorize("inventory.manage");
    if (!ctx.brandWide)
      throw forbidden(
        "Brand stock belongs to every shop, so receiving it needs access to all shops",
      );
    const r = await receiveBrandStock(whoOf(ctx), raw);
    refresh();
    return r;
  });
}

export async function allocateBrandStockAction(
  raw: z.input<typeof AllocateInput>,
) {
  return safe(async () => {
    const ctx = await authorize("inventory.manage");
    const r = await allocateBrandStock(whoOf(ctx), raw);
    refresh();
    return r;
  });
}
