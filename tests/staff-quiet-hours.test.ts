/**
 * ST-I20: off the clock, non-urgent staff texts and app alerts wait for the person's work time.
 */
import { describe, expect, it } from "vitest";
import { QUIET_HOURS_POLICY, URGENT_EVENTS, isUrgent, quietUntil } from "@/domain/staff-notifications";
import { addDays, weekdayOf, zonedWallTime } from "@/lib/time";

const TUE = "2026-11-03";
const at = (date: string, min: number) => zonedWallTime(date, min).toJSDate();
const wed = addDays(TUE, 1);
const WED_SHIFT = [{ weekday: weekdayOf(wed), startMin: 10 * 60, endMin: 18 * 60 }];

describe("quiet hours", () => {
  it("holds a schedule change from the evening until the next shift starts", () => {
    expect(quietUntil("schedule", { now: at(TUE, 20 * 60), work: { state: "off" }, shifts: WED_SHIFT })).toEqual(at(wed, 10 * 60));
  });

  it("sends at once while working, or inside a scheduled shift without clocking in", () => {
    expect(quietUntil("schedule", { now: at(TUE, 20 * 60), work: { state: "working" }, shifts: [] })).toBeNull();
    expect(quietUntil("schedule", { now: at(wed, 11 * 60), work: { state: "off" }, shifts: WED_SHIFT })).toBeNull();
  });

  it("holds until the end of a break", () => {
    const until = at(TUE, 12 * 60 + 30);
    expect(quietUntil("confirm", { now: at(TUE, 12 * 60 + 5), work: { state: "on_break", until }, shifts: WED_SHIFT, startsAt: at(addDays(TUE, 3), 12 * 60) })).toEqual(until);
  });

  it("never holds the urgent ones", () => {
    const now = at(TUE, 22 * 60);
    for (const e of URGENT_EVENTS) expect(quietUntil(e, { now, work: { state: "off" }, shifts: WED_SHIFT })).toBeNull();
    expect(URGENT_EVENTS).toEqual(expect.arrayContaining(["arrived", "late", "waitlist", "clock_out", "meal_break"]));
    expect(QUIET_HOURS_POLICY.heldChannels).toEqual(["sms", "push"]);
  });

  it("an appointment in the next two hours goes now; a held one goes two hours before it at the latest", () => {
    const now = at(TUE, 20 * 60);
    expect(isUrgent("confirm", now, at(TUE, 21 * 60 + 30))).toBe(true);
    expect(quietUntil("confirm", { now, work: { state: "off" }, shifts: WED_SHIFT, startsAt: at(TUE, 21 * 60 + 30) })).toBeNull();
    expect(quietUntil("reschedule", { now, work: { state: "off" }, shifts: WED_SHIFT, startsAt: at(wed, 8 * 60) })).toEqual(at(wed, 6 * 60));
    expect(quietUntil("cancel", { now, work: { state: "off" }, shifts: WED_SHIFT, startsAt: at(addDays(TUE, 5), 15 * 60) })).toEqual(at(wed, 10 * 60));
  });

  it("with no shift this week, waits for 9 AM; shifts and mornings during time off are skipped", () => {
    expect(quietUntil("schedule", { now: at(TUE, 20 * 60), work: { state: "off" }, shifts: [] })).toEqual(at(wed, 9 * 60));
    expect(quietUntil("schedule", { now: at(TUE, 3 * 60), work: { state: "off" }, shifts: [] })).toEqual(at(TUE, 9 * 60));
    const timeOff = [{ startsAt: at(wed, 0), endsAt: at(addDays(wed, 1), 0) }];
    expect(quietUntil("schedule", { now: at(TUE, 20 * 60), work: { state: "off" }, shifts: WED_SHIFT, timeOff })).toEqual(at(addDays(wed, 1), 9 * 60));
    const twoShifts = [...WED_SHIFT, { weekday: weekdayOf(addDays(wed, 2)), startMin: 11 * 60, endMin: 17 * 60 }];
    expect(quietUntil("schedule", { now: at(TUE, 20 * 60), work: { state: "off" }, shifts: twoShifts, timeOff })).toEqual(at(addDays(wed, 2), 11 * 60));
  });

  it("an overnight shift that started yesterday is still work time", () => {
    const late = [{ weekday: weekdayOf(TUE), startMin: 20 * 60, endMin: 26 * 60 }];
    expect(quietUntil("schedule", { now: at(wed, 60), work: { state: "off" }, shifts: late })).toBeNull();
  });
});
