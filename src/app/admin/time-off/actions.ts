"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { safe } from "@/server/action";
import { approverOf, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { askToReschedule, cancelTimeOff, decideTimeOff, reassignForTimeOff, reassignOptions, saveRules } from "@/server/staff-time";
import { requireInTenant } from "@/server/tenant";

function refresh() {
  revalidatePath("/admin/time-off");
  revalidatePath("/admin/calendar");
  revalidatePath("/admin");
}

/** Approve or deny. Approval returns the appointments booked in the time; they stay booked until moved or rescheduled. */
export async function decideTimeOffAction(id: string, decision: "approve" | "deny", note: string) {
  return safe(async () => {
    const ctx = await authorize("timeoff.approve", "You can't approve or deny time off");
    if (decision !== "approve" && decision !== "deny") throw new AppError("bad_request", "Approve or deny");
    const r = await decideTimeOff(id, decision, note, approverOf(ctx));
    refresh();
    return { affected: r.affected.length };
  });
}

export async function cancelTimeOffAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("timeoff.approve", "You can't change time off");
    await cancelTimeOff(id, approverOf(ctx));
    refresh();
    return null;
  });
}

/** Appointments are reassigned or rescheduled by people who can approve time off at that shop. */
async function affectedAppointment(appointmentId: string) {
  const ctx = await authorize("timeoff.approve", "You can't move appointments for time off");
  await requireInTenant(ctx, "appointment", appointmentId);
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, appointmentId) });
  if (!a) throw notFound("Appointment");
  assertShopAccess(ctx, a.shopId);
  if (a.staffId === ctx.staff.id && !ctx.isOwner) throw forbidden("Ask another manager to move your own appointments");
  return { ctx, a };
}

export async function reassignOptionsAction(appointmentId: string) {
  return safe(async () => {
    await affectedAppointment(appointmentId);
    return reassignOptions(appointmentId);
  });
}

export async function reassignAction(appointmentId: string, toStaffId: string) {
  return safe(async () => {
    const { ctx } = await affectedAppointment(appointmentId);
    await reassignForTimeOff(appointmentId, toStaffId, ctx.actor);
    refresh();
    return null;
  });
}

export async function askRescheduleAction(appointmentId: string) {
  return safe(async () => {
    const { ctx } = await affectedAppointment(appointmentId);
    const sent = await askToReschedule(appointmentId, ctx.actor);
    refresh();
    return { sent };
  });
}

/** One shop's changes to its rules. The brand's rules save through the brand change scope (the staff_time setting). */
export async function saveRulesAction(shopId: string, rules: Record<string, unknown>) {
  return safe(async () => {
    const ctx = await authorize("settings.shop", "You can't change the time off rules");
    if (!shopId) throw forbidden("The brand's rules go to every shop you pick: save them from the brand's row");
    assertShopAccess(ctx, shopId);
    await saveRules(shopId, rules, ctx.actor);
    refresh();
    revalidatePath("/admin/my-time");
    return null;
  });
}