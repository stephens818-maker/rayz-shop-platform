import { describe, expect, it } from "vitest";
import { DateTime, Settings } from "luxon";
import { payPeriodByIndex, payPeriodFor, payPeriodsBetween } from "@/domain/payroll";
import { DEFAULT_BRAND_CALENDAR, periodByIndex, periodDatesProblem, periodOf, periodStarting, calendarProblem, workweeksOf, type PayCalendar } from "@/domain/payroll/calendar";
import { existingWallTime, formatTime, weekdayOf } from "@/lib/time";
import { dailyHours, largestRemainder, overtimeSlices, sliceKey, splitByLocalDay, weekStartOf, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import {
  DEFAULT_PAYROLL_SETTINGS,
  EXPORT_COLUMNS,
  earningHeaders,
  inNameOrder,
  locationSummary,
  assemble,
  anomalies,
  computeLine,
  employeePay,
  exportRows,
  ftStatus,
  payrollSettings,
  reconcile,
  roundHalfUp2,
  totalsOf,
  type ExtraFrom,
  type LineInput,
} from "@/domain/payroll/calc";

const at = (local: string) => DateTime.fromISO(local, { zone: "America/Chicago" }).toJSDate();
const entry = (shopId: string, start: string, end: string, kind: TimeEntry["kind"] = "worked", staffId = "b1"): TimeEntry => ({ staffId, shopId, kind, startsAt: at(start), endsAt: at(end) });
/** n days of `hours` each, from a local date, 9am on. */
const days = (shopId: string, from: string, n: number, hours: number, kind: TimeEntry["kind"] = "worked", staffId = "b1") =>
  Array.from({ length: n }, (_, i) => {
    const d = DateTime.fromISO(from, { zone: "America/Chicago" }).plus({ days: i }).set({ hour: 9 });
    return { staffId, shopId, kind, startsAt: d.toJSDate(), endsAt: d.plus({ minutes: hours * 60 }).toJSDate() };
  });

const MAIN: PayCalendar = { anchorStart: "2026-10-18", anchorNumber: 23, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };
const DUBUQUE: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 1, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };

const opts = (over: Partial<OtOptions> = {}): OtOptions => ({
  thresholdCenti: 4000,
  trainingCountsTowardOt: false,
  entityOf: () => "Ray'z Inc.",
  periodOf: (_shop, date) => periodOf(MAIN, date).start,
  ...over,
});

const otBy = (slices: ReturnType<typeof overtimeSlices>) => Object.fromEntries(slices.map((s) => [`${s.shopId}@${s.periodStart}`, s.ot]));

describe("pay calendars are per pay group", () => {
  it("main shops: period 23 is 10/18–10/31, checks Friday 11/6; the next is 11/1–11/14, checks 11/20", () => {
    expect(periodOf(MAIN, "2026-10-23")).toMatchObject({ number: 23, start: "2026-10-18", end: "2026-10-31", checkDate: "2026-11-06" });
    expect(periodOf(MAIN, "2026-11-01")).toMatchObject({ number: 24, start: "2026-11-01", end: "2026-11-14", checkDate: "2026-11-20" });
    expect(DateTime.fromISO("2026-11-20").weekday).toBe(5);
  });

  it("Dubuque runs its own calendar: period 01 was 10/4–10/17, check 10/23", () => {
    expect(periodOf(DUBUQUE, "2026-10-10")).toMatchObject({ number: 1, start: "2026-10-04", end: "2026-10-17", checkDate: "2026-10-23" });
    expect(periodOf(DUBUQUE, "2026-10-23")).toMatchObject({ number: 2, start: "2026-10-18" });
  });

  it("numbers restart at 1 with the first check of a new year", () => {
    expect(periodByIndex(MAIN, 3)).toMatchObject({ number: 26, checkDate: "2026-12-18" });
    expect(periodByIndex(MAIN, 4)).toMatchObject({ number: 1, checkDate: "2027-01-01" });
    expect(periodByIndex(MAIN, 5)).toMatchObject({ number: 2 });
  });

  it("only real period starts open a run; weekly and bi-weekly calendars start on Sundays (I2)", () => {
    expect(periodStarting(MAIN, "2026-10-18")?.number).toBe(23);
    expect(periodStarting(MAIN, "2026-10-19")).toBeNull();
    expect(calendarProblem({ ...MAIN, anchorStart: "2026-10-19" })).toMatch(/Sunday/);
    expect(calendarProblem({ ...MAIN, periodDays: 7, anchorStart: "2026-10-21" })).toMatch(/workweek overtime is counted on/);
    expect(calendarProblem({ ...MAIN, periodDays: 7, anchorStart: "2026-10-25" })).toBeNull();
    expect(calendarProblem({ ...MAIN, periodDays: 7, anchorStart: "2026-02-30" })).toMatch(/first day/);
    expect(periodDatesProblem({ end: "2026-10-17", submitBy: "2026-10-21", checkDate: "2026-10-32" })).toMatch(/both dates/);
    expect(calendarProblem(MAIN)).toBeNull();
  });
});

describe("iSolved's default pay calendar (bi-weekly Sun–Sat, anchored on 10/4/2026)", () => {
  const D = DEFAULT_BRAND_CALENDAR;

  it("period 21 was 9/20–10/3 with a 10/9 check; period 22 is 10/4–10/17, due Wednesday 10/21, check Friday 10/23", () => {
    expect(D).toMatchObject({ anchorStart: "2026-10-04", anchorNumber: 22, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4 });
    expect(periodOf(D, "2026-10-01")).toMatchObject({ number: 21, start: "2026-09-20", end: "2026-10-03", checkDate: "2026-10-09", datesMoved: false });
    const p22 = periodOf(D, "2026-10-10");
    expect(p22).toMatchObject({ number: 22, start: "2026-10-04", end: "2026-10-17", submitBy: "2026-10-21", checkDate: "2026-10-23" });
    expect(weekdayOf(p22.start)).toBe(0);
    expect(weekdayOf(p22.end)).toBe(6);
    expect(weekdayOf(p22.submitBy)).toBe(3);
    expect(weekdayOf(p22.checkDate)).toBe(5);
    expect(calendarProblem(D)).toBeNull();
  });

  it("lands on the same periods, numbers and checks as the calendar it replaces, for a year either way", () => {
    for (let i = -26; i <= 26; i++) {
      const a = periodByIndex(D, i + 1);
      const b = periodByIndex(MAIN, i);
      expect([a.start, a.end, a.number, a.checkDate, a.submitBy]).toEqual([b.start, b.end, b.number, b.checkDate, b.submitBy]);
    }
  });

  it("the OT workweek starts Sunday, so each period is exactly two whole workweeks", () => {
    const p = periodOf(D, "2026-10-10");
    expect(workweeksOf(p)).toEqual(["2026-10-04", "2026-10-11"]);
    expect(weekStartOf("2026-10-17")).toBe("2026-10-11");
    expect(weekStartOf("2026-10-18")).toBe("2026-10-18");
  });

  it("the submit-by offset is configurable, between the period's end and its check date", () => {
    expect(periodOf({ ...D, submitOffsetDays: 3 }, "2026-10-10").submitBy).toBe("2026-10-20");
    expect(calendarProblem({ ...D, submitOffsetDays: 0 })).toBeNull();
    expect(calendarProblem({ ...D, submitOffsetDays: 6 })).toBeNull();
    expect(calendarProblem({ ...D, submitOffsetDays: 7 })).toMatch(/no later than the check date/);
    expect(calendarProblem({ ...D, submitOffsetDays: -1 })).toMatch(/due in iSolved/);
    expect(calendarProblem({ ...D, submitOffsetDays: 1.5 })).toMatch(/due in iSolved/);
  });

  it("saved settings without a submit-by offset get Wednesday (4 days), never after the check", () => {
    expect(payrollSettings({}).calendar).toEqual(D);
    const { submitOffsetDays: _, ...old } = MAIN;
    expect(payrollSettings({ calendar: old }).calendar).toMatchObject({ anchorStart: "2026-10-18", submitOffsetDays: 4 });
    expect(payrollSettings({ calendar: { ...old, checkOffsetDays: 2 } }).calendar).toMatchObject({ checkOffsetDays: 2, submitOffsetDays: 2 });
    expect(payrollSettings({ calendar: { ...MAIN, submitOffsetDays: 9 } }).calendar).toEqual(D);
  });

  it("a period's stored dates replace the offsets (a holiday moved the check) and are marked moved", () => {
    const c: PayCalendar = { ...D, dates: { "2026-10-04": { checkDate: "2026-10-22", submitBy: "2026-10-20" } } };
    expect(periodOf(c, "2026-10-10")).toMatchObject({ number: 22, checkDate: "2026-10-22", submitBy: "2026-10-20", datesMoved: true });
    expect(periodOf(c, "2026-10-20")).toMatchObject({ number: 23, checkDate: "2026-11-06", datesMoved: false });
    const same: PayCalendar = { ...D, dates: { "2026-10-04": { checkDate: "2026-10-23", submitBy: "2026-10-21" } } };
    expect(periodOf(same, "2026-10-10").datesMoved).toBe(false);
  });

  it("numbers follow the check date actually paid: a New Year's Day check moved into December ends the old year", () => {
    expect(periodOf(D, "2026-12-20")).toMatchObject({ start: "2026-12-13", end: "2026-12-26", checkDate: "2027-01-01", number: 1 });
    const c: PayCalendar = { ...D, dates: { "2026-12-13": { checkDate: "2026-12-31", submitBy: "2026-12-29" } } };
    expect(periodOf(c, "2026-12-20")).toMatchObject({ checkDate: "2026-12-31", number: 27, datesMoved: true });
    expect(periodOf(c, "2027-01-01")).toMatchObject({ start: "2026-12-27", checkDate: "2027-01-15", number: 1 });
    expect(periodOf(c, "2027-01-10")).toMatchObject({ number: 2 });
  });

  it("a period's own dates: due once it has ended, no later than its check, the check within 31 days", () => {
    const end = "2026-10-17";
    expect(periodDatesProblem({ end, submitBy: "2026-10-21", checkDate: "2026-10-23" })).toBeNull();
    expect(periodDatesProblem({ end, submitBy: "2026-10-17", checkDate: "2026-10-17" })).toBeNull();
    expect(periodDatesProblem({ end, submitBy: "2026-10-16", checkDate: "2026-10-23" })).toMatch(/before the period's last day/);
    expect(periodDatesProblem({ end, submitBy: "2026-10-22", checkDate: "2026-10-21" })).toMatch(/before the submit-by date/);
    expect(periodDatesProblem({ end, submitBy: "2026-10-21", checkDate: "2026-11-18" })).toMatch(/31 days/);
    expect(periodDatesProblem({ end, submitBy: "", checkDate: "2026-10-23" })).toMatch(/both dates/);
  });
});

describe("cross-shop overtime (C4)", () => {
  it("25h at shop A + 20h at shop B in one week = 5 OT hours, split 25:20", () => {
    const e = [...days("A", "2026-10-18", 5, 5), ...days("B", "2026-10-23", 2, 10)];
    const slices = overtimeSlices(dailyHours(e), opts());
    expect(slices.reduce((a, s) => a + s.worked, 0)).toBe(4500);
    // 5h × 25/45 = 2.777… and 5h × 20/45 = 2.222…, largest remainder to hundredths
    expect(otBy(slices)).toEqual({ "A@2026-10-18": 278, "B@2026-10-18": 222 });
    expect(slices.reduce((a, s) => a + s.ot, 0)).toBe(500);
  });

  it("no OT at exactly 40, and weeks don't pool: 40 + 40 in a bi-weekly period is 0 OT", () => {
    const e = [...days("A", "2026-10-18", 5, 8), ...days("A", "2026-10-25", 5, 8)];
    expect(overtimeSlices(dailyHours(e), opts()).every((s) => s.ot === 0)).toBe(true);
  });

  it("hours only add up within one legal entity", () => {
    const e = [...days("A", "2026-10-18", 5, 5), ...days("B", "2026-10-23", 2, 10)];
    const slices = overtimeSlices(dailyHours(e), opts({ entityOf: (s) => (s === "A" ? "One" : "Two") }));
    expect(slices.every((s) => s.ot === 0)).toBe(true);
  });

  describe("a workweek that spans two pay periods (PY-OT-03): OT on the whole Sun–Sat week, in the period that holds the hours past 40", () => {
    // A weekly calendar starting Wednesdays (refused since I2, but the engine still handles one) puts Sun–Tue and Wed–Sat of one workweek in different periods.
    const wed: PayCalendar = { anchorStart: "2026-10-21", anchorNumber: 1, periodDays: 7, checkOffsetDays: 2, submitOffsetDays: 2, numberResetsYearly: false };
    const o = opts({ periodOf: (_s, d) => periodOf(wed, d).start });

    it("24 h before the boundary and 20 h after: 4.00 OT, all in the later period, none per period", () => {
      const e = [...days("A", "2026-10-18", 3, 8), ...days("A", "2026-10-21", 2, 10)];
      const slices = overtimeSlices(dailyHours(e), o);
      expect(otBy(slices)).toEqual({ "A@2026-10-14": 0, "A@2026-10-21": 400 });
      expect(slices.map((x) => [x.periodStart, x.worked])).toEqual([
        ["2026-10-14", 2400],
        ["2026-10-21", 2000],
      ]);
    });

    it("past 40 before the boundary: the earlier period gets the OT worked there, the later one the rest", () => {
      const e = [...days("A", "2026-10-18", 3, 14), ...days("A", "2026-10-21", 2, 10)];
      expect(otBy(overtimeSlices(dailyHours(e), o))).toEqual({ "A@2026-10-14": 200, "A@2026-10-21": 2000 });
    });

    it("an earlier period locked with a different OT than it now holds: the open period absorbs the difference, and the week still adds up", () => {
      const e = [...days("A", "2026-10-18", 3, 14), ...days("A", "2026-10-21", 2, 10)];
      const first = overtimeSlices(dailyHours(e), o).find((s) => s.periodStart === "2026-10-14")!;
      const over = overtimeSlices(dailyHours(e), { ...o, locked: new Map([[sliceKey(first), 300]]) });
      expect(otBy(over)).toEqual({ "A@2026-10-14": 300, "A@2026-10-21": 1900 });
      // locked with none: the 2.00 h already paid as regular can't become OT in a period that only has 20 h
      const under = overtimeSlices(dailyHours(e), { ...o, locked: new Map([[sliceKey(first), 0]]) });
      expect(otBy(under)).toEqual({ "A@2026-10-14": 0, "A@2026-10-21": 2000 });
    });

    it("within one period, two shops still share its OT by hours (PY-OT-01: 25 h + 20 h is 5.00 OT, 2.78 and 2.22)", () => {
      const e = [...days("M", "2026-10-18", 2, 12.5), ...days("C", "2026-10-21", 2, 10)];
      const same = overtimeSlices(dailyHours(e), opts());
      expect(otBy(same)).toEqual({ "M@2026-10-18": 278, "C@2026-10-18": 222 });
      expect(same.map((x) => x.worked - x.ot)).toEqual([2222, 1778]);
    });
  });

  it("Dubuque and another shop on different calendars still share one week's OT", () => {
    const cal = (shop: string) => (shop === "DBQ" ? DUBUQUE : MAIN);
    const e = [...days("DBQ", "2026-10-11", 3, 10), ...days("A", "2026-10-14", 2, 10)];
    const slices = overtimeSlices(dailyHours(e), opts({ periodOf: (s, d) => periodOf(cal(s), d).start }));
    expect(otBy(slices)).toEqual({ "DBQ@2026-10-04": 600, "A@2026-10-04": 400 });
  });

  it("a DST week counts real elapsed time: 12:30–3:30am on fall-back night is 4 hours", () => {
    const overnight = entry("A", "2026-11-01T00:30", "2026-11-01T03:30");
    expect(splitByLocalDay(overnight)).toEqual([{ date: "2026-11-01", minutes: 240 }]);
    const e = [overnight, ...days("A", "2026-11-02", 5, 8)];
    const slices = overtimeSlices(dailyHours(e), opts());
    expect(slices.map((s) => [s.weekStart, s.worked, s.ot])).toEqual([["2026-11-01", 4400, 400]]);
    // spring forward: 1:30–3:30am on 3/8 is one hour
    expect(splitByLocalDay(entry("A", "2026-03-08T01:30", "2026-03-08T03:30"))).toEqual([{ date: "2026-03-08", minutes: 60 }]);
  });

  describe("workweeks and OT across the DST changes, in America/Chicago whatever the server's zone", () => {
    const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

    it("the fall-back week is 169 real hours and the spring-forward week 167; both start Sunday at local midnight", () => {
      expect(weekStartOf("2026-11-01")).toBe("2026-11-01");
      expect(weekStartOf("2026-11-07")).toBe("2026-11-01");
      expect(weekStartOf("2026-10-31")).toBe("2026-10-25");
      expect(at("2026-11-01T00:00").toISOString()).toBe("2026-11-01T05:00:00.000Z");
      expect(at("2026-11-08T00:00").toISOString()).toBe("2026-11-08T06:00:00.000Z");
      expect(hoursBetween(at("2026-11-01T00:00"), at("2026-11-08T00:00"))).toBe(169);
      expect(weekStartOf("2026-03-08")).toBe("2026-03-08");
      expect(weekStartOf("2026-03-14")).toBe("2026-03-08");
      expect(weekStartOf("2026-03-07")).toBe("2026-03-01");
      expect(hoursBetween(at("2026-03-08T00:00"), at("2026-03-15T00:00"))).toBe(167);
    });

    it("a Saturday-night shift over fall-back is split at local midnight into two workweeks, by real time", () => {
      // 10 PM CDT Sat Oct 31 to 3 AM CST Sun Nov 1: 2 hours Saturday, 4 hours Sunday (1 AM happens twice).
      const night = entry("A", "2026-10-31T22:00", "2026-11-01T03:00");
      expect(hoursBetween(night.startsAt, night.endsAt)).toBe(6);
      expect(splitByLocalDay(night)).toEqual([
        { date: "2026-10-31", minutes: 120 },
        { date: "2026-11-01", minutes: 240 },
      ]);
      // 38 hours Mon–Fri before it, 40 after it: only the new week's 44 hours have OT.
      const e = [...days("A", "2026-10-26", 4, 9.5), night, ...days("A", "2026-11-02", 5, 8)];
      const weeks = Object.fromEntries(overtimeSlices(dailyHours(e), opts()).map((s) => [s.weekStart, [s.worked, s.ot]]));
      expect(weeks).toEqual({ "2026-10-25": [4000, 0], "2026-11-01": [4400, 400] });
    });

    it("a Saturday-night shift over spring-forward is split the same way: 2 AM never happens", () => {
      // 10 PM CST Sat Mar 7 to 3 AM CDT Sun Mar 8: 2 hours Saturday, 2 hours Sunday.
      const night = entry("A", "2026-03-07T22:00", "2026-03-08T03:00");
      expect(hoursBetween(night.startsAt, night.endsAt)).toBe(4);
      expect(splitByLocalDay(night)).toEqual([
        { date: "2026-03-07", minutes: 120 },
        { date: "2026-03-08", minutes: 120 },
      ]);
      const e = [...days("A", "2026-03-02", 4, 9.5), night, ...days("A", "2026-03-09", 5, 8)];
      const weeks = Object.fromEntries(overtimeSlices(dailyHours(e), opts()).map((s) => [s.weekStart, [s.worked, s.ot]]));
      expect(weeks).toEqual({ "2026-03-01": [4000, 0], "2026-03-08": [4200, 200] });
    });

    it("PY-OT-04: the Nov 1–14 pay period starts on the fall-back Sunday; 9 PM CDT Sat to 3 AM CST Sun is 7 real hours, 3 in the old week and 4 in the new, and 36 more make 40.00 with no OT", () => {
      expect(periodOf(MAIN, "2026-11-01")).toMatchObject({ start: "2026-11-01", end: "2026-11-14" });
      expect(periodOf(MAIN, "2026-10-31")).toMatchObject({ start: "2026-10-18", end: "2026-10-31" });
      const night = entry("A", "2026-10-31T21:00", "2026-11-01T03:00");
      expect(hoursBetween(night.startsAt, night.endsAt)).toBe(7);
      expect(splitByLocalDay(night)).toEqual([
        { date: "2026-10-31", minutes: 180 },
        { date: "2026-11-01", minutes: 240 },
      ]);
      const slices = overtimeSlices(dailyHours([night, ...days("A", "2026-11-02", 4, 9)]), opts());
      expect(slices.map((s) => [s.periodStart, s.weekStart, s.worked, s.ot])).toEqual([
        ["2026-10-18", "2026-10-25", 300, 0],
        ["2026-11-01", "2026-11-01", 4000, 0],
      ]);
      // the repeated hour reads distinctly on a timesheet
      expect(formatTime(new Date("2026-11-01T06:30:00Z"), "12h")).toBe("1:30 AM CDT");
      expect(formatTime(new Date("2026-11-01T07:30:00Z"), "12h")).toBe("1:30 AM CST");
      expect(formatTime(at("2026-11-01T03:00"), "12h")).toBe("3:00 AM");
    });

    it("PY-OT-05: 10 PM CST Sat Mar 13 to 4 AM CDT Sun Mar 14, 2027 is 5 real hours, 2 and 3; with 36 more the week is 39.00; 2:30 AM doesn't exist", () => {
      expect(periodOf(MAIN, "2027-03-14")).toMatchObject({ start: "2027-03-07", end: "2027-03-20" });
      const night = entry("A", "2027-03-13T22:00", "2027-03-14T04:00");
      expect(hoursBetween(night.startsAt, night.endsAt)).toBe(5);
      expect(splitByLocalDay(night)).toEqual([
        { date: "2027-03-13", minutes: 120 },
        { date: "2027-03-14", minutes: 180 },
      ]);
      const weeks = overtimeSlices(dailyHours([night, ...days("A", "2027-03-15", 4, 9)]), opts()).map((s) => [s.weekStart, s.worked, s.ot]);
      expect(weeks).toEqual([
        ["2027-03-07", 200, 0],
        ["2027-03-14", 3900, 0],
      ]);
      expect(existingWallTime("2027-03-14", 2 * 60 + 30)).toBeNull();
    });

    it("PY-OT-06: Saturday 11:59 PM and Sunday 12:00 AM are in different workweeks", () => {
      const e = [entry("A", "2026-10-24T23:00", "2026-10-24T23:59"), entry("A", "2026-10-25T00:00", "2026-10-25T01:00")];
      expect(overtimeSlices(dailyHours(e), opts()).map((s) => [s.weekStart, s.worked])).toEqual([
        ["2026-10-18", 98],
        ["2026-10-25", 100],
      ]);
    });

    it("the 25-hour and 23-hour days count every real hour toward the weekly 40", () => {
      const fall = [entry("A", "2026-11-01T00:00", "2026-11-02T00:00"), ...days("A", "2026-11-02", 4, 8)];
      expect(dailyHours(fall).find((d) => d.date === "2026-11-01")!.worked).toBe(2500);
      expect(overtimeSlices(dailyHours(fall), opts()).map((s) => [s.worked, s.ot])).toEqual([[5700, 1700]]);
      const spring = [entry("A", "2026-03-08T00:00", "2026-03-09T00:00"), ...days("A", "2026-03-09", 2, 8), ...days("A", "2026-03-12", 1, 1.5)];
      expect(dailyHours(spring).find((d) => d.date === "2026-03-08")!.worked).toBe(2300);
      expect(overtimeSlices(dailyHours(spring), opts()).map((s) => [s.worked, s.ot])).toEqual([[4050, 50]]);
    });

    it("daily OT on a DST day goes by real hours too: midnight to 9 AM on fall-back day is 10 hours, 2 over 8", () => {
      const e = [entry("A", "2026-11-01T00:00", "2026-11-01T09:00")];
      const [s] = overtimeSlices(dailyHours(e), opts({ dailyThresholdCenti: 800 }));
      expect([s.worked, s.ot]).toEqual([1000, 200]);
      const [p] = overtimeSlices(dailyHours([entry("A", "2026-03-08T00:00", "2026-03-08T09:00")]), opts({ dailyThresholdCenti: 800 }));
      expect([p.worked, p.ot]).toEqual([800, 0]);
    });

    it("a week split over two pay periods on a DST weekend keeps one week's OT", () => {
      // MAIN's period 24 starts Sun Nov 1, the fall-back day: the week and the period start together.
      const e = [...days("A", "2026-10-26", 5, 9), entry("A", "2026-11-01T00:00", "2026-11-01T10:00"), ...days("A", "2026-11-02", 4, 9)];
      const s = overtimeSlices(dailyHours(e), opts());
      expect(otBy(s)).toEqual({ "A@2026-10-18": 500, "A@2026-11-01": 700 });
      expect(s.find((x) => x.periodStart === "2026-11-01")!.worked).toBe(4700);
    });

    it("the same answers with the server's default zone set to Tokyo", () => {
      const was = Settings.defaultZone;
      Settings.defaultZone = "Asia/Tokyo";
      try {
        const night = entry("A", "2026-10-31T22:00", "2026-11-01T03:00");
        expect(splitByLocalDay(night)).toEqual([
          { date: "2026-10-31", minutes: 120 },
          { date: "2026-11-01", minutes: 240 },
        ]);
        expect(weekStartOf("2026-11-01")).toBe("2026-11-01");
        const e = [...days("A", "2026-10-26", 4, 9.5), night, ...days("A", "2026-11-02", 5, 8)];
        const weeks = Object.fromEntries(overtimeSlices(dailyHours(e), opts()).map((s) => [s.weekStart, [s.worked, s.ot]]));
        expect(weeks).toEqual({ "2026-10-25": [4000, 0], "2026-11-01": [4400, 400] });
      } finally {
        Settings.defaultZone = was;
      }
    });
  });

  it("weeks run Sunday to Saturday in shop time; a shift past midnight Saturday is split", () => {
    expect(weekStartOf("2026-10-24")).toBe("2026-10-18");
    expect(weekStartOf("2026-10-25")).toBe("2026-10-25");
    const late = entry("A", "2026-10-24T22:00", "2026-10-25T02:00");
    expect(dailyHours([late]).map((d) => [d.date, d.worked])).toEqual([["2026-10-24", 200], ["2026-10-25", 200]]);
  });

  it("training flag off: training doesn't count toward the 40; on: it does and carries its share", () => {
    const e = [...days("A", "2026-10-18", 4, 9.5), ...days("B", "2026-10-22", 1, 4, "training")];
    expect(overtimeSlices(dailyHours(e), opts()).every((s) => s.ot === 0)).toBe(true);
    const on = overtimeSlices(dailyHours(e), opts({ trainingCountsTowardOt: true }));
    // 38 worked + 4 training = 42 → 2 OT, shared 38:4
    expect(otBy(on)).toEqual({ "A@2026-10-18": 181, "B@2026-10-18": 19 });
  });

  it("largest remainder always adds back up", () => {
    expect(largestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder(0, [5, 5])).toEqual([0, 0]);
    expect(largestRemainder(7, [0, 0])).toEqual([0, 0]);
  });
});

const input = (over: Partial<LineInput> = {}): LineInput => ({
  staffId: "b1",
  name: "Barber One",
  shopId: "A",
  employeeNumber: "1001",
  keyIsText: false,
  isolvedName: "ONE, BARBER",
  hourlyRate: 14.5,
  servicePct: 0.4,
  productPct: 0.15,
  trainingRate: null,
  workedHours: 80,
  otHours: 0,
  ptoHours: 0,
  trainingHours: 0,
  serviceSales: 2864.15,
  productSales: 68.4,
  tips: 395.25,
  ...over,
});

describe("workbook line math", () => {
  it("commission over hourly: NetComm is the top-up plus product, Total Wages = hourly + top-up + product", () => {
    const l = computeLine(input({ workedHours: 60 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.hourlyTotal).toBe(60 * 14.5);
    expect(l.commission).toBe(2864.15 * 0.4);
    expect(l.serviceTotal).toBe(2864.15 * 0.4 - 870);
    expect(l.netComm).toBe(2864.15 * 0.4 - 870 + 68.4 * 0.15);
    expect(l.totalWages).toBe(870 + (2864.15 * 0.4 - 870) + 68.4 * 0.15);
    expect(l.laborCost).toBe(l.totalWages);
  });

  it("hourly over commission: NetComm is product only; zero hours gives null Gross/Hr (the workbook's #DIV/0!)", () => {
    const l = computeLine(input({ serviceSales: 500 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.netComm).toBe(68.4 * 0.15);
    expect(l.totalWages).toBe(1160 + 68.4 * 0.15);
    const z = computeLine(input({ workedHours: 0, serviceSales: 0 }), DEFAULT_PAYROLL_SETTINGS);
    expect(z.grossPerHour).toBeNull();
    expect(z.pctOfGross).toBeNull();
  });

  it("OT pay = 1.5 × base rate × OT hours, in labor cost; regular hours are worked minus OT", () => {
    const l = computeLine(input({ workedHours: 85, otHours: 5 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.hours).toBe(80);
    expect(l.otPay).toBe(1.5 * 14.5 * 5);
    expect(l.laborCost).toBe(l.totalWages + 108.75);
    expect(l.totalWages).toBe(computeLine(input(), DEFAULT_PAYROLL_SETTINGS).totalWages);
  });

  it("training pay is training hours × the training rate, its own line in labor cost (Charles, Oct 28); without a rate, the hourly rate", () => {
    const on = computeLine(input({ trainingHours: 3.5, trainingRate: 12 }), DEFAULT_PAYROLL_SETTINGS);
    expect([on.trainingPay, on.trainingRate]).toEqual([42, 12]);
    expect(on.laborCost).toBe(on.totalWages + 42);
    expect("trainingPayInCost" in DEFAULT_PAYROLL_SETTINGS).toBe(false);
    expect(computeLine(input({ trainingHours: 2 }), DEFAULT_PAYROLL_SETTINGS).trainingPay).toBe(29);
    expect(computeLine(input({ trainingHours: 2, zeroHourlyPay: true }), DEFAULT_PAYROLL_SETTINGS).trainingPay).toBe(0);
    expect(computeLine(input({ trainingHours: 2, zeroHourlyPay: true, trainingRate: 10 }), DEFAULT_PAYROLL_SETTINGS).trainingPay).toBe(20);
  });

  it("training never enters commission or the greater-of: every greater-of column is the same with or without it", () => {
    const cols = ["hours", "hourlyTotal", "commission", "serviceTotal", "productTotal", "netComm", "totalWages", "grossPerHour", "pctOfGross"] as const;
    for (const over of [{ serviceSales: 500 }, { serviceSales: 2864.15 }, { serviceSales: 2900 }, { workedHours: 85, otHours: 5 }]) {
      const without = computeLine(input(over), DEFAULT_PAYROLL_SETTINGS);
      const withTraining = computeLine(input({ ...over, trainingHours: 6, trainingRate: 11 }), DEFAULT_PAYROLL_SETTINGS);
      for (const k of cols) expect(withTraining[k], k).toBe(without[k]);
      expect(employeePay(withTraining)).toMatchObject({ greaterOfCents: employeePay(without).greaterOfCents, appliedRule: employeePay(without).appliedRule, trainingPayCents: 6600 });
      expect(withTraining.laborCost).toBeCloseTo(without.laborCost + 66, 10);
    }
  });

  it("C2: overtime past the hours clocked at a shop is training that went over the 40 there, paid as O.T. hours, never negative regular hours", () => {
    const l = computeLine(input({ workedHours: 0, otHours: 1.33, trainingHours: 8, trainingRate: 12, serviceSales: 0, productSales: 0, tips: 0 }), DEFAULT_PAYROLL_SETTINGS);
    expect([l.hours, l.otHours, l.trainingHours, l.otFromTraining]).toEqual([0, 1.33, 8 - 1.33, 1.33]);
    expect(l.hourlyTotal).toBe(0);
    expect(l.trainingPay).toBeCloseTo((8 - 1.33) * 12, 10);
    const { blocks, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs: [l.input] }], DEFAULT_PAYROLL_SETTINGS);
    expect(mismatches).toEqual([]);
    expect(blocks[0].exportRows[0].values).toEqual([0, 1.33, 0, 0, 0, 8 - 1.33]);
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).find((a) => a.kind === "training_overtime")?.message).toMatch(/1\.33h of overtime here is training/);
    const clocked = computeLine(input({ workedHours: 30, otHours: 2, trainingHours: 8 }), DEFAULT_PAYROLL_SETTINGS);
    expect([clocked.hours, clocked.trainingHours, clocked.otFromTraining]).toEqual([28, 8, undefined]);
  });

  it("training at the hourly rate for want of a training rate is flagged; a rate that changed in the period is mixed", () => {
    const { blocks } = assemble(
      [
        {
          shopId: "A",
          shop: "Shop A",
          inputs: [input({ trainingHours: 4, trainingRateSource: "hourly" }), input({ staffId: "b2", trainingHours: 4, trainingRate: 11.25, trainingRateSource: "staff", mixedRates: ["trainingRate"] }), input({ staffId: "b3", trainingRateSource: "hourly" })],
        },
      ],
      DEFAULT_PAYROLL_SETTINGS,
    );
    const a = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS);
    expect(a.filter((x) => x.kind === "no_training_rate").map((x) => x.staffId)).toEqual(["b1"]);
    expect(a.find((x) => x.kind === "no_training_rate")!.message).toBe("Barber One (Shop A): 4h of training paid at their hourly rate ($14.50), because they have no training rate. Set one on their Staff page.");
    expect(a.find((x) => x.kind === "mixed_rates")!.message).toBe(`Barber One (Shop A): the training rate changed during the period, so each day's training at that day's training rate. The report shows "mixed".`);
    expect(employeePay(blocks[0].lines[1])).toMatchObject({ trainingRateCents: null, trainingPayCents: 4500 });
  });

  it("a typed-over NetComm goes to the export but is flagged against the formula, never fixed", () => {
    const l = computeLine(input({ serviceSales: 500, overrides: { netComm: { value: 141.37, reason: "carried over" } } }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.netComm).toBe(141.37);
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [l.input] }], DEFAULT_PAYROLL_SETTINGS);
    expect(blocks[0].exportRows[0].values[3]).toBe(141.37);
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).map((a) => a.kind)).toContain("netcomm_gap");
  });

  it("owner rows are flagged, not guessed: hours at $0 cost and sales with no hours", () => {
    const owner = input({ staffId: "o", name: "Owner", hourlyRate: 0, servicePct: 0, productPct: 0, serviceSales: 0, productSales: 0, tips: 0 });
    const sales = input({ staffId: "o2", name: "Owner", workedHours: 0, serviceSales: 35, productSales: 0 });
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [owner, sales] }], DEFAULT_PAYROLL_SETTINGS);
    const kinds = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).map((a) => a.kind);
    expect(kinds).toContain("owner_case");
    expect(kinds).toContain("sales_without_hours");
  });
});

describe("totals come from line items", () => {
  it("shop and Locations totals are sums of rows; ratios are ratios of the totals", () => {
    const { blocks, grand, mismatches } = assemble(
      [
        { shopId: "A", shop: "Shop A", inputs: [input(), input({ staffId: "b2", serviceSales: 1000, workedHours: 41, otHours: 1 })] },
        { shopId: "B", shop: "Shop B", inputs: [input({ staffId: "b3", shopId: "B" })] },
      ],
      DEFAULT_PAYROLL_SETTINGS,
    );
    expect(mismatches).toEqual([]);
    expect(blocks[0].totals.service).toBe(2864.15 + 1000);
    expect(blocks[0].totals.hours).toBe(120);
    expect(grand.laborCost).toBe(blocks[0].totals.laborCost + blocks[1].totals.laborCost);
    expect(grand.grossProfit).toBe(grand.service - grand.laborCost);
    expect(blocks[0].totals.grossPerHour).toBe(blocks[0].totals.service / 120);
  });
});

describe("reconciliation gate", () => {
  it("blocks when a report total isn't the sum of its rows", () => {
    const { blocks, grand } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input(), input({ staffId: "b2" })] }], DEFAULT_PAYROLL_SETTINGS);
    blocks[0].totals = { ...blocks[0].totals, tips: blocks[0].totals.tips + 0.01 };
    const m = reconcile(blocks, grand);
    expect(m.map((x) => [x.check, x.column])).toContainEqual(["rows", "TIPS"]);
  });

  it("blocks when the per-shop export adds up differently, even by a cent from rounding", () => {
    const s = { ...DEFAULT_PAYROLL_SETTINGS, roundExport2dp: true };
    const { mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 1.005 }), input({ staffId: "b2", tips: 1.005 })] }], s);
    expect(mismatches.map((x) => x.column)).toContain("E_Cash Tips Recd_Dollars");
    expect(assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 1.005 }), input({ staffId: "b2", tips: 1.005 })] }], DEFAULT_PAYROLL_SETTINGS).mismatches).toEqual([]);
  });

  it("blocks when Training Pay isn't the export's E_Training_Hours at each person's training rate, or Labor Cost leaves it out", () => {
    const shop = () => assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ trainingHours: 3, trainingRate: 12 }), input({ staffId: "b2", trainingHours: 1.5 })] }], DEFAULT_PAYROLL_SETTINGS);
    expect(shop().mismatches).toEqual([]);
    const file = shop();
    file.blocks[0].exportRows[0].values[5] = 2.5;
    expect(reconcile(file.blocks, file.grand).map((x) => [x.check, x.column])).toEqual(
      expect.arrayContaining([
        ["export", "E_Training_Hours"],
        ["export", "Training Pay"],
      ]),
    );
    const cost = shop();
    const l = cost.blocks[0].lines[0];
    cost.blocks[0].lines[0] = { ...l, laborCost: l.laborCost - l.trainingPay };
    cost.blocks[0].totals = totalsOf(cost.blocks[0].lines);
    cost.grand = totalsOf(cost.blocks.map((b) => b.totals));
    expect(reconcile(cost.blocks, cost.grand).map((x) => [x.check, x.column])).toEqual([["rows", "Labor Cost"]]);
    const locked = shop();
    locked.blocks[0].lines = locked.blocks[0].lines.map(({ trainingRate: _r, ...x }) => ({ ...x, trainingPay: 0, laborCost: x.laborCost - x.trainingPay }));
    locked.blocks[0].totals = totalsOf(locked.blocks[0].lines);
    locked.grand = totalsOf(locked.blocks.map((b) => b.totals));
    expect(reconcile(locked.blocks, locked.grand)).toEqual([]);
  });

  it("blocks when the Locations total isn't the shops", () => {
    const { blocks, grand } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input()] }], DEFAULT_PAYROLL_SETTINGS);
    expect(reconcile(blocks, { ...grand, laborCost: grand.laborCost - 1 }).map((x) => x.check)).toEqual(["locations"]);
  });

  it("totalsOf on an empty shop is all zeros", () => {
    expect(totalsOf([]).laborCost).toBe(0);
    expect(totalsOf([]).grossPerHour).toBeNull();
  });
});

describe("iSolved export values", () => {
  it("carries OT hours only — never OT dollars or a premium", () => {
    expect(EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      "E_Regular_Hours",
      "E_Overtime 1.5_Hours",
      "E_Cash Tips Recd_Dollars",
      "E_Comm Sales_Dollars",
      "E_Ray'z Paid Time_Hours",
      "E_Training_Hours",
    ]);
    const lines = [computeLine(input({ workedHours: 87.5, otHours: 7.5, tips: 0, productSales: 0, serviceSales: 0, trainingHours: 2 }), DEFAULT_PAYROLL_SETTINGS)];
    const [row] = exportRows(lines, DEFAULT_PAYROLL_SETTINGS);
    expect(row.values).toEqual([80, 7.5, 0, 0, 0, 2]);
    expect(lines[0].otPay).toBe(163.125);
    expect(row.values).not.toContain(lines[0].otPay);
    expect(row.values).not.toContain(lines[0].otPay / 1.5);
    expect(row.values).not.toContain(lines[0].trainingPay);
    // OT pay is in the report's labor cost, not in NetComm (Comm Sales) or tips
    expect(row.values[3]).toBe(lines[0].netComm);
    expect(lines[0].laborCost - lines[0].totalWages).toBe(163.125 + lines[0].trainingPay);
  });

  it("goes out unrounded by default, exactly the computed value", () => {
    const lines = [computeLine(input({ serviceSales: 2864.14, workedHours: 60 }), DEFAULT_PAYROLL_SETTINGS)];
    expect(exportRows(lines, DEFAULT_PAYROLL_SETTINGS)[0].values[3]).toBe(2864.14 * 0.4 - 870 + 68.4 * 0.15);
  });

  it("keys keep their type: numeric keys are numbers, text keys (and leading zeros) stay text", () => {
    const rows = exportRows(
      [input(), input({ employeeNumber: "001234" }), input({ employeeNumber: "1002", keyIsText: true }), input({ employeeNumber: null })].map((i) => computeLine(i, DEFAULT_PAYROLL_SETTINGS)),
      DEFAULT_PAYROLL_SETTINGS,
    );
    expect(rows.map((r) => r.key)).toEqual([1001, 1234, "1002", null]);
  });
});

describe("Payroll Report settings (Charles's open questions, configurable)", () => {
  it("defaults: unrounded, uniform 0.00 files, PTO and training from the clock or a manager, card tips under E_Cash Tips Recd", () => {
    const d = payrollSettings({});
    expect(d).toMatchObject({ roundExport2dp: false, exportFormat: "uniform", ptoSource: "both", trainingSource: "both", cardTipsHeader: "E_Cash Tips Recd_Dollars" });
    expect(earningHeaders(d)).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(payrollSettings({ exportFormat: "nope", ptoSource: "nope", reportOrder: "x" })).toMatchObject({ exportFormat: "uniform", ptoSource: "both", reportOrder: d.reportOrder });
  });

  it("earning codes rename the file's columns; card tips stay in E_Cash Tips Recd, never a code of their own (8 columns, Charles)", () => {
    const s = payrollSettings({ earningCodes: { hours: "E_Reg_Hours" }, cardTipsHeader: "E_Card Tips_Dollars" });
    const lines = [input({ tips: 100, chargedTips: 70 }), input({ staffId: "b2", tips: 50, chargedTips: 0 })].map((i) => computeLine(i, s));
    expect(lines.map((l) => l.cardTipsOutside)).toEqual([70, 0]);
    const { blocks, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs: lines.map((l) => l.input) }], s);
    expect(mismatches).toEqual([]);
    expect(blocks[0].exportHeaders).toEqual(["E_Reg_Hours", ...EXPORT_COLUMNS.slice(1).map((c) => c.header)]);
    expect(blocks[0].exportRows.map((r) => r.values[2])).toEqual([100, 50]);
  });

  it("the $0 hourly flag keeps the hours in the file with no hourly pay; a typed Hourly Total is an adjustment", () => {
    const owner = computeLine(input({ zeroHourlyPay: true, workedHours: 42, otHours: 2, serviceSales: 0, productSales: 0 }), DEFAULT_PAYROLL_SETTINGS);
    expect([owner.hours, owner.hourlyTotal, owner.otPay, owner.totalWages]).toEqual([40, 0, 0, 0]);
    expect(exportRows([owner], DEFAULT_PAYROLL_SETTINGS)[0].values.slice(0, 2)).toEqual([40, 2]);
    const typed = computeLine(input({ serviceSales: 0, productSales: 0, overrides: { hourlyTotal: { value: 100, reason: "agreed flat" } } }), DEFAULT_PAYROLL_SETTINGS);
    expect([typed.hourlyTotal, typed.totalWages, typed.overridden]).toEqual([100, 100, ["hourlyTotal"]]);
  });

  it("shops in Charles's orders by name, spaces and case aside; shops not listed come after, by name", () => {
    const shops = ["Dubuque", "Le Claire", "Moline", "Utica", "Rock Island"];
    expect(inNameOrder(shops, DEFAULT_PAYROLL_SETTINGS.reportOrder, (s) => [s])).toEqual(["Utica", "Moline", "Rock Island", "Le Claire", "Dubuque"]);
    expect(inNameOrder(shops, DEFAULT_PAYROLL_SETTINGS.sheetOrder, (s) => [s])).toEqual(["Rock Island", "Moline", "Utica", "Le Claire", "Dubuque"]);
  });

  it("the Locations summary: Employee Cost is Total Wages (not labor cost); Gross Profit is service less it", () => {
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ workedHours: 85, otHours: 5 })] }, { shopId: "B", shop: "Shop B", inputs: [input({ staffId: "b2", shopId: "B" })] }], DEFAULT_PAYROLL_SETTINGS);
    const { rows, total } = locationSummary(blocks);
    expect(rows[0].employeeCost).toBe(blocks[0].totals.totalWages);
    expect(rows[0].employeeCost).toBeLessThan(blocks[0].totals.laborCost);
    expect(total).toEqual({ shopId: null, shop: "Total", service: rows[0].service + rows[1].service, employeeCost: rows[0].employeeCost + rows[1].employeeCost, grossProfit: rows[0].service + rows[1].service - (rows[0].employeeCost + rows[1].employeeCost) });
  });

  it("flags sales with no employee on them, and rates that changed mid-period", () => {
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ mixedRates: ["servicePct"] })], unassigned: { serviceSales: 0, productSales: 42.5, salesTax: 3.19 } }], DEFAULT_PAYROLL_SETTINGS);
    const a = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS);
    expect(a.find((x) => x.kind === "unassigned_sales")?.message).toContain("$42.50 of product sales");
    expect(a.find((x) => x.kind === "mixed_rates")?.message).toContain("service %");
  });

  it("sales tax is carried for reference and never in pay", () => {
    const a = computeLine(input(), DEFAULT_PAYROLL_SETTINGS);
    const b = computeLine(input({ salesTax: 231.09 }), DEFAULT_PAYROLL_SETTINGS);
    expect(b.salesTax).toBe(231.09);
    expect({ ...b, input: null, salesTax: 0 }).toEqual({ ...a, input: null });
    expect(exportRows([b], DEFAULT_PAYROLL_SETTINGS)).toEqual(exportRows([a], DEFAULT_PAYROLL_SETTINGS));
  });
});

describe("tips already paid out", () => {
  const CASH_TIPS = EXPORT_COLUMNS.findIndex((c) => c.from === "tipsOutside");
  it("tips already paid out (drawer or Stripe) stay in E_Cash Tips Recd with no memo column: the file is always the workbook's 8 columns", () => {
    const lines = [computeLine(input({ tips: 395.25, tipsPaidOut: 300 }), DEFAULT_PAYROLL_SETTINGS)];
    expect(lines[0]).toMatchObject({ tips: 395.25, tipsInPayroll: 0, tipsOutside: 395.25, tipsPaidOut: 300 });
    for (const markPaidTips of [true, false]) {
      const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 395.25, tipsPaidOut: 300 })] }], { ...DEFAULT_PAYROLL_SETTINGS, markPaidTips });
      expect(blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
      expect(blocks[0].exportFrom).toEqual([]);
      expect(blocks[0].exportRows[0].values).toHaveLength(EXPORT_COLUMNS.length);
      expect(blocks[0].exportRows[0].values[CASH_TIPS]).toBe(395.25);
      expect(mismatches).toEqual([]);
      const short = { ...blocks[0], exportRows: blocks[0].exportRows.map((r) => ({ ...r, values: r.values.map((v, k) => (k === CASH_TIPS ? 95.25 : v)) })) };
      expect(reconcile([short], grand).map((m) => m.column)).toContain("E_Cash Tips Recd_Dollars");
    }
  });

  it("tips to be paid through payroll stay in E_Cash Tips Recd too, and are flagged: iSolved doesn't pay that column in the check", () => {
    const inputs = [input({ tips: 395.25, tipsInPayroll: 395.25 }), input({ staffId: "b2", employeeNumber: "1002", tips: 100, tipsPaidOut: 100 })];
    const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs }], DEFAULT_PAYROLL_SETTINGS);
    expect(blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(blocks[0].exportRows.map((r) => r.values[CASH_TIPS])).toEqual([395.25, 100]);
    expect(grand).toMatchObject({ tips: 495.25, tipsInPayroll: 395.25, tipsOutside: 100, tipsPaidOut: 100 });
    expect(mismatches).toEqual([]);
    const flags = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).filter((a) => a.kind === "tips_in_payroll_memo");
    expect(flags.map((a) => a.staffId)).toEqual(["b1"]);
    expect(flags[0].message).toContain("$395.25 of tips to be paid through payroll");
  });

  it("owed tips and tips paid by Stripe add no codes (ST-C13's split declined); a period locked with the old tip columns still checks against them", () => {
    const s = DEFAULT_PAYROLL_SETTINGS;
    const inputs = [
      input({ tips: 300, tipsInPayroll: 300, owedTipsInPayroll: 120 }),
      input({ staffId: "b2", employeeNumber: "1002", tips: 200, tipsPaidOut: 200, tipsPaidByStripe: 150 }),
      input({ staffId: "b3", employeeNumber: "1003", tips: 50, tipsPaidOut: 50 }),
    ];
    const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs }], s);
    expect(blocks[0].exportFrom).toEqual([]);
    expect(blocks[0].exportRows.map((r) => r.values)).toEqual(blocks[0].lines.map((l) => [l.hours, l.otHours, l.tips, l.netComm, l.ptoHours, l.trainingHours]));
    expect(grand).toMatchObject({ tipsInPayroll: 300, tipsPaidOut: 250 });
    expect(mismatches).toEqual([]);
    // Never more than the tips they're part of.
    expect(computeLine(input({ tips: 10, tipsInPayroll: 10, owedTipsInPayroll: 25, tipsPaidOut: 0, tipsPaidByStripe: 5 }), s)).toMatchObject({ tipsInPayrollOwed: 10, tipsInPayrollChosen: 0, tipsPaidOutStripe: 0 });

    const locked = {
      ...blocks[0],
      exportFrom: ["tipsInPayroll"] as ExtraFrom[],
      exportHeaders: [...EXPORT_COLUMNS.map((c) => c.header), s.tipsInPayrollHeader],
      exportRows: blocks[0].exportRows.map((r, i) => ({ ...r, values: [...r.values.slice(0, CASH_TIPS), blocks[0].lines[i].tipsOutside, ...r.values.slice(CASH_TIPS + 1), blocks[0].lines[i].tipsInPayroll] })),
    };
    expect(reconcile([locked], grand)).toEqual([]);
    expect(reconcile([{ ...locked, exportRows: locked.exportRows.map((r, i) => (i ? r : { ...r, values: [...r.values.slice(0, 6), 100] })) }], grand).map((m) => m.column)).toContain("Tips in payroll");
  });

  it("45B starts in 2025 at the $7.25 federal minimum wage for barbering (2025 Form 8846)", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.tipTax).toMatchObject({ creditFrom: "2025-01-01", creditWageCentsPerHour: 725 });
  });

});

describe("2-decimal half-up rounding (toggle, off by default)", () => {
  it("rounds half up from the decimal digits, never banker's", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.roundExport2dp).toBe(false);
    expect(roundHalfUp2(6.315)).toBe(6.32);
    expect(roundHalfUp2(0.125)).toBe(0.13);
    expect(roundHalfUp2(2.675)).toBe(2.68);
    expect(roundHalfUp2(1.005)).toBe(1.01);
    expect(roundHalfUp2(-1.005)).toBe(-1.01);
    expect(roundHalfUp2(218.66700000000003)).toBe(218.67);
    expect(roundHalfUp2(78.24999999999991)).toBe(78.25);
    expect(roundHalfUp2(7)).toBe(7);
  });

  it("applies to every export value when on", () => {
    const s = { ...DEFAULT_PAYROLL_SETTINGS, roundExport2dp: true };
    const [row] = exportRows([computeLine(input({ tips: 6.315, workedHours: 78.245 }), s)], s);
    expect(row.values.slice(0, 3)).toEqual([78.25, 0, 6.32]);
  });
});

describe("full time / part time", () => {
  const weeks = (h: number[], training = 0) => h.map((worked) => ({ worked, training, pto: 0 }));

  it("averaging exactly 32.0 hours over the rolling 4 weeks is part time; more is full time", () => {
    expect(ftStatus("c", weeks([32, 32, 32, 32]), DEFAULT_PAYROLL_SETTINGS).fullTime).toBe(false);
    expect(ftStatus("c", weeks([32, 32, 32, 32.04]), DEFAULT_PAYROLL_SETTINGS)).toMatchObject({ averageHours: 32.01, fullTime: true });
  });

  it("only the window counts, and the basis is a setting (clocked worked hours by default)", () => {
    expect(ftStatus("c", weeks([60, 30, 30, 30, 30]), DEFAULT_PAYROLL_SETTINGS).fullTime).toBe(false);
    expect(ftStatus("c", weeks([30, 30, 30, 30], 4), DEFAULT_PAYROLL_SETTINGS).fullTime).toBe(false);
    expect(ftStatus("c", weeks([30, 30, 30, 30], 4), { ...DEFAULT_PAYROLL_SETTINGS, ftBasis: "worked_training" }).fullTime).toBe(true);
    expect(ftStatus("c", weeks([40, 40]), { ...DEFAULT_PAYROLL_SETTINGS, ftWindowWeeks: 2 }).weeks).toBe(2);
  });

  it("settings parse with safe defaults", () => {
    expect(payrollSettings(null)).toEqual(DEFAULT_PAYROLL_SETTINGS);
    expect(payrollSettings({ ftBasis: "nope", ftHoursPerWeek: -1, roundExport2dp: true })).toMatchObject({ ftBasis: "worked", ftHoursPerWeek: 32, roundExport2dp: true });
  });

  it("hours come from the time clock unless the brand turns it off (Charles: the basic clock ships at launch)", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.hoursFromClock).toBe(true);
    expect(payrollSettings({ hoursFromClock: "no" }).hoursFromClock).toBe(true);
    expect(payrollSettings({ hoursFromClock: false }).hoursFromClock).toBe(false);
  });
});

describe("payroll review (SB-C2, SB-C3, SB-I2)", () => {
  it("brand pay periods follow the calendar in the payroll setting, not a hard-coded anchor", () => {
    expect(payPeriodFor("2026-10-18")).toMatchObject({ start: "2026-10-18", end: "2026-10-31", index: 1 });
    expect(payPeriodFor("2026-10-04")).toMatchObject({ start: "2026-10-04", end: "2026-10-17", index: 0 });
    const cal = { anchorStart: "2026-10-04", periodDays: 7 };
    expect(payPeriodFor("2026-10-18", cal)).toMatchObject({ start: "2026-10-18", end: "2026-10-24", index: 2 });
    expect(payPeriodByIndex(-1, cal)).toMatchObject({ start: "2026-09-27", end: "2026-10-03" });
    expect(payPeriodsBetween("2026-10-01", "2026-10-12", cal).map((p) => p.start)).toEqual(["2026-09-27", "2026-10-04", "2026-10-11"]);
    expect(payrollSettings({ calendar: DUBUQUE }).calendar).toEqual(DUBUQUE);
    expect(payrollSettings({ calendar: { ...DUBUQUE, anchorStart: "2026-10-05" } }).calendar).toEqual(DEFAULT_BRAND_CALENDAR);
  });

  it("declarations and the W-2 and 45B settings parse with safe defaults", () => {
    expect(payrollSettings({ declarations: { lockDay: 40, remindUntilDay: 20, attestation: "  " } }).declarations).toMatchObject({ lockDay: 10, remindUntilDay: 10, attestation: DEFAULT_PAYROLL_SETTINGS.declarations.attestation });
    expect(payrollSettings({ declarations: { lockDay: 5, enabled: false } }).declarations).toMatchObject({ lockDay: 5, remindUntilDay: 5, enabled: false, atClockOut: true });
    expect(payrollSettings({ tipTax: { qualifiedTipsCode: "tp", overtimeCode: "not a code", ficaRate: 2, creditFrom: "soon" } }).tipTax).toEqual({ ...DEFAULT_PAYROLL_SETTINGS.tipTax, qualifiedTipsCode: "TP" });
  });

  it("declared cash tips go in E_Cash Tips Recd with the ticket tips (no column of their own), are not labor cost, and the export must match the report", () => {
    const inputs = [input({ declaredCashTips: 45 }), input({ staffId: "b2", employeeNumber: "1002" })];
    const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs }], DEFAULT_PAYROLL_SETTINGS);
    const cash = EXPORT_COLUMNS.findIndex((c) => c.from === "tipsOutside");
    expect(blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(blocks[0].exportRows.map((r) => r.values[cash])).toEqual([395.25 + 45, 395.25]);
    expect(blocks[0].lines[0].laborCost).toBe(blocks[0].lines[1].laborCost);
    expect(grand.declaredCashTips).toBe(45);
    expect(mismatches).toEqual([]);
    const off = { ...blocks[0], exportRows: blocks[0].exportRows.map((r, i) => (i ? r : { ...r, values: r.values.map((v, k) => (k === cash ? 395.25 : v)) })) };
    expect(reconcile([off], grand).map((x) => x.column)).toContain("E_Cash Tips Recd_Dollars");
  });

  it("a refund of tips already paid is flagged and always the shop's cost (ST-C15)", () => {
    const shopCost = computeLine(input({ tips: 50, lateTipRefunds: 20 }), DEFAULT_PAYROLL_SETTINGS);
    expect(shopCost).toMatchObject({ tips: 50, lateTipRefunds: 20, tipRefundsShopCost: 20 });
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [shopCost.input, input({ staffId: "b3" })] }], DEFAULT_PAYROLL_SETTINGS);
    const flags = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).filter((a) => a.kind === "late_tip_refund");
    expect(flags.map((a) => a.staffId)).toEqual(["b1"]);
    expect(flags[0].message).toMatch(/\$20\.00 is the shop's cost, never taken from their pay/);
  });
});
