import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { CLOCK_ROLL_MS, clockBlocks, clockKindOf, effectiveEnd, onlyRolled, type ClockBlockInput, type ClockBlockSettings, type ClockPunch } from "@/domain/clock-blocks";
import { scheduledOn, type PunchType } from "@/domain/time-clock";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";

const DAY = "2026-10-19"; // Monday
const at = (hhmm: string) => DateTime.fromISO(`${DAY}T${hhmm}`, { zone: "America/Chicago" }).toJSDate();
let n = 0;
const p = (type: PunchType, hhmm: string, o: Partial<ClockPunch> = {}): ClockPunch => ({ id: `p${++n}`, staffId: "b1", shopId: "s1", type, at: at(hhmm), ...o });
// Scheduled 10:00–18:00 at s1.
const SCHED = scheduledOn(DAY, 1, [{ weekday: 1, startMin: 10 * 60, endMin: 18 * 60 }]).map((s) => ({ ...s, shopId: "s1" }));
const SET: ClockBlockSettings = { blockOnBreak: true, breakHoldMinutes: 30, blockAfterClockOut: true, notInBlock: false, graceMinutes: 5 };

function blocks(punches: ClockPunch[], now: string, over: Partial<ClockBlockInput> & { set?: Partial<ClockBlockSettings> } = {}) {
  const { set, ...rest } = over;
  return clockBlocks({
    staffId: "b1",
    punches,
    from: startOfLocalDay(DAY),
    to: endOfLocalDay(DAY),
    now: at(now),
    settings: () => ({ ...SET, ...set }),
    scheduled: SCHED,
    usesClock: true,
    off: [],
    ...rest,
  });
}

describe("clock blocks: breaks", () => {
  it("a break with a planned length blocks that long, linked to the break start", () => {
    const start = p("break_start", "12:00", { plannedMin: 20, reasonId: "r-lunch" });
    const [b] = blocks([p("in", "10:00"), start], "12:05");
    expect(b).toMatchObject({ key: `break:${start.id}`, kind: "break", shopId: "s1", start: at("12:00"), end: at("12:20"), open: true, punchId: start.id, endPunchId: null, reasonId: "r-lunch" });
  });

  it("with no planned length it blocks the shop's default, and runs on past it while the break lasts", () => {
    const start = p("break_start", "12:00");
    expect(blocks([p("in", "10:00"), start], "12:05")[0].end).toEqual(at("12:30"));
    expect(blocks([p("in", "10:00"), start], "12:40")[0].end).toEqual(new Date(at("12:40").getTime() + CLOCK_ROLL_MS));
  });

  it("ending the break trims the block to the actual end and links the end punch", () => {
    const start = p("break_start", "12:00", { plannedMin: 30 });
    const end = p("break_end", "12:12");
    const [b] = blocks([p("in", "10:00"), start, end], "12:15");
    expect(b).toMatchObject({ start: at("12:00"), end: at("12:12"), open: false, endPunchId: end.id });
  });

  it("clocking out during a break ends the break block at the clock-out", () => {
    const start = p("break_start", "17:00");
    const out = p("out", "17:10");
    const list = blocks([p("in", "10:00"), start, out], "17:15");
    expect(list.find((b) => b.kind === "break")).toMatchObject({ end: at("17:10"), endPunchId: out.id });
    expect(list.find((b) => b.kind === "clocked_out")).toMatchObject({ start: at("17:10"), end: at("18:00") });
  });

  it("writes nothing for breaks when the shop turns that off", () => {
    expect(blocks([p("in", "10:00"), p("break_start", "12:00")], "12:05", { set: { blockOnBreak: false } })).toEqual([]);
  });
});

describe("clock blocks: clocking out early", () => {
  it("blocks from the clock-out to the end of the scheduled stretch", () => {
    const out = p("out", "15:00");
    const [b] = blocks([p("in", "10:00"), out], "15:05");
    expect(b).toMatchObject({ key: `out:${out.id}`, kind: "clocked_out", start: at("15:00"), end: at("18:00"), open: false, punchId: out.id, endPunchId: null });
  });

  it("clocking back in trims it to the clock-in", () => {
    const out = p("out", "15:00");
    const back = p("in", "15:40");
    const [b] = blocks([p("in", "10:00"), out, back], "16:00");
    expect(b).toMatchObject({ key: `out:${out.id}`, start: at("15:00"), end: at("15:40"), endPunchId: back.id });
  });

  it("clocking in at another shop doesn't trim it", () => {
    const [b] = blocks([p("in", "10:00"), p("out", "15:00"), p("in", "15:30", { shopId: "s2" })], "16:00");
    expect(b.end).toEqual(at("18:00"));
  });

  it("no block within the grace, after the schedule, or when the shop turns it off", () => {
    expect(blocks([p("in", "10:00"), p("out", "17:57")], "18:00")).toEqual([]);
    expect(blocks([p("in", "10:00"), p("out", "18:30")], "18:35")).toEqual([]);
    expect(blocks([p("in", "10:00"), p("out", "15:00")], "15:05", { set: { blockAfterClockOut: false } })).toEqual([]);
  });

  it("with a split schedule it blocks to the end of the stretch they left, not the day", () => {
    const split = scheduledOn(DAY, 1, [
      { weekday: 1, startMin: 10 * 60, endMin: 13 * 60 },
      { weekday: 1, startMin: 14 * 60, endMin: 18 * 60 },
    ]).map((s) => ({ ...s, shopId: "s1" }));
    const [b] = blocks([p("in", "10:00"), p("out", "12:00")], "12:05", { scheduled: split });
    expect(b.end).toEqual(at("13:00"));
  });
});

describe("clock blocks: not in yet", () => {
  const on = { set: { notInBlock: true } };

  it("is off unless the shop turns it on", () => {
    expect(blocks([], "10:20")).toEqual([]);
  });

  it("from the scheduled start, rolling on until the clock-in", () => {
    const [b] = blocks([], "10:20", on);
    expect(b).toMatchObject({ kind: "not_in", key: `not_in:b1:s1:${at("10:00").toISOString()}`, start: at("10:00"), end: new Date(at("10:20").getTime() + CLOCK_ROLL_MS), open: true, punchId: null });
  });

  it("nothing before the scheduled start, or for someone who doesn't use the clock", () => {
    expect(blocks([], "09:50", on)).toEqual([]);
    expect(blocks([], "10:20", { ...on, usesClock: false })).toEqual([]);
  });

  it("the clock-in trims it and links the punch; within the grace there's none", () => {
    const late = p("in", "10:25");
    expect(blocks([late], "10:30", on)[0]).toMatchObject({ start: at("10:00"), end: at("10:25"), open: false, endPunchId: late.id });
    expect(blocks([p("in", "10:03")], "10:30", on)).toEqual([]);
    expect(blocks([p("in", "09:55")], "10:30", on)).toEqual([]);
  });

  it("not over time off already on the calendar", () => {
    expect(blocks([], "10:20", { ...on, off: [{ shopId: null, start: at("00:00"), end: at("23:59") }] })).toEqual([]);
  });

  it("runs to the end of the stretch when they never came", () => {
    expect(blocks([], "19:00", on)[0]).toMatchObject({ end: at("18:00"), open: false });
  });
});

describe("clock blocks: helpers", () => {
  it("reads the kind from the key", () => {
    expect(clockKindOf("break:abc")).toBe("break");
    expect(clockKindOf("out:abc")).toBe("clocked_out");
    expect(clockKindOf("not_in:a:b:c")).toBe("not_in");
    expect(clockKindOf(null)).toBeNull();
  });

  it("an open block reaches the roll ahead for booking; a closed or overridden one doesn't move", () => {
    const now = at("12:40");
    const ends = at("12:30");
    expect(effectiveEnd({ endsAt: ends, clockOpen: true, overriddenAt: null }, now)).toEqual(new Date(now.getTime() + CLOCK_ROLL_MS));
    expect(effectiveEnd({ endsAt: ends, clockOpen: false, overriddenAt: null }, now)).toEqual(ends);
    expect(effectiveEnd({ endsAt: ends, clockOpen: true, overriddenAt: now }, now)).toEqual(ends);
  });

  it("tells a roll-on from a real change", () => {
    const before = { startsAt: at("12:00"), endsAt: at("12:30"), clockOpen: true, endPunchId: null, reasonId: null };
    const want = { key: "break:x", kind: "break" as const, staffId: "b1", shopId: "s1", start: at("12:00"), punchId: "x", reasonId: null };
    expect(onlyRolled(before, { ...want, end: at("12:45"), open: true, endPunchId: null })).toBe(true);
    expect(onlyRolled(before, { ...want, end: at("12:12"), open: false, endPunchId: "y" })).toBe(false);
  });
});
