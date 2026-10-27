import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, staffShops, timeBlocks } from "@/db/schema";
import { selfBlockProblem } from "@/domain/staff-time";
import { isValidLocalDate, localMinutesOf } from "@/lib/time";
import { blockChangeDenied, clockBlockChangeDenied } from "@/server/auth/policy";
import { StaffContext, assertShopAccess, blockCaller, can } from "@/server/auth/staff";
import { usableReason } from "@/server/block-reasons";
import { createAppointment, getAvailability, rescheduleAppointment, setAppointmentStatus, staffWallTime } from "@/server/booking";
import { checkEntry, fillEntry, type EntryDetails } from "@/server/client-entry";
import { clientPolicy } from "@/server/client-privacy";
import { releaseClockBlock } from "@/server/clock-blocks";
import { AppError, forbidden, notFound } from "@/server/errors";
import { finishService } from "@/server/service-times";
import { addBlock, removeBlock, rulesFor } from "@/server/staff-time";
import { hasShop, requireInTenant } from "@/server/tenant";

/**
 * The calendar's changes for a staff member already signed in, with every rule the calendar holds
 * them to: the web calendar's server actions and the staff app (/api/staff/v1) both call these, so a
 * barber can't do from the phone what they couldn't do at the desk.
 */

export async function barberShops(staffId: string) {
  return (await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
}

/** Without "manage the calendar", people work only in their own column. */
export const ownColumnOnly = (ctx: StaffContext) => !can(ctx, "calendar.manage");

export function assertSqueeze(ctx: StaffContext, squeezeIn: boolean | undefined) {
  if (squeezeIn && !can(ctx, "calendar.squeeze_in")) throw forbidden("You can't squeeze in bookings off the grid. Pick one of the open times.");
}

/** An appointment at their shops they may change: their own, or anyone's with `othersNeed`. */
export async function changeableAppt(ctx: StaffContext, id: string, othersNeed: "calendar.manage" | "checkout.any" = "calendar.manage") {
  await requireInTenant(ctx, "appointment", id);
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound("Appointment");
  if (a.staffId !== ctx.staff.id && !can(ctx, othersNeed)) throw forbidden("You can only change your own appointments");
  return a;
}

export async function staffOpenings(ctx: StaffContext, input: { shopId: string; staffId: string; date: string; serviceId: string; addonIds: string[] }) {
  assertShopAccess(ctx, input.shopId);
  if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only book into your own column");
  if (!isValidLocalDate(input.date)) throw new AppError("bad_request", "Pick a date");
  const a = await getAvailability({ shopRef: input.shopId, date: input.date, serviceId: input.serviceId, addonIds: input.addonIds, barberRef: input.staffId, staffOverride: true });
  return { durationMin: a.durationMin, starts: a.slots.map((s) => localMinutesOf(s.startsAt)), reason: a.reason, canSqueeze: can(ctx, "calendar.squeeze_in") };
}

export type StaffStatus = "confirmed" | "checked_in" | "in_service" | "completed" | "cancelled" | "no_show" | "booked";

/** A status change on one appointment they may change; setAppointmentStatus audits it. */
export async function changeStatus(ctx: StaffContext, id: string, status: StaffStatus) {
  await changeableAppt(ctx, id);
  await setAppointmentStatus(id, status, ctx.actor);
}

/** Finish: the end of the service. Their own, or anyone's with checkout for anyone. */
export async function finishFor(ctx: StaffContext, id: string) {
  await changeableAppt(ctx, id, "checkout.any");
  await finishService(id, ctx.actor);
}

export interface StaffBookingInput {
  shopId: string;
  staffId: string;
  date: string;
  startMin: number;
  serviceId: string;
  addonIds: string[];
  customerId?: string | null;
  customer?: { firstName: string; lastName?: string; phone?: string; email?: string } | null;
  /** A new client's details, each needing "add"; ones already on a matched client stay as they are. */
  details?: EntryDetails | null;
  notes?: string | null;
  /** Off the barber's grid, into buffer time or outside hours. Needs "calendar.squeeze_in"; logged. */
  squeezeIn?: boolean;
}

/** A booking made by staff: their own column unless they manage the calendar, on the grid unless they may squeeze in. */
export async function bookForStaff(ctx: StaffContext, input: StaffBookingInput, via: "calendar" | "staff_app" = "calendar") {
  assertShopAccess(ctx, input.shopId);
  assertSqueeze(ctx, input.squeezeIn);
  if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only book into your own column");
  if (!input.customerId && !input.customer?.firstName) throw new AppError("bad_request", "Pick a client or enter a name");
  const typed = !input.customerId && input.customer ? checkEntry(await clientPolicy(ctx), { ...input.details, phone: input.details?.phone ?? input.customer.phone, email: input.details?.email ?? input.customer.email }) : null;
  const appt = await createAppointment({
    shopRef: input.shopId,
    serviceId: input.serviceId,
    addonIds: input.addonIds,
    barberRef: input.staffId,
    startsAt: staffWallTime(input.date, input.startMin),
    customerId: input.customerId ?? null,
    customer: input.customerId || !input.customer ? null : { ...input.customer, phone: typed?.phone, email: typed?.email },
    allowNoContact: true,
    notes: input.notes || null,
    source: "staff",
    squeezeIn: input.squeezeIn,
    actor: via === "staff_app" ? { ...ctx.actor, label: `${ctx.actor.label} (staff app)` } : ctx.actor,
  });
  if (typed && appt.customer) await fillEntry(appt.customer.id, typed, { actor: ctx.actor, staffId: ctx.staff.id, shopId: input.shopId });
  return appt;
}

/** Moves land on the target barber's grid; with "calendar.squeeze_in" they can be squeezed in instead. */
export async function moveForStaff(ctx: StaffContext, id: string, staffId: string, date: string, startMin: number, opts: { squeezeIn?: boolean } = {}) {
  const a = await changeableAppt(ctx, id);
  if (ownColumnOnly(ctx) && staffId !== ctx.staff.id) throw forbidden("You can only move your own appointments within your own column");
  assertSqueeze(ctx, opts.squeezeIn);
  if (!isValidLocalDate(date)) throw new AppError("bad_request", "Pick a date");
  await rescheduleAppointment(a.code, { startsAt: staffWallTime(date, startMin), barberRef: staffId, actor: ctx.actor, byCustomer: false, squeezeIn: opts.squeezeIn });
}

export interface StaffBlockInput {
  shopId: string;
  staffId: string;
  date: string;
  startMin: number;
  endMin: number;
  reasonId: string;
  note?: string | null;
  allShops: boolean;
  confirm?: boolean;
}

/**
 * Your own time needs "Block out their own time" and stays within the shop's limits; anyone else's
 * needs "Block out time for anyone". With booked appointments in it, nothing is saved until the
 * caller confirms, and the appointments stay booked.
 */
export async function blockForStaff(ctx: StaffContext, input: StaffBlockInput, via: "calendar" | "staff_app" = "calendar") {
  assertShopAccess(ctx, input.shopId);
  if (!isValidLocalDate(input.date)) throw new AppError("bad_request", "Pick a date");
  if (input.endMin <= input.startMin) throw new AppError("bad_request", "End must be after start");
  const shopId = input.allShops ? null : input.shopId;
  const shopsOfBarber = await barberShops(input.staffId);
  const denied = blockChangeDenied(blockCaller(ctx), { staffId: input.staffId, shopId }, shopsOfBarber);
  if (denied) throw forbidden(denied);
  if (input.allShops && !shopsOfBarber.includes(input.shopId)) throw forbidden("That barber doesn't work at this shop");
  const reason = await usableReason(input.reasonId, "blocks", undefined, input.shopId);
  if (input.staffId === ctx.staff.id && !can(ctx, "blocks.others")) {
    const problem = selfBlockProblem(await rulesFor(input.staffId, shopId), reason.countsAsLunch, input.endMin - input.startMin);
    if (problem) throw new AppError("bad_request", problem);
  }
  return addBlock(
    { staffId: input.staffId, shopId, startsAt: staffWallTime(input.date, input.startMin), endsAt: staffWallTime(input.date, input.endMin), reasonId: reason.id, note: input.note },
    { actor: ctx.actor, confirm: input.confirm, via, auditShopId: input.shopId },
  );
}

/** Takes a block off: a clock block under the clock's rules, any other under the block rules. */
export async function unblockForStaff(ctx: StaffContext, id: string) {
  const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
  if (!b || (b.shopId && !hasShop(ctx, b.shopId))) throw notFound("Block");
  if (!b.shopId && !(await barberShops(b.staffId)).some((s) => hasShop(ctx, s))) throw notFound("Block");
  if (b.source === "clock") {
    const denied = clockBlockChangeDenied(blockCaller(ctx), b, await barberShops(b.staffId));
    if (denied) throw forbidden(denied);
    await releaseClockBlock(id, ctx.actor, null);
  } else {
    const denied = blockChangeDenied(blockCaller(ctx), b, await barberShops(b.staffId));
    if (denied) throw forbidden(denied);
    await removeBlock(id, ctx.actor, "calendar", b.shopId);
  }
}
