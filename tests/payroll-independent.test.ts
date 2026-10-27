import { describe, expect, it } from "vitest";
import { blendedHourly, commissionBetween, hourlyOn, sortVersions, versionOn, type CommissionLine, type CompVersion, type Fallback } from "@/domain/compensation";
import { dailyHours, overtimeSlices, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import { pairPunches, shiftWork, wallInstant, type PunchLike, type PunchType } from "@/domain/time-clock";

/**
 * Checks of the payroll engine that don't come from the workbook or reference_calc.py: every expected
 * number is worked out by hand in the comment next to it, from punches and pay-plan versions, the way
 * the platform gets them in production. People and rates are made up.
 */

const at = (local: string, later = false) => {
  const d = wallInstant(local, later);
  if (!d) throw new Error(`${local} doesn't exist in America/Chicago`);
  return d;
};

let seq = 0;
const punch = (shopId: string, type: PunchType, local: string, later = false): PunchLike => ({ id: `p${++seq}`, staffId: "alex", shopId, type, at: at(local, later) });

/** A day at a shop: in, an optional break, out. */
const day = (shopId: string, date: string, from: string, to: string, brk?: [string, string]): PunchLike[] => [
  punch(shopId, "in", `${date}T${from}`),
  ...(brk ? [punch(shopId, "break_start", `${date}T${brk[0]}`), punch(shopId, "break_end", `${date}T${brk[1]}`)] : []),
  punch(shopId, "out", `${date}T${to}`),
];

const RULES = { unpaidBreakFromMinutes: 30, autoMealMinutes: 0, autoMealAfterHours: 6 };

/** Punches to time entries, as the server's clock source does: each closed shift's paid segments. */
function entries(punches: PunchLike[], rules = RULES): TimeEntry[] {
  const { shifts, problems } = pairPunches(punches);
  expect(problems).toEqual([]);
  return shifts.flatMap((s) => shiftWork(s, rules).segments.map((seg) => ({ staffId: s.staffId, shopId: s.shopId, kind: "worked" as const, startsAt: seg.start, endsAt: seg.end })));
}

const opts = (over: Partial<OtOptions> = {}): OtOptions => ({
  thresholdCenti: 4000,
  trainingCountsTowardOt: true,
  entityOf: (shop) => (shop === "C" ? "Other Inc." : "Ray'z Inc."),
  periodOf: () => "2026-11-08",
  ...over,
});

describe("overtime from punches", () => {
  it("five 9-to-6 days with a 30-minute unpaid lunch are 42.5 hours: 2.5 OT", () => {
    // 9:00–18:00 is 9 h, less the 30-minute lunch (unpaid at 30 minutes or more) = 8.5 h × 5 = 42.5 h.
    const p = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].flatMap((d) => day("A", d, "09:00", "18:00", ["12:00", "12:30"]));
    const [s] = overtimeSlices(dailyHours(entries(p)), opts());
    expect([s.weekStart, s.worked, s.ot]).toEqual(["2026-11-08", 4250, 250]);
  });

  it("a break under the unpaid threshold stays paid; a shift with no break loses the automatic meal", () => {
    // 9:00–17:00 with a 15-minute break: all 8 h paid.
    const [paid] = dailyHours(entries(day("A", "2026-11-09", "09:00", "17:00", ["12:00", "12:15"])));
    expect(paid.worked).toBe(800);
    // 9:00–17:00, no break, 30-minute automatic meal after 6 h: 7.5 h.
    const [meal] = dailyHours(entries(day("A", "2026-11-10", "09:00", "17:00"), { ...RULES, autoMealMinutes: 30 }));
    expect(meal.worked).toBe(750);
  });

  it("hours at two shops of one employer add up before the 40; OT is shared by each shop's hours", () => {
    // Shop A Mon–Fri 42.5 h (as above), Shop B Saturday 10:00–14:00 = 4 h. Week 46.5 h → 6.5 h OT.
    // A: 6.5 × 42.5 / 46.5 = 5.9409 → 5.94; B: 6.5 × 4 / 46.5 = 0.5591 → 0.56 (largest remainder). 5.94 + 0.56 = 6.50.
    const p = [
      ...["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].flatMap((d) => day("A", d, "09:00", "18:00", ["12:00", "12:30"])),
      ...day("B", "2026-11-14", "10:00", "14:00"),
    ];
    const s = overtimeSlices(dailyHours(entries(p)), opts());
    expect(s.map((x) => [x.shopId, x.worked, x.ot])).toEqual([
      ["A", 4250, 594],
      ["B", 400, 56],
    ]);
  });

  it("a shop of a different employer is its own 40", () => {
    // Shop A 42.5 h → 2.5 OT. Shop C (another legal entity) 4 h → none.
    const p = [
      ...["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].flatMap((d) => day("A", d, "09:00", "18:00", ["12:00", "12:30"])),
      ...day("C", "2026-11-14", "10:00", "14:00"),
    ];
    const s = overtimeSlices(dailyHours(entries(p)), opts());
    expect(s.map((x) => [x.shopId, x.ot])).toEqual([
      ["A", 250],
      ["C", 0],
    ]);
    // Configured as one employer, the same punches give 6.5 h shared as above.
    expect(overtimeSlices(dailyHours(entries(p)), opts({ entityOf: () => "Ray'z Inc." })).map((x) => x.ot)).toEqual([594, 56]);
  });

  it("training on top of punches counts toward the 40; training inside a punched shift doesn't count twice", () => {
    const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"].flatMap((d) => day("A", d, "09:00", "18:00", ["12:00", "12:30"]));
    // 34 h punched. Friday 4 h of training off the clock (8:00–12:00): 38 h, no OT.
    const off: TimeEntry = { staffId: "alex", shopId: "B", kind: "training", startsAt: at("2026-11-13T08:00"), endsAt: at("2026-11-13T12:00") };
    // Plus Friday 10 h punched at A (8:00–18:00, no break) with 2 h of training logged inside it (9:00–11:00).
    const inside: TimeEntry = { staffId: "alex", shopId: "A", kind: "training", startsAt: at("2026-11-14T09:00"), endsAt: at("2026-11-14T11:00") };
    const e = [...entries([...week, ...day("A", "2026-11-14", "08:00", "18:00")]), off, inside];
    // Basis: 34 + 10 punched + 4 training off the clock = 48 → 8 h OT. The 2 h inside the shift add nothing.
    const s = overtimeSlices(dailyHours(e), opts());
    expect(s.reduce((a, x) => a + x.ot, 0)).toBe(800);
    expect(s.reduce((a, x) => a + x.basis, 0)).toBe(4800);
    // With the setting off, training counts for nothing: 44 h punched → 4 h OT.
    expect(overtimeSlices(dailyHours(e), opts({ trainingCountsTowardOt: false })).reduce((a, x) => a + x.ot, 0)).toBe(400);
  });
});

describe("DST from punches (America/Chicago)", () => {
  it("fall back: in 8 PM Saturday, out at the second 1:30 AM is 6.5 real hours, split at midnight into two workweeks", () => {
    // 20:00 CDT → 00:00 CDT = 4 h on Sat 10/31. 00:00 CDT → 01:00 CDT → (clocks back) 01:00 CST → 01:30 CST = 2.5 h on Sun 11/1.
    const e = entries([punch("A", "in", "2026-10-31T20:00"), punch("A", "out", "2026-11-01T01:30", true)]);
    expect(dailyHours(e).map((d) => [d.date, d.worked])).toEqual([
      ["2026-10-31", 400],
      ["2026-11-01", 250],
    ]);
    const weeks = overtimeSlices(dailyHours(e), opts({ periodOf: (_s, d) => (d < "2026-11-01" ? "2026-10-25" : "2026-11-01") })).map((s) => [s.weekStart, s.worked]);
    expect(weeks).toEqual([
      ["2026-10-25", 400],
      ["2026-11-01", 250],
    ]);
  });

  it("fall back: out at the first 1:30 AM is 5.5 hours", () => {
    // 20:00 CDT → 01:30 CDT: 4 h Saturday + 1.5 h Sunday.
    const e = entries([punch("A", "in", "2026-10-31T20:00"), punch("A", "out", "2026-11-01T01:30")]);
    expect(dailyHours(e).map((d) => d.worked)).toEqual([400, 150]);
  });

  it("spring forward: in at 1:30 AM, out at 6 AM is 3.5 hours, and 2:30 AM can't be punched", () => {
    // 01:30 CST → 02:00 CST (clocks jump to 03:00 CDT) → 06:00 CDT: 0.5 + 3 = 3.5 h.
    const e = entries([punch("A", "in", "2027-03-14T01:30"), punch("A", "out", "2027-03-14T06:00")]);
    expect(dailyHours(e).map((d) => [d.date, d.worked])).toEqual([["2027-03-14", 350]]);
    expect(wallInstant("2027-03-14T02:30")).toBeNull();
  });

  it("a fall-back week with a 25-hour Sunday: 10 PM Saturday to 9 AM Sunday is 12 real hours", () => {
    // 22:00 CDT → 00:00 = 2 h Saturday; 00:00 → 09:00 CST on a 25-hour day = 10 h Sunday.
    // Then Mon–Thu 9:00–18:00 with a 30-minute lunch, 8.5 h × 4 = 34 h: the week of 11/1 has 44 h → 4 h OT.
    const p = [
      punch("A", "in", "2026-10-31T22:00"),
      punch("A", "out", "2026-11-01T09:00"),
      ...["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].flatMap((d) => day("A", d, "09:00", "18:00", ["12:00", "12:30"])),
    ];
    const s = overtimeSlices(dailyHours(entries(p)), opts({ periodOf: (_s, d) => (d < "2026-11-01" ? "2026-10-25" : "2026-11-01") }));
    expect(s.map((x) => [x.weekStart, x.worked, x.ot])).toEqual([
      ["2026-10-25", 200, 0],
      ["2026-11-01", 4400, 400],
    ]);
  });
});

const version = (effectiveFrom: string, createdAt: string, over: Partial<CompVersion> = {}): CompVersion => ({
  effectiveFrom,
  createdAt,
  hourlyRateCents: null,
  shopHourlyRates: [],
  servicePct: null,
  serviceOverrides: [],
  serviceTiers: [],
  tierMode: "step",
  productPct: null,
  boothRentCents: null,
  boothRentFrequency: null,
  guaranteeCents: null,
  guaranteePer: null,
  tipMethod: null,
  note: null,
  ...over,
});
const fb: Fallback = () => ({ hourlyRate: 12, servicePct: 0.3, productPct: 0.1 });

describe("effective-dated pay rates", () => {
  const v1 = version("2026-10-01", "2026-09-20T12:00:00Z", { hourlyRateCents: 1500, servicePct: 0.4, productPct: 0.15, shopHourlyRates: [{ shopId: "B", cents: 1700 }] });
  const v2 = version("2026-11-11", "2026-11-01T12:00:00Z", { hourlyRateCents: 1600, servicePct: 0.45 });
  // Saved again for the same start date: replaces v2.
  const v2b = version("2026-11-11", "2026-11-02T12:00:00Z", { hourlyRateCents: 1650, servicePct: 0.45, productPct: 0.2 });
  const sorted = sortVersions([v2, v1, v2b]);

  it("the version in effect on a date: none before the first, the later save on a shared start date", () => {
    expect(versionOn(sorted, "2026-09-30")).toBeNull();
    expect(versionOn(sorted, "2026-10-01")).toBe(v1);
    expect(versionOn(sorted, "2026-11-10")).toBe(v1);
    expect(versionOn(sorted, "2026-11-11")).toBe(v2b);
    expect(versionOn(sorted, "2027-01-01")).toBe(v2b);
  });

  it("hourly: the shop's own rate, else the version's, else Payroll setup's", () => {
    expect(hourlyOn(versionOn(sorted, "2026-10-15"), "B", fb)).toBe(17);
    expect(hourlyOn(versionOn(sorted, "2026-10-15"), "A", fb)).toBe(15);
    expect(hourlyOn(versionOn(sorted, "2026-09-15"), "A", fb)).toBe(12);
  });

  it("a raise mid-period blends by hours: 24 h at $15 and 16 h at $16.50 is $15.60", () => {
    // (24 × 15 + 16 × 16.50) / 40 = (360 + 264) / 40 = 15.60
    const days = [
      { date: "2026-11-08", centi: 800 },
      { date: "2026-11-09", centi: 800 },
      { date: "2026-11-10", centi: 800 },
      { date: "2026-11-11", centi: 800 },
      { date: "2026-11-12", centi: 800 },
    ];
    expect(blendedHourly(days, sorted, "A", fb, "2026-11-21")).toBeCloseTo(15.6, 10);
    // No hours: the rate on the period's last day.
    expect(blendedHourly([], sorted, "A", fb, "2026-11-21")).toBe(16.5);
  });

  const line = (date: string, saleDate: string, kind: "service" | "product", netCents: number): CommissionLine => ({
    date,
    saleDate,
    shopId: "A",
    kind,
    refId: null,
    category: null,
    grossCents: Math.max(netCents, 0),
    discountCents: 0,
    refundCents: Math.min(netCents, 0),
    netCents,
  });

  it("each sale earns the rate in effect on its date; a refund takes it back at the original sale's rate", () => {
    const lines = [
      line("2026-11-10", "2026-11-10", "service", 10_000), // $100 at 40% = $40
      line("2026-11-12", "2026-11-12", "service", 20_000), // $200 at 45% = $90
      line("2026-11-13", "2026-11-10", "service", -5_000), // −$50 of the 11/10 sale, at 40% = −$20
      line("2026-11-12", "2026-11-12", "product", 4_000), // $40 at 20% = $8
    ];
    const t = commissionBetween(lines, sorted, fb, "2026-11-08", "2026-11-21").get("A")!;
    expect(t.serviceNetCents).toBe(25_000);
    expect(t.serviceCommissionCents).toBeCloseTo(11_000, 6); // 40 + 90 − 20 = $110
    expect(t.productCommissionCents).toBeCloseTo(800, 6);
  });

  it("a refund in the next period counts there, at the rate the sale earned", () => {
    const lines = [line("2026-11-12", "2026-11-12", "service", 20_000), line("2026-11-23", "2026-11-12", "service", -10_000)];
    const next = commissionBetween(lines, sorted, fb, "2026-11-22", "2026-12-05").get("A")!;
    // −$100 at the 11/12 sale's 45% = −$45, not touching the period the sale was paid in.
    expect(next.serviceCommissionCents).toBeCloseTo(-4_500, 6);
    expect(commissionBetween(lines, sorted, fb, "2026-11-08", "2026-11-21").get("A")!.serviceCommissionCents).toBeCloseTo(9_000, 6);
  });
});
