import { describe, expect, it } from "vitest";
import { cadenceByBarber, cadenceDays, cadenceFromDays, cadenceLabel, cadenceOf, median, visitDays, visitStatus } from "@/domain/visit-cadence";
import { addDays } from "@/lib/time";

/** Visit days `gaps` apart, ending on `last`. */
const days = (last: string, gaps: number[]) => {
  const out = [last];
  for (const g of [...gaps].reverse()) out.unshift(addDays(out[0], -g));
  return out;
};

describe("time between visits", () => {
  it("is the median gap, so one long break or quick touch-up doesn't move it", () => {
    expect(median([])).toBeNull();
    expect(median([21, 28, 90])).toBe(28);
    expect(median([21, 28])).toBe(24.5);
    expect(cadenceDays(days("2026-10-01", [24, 25, 120, 24, 3, 25]))).toBe(24.5);
  });

  it("needs two visit days, and counts two visits on one day once", () => {
    expect(cadenceDays(["2026-10-01"])).toBeNull();
    expect(cadenceDays(["2026-10-01", "2026-10-01"])).toBeNull();
    expect(cadenceDays(["2026-09-10", "2026-10-01", "2026-10-01"])).toBe(21);
    // 10:30 PM Chicago is the next day in UTC; both are the same local day.
    expect(visitDays(["2026-10-02T03:30:00Z", "2026-10-01T15:00:00Z"])).toEqual(["2026-10-01"]);
  });

  it("reads only the last 10 gaps", () => {
    const old = days("2025-01-01", Array(10).fill(60));
    const recent = days("2026-10-01", Array(10).fill(21)).slice(1);
    expect(cadenceDays([...old, ...recent])).toBe(21);
  });

  it("reads in days under two weeks, else half weeks", () => {
    expect(cadenceLabel(1)).toBe("Every day");
    expect(cadenceLabel(10)).toBe("Every 10 days");
    expect(cadenceLabel(13.4)).toBe("Every 13 days");
    expect(cadenceLabel(14)).toBe("Every 2 weeks");
    expect(cadenceLabel(24.5)).toBe("Every 3.5 weeks");
    expect(cadenceLabel(28)).toBe("Every 4 weeks");
    expect(cadenceLabel(45)).toBe("Every 6.5 weeks");
  });

  it("is on track, due from 3 days before, then overdue a week (or a quarter of the gap) after; booked is on track", () => {
    expect(visitStatus(null, 40, false)).toBeNull();
    expect(visitStatus(28, 24, false)).toBe("on_track");
    expect(visitStatus(28, 25, false)).toBe("due");
    expect(visitStatus(28, 35, false)).toBe("due");
    expect(visitStatus(28, 36, false)).toBe("overdue");
    expect(visitStatus(28, 60, true)).toBe("on_track");
    expect(visitStatus(60, 75, false)).toBe("due");
    expect(visitStatus(60, 76, false)).toBe("overdue");
  });

  it("gives the last visit, days since, next expected visit and status", () => {
    expect(cadenceFromDays(days("2026-10-01", [21, 28, 21]), "2026-10-20", false)).toEqual({
      visitDays: 4,
      cadenceDays: 21,
      label: "Every 3 weeks",
      lastVisit: "2026-10-01",
      sinceDays: 19,
      nextExpected: "2026-10-22",
      booked: false,
      status: "due",
    });
    expect(cadenceOf([], "2026-10-20", false)).toMatchObject({ visitDays: 0, cadenceDays: null, lastVisit: null, status: null });
    expect(cadenceOf(["2026-10-01T15:00:00Z"], "2026-10-20", false)).toMatchObject({ visitDays: 1, cadenceDays: null, sinceDays: 19, nextExpected: null, status: null });
  });

  it("per barber only when they've seen more than one", () => {
    const at = (d: string) => `${d}T16:00:00Z`;
    const one = days("2026-10-01", [21, 21]).map((d) => ({ at: at(d), staffId: "a", name: "Ray" }));
    expect(cadenceByBarber(one)).toEqual([]);
    const both = [...one, ...days("2026-08-01", [35]).map((d) => ({ at: at(d), staffId: "b", name: "Makenna" })), { at: at("2026-09-15"), staffId: "c", name: "Jo" }];
    expect(cadenceByBarber(both)).toEqual([
      { staffId: "a", name: "Ray", visitDays: 3, cadenceDays: 21, label: "Every 3 weeks", lastVisit: "2026-10-01" },
      { staffId: "b", name: "Makenna", visitDays: 2, cadenceDays: 35, label: "Every 5 weeks", lastVisit: "2026-08-01" },
      { staffId: "c", name: "Jo", visitDays: 1, cadenceDays: null, label: null, lastVisit: "2026-09-15" },
    ]);
  });
});
