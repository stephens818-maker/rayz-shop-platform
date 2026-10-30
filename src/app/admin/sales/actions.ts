"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { refunds, sales } from "@/db/schema";
import { safe } from "@/server/action";
import { assertSteppedUp } from "@/server/auth/sessions";
import { canAny, requireStaff } from "@/server/auth/staff";
import { assignRefundLines, refundSale, voidSale } from "@/server/checkout";
import { forbidden, notFound } from "@/server/errors";
import { Approval, ApprovalPermission, approvedFor } from "@/server/manager-approval";
import { reassignSale } from "@/server/reassign";
import { type StaffReceiptInput, sendReceiptFromStaff } from "@/server/receipts";
import { requireInTenant } from "@/server/tenant";

/**
 * Refunds, voids and reassigning a ticket: people with the permission do it themselves, up to their
 * dollar limit; anyone else who works the tickets (and every shop login), or anyone going over
 * their limit, needs the PIN of a manager whose limit covers it.
 */
const DENIED: Record<ApprovalPermission, string> = {
  "sales.refund": "You don't have permission to refund sales",
  "sales.void": "You don't have permission to void sales",
  "sales.reassign": "You don't have permission to reassign tickets",
};

async function guard(saleId: string, perm: ApprovalPermission, approval: Approval | null | undefined) {
  const ctx = await requireStaff();
  await requireInTenant(ctx, "sale", saleId);
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId), columns: { shopId: true, staffId: true } });
  if (!sale) throw notFound("Sale");
  if (!ctx.permissions.has(perm) && !canAny(ctx, ["sales.view", "checkout.any"])) throw forbidden(DENIED[perm]);
  const { actor, limitCents } = await approvedFor(ctx, sale.shopId, perm, approval);
  return { ctx, actor, limitCents };
}

export async function voidAction(saleId: string, reason: string, approval?: Approval | null) {
  return safe(async () => {
    const { actor, limitCents } = await guard(saleId, "sales.void", approval);
    await voidSale(saleId, reason, actor, new Date(), limitCents);
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
  input: { saleId: string; items: { saleItemId: string; qty: number }[]; tipCents: number; refundCardFee: boolean | "proportional"; reason: string; restock: boolean },
  approval?: Approval | null,
) {
  return safe(async () => {
    const { ctx, actor, limitCents } = await guard(input.saleId, "sales.refund", approval);
    // A manager's PIN typed for this refund is its own fresh check; without one, the person refunding confirms it's them.
    if (!actor.approvedBy) await assertSteppedUp(ctx, "refund");
    const r = await refundSale({ ...input, actor, maxCents: limitCents });
    revalidatePath(`/admin/sales/${input.saleId}`);
    return { refundedCents: r.refundedCents, giftCardsVoided: r.giftCardsVoided };
  });
}

/** Says what a Stripe dashboard refund was for, with the same authority as refunding; no money moves, so no dollar limit applies. */
export async function assignRefundLinesAction(
  input: { saleId: string; refundId: string; items: { saleItemId: string; qty: number }[]; tipCents: number; refundCardFee: boolean | "proportional"; restock: boolean },
  approval?: Approval | null,
) {
  return safe(async () => {
    const { actor } = await guard(input.saleId, "sales.refund", approval);
    const ref = await db.query.refunds.findFirst({ where: eq(refunds.id, input.refundId), columns: { saleId: true } });
    if (!ref || ref.saleId !== input.saleId) throw notFound("Refund");
    const r = await assignRefundLines({ refundId: input.refundId, items: input.items, tipCents: input.tipCents, refundCardFee: input.refundCardFee, restock: input.restock, actor });
    revalidatePath(`/admin/sales/${input.saleId}`);
    revalidatePath("/admin/sales");
    return { status: r.status };
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
