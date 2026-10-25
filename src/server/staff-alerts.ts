import { asc, eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointmentItems, appointments, customers, notificationJobs, shops, staff } from "@/db/schema";
import { StaffEvent, channelsFor, cleanNotificationPrefs, staffAlertText } from "@/domain/staff-notifications";
import { formatDate, formatTime } from "@/lib/time";

/**
 * Tells a barber about their own client's booking, change, cancellation or arrival on the channels
 * they picked. Never when they made the change themselves. App alerts wait for the staff app's
 * push (requested in NOTES-SYNC); texts and emails go out now. Returns how many were queued.
 */
export async function queueStaffAlert(event: StaffEvent, appointmentId: string, opts: { actorStaffId?: string | null; now?: Date } = {}, tx: DBorTx = db): Promise<number> {
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
  const body = staffAlertText(event, { firstName: row.firstName, when, shopName: row.shopName, services: items.map((i) => i.name) });
  const now = opts.now ?? new Date();
  const rows = [
    ...(channels.includes("sms") && row.phone ? [{ channel: "sms", to: row.phone, subject: null }] : []),
    ...(channels.includes("email") && row.email ? [{ channel: "email", to: row.email, subject: body.split(": ")[1]?.slice(0, 80) ?? "Your schedule" }] : []),
  ].map((r) => ({ ...r, kind: `staff_${event}`, body, appointmentId, shopId: row.shopId, runAt: now }));
  if (rows.length) await tx.insert(notificationJobs).values(rows);
  return rows.length;
}
