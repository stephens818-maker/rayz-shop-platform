/**
 * The block-outs the time clock writes, worked out from punches and the schedule. Pure: the server
 * (src/server/clock-blocks.ts) loads the punches and writes the result to time_blocks, where they
 * are ordinary blocks to availability, the calendar, who's off and reports.
 *
 * - A break blocks from its start for its planned length (the shop's default when none was given),
 *   on past that while it lasts, and is trimmed to the break end.
 * - A clock-out before the scheduled end blocks to the end of that stretch of the schedule,
 *   trimmed to the next clock-in.
 * - Where the shop turns it on, "Not in yet" blocks from the scheduled start until the clock-in.
 *
 * Each block has a stable key from the punch (or the scheduled start) it comes from, so editing or
 * voiding the punch moves or removes the same row.
 */
import { endOfLocalDay, localDateOf } from "@/lib/time";
import { type Interval, type PunchLike, type ShopClockSettings, pairPunches } from "./time-clock";

export type ClockBlockKind = "break" | "clocked_out" | "not_in";

/** The block_reasons key each kind is written with (a break uses the reason picked at break start, if any). */
export const CLOCK_REASON_KEY: Record<ClockBlockKind, string> = { break: "break", clocked_out: "clocked_out", not_in: "not_in" };
/** Used when the reason is missing from the list. */
export const CLOCK_BLOCK_LABEL: Record<ClockBlockKind, string> = { break: "Break", clocked_out: "Clocked out", not_in: "Not in yet" };

/** A block still going always reaches at least this far ahead; the cron and every punch move it on. */
export const CLOCK_ROLL_MS = 15 * 60_000;
/** An open shift older than this is a forgotten clock-out, not someone at work. */
const STALE_OPEN_MS = 24 * 3600_000;

export interface ClockPunch extends PunchLike {
  reasonId?: string | null;
  plannedMin?: number | null;
}

export type ClockBlockSettings = Pick<ShopClockSettings, "blockOnBreak" | "breakHoldMinutes" | "blockAfterClockOut" | "notInBlock"> & { graceMinutes: number };

export interface ClockBlockInput {
  staffId: string;
  /** Their punches at every shop, reaching at least 36 hours either side of the window. */
  punches: readonly ClockPunch[];
  /** Blocks that start in [from, to) are worked out. */
  from: Date;
  to: Date;
  now: Date;
  settings: (shopId: string) => ClockBlockSettings;
  /** Their scheduled stretches, per shop, on the days the window touches. */
  scheduled: readonly (Interval & { shopId: string })[];
  /** They use the clock (punched in the last 30 days): only then does "Not in yet" apply. */
  usesClock: boolean;
  /** Time off already on the calendar (shopId null: every shop); no "Not in yet" starts inside it. */
  off: readonly (Interval & { shopId: string | null })[];
}

export interface WantedBlock {
  key: string;
  kind: ClockBlockKind;
  staffId: string;
  shopId: string;
  start: Date;
  end: Date;
  /** Still going: the end moves on with the clock until the punch that ends it. */
  open: boolean;
  /** The punch it comes from (break start or clock-out); null for "Not in yet". */
  punchId: string | null;
  /** The punch that ended it: break end, the clock-out that closed the break, or the next clock-in. */
  endPunchId: string | null;
  /** The reason picked at break start; null uses the kind's reason. */
  reasonId: string | null;
}

const t = (d: Date) => d.getTime();
const at = (ms: number) => new Date(ms);
const dayEnd = (d: Date) => t(endOfLocalDay(localDateOf(d)));

export function clockBlocks(i: ClockBlockInput): WantedBlock[] {
  const mine = i.punches.filter((p) => p.staffId === i.staffId && t(p.at) <= t(i.now) + 5 * 60_000);
  const byId = new Map(mine.map((p) => [p.id, p]));
  const { shifts } = pairPunches(mine);
  const inWindow = (d: Date) => t(d) >= t(i.from) && t(d) < t(i.to);
  const live = (s: { start: Date; end: Date | null }) => s.end === null && t(i.now) - t(s.start) <= STALE_OPEN_MS;
  const out: WantedBlock[] = [];

  for (const s of shifts) {
    const set = i.settings(s.shopId);
    if (set.blockOnBreak) {
      for (const b of s.breaks) {
        if (!inWindow(b.start)) continue;
        const p = byId.get(b.startId);
        const planned = p?.plannedMin && p.plannedMin > 0 ? p.plannedMin : set.breakHoldMinutes;
        const due = t(b.start) + planned * 60_000;
        let end: number;
        let open = false;
        if (b.end) end = t(b.end);
        else if (live(s)) {
          end = Math.min(Math.max(due, t(i.now) + CLOCK_ROLL_MS), dayEnd(b.start));
          open = end < dayEnd(b.start);
        } else end = due;
        if (end <= t(b.start)) continue;
        out.push({
          key: `break:${b.startId}`,
          kind: "break",
          staffId: i.staffId,
          shopId: s.shopId,
          start: b.start,
          end: at(end),
          open,
          punchId: b.startId,
          endPunchId: b.end ? (b.endId ?? s.outId) : null,
          reasonId: p?.reasonId ?? null,
        });
      }
    }
    if (set.blockAfterClockOut && s.end && s.outId && inWindow(s.end)) {
      const stretch = i.scheduled.find((x) => x.shopId === s.shopId && t(x.start) < t(s.end!) && t(x.end) > t(s.end!));
      if (stretch && t(stretch.end) - t(s.end) > set.graceMinutes * 60_000) {
        const back = shifts.find((n) => n.shopId === s.shopId && t(n.start) >= t(s.end!) && t(n.start) < t(stretch.end));
        const end = back ? t(back.start) : t(stretch.end);
        if (end > t(s.end))
          out.push({
            key: `out:${s.outId}`,
            kind: "clocked_out",
            staffId: i.staffId,
            shopId: s.shopId,
            start: s.end,
            end: at(end),
            open: false,
            punchId: s.outId,
            endPunchId: back?.inId ?? null,
            reasonId: null,
          });
      }
    }
  }

  if (i.usesClock) {
    for (const st of i.scheduled) {
      const set = i.settings(st.shopId);
      if (!set.notInBlock || !inWindow(st.start) || t(st.start) > t(i.now)) continue;
      const here = shifts.filter((s) => s.shopId === st.shopId);
      const covering = here.some((s) => t(s.start) <= t(st.start) && (s.end ? t(s.end) > t(st.start) : live(s)));
      if (covering) continue;
      if (i.off.some((o) => (o.shopId === null || o.shopId === st.shopId) && t(o.start) <= t(st.start) && t(o.end) > t(st.start))) continue;
      const first = here.find((s) => t(s.start) > t(st.start) && t(s.start) < t(st.end));
      let end: number;
      let open = false;
      if (first) {
        end = t(first.start);
        if (end - t(st.start) <= set.graceMinutes * 60_000) continue;
      } else {
        end = Math.min(t(st.end), Math.max(t(st.start), t(i.now)) + CLOCK_ROLL_MS);
        open = end < t(st.end);
      }
      out.push({
        key: `not_in:${i.staffId}:${st.shopId}:${st.start.toISOString()}`,
        kind: "not_in",
        staffId: i.staffId,
        shopId: st.shopId,
        start: st.start,
        end: at(end),
        open,
        punchId: null,
        endPunchId: first?.inId ?? null,
        reasonId: null,
      });
    }
  }
  return out.sort((a, b) => t(a.start) - t(b.start));
}

/** The kind of clock block a key belongs to. */
export function clockKindOf(key: string | null): ClockBlockKind | null {
  if (!key) return null;
  const k = key.slice(0, key.indexOf(":"));
  return k === "break" ? "break" : k === "out" ? "clocked_out" : k === "not_in" ? "not_in" : null;
}

/** How far an open clock block reaches for booking right now: never less than the roll ahead of `now`, whatever was last written. */
export function effectiveEnd(b: { endsAt: Date; clockOpen: boolean; overriddenAt: Date | null }, now: Date): Date {
  if (!b.clockOpen || b.overriddenAt) return b.endsAt;
  return at(Math.max(t(b.endsAt), t(now) + CLOCK_ROLL_MS));
}

/** Whether a sync only moved an open block's end on: no audit entry for that. */
export function onlyRolled(before: { startsAt: Date; endsAt: Date; clockOpen: boolean; endPunchId: string | null; reasonId: string | null }, after: WantedBlock & { reasonId: string | null }): boolean {
  return before.clockOpen && after.open && t(before.startsAt) === t(after.start) && t(after.end) >= t(before.endsAt) && before.endPunchId === after.endPunchId && before.reasonId === after.reasonId;
}
