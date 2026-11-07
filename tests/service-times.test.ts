import { describe, expect, it } from "vitest";
import {
  actualMinutes,
  correctionProblem,
  counts,
  median,
  paceOf,
  suggestDuration,
  summarize,
  timingFlags,
  waitMinutes,
  type TimedService,
} from "@/domain/service-times";

const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 15, 0) + min * 60_000);
const t = (o: Partial<TimedService> & { start?: number; finish?: number; arrive?: number }): TimedService => ({
  bookedMin: o.bookedMin ?? 30,
  arrivedAt: o.arrive === undefined ? null : at(o.arrive),
  startedAt: o.start === undefined ? null : at(o.start),
  finishedAt: o.finish === undefined ? null : at(o.finish),
  review: o.review ?? null,
});

describe("actual and wait minutes", () => {
  it("is start to finish, and null until both are there", () => {
    expect(actualMinutes(t({ start: 0, finish: 32 }))).toBe(32);
    expect(actualMinutes(t({ start: 0 }))).toBeNull();
    expect(actualMinutes(t({ finish: 10 }))).toBeNull();
  });

  it("waits are arrival to start, leaving out starts before arrival and waits over 3 hours", () => {
    expect(waitMinutes(t({ arrive: -12, start: 0 }))).toBe(12);
    expect(waitMinutes(t({ arrive: 5, start: 0 }))).toBeNull();
    expect(waitMinutes(t({ arrive: -181, start: 0 }))).toBeNull();
    expect(waitMinutes(t({ arrive: -180, start: 0 }))).toBe(180);
    expect(waitMinutes(t({ start: 0 }))).toBeNull();
  });
});

describe("outlier flags", () => {
  it("flags over 3x and under a quarter of the booked time, not the boundaries", () => {
    expect(timingFlags(t({ bookedMin: 30, start: 0, finish: 91 }))).toEqual(["over_3x"]);
    expect(timingFlags(t({ bookedMin: 30, start: 0, finish: 90 }))).toEqual([]);
    expect(timingFlags(t({ bookedMin: 30, start: 0, finish: 7 }))).toEqual(["under_quarter"]);
    expect(timingFlags(t({ bookedMin: 30, start: 0, finish: 7.5 }))).toEqual([]);
  });

  it("flags a timer left running only once it's past 3x", () => {
    expect(timingFlags(t({ bookedMin: 20, start: 0 }), at(59))).toEqual([]);
    expect(timingFlags(t({ bookedMin: 20, start: 0 }), at(61))).toEqual(["left_running"]);
  });

  it("flagged times are left out unless a manager counts them; left out by a manager never counts", () => {
    const over = t({ bookedMin: 20, start: 0, finish: 100 });
    expect(counts(over)).toBe(false);
    expect(counts({ ...over, review: "include" })).toBe(true);
    const fine = t({ bookedMin: 20, start: 0, finish: 22 });
    expect(counts(fine)).toBe(true);
    expect(counts({ ...fine, review: "exclude" })).toBe(false);
    expect(counts({ ...t({ start: 0 }), review: "include" })).toBe(false);
  });
});

describe("averages, medians and pace", () => {
  it("median takes the middle, or halfway between the two middle values", () => {
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
  });

  it("on time is within 5 minutes either way", () => {
    expect(paceOf(35, 30)).toBe("on_time");
    expect(paceOf(25, 30)).toBe("on_time");
    expect(paceOf(35.5, 30)).toBe("over");
    expect(paceOf(24, 30)).toBe("under");
  });

  it("summarizes average, median, variance, on-time shares and waits", () => {
    const s = summarize([
      { actualMin: 30, bookedMin: 30, waitMin: 10 },
      { actualMin: 40, bookedMin: 30, waitMin: null },
      { actualMin: 20, bookedMin: 30, waitMin: 4 },
      { actualMin: 32, bookedMin: 30, waitMin: 6 },
    ]);
    expect(s.n).toBe(4);
    expect(s.avgMin).toBe(30.5);
    expect(s.medianMin).toBe(31);
    expect(s.avgVarianceMin).toBe(0.5);
    expect(s.medianVarianceMin).toBe(1);
    expect([s.onTime, s.over, s.under]).toEqual([0.5, 0.25, 0.25]);
    expect(s.waitN).toBe(3);
    expect(s.avgWaitMin).toBeCloseTo(20 / 3, 10);
    expect(s.medianWaitMin).toBe(6);
  });

  it("an empty summary has no averages", () => {
    const s = summarize([]);
    expect([s.n, s.avgMin, s.medianMin, s.onTime, s.waitN]).toEqual([0, null, null, null, 0]);
  });
});

describe("duration suggestions", () => {
  const runs = (xs: number[]) => ({ currentMin: 30, actualMin: xs, stepMin: 5 });

  it("suggests the average on the duration step when a barber consistently runs long", () => {
    const s = suggestDuration(runs([38, 40, 41, 39, 42, 37, 40, 43]));
    expect(s).toMatchObject({ minutes: 40, currentMin: 30, n: 8, consistency: 1 });
  });

  it("and when they consistently run short", () => {
    expect(suggestDuration(runs([20, 22, 19, 21, 23, 20, 18, 24]))?.minutes).toBe(20);
  });

  it("needs at least 8 counted services", () => {
    expect(suggestDuration(runs([40, 40, 40, 40, 40, 40, 40]))).toBeNull();
  });

  it("needs the average and median past 5 minutes and 15% of the booked time", () => {
    expect(suggestDuration(runs([34, 34, 34, 34, 34, 34, 34, 34]))).toBeNull();
    expect(suggestDuration({ currentMin: 60, actualMin: Array(8).fill(68), stepMin: 5 })).toBeNull();
    expect(suggestDuration({ currentMin: 60, actualMin: Array(8).fill(70), stepMin: 5 })?.minutes).toBe(70);
  });

  it("needs the median on the same side, so a few very long ones don't move it", () => {
    expect(suggestDuration(runs([28, 29, 30, 31, 29, 28, 70, 75, 80, 72]))).toBeNull();
  });

  it("needs 70% of the services on that side", () => {
    expect(suggestDuration(runs([45, 45, 45, 45, 45, 45, 28, 28, 28, 28]))).toBeNull();
    expect(suggestDuration(runs([45, 45, 45, 45, 45, 45, 45, 28, 28, 28]))?.minutes).toBe(40);
  });

  it("doesn't suggest the time it already has", () => {
    expect(suggestDuration({ currentMin: 30, actualMin: Array(8).fill(36), stepMin: 15 })).toBeNull();
  });
});

describe("corrections", () => {
  const now = at(120);
  it("accepts a sensible correction", () => {
    expect(correctionProblem({ arrivedAt: at(-5), startedAt: at(0), finishedAt: at(30) }, now)).toBeNull();
  });
  it("refuses times in the future, a finish without a start, a finish before the start, and arrival after the start", () => {
    expect(correctionProblem({ arrivedAt: null, startedAt: at(0), finishedAt: at(200) }, now)).toMatch(/future/);
    expect(correctionProblem({ arrivedAt: null, startedAt: null, finishedAt: at(30) }, now)).toMatch(/start time/);
    expect(correctionProblem({ arrivedAt: null, startedAt: at(30), finishedAt: at(30) }, now)).toMatch(/after the start/);
    expect(correctionProblem({ arrivedAt: at(10), startedAt: at(0), finishedAt: at(30) }, now)).toMatch(/Arrival/);
    expect(correctionProblem({ arrivedAt: null, startedAt: at(-2000), finishedAt: at(0) }, now)).toMatch(/longer than a day/);
  });
});
