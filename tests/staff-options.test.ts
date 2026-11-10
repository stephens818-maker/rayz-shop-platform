import { describe, expect, it } from "vitest";
import { computeDaySlots, isSlotFree, type DayAvailabilityInput } from "@/domain/availability";
import { cleanBookingOptions, effectiveBookingOptions, minutesLabel } from "@/domain/staff-booking";
import { cleanNotificationPrefs, reminderHours, staffAlertText } from "@/domain/staff-notifications";
import { formatTimeOfDay, parseTimeOfDay, stepTime } from "@/lib/time-parse";
import { zonedWallTime } from "@/lib/time";

const SHOP = { bookingWindowDays: 60, minLeadMinutes: 30, cancelCutoffMinutes: 120, bufferMinutes: 0 };

describe("per-barber booking options", () => {
  it("keeps known keys with sane values and drops the rest", () => {
    expect(cleanBookingOptions({ bookingTip: true, maxDaysAhead: "14", minNoticeMinutes: -5, barberIntervalMinutes: 500, junk: 1, trackTime: "yes" })).toEqual({ bookingTip: true, maxDaysAhead: 14 });
    expect(cleanBookingOptions(null)).toEqual({});
  });

  it("this shop only beats all shops, which beats the shop default, and says where each comes from", () => {
    const e = effectiveBookingOptions(SHOP, { minNoticeMinutes: 60, bookingTip: true }, { minNoticeMinutes: 240 });
    expect(e.minNoticeMinutes).toEqual({ value: 240, source: "this_shop" });
    expect(e.bookingTip).toEqual({ value: true, source: "all_shops" });
    expect(e.cancelCutoffMinutes).toEqual({ value: 120, source: "shop" });
    expect(e.bookWithoutPayment).toEqual({ value: true, source: "shop" });
    expect(e.confirmationTip.value).toBe(false);
  });

  it("never lets max days ahead run past the shop's booking window", () => {
    expect(effectiveBookingOptions(SHOP, { maxDaysAhead: 90 }, {}).maxDaysAhead.value).toBe(60);
    expect(effectiveBookingOptions(SHOP, {}, { maxDaysAhead: 21 }).maxDaysAhead.value).toBe(21);
  });

  it("labels limits in words", () => {
    expect([0, 45, 60, 120, 1440, 2880].map(minutesLabel)).toEqual(["none", "45 min", "1 hour", "2 hours", "1 day", "2 days"]);
  });
});

describe("per-barber notifications", () => {
  it("keeps only known events, channels and reminder choices", () => {
    const p = cleanNotificationPrefs({ events: { confirm: ["sms", "fax", "push"], arrived: "sms", other: ["sms"] }, firstHours: 18, secondHours: 7 });
    expect(p).toEqual({ events: { confirm: ["sms", "push"] }, firstHours: 18 });
    expect(reminderHours(p)).toEqual({ firstHours: 18, secondHours: 2 });
    expect(reminderHours(null)).toEqual({ firstHours: 24, secondHours: 2 });
    expect(reminderHours(cleanNotificationPrefs({ firstHours: 0, secondHours: 0 }))).toEqual({ firstHours: 0, secondHours: 0 });
  });

  it("alerts use the client's first name only", () => {
    expect(staffAlertText("arrived", { firstName: "Marcus", when: "Mon 2:30 PM", shopName: "Coralville", services: ["Fade"] })).toBe("Ray'z Coralville: Marcus is here for Mon 2:30 PM (Fade).");
    expect(staffAlertText("cancel", { firstName: null, when: "Tue 9 AM", shopName: "Kimberly" })).toBe("Ray'z Kimberly: A client cancelled Tue 9 AM.");
  });
});

describe("fast time picker", () => {
  it("reads typed times the way a barbershop means them", () => {
    const cases: [string, number | null][] = [
      ["9", 540],
      ["930", 570],
      ["9:30", 570],
      ["5", 17 * 60],
      ["5p", 17 * 60],
      ["5:15 pm", 17 * 60 + 15],
      ["7a", 420],
      ["12am", 0],
      ["12pm", 720],
      ["17:00", 1020],
      ["noon", 720],
      ["midnight", 0],
      ["9:75", null],
      ["13pm", null],
      ["soon", null],
      ["", null],
    ];
    for (const [s, want] of cases) expect(parseTimeOfDay(s), s).toBe(want);
  });

  it("formats and steps a quarter hour at a time, within the day", () => {
    expect(formatTimeOfDay(570)).toBe("9:30 AM");
    expect(formatTimeOfDay(720)).toBe("12 PM");
    expect(formatTimeOfDay(0)).toBe("12 AM");
    expect(stepTime(570, 1)).toBe(585);
    expect(stepTime(577, -1)).toBe(570);
    expect(stepTime(0, -1)).toBe(0);
    expect(stepTime(1425, 1)).toBe(1425);
  });
});

const shopHours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 }));
const input = (over: Partial<DayAvailabilityInput> = {}): DayAvailabilityInput => ({
  date: "2026-10-19",
  shopId: "coralville",
  shopHours,
  staffIds: ["michelle"],
  schedules: shopHours.map((h) => ({ ...h, staffId: "michelle", shopId: "coralville" })),
  blocks: [],
  appointments: [],
  durationMin: 30,
  slotIntervalMin: 15,
  now: new Date("2026-10-19T14:00:00Z"),
  ...over,
});

describe("availability with barber options and days on", () => {
  it("a barber's minimum notice holds their first slot back", () => {
    const slots = computeDaySlots(input({ plans: { michelle: { leadMin: 120 } } }));
    expect(new Date(slots[0].start).toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(isSlotFree(input({ plans: { michelle: { leadMin: 120 } } }), "michelle", zonedWallTime("2026-10-19", 10 * 60).toMillis())).toBe(false);
  });

  it("nothing past a barber's max days ahead", () => {
    expect(computeDaySlots(input({ date: "2026-10-22", plans: { michelle: { windowDays: 3 } } })).length).toBeGreaterThan(0);
    expect(computeDaySlots(input({ date: "2026-10-23", plans: { michelle: { windowDays: 3 } } }))).toEqual([]);
  });

  it("a day on opens a Sunday the shop is normally closed, but not a closed date", () => {
    const sunday = input({ date: "2026-10-25", daysOn: [{ staffId: "michelle", shopId: "coralville", date: "2026-10-25", startMin: 10 * 60, endMin: 12 * 60 }] });
    const slots = computeDaySlots(sunday);
    expect(slots).toHaveLength((120 - 30) / 15 + 1);
    expect(computeDaySlots({ ...sunday, closedDates: ["2026-10-25"] })).toEqual([]);
    expect(computeDaySlots(input({ date: "2026-10-25" }))).toEqual([]);
  });
});
