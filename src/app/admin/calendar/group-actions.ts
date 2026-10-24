"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { bookingGroups } from "@/db/schema";
import { safe } from "@/server/action";
import { assertShopAccess, authorize, can } from "@/server/auth/staff";
import {
  type GroupOptionsView,
  bookGroup,
  cancelGroup,
  checkInGroup,
  groupNoShow,
  openGroupSplitTickets,
  openGroupTicket,
  planGroup,
  startGroupDeposit,
} from "@/server/booking-groups";
import { staffWallTime } from "@/server/booking";
import { sendGroupToCheckout } from "@/server/combined-checkout";
import { customerAccess } from "@/server/customers";
import { isValidLocalDate } from "@/lib/time";
import { AppError, notFound } from "@/server/errors";

const touch = () => {
  revalidatePath("/admin/calendar");
  revalidatePath("/admin");
};

async function reachClient(staffId: string, viewAll: boolean, customerId: string) {
  if (!(await customerAccess({ staffId, viewAll }, customerId))) throw new AppError("not_found", "Client not found");
}

/**
 * The slot finder at the desk: the front desk's view of openings (no lead time or booking window),
 * from `afterMin` (the shop's wall clock on `date`) when given.
 */
export async function staffGroupOptionsAction(guardianId: string, input: { shopId: string; date: string; people: unknown[]; afterMin?: number | null }) {
  return safe(async () => {
    const ctx = await authorize("calendar.manage", "You can't book appointments");
    const p = z.object({ shopId: z.uuid(), date: z.string().refine(isValidLocalDate, "Pick a date"), afterMin: z.number().int().min(0).max(36 * 60).nullish() }).parse(input);
    assertShopAccess(ctx, p.shopId);
    await reachClient(ctx.staff.id, can(ctx, "clients.view_all"), z.uuid().parse(guardianId));
    const after = p.afterMin != null ? staffWallTime(p.date, p.afterMin).toISOString() : undefined;
    return planGroup({ shopId: p.shopId, date: p.date, people: input.people, after }, { guardianId, staff: true });
  });
}

/** Book the option picked, all or nothing. A seat taken in the meantime returns the times still open. */
export async function staffBookGroupAction(guardianId: string, input: unknown) {
  return safe(async () => {
    const ctx = await authorize("calendar.manage", "You can't book appointments");
    const shopId = z.object({ shopId: z.uuid() }).parse(input).shopId;
    assertShopAccess(ctx, shopId);
    await reachClient(ctx.staff.id, can(ctx, "clients.view_all"), z.uuid().parse(guardianId));
    try {
      const g = await bookGroup(input, { guardianId, source: "staff", actor: ctx.actor });
      touch();
      return { code: g.code as string | null, message: null, alternatives: null };
    } catch (e) {
      if (e instanceof AppError && e.code === "slot_unavailable") {
        const alt = (e.details as { alternatives?: GroupOptionsView } | undefined)?.alternatives ?? null;
        return { code: null, message: e.message, alternatives: alt };
      }
      throw e;
    }
  });
}

async function loadGroup(groupId: string, need: "calendar.manage" | "checkout.any") {
  const ctx = await authorize(need, need === "checkout.any" ? "You can't check out other barbers' clients" : "You can't change appointments");
  const g = await db.query.bookingGroups.findFirst({ where: eq(bookingGroups.id, z.uuid().parse(groupId)) });
  if (!g) throw notFound("Family booking");
  assertShopAccess(ctx, g.shopId);
  return { ctx, g };
}

export async function checkInGroupAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "calendar.manage");
    const n = await checkInGroup(g.id, ctx.actor);
    touch();
    return { checkedIn: n };
  });
}

export async function groupTicketAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "checkout.any");
    return { saleId: await openGroupTicket(g.id, ctx.actor) };
  });
}

/** Everyone in the group finished: one combined ticket, all of them ready in the checkout queue. */
export async function groupSendToCheckoutAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "checkout.any");
    const saleId = await sendGroupToCheckout(g.id, ctx.actor);
    touch();
    revalidatePath("/admin/sales");
    return { saleId };
  });
}

export async function groupSplitTicketsAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "checkout.any");
    const tickets = await openGroupSplitTickets(g.id, ctx.actor);
    touch();
    return { tickets };
  });
}

export async function groupNoShowAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "calendar.manage");
    const r = await groupNoShow(g.id, ctx.actor);
    touch();
    return r;
  });
}

export async function cancelGroupStaffAction(groupId: string, reason?: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "calendar.manage");
    await cancelGroup(g.code, { actor: ctx.actor, byCustomer: false, reason: reason?.slice(0, 200) });
    touch();
    return null;
  });
}

export async function groupDepositAction(groupId: string) {
  return safe(async () => {
    const { ctx, g } = await loadGroup(groupId, "checkout.any");
    return { saleId: await startGroupDeposit(g.id, ctx.actor) };
  });
}
