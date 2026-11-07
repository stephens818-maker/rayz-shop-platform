"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { appointmentOutreach, callIns, timeBlocks } from "@/db/schema";
import { CALL_IN_KINDS, OUTREACH_OPTIONS } from "@/domain/outreach";
import { isValidLocalDate } from "@/lib/time";
import { safe } from "@/server/action";
import { StaffContext, assertShopAccess, authorize, caller, can } from "@/server/auth/staff";
import { workShopIds } from "@/server/auth/access";
import { callInDenied } from "@/server/auth/policy";
import { Who, cancelCallIn, closeByStaff, markCallIn, markCallInFromClockBlock, sendOutreach } from "@/server/call-ins";
import { forbidden, notFound } from "@/server/errors";
import { hasShop, requireInTenant } from "@/server/tenant";

const MARKERS = ["callins.mark", "callins.mark_own"] as const;

function refresh(id?: string) {
  revalidatePath("/admin/call-ins");
  if (id) revalidatePath(`/admin/call-ins/${id}`);
  revalidatePath("/admin/calendar");
  revalidatePath("/admin");
}

/** Whether they may mark (or cancel) this call-in, against the shops the barber works at. */
async function assertCanMark(ctx: StaffContext, c: { staffId: string; shopId: string | null }) {
  const denied = callInDenied(markerOf(ctx), c, await workShopIds(c.staffId));
  if (denied) throw forbidden(denied);
}

const markerOf = (ctx: StaffContext) => ({ ...caller(ctx), markOthers: can(ctx, "callins.mark"), markOwn: can(ctx, "callins.mark_own") });
const whoOf = (ctx: StaffContext): Who => ({ actor: ctx.actor, staffId: ctx.staff.id, shopIds: ctx.shopIds, canOutreach: can(ctx, "callins.outreach"), canVoice: can(ctx, "callins.voice") });

const Mark = z.object({
  staffId: z.string().uuid("Pick a barber"),
  shopId: z.string().uuid().nullable(),
  kind: z.enum(CALL_IN_KINDS as [string, ...string[]]),
  reasonId: z.string().uuid().nullable().optional(),
  fromDate: z.string().refine(isValidLocalDate, "Pick a date"),
  toDate: z.string().refine(isValidLocalDate, "Pick a date"),
  allDay: z.boolean(),
  startMin: z.number().int().min(0).max(24 * 60),
  endMin: z.number().int().min(0).max(24 * 60),
  note: z.string().max(200, "Keep the note to 200 characters").nullable().optional(),
});

/** Writes the time off and lists the appointments in it; nothing goes to clients until outreach is sent. */
export async function markCallInAction(input: z.input<typeof Mark>) {
  return safe(async () => {
    const ctx = await authorize(MARKERS, "You can't mark call-ins");
    const v = Mark.parse(input);
    await assertCanMark(ctx, { staffId: v.staffId, shopId: v.shopId });
    const r = await markCallIn(
      {
        staffId: v.staffId,
        shopId: v.shopId,
        kind: v.kind as (typeof CALL_IN_KINDS)[number],
        reasonId: v.reasonId ?? null,
        range: { fromDate: v.fromDate, toDate: v.allDay ? v.toDate : v.fromDate, startMin: v.allDay ? null : v.startMin, endMin: v.allDay ? null : v.endMin },
        note: v.note ?? null,
      },
      { actor: ctx.actor },
    );
    refresh();
    return r;
  });
}

/** Clients booked inside a break, early clock-out or "Not in yet" block: open the rebook flow on that block. */
export async function callInFromClockBlockAction(blockId: string) {
  return safe(async () => {
    const ctx = await authorize(MARKERS, "You can't mark call-ins");
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, blockId) });
    if (!b || b.source !== "clock" || !b.shopId || !hasShop(ctx, b.shopId)) throw notFound("Block");
    await assertCanMark(ctx, { staffId: b.staffId, shopId: b.shopId });
    const r = await markCallInFromClockBlock(blockId, { actor: ctx.actor });
    refresh(r.callInId);
    return r;
  });
}

export async function cancelCallInAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(MARKERS, "You can't change call-ins");
    await requireInTenant(ctx, "call_in", id);
    const ci = await db.query.callIns.findFirst({ where: eq(callIns.id, id) });
    if (!ci) throw notFound("Call-in");
    await assertCanMark(ctx, ci);
    await cancelCallIn(id, ctx.actor);
    refresh(id);
    return null;
  });
}

const Choices = z
  .array(z.object({ appointmentId: z.string().uuid(), option: z.enum(OUTREACH_OPTIONS as [string, ...string[]]) }))
  .min(1, "Pick an option for at least one appointment")
  .max(200);

/** Each appointment gets its option; one failing doesn't stop the rest. */
export async function sendOutreachAction(callInId: string, choices: z.input<typeof Choices>) {
  return safe(async () => {
    const ctx = await authorize(["callins.outreach", "callins.voice"], "You can't contact clients about a call-in");
    await requireInTenant(ctx, "call_in", callInId);
    const list = Choices.parse(choices).map((c) => ({ appointmentId: c.appointmentId, option: c.option as (typeof OUTREACH_OPTIONS)[number] }));
    const results = await sendOutreach(callInId, list, whoOf(ctx));
    refresh(callInId);
    return results;
  });
}

const Close = z.object({ status: z.enum(["rebooked", "declined", "cancelled"]), note: z.string().max(200).nullable().optional() });

/** Staff reached the client another way: record how it ended and clear the flag. */
export async function closeOutreachAction(outreachId: string, input: z.input<typeof Close>) {
  return safe(async () => {
    const ctx = await authorize("callins.outreach", "You can't update call-in outreach");
    const row = await db.query.appointmentOutreach.findFirst({ where: eq(appointmentOutreach.id, outreachId) });
    if (!row) throw notFound("Appointment");
    assertShopAccess(ctx, row.shopId);
    const v = Close.parse(input);
    await closeByStaff(outreachId, v.status, v.note ?? null, ctx.actor);
    refresh(row.callInId);
    return null;
  });
}

