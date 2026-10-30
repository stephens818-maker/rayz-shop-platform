"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { StaffContext, authorize, can, requireStaff } from "@/server/auth/staff";
import { addDayOn, removeDayOn, saveBookingOptions, saveNotificationPrefs, setVisibleOnline } from "@/server/staff-settings";

const viewer = (ctx: StaffContext) => ({ actor: ctx.actor, staffId: ctx.staff.id, shopIds: ctx.shopIds, brandWide: ctx.brandWide });
const Scope = z.union([z.literal("all"), z.string().uuid()]);

export async function saveBookingOptionsAction(raw: { staffId: string; scope: string; options: Record<string, unknown> }) {
  return safe(async () => {
    const ctx = await authorize("staff.manage");
    const p = z.object({ staffId: z.string().uuid(), scope: Scope, options: z.record(z.string(), z.unknown()) }).parse(raw);
    const saved = await saveBookingOptions(viewer(ctx), p);
    revalidatePath(`/admin/staff/${p.staffId}`);
    return saved;
  });
}

export async function setVisibleOnlineAction(raw: { staffId: string; scope: string; visible: boolean }) {
  return safe(async () => {
    const ctx = await authorize("staff.manage");
    const p = z.object({ staffId: z.string().uuid(), scope: Scope, visible: z.boolean() }).parse(raw);
    await setVisibleOnline(viewer(ctx), p);
    revalidatePath(`/admin/staff/${p.staffId}`);
    revalidatePath("/admin/staff");
    return null;
  });
}

export async function saveNotificationPrefsAction(raw: { staffId: string; prefs: unknown }) {
  return safe(async () => {
    const ctx = await requireStaff();
    const p = z.object({ staffId: z.string().uuid(), prefs: z.unknown() }).parse(raw);
    const saved = await saveNotificationPrefs({ ...viewer(ctx), canManage: can(ctx, "staff.manage") }, p);
    revalidatePath(`/admin/staff/${p.staffId}`);
    return saved;
  });
}

export async function addDayOnAction(raw: { staffId: string; shopId: string; date: string; startMin: number; endMin: number; note?: string | null }) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    const p = z
      .object({ staffId: z.string().uuid(), shopId: z.string().uuid(), date: z.string(), startMin: z.number().int(), endMin: z.number().int(), note: z.string().max(200).nullish() })
      .parse(raw);
    const id = await addDayOn(viewer(ctx), p);
    revalidatePath(`/admin/staff/${p.staffId}`);
    revalidatePath("/admin/calendar");
    return id;
  });
}

export async function removeDayOnAction(raw: { id: string; staffId: string }) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    const p = z.object({ id: z.string().uuid(), staffId: z.string().uuid() }).parse(raw);
    await removeDayOn(viewer(ctx), p.id);
    revalidatePath(`/admin/staff/${p.staffId}`);
    revalidatePath("/admin/calendar");
    return null;
  });
}
