/**
 * The payroll spec review's fixes, each checked against figures worked out by hand here (not from
 * reference_calc.py, which only shows the workbook's formulas were copied right). Every name, rate
 * and amount is made up.
 */
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import { dailyHours, overtimeSlices, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import {
  DEFAULT_PAYROLL_SETTINGS,
  EXPORT_COLUMNS,
  anomalies,
  assemble,
  computeLine,
  exportHeaders,
  exportRows,
  payrollSettings,
  regularRateAdjustments,
  retroOtPremiumFor,
  type LineInput,
} from "@/domain/payroll/calc";

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

describe("I4: refunds come off the period's commission before the greater-of; below zero is written off", () => {
  // $12/h × 40h = $480 hourly. Service commission 50%, product 10%.
  it("a refund in a top-up period lowers the top-up: $1,000 of service is a $20 top-up, $800 after a $200 refund is none", () => {
    const before = computeLine(line({ serviceSales: 1000 }), DEFAULT_PAYROLL_SETTINGS);
    expect([before.commission, before.serviceTotal, before.netComm, before.totalWages]).toEqual([500, 20, 20, 500]);
    const after = computeLine(line({ serviceSales: 800 }), DEFAULT_PAYROLL_SETTINGS);
    expect([after.commission, after.serviceTotal, after.netComm, after.totalWages, after.commissionWrittenOff]).toEqual([400, -80, 0, 480, 0]);
  });

  it("a refund in an hourly period changes nothing they're paid: $300 or $200 of service is $480 either way", () => {
    for (const service of [300, 200]) expect(computeLine(line({ serviceSales: service }), DEFAULT_PAYROLL_SETTINGS)).toMatchObject({ netComm: 0, totalWages: 480 });
  });

  it("refunds bigger than the period's sales leave commission at $0.00, never negative, and the rest is written off and flagged", () => {
    const l = computeLine(line({ serviceSales: -100, productSales: -20 }), DEFAULT_PAYROLL_SETTINGS);
    expect([l.commission, l.productTotal, l.netComm, l.totalWages, l.commissionWrittenOff]).toEqual([0, 0, 0, 480, 52]);
    const blocks = assemble([{ shopId: "A", shop: "Alpha", inputs: [l.input] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).find((a) => a.kind === "refund_written_off")?.message).toBe(
      "Alex (Alpha): refunds this period came to more than the commission they'd earned, by $52.00. Commission is $0.00 (never negative) and the $52.00 is written off: the shop absorbs it and it's never taken from a later check.",
    );
  });

  it("a product refund bigger than product sales doesn't eat into a service top-up", () => {
    const l = computeLine(line({ serviceSales: 1200, productSales: -50 }), DEFAULT_PAYROLL_SETTINGS);
    expect([l.serviceTotal, l.productTotal, l.netComm, l.totalWages, l.commissionWrittenOff]).toEqual([120, 0, 120, 600, 5]);
  });
});

describe("C1: overtime on commission (the FLSA regular rate)", () => {
  // Alex: 45h at two shops, 5h OT (3 at A, 2 at B), $12/h. At A: $1,200 service (top-up $120 over A's hourly) and $100 product ($10).
  const a = computeLine(line({ workedHours: 27, otHours: 3, serviceSales: 1200, productSales: 100 }), DEFAULT_PAYROLL_SETTINGS);
  const b = computeLine(line({ shopId: "B", workedHours: 18, otHours: 2 }), DEFAULT_PAYROLL_SETTINGS);

  it("is 0.5 × each shop's OT hours × the commission over all hours worked, across shops", () => {
    // A's hourly = 24h × $12 = $288; top-up = $600 − $288 = $312; product $10. ($312 + $10) / 45h = $7.1555…/h.
    expect([a.serviceTotal, a.productTotal]).toEqual([312, 10]);
    const adj = regularRateAdjustments([a, b], DEFAULT_PAYROLL_SETTINGS);
    expect(adj.get("e1|A")).toBeCloseTo(0.5 * 3 * (322 / 45), 10);
    expect(adj.get("e1|B")).toBeCloseTo(0.5 * 2 * (322 / 45), 10);
    expect((adj.get("e1|A") ?? 0) + (adj.get("e1|B") ?? 0)).toBeCloseTo(17.89, 2);
  });

  it("is nothing with no OT or no commission", () => {
    expect(regularRateAdjustments([computeLine(line({ serviceSales: 2000 }), DEFAULT_PAYROLL_SETTINGS)], DEFAULT_PAYROLL_SETTINGS).size).toBe(0);
    expect(regularRateAdjustments([computeLine(line({ workedHours: 45, otHours: 5 }), DEFAULT_PAYROLL_SETTINGS)], DEFAULT_PAYROLL_SETTINGS).size).toBe(0);
  });

  it("the switch is off by default: the iSolved file keeps its six columns, the amount is labor cost and flagged to enter by hand", () => {
    const i = { ...a.input, otRegularRateAdj: 10.73 };
    const l = computeLine(i, DEFAULT_PAYROLL_SETTINGS);
    expect([l.otPremiumOwed, l.otPremiumAdj]).toEqual([10.73, 0]);
    expect(l.laborCost).toBeCloseTo(l.totalWages + l.otPay + l.trainingPay + 10.73, 10);
    expect(exportHeaders([l], DEFAULT_PAYROLL_SETTINGS)).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    const blocks = assemble([{ shopId: "A", shop: "Alpha", inputs: [i] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).find((x) => x.kind === "ot_regular_rate")?.message).toMatch(/\$10\.73 more is owed\. Enter it in iSolved by hand/);
  });

  it("switched on, the file gets the adjustment column (a format change, Needs Charles)", () => {
    const s = payrollSettings({ otRegularRate: "adjust" });
    const l = computeLine({ ...a.input, otRegularRateAdj: 10.73 }, s);
    expect(exportHeaders([l], s)).toEqual([...EXPORT_COLUMNS.map((c) => c.header), "E_OT Premium Adj_Dollars"]);
    expect(exportRows([l], s)[0].values.at(-1)).toBe(10.73);
    const r = assemble([{ shopId: "A", shop: "Alpha", inputs: [l.input] }], s);
    expect(r.mismatches).toEqual([]);
    expect(anomalies(r.blocks, s).filter((x) => x.kind === "ot_regular_rate")).toEqual([]);
  });
});

describe("I2: commission owed for a locked period", () => {
  it("adds half-time on that period's overtime: 0.5 × 4 OT hours × $90 ÷ 44 hours worked = $4.09", () => {
    expect(retroOtPremiumFor(90, { hours: 40, otHours: 4 }, DEFAULT_PAYROLL_SETTINGS)).toBeCloseTo(4.0909, 4);
    expect(retroOtPremiumFor(90, { hours: 38, otHours: 0 }, DEFAULT_PAYROLL_SETTINGS)).toBe(0);
    expect(retroOtPremiumFor(90, null, DEFAULT_PAYROLL_SETTINGS)).toBe(0);
  });

  it("is paid in this period's Comm Sales and Total Wages; the retro OT premium is owed and flagged", () => {
    const l = computeLine(line({ lateCommissions: [{ earnedStart: "2026-10-04", earnedEnd: "2026-10-17", amount: 90, reason: "missed credit", retroOtPremium: 4.09 }] }), DEFAULT_PAYROLL_SETTINGS);
    expect([l.netComm, l.totalWages, l.lateCommission, l.otPremiumOwed]).toEqual([90, 570, 90, 4.09]);
    expect(exportRows([l], DEFAULT_PAYROLL_SETTINGS)[0].values[3]).toBe(90);
    const blocks = assemble([{ shopId: "A", shop: "Alpha", inputs: [l.input] }], DEFAULT_PAYROLL_SETTINGS).blocks;
    expect(anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).find((x) => x.kind === "late_commission")?.message).toBe(
      "Alex (Alpha): $90.00 of commission earned 2026-10-04 to 2026-10-17, already locked, is paid in this period's Comm Sales (missed credit). It adds $4.09 of half-time to that period's overtime.",
    );
  });
});
