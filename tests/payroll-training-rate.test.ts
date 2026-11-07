import { describe, expect, it } from "vitest";
import { trainingRateFor, trainingRateOn, trainingRateProblem, sortTrainingRates } from "@/domain/payroll/training-rate";

const versions = [
  { effectiveFrom: "2026-10-01", rateCents: 1000 },
  { effectiveFrom: "2026-11-08", rateCents: 1250 },
];
const base = { versions, setupRate: null, hourlyRate: 15, end: "2026-11-14" };

describe("training rate, effective-dated per employee (Charles, Oct 28)", () => {
  it("the version in effect on a date", () => {
    const sorted = sortTrainingRates(versions);
    expect(trainingRateOn(sorted, "2026-09-30")).toBeNull();
    expect(trainingRateOn(sorted, "2026-10-01")?.rateCents).toBe(1000);
    expect(trainingRateOn(sorted, "2026-11-07")?.rateCents).toBe(1000);
    expect(trainingRateOn(sorted, "2026-11-08")?.rateCents).toBe(1250);
  });

  it("one rate in the period: that rate; changed mid-period: each day's training at that day's rate, hours-weighted, and mixed", () => {
    expect(trainingRateFor({ ...base, days: [{ date: "2026-11-02", centi: 400 }] })).toEqual({ rate: 10, source: "staff", mixed: false });
    const r = trainingRateFor({ ...base, days: [{ date: "2026-11-02", centi: 400 }, { date: "2026-11-09", centi: 200 }] });
    expect(r.mixed).toBe(true);
    expect(r.rate! * 6).toBeCloseTo(4 * 10 + 2 * 12.5, 10);
  });

  it("no training days (typed on the report or a Squire import): the rate on the period's last day", () => {
    expect(trainingRateFor({ ...base, days: [] })).toEqual({ rate: 12.5, source: "staff", mixed: false });
  });

  it("falls back to Payroll setup's training rate, then the hourly rate (flagged as hourly)", () => {
    expect(trainingRateFor({ ...base, versions: [], setupRate: 11, days: [{ date: "2026-11-02", centi: 100 }] })).toEqual({ rate: 11, source: "payroll_setup", mixed: false });
    expect(trainingRateFor({ ...base, versions: [], days: [{ date: "2026-11-02", centi: 100 }] })).toEqual({ rate: null, source: "hourly", mixed: false });
    const part = trainingRateFor({ ...base, versions: [{ effectiveFrom: "2026-11-08", rateCents: 1250 }], days: [{ date: "2026-11-02", centi: 100 }, { date: "2026-11-09", centi: 100 }] });
    expect(part).toMatchObject({ source: "hourly", mixed: true });
    expect(part.rate).toBeCloseTo((15 + 12.5) / 2, 10);
  });

  it("a new version starts after the last locked pay period, at $0 to $500 an hour, one per day", () => {
    const c = { lockedThrough: "2026-10-31", existing: versions };
    expect(trainingRateProblem({ effectiveFrom: "2026-10-31", rateCents: 1100 }, c)).toMatch(/after the last locked pay period/);
    expect(trainingRateProblem({ effectiveFrom: "2026-11-08", rateCents: 1100 }, c)).toMatch(/already a training rate/);
    expect(trainingRateProblem({ effectiveFrom: "2026-11-09", rateCents: 50_001 }, c)).toMatch(/\$0 to \$500/);
    expect(trainingRateProblem({ effectiveFrom: "2026-11-09", rateCents: 10.5 }, c)).toMatch(/\$0 to \$500/);
    expect(trainingRateProblem({ effectiveFrom: "2026-02-30", rateCents: 1100 }, c)).toMatch(/Pick the date/);
    expect(trainingRateProblem({ effectiveFrom: "2026-11-09", rateCents: 1100 }, c)).toBeNull();
  });
});
