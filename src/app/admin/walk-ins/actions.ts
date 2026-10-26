"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { shops, waitlistEntries } from "@/db/schema";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { quickWalkIn, seatFromWaitlist, updateWaitlistStatus } from "@/server/booking";
import { linkWalkIns } from "@/server/booking-groups";
import { clientPolicy } from "@/server/client-privacy";
import { checkEntry, fillEntry, type EntryDetails } from "@/server/client-entry";
import { textingDeclined } from "@/server/customers";
import { AppError, notFound } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { requireInTenant } from "@/server/tenant";

export async function walkInAction(input: {
  shopId: string;
  serviceId: string;
  name: string;
  phone: string;
  preferredStaffId: string | null;
  customerId?: string | null;
  /** A new client's other details, each needing "add"; a matched client keeps what's on file. */
  details?: EntryDetails | null;
}) {
  return safe(async () => {
    const ctx = await authorize("walkins.manage");
    assertShopAccess(ctx, input.shopId);
    const customerId = input.customerId ? z.uuid().parse(input.customerId) : null;
    const typed = customerId ? null : checkEntry(await clientPolicy(ctx), { ...input.details, phone: input.phone });
    const r = await quickWalkIn({ shopId: input.shopId, serviceId: input.serviceId, name: input.name, preferredStaffId: input.preferredStaffId, customerId, phone: customerId ? null : (typed?.phone ?? null), actor: ctx.actor });
    const clientId = r.seated ? r.appointment.customer?.id : r.entry.customerId;
    if (typed && clientId) await fillEntry(clientId, typed, { actor: ctx.actor, staffId: ctx.staff.id, shopId: input.shopId });
    revalidatePath("/admin/walk-ins");
    revalidatePath("/admin/calendar");
    return r.seated
      ? { seated: true as const, appointmentId: r.appointment.id, barber: r.appointment.barber.displayName }
      : { seated: false as const, quotedWaitMin: r.entry.quotedWaitMin ?? 0 };
  });
}

/** A family walking in together: the ones seated become one group, so they check out together. */
export async function linkWalkInsAction(appointmentIds: string[]) {
  return safe(async () => {
    const ctx = await authorize("walkins.manage");
    const ids = z.array(z.uuid()).max(7).parse(appointmentIds);
    for (const id of ids) await requireInTenant(ctx, "appointment", id);
    const code = await linkWalkIns(ids, ctx.actor);
    revalidatePath("/admin/calendar");
    return { code };
  });
}

async function entryFor(entryId: string) {
  const ctx = await authorize("walkins.manage");
  await requireInTenant(ctx, "waitlist_entry", entryId);
  const e = await db.query.waitlistEntries.findFirst({ where: eq(waitlistEntries.id, entryId) });
  if (!e) throw notFound("Waitlist entry");
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
    await enqueueRaw({ kind: "waitlist_ready", channel: "sms", to: e.phone, customerId: e.customerId, shopId: e.shopId, body: `Ray'z ${shop?.name}: ${e.name.split(" ")[0]}, your chair is ready! Please head in.` });
    await updateWaitlistStatus(entryId, "notified", ctx.actor);
    revalidatePath("/admin/walk-ins");
    return null;
  });
}
