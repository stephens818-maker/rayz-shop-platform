"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { can, requireStaff, workingShopId } from "@/server/auth/staff";
import { customerAccess } from "@/server/customers";
import { AppError } from "@/server/errors";
import { buyAgain } from "@/server/product-history";

/** Buy again from the client's profile: onto their open ticket at this shop today, or a new one. */
export async function buyAgainAction(customerId: string, productId: string, qty: number) {
  return safe(async () => {
    const ctx = await requireStaff();
    if (!(await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId))) throw new AppError("not_found", "Client not found");
    const shopId = workingShopId(ctx);
    if (!shopId) throw new AppError("bad_request", "Pick a shop first");
    const r = await buyAgain({ customerId, productId, qty }, { shopId, staffId: ctx.staff.id, anyTicket: can(ctx, "checkout.any"), actor: ctx.actor });
    revalidatePath(`/admin/checkout/${r.saleId}`);
    return r;
  });
}
