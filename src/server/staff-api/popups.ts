import "server-only";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { appointments, shops, staffSchedules } from "@/db/schema";
import { scheduledOn } from "@/domain/time-clock";
import { endOfLocalDay, formatDate, formatTime, localDateOf, weekdayOf } from "@/lib/time";
import { can } from "@/server/auth/staff";
import { markWelcomed, welcomeFor } from "@/server/milestones/day";
import { clockState } from "@/server/time-clock";
import type { StaffAppContext } from "./http";

/** How far ahead an unclocked start brings up the reminder. */
export const CLOCK_REMINDER_MIN = 30;

export interface Popup {
  /** A milestone's id (mark it seen with POST /popups/seen), or a fixed key for clock reminders. */
  id: string;
  kind: "milestone" | "clock_in_reminder" | "open_shift";
  title: string;
  body: string;
  milestoneKind?: string;
  shopId?: string | null;
}

/**
 * What the app pops up when it opens or comes back to the front: congratulations they haven't seen
 * (the brand's milestone settings and the welcome switch apply; sales amounts need dollar amounts in
 * reports), a reminder to clock in when their first client or shift starts soon and they're not in,
 * and an old shift that was never clocked out. Clocking in also returns the congratulations itself.
 */
export async function popupsFor(ctx: StaffAppContext, now = new Date()): Promise<{ popups: Popup[] }> {
  const me = ctx.staff.id;
  const out: Popup[] = [];
  if (ctx.staff.kind !== "person") return { popups: out };
  const items = await welcomeFor(me, { now, money: can(ctx, "reports.money") });
  if (items.length) {
    for (const i of items) out.push({ id: i.id, kind: "milestone", title: `Congratulations, ${ctx.staff.firstName}!`, body: i.text, milestoneKind: i.kind });
  }
  if (can(ctx, "timeclock.punch") && ctx.shopIds.length) {
    const state = await clockState(me, now);
    if (state.stale) out.push({ id: "open_shift", kind: "open_shift", title: "An old shift is still open", body: `Your clock-in at ${state.stale.shop} on ${formatDate(state.stale.start)} was never clocked out. A manager will fix it; you can clock in again now.` });
    if (state.state === "off") {
      const soon = new Date(now.getTime() + CLOCK_REMINDER_MIN * 60_000);
      const today = localDateOf(now);
      const [first] = await db
        .select({ startsAt: appointments.startsAt, shopId: appointments.shopId, shop: shops.name })
        .from(appointments)
        .innerJoin(shops, eq(shops.id, appointments.shopId))
        .where(
          and(
            eq(appointments.staffId, me),
            inArray(appointments.shopId, ctx.shopIds),
            inArray(appointments.status, ["booked", "confirmed", "checked_in"]),
            gt(appointments.startsAt, new Date(now.getTime() - 60 * 60_000)),
            lt(appointments.startsAt, endOfLocalDay(today)),
          ),
        )
        .orderBy(asc(appointments.startsAt))
        .limit(1);
      const sched = await db.select().from(staffSchedules).where(and(eq(staffSchedules.staffId, me), inArray(staffSchedules.shopId, ctx.shopIds)));
      const shift = ctx.shopIds
        .flatMap((shopId) => scheduledOn(today, weekdayOf(today), sched.filter((s) => s.shopId === shopId)).map((i) => ({ ...i, shopId })))
        .filter((i) => i.end > now)
        .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
      const starts = [first && { at: first.startsAt, shopId: first.shopId, what: `Your first client is at ${formatTime(first.startsAt)}` }, shift && { at: shift.start, shopId: shift.shopId, what: `Your shift starts at ${formatTime(shift.start)}` }]
        .filter((x): x is { at: Date; shopId: string; what: string } => !!x && x.at <= soon)
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      if (starts[0]) out.push({ id: "clock_in_reminder", kind: "clock_in_reminder", title: "You're not clocked in", body: `${starts[0].what}. Clock in when you get to the shop.`, shopId: starts[0].shopId });
    }
  }
  return { popups: out };
}

/** Milestones the app showed: they don't pop up again, here or on the web. */
export async function markPopupsSeen(ctx: StaffAppContext, ids: string[]) {
  return { seen: await markWelcomed(ctx.staff.id, ids, ctx.actor, "app") };
}
