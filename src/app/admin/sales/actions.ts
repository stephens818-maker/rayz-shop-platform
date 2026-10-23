"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sales } from "@/db/schema";
import { safe } from "@/server/action";
import { authorize, canAny, requireStaff } from "@/server/auth/staff";
import { refundSale, voidSale } from "@/server/checkout";
import { forbidden, notFound } from "@/server/errors";
import { type StaffReceiptInput, sendReceiptFromStaff } from "@/server/receipts";
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

/** Text or email the receipt: the counter's choice right after paying, or again from the ticket or the client's history. */
export async function sendReceiptAction(saleId: string, input: StaffReceiptInput) {
  return safe(async () => {
    const ctx = await requireStaff();
    await requireInTenant(ctx, "sale", saleId);
    const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { staffId: true } });
    if (!sale) throw notFound("Sale");
    if (sale.staffId !== ctx.staff.id && !canAny(ctx, ["sales.view", "checkout.any"])) throw forbidden("You can send receipts only for your own clients' tickets");
    const r = await sendReceiptFromStaff(saleId, { channel: input.channel, onFile: !!input.onFile, to: input.to, atCheckout: !!input.atCheckout }, ctx.actor);
    revalidatePath(`/admin/sales/${saleId}`);
    return r;
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
