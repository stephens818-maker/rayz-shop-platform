/**
 * A barber's day as the time clock shows it, kept pure: where they stand right now (clocked in, on a
 * break, clocked out, not in yet), the time they actually worked next to the schedule, late and
 * early punches and missed ones, and what that does to online booking: a break or an early
 * clock-out holds the time, an early clock-in can open the time before the scheduled start. The
 * server (src/server/clock-live.ts) loads the punches and applies these to availability, the
 * calendar and Today. Customers only ever see the slots that result.
 */
import { type ClockRules, type Interval, type PairProblemKind, type PunchLike, type ShopClockSettings, forgottenAfter, offSchedule, pairPunches } from "./time-clock";

export type LiveStatus = "in" | "break" | "out" | "not_in";

export const LIVE_STATUS_LABEL: Record<LiveStatus, string> = { in: "Clocked in", break: "On break", out: "Clocked out", not_in: "Not in yet" };

export type MissedKind = Exclude<PairProblemKind, "open_shift"> | "forgot_out";

export const MISSED_LABEL: Record<MissedKind, string> = {
  forgot_out: "No clock-out",
  double_in: "Clocked in twice",
  out_without_in: "No clock-in",
  break_outside_shift: "Break while clocked out",
  break_end_without_start: "Break end with no start",
  break_not_ended: "Break never ended",
  double_break: "Break started twice",
};

export type HoldWhy = "break" | "clocked_out";

export const HOLD_LABEL: Record<HoldWhy, string> = { break: "On break", clocked_out: "Clocked out" };

/** An open break holds at least this far ahead once it runs past the shop's hold. */
const BREAK_ROLL_MS = 15 * 60_000;
/** An open shift older than this is a forgotten one, not someone at work (as on the time clock). */
const STALE_OPEN_MS = 24 * 3600_000;

export interface LiveShift {
  start: Date;
  /** Null while still clocked in. */
  end: Date | null;
  breaks: { start: Date; end: Date | null }[];
}

export interface LiveDayInput {
  staffId: string;
  shopId: string;
  /** This barber's punches, at every shop, from at least a day before `dayStart` up to now. */
  punches: readonly PunchLike[];
  dayStart: Date;
  dayEnd: Date;
  /** Their scheduled stretches at this shop that day. */
  scheduled: readonly Interval[];
  now: Date;
  shop: Pick<ShopClockSettings, "blockOnBreak" | "breakHoldMinutes" | "blockAfterClockOut" | "openEarly" | "graceMinutes">;
  rules: Pick<ClockRules, "graceMinutes" | "forgotOutAfterMinutes" | "maxShiftHours">;
  /** The barber lets an early clock-in open earlier slots. */
  permitsEarly: boolean;
}

export interface LiveDay {
  staffId: string;
  /** Where they stand now. Null for a day that isn't today. */
  status: LiveStatus | null;
  /** Clocked in at another shop right now. */
  elsewhereShopId: string | null;
  /** When the current status began: the clock-in, the break's start or the clock-out. */
  since: Date | null;
  /** Shifts at this shop that touch the day. */
  shifts: LiveShift[];
  /** The first clock-in here was this many minutes past the scheduled start (beyond the grace). */
  lateMin: number | null;
  /** Not clocked in yet and the scheduled start (plus grace) has passed by this many minutes. */
  overdueMin: number | null;
  /** The last clock-out here was this many minutes before the scheduled end (beyond the grace). */
  earlyOutMin: number | null;
  missed: { kind: MissedKind; at: Date }[];
  /** Online booking held by the clock, at this shop. */
  holds: { start: Date; end: Date; why: HoldWhy }[];
  /** Time before the scheduled start opened by an early clock-in; `end` is the scheduled start. */
  early: { start: Date; end: Date } | null;
}

const t = (d: Date) => d.getTime();

/** One barber's day at one shop from their punches. Holds and early time only come out for today (`now` inside the day). */
export function liveDay(i: LiveDayInput): LiveDay {
  const mine = i.punches.filter((p) => p.staffId === i.staffId && t(p.at) <= t(i.now));
  const { shifts, problems } = pairPunches(mine);
  const isToday = t(i.now) >= t(i.dayStart) && t(i.now) < t(i.dayEnd);
  const grace = i.shop.graceMinutes ?? i.rules.graceMinutes;
  const touches = (s: { start: Date; end: Date | null }) => t(s.start) < t(i.dayEnd) && t(s.end ?? i.now) > t(i.dayStart);
  const here = shifts.filter((s) => s.shopId === i.shopId && touches(s));
  const startedToday = here.filter((s) => t(s.start) >= t(i.dayStart));

  const latest = shifts[shifts.length - 1];
  const open = latest && latest.end === null && t(i.now) - t(latest.start) <= STALE_OPEN_MS ? latest : null;
  const openBreak = open?.breaks.find((b) => b.end === null) ?? null;

  let status: LiveStatus | null = null;
  let since: Date | null = null;
  let elsewhereShopId: string | null = null;
  if (isToday) {
    if (open && open.shopId !== i.shopId) {
      elsewhereShopId = open.shopId;
      status = "in";
      since = open.start;
    } else if (open) {
      status = openBreak ? "break" : "in";
      since = openBreak ? openBreak.start : open.start;
    } else if (startedToday.length) {
      status = "out";
      since = startedToday[startedToday.length - 1].end;
    } else status = "not_in";
  }

  const first = startedToday[0];
  const late = first ? offSchedule("in", first.start, i.scheduled, grace) : null;
  const lateMin = late?.flag === "late" ? late.minutes : null;
  const firstStart = i.scheduled[0]?.start;
  const overdueMin =
    status === "not_in" && firstStart && t(i.now) > t(firstStart) + grace * 60_000 && t(i.now) < t(i.scheduled[i.scheduled.length - 1].end)
      ? Math.floor((t(i.now) - t(firstStart)) / 60_000)
      : null;

  const last = startedToday[startedToday.length - 1];
  const closedLast = last && last.end && !(open && open.shopId === i.shopId) ? last : null;
  const out = closedLast ? offSchedule("out", closedLast.end!, i.scheduled, grace) : null;
  const earlyOutMin = out?.flag === "early_out" ? -out.minutes! : null;

  const missed: LiveDay["missed"] = problems
    .filter((p) => p.kind !== "open_shift" && p.shopId === i.shopId && t(p.at) >= t(i.dayStart) && t(p.at) < t(i.dayEnd))
    .map((p) => ({ kind: p.kind as MissedKind, at: p.at }));
  for (const s of here) {
    if (s.end !== null) continue;
    const due = forgottenAfter(s.start, i.scheduled, i.rules);
    if (s !== open || t(due) <= t(i.now)) missed.push({ kind: "forgot_out", at: s.start });
  }
  missed.sort((a, b) => t(a.at) - t(b.at));

  const holds: LiveDay["holds"] = [];
  let early: LiveDay["early"] = null;
  if (isToday) {
    if (status === "break" && !elsewhereShopId && i.shop.blockOnBreak && openBreak) {
      const end = Math.max(t(openBreak.start) + i.shop.breakHoldMinutes * 60_000, t(i.now) + BREAK_ROLL_MS);
      holds.push({ start: openBreak.start, end: new Date(Math.min(end, t(i.dayEnd))), why: "break" });
    }
    if (status === "out" && earlyOutMin !== null && i.shop.blockAfterClockOut) holds.push({ start: closedLast!.end!, end: i.dayEnd, why: "clocked_out" });
    if (open && open.shopId === i.shopId && i.shop.openEarly && i.permitsEarly && t(open.start) >= t(i.dayStart)) {
      const next = i.scheduled.find((s) => t(s.start) > t(open.start));
      const inside = i.scheduled.some((s) => t(s.start) <= t(open.start) && t(s.end) > t(open.start));
      if (next && !inside) early = { start: open.start, end: next.start };
    }
  }

  return {
    staffId: i.staffId,
    status,
    elsewhereShopId,
    since,
    shifts: here.map((s) => ({ start: s.start, end: s.end, breaks: s.breaks.map((b) => ({ start: b.start, end: b.end })) })),
    lateMin,
    overdueMin,
    earlyOutMin,
    missed,
    holds,
    early,
  };
}

export interface BookedLike {
  id: string;
  staffId: string;
  shopId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

/** Statuses a break or a clock-out can still disrupt: the client hasn't sat down yet. */
export const DISRUPTABLE = ["booked", "confirmed", "checked_in"] as const;

/** Appointments the clock now holds time over: booked with this barber, here, overlapping a break or the time after an early clock-out. */
export function affectedBy<T extends BookedLike>(day: Pick<LiveDay, "staffId" | "holds">, shopId: string, appts: readonly T[]): (T & { why: HoldWhy })[] {
  const out: (T & { why: HoldWhy })[] = [];
  for (const a of appts) {
    if (a.staffId !== day.staffId || a.shopId !== shopId || !(DISRUPTABLE as readonly string[]).includes(a.status)) continue;
    const h = day.holds.find((x) => t(a.startsAt) < t(x.end) && t(a.endsAt) > t(x.start));
    if (h) out.push({ ...a, why: h.why });
  }
  return out.sort((a, b) => t(a.startsAt) - t(b.startsAt));
}

/** The call-in form (src/app/admin/call-ins) filled in for the time a break or early clock-out holds, in minutes after midnight. */
export function callInHref(staffId: string, shopId: string, hold: { why: HoldWhy; startMin: number; endMin: number }): string {
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const q = new URLSearchParams({ staff: staffId, shop: shopId, from: hm(Math.floor(hold.startMin / 15) * 15) });
  if (hold.why === "break") q.set("to", hm(Math.min(24 * 60 - 15, Math.ceil(hold.endMin / 15) * 15)));
  return `/admin/call-ins?${q}`;
}

/**
 * Due a "not clocked in" alert: today, not clocked in here, with a first appointment (that hasn't
 * started) at most `minutes` away or already begun. Null when there's nothing to say.
 */
export function lateClockIn(day: Pick<LiveDay, "status" | "elsewhereShopId">, firstAppt: Pick<BookedLike, "startsAt" | "status"> | null, now: Date, minutes: number | null): { minutesToGo: number } | null {
  if (minutes === null || !firstAppt || day.status === null) return null;
  if (day.status === "in" || day.status === "break") {
    if (!day.elsewhereShopId) return null;
  } else if (day.status === "out") return null;
  if (!(DISRUPTABLE as readonly string[]).includes(firstAppt.status)) return null;
  const toGo = Math.round((t(firstAppt.startsAt) - t(now)) / 60_000);
  return toGo <= minutes ? { minutesToGo: toGo } : null;
}
