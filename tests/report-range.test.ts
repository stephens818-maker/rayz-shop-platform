import { describe, expect, it } from "vitest";
import {
  PRESETS,
  RANGE_TIME_ZONE,
  STANDARD_PRESETS,
  STANDARD_PRESET_IDS,
  parsePayPeriodNumber,
  payPeriodNumberPreset,
  presetRange,
  priorPeriod,
  rangeHeading,
  rangeText,
} from "@/domain/report-range";
import { DEFAULT_BRAND_CALENDAR, periodByIndex, periodByNumber, type PayCalendar } from "@/domain/payroll/calendar";

const DUBUQUE: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 1, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };
const RUNNING: PayCalendar = { ...DEFAULT_BRAND_CALENDAR, anchorNumber: 140, numberResetsYearly: false };
const WED = "2026-10-28";

describe("the standard date ranges", () => {
  it("every report offers the same ranges, in this order", () => {
    expect(STANDARD_PRESETS.map((p) => p.label)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "Last week",
      "This pay period",
      "Last pay period",
      "Month to date",
      "Last month",
      "Quarter to date",
      "Year to date",
    ]);
    expect(STANDARD_PRESETS.map((p) => p.id)).toEqual([...STANDARD_PRESET_IDS]);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(RANGE_TIME_ZONE).toBe("America/Chicago");
  });

  it("each preset's dates on a Wednesday, with weeks from Sunday", () => {
    const at = (id: string, today = WED) => presetRange(id, today, DEFAULT_BRAND_CALENDAR);
    expect(at("today")).toEqual({ from: WED, to: WED });
    expect(at("yesterday")).toEqual({ from: "2026-10-27", to: "2026-10-27" });
    expect(at("week")).toEqual({ from: "2026-10-25", to: WED });
    expect(at("lastweek")).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(at("payperiod")).toEqual({ from: "2026-10-18", to: WED });
    expect(at("lastpayperiod")).toEqual({ from: "2026-10-04", to: "2026-10-17" });
    expect(at("month")).toEqual({ from: "2026-10-01", to: WED });
    expect(at("lastmonth")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(at("quarter")).toEqual({ from: "2026-10-01", to: WED });
    expect(at("ytd")).toEqual({ from: "2026-01-01", to: WED });
  });

  it("last week is the whole Sunday-to-Saturday week before this one, also on a Sunday and a Saturday", () => {
    expect(presetRange("lastweek", "2026-10-25")).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(presetRange("lastweek", "2026-10-31")).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(presetRange("lastweek", "2027-01-02")).toEqual({ from: "2026-12-20", to: "2026-12-26" });
  });

  it("month and quarter to date compare with the whole month and quarter before", () => {
    expect(priorPeriod("2026-10-01", WED, "month")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(priorPeriod("2026-10-01", WED, "quarter")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(priorPeriod("2026-10-18", "2026-10-24", "lastweek")).toEqual({ from: "2026-10-11", to: "2026-10-17" });
  });
});

describe("range text in headers, exports and emails", () => {
  it("one day, within a month, across months and across years", () => {
    expect(rangeText("2026-10-04", "2026-10-04")).toBe("Oct 4, 2026");
    expect(rangeText("2026-10-04", "2026-10-17")).toBe("Oct 4 – 17, 2026");
    expect(rangeText("2026-10-26", "2026-11-08")).toBe("Oct 26 – Nov 8, 2026");
    expect(rangeText("2026-12-27", "2027-01-09")).toBe("Dec 27, 2026 – Jan 9, 2027");
  });

  it("leads with the range's name, or the dates alone for custom dates", () => {
    expect(rangeHeading({ from: "2026-10-04", to: "2026-10-17", label: "Last pay period" })).toBe("Last pay period: Oct 4 – 17, 2026");
    expect(rangeHeading({ from: "2026-10-04", to: "2026-10-09", label: null })).toBe("Oct 4 – 9, 2026");
  });
});

describe("a pay period picked by number", () => {
  const group = "6f1c2a8e-1d2b-4c3d-9e4f-5a6b7c8d9e0f";

  it("is named by pay group, check year and number, and nothing else parses", () => {
    const id = payPeriodNumberPreset(group, 2026, 22);
    expect(id).toBe(`ppn:${group}:2026:22`);
    expect(parsePayPeriodNumber(id)).toEqual({ payGroupId: group, year: 2026, number: 22 });
    for (const bad of [null, "", "pp:last", `ppn:${group}:26:22`, `ppn:nope:2026:22`, `ppn:${group}:2026:22222`, `${id};drop`]) expect(parsePayPeriodNumber(bad), String(bad)).toBeNull();
  });

  it("finds the brand's period 22 of 2026 (Oct 4 – 17) and the numbers around New Year's", () => {
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2026, 22)).toMatchObject({ start: "2026-10-04", end: "2026-10-17", checkDate: "2026-10-23", number: 22 });
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2026, 26)).toMatchObject({ checkDate: "2026-12-18" });
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2027, 1)).toMatchObject({ checkDate: "2027-01-01", start: "2026-12-13" });
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2026, 1)).toMatchObject({ number: 1, checkDate: "2026-01-02" });
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2026, 27)).toBeNull();
    expect(periodByNumber(DEFAULT_BRAND_CALENDAR, 2026, 0)).toBeNull();
  });

  it("Dubuque's own numbering gives other dates for the same number", () => {
    expect(periodByNumber(DUBUQUE, 2026, 1)).toMatchObject({ start: "2026-10-04", end: "2026-10-17" });
    expect(periodByNumber(DUBUQUE, 2026, 2)).toMatchObject({ start: "2026-10-18" });
    expect(periodByNumber(DUBUQUE, 2026, 22)?.start).not.toBe("2026-10-04");
  });

  it("round-trips every period for two years either side, numbering yearly or running on", () => {
    for (const c of [DEFAULT_BRAND_CALENDAR, DUBUQUE, RUNNING])
      for (let i = -60; i <= 60; i++) {
        const p = periodByIndex(c, i);
        if (p.number < 1) continue;
        const year = c.numberResetsYearly ? Number(p.checkDate.slice(0, 4)) : 2026;
        expect(periodByNumber(c, year, p.number)?.index, `${c.anchorNumber} #${i}`).toBe(i);
      }
  });
});
