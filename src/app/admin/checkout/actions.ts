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
import { CheckoutLineInput, SplitTenderInput, TenderInput, assertStaffAtShop, finalizeSale, lookupGiftCard, openBlankSale } from "@/server/checkout";
import { acceptRebook, addPromptProduct, declinePrompt, tagUsedProduct, untagUsedProduct } from "@/server/checkout-prompts";
import { mergeTickets, openTickets, splitOffTicket, splitTicketApart } from "@/server/combined-checkout";
import { resolveCoupon } from "@/server/coupons";
import { clientPolicy } from "@/server/client-privacy";
import { checkEntry, fillEntry, type EntryDetails } from "@/server/client-entry";
import { findOrCreateCustomer } from "@/server/customers";
import { AppError, forbidden, notFound } from "@/server/errors";
import { sameHousehold } from "@/server/family";
import { addAppointmentToTicket, removeAppointmentFromTicket, ticketAppointmentIds, ticketPeople } from "@/server/family-ticket";
import { HandoffDraftInput, endHandoffFromCounter, startHandoff } from "@/server/handoff";
import { sendToApp } from "@/server/app-pay";
import { holdRetail } from "@/server/inventory/stock";
import { requireInTenant } from "@/server/tenant";
import { inspectPaymentMethod, terminal } from "@/server/payments/processor";
import type { StaffTip } from "@/domain/combined-checkout";
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
    if ((await ticketAppointmentIds(saleId)).length) {
      // A combined ticket's payer is someone on it, or someone in the payer's household.
      const onTicket = (await ticketPeople(sale)).some((p) => p.customerId === customerId);
      if (!(customerId && (onTicket || (sale.customerId && (await sameHousehold(customerId, sale.customerId)))))) {
        throw new AppError("conflict", "On a combined ticket, the payer is one of the people on it. Split the others off first to change that.");
      }
    }
    await db.update(sales).set({ customerId }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}

/** A client who isn't on file yet: matched by phone or email if they are, otherwise created, then put on the ticket. */
export async function newClientAtCheckoutAction(saleId: string, input: { firstName: string; lastName?: string } & EntryDetails) {
  return safe(async () => {
    const ctx = await requireStaff();
    const sale = await loadSale(ctx, saleId);
    if (sale.status !== "open") throw new AppError("conflict", "Ticket is closed");
    const { firstName, lastName, ...details } = input;
    const typed = checkEntry(await clientPolicy(ctx), details);
    const c = await db.transaction(async (tx) => {
      const row = await findOrCreateCustomer({ firstName, lastName, phone: typed.phone, email: typed.email }, sale.shopId, tx, { allowNoContact: true });
      await tx.update(sales).set({ customerId: row.id }).where(and(eq(sales.id, saleId), eq(sales.status, "open")));
      return row;
    });
    await fillEntry(c.id, typed, { actor: ctx.actor, staffId: ctx.staff.id, shopId: sale.shopId });
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

const touchTickets = (...saleIds: string[]) => {
  for (const id of saleIds) revalidatePath(`/admin/checkout/${id}`);
  revalidatePath("/admin/sales");
  revalidatePath("/admin/calendar");
};

/** The "add ticket" picker: other open tickets at this ticket's shop, by number or anyone's name on them. */
export async function searchTicketsAction(saleId: string, q: string) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    const sale = await loadSale(ctx, saleId);
    const found = await openTickets([sale.shopId], { excludeSaleId: sale.id, q: q.slice(0, 60), limit: 100 });
    return found.slice(0, 12).map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), people: t.people.map((p) => ({ ...p, readyAt: p.readyAt?.toISOString() ?? null })) }));
  });
}

/** Combine other open tickets into this one (siblings who walked in apart, a friend paying for both). */
export async function mergeTicketsAction(saleId: string, sourceIds: string[]) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    await loadSale(ctx, saleId);
    const ids = [...new Set(sourceIds)].slice(0, 12);
    for (const id of ids) await requireInTenant(ctx, "sale", id);
    await mergeTickets(saleId, ids, ctx.actor);
    touchTickets(saleId, ...ids);
    return null;
  });
}

/** One person on a combined ticket gets their own ticket again, with their lines. */
export async function splitOffAction(saleId: string, appointmentId: string) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    await loadSale(ctx, saleId);
    const own = await splitOffTicket(saleId, appointmentId, ctx.actor);
    touchTickets(saleId, own);
    return { saleId: own };
  });
}

/** Everyone on a combined ticket gets their own. */
export async function splitApartAction(saleId: string) {
  return safe(async () => {
    const ctx = await authorize("checkout.any");
    await loadSale(ctx, saleId);
    const made = await splitTicketApart(saleId, ctx.actor);
    touchTickets(saleId, ...made);
    return { saleIds: made };
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
  membershipId?: string | null;
  tipCents: number;
  giftCard: { code: string; amountCents: number } | null;
  tender: TenderInput;
  expectedTotalCents: number;
  rebookInWeeks: number | null;
  tipSplit?: TipSplitMode | null;
  tipByStaff?: StaffTip[] | null;
  tenders?: SplitTenderInput[] | null;
  ticketPeople?: string[] | null;
  waiveCardFee?: { reason: string } | null;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, input.saleId);
    if (input.manualDiscount && input.manualDiscount.value > 0 && !can(ctx, "pos.discount")) throw forbidden("You don't have permission to give discounts");
    if (input.manualDiscount && input.manualDiscount.value > 0 && !input.manualDiscount.reason.trim()) {
      throw new AppError("bad_request", "Add a reason for the discount");
    }
    const r = await finalizeSale({ ...input, canOverridePrice: can(ctx, "pos.price_override"), canCustomCharge: can(ctx, "pos.custom_charge"), canWaiveCardFee: can(ctx, "pos.waive_card_fee"), waiveCardFee: input.waiveCardFee?.reason ? { reason: input.waiveCardFee.reason, byStaffId: ctx.staff.id } : null, maxManualDiscountPct: ctx.maxDiscountPct, actor: ctx.actor });
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    revalidatePath("/admin/sales");
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
      canCustomCharge: can(ctx, "pos.custom_charge"),
      canWaiveCardFee: can(ctx, "pos.waive_card_fee"),
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

/** Sends the ticket as it stands to the client's phone to tip and pay in the app (C7). Ended from here like a customer screen. */
export async function sendToAppAction(saleId: string, draft: HandoffDraftInput) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    const r = await sendToApp(saleId, draft, {
      actor: ctx.actor,
      staffId: ctx.staff.id,
      canDiscount: can(ctx, "pos.discount"),
      canOverridePrice: can(ctx, "pos.price_override"),
      canCustomCharge: can(ctx, "pos.custom_charge"),
      canWaiveCardFee: can(ctx, "pos.waive_card_fee"),
      maxManualDiscountPct: ctx.maxDiscountPct,
    });
    revalidatePath(`/admin/checkout/${saleId}`);
    return r;
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

/** The rebook prompt: book the time picked (everyone the prompt covers, for a family). */
export async function acceptRebookAction(saleId: string, promptId: string, pick: { index: number; startsAt: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    const r = await acceptRebook(saleId, promptId, pick, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    revalidatePath("/admin/calendar");
    return r;
  });
}

/** A prompt answered "not now", with an optional reason and (rebook) an optional reminder to book. */
export async function declinePromptAction(saleId: string, promptId: string, input: { reason?: string | null; remind?: boolean }) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    await declinePrompt(saleId, promptId, input, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}

/** A suggested product put on the ticket from the product prompt. */
export async function addPromptProductAction(saleId: string, promptId: string, productId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    await addPromptProduct(saleId, promptId, productId, ctx.actor);
    return null;
  });
}

/** A product the barber used in the service, tagged (or untagged) on the ticket for the product prompt. */
export async function tagUsedProductAction(saleId: string, productId: string, used: boolean) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadSale(ctx, saleId);
    if (used) await tagUsedProduct(saleId, productId, ctx.actor);
    else await untagUsedProduct(saleId, productId, ctx.actor);
    revalidatePath(`/admin/checkout/${saleId}`);
    return null;
  });
}
