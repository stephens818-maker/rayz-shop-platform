"use server";

import { and, desc, eq, ilike, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { appointments, customers, timeBlocks } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";
import { zonedWallTime } from "@/lib/time";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, canManage, requireStaff } from "@/server/auth/staff";
import { createAppointment, rescheduleAppointment, setAppointmentStatus } from "@/server/booking";
import { openSaleForAppointment } from "@/server/checkout";
import { AppError, forbidden, notFound } from "@/server/errors";

async function loadAppt(ctx: StaffContext, id: string) {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound("Appointment");
  assertShopAccess(ctx, a.shopId);
  if (ctx.isBarber && a.staffId !== ctx.staff.id) throw forbidden("You can only change your own appointments");
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
    await loadAppt(ctx, appointmentId);
    const sale = await openSaleForAppointment(appointmentId, ctx.actor);
    return { saleId: sale.id, status: sale.status };
  });
}

export async function searchCustomersAction(q: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    if (!canManage(ctx) && !ctx.isBarber) throw forbidden();
    const term = q.trim();
    if (term.length < 2) return [];
    const phone = normalizePhone(term);
    const digits = term.replace(/\D/g, "");
    const [first, ...rest] = term.split(/\s+/);
    const rows = await db
      .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, phone: customers.phone, email: customers.email })
      .from(customers)
      .where(
        phone
          ? eq(customers.phone, phone)
          : digits.length >= 4
            ? ilike(customers.phone, `%${digits}%`)
            : rest.length
              ? and(ilike(customers.firstName, `${first}%`), ilike(customers.lastName, `${rest.join(" ")}%`))
              : or(ilike(customers.firstName, `${term}%`), ilike(customers.lastName, `${term}%`), ilike(customers.email, `${term}%`)),
      )
      .orderBy(desc(customers.createdAt))
      .limit(8);
    return rows;
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
    if (ctx.isBarber && input.staffId !== ctx.staff.id) throw forbidden("Barbers can only book into their own column");
    if (!input.customerId && !input.customer?.firstName) throw new AppError("bad_request", "Pick a client or enter a name");
    const startsAt = zonedWallTime(input.date, input.startMin).toJSDate();
    const appt = await createAppointment({
      shopRef: input.shopId,
      serviceId: input.serviceId,
      addonIds: input.addonIds,
      barberRef: input.staffId,
      startsAt,
      customerId: input.customerId ?? null,
      customer: input.customerId ? null : input.customer && (input.customer.phone || input.customer.email) ? input.customer : null,
      notes: input.customerId || input.customer?.phone || input.customer?.email ? input.notes || null : `Walk-in: ${input.customer?.firstName} ${input.customer?.lastName ?? ""}`.trim(),
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
    await rescheduleAppointment(a.code, { startsAt: zonedWallTime(date, startMin).toJSDate(), barberRef: staffId, actor: ctx.actor, byCustomer: false });
    revalidatePath("/admin/calendar");
    return null;
  });
}

export async function createBlockAction(input: { shopId: string; staffId: string; date: string; startMin: number; endMin: number; reason: string; allShops: boolean }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (ctx.isBarber && input.staffId !== ctx.staff.id) throw forbidden();
    if (!input.reason.trim()) throw new AppError("bad_request", "Add a reason for the block");
    if (input.endMin <= input.startMin) throw new AppError("bad_request", "End must be after start");
    const [b] = await db
      .insert(timeBlocks)
      .values({
        staffId: input.staffId,
        shopId: input.allShops ? null : input.shopId,
        startsAt: zonedWallTime(input.date, input.startMin).toJSDate(),
        endsAt: zonedWallTime(input.date, input.endMin).toJSDate(),
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
    if (!b) throw notFound("Block");
    if (b.shopId) assertShopAccess(ctx, b.shopId);
    if (ctx.isBarber && b.staffId !== ctx.staff.id) throw forbidden();
    await db.delete(timeBlocks).where(eq(timeBlocks.id, id));
    await audit(ctx.actor, "block.delete", "time_block", id, { reason: b.reason }, b.shopId);
    revalidatePath("/admin/calendar");
    return null;
  });
}
