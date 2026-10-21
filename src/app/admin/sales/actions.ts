"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { refundSale, voidSale } from "@/server/checkout";
import { requireInTenant } from "@/server/tenant";

async function guard(saleId: string) {
  const ctx = await authorize("sales.refund", "You don't have permission to refund or void sales");
  await requireInTenant(ctx, "sale", saleId);
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

export async function refundAction(input: { saleId: string; items: { saleItemId: string; qty: number }[]; tipCents: number; refundCardFee: boolean; reason: string; restock: boolean }) {
  return safe(async () => {
    const ctx = await guard(input.saleId);
    const r = await refundSale({ ...input, actor: ctx.actor });
    revalidatePath(`/admin/sales/${input.saleId}`);
    return { refundedCents: r.refundedCents, giftCardsVoided: r.giftCardsVoided };
  });
}
