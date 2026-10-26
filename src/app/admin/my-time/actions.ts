"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { timeBlockSeries, timeBlocks, timeOffRequests } from "@/db/schema";
import type { BlockReason } from "@/domain/block-reasons";
import { LUNCH_NOW_MIN, selfBlockProblem } from "@/domain/staff-time";
import { isValidLocalDate, localDateOf, localMinutesOf } from "@/lib/time";
import { safe } from "@/server/action";
import { workShopIds } from "@/server/auth/access";
import { blockChangeDenied } from "@/server/auth/policy";
import { StaffContext, approverOf, authorize, blockCaller, can, requireStaff } from "@/server/auth/staff";
import { staffWallTime } from "@/server/booking";
import { lunchReason, usableReason } from "@/server/block-reasons";
import { AppError, forbidden, notFound } from "@/server/errors";
import { addBlock, cancelTimeOff, createSeries, endSeries, removeBlock, requestTimeOff, rulesFor } from "@/server/staff-time";

const BLOCKERS = ["blocks.own", "blocks.others"] as const;

function refresh() {
  revalidatePath("/admin/my-time");
  revalidatePath("/admin/calendar");
  revalidatePath("/admin");
}

/** Your own block, at every shop you work at. Held to the shop's limits unless you can block anyone's time. */
async function ownBlock(ctx: StaffContext, reason: BlockReason, startsAt: Date, endsAt: Date, note: string | null, confirm: boolean, via: string) {
  const me = ctx.staff.id;
  const denied = blockChangeDenied(blockCaller(ctx), { staffId: me, shopId: null }, await workShopIds(me));
  if (denied) throw forbidden(denied);
  if (!can(ctx, "blocks.others")) {
    const problem = selfBlockProblem(await rulesFor(me, null), reason.countsAsLunch, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000));
    if (problem) throw new AppError("bad_request", problem);
  }
  const r = await addBlock({ staffId: me, shopId: null, startsAt, endsAt, reasonId: reason.id, note }, { actor: ctx.actor, confirm, via });
  if (r.done) refresh();
  return { saved: r.done, conflicts: r.conflicts };
}

const ReasonId = z.string("Pick a reason").uuid("Pick a reason");
const Note = z.string().max(200, "Keep the note to 200 characters").nullable().optional().default(null);

const Quick = z.object({
  reasonId: ReasonId,
  note: Note,
  date: z.string().refine(isValidLocalDate, "Pick a date"),
  startMin: z.number().int().min(0).max(24 * 60 - 1),
  minutes: z.number().int().min(5, "At least 5 minutes").max(12 * 60),
  confirm: z.boolean().optional().default(false),
});

/** A block from a start and a length, for a reason on the brand's list. */
export async function quickBlockAction(input: z.input<typeof Quick>) {
  return safe(async () => {
    const ctx = await authorize(BLOCKERS, "You can't block out your own time");
    const v = Quick.parse(input);
    const reason = await usableReason(v.reasonId, "blocks", undefined, ctx.currentShopId);
    const startsAt = staffWallTime(v.date, v.startMin);
    const endsAt = new Date(startsAt.getTime() + v.minutes * 60_000);
    if (endsAt <= new Date()) throw new AppError("bad_request", "That time has already passed");
    return ownBlock(ctx, reason, startsAt, endsAt, v.note, v.confirm, "my_time");
  });
}

/** One tap: lunch from now for 30 minutes (or the shop's longest lunch, if that's shorter). */
export async function lunchNowAction(confirm = false) {
  return safe(async () => {
    const ctx = await authorize(BLOCKERS, "You can't block out your own time");
    const now = new Date();
    const startsAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const rules = await rulesFor(ctx.staff.id, null);
    const minutes = can(ctx, "blocks.others") ? LUNCH_NOW_MIN : Math.min(LUNCH_NOW_MIN, rules.maxLunchMin);
    const r = await ownBlock(ctx, await lunchReason(ctx.currentShopId), startsAt, new Date(startsAt.getTime() + minutes * 60_000), null, confirm, "lunch_now");
    return { ...r, until: localMinutesOf(new Date(startsAt.getTime() + minutes * 60_000)), date: localDateOf(startsAt) };
  });
}

export async function removeMyBlockAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(BLOCKERS, "You can't change your blocks");
    const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
    if (!b || b.staffId !== ctx.staff.id) throw notFound("Block");
    const denied = blockChangeDenied(blockCaller(ctx), b, await workShopIds(b.staffId));
    if (denied) throw forbidden(denied);
    await removeBlock(id, ctx.actor, "my_time");
    refresh();
    return null;
  });
}

const Series = z.object({
  reasonId: ReasonId,
  note: Note,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day"),
  startMin: z.number().int().min(0).max(24 * 60),
  endMin: z.number().int().min(0).max(24 * 60),
  startsOn: z.string().refine(isValidLocalDate, "Pick the first day"),
  endsOn: z.string().refine(isValidLocalDate, "Pick the last day").nullable().optional().default(null),
  confirm: z.boolean().optional().default(false),
});

/** A recurring block of your own, e.g. lunch every weekday 12:00–12:30. */
export async function createMySeriesAction(input: z.input<typeof Series>) {
  return safe(async () => {
    const ctx = await authorize(BLOCKERS, "You can't block out your own time");
    const v = Series.parse(input);
    const reason = await usableReason(v.reasonId, "blocks", undefined, ctx.currentShopId);
    const me = ctx.staff.id;
    const denied = blockChangeDenied(blockCaller(ctx), { staffId: me, shopId: null }, await workShopIds(me));
    if (denied) throw forbidden(denied);
    if (!can(ctx, "blocks.others")) {
      const problem = selfBlockProblem(await rulesFor(me, null), reason.countsAsLunch, v.endMin - v.startMin);
      if (problem) throw new AppError("bad_request", problem);
    }
    const r = await createSeries(
      { staffId: me, shopId: null, reasonId: reason.id, note: v.note, weekdays: v.weekdays, startMin: v.startMin, endMin: v.endMin, startsOn: v.startsOn, endsOn: v.endsOn },
      { actor: ctx.actor, confirm: v.confirm },
    );
    if (r.done) refresh();
    return { saved: r.done, conflicts: r.conflicts, occurrences: r.done ? r.occurrences : 0 };
  });
}

export async function endMySeriesAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(BLOCKERS, "You can't change your blocks");
    const s = await db.query.timeBlockSeries.findFirst({ where: eq(timeBlockSeries.id, id) });
    if (!s || s.staffId !== ctx.staff.id) throw notFound("Recurring block");
    const denied = blockChangeDenied(blockCaller(ctx), s, await workShopIds(s.staffId));
    if (denied) throw forbidden(denied);
    const r = await endSeries(id, ctx.actor);
    refresh();
    return { removed: r.removed };
  });
}

const Request = z.object({
  shopId: z.string().uuid().nullable(),
  fromDate: z.string().refine(isValidLocalDate, "Pick the first day"),
  toDate: z.string().refine(isValidLocalDate, "Pick the last day"),
  allDay: z.boolean(),
  startMin: z.number().int().min(0).max(24 * 60).optional(),
  endMin: z.number().int().min(0).max(24 * 60).optional(),
  reasonId: ReasonId,
  note: Note,
  confirm: z.boolean().optional().default(false),
});

/** Your own time off: whole days or part of one day, at one of your shops or all of them. */
export async function requestTimeOffAction(input: z.input<typeof Request>) {
  return safe(async () => {
    const ctx = await authorize("timeoff.request", "You can't request time off");
    const v = Request.parse(input);
    const mine = await workShopIds(ctx.staff.id);
    if (!mine.length) throw forbidden("You aren't on any shop's team yet");
    if (v.shopId && !mine.includes(v.shopId)) throw forbidden("You don't work at that shop");
    const range = v.allDay
      ? { fromDate: v.fromDate, toDate: v.toDate, startMin: null, endMin: null }
      : { fromDate: v.fromDate, toDate: v.fromDate, startMin: v.startMin ?? null, endMin: v.endMin ?? null };
    const r = await requestTimeOff(
      { staffId: ctx.staff.id, shopId: v.shopId, range, reasonId: v.reasonId, note: v.note },
      { actor: ctx.actor, confirm: v.confirm, enforceNotice: true },
    );
    if (r.done) {
      refresh();
      revalidatePath("/admin/time-off");
    }
    return r.done ? { saved: true, conflicts: r.conflicts, status: r.status, heldForManager: r.heldForManager } : { saved: false, conflicts: r.conflicts, status: null, heldForManager: false };
  });
}

export async function cancelMyRequestAction(id: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const r = await db.query.timeOffRequests.findFirst({ where: eq(timeOffRequests.id, id) });
    if (!r || r.staffId !== ctx.staff.id) throw notFound("Time off request");
    await cancelTimeOff(id, approverOf(ctx));
    refresh();
    revalidatePath("/admin/time-off");
    return null;
  });
}
