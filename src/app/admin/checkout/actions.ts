"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { sales } from "@/db/schema";
import { safe } from "@/server/action";
import { StaffContext, assertShopAccess, authorize, can, requireStaff, workingShopId } from "@/server/auth/staff";
import { CheckoutLineInput, TenderInput, assertStaffAtShop, finalizeSale, lookupGiftCard, openBlankSale, validatePromo } from "@/server/checkout";
import { AppError, forbidden, notFound } from "@/server/errors";
import { inspectPaymentMethod, terminal } from "@/server/payments/processor";

async function loadSale(ctx: StaffContext, saleId: string) {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  assertShopAccess(ctx, sale.shopId);
  if (sale.staffId !== ctx.staff.id && !can(ctx, "checkout.any")) throw forbidden("You can only check out your own clients");
  return sale;
}

export async function newSaleAction() {
  const ctx = await authorize("checkout.any");
  const shopId = workingShopId(ctx);
  if (!shopId) throw new AppError("bad_request", "Pick a shop first");
  const sale = await openBlankSale(shopId, ctx.actor);
  redirect(`/admin/checkout/${sale.id}`);
}

export async function promoAction(saleId: string, code: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const sale = await loadSale(ctx, saleId);
    const d = await validatePromo(code, sale.shopId);
    return { ...d, code: code.trim().toUpperCase() };
  });
}

export async function giftCardAction(code: string) {
  return safe(async () => {
    await requireStaff();
    return lookupGiftCard(code);
  });
}

/** Reads the card's funding type before charging so the credit-only fee is shown up front. */
export async function inspectCardAction(paymentMethodId: string) {
  return safe(async () => {
    await requireStaff();
    return inspectPaymentMethod(paymentMethodId);
  });
}

export async function terminalCollectAction(testCard: string) {
  return safe(async () => {
    await requireStaff();
    return terminal.collectPaymentMethod(testCard);
  });
}

export async function attachCustomerAction(saleId: string, customerId: string | null) {
  return safe(async () => {
    const ctx = await requireStaff();
    const sale = await loadSale(ctx, saleId);
    if (sale.status !== "open") throw new AppError("conflict", "Ticket is closed");
    await db.update(sales).set({ customerId }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}

export async function setBarberAction(saleId: string, staffId: string | null) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    const sale = await loadSale(ctx, saleId);
    if (staffId) await assertStaffAtShop(staffId, sale.shopId);
    await db.update(sales).set({ staffId }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}

export async function finalizeAction(input: {
  saleId: string;
  lines: CheckoutLineInput[];
  promoCode: string | null;
  manualDiscount: { type: "percent" | "amount"; value: number; reason: string } | null;
  loyaltyRewardId: string | null;
  tipCents: number;
  giftCard: { code: string; amountCents: number } | null;
  tender: TenderInput;
  expectedTotalCents: number;
  rebookInWeeks: number | null;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, input.saleId);
    if (input.manualDiscount && input.manualDiscount.value > 0 && !can(ctx, "pos.discount")) throw forbidden("You don't have permission to give discounts");
    if (input.manualDiscount && input.manualDiscount.value > 0 && !input.manualDiscount.reason.trim()) {
      throw new AppError("bad_request", "Add a reason for the discount");
    }
    const r = await finalizeSale({ ...input, canOverridePrice: can(ctx, "pos.price_override"), maxManualDiscountPct: ctx.maxDiscountPct, actor: ctx.actor });
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    const rebook = r.rebooked && "code" in r.rebooked ? { code: r.rebooked.code, startsAt: r.rebooked.startsAt } : r.rebooked && "error" in r.rebooked ? { error: r.rebooked.error } : null;
    return { saleId: r.saleId, rewardsIssued: r.rewardsIssued, giftCards: r.issuedGiftCards, rebook };
  });
}
