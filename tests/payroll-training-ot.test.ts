/**
 * Q11 answered (Charles): training hours are on top of clocked production hours. Production plus
 * training over 40 in a Chicago Sun–Sat workweek is overtime, every shop added up, and each shop's
 * share of it counts the training there. Training pay is training hours × the flat training rate,
 * outside the greater-of; OT goes out as E_Overtime 1.5_Hours, the format unchanged; training's cost
 * and its share of the OT cost are in labor cost, and the gate checks them. This rests on training
 * being hours worked under the FLSA, the CPA's to confirm.
 */
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAYROLL_SETTINGS, assemble, computeLine, employeePay, reconcile, regularRateAdjustments, toCents, totalsOf, type LineInput, type PayrollSettings } from "@/domain/payroll/calc";
import { dailyHours, overtimeSlices, trainingOtCenti, type OtOptions, type Slice, type TimeEntry } from "@/domain/payroll/overtime";

const at = (local: string) => DateTime.fromISO(local, { zone: "America/Chicago" }).toJSDate();
const entry = (shopId: string, date: string, from: string, to: string, kind: TimeEntry["kind"] = "worked"): TimeEntry => ({ staffId: "e1", shopId, kind, startsAt: at(`${date}T${from}`), endsAt: at(`${date}T${to}`) });
const opts = (over: Partial<OtOptions> = {}): OtOptions => ({ thresholdCenti: 4000, trainingCountsTowardOt: true, entityOf: () => "Ray'z Inc.", periodOf: () => "2026-10-04", ...over });
// Mon–Thu 9:00–6:30 is 38 production hours in the workweek of Sunday Oct 4, 2026.
const production = (shopId = "A") => ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => entry(shopId, d, "09:00", "18:30"));

/** A slice's figures as the Payroll Report's line input, as buildPayroll makes it. */
const inputOf = (s: Slice, o: Pick<OtOptions, "trainingCountsTowardOt">, over: Partial<LineInput> = {}): LineInput => ({
  staffId: s.staffId,
  name: "Alex",
  shopId: s.shopId,
  employeeNumber: "9001",
  keyIsText: false,
  isolvedName: "SAMPLE, ALEX",
  hourlyRate: 15,
  servicePct: 0.4,
  productPct: 0.1,
  trainingRate: 10,
  workedHours: s.worked / 100,
  otHours: s.ot / 100,
  ptoHours: 0,
  trainingHours: s.training / 100,
  trainingOtHours: trainingOtCenti(s, o) / 100,
  serviceSales: 0,
  productSales: 0,
  tips: 0,
  ...over,
});

const run = (entries: TimeEntry[], s: PayrollSettings = DEFAULT_PAYROLL_SETTINGS, over: Partial<LineInput> = {}) => {
  const slices = overtimeSlices(dailyHours(entries), opts({ trainingCountsTowardOt: s.trainingCountsTowardOt }));
  const shops = [...new Set(slices.map((x) => x.shopId))].sort();
  return assemble(
    shops.map((shopId) => ({ shopId, shop: shopId === "A" ? "Coralville" : "Moline", inputs: slices.filter((x) => x.shopId === shopId).map((x) => inputOf(x, s, over)) })),
    s,
  );
};

describe("golden: 38 production hours + 4 training hours = 2 OT hours", () => {
  const entries = [...production(), entry("A", "2026-10-09", "09:00", "13:00", "training")];

  it("OT is the 2 hours over 40, out of regular hours; all 4 training hours are paid at the training rate", () => {
    const { blocks, mismatches } = run(entries);
    const l = blocks[0].lines[0];
    expect(l).toMatchObject({ otHours: 2, hours: 36, trainingHours: 4, trainingPay: 40, otPay: 45, hourlyTotal: 540 });
    expect(l.otFromTraining ?? 0).toBe(0);
    expect(l.hours + l.otHours + l.trainingHours).toBe(42);
    expect(mismatches).toEqual([]);
  });

  it("the iSolved file: 36 regular, 2 in E_Overtime 1.5_Hours, 4 training, the same 6 columns", () => {
    const b = run(entries).blocks[0];
    expect(b.exportHeaders).toEqual(["E_Regular_Hours", "E_Overtime 1.5_Hours", "E_Cash Tips Recd_Dollars", "E_Comm Sales_Dollars", "E_Ray'z Paid Time_Hours", "E_Training_Hours"]);
    expect(b.exportRows[0].values).toEqual([36, 2, 0, 0, 0, 4]);
  });

  it("training cost is its pay and its share of the OT cost, inside labor cost: 4 of the 42 hours carry 4/42 of the 2 OT hours", () => {
    const l = run(entries).blocks[0].lines[0];
    expect(l.trainingOtHours).toBeCloseTo((2 * 4) / 42, 9);
    expect(l.trainingOtPay).toBeCloseTo(1.5 * 15 * ((2 * 4) / 42), 9);
    expect(l.trainingCost).toBeCloseTo(40 + 1.5 * 15 * ((2 * 4) / 42), 9);
    expect(l.laborCost).toBe(540 + 45 + 40);
  });

  it("with the setting off (only on the CPA's advice), training is out of the 40: no OT, and training cost is its pay", () => {
    const off = { ...DEFAULT_PAYROLL_SETTINGS, trainingCountsTowardOt: false };
    const l = run(entries, off).blocks[0].lines[0];
    expect(l).toMatchObject({ otHours: 0, hours: 38, trainingHours: 4, trainingOtHours: 0, trainingOtPay: 0, trainingCost: 40 });
  });

  it("commission's regular-rate half-time is spread over all 42 hours worked, training included", () => {
    const { blocks } = run(entries, DEFAULT_PAYROLL_SETTINGS, { serviceSales: 2000 });
    const l = blocks[0].lines[0];
    // Commission 800 against 540 hourly: 260 above it over 42 hours, half-time on the 2 OT hours.
    const rr = regularRateAdjustments([l], DEFAULT_PAYROLL_SETTINGS);
    expect(rr.get("e1|A")).toBeCloseTo(0.5 * 2 * (260 / 42), 9);
    expect(regularRateAdjustments([l], { otMultiplier: 1.5, trainingCountsTowardOt: false }).get("e1|A")).toBeCloseTo(0.5 * 2 * (260 / 38), 9);
  });
});

describe("the default, with a control (Q11; pending CPA confirmation)", () => {
  it("training counts toward weekly OT unless a brand turns it off", () => {
    expect(DEFAULT_PAYROLL_SETTINGS.trainingCountsTowardOt).toBe(true);
  });

  it("38 production + 4 training in the same Sun–Sat week: 2 OT hours, with the default settings", () => {
    const entries = [...production(), entry("A", "2026-10-10", "09:00", "13:00", "training")];
    const slices = overtimeSlices(dailyHours(entries), opts({ trainingCountsTowardOt: DEFAULT_PAYROLL_SETTINGS.trainingCountsTowardOt }));
    expect(slices.map((s) => [s.weekStart, s.basis, s.ot])).toEqual([["2026-10-04", 4200, 200]]);
    expect(run(entries).blocks[0].lines[0]).toMatchObject({ otHours: 2, hours: 36, trainingHours: 4, trainingPay: 40 });
  });

  it("control: the same 4 training hours in the next week (Monday Oct 12) give 0 OT; each week is under 40", () => {
    const entries = [...production(), entry("A", "2026-10-12", "09:00", "13:00", "training")];
    const slices = overtimeSlices(dailyHours(entries), opts({ trainingCountsTowardOt: DEFAULT_PAYROLL_SETTINGS.trainingCountsTowardOt }));
    expect(slices.map((s) => [s.weekStart, s.basis, s.ot])).toEqual([
      ["2026-10-04", 3800, 0],
      ["2026-10-11", 400, 0],
    ]);
    // One line per workweek here (buildPayroll adds a shop's weeks into one line).
    const lines = run(entries).blocks[0].lines;
    const total = (k: "otHours" | "hours" | "trainingHours" | "trainingPay" | "otPay" | "trainingOtHours") => lines.reduce((s, l) => s + l[k], 0);
    expect({ otHours: total("otHours"), hours: total("hours"), trainingHours: total("trainingHours"), trainingPay: total("trainingPay"), otPay: total("otPay"), trainingOtHours: total("trainingOtHours") }).toEqual({ otHours: 0, hours: 38, trainingHours: 4, trainingPay: 40, otPay: 0, trainingOtHours: 0 });
  });

  it("training pay stays at its flat rate, outside the greater-of, whichever side wins and wherever the hours fall", () => {
    for (const day of ["2026-10-10", "2026-10-12"]) {
      const entries = [...production(), entry("A", day, "09:00", "13:00", "training")];
      for (const serviceSales of [0, 2000]) {
        const lines = run(entries, DEFAULT_PAYROLL_SETTINGS, { serviceSales }).blocks[0].lines;
        expect(lines.reduce((s, l) => s + l.trainingPay, 0), `${day} ${serviceSales}`).toBe(40);
        for (const l of lines) {
          const p = employeePay(l);
          expect(l.trainingPay, `${day} ${serviceSales}`).toBe(l.trainingHours * 10);
          expect(l.totalWages, `${day} ${serviceSales}`).toBe(Math.max(l.hourlyTotal, l.commission));
          expect(p.greaterOfCents, `${day} ${serviceSales}`).toBe(toCents(Math.max(l.hourlyTotal, l.commission)));
          expect(p.wagesCents, `${day} ${serviceSales}`).toBe(p.greaterOfCents + p.trainingPayCents + p.overtimePayCents);
        }
      }
    }
  });
});

describe("golden: training hours at a second shop", () => {
  // 38 production hours at Coralville, then a 4-hour class at Moline on Saturday.
  const entries = [...production("A"), entry("B", "2026-10-10", "09:00", "13:00", "training")];

  it("the 2 OT hours are shared 38:4 by hours, training counted: 1.81 at Coralville, 0.19 at Moline", () => {
    const { blocks, mismatches } = run(entries);
    const [a, b] = blocks.map((x) => x.lines[0]);
    expect([a.otHours, b.otHours]).toEqual([1.81, 0.19]);
    expect([a.hours, a.trainingHours]).toEqual([36.19, 0]);
    expect(mismatches).toEqual([]);
    // Moline's 0.19 OT hours can only come off the training there: no clocked hours to take them from.
    expect(b).toMatchObject({ hours: 0, otFromTraining: 0.19, trainingOtHours: 0.19 });
    expect(b.trainingHours).toBeCloseTo(3.81, 9);
    expect([a, b].reduce((s, l) => s + l.hours + l.otHours + l.trainingHours, 0)).toBeCloseTo(42, 9);
  });

  it("each shop's file carries its own hours, the format unchanged", () => {
    const { blocks } = run(entries);
    expect(blocks[0].exportRows[0].values).toEqual([36.19, 1.81, 0, 0, 0, 0]);
    expect(blocks[1].exportRows[0].values.map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.19, 0, 0, 0, 3.81]);
  });

  it("training cost lands at Moline: training pay there and its OT share; Coralville's OT has no training in it", () => {
    const { blocks, grand } = run(entries);
    const [a, b] = blocks.map((x) => x.lines[0]);
    expect([a.trainingOtHours, a.trainingCost]).toEqual([0, 0]);
    expect(b.trainingPay).toBeCloseTo(38.1, 9);
    expect(b.trainingOtPay).toBeCloseTo(1.5 * 15 * 0.19, 9);
    expect(grand.trainingCost).toBeCloseTo(38.1 + 1.5 * 15 * 0.19, 9);
    expect(grand.laborCost).toBeCloseTo(a.laborCost + b.laborCost, 9);
  });
});

describe("the gate checks training cost", () => {
  it("a Training Cost that isn't Training Pay + its OT share, or a share over the OT, blocks the lock", () => {
    const entries = [...production(), entry("A", "2026-10-09", "09:00", "13:00", "training")];
    const { blocks, grand } = run(entries);
    const line = blocks[0].lines[0];
    const tampered = [{ ...blocks[0], lines: [{ ...line, trainingCost: line.trainingCost + 1, trainingOtPay: line.otPay + 1 }] }];
    tampered[0].totals = { ...tampered[0].totals, trainingCost: tampered[0].lines[0].trainingCost, trainingOtPay: tampered[0].lines[0].trainingOtPay };
    const details = reconcile(tampered, { ...grand, trainingCost: tampered[0].totals.trainingCost }).map((m) => m.detail);
    expect(details).toContain("Coralville: training's share of overtime is more than the overtime (Alex)");
  });

  it("training cost is summed and checked like every column", () => {
    const entries = [...production(), entry("A", "2026-10-09", "09:00", "13:00", "training")];
    const { blocks, grand } = run(entries);
    const off = [{ ...blocks[0], totals: { ...blocks[0].totals, trainingCost: blocks[0].totals.trainingCost + 1 } }];
    expect(reconcile(off, grand).map((m) => `${m.column} ${m.check}`)).toEqual(expect.arrayContaining(["Training Cost rows", "Training Cost locations"]));
  });

  it("a line locked before training cost was split out (no trainingCost on it) still passes", () => {
    const entries = [...production(), entry("A", "2026-10-09", "09:00", "13:00", "training")];
    const { blocks } = run(entries);
    const { trainingCost: _c, trainingOtPay: _p, trainingOtHours: _h, ...old } = blocks[0].lines[0];
    const { trainingCost: _tc, trainingOtPay: _tp, trainingOtHours: _th, ...totals } = blocks[0].totals;
    const legacy = [{ ...blocks[0], lines: [old as typeof blocks[0]["lines"][0]], totals: totals as typeof blocks[0]["totals"] }];
    expect(reconcile(legacy, totalsOf(legacy.map((b) => b.totals)))).toEqual([]);
  });
});

describe("hours with no workweeks (typed, or from Squire): the period's figures give training's OT share", () => {
  it("OT × training ÷ (worked + training) at the shop", () => {
    const l = computeLine(
      { ...inputOf({ staffId: "e1", shopId: "A", worked: 8200, training: 400, ot: 200, basis: 0, trainingOverlap: 0 } as Slice, DEFAULT_PAYROLL_SETTINGS), trainingOtHours: undefined },
      DEFAULT_PAYROLL_SETTINGS,
    );
    expect(l.trainingOtHours).toBeCloseTo((2 * 4) / 86, 9);
  });

  it("training inside clocked time isn't on top, so it carries no OT share", () => {
    const l = computeLine({ ...inputOf({ staffId: "e1", shopId: "A", worked: 4200, training: 200, ot: 200, basis: 0, trainingOverlap: 0 } as Slice, DEFAULT_PAYROLL_SETTINGS), trainingOtHours: undefined, trainingOverlapHours: 2 }, DEFAULT_PAYROLL_SETTINGS);
    expect(l.trainingOtHours).toBe(0);
  });
});
