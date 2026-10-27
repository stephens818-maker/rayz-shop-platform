import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { periodByIndex, periodOf, periodStarting, calendarProblem, type PayCalendar } from "@/domain/payroll/calendar";
import { dailyHours, largestRemainder, overtimeSlices, sliceKey, splitByLocalDay, weekStartOf, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import {
  DEFAULT_PAYROLL_SETTINGS,
  EXPORT_COLUMNS,
  assemble,
  anomalies,
  computeLine,
  exportRows,
  ftStatus,
  payrollSettings,
  reconcile,
  roundHalfUp2,
  totalsOf,
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

const MAIN: PayCalendar = { anchorStart: "2026-10-18", anchorNumber: 23, periodDays: 14, checkOffsetDays: 6, numberResetsYearly: true };
const DUBUQUE: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 1, periodDays: 14, checkOffsetDays: 6, numberResetsYearly: true };

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

  it("only real period starts open a run; bi-weekly calendars start on Sundays", () => {
    expect(periodStarting(MAIN, "2026-10-18")?.number).toBe(23);
    expect(periodStarting(MAIN, "2026-10-19")).toBeNull();
    expect(calendarProblem({ ...MAIN, anchorStart: "2026-10-19" })).toMatch(/Sunday/);
    expect(calendarProblem(MAIN)).toBeNull();
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

  it("a workweek that spans two pay periods: OT is on the whole week, shared by each period's hours", () => {
    // A weekly calendar starting Wednesdays puts Sun–Tue and Wed–Sat of one workweek in different periods.
    const wed: PayCalendar = { anchorStart: "2026-10-21", anchorNumber: 1, periodDays: 7, checkOffsetDays: 2, numberResetsYearly: false };
    const e = [...days("A", "2026-10-18", 3, 10), ...days("A", "2026-10-21", 2, 10)];
    const o = opts({ periodOf: (_s, d) => periodOf(wed, d).start });
    const slices = overtimeSlices(dailyHours(e), o);
    expect(otBy(slices)).toEqual({ "A@2026-10-14": 600, "A@2026-10-21": 400 });

    // If the first period was locked with no OT before the rest of the week was in, the later period takes all of it.
    const first = slices.find((s) => s.periodStart === "2026-10-14")!;
    const locked = new Map([[sliceKey(first), 0]]);
    expect(otBy(overtimeSlices(dailyHours(e), { ...o, locked }))).toEqual({ "A@2026-10-14": 0, "A@2026-10-21": 1000 });
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
  hourlyRate: 15.5,
  servicePct: 0.4,
  productPct: 0.15,
  trainingRate: null,
  workedHours: 80,
  otHours: 0,
  ptoHours: 0,
  trainingHours: 0,
  serviceSales: 2886.34,
  productSales: 70.98,
  tips: 412.5,
  ...over,
});

describe("workbook line math", () => {
  it("commission over hourly: NetComm is the top-up plus product, Total Wages = hourly + top-up + product", () => {
    const l = computeLine(input({ workedHours: 60 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.hourlyTotal).toBe(60 * 15.5);
    expect(l.commission).toBe(2886.34 * 0.4);
    expect(l.serviceTotal).toBe(2886.34 * 0.4 - 930);
    expect(l.netComm).toBe(2886.34 * 0.4 - 930 + 70.98 * 0.15);
    expect(l.totalWages).toBe(930 + (2886.34 * 0.4 - 930) + 70.98 * 0.15);
    expect(l.laborCost).toBe(l.totalWages);
  });

  it("hourly over commission: NetComm is product only; zero hours gives null Gross/Hr (the workbook's #DIV/0!)", () => {
    const l = computeLine(input({ serviceSales: 500 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.netComm).toBe(70.98 * 0.15);
    expect(l.totalWages).toBe(1240 + 70.98 * 0.15);
    const z = computeLine(input({ workedHours: 0, serviceSales: 0 }), DEFAULT_PAYROLL_SETTINGS);
    expect(z.grossPerHour).toBeNull();
    expect(z.pctOfGross).toBeNull();
  });

  it("OT pay = 1.5 × base rate × OT hours, in labor cost; regular hours are worked minus OT", () => {
    const l = computeLine(input({ workedHours: 85, otHours: 5 }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.hours).toBe(80);
    expect(l.otPay).toBe(1.5 * 15.5 * 5);
    expect(l.laborCost).toBe(l.totalWages + 116.25);
    expect(l.totalWages).toBe(computeLine(input(), DEFAULT_PAYROLL_SETTINGS).totalWages);
  });

  it("training pay at the training rate is labor cost unless switched off", () => {
    const on = computeLine(input({ trainingHours: 3.5, trainingRate: 12 }), DEFAULT_PAYROLL_SETTINGS);
    expect(on.trainingPay).toBe(42);
    expect(on.laborCost).toBe(on.totalWages + 42);
    const off = computeLine(input({ trainingHours: 3.5, trainingRate: 12 }), { ...DEFAULT_PAYROLL_SETTINGS, trainingPayInCost: false });
    expect(off.trainingPay).toBe(0);
    expect(computeLine(input({ trainingHours: 2 }), DEFAULT_PAYROLL_SETTINGS).trainingPay).toBe(31);
  });

  it("a typed-over NetComm goes to the export but is flagged against the formula, never fixed", () => {
    const l = computeLine(input({ serviceSales: 500, overrides: { netComm: { value: 130.66, reason: "carried over" } } }), DEFAULT_PAYROLL_SETTINGS);
    expect(l.netComm).toBe(130.66);
    const { blocks } = assemble([{ shopId: "A", shop: "Shop A", inputs: [l.input] }], DEFAULT_PAYROLL_SETTINGS);
    expect(blocks[0].exportRows[0].values[3]).toBe(130.66);
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).map((a) => a.kind)).toContain("netcomm_gap");
  });

  it("owner rows are flagged, not guessed: hours at $0 cost and sales with no hours", () => {
    const owner = input({ staffId: "o", name: "Owner", hourlyRate: 0, servicePct: 0, productPct: 0, serviceSales: 0, productSales: 0, tips: 0 });
    const sales = input({ staffId: "o2", name: "Owner", workedHours: 0, serviceSales: 20, productSales: 0 });
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
    expect(blocks[0].totals.service).toBe(2886.34 + 1000);
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
    expect(lines[0].otPay).toBe(174.375);
    expect(row.values).not.toContain(lines[0].otPay);
    expect(row.values).not.toContain(lines[0].otPay / 1.5);
    expect(row.values).not.toContain(lines[0].trainingPay);
    // OT pay is in the report's labor cost, not in NetComm (Comm Sales) or tips
    expect(row.values[3]).toBe(lines[0].netComm);
    expect(lines[0].laborCost - lines[0].totalWages).toBe(174.375 + lines[0].trainingPay);
  });

  it("goes out unrounded by default, exactly the computed value", () => {
    const lines = [computeLine(input({ serviceSales: 2886.33, workedHours: 60 }), DEFAULT_PAYROLL_SETTINGS)];
    expect(exportRows(lines, DEFAULT_PAYROLL_SETTINGS)[0].values[3]).toBe(2886.33 * 0.4 - 930 + 70.98 * 0.15);
  });

  it("keys keep their type: numeric keys are numbers, text keys (and leading zeros) stay text", () => {
    const rows = exportRows(
      [input(), input({ employeeNumber: "001234" }), input({ employeeNumber: "1002", keyIsText: true }), input({ employeeNumber: null })].map((i) => computeLine(i, DEFAULT_PAYROLL_SETTINGS)),
      DEFAULT_PAYROLL_SETTINGS,
    );
    expect(rows.map((r) => r.key)).toEqual([1001, 1234, "1002", null]);
  });
});

describe("tips already paid out", () => {
  it("tips paid outside payroll go to E_Cash Tips Recd; those already paid out are marked in a memo column, which can be turned off", () => {
    const lines = [computeLine(input({ tips: 412.5, tipsPaidOut: 300 }), DEFAULT_PAYROLL_SETTINGS)];
    expect(lines[0]).toMatchObject({ tips: 412.5, tipsInPayroll: 0, tipsOutside: 412.5, tipsPaidOut: 300 });
    const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 412.5, tipsPaidOut: 300 })] }], DEFAULT_PAYROLL_SETTINGS);
    expect(blocks[0].exportHeaders).toEqual([...EXPORT_COLUMNS.map((c) => c.header), "M_Tips Paid Out_Dollars"]);
    expect(blocks[0].exportFrom).toEqual(["tipsPaidOut"]);
    expect(blocks[0].exportRows[0].values.slice(2, 3).concat(blocks[0].exportRows[0].values.slice(6))).toEqual([412.5, 300]);
    expect(mismatches).toEqual([]);
    expect(reconcile([{ ...blocks[0], exportRows: blocks[0].exportRows.map((r) => ({ ...r, values: [...r.values.slice(0, 6), 250] })) }], grand).map((m) => m.column)).toContain("Tips paid out");

    const off = { ...DEFAULT_PAYROLL_SETTINGS, markPaidTips: false };
    const plain = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 412.5, tipsPaidOut: 300 })] }], off);
    expect(plain.blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(plain.blocks[0].exportRows[0].values).toHaveLength(EXPORT_COLUMNS.length);
    expect(plain.mismatches).toEqual([]);
    const none = assemble([{ shopId: "A", shop: "Shop A", inputs: [input({ tips: 412.5 })] }], DEFAULT_PAYROLL_SETTINGS);
    expect(none.blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
  });

  it("tips paid through payroll leave E_Cash Tips Recd and get their own column, so nobody is paid twice", () => {
    const inputs = [input({ tips: 412.5, tipsInPayroll: 412.5 }), input({ staffId: "b2", employeeNumber: "1002", tips: 100, tipsPaidOut: 100 })];
    const { blocks, grand, mismatches } = assemble([{ shopId: "A", shop: "Shop A", inputs }], DEFAULT_PAYROLL_SETTINGS);
    expect(blocks[0].exportHeaders).toEqual([...EXPORT_COLUMNS.map((c) => c.header), DEFAULT_PAYROLL_SETTINGS.tipsInPayrollHeader, DEFAULT_PAYROLL_SETTINGS.tipsPaidOutHeader]);
    expect(blocks[0].exportRows.map((r) => [r.values[2], r.values[6], r.values[7]])).toEqual([
      [0, 412.5, 0],
      [100, 0, 100],
    ]);
    expect(grand).toMatchObject({ tips: 512.5, tipsInPayroll: 412.5, tipsOutside: 100, tipsPaidOut: 100 });
    expect(mismatches).toEqual([]);
    expect(reconcile([{ ...blocks[0], exportRows: blocks[0].exportRows.map((r, i) => (i ? r : { ...r, values: [...r.values.slice(0, 6), 400] })) }], grand).map((m) => m.check)).toContain("export");
  });

  it("the column's header is a setting, defaulting until it's confirmed", () => {
    expect(payrollSettings(null).tipsInPayrollHeader).toBe(DEFAULT_PAYROLL_SETTINGS.tipsInPayrollHeader);
    expect(payrollSettings({ tipsInPayrollHeader: "E_Tips_Dollars" }).tipsInPayrollHeader).toBe("E_Tips_Dollars");
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
    expect(roundHalfUp2(224.43300000000005)).toBe(224.43);
    expect(roundHalfUp2(79.93999999999991)).toBe(79.94);
    expect(roundHalfUp2(7)).toBe(7);
  });

  it("applies to every export value when on", () => {
    const s = { ...DEFAULT_PAYROLL_SETTINGS, roundExport2dp: true };
    const [row] = exportRows([computeLine(input({ tips: 6.315, workedHours: 79.935 }), s)], s);
    expect(row.values.slice(0, 3)).toEqual([79.94, 0, 6.32]);
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
});
