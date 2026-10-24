"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { sales } from "@/db/schema";
import { safe } from "@/server/action";
import { HANDOFF_COOKIE } from "@/server/auth/cookies";
import { HANDOFF_TTL, handoffToken } from "@/server/auth/handoff-lock";
import { StaffContext, authorize, can, requireStaff, workingShopId } from "@/server/auth/staff";
import { CheckoutLineInput, TenderInput, assertStaffAtShop, finalizeSale, lookupGiftCard, openBlankSale } from "@/server/checkout";
import { resolveCoupon } from "@/server/coupons";
import { assertCanEnter, clientPolicy } from "@/server/client-privacy";
import { findOrCreateCustomer } from "@/server/customers";
import { AppError, forbidden, notFound } from "@/server/errors";
import { sameHousehold } from "@/server/family";
import { addAppointmentToTicket, removeAppointmentFromTicket, ticketAppointmentIds } from "@/server/family-ticket";
import { HandoffDraftInput, endHandoffFromCounter, startHandoff } from "@/server/handoff";
import { holdRetail } from "@/server/inventory/stock";
import { requireInTenant } from "@/server/tenant";
import { inspectPaymentMethod, terminal } from "@/server/payments/processor";
import type { TipSplitMode } from "@/domain/handoff";

async function loadSale(ctx: StaffContext, saleId: string) {
  await requireInTenant(ctx, "sale", saleId);
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
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
    return resolveCoupon(code, { shopId: sale.shopId, customerId: sale.customerId, saleId: sale.id, appointmentId: sale.appointmentId });
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
    if ((await ticketAppointmentIds(saleId)).length && !(customerId && sale.customerId && (await sameHousehold(customerId, sale.customerId)))) {
      throw new AppError("conflict", "Take the family members off this ticket before changing who's paying");
    }
    await db.update(sales).set({ customerId }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}

/** A client who isn't on file yet: matched by phone or email if they are, otherwise created, then put on the ticket. */
export async function newClientAtCheckoutAction(saleId: string, input: { firstName: string; lastName?: string; phone?: string; email?: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    const sale = await loadSale(ctx, saleId);
    if (sale.status !== "open") throw new AppError("conflict", "Ticket is closed");
    assertCanEnter(await clientPolicy(ctx), input);
    const c = await db.transaction(async (tx) => {
      const row = await findOrCreateCustomer(input, sale.shopId, tx, { allowNoContact: true });
      await tx.update(sales).set({ customerId: row.id }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
      return row;
    });
    revalidatePath(`/admin/checkout/${saleId}`);
    return { id: c.id };
  });
}

/** Another household member's appointment today joins this ticket, so the parent pays once for everyone. */
export async function addFamilyToTicketAction(saleId: string, appointmentId: string) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    await loadSale(ctx, saleId);
    await requireInTenant(ctx, "appointment", appointmentId);
    await addAppointmentToTicket(saleId, appointmentId, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    revalidatePath("/admin/calendar");
    return null;
  });
}

export async function removeFamilyFromTicketAction(saleId: string, appointmentId: string) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    await loadSale(ctx, saleId);
    await removeAppointmentFromTicket(saleId, appointmentId, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    revalidatePath("/admin/calendar");
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
  promoCodes?: string[] | null;
  manualDiscount: { type: "percent" | "amount"; value: number; reason: string } | null;
  loyaltyRewardId: string | null;
  tipCents: number;
  giftCard: { code: string; amountCents: number } | null;
  tender: TenderInput;
  expectedTotalCents: number;
  rebookInWeeks: number | null;
  tipSplit?: TipSplitMode | null;
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
    return { saleId: r.saleId, rewardsIssued: r.rewardsIssued, giftCards: r.issuedGiftCards, rebook, stockWarnings: r.stockWarnings };
  });
}

/** Saves the retail on an open ticket so it counts as committed stock until the ticket is paid or voided. */
export async function holdRetailAction(saleId: string, lines: { productId: string; qty: number }[]) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    await holdRetail(saleId, lines);
    return null;
  });
}

/**
 * Turns this device to the client for the ticket as it stands: this browser is locked to the
 * customer screen (a signed cookie the middleware checks) until a staff PIN takes it back.
 */
export async function handToCustomerAction(saleId: string, draft: HandoffDraftInput) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    const h = await startHandoff(saleId, draft, {
      actor: ctx.actor,
      staffId: ctx.staff.id,
      canDiscount: can(ctx, "pos.discount"),
      canOverridePrice: can(ctx, "pos.price_override"),
      maxManualDiscountPct: ctx.maxDiscountPct,
    });
    (await cookies()).set(HANDOFF_COOKIE, await handoffToken(h.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: HANDOFF_TTL,
    });
    return { id: h.id };
  });
}

/** Ends a hand-off from another device, e.g. when the client walked away with the tablet. */
export async function endHandoffAction(saleId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    await endHandoffFromCounter(saleId, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}
