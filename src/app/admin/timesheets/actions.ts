"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { wallInstant } from "@/domain/time-clock";
import { isValidLocalDate } from "@/lib/time";
import { safe } from "@/server/action";
import { authorize, type StaffContext } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { assertShop, requireInTenant } from "@/server/tenant";
import { addPunch, approveAsManager, approveOwn, editPunch, lockPeriod, unlockPeriod, voidPunch, type Editor } from "@/server/time-clock";

const PunchType = z.enum(["in", "out", "break_start", "break_end"]);
const Day = z.string().refine(isValidLocalDate, "Pick a date.");
const When = z.object({ local: z.string().max(16), later: z.boolean().optional() });

const editor = (ctx: StaffContext): Editor => ({ actor: ctx.actor, staffId: ctx.staff.id, isOwner: ctx.isOwner, shopIds: ctx.shopIds });

function instant(w: z.infer<typeof When>) {
  const at = wallInstant(w.local, w.later);
  if (!at) throw new AppError("bad_request", "That time doesn't exist (clocks skip ahead that night). Pick another.");
  return at;
}

function refresh() {
  revalidatePath("/admin/timesheets", "layout");
  revalidatePath("/admin/clock");
}

export async function editPunchAction(input: { punchId: string; when: { local: string; later?: boolean }; type: string; shopId: string; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.edit");
    const v = z.object({ punchId: z.uuid(), when: When, type: PunchType, shopId: z.uuid(), reason: z.string().max(400) }).parse(input);
    assertShop(ctx, v.shopId);
    await editPunch(editor(ctx), v.punchId, { at: instant(v.when), type: v.type, shopId: v.shopId }, v.reason);
    refresh();
    return null;
  });
}

export async function addPunchAction(input: { staffId: string; shopId: string; type: string; when: { local: string; later?: boolean }; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.edit");
    const v = z.object({ staffId: z.uuid(), shopId: z.uuid(), type: PunchType, when: When, reason: z.string().max(400) }).parse(input);
    assertShop(ctx, v.shopId);
    await requireInTenant(ctx, "staff", v.staffId);
    await addPunch(editor(ctx), { staffId: v.staffId, shopId: v.shopId, type: v.type, at: instant(v.when) }, v.reason);
    refresh();
    return null;
  });
}

export async function voidPunchAction(input: { punchId: string; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.edit");
    const v = z.object({ punchId: z.uuid(), reason: z.string().max(400) }).parse(input);
    await voidPunch(editor(ctx), v.punchId, v.reason);
    refresh();
    return null;
  });
}

export async function approveOwnAction(input: { shopId: string; periodStart: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.own");
    const v = z.object({ shopId: z.uuid(), periodStart: Day }).parse(input);
    await approveOwn(ctx.staff.id, v.shopId, v.periodStart, ctx.actor);
    refresh();
    return null;
  });
}

export async function approveManagerAction(input: { staffId: string; shopId: string; periodStart: string; note: string | null }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.approve");
    const v = z.object({ staffId: z.uuid(), shopId: z.uuid(), periodStart: Day, note: z.string().max(400).nullable() }).parse(input);
    await requireInTenant(ctx, "staff", v.staffId);
    await approveAsManager(editor(ctx), v.staffId, v.shopId, v.periodStart, v.note);
    refresh();
    return null;
  });
}

export async function lockPeriodAction(input: { shopId: string; periodStart: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.approve");
    const v = z.object({ shopId: z.uuid(), periodStart: Day }).parse(input);
    await lockPeriod(editor(ctx), v.shopId, v.periodStart);
    refresh();
    return null;
  });
}

export async function unlockPeriodAction(input: { shopId: string; periodStart: string; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.approve");
    if (!ctx.isOwner && !ctx.permissions.has("payroll.run")) throw forbidden("Ask the owner or whoever runs payroll to reopen a locked period.");
    const v = z.object({ shopId: z.uuid(), periodStart: Day, reason: z.string().max(400) }).parse(input);
    await unlockPeriod(editor(ctx), v.shopId, v.periodStart, v.reason);
    refresh();
    return null;
  });
}
