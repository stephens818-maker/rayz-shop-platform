import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffAppTokens, staffDevices, staffSchedules, staffShops, timeBlockSeries, timeOffRequests } from "@/db/schema";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { AffectedAppointment, affectedByRequests, endSeries } from "./staff-time";
import { releaseLeaverPayouts } from "./tips/payouts";

const FAR = 3 * 365 * 86_400_000;

/** Booked appointments from now on, to hand to someone else before or after offboarding. */
export async function futureBookings(staffId: string, now: Date = new Date()): Promise<AffectedAppointment[]> {
  const span = { id: "future", staffId, shopId: null, startsAt: now, endsAt: new Date(now.getTime() + FAR) };
  return (await affectedByRequests([span])).get("future") ?? [];
}

/**
 * Takes someone off the team in one step. Their sign-in stops working on the next request, they
 * leave online booking and every schedule, recurring blocks end, and pending time-off requests are
 * cancelled. Past sales, tips, punches and payroll stay. Tips held for their Stripe setup are let go:
 * open pay periods' go with their last paycheck, earlier ones in cash. Booked appointments are left
 * booked and returned so the shop can move them.
 */
export async function offboardStaff(staffId: string, actor: Actor & { staffId: string }, reason: string | null, now: Date = new Date()) {
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!person) throw notFound("Staff member");
  if (person.kind !== "person") throw new AppError("bad_request", "Shop logins are turned off under Setup → Shop logins");
  if (person.id === actor.staffId) throw new AppError("bad_request", "You can't offboard yourself");
  if (!person.active) throw new AppError("conflict", `${person.displayLabel} is already inactive`);
  const counts = await db.transaction(async (tx) => {
    await tx.update(staff).set({ active: false, isBookable: false, sessionsValidAfter: now }).where(eq(staff.id, staffId));
    await tx.update(staffAppTokens).set({ revokedAt: now }).where(and(eq(staffAppTokens.staffId, staffId), isNull(staffAppTokens.revokedAt)));
    await tx.update(staffDevices).set({ revokedAt: now }).where(and(eq(staffDevices.staffId, staffId), isNull(staffDevices.revokedAt)));
    const schedules = await tx.delete(staffSchedules).where(eq(staffSchedules.staffId, staffId)).returning({ shopId: staffSchedules.shopId });
    await tx.update(staffShops).set({ visibleOnline: false }).where(eq(staffShops.staffId, staffId));
    const requests = await tx
      .update(timeOffRequests)
      .set({ status: "cancelled", decidedAt: now, decidedBy: actor.staffId, decisionNote: "Left the team", updatedAt: now })
      .where(and(eq(timeOffRequests.staffId, staffId), eq(timeOffRequests.status, "pending")))
      .returning({ id: timeOffRequests.id });
    return { schedules: schedules.length, timeOffRequests: requests.length };
  });
  const series = await db
    .select({ id: timeBlockSeries.id })
    .from(timeBlockSeries)
    .where(and(eq(timeBlockSeries.staffId, staffId), isNull(timeBlockSeries.endedAt)));
  for (const s of series) await endSeries(s.id, actor, now);
  const tips = await releaseLeaverPayouts(staffId, actor);
  const bookings = await futureBookings(staffId, now);
  await audit(actor, "staff.offboard", "staff", staffId, { ...counts, recurringBlocks: series.length, heldTipPayouts: tips.payouts, bookedAhead: bookings.length, reason: reason || null }, null);
  return { ...counts, recurringBlocks: series.length, heldTipPayouts: tips.payouts, bookings };
}
