import { describe, expect, it } from "vitest";
import {
  payPeriodFor,
  rangeForPreset,
  resolveSavedRange,
  weekCovers,
  workweekContaining,
} from "./dates";

const TODAY = "2026-10-23";

describe("Chicago preset date math", () => {
  it("resolves every preset for Friday 23 Oct 2026", () => {
    expect(rangeForPreset("current_period", TODAY)).toEqual({ from: "2026-10-18", to: "2026-10-31" });
    expect(rangeForPreset("last_period", TODAY)).toEqual({ from: "2026-10-04", to: "2026-10-17" });
    expect(rangeForPreset("this_week", TODAY)).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(rangeForPreset("last_week", TODAY)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(rangeForPreset("month_to_date", TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-23" });
  });

  it("keeps Monday–Sunday workweeks across the daylight-saving Sunday", () => {
    expect(workweekContaining("2026-11-01")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(payPeriodFor("2026-11-01")).toMatchObject({ start: "2026-11-01", end: "2026-11-14" });
    expect(rangeForPreset("this_week", "2026-03-08")).toEqual({ from: "2026-03-02", to: "2026-03-08" });
  });

  it("remembers a custom range and recomputes named presets from today", () => {
    expect(resolveSavedRange({ preset: "custom", from: "2026-10-16", to: "2026-10-20" }, TODAY)).toEqual({
      preset: "custom",
      from: "2026-10-16",
      to: "2026-10-20",
    });
    expect(resolveSavedRange({ preset: "this_week", from: "2020-01-01", to: "2020-01-02" }, TODAY).from).toBe("2026-10-19");
  });

  it("marks a range that clips a workweek as partial", () => {
    const week = workweekContaining("2026-10-14");
    expect(week).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(weekCovers(week, { from: "2026-10-12", to: "2026-10-18" })).toBe("full");
    expect(weekCovers(week, { from: "2026-10-16", to: "2026-10-20" })).toBe("partial");
  });
});
