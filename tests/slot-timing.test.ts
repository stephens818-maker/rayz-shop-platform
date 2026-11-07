import { describe, expect, it } from "vitest";
import { BarberWeeklyHours, DayAvailabilityInput, computeDaySlots, gridStarts, isSlotFree, onSlotGrid, squeezeCheck } from "@/domain/availability";
import { bookingPlan, durationProblem, intervalProblem, resolveDuration, resolveInterval, snapDuration, trailingBuffer } from "@/domain/timing";
import { formatTime, zonedWallTime } from "@/lib/time";

const SHOP = "coralville";
const OTHER = "kimberly";
const MON = "2026-10-19";
const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 }));
const week = (staffId: string, shopId = SHOP): BarberWeeklyHours[] => hours.map((h) => ({ ...h, staffId, shopId }));
const at = (hh: number, mm = 0, date = MON) => zonedWallTime(date, hh * 60 + mm).toMillis();
const label = (t: number) => formatTime(t).replace(" ", "").toLowerCase();

function day(over: Partial<DayAvailabilityInput> = {}): DayAvailabilityInput {
  return {
    date: MON,
    shopId: SHOP,
    shopHours: hours,
    staffIds: ["casey"],
    schedules: week("casey"),
    blocks: [],
    appointments: [],
    durationMin: 30,
    slotIntervalMin: 15,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}
const starts = (input: DayAvailabilityInput) => computeDaySlots(input).map((s) => label(s.start));
const plan = (p: Partial<{ durationMin: number; intervalMin: number; beforeMin: number; afterMin: number; gapMin: number }>) => ({ casey: p });

describe("timing: which interval and duration apply", () => {
  it("the most specific interval wins: barber at this shop, then barber, then shop, then brand", () => {
    expect(resolveInterval({ brand: 15 })).toEqual({ minutes: 15, source: "brand" });
    expect(resolveInterval({ brand: 15, shop: 30 })).toEqual({ minutes: 30, source: "shop" });
    expect(resolveInterval({ brand: 15, shop: 30, barber: 20 })).toEqual({ minutes: 20, source: "barber" });
    expect(resolveInterval({ brand: 15, shop: 30, barber: 20, barberAtShop: 25 })).toEqual({ minutes: 25, source: "barber_at_shop" });
    expect(resolveInterval({ brand: 15, shop: null, barber: null, barberAtShop: null }).source).toBe("brand");
  });

  it("a barber who works at two shops can have a different interval at each", () => {
    const casey = { brand: 15, barber: 20 };
    expect(resolveInterval({ ...casey, shop: null, barberAtShop: null }).minutes).toBe(20); // Coralville: their own 20
    expect(resolveInterval({ ...casey, shop: 15, barberAtShop: 30 }).minutes).toBe(30); // Kimberly: 30 just there
  });

  it("the most specific duration wins: barber at this shop, then barber, then the shop's menu, then the service", () => {
    expect(resolveDuration({ service: 30 })).toEqual({ minutes: 30, source: "service" });
    expect(resolveDuration({ service: 30, shop: 35 }).source).toBe("shop");
    expect(resolveDuration({ service: 30, shop: 35, barber: 40 })).toEqual({ minutes: 40, source: "barber" });
    expect(resolveDuration({ service: 30, shop: 35, barber: 40, barberAtShop: 45 })).toEqual({ minutes: 45, source: "barber_at_shop" });
  });

  it("intervals: 15, 20, 30 or any multiple of 5 up to two hours", () => {
    for (const n of [15, 20, 30, 5, 25, 45, 120]) expect(intervalProblem(n)).toBeNull();
    for (const n of [0, 7, 22, 125, 12.5]) expect(intervalProblem(n)).not.toBeNull();
    expect(intervalProblem("20")).not.toBeNull();
  });

  it("durations snap to the service's 5, 10, 15, 20 or 30 minute step", () => {
    expect(durationProblem(40, 5)).toBeNull();
    expect(durationProblem(40, 20)).toBeNull();
    expect(durationProblem(45, 20)).toMatch(/20-minute steps/);
    expect(durationProblem(42, 5)).toMatch(/for example 40/);
    expect(snapDuration(42, 5)).toBe(40);
    expect(snapDuration(43, 5)).toBe(45);
    expect(snapDuration(50, 30)).toBe(60);
    expect(snapDuration(2, 15)).toBe(15);
    expect(durationProblem(0, 5)).not.toBeNull();
  });

  it("add-ons add their minutes and buffers to the main service; the shop's gap comes after the cleanup", () => {
    const p = bookingPlan(
      [
        { kind: "service", durationMin: 40, bufferBeforeMin: 5, bufferAfterMin: 10 },
        { kind: "addon", durationMin: 10, bufferAfterMin: 5 },
        { kind: "addon", durationMin: 5 },
      ],
      { intervalMin: 20, gapMin: 5 },
    );
    expect(p).toEqual({ durationMin: 55, beforeMin: 5, afterMin: 15, gapMin: 5, intervalMin: 20 });
    expect(trailingBuffer(p)).toBe(20);
  });

  it("a service's own booking increment replaces the barber's interval for that booking", () => {
    expect(bookingPlan([{ kind: "service", durationMin: 90, bookingIncrementMin: 30 }], { intervalMin: 20 }).intervalMin).toBe(30);
    expect(bookingPlan([{ kind: "service", durationMin: 30, bookingIncrementMin: null }], { intervalMin: 20 }).intervalMin).toBe(20);
    expect(
      bookingPlan(
        [
          { kind: "service", durationMin: 30 },
          { kind: "addon", durationMin: 10, bookingIncrementMin: 60 },
        ],
        { intervalMin: 20 },
      ).intervalMin,
    ).toBe(20);
  });
});

describe("availability: 15, 20 and 30 minute intervals", () => {
  it("20 minutes: starts at 9:00, 9:20, 9:40 and the last 45-minute cut fits before 6", () => {
    const s = starts(day({ plans: plan({ intervalMin: 20, durationMin: 45 }) }));
    expect(s.slice(0, 4)).toEqual(["9:00am", "9:20am", "9:40am", "10:00am"]);
    expect(s.at(-1)).toBe("5:00pm"); // 5:20 would end 6:05
    expect(s).toHaveLength(25);
  });

  it("15 minutes with a 30-minute cut: every quarter hour to 5:30", () => {
    const s = starts(day({ plans: plan({ intervalMin: 15, durationMin: 30 }) }));
    expect(s.slice(0, 3)).toEqual(["9:00am", "9:15am", "9:30am"]);
    expect(s.at(-1)).toBe("5:30pm");
    expect(s).toHaveLength(35);
  });

  it("30 minutes with a 40-minute fade, a 10-minute add-on and 10 minutes cleanup: the whole hour must fit", () => {
    const p = bookingPlan(
      [
        { kind: "service", durationMin: 40, bufferAfterMin: 10 },
        { kind: "addon", durationMin: 10 },
      ],
      { intervalMin: 30 },
    );
    const s = starts(day({ plans: { casey: p } }));
    expect(s[0]).toBe("9:00am");
    expect(s[1]).toBe("9:30am");
    expect(s.at(-1)).toBe("5:00pm"); // 5:00 + 50 + 10 cleanup = 6:00
    expect(s).toHaveLength(17);
  });

  it("prep time before the service has to fit inside working hours too", () => {
    const s = starts(day({ plans: plan({ intervalMin: 15, durationMin: 30, beforeMin: 10 }) }));
    expect(s[0]).toBe("9:15am"); // 9:00 would need prep from 8:50
  });

  it("the shop's gap between appointments may run past closing; the service's cleanup may not", () => {
    const gap = starts(day({ plans: plan({ intervalMin: 15, durationMin: 30, gapMin: 15 }) }));
    const cleanup = starts(day({ plans: plan({ intervalMin: 15, durationMin: 30, afterMin: 15 }) }));
    expect(gap.at(-1)).toBe("5:30pm");
    expect(cleanup.at(-1)).toBe("5:15pm");
  });

  it("services of other lengths: 25 minutes on a 20 grid, 60 on a 30 grid, 15 on a 15 grid", () => {
    expect(starts(day({ plans: plan({ intervalMin: 20, durationMin: 25 }) })).at(-1)).toBe("5:20pm");
    expect(starts(day({ plans: plan({ intervalMin: 30, durationMin: 60 }) })).at(-1)).toBe("5:00pm");
    expect(starts(day({ plans: plan({ intervalMin: 15, durationMin: 15 }) })).at(-1)).toBe("5:45pm");
  });

  it("a buffer on an existing appointment keeps neighbours off it", () => {
    const appointments = [{ staffId: "casey", shopId: SHOP, startsAt: at(10), endsAt: at(10, 30), status: "booked", bufferBeforeMin: 10, bufferAfterMin: 10 }];
    const s = starts(day({ appointments, plans: plan({ intervalMin: 20, durationMin: 30 }) }));
    expect(s).toContain("9:20am"); // ends 9:50, as the prep begins
    expect(s).not.toContain("9:40am");
    expect(s).not.toContain("10:00am");
    expect(s).not.toContain("10:20am");
    expect(s).toContain("10:40am"); // as the cleanup ends
  });

  it("the new booking's own cleanup can't run into the next appointment", () => {
    const appointments = [{ staffId: "casey", shopId: SHOP, startsAt: at(10), endsAt: at(10, 30), status: "booked", bufferAfterMin: 0 }];
    const s = starts(day({ appointments, plans: plan({ intervalMin: 20, durationMin: 30, afterMin: 10 }) }));
    expect(s).toContain("9:20am"); // 9:20-9:50, cleanup to 10:00
    expect(s).not.toContain("9:40am");
  });

  it("blocks and other appointments are avoided on every grid", () => {
    const blocks = [{ staffId: "casey", shopId: SHOP, startsAt: at(12), endsAt: at(13) }];
    for (const intervalMin of [15, 20, 30]) {
      const s = computeDaySlots(day({ blocks, plans: plan({ intervalMin, durationMin: 40 }) }));
      for (const slot of s) expect(slot.end <= at(12) || slot.start >= at(13)).toBe(true);
    }
  });
});

describe("availability: each barber on their own grid", () => {
  const two = (over: Partial<DayAvailabilityInput> = {}) =>
    day({
      staffIds: ["casey", "delaney"],
      schedules: [...week("casey"), ...week("delaney")],
      plans: { casey: { intervalMin: 20, durationMin: 40 }, delaney: { intervalMin: 15, durationMin: 30 } },
      ...over,
    });

  it("'any barber' merges both grids and says who offers each start and when they'd finish", () => {
    const slots = computeDaySlots(two());
    const find = (t: number) => slots.find((s) => s.start === t)!;
    expect(find(at(9)).staffIds.sort()).toEqual(["casey", "delaney"]);
    expect(find(at(9)).ends).toEqual({ casey: at(9, 40), delaney: at(9, 30) });
    expect(find(at(9)).end).toBe(at(9, 40));
    expect(find(at(9, 15)).staffIds).toEqual(["delaney"]);
    expect(find(at(9, 20)).staffIds).toEqual(["casey"]);
    expect(slots.find((s) => s.start === at(9, 10))).toBeUndefined();
  });

  it("the grid starts where each barber's day starts", () => {
    const schedules = [...week("casey").map((h) => ({ ...h, startMin: 10 * 60 + 10 })), ...week("delaney")];
    const grid = gridStarts(two({ schedules }), "casey").map(label);
    expect(grid.slice(0, 3)).toEqual(["10:10am", "10:30am", "10:50am"]);
    expect(onSlotGrid(two({ schedules }), at(10, 30), "casey")).toBe(true);
    expect(onSlotGrid(two({ schedules }), at(10, 20), "casey")).toBe(false);
    expect(onSlotGrid(two({ schedules }), at(10, 15), "delaney")).toBe(true);
  });

  it("a barber's own duration (Casey's fade takes 40) decides which starts fit", () => {
    const appointments = [{ staffId: "casey", shopId: SHOP, startsAt: at(10), endsAt: at(11), status: "booked" }];
    const s = computeDaySlots(two({ appointments })).filter((x) => x.staffIds.includes("casey"));
    expect(s.map((x) => label(x.start))).toContain("9:20am"); // 9:20 + 40 = 10:00
    expect(s.map((x) => label(x.start))).not.toContain("9:40am");
  });
});

describe("availability: a barber at two shops", () => {
  const schedules = [...week("casey", SHOP).filter((h) => h.weekday === 1), ...week("casey", OTHER).filter((h) => h.weekday === 2)];
  const coralville = day({ schedules, plans: plan({ intervalMin: 20, durationMin: 30 }) });
  const kimberly = day({ schedules, shopId: OTHER, date: "2026-10-20", plans: plan({ intervalMin: 30, durationMin: 30 }) });

  it("each shop offers the barber on that shop's interval for them", () => {
    expect(starts(coralville).slice(0, 3)).toEqual(["9:00am", "9:20am", "9:40am"]);
    expect(starts(kimberly).slice(0, 3)).toEqual(["9:00am", "9:30am", "10:00am"]);
  });

  it("a booking at one shop still blocks them at the other, whatever the grids", () => {
    const sameDay = [
      ...week("casey", SHOP)
        .filter((h) => h.weekday === 1)
        .map((h) => ({ ...h, endMin: 13 * 60 })),
      { staffId: "casey", shopId: OTHER, weekday: 1, startMin: 13 * 60, endMin: 18 * 60 },
    ];
    const appointments = [{ staffId: "casey", shopId: OTHER, startsAt: at(12, 30), endsAt: at(13, 30), status: "booked" }];
    const c = starts(day({ schedules: sameDay, appointments, plans: plan({ intervalMin: 20, durationMin: 30 }) }));
    expect(c).toContain("12:00pm");
    expect(c).not.toContain("12:20pm");
    expect(c.at(-1)).toBe("12:00pm");
  });
});

describe("availability: changing an interval with bookings already made", () => {
  const booked = [{ id: "a1", staffId: "casey", shopId: SHOP, startsAt: at(9, 15), endsAt: at(9, 45), status: "booked" }];

  it("the 9:15 booking made on the old 15-minute grid still holds its chair; new starts follow the 20-minute grid", () => {
    const now20 = day({ appointments: booked, plans: plan({ intervalMin: 20 }) });
    const s = starts(now20);
    expect(s).not.toContain("9:15am"); // not offered any more
    expect(s).not.toContain("9:00am"); // would run into the 9:15 cut
    expect(s).not.toContain("9:20am");
    expect(s).not.toContain("9:40am");
    expect(s[0]).toBe("10:00am");
    expect(onSlotGrid(now20, at(9, 15), "casey")).toBe(false);
  });

  it("moving that booking means picking a start on today's grid", () => {
    const moving = day({ appointments: booked, ignoreAppointmentId: "a1", plans: plan({ intervalMin: 20 }) });
    expect(starts(moving)[0]).toBe("9:00am");
    expect(isSlotFree(moving, "casey", at(9, 15))).toBe(true); // free, but off the grid
    expect(onSlotGrid(moving, at(9, 15), "casey")).toBe(false);
  });
});

describe("availability: DST days on custom grids (America/Chicago)", () => {
  const overnight = [{ weekday: 0, startMin: 0, endMin: 6 * 60 }];
  const sched = overnight.map((h) => ({ ...h, staffId: "casey", shopId: SHOP }));

  it("fall back: 00:00-06:00 is 7 real hours, so a 20-minute grid gets 21 distinct starts and none repeat", () => {
    const input = day({ date: "2026-11-01", shopHours: overnight, schedules: sched, plans: plan({ intervalMin: 20, durationMin: 40 }) });
    const grid = gridStarts(input, "casey");
    expect(grid).toHaveLength(21);
    expect(new Set(grid).size).toBe(21);
    for (let i = 1; i < grid.length; i++) expect(grid[i] - grid[i - 1]).toBe(20 * 60_000);
    expect(computeDaySlots(input)).toHaveLength(20); // the last 40-minute cut starts 5:20 wall time
  });

  it("spring forward: 00:00-06:00 is 5 real hours on a 30-minute grid", () => {
    const input = day({ date: "2026-03-08", shopHours: overnight, schedules: sched, plans: plan({ intervalMin: 30, durationMin: 45 }) });
    expect(gridStarts(input, "casey")).toHaveLength(10);
    expect(computeDaySlots(input)).toHaveLength(9);
    for (const s of computeDaySlots(input)) expect(s.end - s.start).toBe(45 * 60_000);
  });

  it("the Monday after each change starts at 9:00 local on a 20-minute grid", () => {
    const fall = computeDaySlots(day({ date: "2026-11-02", plans: plan({ intervalMin: 20 }) }));
    const spring = computeDaySlots(day({ date: "2026-03-09", plans: plan({ intervalMin: 20 }) }));
    expect(new Date(fall[0].start).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(new Date(fall[1].start).toISOString()).toBe("2026-11-02T15:20:00.000Z");
    expect(new Date(spring[0].start).toISOString()).toBe("2026-03-09T14:00:00.000Z");
    expect(fall).toHaveLength(spring.length);
  });
});

describe("squeeze in", () => {
  const appointments = [{ staffId: "casey", shopId: SHOP, startsAt: at(10), endsAt: at(10, 30), status: "booked", bufferAfterMin: 10 }];
  const input = day({ appointments, plans: plan({ intervalMin: 20, durationMin: 30 }) });

  it("an ordinary open start bends nothing", () => {
    expect(squeezeCheck(input, "casey", at(11))).toEqual({ ok: true, bypasses: [] });
  });

  it("off the grid, into buffer time, or outside working hours is allowed and says what it bent", () => {
    expect(squeezeCheck(input, "casey", at(11, 5))).toEqual({ ok: true, bypasses: ["off_grid"] });
    expect(squeezeCheck(input, "casey", at(10, 30))).toEqual({ ok: true, bypasses: ["off_grid", "buffer"] });
    expect(squeezeCheck(input, "casey", at(10, 40))).toEqual({ ok: true, bypasses: [] });
    expect(squeezeCheck(input, "casey", at(17, 40))).toEqual({ ok: true, bypasses: ["outside_hours"] });
    expect(squeezeCheck(input, "casey", at(8, 30))).toEqual({ ok: true, bypasses: ["off_grid", "outside_hours"] });
  });

  it("never on top of another client's service, time off, or in the past", () => {
    expect(squeezeCheck(input, "casey", at(10, 15))).toMatchObject({ ok: false, reason: expect.stringMatching(/another client/) });
    expect(squeezeCheck(input, "casey", at(9, 45))).toMatchObject({ ok: false });
    const blocks = [{ staffId: "casey", shopId: null, startsAt: at(12), endsAt: at(13) }];
    expect(squeezeCheck({ ...input, blocks }, "casey", at(12, 30))).toMatchObject({ ok: false, reason: expect.stringMatching(/time off/) });
    expect(squeezeCheck({ ...input, now: at(14) }, "casey", at(13))).toMatchObject({ ok: false, reason: expect.stringMatching(/passed/) });
  });
});
