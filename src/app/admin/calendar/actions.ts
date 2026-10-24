"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { appointments, staffShops, timeBlocks } from "@/db/schema";
import { safe } from "@/server/action";
import { selfBlockProblem } from "@/domain/staff-time";
import { blockChangeDenied, clockBlockChangeDenied } from "@/server/auth/policy";
import { overrideClockBlock, releaseClockBlock, resetClockBlock } from "@/server/clock-blocks";
import { StaffContext, assertShopAccess, authorize, blockCaller, can, requireStaff } from "@/server/auth/staff";
import { addBlock, removeBlock, rulesFor } from "@/server/staff-time";
import { createAppointment, getAvailability, rescheduleAppointment, setAppointmentStatus, staffWallTime } from "@/server/booking";
import { openSaleForAppointment } from "@/server/checkout";
import { clockPulse } from "@/server/clock-live";
import { sendToCheckout } from "@/server/combined-checkout";
import { assertCanEnter, clientPolicy } from "@/server/client-privacy";
import { searchClients } from "@/server/client-search";
import { usableReason } from "@/server/block-reasons";
import { AppError, forbidden, notFound } from "@/server/errors";
import { correctServiceTimes, finishService, reviewServiceTime } from "@/server/service-times";
import { hasShop, requireInTenant } from "@/server/tenant";
import { isValidLocalDate, localDateOf, localMinutesOf, zonedWallTime } from "@/lib/time";

async function barberShops(staffId: string) {
  return (await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
}

/** Without "manage the calendar", people work only in their own column. */
const ownColumnOnly = (ctx: StaffContext) => !can(ctx, "calendar.manage");

function assertSqueeze(ctx: StaffContext, squeezeIn: boolean | undefined) {
  if (squeezeIn && !can(ctx, "calendar.squeeze_in")) throw forbidden("You can't squeeze in bookings off the grid. Pick one of the open times.");
}

/**
 * Open starts on this barber's grid for this service and these add-ons, as the front desk books
 * them (no lead time or booking window), with how long it takes them.
 */
export async function staffOpeningsAction(input: { shopId: string; staffId: string; date: string; serviceId: string; addonIds: string[] }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only book into your own column");
    if (!isValidLocalDate(input.date)) throw new AppError("bad_request", "Pick a date");
    const a = await getAvailability({ shopRef: input.shopId, date: input.date, serviceId: input.serviceId, addonIds: input.addonIds, barberRef: input.staffId, staffOverride: true });
    return {
      durationMin: a.durationMin,
      starts: a.slots.map((s) => localMinutesOf(s.startsAt)),
      reason: a.reason,
      canSqueeze: can(ctx, "calendar.squeeze_in"),
    };
  });
}

/** A fingerprint of the day's punches and appointments here; the calendar polls it and refreshes when it changes. */
export async function calendarPulseAction(input: { shopId: string; date: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (!isValidLocalDate(input.date)) throw new AppError("bad_request", "Pick a date");
    return clockPulse(input.shopId, input.date);
  });
}

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

/** Finish tapped: the end of the service. Start is "In chair" (`setStatusAction(id, "in_service")`). */
export async function finishServiceAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadAppt(ctx, id, "checkout.any");
    await finishService(id, ctx.actor);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    return null;
  });
}

const wallTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times are HH:MM")
  .nullable()
  .optional();
const CorrectionInput = z.object({ arrivedAt: wallTime, startedAt: wallTime, finishedAt: wallTime, reason: z.string() });

/**
 * A manager fixes the recorded times, with a reason. Times are the shop's wall clock (HH:MM) on the
 * appointment's day, so the browser's time zone doesn't matter. Undefined leaves a time alone; null clears it.
 */
export async function correctServiceTimesAction(id: string, input: z.input<typeof CorrectionInput>) {
  return safe(async () => {
    const ctx = await authorize("service_times.correct");
    await requireInTenant(ctx, "appointment", id);
    const v = CorrectionInput.parse(input);
    const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
    if (!a) throw notFound("Appointment");
    const day = localDateOf(a.startsAt);
    const when = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : zonedWallTime(day, Number(s.slice(0, 2)) * 60 + Number(s.slice(3))).toJSDate());
    await correctServiceTimes(id, { arrivedAt: when(v.arrivedAt), startedAt: when(v.startedAt), finishedAt: when(v.finishedAt) }, v.reason, ctx.actor);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin/reports/service-times");
    return null;
  });
}

/** Count a flagged time anyway, leave a time out, or go back to the flags. */
export async function reviewServiceTimeAction(id: string, review: "include" | "exclude" | null, note: string | null) {
  return safe(async () => {
    const ctx = await authorize("service_times.correct");
    await requireInTenant(ctx, "appointment", id);
    if (review !== null && review !== "include" && review !== "exclude") throw new AppError("bad_request", "Pick count or leave out");
    await reviewServiceTime(id, review, note, ctx.actor);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin/reports/service-times");
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
 * The barber's "Send to checkout": the service is done, the visit goes onto its group's ticket (or its
 * own) and waits in the checkout queue, and the barber goes back to the next client.
 */
export async function sendToCheckoutAction(appointmentId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await loadAppt(ctx, appointmentId, "checkout.any");
    const r = await sendToCheckout(appointmentId, ctx.actor);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    revalidatePath("/admin/sales");
    return r;
  });
}

/**
 * The client search for booking, the POS and walk-ins: see searchClients. Everyone searches the
 * brand's one client book, so a client from any shop can be booked anywhere; what each hit shows
 * is the searcher's client policy.
 */
export async function searchCustomersAction(q: string, via: "booking" | "pos" | "walk_in" = "booking") {
  return safe(async () => {
    const ctx = await requireStaff();
    return searchClients(ctx, q, { via: ["booking", "pos", "walk_in"].includes(via) ? via : "booking" });
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
  /** Off the barber's grid, into buffer time or outside hours. Needs "calendar.squeeze_in"; logged. */
  squeezeIn?: boolean;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    assertSqueeze(ctx, input.squeezeIn);
    if (ownColumnOnly(ctx) && input.staffId !== ctx.staff.id) throw forbidden("You can only book into your own column");
    if (!input.customerId && !input.customer?.firstName) throw new AppError("bad_request", "Pick a client or enter a name");
    if (!input.customerId && input.customer) assertCanEnter(await clientPolicy(ctx), input.customer);
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
      squeezeIn: input.squeezeIn,
      actor: ctx.actor,
    });
    revalidatePath("/admin/calendar");
    return { code: appt.code };
  });
}

/** Moves land on the target barber's grid; with "calendar.squeeze_in" they can be squeezed in instead. */
export async function moveAppointmentAction(id: string, staffId: string, date: string, startMin: number, opts: { squeezeIn?: boolean } = {}) {
  return safe(async () => {
    const ctx = await requireStaff();
    const a = await loadAppt(ctx, id);
    if (ownColumnOnly(ctx) && staffId !== ctx.staff.id) throw forbidden("You can only move your own appointments within your own column");
    assertSqueeze(ctx, opts.squeezeIn);
    await rescheduleAppointment(a.code, { startsAt: staffWallTime(date, startMin), barberRef: staffId, actor: ctx.actor, byCustomer: false, squeezeIn: opts.squeezeIn });
    revalidatePath("/admin/calendar");
    return null;
  });
}

/**
 * Your own time needs "Block out their own time" and stays within the shop's limits; anyone else's
 * needs "Block out time for anyone". With booked appointments in it, nothing is saved until the
 * caller confirms, and the appointments stay booked.
 */
export async function createBlockAction(input: {
  shopId: string;
  staffId: string;
  date: string;
  startMin: number;
  endMin: number;
  reasonId: string;
  note?: string | null;
  allShops: boolean;
  confirm?: boolean;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    if (input.endMin <= input.startMin) throw new AppError("bad_request", "End must be after start");
    const shopId = input.allShops ? null : input.shopId;
    const shopsOfBarber = await barberShops(input.staffId);
    const denied = blockChangeDenied(blockCaller(ctx), { staffId: input.staffId, shopId }, shopsOfBarber);
    if (denied) throw forbidden(denied);
    if (input.allShops && !shopsOfBarber.includes(input.shopId)) throw forbidden("That barber doesn't work at this shop");
    const reason = await usableReason(input.reasonId, "blocks");
    if (input.staffId === ctx.staff.id && !can(ctx, "blocks.others")) {
      const problem = selfBlockProblem(await rulesFor(input.staffId, shopId), reason.countsAsLunch, input.endMin - input.startMin);
      if (problem) throw new AppError("bad_request", problem);
    }
    const r = await addBlock(
      { staffId: input.staffId, shopId, startsAt: staffWallTime(input.date, input.startMin), endsAt: staffWallTime(input.date, input.endMin), reasonId: reason.id, note: input.note },
      { actor: ctx.actor, confirm: input.confirm, via: "calendar", auditShopId: input.shopId },
    );
    if (r.done) {
      revalidatePath("/admin/calendar");
      revalidatePath("/admin/my-time");
    }
    return { saved: r.done, conflicts: r.conflicts };
  });
}

export async function deleteBlockAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!b || (b.shopId && !hasShop(ctx, b.shopId))) throw notFound("Block");
    if (b.source === "clock") {
      const denied = clockBlockChangeDenied(blockCaller(ctx), b, await barberShops(b.staffId));
      if (denied) throw forbidden(denied);
      await releaseClockBlock(id, ctx.actor, null);
    } else {
      const denied = blockChangeDenied(blockCaller(ctx), b, await barberShops(b.staffId));
      if (denied) throw forbidden(denied);
      await removeBlock(id, ctx.actor, "calendar", b.shopId);
    }
    revalidateBlocks();
    return null;
  });
}

function revalidateBlocks() {
  revalidatePath("/admin/calendar");
  revalidatePath("/admin/my-time");
  revalidatePath("/admin");
}

/** A block the time clock wrote, which this manager may change: else not found or forbidden. */
async function clockBlockFor(ctx: StaffContext, id: string) {
  const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
  if (!b || b.source !== "clock" || !b.shopId || !hasShop(ctx, b.shopId)) throw notFound("Block");
  const denied = clockBlockChangeDenied(blockCaller(ctx), b, await barberShops(b.staffId));
  if (denied) throw forbidden(denied);
  return b;
}

const Override = z.object({ date: z.string().refine(isValidLocalDate), startMin: z.number().int().min(0).max(1440), endMin: z.number().int().min(0).max(1440), note: z.string().max(300).nullish() });

/** A manager sets a clock block's times by hand: punch edits stop moving it until it's reset. Audit-logged. */
export async function overrideClockBlockAction(id: string, input: z.input<typeof Override>) {
  return safe(async () => {
    const ctx = await requireStaff();
    const v = Override.parse(input);
    if (v.endMin <= v.startMin) throw new AppError("bad_request", "End must be after start");
    await clockBlockFor(ctx, id);
    await overrideClockBlock(id, { startsAt: staffWallTime(v.date, v.startMin), endsAt: staffWallTime(v.date, v.endMin) }, ctx.actor, v.note);
    revalidateBlocks();
    return null;
  });
}

/** A manager takes a clock block off: the time reopens and the clock won't write it again. Audit-logged. */
export async function releaseClockBlockAction(id: string, note?: string | null) {
  return safe(async () => {
    const ctx = await requireStaff();
    await clockBlockFor(ctx, id);
    await releaseClockBlock(id, ctx.actor, typeof note === "string" ? note.slice(0, 300) : null);
    revalidateBlocks();
    return null;
  });
}

/** Undo a manager's times: the block follows the punches again. Audit-logged. */
export async function resetClockBlockAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await clockBlockFor(ctx, id);
    await resetClockBlock(id, ctx.actor);
    revalidateBlocks();
    return null;
  });
}
