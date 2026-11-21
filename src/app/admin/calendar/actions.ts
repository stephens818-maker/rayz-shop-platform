"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { appointments, timeBlocks } from "@/db/schema";
import { safe } from "@/server/action";
import { clockBlockChangeDenied } from "@/server/auth/policy";
import { overrideClockBlock, releaseClockBlock, resetClockBlock } from "@/server/clock-blocks";
import { StaffContext, authorize, blockCaller, can, requireStaff } from "@/server/auth/staff";
import { staffWallTime } from "@/server/booking";
import {
  StaffBlockInput,
  StaffBookingInput,
  barberShops,
  blockForStaff,
  bookForStaff,
  changeStatus,
  changeableAppt,
  finishFor,
  moveForStaff,
  staffOpenings,
  unblockForStaff,
} from "@/server/calendar-ops";
import { openSaleForAppointment } from "@/server/checkout";
import { clockPulse } from "@/server/clock-live";
import { sendToCheckout } from "@/server/combined-checkout";
import { searchClients } from "@/server/client-search";
import { AppError, forbidden, notFound } from "@/server/errors";
import { correctServiceTimes, reviewServiceTime } from "@/server/service-times";
import { panelThread, replyToCustomer } from "@/server/messaging";
import { messageHistory } from "@/server/notification-history";
import { assertShop as assertShopAccess, hasShop, requireInTenant } from "@/server/tenant";
import { isValidLocalDate, localDateOf, zonedWallTime } from "@/lib/time";
import { withDesk, type DeskPin } from "@/server/desk-pin";
import { clockState, punchForStaff } from "@/server/time-clock";
import { loadStaffAccess } from "@/server/auth/access";

/**
 * Open starts on this barber's grid for this service and these add-ons, as the front desk books
 * them (no lead time or booking window), with how long it takes them.
 */
export async function staffOpeningsAction(input: { shopId: string; staffId: string; date: string; serviceId: string; addonIds: string[] }) {
  return safe(async () => staffOpenings(await requireStaff(), input));
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

const loadAppt = changeableAppt;

const canText = (ctx: StaffContext) => can(ctx, "clients.message") || can(ctx, "inbox.view");

/** The inbox thread with this client, plus the appointment's outbound notices. The phone stays on the server. */
export async function appointmentMessagesAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const a = await loadAppt(ctx, id);
    const [history, thread] = await Promise.all([
      messageHistory(ctx, { appointmentId: id }, 20),
      a.customerId ? panelThread(a.shopId, a.customerId) : Promise.resolve({ threadId: null, unread: 0, messages: [], replyBlock: "No client on this appointment." }),
    ]);
    return { history, thread, canText: canText(ctx) };
  });
}

/** A reply from the calendar panel. Same rules as the inbox: opt-in, STOP, and the reply window. */
export async function appointmentReplyAction(id: string, body: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    if (!canText(ctx)) throw forbidden("You can't text clients");
    const a = await loadAppt(ctx, id);
    if (!a.customerId) throw new AppError("bad_request", "No client on this appointment");
    const r = await replyToCustomer(a.shopId, a.customerId, body, { staffId: ctx.staff.id, actor: ctx.actor });
    revalidatePath("/admin/calendar");
    revalidatePath("/admin/inbox");
    return r;
  });
}

type Status = "confirmed" | "checked_in" | "in_service" | "completed" | "cancelled" | "no_show" | "booked";

export async function setStatusAction(id: string, status: Status, pin?: DeskPin) {
  return safe(async () => {
    await changeStatus(await withDesk(await requireStaff(), pin), id, status);
    revalidatePath("/admin/calendar");
    revalidatePath("/admin");
    return null;
  });
}

/** Finish tapped: the end of the service. Start is "In chair" (`setStatusAction(id, "in_service")`). */
export async function finishServiceAction(id: string, pin?: DeskPin) {
  return safe(async () => {
    await finishFor(await withDesk(await requireStaff(), pin), id);
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

export async function startCheckoutAction(appointmentId: string, pin?: DeskPin) {
  return safe(async () => {
    const ctx = await withDesk(await requireStaff(), pin);
    await loadAppt(ctx, appointmentId, "checkout.any");
    const sale = await openSaleForAppointment(appointmentId, ctx.actor);
    return { saleId: sale.id, status: sale.status };
  });
}

/**
 * The barber's "Send to checkout": the service is done, the visit goes onto its group's ticket (or its
 * own) and waits in the checkout queue, and the barber goes back to the next client.
 */
export async function sendToCheckoutAction(appointmentId: string, pin?: DeskPin) {
  return safe(async () => {
    const ctx = await withDesk(await requireStaff(), pin);
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

export async function createStaffAppointmentAction(input: StaffBookingInput, pin?: DeskPin) {
  return safe(async () => {
    const appt = await bookForStaff(await withDesk(await requireStaff(), pin), input);
    revalidatePath("/admin/calendar");
    return { code: appt.code };
  });
}

/** Drag the bottom edge. Booked and confirmed only; the start stays put. */
export async function resizeAppointmentAction(id: string, date: string, endMin: number) {
  return safe(async () => {
    const { resizeForStaff } = await import("@/server/calendar-ops");
    await resizeForStaff(await requireStaff(), id, date, endMin);
    revalidatePath("/admin/calendar");
    return null;
  });
}

/** Moves land on the target barber's grid; with "calendar.squeeze_in" they can be squeezed in instead. */
export async function moveAppointmentAction(id: string, staffId: string, date: string, startMin: number, opts: { squeezeIn?: boolean; desk?: DeskPin } = {}) {
  return safe(async () => {
    await moveForStaff(await withDesk(await requireStaff(), opts.desk), id, staffId, date, startMin, { squeezeIn: opts.squeezeIn });
    revalidatePath("/admin/calendar");
    return null;
  });
}

/**
 * Your own time needs "Block out their own time" and stays within the shop's limits; anyone else's
 * needs "Block out time for anyone". With booked appointments in it, nothing is saved until the
 * caller confirms, and the appointments stay booked.
 */
export async function createBlockAction(input: StaffBlockInput) {
  return safe(async () => {
    const r = await blockForStaff(await requireStaff(), input);
    if (r.done) {
      revalidatePath("/admin/calendar");
      revalidatePath("/admin/my-time");
    }
    return { saved: r.done, conflicts: r.conflicts };
  });
}

export async function deleteBlockAction(id: string) {
  return safe(async () => {
    await unblockForStaff(await requireStaff(), id);
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

const Punch = z.enum(["in", "out", "break_start", "break_end"]);

/** Where this person stands right now, for the clock on their calendar column. */
export async function columnClockAction(input: { staffId: string; shopId: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    const s = await clockState(z.uuid().parse(input.staffId));
    return { state: s.state, next: s.next, since: s.shift?.start.toISOString() ?? null, shop: s.shift?.shop ?? null };
  });
}

/** Clock in, out to lunch, back from lunch, or clock out. A manager can punch for someone else. */
export async function columnPunchAction(input: { staffId: string; shopId: string; type: z.infer<typeof Punch>; desk?: DeskPin }) {
  return safe(async () => {
    const ctx = await requireStaff();
    assertShopAccess(ctx, input.shopId);
    const type = Punch.parse(input.type);
    const desk = await withDesk(ctx, input.desk);
    const byId = desk.actor.staffId;
    if (!byId) throw forbidden("Enter your PIN.");
    const access = ctx.staff.kind === "shop" ? await loadStaffAccess(byId) : null;
    const others = access ? access.isOwner || access.permissions.has("timeclock.edit_others") || access.permissions.has("timesheet.edit") : ctx.isOwner || can(ctx, "timeclock.edit_others") || can(ctx, "timesheet.edit");
    const self = input.staffId === byId;
    if (!self && !others) throw forbidden("You can clock yourself in from here. A manager clocks someone else in.");
    if (self && !others) {
      const canSelf = access ? access.permissions.has("timeclock.punch") || access.isOwner : can(ctx, "timeclock.punch");
      if (!canSelf) throw forbidden("You can't punch from the calendar.");
    }
    const r = await punchForStaff({ actor: desk.actor, byStaffId: byId, staffId: z.uuid().parse(input.staffId), shopId: input.shopId, type });
    if (r.kind !== "done" || !r.clock) throw new AppError("bad_request", "That punch needs a confirmation. Use the front-desk clock.");
    revalidatePath("/admin/timesheets");
    return { type: r.type, at: r.at.toISOString(), state: r.clock.state, next: r.clock.next, since: r.clock.since };
  });
}
