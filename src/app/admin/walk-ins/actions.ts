"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { shops, waitlistEntries } from "@/db/schema";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { quickWalkIn, seatFromWaitlist, updateWaitlistStatus } from "@/server/booking";
import { textingDeclined } from "@/server/customers";
import { AppError, notFound } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";

export async function walkInAction(input: { shopId: string; serviceId: string; name: string; phone: string; preferredStaffId: string | null }) {
  return safe(async () => {
    const ctx = await authorize("walkins.manage");
    assertShopAccess(ctx, input.shopId);
    const r = await quickWalkIn({ ...input, phone: input.phone || null, actor: ctx.actor });
    revalidatePath("/admin/walk-ins");
    revalidatePath("/admin/calendar");
    return r.seated
      ? { seated: true as const, appointmentId: r.appointment.id, barber: r.appointment.barber.displayName }
      : { seated: false as const, quotedWaitMin: r.entry.quotedWaitMin ?? 0 };
  });
}

async function entryFor(entryId: string) {
  const ctx = await authorize("walkins.manage");
  const e = await db.query.waitlistEntries.findFirst({ where: eq(waitlistEntries.id, entryId) });
  if (!e) throw notFound("Waitlist entry");
  assertShopAccess(ctx, e.shopId);
  return { ctx, e };
}

export async function seatAction(entryId: string, staffId: string) {
  return safe(async () => {
    const { ctx } = await entryFor(entryId);
    const appt = await seatFromWaitlist(entryId, staffId, ctx.actor);
    revalidatePath("/admin/walk-ins");
    return { appointmentId: appt.id };
  });
}

export async function waitlistStatusAction(entryId: string, status: "left" | "done") {
  return safe(async () => {
    const { ctx } = await entryFor(entryId);
    await updateWaitlistStatus(entryId, status, ctx.actor);
    revalidatePath("/admin/walk-ins");
    return null;
  });
}

export async function notifyAction(entryId: string) {
  return safe(async () => {
    const { ctx, e } = await entryFor(entryId);
    if (!e.phone) throw new Error("No phone number on this entry");
    if (await textingDeclined(e.customerId, e.phone)) throw new AppError("conflict", "This client has opted out of texts. Call or wave them in instead.");
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, e.shopId) });
    await enqueueRaw({ kind: "waitlist_ready", channel: "sms", to: e.phone, customerId: e.customerId, body: `Ray'z ${shop?.name}: ${e.name.split(" ")[0]}, your chair is ready! Please head in.` });
    await updateWaitlistStatus(entryId, "notified", ctx.actor);
    revalidatePath("/admin/walk-ins");
    return null;
  });
}
