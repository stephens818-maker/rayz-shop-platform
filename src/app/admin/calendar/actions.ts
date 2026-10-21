"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { appointments, staffShops, timeBlocks } from "@/db/schema";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { timeBlockChangeDenied } from "@/server/auth/policy";
import { StaffContext, assertShopAccess, can, caller, requireStaff } from "@/server/auth/staff";
import { createAppointment, rescheduleAppointment, setAppointmentStatus, staffWallTime } from "@/server/booking";
import { openSaleForAppointment } from "@/server/checkout";
import { clientSearchScope, maskPhone, searchCustomers } from "@/server/customers";
import { AppError, forbidden, notFound } from "@/server/errors";
import { ratingSummaries } from "@/server/ratings";
import { hasShop, requireInTenant } from "@/server/tenant";

async function barberShops(staffId: string) {
  return (await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
}

/** Without "manage the calendar", people work only in their own column. */
const ownColumnOnly = (ctx: StaffContext) => !can(ctx, "calendar.manage");

async function loadAppt(ctx: StaffContext, id: string, othersNeed: "calendar.manage" | "checkout.any" = "calendar.manage") {
  await requireInTenant(ctx, "appointment", id);
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound("Appointment");
  if (a.staffId !== ctx.staff.id && !can(ctx, othersNeed)) throw forbidden("You can only change your own appointments");
  return a;
}

type Status = "confirmed" | "checked_in" | "in_service" | "completed" | "cancelled" | "no_show" | "booked";

export async function setStatusAction(id: string, status: Status) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadAppt(ctx, id);
    await setAppointmentStatus(id, status, ctx.actor);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    return null;
  });
}

export async function startCheckoutAction(appointmentId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadAppt(ctx, appointmentId, "checkout.any");
    const sale = await openSaleForAppointment(appointmentId, ctx.actor);
    return { saleId: sale.id, status: sale.status };
  });
}

/**
 * Brand-wide staff with "every client" search the shared book. Everyone else finds their shops'
 * clients by any part of a name or number, and clients of other shops only by an exact phone,
 * email or full name. Without contact access you see the last four digits of the phone and no email.
 */
export async function searchCustomersAction(q: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const term = q.trim();
    if (term.length < 2) return [];
    const full = can(ctx, "clients.view_all");
    const contact = can(ctx, "clients.contact");
    const rows = await searchCustomers(term, clientSearchScope(ctx, full), 8);
    const ratings = await ratingSummaries(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      phone: contact ? r.phone : null,
      phoneHint: contact ? null : maskPhone(r.phone),
      email: contact ? r.email : null,
      notes: r.notes,
      rating: ratings.get(r.id) ?? null,
    }));
  });
}

export async function createStaffAppointmentAction(input: {
  shopId: string;
  staffId: string;
  date: string;
  startMin: number;
  serviceId: string;
  addonIds: string[];
  customerId?: string | null;
  customer?: { firstName: string; lastName?: string; phone?: string; email?: string } | null;
  notes?: string;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only book into your own column");
    if (!input.customerId && !input.customer?.firstName) throw new AppError("bad_request", "Pick a client or enter a name");
    const startsAt = staffWallTime(input.date, input.startMin);
    const appt = await createAppointment({
      shopRef: input.shopId,
      serviceId: input.serviceId,
      addonIds: input.addonIds,
      barberRef: input.staffId,
      startsAt,
      customerId: input.customerId ?? null,
      customer: input.customerId ? null : (input.customer ?? null),
      allowNoContact: true,
      notes: input.notes || null,
      source: "staff",
      actor: ctx.actor,
    });
    revalidatePath("/admin/calendar");
    return { code: appt.code };
  });
}

export async function moveAppointmentAction(id: string, staffId: string, date: string, startMin: number) {
  return safe(async () => {
    const ctx = await requireStaff();
    const a = await loadAppt(ctx, id);
    if (ownColumnOnly(ctx) && staffId !== ctx.staff.id) throw forbidden("You can only move your own appointments within your own column");
    await rescheduleAppointment(a.code, { startsAt: staffWallTime(date, startMin), barberRef: staffId, actor: ctx.actor, byCustomer: false });
    revalidatePath("/admin/calendar");
    return null;
  });
}

export async function createBlockAction(input: { shopId: string; staffId: string; date: string; startMin: number; endMin: number; reason: string; allShops: boolean }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only block time in your own column");
    if (!input.reason.trim()) throw new AppError("bad_request", "Add a reason for the block");
    if (input.endMin <= input.startMin) throw new AppError("bad_request", "End must be after start");
    const shopId = input.allShops ? null : input.shopId;
    const denied = timeBlockChangeDenied(caller(ctx), { staffId: input.staffId, shopId }, await barberShops(input.staffId));
    if (denied) throw forbidden(denied);
    if (input.allShops && !(await barberShops(input.staffId)).includes(input.shopId)) throw forbidden("That barber doesn't work at this shop");
    const [b] = await db
      .insert(timeBlocks)
      .values({
        staffId: input.staffId,
        shopId,
        startsAt: staffWallTime(input.date, input.startMin),
        endsAt: staffWallTime(input.date, input.endMin),
        reason: input.reason.trim(),
        kind: "block",
        createdBy: ctx.staff.id,
      })
      .returning();
    await audit(ctx.actor, "block.create", "time_block", b.id, { staffId: input.staffId, reason: b.reason }, input.shopId);
    revalidatePath("/admin/calendar");
    return null;
  });
}

export async function deleteBlockAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!b || (b.shopId && !hasShop(ctx, b.shopId))) throw notFound("Block");
    if (ownColumnOnly(ctx) && b.staffId !== ctx.staff.id) throw forbidden("You can only remove blocks in your own column");
    const denied = timeBlockChangeDenied(caller(ctx), b, await barberShops(b.staffId));
    if (denied) throw forbidden(denied);
    await db.delete(timeBlocks).where(eq(timeBlocks.id, id));
    await audit(ctx.actor, "block.delete", "time_block", id, { reason: b.reason }, b.shopId);
    revalidatePath("/admin/calendar");
    return null;
  });
}
