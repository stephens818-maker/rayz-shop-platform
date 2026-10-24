"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sales } from "@/db/schema";
import { safe } from "@/server/action";
import { canAny, requireStaff } from "@/server/auth/staff";
import { refundSale, voidSale } from "@/server/checkout";
import { forbidden, notFound } from "@/server/errors";
import { Approval, ApprovalPermission, approvedActor } from "@/server/manager-approval";
import { reassignSale } from "@/server/reassign";
import { type StaffReceiptInput, sendReceiptFromStaff } from "@/server/receipts";
import { requireInTenant } from "@/server/tenant";

/**
 * Refunds, voids and reassigning a ticket: people with the permission do it themselves; anyone
 * else who works the tickets (and every shop login) needs a manager's PIN for each one.
 */
async function guard(saleId: string, perm: ApprovalPermission, approval: Approval | null | undefined) {
  const ctx = await requireStaff();
  await requireInTenant(ctx, "sale", saleId);
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { shopId: true, staffId: true } });
  if (!sale) throw notFound("Sale");
  if (!ctx.permissions.has(perm) && !canAny(ctx, ["sales.view", "checkout.any"])) throw forbidden(perm === "sales.refund" ? "You don't have permission to refund or void sales" : "You don't have permission to reassign tickets");
  return { ctx, actor: await approvedActor(ctx, sale.shopId, perm, approval) };
}

export async function voidAction(saleId: string, reason: string, approval?: Approval | null) {
  return safe(async () => {
    const { actor } = await guard(saleId, "sales.refund", approval);
    await voidSale(saleId, reason, actor);
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

export async function refundAction(
  input: { saleId: string; items: { saleItemId: string; qty: number }[]; tipCents: number; refundCardFee: boolean; reason: string; restock: boolean },
  approval?: Approval | null,
) {
  return safe(async () => {
    const { actor } = await guard(input.saleId, "sales.refund", approval);
    const r = await refundSale({ ...input, actor });
    revalidatePath(`/admin/sales/${input.saleId}`);
    return { refundedCents: r.refundedCents, giftCardsVoided: r.giftCardsVoided };
  });
}

export async function reassignAction(input: { saleId: string; toStaffId: string; reason: string }, approval?: Approval | null) {
  return safe(async () => {
    const { actor } = await guard(input.saleId, "sales.reassign", approval);
    const r = await reassignSale({ ...input, actor });
    revalidatePath(`/admin/sales/${input.saleId}`);
    revalidatePath("/admin/sales");
    return r;
  });
}
