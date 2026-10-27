/**
 * The payroll spec review's fixes, each checked against figures worked out by hand here (not from
 * reference_calc.py, which only shows the workbook's formulas were copied right). Every name, rate
 * and amount is made up.
 */
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import { dailyHours, overtimeSlices, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import { DEFAULT_PAYROLL_SETTINGS, anomalies, assemble, computeLine, payrollSettings, type LineInput } from "@/domain/payroll/calc";

const at = (local: string) => DateTime.fromISO(local, { zone: "America/Chicago" }).toJSDate();
const shift = (shopId: string, date: string, from: string, to: string, kind: TimeEntry["kind"] = "worked", staffId = "e1"): TimeEntry => ({
  staffId,
  shopId,
  kind,
  startsAt: at(`${date}T${from}`),
  endsAt: at(`${date}T${to}`),
});
const CAL: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 22, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };
const opts = (over: Partial<OtOptions> = {}): OtOptions => ({
  thresholdCenti: 4000,
  trainingCountsTowardOt: true,
  entityOf: () => "Ray'z Inc.",
  periodOf: (_s, d) => periodOf(CAL, d).start,
  ...over,
});
const week = (from: string, n: number, start: string, end: string, shopId = "A", kind: TimeEntry["kind"] = "worked") =>
  Array.from({ length: n }, (_, i) => shift(shopId, DateTime.fromISO(from).plus({ days: i }).toISODate()!, start, end, kind));

const line = (over: Partial<LineInput> = {}): LineInput => ({
  staffId: "e1",
  name: "Alex",
  shopId: "A",
  employeeNumber: "9001",
  keyIsText: false,
  isolvedName: "SAMPLE, ALEX",
  hourlyRate: 12,
  servicePct: 0.5,
  productPct: 0.1,
  trainingRate: null,
  workedHours: 40,
  otHours: 0,
  ptoHours: 0,
  trainingHours: 0,
  serviceSales: 0,
  productSales: 0,
  tips: 0,
  ...over,
});

describe("C2: training on top of clocked hours counts toward overtime", () => {
  it("is on by default and configurable", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.trainingCountsTowardOt).toBe(true);
    expect(payrollSettings({ trainingCountsTowardOt: false }).trainingCountsTowardOt).toBe(false);
  });

  it("38 clocked hours plus a separate 4-hour class is 42: 2 hours of OT, shared 38:4", () => {
    // Mon–Thu 9:00–6:30 (9.5h × 4 = 38h), then a 4-hour class Friday morning.
    const e = [...week("2026-10-05", 4, "09:00", "18:30"), shift("A", "2026-10-09", "09:00", "13:00", "training")];
    const s = overtimeSlices(dailyHours(e), opts());
    expect(s.map((x) => [x.basis, x.ot])).toEqual([[4200, 200]]);
    expect(overtimeSlices(dailyHours(e), opts({ trainingCountsTowardOt: false })).map((x) => [x.basis, x.ot])).toEqual([[3800, 0]]);
  });

  it("training inside clocked time isn't counted twice: a 2-hour session during a 9-hour shift adds nothing", () => {
    // 5 shifts of 9:00–5:00 (8h) = 40h; training 1:00–3:00 on Wednesday, while clocked in.
    const e = [...week("2026-10-05", 5, "09:00", "17:00"), shift("A", "2026-10-07", "13:00", "15:00", "training")];
    const days = dailyHours(e);
    expect(days.find((d) => d.date === "2026-10-07")).toMatchObject({ worked: 800, training: 200, trainingOverlap: 200 });
    expect(overtimeSlices(days, opts()).map((x) => [x.basis, x.ot])).toEqual([[4000, 0]]);
  });

  it("training that runs past clock-out counts only the part after it", () => {
    // 40h clocked; training 4:00–7:00 on Friday, with the shift ending at 5:00: one hour inside it, two on top.
    const e = [...week("2026-10-05", 5, "09:00", "17:00"), shift("A", "2026-10-09", "16:00", "19:00", "training")];
    expect(overtimeSlices(dailyHours(e), opts()).map((x) => [x.basis, x.training, x.trainingOverlap, x.ot])).toEqual([[4200, 300, 100, 200]]);
  });

  it("training at another shop overlapping a shift here is still the same person's time", () => {
    const e = [...week("2026-10-05", 5, "09:00", "17:00", "A"), shift("B", "2026-10-06", "10:00", "11:00", "training")];
    const s = overtimeSlices(dailyHours(e), opts());
    expect(s.reduce((a, x) => a + x.basis, 0)).toBe(4000);
    expect(s.every((x) => x.ot === 0)).toBe(true);
  });

  it("flags training inside clocked hours: it's paid as both", () => {
    const blocks = assemble([{ shopId: "A", shop: "Alpha", inputs: [line({ trainingHours: 2, trainingOverlapHours: 2 })] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).find((a) => a.kind === "training_in_hours")?.message).toMatch(/2h of training falls inside their clocked hours/);
    const clean = assemble([{ shopId: "A", shop: "Alpha", inputs: [line({ trainingHours: 2 })] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    expect(anomalies(clean, DEFAULT_PAYROLL_SETTINGS).filter((a) => a.kind === "training_in_hours")).toEqual([]);
  });
});

describe("C6: overtime comes from the punches; an adjustment can't lower it", () => {
  it("an OT or hours-worked override below the punches is ignored and flagged; one above them is paid", () => {
    const lower = computeLine(line({ workedHours: 45, otHours: 5, overrides: { otHours: { value: 0, reason: "no OT" }, workedHours: { value: 40, reason: "short" } } }), DEFAULT_PAYROLL_SETTINGS);
    expect([lower.otHours, lower.hours, lower.otPay]).toEqual([5, 40, 1.5 * 12 * 5]);
    const blocks = assemble([{ shopId: "A", shop: "Alpha", inputs: [lower.input] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    const flags = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).filter((a) => a.kind === "below_punches");
    expect(flags.map((a) => a.message)).toEqual([
      "Alex (Alpha): Hours worked typed as 40h, below the 45h the punches show. The report pays the punches' 45h; fix the punches on the timesheet if they're wrong.",
      "Alex (Alpha): O.T. hours typed as 0h, below the 5h the punches show. The report pays the punches' 5h; fix the punches on the timesheet if they're wrong.",
    ]);
    const higher = computeLine(line({ workedHours: 45, otHours: 5, overrides: { otHours: { value: 6, reason: "missed punch" } } }), DEFAULT_PAYROLL_SETTINGS);
    expect([higher.otHours, higher.hours]).toEqual([6, 39]);
  });
});
