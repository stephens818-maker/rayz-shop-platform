import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { computeDaySlots, isSlotFree, onSlotGrid, type DayAvailabilityInput } from "@/domain/availability";
import { affectedBy, callInHref, clockBlockTitle, lateClockIn, liveDay, type LiveDayInput } from "@/domain/clock-live";
import { DEFAULT_CLOCK_RULES, DEFAULT_SHOP_CLOCK, scheduledOn, shopClockSettings, type PunchLike, type PunchType } from "@/domain/time-clock";
import { endOfLocalDay, startOfLocalDay } from "@/lib/time";

const DAY = "2026-10-19"; // Monday
const at = (hhmm: string, date = DAY) => DateTime.fromISO(`${date}T${hhmm}`, { zone: "America/Chicago" }).toJSDate();
let n = 0;
const p = (type: PunchType, hhmm: string, shopId = "s1"): PunchLike => ({ id: `p${++n}`, staffId: "b1", shopId, type, at: at(hhmm) });
// Scheduled 10:00–18:00 at s1.
const SCHED = scheduledOn(DAY, 1, [{ weekday: 1, startMin: 10 * 60, endMin: 18 * 60 }]);

function day(punches: PunchLike[], now: string, over: Partial<LiveDayInput> = {}) {
  return liveDay({
    staffId: "b1",
    shopId: "s1",
    punches,
    dayStart: startOfLocalDay(DAY),
    dayEnd: endOfLocalDay(DAY),
    scheduled: SCHED,
    now: at(now),
    shop: DEFAULT_SHOP_CLOCK,
    rules: DEFAULT_CLOCK_RULES,
    permitsEarly: false,
    ...over,
  });
}

describe("live clock: status", () => {
  it("is not in yet before any punch, and says how far past the start once it's gone (beyond the grace)", () => {
    expect(day([], "09:30")).toMatchObject({ status: "not_in", overdueMin: null });
    expect(day([], "10:04").overdueMin).toBeNull();
    expect(day([], "10:20").overdueMin).toBe(20);
  });

  it("follows the punches: clocked in, on a break, clocked out", () => {
    const inP = p("in", "09:58");
    expect(day([inP], "11:00")).toMatchObject({ status: "in", since: inP.at, lateMin: null });
    const br = p("break_start", "12:00");
    expect(day([inP, br], "12:10")).toMatchObject({ status: "break", since: br.at });
    const out = p("out", "18:02");
    expect(day([inP, br, p("break_end", "12:30"), out], "18:05")).toMatchObject({ status: "out", since: out.at, earlyOutMin: null });
  });

  it("knows a barber clocked in at another shop", () => {
    expect(day([p("in", "09:55", "s2")], "11:00")).toMatchObject({ status: "in", elsewhereShopId: "s2", shifts: [] });
  });

  it("has no status on other days, but still shows the worked time and flags", () => {
    const d = day([p("in", "10:15"), p("out", "16:00")], "12:00", { now: at("12:00", "2026-10-20") });
    expect(d.status).toBeNull();
    expect(d.shifts).toHaveLength(1);
    expect(d.lateMin).toBe(15);
    expect(d.earlyOutMin).toBe(120);
  });
});

describe("live clock: flags", () => {
  it("flags a late clock-in and an early clock-out against the schedule", () => {
    expect(day([p("in", "10:12")], "11:00").lateMin).toBe(12);
    expect(day([p("in", "10:04")], "11:00").lateMin).toBeNull();
    expect(day([p("in", "10:00"), p("out", "15:00")], "15:05").earlyOutMin).toBe(180);
  });

  it("flags missed punches: a break never ended, a clock-out with no clock-in, a forgotten clock-out", () => {
    expect(day([p("in", "10:00"), p("break_start", "12:00"), p("out", "18:00")], "18:05").missed.map((m) => m.kind)).toEqual(["break_not_ended"]);
    expect(day([p("out", "18:00")], "18:05").missed.map((m) => m.kind)).toEqual(["out_without_in"]);
    expect(day([p("in", "10:00")], "18:30").missed).toEqual([]);
    expect(day([p("in", "10:00")], "19:01").missed.map((m) => m.kind)).toEqual(["forgot_out"]);
  });
});

describe("live clock: opening early", () => {
  it("an early clock-in opens the time before the start only when the shop and the barber both allow it", () => {
    const punches = [p("in", "09:10")];
    const shop = { ...DEFAULT_SHOP_CLOCK, openEarly: true };
    expect(day(punches, "09:20").early).toBeNull();
    expect(day(punches, "09:20", { shop }).early).toBeNull();
    expect(day(punches, "09:20", { permitsEarly: true }).early).toBeNull();
    expect(day(punches, "09:20", { shop, permitsEarly: true }).early).toEqual({ start: at("09:10"), end: at("10:00") });
    expect(day([...punches, p("out", "09:40")], "09:45", { shop, permitsEarly: true }).early).toBeNull();
  });
});

describe("availability with the clock", () => {
  const base = (over: Partial<DayAvailabilityInput> = {}): DayAvailabilityInput => ({
    date: DAY,
    shopId: "s1",
    shopHours: [{ weekday: 1, startMin: 9 * 60, endMin: 18 * 60 }],
    staffIds: ["b1"],
    schedules: [{ staffId: "b1", shopId: "s1", weekday: 1, startMin: 10 * 60, endMin: 18 * 60 }],
    blocks: [],
    appointments: [],
    durationMin: 30,
    slotIntervalMin: 30,
    now: at("09:20"),
    ...over,
  });
  const starts = (i: DayAvailabilityInput) => computeDaySlots(i).map((s) => DateTime.fromMillis(s.start, { zone: "America/Chicago" }).toFormat("HH:mm"));

  it("time an early clock-in opened is bookable on the grid counted back from the scheduled start, so the day's grid doesn't move", () => {
    const without = starts(base());
    expect(without[0]).toBe("10:00");
    const opened = base({ early: [{ staffId: "b1", start: at("09:10"), end: at("10:00") }] });
    const s = starts(opened);
    expect(s[0]).toBe("09:30");
    expect(s.slice(1)).toEqual(without);
    expect(onSlotGrid(opened, at("09:30").getTime(), "b1")).toBe(true);
    expect(onSlotGrid(opened, at("09:40").getTime(), "b1")).toBe(false);
    expect(isSlotFree(opened, "b1", at("09:30").getTime())).toBe(true);
    expect(isSlotFree(base(), "b1", at("09:30").getTime())).toBe(false);
  });

  it("early time never goes outside shop hours", () => {
    const s = starts(base({ now: at("08:05"), early: [{ staffId: "b1", start: at("08:00"), end: at("10:00") }] }));
    expect(s.slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
  });
});

describe("live clock: who to tell", () => {
  const appt = (id: string, from: string, to: string, status = "booked") => ({ id, staffId: "b1", shopId: "s1", startsAt: at(from), endsAt: at(to), status });

  it("finds the clients a clock block sits over, not the one in the chair, at another shop or cancelled", () => {
    const out = { id: "blk1", staffId: "b1", shopId: "s1", startsAt: at("14:00"), endsAt: at("18:00"), kind: "clocked_out" as const };
    const list = [appt("a1", "13:00", "13:45", "completed"), appt("a2", "14:30", "15:00"), appt("a3", "16:00", "16:30", "confirmed"), appt("a4", "15:00", "15:30", "cancelled"), { ...appt("a5", "15:00", "15:30"), shopId: "s2" }];
    expect(affectedBy([out], list).map((a) => [a.id, a.why, a.blockId])).toEqual([
      ["a2", "clocked_out", "blk1"],
      ["a3", "clocked_out", "blk1"],
    ]);
    const br = { id: "blk2", staffId: "b1", shopId: "s1", startsAt: at("12:00"), endsAt: at("12:30"), kind: "break" as const };
    expect(affectedBy([br], [appt("x", "12:15", "12:45"), appt("y", "12:30", "13:00"), appt("z", "11:00", "11:30", "in_service")]).map((a) => a.id)).toEqual(["x"]);
    expect(affectedBy([{ ...br, staffId: "b2" }], [appt("x", "12:15", "12:45")])).toEqual([]);
  });

  it("alerts when a barber isn't clocked in within the shop's minutes of their first client", () => {
    const first = appt("a1", "10:00", "10:30");
    expect(lateClockIn(day([], "09:45"), first, at("09:45"), 10)).toBeNull();
    expect(lateClockIn(day([], "09:50"), first, at("09:50"), 10)).toEqual({ minutesToGo: 10 });
    expect(lateClockIn(day([], "10:05"), first, at("10:05"), 10)).toEqual({ minutesToGo: -5 });
    expect(lateClockIn(day([p("in", "09:52")], "09:55"), first, at("09:55"), 10)).toBeNull();
    expect(lateClockIn(day([p("in", "09:40", "s2")], "09:55"), first, at("09:55"), 10)).toEqual({ minutesToGo: 5 });
    expect(lateClockIn(day([], "09:55"), first, at("09:55"), null)).toBeNull();
    expect(lateClockIn(day([], "09:55"), { ...first, status: "in_service" }, at("09:55"), 10)).toBeNull();
    expect(lateClockIn(day([], "09:55"), null, at("09:55"), 10)).toBeNull();
  });

  it("links to the rebook flow for the block, and says what happened", () => {
    expect(callInHref("blk-1")).toBe("/admin/call-ins?block=blk-1");
    expect(clockBlockTitle("Makenna", "break")).toBe("Makenna is on a break");
    expect(clockBlockTitle("Makenna", "clocked_out")).toBe("Makenna clocked out early");
    expect(clockBlockTitle("Makenna", "not_in")).toBe("Makenna isn't clocked in yet");
  });
});

describe("shop clock settings", () => {
  it("default to blocking breaks and early clock-outs, no \"Not in yet\" block, not opening early, alerting 10 minutes ahead", () => {
    expect(shopClockSettings({})).toMatchObject({ blockOnBreak: true, breakHoldMinutes: 30, blockAfterClockOut: true, notInBlock: false, openEarly: false, lateAlertMinutes: 10 });
    expect(shopClockSettings({ notInBlock: true }).notInBlock).toBe(true);
    expect(shopClockSettings({ openEarly: true, lateAlertMinutes: null, breakHoldMinutes: 45 })).toMatchObject({ openEarly: true, lateAlertMinutes: null, breakHoldMinutes: 45 });
  });
});
