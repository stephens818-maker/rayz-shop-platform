import { and, asc, eq, gt, gte, isNull, lt } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointmentItems, appointments, customers, notificationJobs, shops, staff, staffDevices, staffSchedules, timeBlocks, timePunches } from "@/db/schema";
import {
  APPOINTMENT_EVENTS,
  QUIET_BREAK_MIN,
  QUIET_CHANNELS,
  QUIET_LOOKAHEAD_DAYS,
  STAFF_EVENT_LABEL,
  StaffEvent,
  channelsFor,
  cleanNotificationPrefs,
  isUrgent,
  quietUntil,
  staffAlertText,
  type WorkNow,
} from "@/domain/staff-notifications";
import { clockStatus } from "@/domain/time-clock";
import { formatDate, formatTime } from "@/lib/time";

const HOUR = 3600_000;
/** An open shift older than this is a forgotten clock-out, not someone at work (as in the time clock). */
const STALE_OPEN_MS = 24 * HOUR;

/** Whether the person is working, on a break (and until when) or off, from their punches. */
export async function workNow(staffId: string, now: Date, tx: DBorTx = db): Promise<WorkNow> {
  const rows = await tx
    .select({ id: timePunches.id, staffId: timePunches.staffId, shopId: timePunches.shopId, type: timePunches.type, at: timePunches.at, plannedMin: timePunches.plannedMin })
    .from(timePunches)
    .where(and(eq(timePunches.staffId, staffId), isNull(timePunches.voidedAt), gte(timePunches.at, new Date(now.getTime() - STALE_OPEN_MS)), lt(timePunches.at, new Date(now.getTime() + 60_000))))
    .orderBy(asc(timePunches.at));
  const { state, shift } = clockStatus(rows);
  if (state === "off" || !shift) return { state: "off" };
  if (state === "working") return { state: "working" };
  const br = shift.breaks.find((b) => b.end === null)!;
  const planned = rows.find((r) => r.id === br.startId)?.plannedMin ?? QUIET_BREAK_MIN;
  return { state: "on_break", until: new Date(br.start.getTime() + planned * 60_000) };
}

/** When this person's non-urgent text or app alert should go, or null for now. */
export async function quietHold(staffId: string, event: StaffEvent, now: Date, startsAt: Date | null = null, tx: DBorTx = db): Promise<Date | null> {
  if (isUrgent(event, now, startsAt)) return null;
  const work = await workNow(staffId, now, tx);
  if (work.state === "working") return null;
  const shifts = await tx.select({ weekday: staffSchedules.weekday, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin }).from(staffSchedules).where(eq(staffSchedules.staffId, staffId));
  const timeOff = await tx
    .select({ startsAt: timeBlocks.startsAt, endsAt: timeBlocks.endsAt })
    .from(timeBlocks)
    .where(and(eq(timeBlocks.staffId, staffId), eq(timeBlocks.category, "time_off"), gt(timeBlocks.endsAt, now), lt(timeBlocks.startsAt, new Date(now.getTime() + (QUIET_LOOKAHEAD_DAYS + 1) * 24 * HOUR))));
  return quietUntil(event, { now, work, shifts, timeOff, startsAt });
}

/** Sends this person's held texts and app alerts now: they clocked in or ended a break. Returns how many. */
export async function releaseHeldStaffNotices(staffId: string, at: Date, tx: DBorTx = db): Promise<number> {
  const rows = await tx
    .update(notificationJobs)
    .set({ runAt: at, heldForStaffId: null })
    .where(and(eq(notificationJobs.heldForStaffId, staffId), eq(notificationJobs.status, "pending"), gt(notificationJobs.runAt, at)))
    .returning({ id: notificationJobs.id });
  return rows.length;
}

const timing = (channel: string, staffId: string, now: Date, hold: Date | null) =>
  hold && (QUIET_CHANNELS as readonly string[]).includes(channel) ? { runAt: hold, heldForStaffId: staffId } : { runAt: now, heldForStaffId: null };

/**
 * Tells a barber about their own client's booking, change, cancellation or arrival on the channels
 * they picked. Never when they made the change themselves. App alerts go to each staff app phone
 * signed in as them (staff_devices); the push carries the appointment id. Off the clock, non-urgent
 * texts and app alerts wait for quiet hours to end. Returns how many were queued.
 */
export async function queueStaffAlert(
  event: (typeof APPOINTMENT_EVENTS)[number],
  appointmentId: string,
  opts: { actorStaffId?: string | null; now?: Date; detail?: string | null; staffId?: string } = {},
  tx: DBorTx = db,
): Promise<number> {
  const [row] = await tx
    .select({
      staffId: appointments.staffId,
      shopId: appointments.shopId,
      startsAt: appointments.startsAt,
      prefs: staff.notificationPrefs,
      phone: staff.phone,
      email: staff.email,
      active: staff.active,
      shopName: shops.name,
      firstName: customers.firstName,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(eq(appointments.id, appointmentId));
  if (!row || !row.active || (opts.actorStaffId && opts.actorStaffId === row.staffId)) return 0;
  const channels = channelsFor(cleanNotificationPrefs(row.prefs), event);
  if (!channels.length) return 0;
  const items = await tx.select({ name: appointmentItems.name }).from(appointmentItems).where(eq(appointmentItems.appointmentId, appointmentId)).orderBy(asc(appointmentItems.kind));
  const when = `${formatDate(row.startsAt, "EEE MMM d")} at ${formatTime(row.startsAt)}`;
  const body = staffAlertText(event, { firstName: row.firstName, when, shopName: row.shopName, services: items.map((i) => i.name), detail: opts.detail });
  const now = opts.now ?? new Date();
  const phones = channels.includes("push")
    ? await tx
        .select({ id: staffDevices.id })
        .from(staffDevices)
        .where(and(eq(staffDevices.staffId, row.staffId), isNull(staffDevices.revokedAt), eq(staffDevices.pushEnabled, true)))
    : [];
  const held = channels.some((c) => QUIET_CHANNELS.includes(c)) ? await quietHold(row.staffId, event, now, row.startsAt, tx) : null;
  const rows = [
    ...(channels.includes("sms") && row.phone ? [{ channel: "sms", to: row.phone, subject: null }] : []),
    ...(channels.includes("email") && row.email ? [{ channel: "email", to: row.email, subject: body.split(": ")[1]?.slice(0, 80) ?? "Your schedule" }] : []),
    ...phones.map((d) => ({ channel: "push", to: d.id, subject: STAFF_EVENT_LABEL[event] })),
  ].map((r) => ({ ...r, kind: `staff_${event}`, body, appointmentId, shopId: row.shopId, ...timing(r.channel, row.staffId, now, held) }));
  if (rows.length) await tx.insert(notificationJobs).values(rows);
  return rows.length;
}

/**
 * About their own time rather than a client's booking (a clock-out reminder, a schedule change or a
 * time off decision): to their staff app phones, and by text or email where they picked those.
 * No client details. Schedule changes wait for quiet hours to end. Returns how many were queued.
 */
export async function queueStaffNotice(
  event: Exclude<StaffEvent, (typeof APPOINTMENT_EVENTS)[number]>,
  staffId: string,
  msg: { body: string; shopId: string | null; now?: Date },
  tx: DBorTx = db,
): Promise<number> {
  const person = await tx.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { active: true, kind: true, notificationPrefs: true, phone: true, email: true } });
  if (!person?.active || person.kind !== "person") return 0;
  const channels = channelsFor(cleanNotificationPrefs(person.notificationPrefs), event);
  if (!channels.length) return 0;
  const phones = channels.includes("push")
    ? await tx
        .select({ id: staffDevices.id })
        .from(staffDevices)
        .where(and(eq(staffDevices.staffId, staffId), isNull(staffDevices.revokedAt), eq(staffDevices.pushEnabled, true)))
    : [];
  const now = msg.now ?? new Date();
  const held = channels.some((c) => QUIET_CHANNELS.includes(c)) ? await quietHold(staffId, event, now, null, tx) : null;
  const rows = [
    ...(channels.includes("sms") && person.phone ? [{ channel: "sms", to: person.phone, subject: null }] : []),
    ...(channels.includes("email") && person.email ? [{ channel: "email", to: person.email, subject: STAFF_EVENT_LABEL[event] }] : []),
    ...phones.map((d) => ({ channel: "push", to: d.id, subject: STAFF_EVENT_LABEL[event] })),
  ].map((r) => ({ ...r, kind: `staff_${event}`, body: msg.body, shopId: msg.shopId, ...timing(r.channel, staffId, now, held) }));
  if (rows.length) await tx.insert(notificationJobs).values(rows);
  return rows.length;
}
