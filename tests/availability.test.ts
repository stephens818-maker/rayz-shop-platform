import { describe, expect, it } from "vitest";
import {
  BarberWeeklyHours,
  DayAvailabilityInput,
  computeDaySlots,
  findScheduleConflicts,
  isSlotFree,
  pickBarber,
  totalDuration,
} from "@/domain/availability";
import { zonedWallTime } from "@/lib/time";

const SHOP = "coralville";
const OTHER = "kimberly";
// Real Coralville hours: Mon-Fri 9-6, Sat 9-4, Sun closed.
const shopHours = [1, 2, 3, 4, 5]
  .map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 }))
  .concat([{ weekday: 6, startMin: 9 * 60, endMin: 16 * 60 }]);

const fullWeek = (staffId: string, shopId = SHOP): BarberWeeklyHours[] =>
  shopHours.map((h) => ({ ...h, staffId, shopId }));

const at = (date: string, hh: number, mm = 0) => zonedWallTime(date, hh * 60 + mm).toMillis();
const iso = (t: number) => new Date(t).toISOString();

function input(over: Partial<DayAvailabilityInput> = {}): DayAvailabilityInput {
  return {
    date: "2026-10-19", // Monday
    shopId: SHOP,
    shopHours,
    staffIds: ["michelle"],
    schedules: fullWeek("michelle"),
    blocks: [],
    appointments: [],
    durationMin: 30,
    slotIntervalMin: 15,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("availability: basics", () => {
  it("produces slots inside shop and barber hours, in Chicago time", () => {
    const slots = computeDaySlots(input());
    expect(iso(slots[0].start)).toBe("2026-10-19T14:00:00.000Z"); // 9:00 CDT
    expect(iso(slots[slots.length - 1].start)).toBe("2026-10-19T22:30:00.000Z"); // 5:30 PM CDT, ends 6:00
    expect(slots).toHaveLength((9 * 60 - 30) / 15 + 1);
  });

  it("returns nothing on Sundays (all shops closed)", () => {
    expect(computeDaySlots(input({ date: "2026-10-18" }))).toEqual([]);
  });

  it("returns nothing for a shop with zero barbers (Dubuque)", () => {
    expect(computeDaySlots(input({ staffIds: [], schedules: [] }))).toEqual([]);
  });

  it("respects closed dates (holidays)", () => {
    expect(computeDaySlots(input({ closedDates: ["2026-10-19"] }))).toEqual([]);
  });

  it("respects a barber's shorter shift", () => {
    const schedules = [{ staffId: "michelle", shopId: SHOP, weekday: 1, startMin: 12 * 60, endMin: 15 * 60 }];
    const slots = computeDaySlots(input({ schedules }));
    expect(iso(slots[0].start)).toBe(iso(at("2026-10-19", 12)));
    expect(iso(slots[slots.length - 1].start)).toBe(iso(at("2026-10-19", 14, 30)));
  });

  it("never offers slots in the past or inside the lead time", () => {
    const now = at("2026-10-19", 13, 5);
    const slots = computeDaySlots(input({ now, minLeadMin: 30 }));
    expect(iso(slots[0].start)).toBe(iso(at("2026-10-19", 13, 45)));
  });
});

describe("availability: overlaps", () => {
  const appt = (startH: number, startM: number, mins: number, status = "booked", extra: object = {}) => ({
    staffId: "michelle",
    shopId: SHOP,
    startsAt: at("2026-10-19", startH, startM),
    endsAt: at("2026-10-19", startH, startM) + mins * 60_000,
    status,
    ...extra,
  });

  it("removes every slot that would overlap an existing appointment", () => {
    const slots = computeDaySlots(input({ appointments: [appt(10, 0, 40)] }));
    const starts = slots.map((s) => s.start);
    expect(starts).toContain(at("2026-10-19", 9, 30)); // 9:30-10:00 touches but doesn't overlap
    expect(starts).not.toContain(at("2026-10-19", 9, 45));
    expect(starts).not.toContain(at("2026-10-19", 10, 15));
    expect(starts).not.toContain(at("2026-10-19", 10, 30));
    expect(starts).toContain(at("2026-10-19", 10, 45)); // after 10:40 on the 15-min grid
  });

  it("cancelled and no-show appointments free the chair", () => {
    const slots = computeDaySlots(input({ appointments: [appt(10, 0, 40, "cancelled"), appt(11, 0, 30, "no_show")] }));
    expect(slots.map((s) => s.start)).toContain(at("2026-10-19", 10, 0));
    expect(slots.map((s) => s.start)).toContain(at("2026-10-19", 11, 0));
  });

  it("ignores the appointment being rescheduled", () => {
    const a = appt(10, 0, 30, "booked", { id: "a1" });
    expect(isSlotFree(input({ appointments: [a] }), "michelle", at("2026-10-19", 10, 0))).toBe(false);
    expect(isSlotFree(input({ appointments: [a], ignoreAppointmentId: "a1" }), "michelle", at("2026-10-19", 10, 0))).toBe(true);
  });

  it("applies a buffer between appointments when configured", () => {
    const slots = computeDaySlots(input({ appointments: [appt(10, 0, 30)], bufferMin: 15 }));
    const starts = slots.map((s) => s.start);
    expect(starts).not.toContain(at("2026-10-19", 9, 30)); // would end 10:00, inside 15-min buffer
    expect(starts).not.toContain(at("2026-10-19", 10, 30));
    expect(starts).toContain(at("2026-10-19", 10, 45));
  });
});

describe("availability: add-ons", () => {
  it("adds add-on minutes to the chair time", () => {
    expect(totalDuration([{ durationMin: 20 }, { durationMin: 10 }, { durationMin: 5 }])).toBe(35);
  });

  it("a slot that fits the base service can be lost once add-ons are included", () => {
    const appointments = [
      { staffId: "michelle", shopId: SHOP, startsAt: at("2026-10-19", 11), endsAt: at("2026-10-19", 11, 30), status: "booked" },
    ];
    const base = computeDaySlots(input({ durationMin: 20, appointments }));
    const withAddon = computeDaySlots(input({ durationMin: 20 + 10, appointments }));
    expect(base.map((s) => s.start)).toContain(at("2026-10-19", 10, 30));
    expect(withAddon.map((s) => s.start)).not.toContain(at("2026-10-19", 10, 45));
    expect(withAddon.map((s) => s.start)).toContain(at("2026-10-19", 10, 30));
    // Last slot of the day moves earlier, too.
    expect(withAddon[withAddon.length - 1].start).toBe(at("2026-10-19", 17, 30));
    expect(base[base.length - 1].start).toBe(at("2026-10-19", 17, 30));
    expect(computeDaySlots(input({ durationMin: 45 })).at(-1)!.start).toBe(at("2026-10-19", 17, 15));
  });
});

describe("availability: time blocks", () => {
  it("blocks out time (e.g. lunch) with a reason", () => {
    const blocks = [{ staffId: "michelle", shopId: SHOP, startsAt: at("2026-10-19", 12), endsAt: at("2026-10-19", 13) }];
    const starts = computeDaySlots(input({ blocks })).map((s) => s.start);
    expect(starts).not.toContain(at("2026-10-19", 12));
    expect(starts).not.toContain(at("2026-10-19", 11, 45));
    expect(starts).toContain(at("2026-10-19", 13));
  });

  it("a block for another shop does not apply here; a brand-wide day off does", () => {
    const otherShopBlock = [{ staffId: "michelle", shopId: OTHER, startsAt: at("2026-10-19", 9), endsAt: at("2026-10-19", 18) }];
    expect(computeDaySlots(input({ blocks: otherShopBlock })).length).toBeGreaterThan(0);
    const dayOff = [{ staffId: "michelle", shopId: null, startsAt: at("2026-10-19", 0), endsAt: at("2026-10-20", 0) }];
    expect(computeDaySlots(input({ blocks: dayOff }))).toEqual([]);
  });
});

describe("availability: multi-shop barbers", () => {
  const casey = [...fullWeek("casey", SHOP), ...fullWeek("casey", OTHER)].filter(
    (s) => (s.shopId === SHOP && s.weekday === 1) || (s.shopId === OTHER && s.weekday === 2),
  );

  it("a booking at another shop blocks the same barber here (no cross-shop double booking)", () => {
    const appointments = [
      { staffId: "casey", shopId: OTHER, startsAt: at("2026-10-19", 14), endsAt: at("2026-10-19", 15), status: "booked" },
    ];
    const slots = computeDaySlots(input({ staffIds: ["casey"], schedules: casey, appointments }));
    const starts = slots.map((s) => s.start);
    expect(starts).not.toContain(at("2026-10-19", 14));
    expect(starts).not.toContain(at("2026-10-19", 14, 30));
    expect(starts).toContain(at("2026-10-19", 15));
  });

  it("only offers the barber at the shop they're scheduled at that day", () => {
    expect(computeDaySlots(input({ staffIds: ["casey"], schedules: casey, date: "2026-10-19" })).length).toBeGreaterThan(0);
    expect(computeDaySlots(input({ staffIds: ["casey"], schedules: casey, date: "2026-10-20" }))).toEqual([]);
    expect(
      computeDaySlots(input({ staffIds: ["casey"], schedules: casey, date: "2026-10-20", shopId: OTHER })).length,
    ).toBeGreaterThan(0);
  });

  it("refuses weekly hours that overlap across shops", () => {
    const rows = [
      { staffId: "casey", shopId: SHOP, weekday: 1, startMin: 540, endMin: 780 },
      { staffId: "casey", shopId: OTHER, weekday: 1, startMin: 720, endMin: 1080 },
      { staffId: "casey", shopId: OTHER, weekday: 2, startMin: 540, endMin: 1080 },
    ];
    expect(findScheduleConflicts(rows)).toHaveLength(1);
    expect(findScheduleConflicts(rows.slice(1))).toHaveLength(0);
  });

  it("'any barber' merges barbers and picks the least-loaded one", () => {
    const schedules = [...fullWeek("a"), ...fullWeek("b")];
    const appointments = [
      { staffId: "a", shopId: SHOP, startsAt: at("2026-10-19", 9), endsAt: at("2026-10-19", 10), status: "booked" },
    ];
    const slots = computeDaySlots(input({ staffIds: ["a", "b"], schedules, appointments }));
    const nine = slots.find((s) => s.start === at("2026-10-19", 9))!;
    expect(nine.staffIds).toEqual(["b"]);
    const noon = slots.find((s) => s.start === at("2026-10-19", 12))!;
    expect(noon.staffIds.sort()).toEqual(["a", "b"]);
    expect(pickBarber(noon.staffIds, appointments, "2026-10-19")).toBe("b");
    expect(pickBarber([], appointments, "2026-10-19")).toBeNull();
  });
});

describe("availability: DST weekends (America/Chicago)", () => {
  it("fall back: Saturday is CDT (UTC-5), Monday is CST (UTC-6)", () => {
    const sat = computeDaySlots(input({ date: "2026-10-31" }));
    const mon = computeDaySlots(input({ date: "2026-11-02" }));
    expect(iso(sat[0].start)).toBe("2026-10-31T14:00:00.000Z");
    expect(iso(mon[0].start)).toBe("2026-11-02T15:00:00.000Z");
    expect(sat).toHaveLength((7 * 60 - 30) / 15 + 1);
    expect(mon).toHaveLength((9 * 60 - 30) / 15 + 1);
  });

  it("spring forward: Saturday is CST, Monday is CDT", () => {
    expect(iso(computeDaySlots(input({ date: "2026-03-07" }))[0].start)).toBe("2026-03-07T15:00:00.000Z");
    expect(iso(computeDaySlots(input({ date: "2026-03-09" }))[0].start)).toBe("2026-03-09T14:00:00.000Z");
  });

  it("Sunday transition days stay closed with real hours", () => {
    expect(computeDaySlots(input({ date: "2026-11-01" }))).toEqual([]);
    expect(computeDaySlots(input({ date: "2026-03-08" }))).toEqual([]);
  });

  it("a shop open across the transition gets the real number of hours (25h / 23h day)", () => {
    const overnight = [{ weekday: 0, startMin: 0, endMin: 6 * 60 }];
    const sched = overnight.map((h) => ({ ...h, staffId: "michelle", shopId: SHOP }));
    const base = { shopHours: overnight, schedules: sched, durationMin: 60, slotIntervalMin: 60 };
    const fall = computeDaySlots(input({ ...base, date: "2026-11-01" }));
    const spring = computeDaySlots(input({ ...base, date: "2026-03-08" }));
    expect(fall).toHaveLength(7); // 00:00–06:00 wall clock is 7 real hours
    expect(spring).toHaveLength(5); // and 5 real hours in spring
    expect(new Set(fall.map((s) => s.start)).size).toBe(7);
    // Every slot is exactly 60 real minutes.
    for (const s of [...fall, ...spring]) expect(s.end - s.start).toBe(3_600_000);
  });
});
