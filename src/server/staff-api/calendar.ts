import "server-only";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { LocalDate, formatTime, isValidLocalDate, todayLocal } from "@/lib/time";
import { audit } from "@/server/audit";
import { can, canAny, reasonViewer } from "@/server/auth/staff";
import { StaffBlockInput, StaffBookingInput, blockForStaff, bookForStaff, changeStatus, changeableAppt, finishFor, moveForStaff, staffOpenings, unblockForStaff } from "@/server/calendar-ops";
import { loadDayCalendar } from "@/server/calendar";
import { noteViewer } from "@/server/client-notes";
import { clientPolicy } from "@/server/client-privacy";
import { AppError } from "@/server/errors";
import { queueStaffAlert } from "@/server/staff-alerts";
import { StaffAppContext, shopOf } from "./http";
import { myAppointment } from "./schedule";

/**
 * The day calendar on the phone (ST-C3): their own column, or every column with "see every barber's
 * calendar" or "manage the calendar", and the same changes the web calendar makes, through the same
 * server code (calendar-ops), so every rule and audit entry is the web's.
 */

export const seesEveryColumn = (ctx: StaffAppContext) => canAny(ctx, ["calendar.view_all", "calendar.manage"]);

/** GET /me/calendar. Client phones never come back, masked or not: calls and texts go through POST /clients/{id}/contact. */
export async function myCalendar(ctx: StaffAppContext, q: { date?: string; shopId?: string; all?: boolean }) {
  const date: LocalDate = q.date ?? todayLocal();
  if (!isValidLocalDate(date)) throw new AppError("bad_request", "date is a day like 2026-10-27", { field: "date" });
  const shopId = shopOf(ctx, q.shopId);
  const everyone = seesEveryColumn(ctx) && q.all !== false;
  const policy = await clientPolicy(ctx);
  const data = await loadDayCalendar(shopId, date, everyone ? null : ctx.staff.id, ctx, policy, reasonViewer(ctx), noteViewer(ctx, policy));
  return {
    date: data.date,
    shop: { id: data.shop.id, name: data.shop.name },
    closed: data.closed,
    openMin: data.openMin,
    closeMin: data.closeMin,
    allColumns: everyone,
    canManage: can(ctx, "calendar.manage"),
    canSqueezeIn: can(ctx, "calendar.squeeze_in"),
    columns: data.columns.map((c) => ({
      staffId: c.id,
      label: c.label,
      color: c.color,
      mine: c.id === ctx.staff.id,
      spans: c.spans,
      intervalMin: c.intervalMin,
      blocks: c.blocks.map((b) => ({ id: b.id, startMin: b.startMin, endMin: b.endMin, kind: b.kind, category: b.category, label: b.label, color: b.color, note: b.note, private: b.hidden, recurring: b.recurring, fromRequest: b.fromRequest, clock: b.clock ? { kind: b.clock.kind, open: b.clock.open } : null })),
      appts: c.appts.map(({ phone: _phone, ...a }) => a),
      clock: c.clock,
    })),
    off: data.off,
  };
}

export const STATUS_ACTIONS = ["confirm", "check_in", "start", "finish", "complete", "no_show", "cancel", "undo"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];
const STATUS_OF = { confirm: "confirmed", check_in: "checked_in", start: "in_service", complete: "completed", no_show: "no_show", cancel: "cancelled", undo: "booked" } as const;

/** POST /appointments/{id}/status: their own appointment, or anyone's with "manage the calendar". Audited as on the web. */
export async function setStatus(ctx: StaffAppContext, id: string, action: StatusAction) {
  if (action === "finish") await finishFor(ctx, id);
  else await changeStatus(ctx, id, STATUS_OF[action]);
  return myAppointment(ctx, id);
}

/** POST /appointments: on the grid unless they may squeeze in; their own column unless they manage the calendar. */
export async function book(ctx: StaffAppContext, input: StaffBookingInput) {
  const appt = await bookForStaff(ctx, { ...input, shopId: shopOf(ctx, input.shopId) }, "staff_app");
  return myAppointment(ctx, appt.id);
}

/** POST /appointments/{id}/move */
export async function move(ctx: StaffAppContext, id: string, v: { staffId?: string | null; date: string; startMin: number; squeezeIn?: boolean }) {
  const a = await changeableAppt(ctx, id);
  await moveForStaff(ctx, id, v.staffId ?? a.staffId, v.date, v.startMin, { squeezeIn: v.squeezeIn });
  return myAppointment(ctx, id);
}

/** GET /openings: open starts on a barber's grid for a service, as the front desk books them. */
export async function openings(ctx: StaffAppContext, q: { shopId?: string; staffId?: string; date: string; serviceId: string; addonIds?: string[] }) {
  return staffOpenings(ctx, { shopId: shopOf(ctx, q.shopId), staffId: q.staffId ?? ctx.staff.id, date: q.date, serviceId: q.serviceId, addonIds: q.addonIds ?? [] });
}

/** POST /blocks: { done: false, conflicts } until confirmed when clients are booked in it; they stay booked. */
export async function block(ctx: StaffAppContext, input: Omit<StaffBlockInput, "staffId" | "shopId"> & { staffId?: string | null; shopId?: string | null }) {
  const r = await blockForStaff(ctx, { ...input, shopId: shopOf(ctx, input.shopId), staffId: input.staffId ?? ctx.staff.id }, "staff_app");
  return { saved: r.done, blockId: r.done ? r.blockId : null, conflicts: r.conflicts };
}

export async function unblock(ctx: StaffAppContext, id: string) {
  await unblockForStaff(ctx, id);
}

/**
 * POST /appointments/{id}/late: the client called or texted the desk that they're running late. The
 * barber gets an app alert (first name only); audited. Nothing is sent to the client.
 */
export async function runningLate(ctx: StaffAppContext, id: string, minutes: number) {
  const a = await changeableAppt(ctx, id);
  if (!["booked", "confirmed"].includes(a.status)) throw new AppError("conflict", "Only an appointment that hasn't started can run late");
  await audit(ctx.actor, "appointment.running_late", "appointment", id, { minutes, via: "staff_app" }, a.shopId);
  const queued = await queueStaffAlert("late", id, { actorStaffId: ctx.staff.id, detail: `about ${minutes} min late` });
  const fresh = await db.query.appointments.findFirst({ where: eq(appointments.id, id), columns: { startsAt: true } });
  return { told: queued > 0, startsAt: fresh?.startsAt.toISOString() ?? null, expectedAt: fresh ? formatTime(new Date(fresh.startsAt.getTime() + minutes * 60_000)) : null };
}
