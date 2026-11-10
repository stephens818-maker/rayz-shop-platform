"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize, can } from "@/server/auth/staff";
import { workShopIds } from "@/server/auth/access";
import { forbidden } from "@/server/errors";
import { refreshStaffAccount } from "@/server/tips/accounts";
import { chainShopIds, recordTaxFormCheck } from "@/server/tips/tracker";

const refresh = () => revalidatePath("/admin/tips/tracker");

/** Asks Stripe for a barber's account as it is now, at a shop the manager runs the tracker for. */
export async function refreshAccountAction(staffId: string) {
  return safe(async () => {
    const ctx = await authorize("payouts.manage");
    const id = z.string().uuid().parse(staffId);
    const allowed = new Set(can(ctx, "payouts.chain") ? await chainShopIds() : ctx.shopIds);
    if (!(await workShopIds(id)).some((s) => allowed.has(s))) throw forbidden("They don't work at a shop you can see");
    await refreshStaffAccount(id);
    refresh();
    return null;
  });
}

/** Records this year's check that Stripe won't file 1099s for the barbers' accounts. The whole chain's, so it needs every shop. */
export async function recordTaxCheckAction(taxYear: number) {
  return safe(async () => {
    const ctx = await authorize("payouts.manage");
    if (!can(ctx, "payouts.chain") && !ctx.brandWide) throw forbidden("The tax form check covers every shop; it needs the payout tracker for every shop.");
    const r = await recordTaxFormCheck(ctx.actor, z.number().int().parse(taxYear));
    refresh();
    return r;
  });
}
