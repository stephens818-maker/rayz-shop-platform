/**
 * Charles: no military time. Every time reads 12-hour with AM and PM (9:05 AM, 5:30 PM) unless the
 * brand picks 24-hour; payroll hours read decimal (the workbook) or as hours and minutes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY, displaySettings } from "@/domain/display";
import { formatPayHours, payrollHoursStyle, setPayrollHoursStyle } from "@/lib/hours";
import {
  currentTimeFormat,
  formatDateTime,
  formatTime,
  hhmmLabel,
  localStampLabel,
  minutesToLabel,
  setTimeFormat,
  timePattern,
  zonedWallTime,
} from "@/lib/time";
import { compactTimeOfDay, formatTimeOfDay, parseTimeOfDay } from "@/lib/time-parse";

afterEach(() => {
  setTimeFormat("12h");
  setPayrollHoursStyle("decimal");
});

const at = (min: number) => zonedWallTime("2026-10-27", min).toJSDate();

describe("time format", () => {
  it("defaults to 12-hour with AM and PM, never 24-hour", () => {
    expect(currentTimeFormat()).toBe("12h");
    expect(DEFAULT_DISPLAY.timeFormat).toBe("12h");
    expect(timePattern()).toBe("h:mm a");
    expect(formatTime(at(9 * 60 + 5))).toBe("9:05 AM");
    expect(formatTime(at(17 * 60 + 30))).toBe("5:30 PM");
    expect(formatTime(at(0))).toBe("12:00 AM");
    expect(formatTime(at(12 * 60))).toBe("12:00 PM");
    expect(formatDateTime(at(17 * 60 + 30))).toBe("Tue, Oct 27 · 5:30 PM");
    expect(formatDateTime(at(17 * 60 + 30), { date: "MMM d", sep: ", " })).toBe("Oct 27, 5:30 PM");
    expect(minutesToLabel(9 * 60 + 5)).toBe("9:05 AM");
    expect(minutesToLabel(24 * 60)).toBe("12:00 AM");
    expect(formatTimeOfDay(17 * 60 + 30)).toBe("5:30 PM");
    expect(formatTimeOfDay(9 * 60)).toBe("9 AM");
    expect(compactTimeOfDay(17 * 60 + 30)).toBe("5:30p");
    expect(hhmmLabel("21:00")).toBe("9:00 PM");
    expect(localStampLabel("2026-10-27 14:05")).toBe("Oct 27, 2026 2:05 PM");
    expect(localStampLabel("2026-10-27 14:05", "yyyy-MM-dd")).toBe("2026-10-27 2:05 PM");
    expect(localStampLabel("not a time")).toBe("not a time");
  });

  it("reads times in the shop's zone whatever zone the instant came in", () => {
    expect(formatTime("2026-10-27T14:05:00Z")).toBe("9:05 AM");
    expect(formatTime("2026-10-27 22:30:00+00")).toBe("5:30 PM");
  });

  it("the 24-hour setting switches every formatter at once", () => {
    setTimeFormat("24h");
    expect(formatTime(at(17 * 60 + 30))).toBe("17:30");
    expect(formatTime(at(9 * 60 + 5))).toBe("09:05");
    expect(formatDateTime(at(17 * 60 + 30))).toBe("Tue, Oct 27 · 17:30");
    expect(minutesToLabel(17 * 60 + 30)).toBe("17:30");
    expect(formatTimeOfDay(9 * 60)).toBe("09:00");
    expect(compactTimeOfDay(17 * 60 + 30)).toBe("17:30");
    expect(hhmmLabel("21:00")).toBe("21:00");
    expect(localStampLabel("2026-10-27 14:05")).toBe("Oct 27, 2026 14:05");
  });

  it("the time picker still reads both ways of typing, and shows what it read in the brand's format", () => {
    expect(parseTimeOfDay("5:30 PM")).toBe(17 * 60 + 30);
    expect(parseTimeOfDay("17:30")).toBe(17 * 60 + 30);
    expect(parseTimeOfDay("930")).toBe(9 * 60 + 30);
    expect(formatTimeOfDay(parseTimeOfDay("17:30")!)).toBe("5:30 PM");
  });

  it("a stored setting that isn't a known value falls back to 12-hour and decimal", () => {
    expect(displaySettings({ timeFormat: "military", payrollHours: "minutes" })).toEqual({ timeFormat: "12h", payrollHours: "decimal" });
    expect(displaySettings({ timeFormat: "24h", payrollHours: "hm" })).toEqual({ timeFormat: "24h", payrollHours: "hm" });
    expect(displaySettings(null)).toEqual(DEFAULT_DISPLAY);
  });
});

describe("payroll hours", () => {
  it("are decimal by default, like the payroll workbook", () => {
    expect(payrollHoursStyle()).toBe("decimal");
    expect(formatPayHours(79.94)).toBe("79.94");
    expect(formatPayHours(8)).toBe("8.00");
    expect(formatPayHours(1234.5)).toBe("1,234.50");
    expect(formatPayHours(8.5, { unit: true })).toBe("8.50 h");
    expect(formatPayHours(8.5, { unit: "hours" })).toBe("8.50 hours");
  });

  it("or hours and minutes, which carry their own units", () => {
    setPayrollHoursStyle("hm");
    expect(formatPayHours(79 + 56 / 60)).toBe("79h 56m");
    expect(formatPayHours(8)).toBe("8h");
    expect(formatPayHours(8.5, { unit: true })).toBe("8h 30m");
    expect(formatPayHours(0.05)).toBe("0h 03m");
    expect(formatPayHours(-1.25)).toBe("-1h 15m");
    expect(formatPayHours(8.5, { style: "decimal" })).toBe("8.50");
  });
});
