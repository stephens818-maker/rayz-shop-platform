import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPENSATION_SETTINGS,
  blendedHourly,
  boothRentForDays,
  commissionBetween,
  compensationSettings,
  describePlan,
  exportExtras,
  fieldProblem,
  fieldValue,
  guaranteeForDays,
  guaranteeTopUps,
  lineRate,
  monthEnd,
  monthsBetween,
  sensitiveLabel,
  settingsProblem,
  sortVersions,
  tierCommissionCents,
  tierRate,
  timeline,
  versionOn,
  versionProblem,
  type CommissionLine,
  type CompVersion,
  type Fallback,
  type VersionContext,
} from "@/domain/compensation";
import { DEFAULT_PAYROLL_SETTINGS, EXPORT_COLUMNS, assemble, computeLine, exportHeaders, reconcile, type LineInput } from "@/domain/payroll/calc";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const CUT = "00000000-0000-0000-0000-0000000000c1";
const BEARD = "00000000-0000-0000-0000-0000000000c2";

const version = (o: Partial<CompVersion> = {}): CompVersion => ({
  effectiveFrom: "2026-01-01",
  createdAt: "2026-01-01T00:00:00Z",
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
  ...o,
});

const setup: Fallback = (shopId) => (shopId === B ? { hourlyRate: 14, servicePct: 0.35, productPct: 0.1 } : { hourlyRate: 12, servicePct: 0.3, productPct: 0.15 });

const line = (o: Partial<CommissionLine> & Pick<CommissionLine, "date" | "netCents">): CommissionLine => ({
  saleDate: o.date,
  shopId: A,
  kind: "service",
  refId: CUT,
  category: "Haircuts",
  grossCents: Math.max(0, o.netCents),
  discountCents: 0,
  refundCents: Math.max(0, -o.netCents),
  ...o,
});

const ctx: VersionContext = { today: "2026-03-10", lockedThrough: "2026-02-28", shopIds: [A, B], serviceIds: [CUT, BEARD], categories: ["Haircuts", "Beard"], tipMethods: ["cash", "stripe", "payroll"] };

describe("settings", () => {
  it("are off by default, payroll and the export untouched", () => {
    const s = compensationSettings(undefined);
    expect(s).toEqual(DEFAULT_COMPENSATION_SETTINGS);
    expect(s.enabled).toBe(false);
    expect(s.payrollUsesPlans).toBe(false);
    expect(exportExtras(s)).toEqual([]);
    expect(exportExtras({ ...s, exportColumns: { ...s.exportColumns, serviceCommission: { on: true, header: "X" } } })).toEqual([]);
  });

  it("export columns only when on, in a fixed order, with headers that can't clash", () => {
    const s = compensationSettings({ enabled: true, exportColumns: { hourlyRate: { on: true, header: " Rate " }, serviceCommission: { on: true } } });
    expect(exportExtras(s)).toEqual([
      { header: "E_Service Commission_Dollars", from: "commission" },
      { header: "Rate", from: "wage" },
    ]);
    expect(settingsProblem(s, EXPORT_COLUMNS.map((c) => c.header))).toBeNull();
    expect(settingsProblem({ ...s, guaranteeHeader: "E_Regular_Hours" }, EXPORT_COLUMNS.map((c) => c.header))).toMatch(/already has a column/);
    expect(settingsProblem({ ...s, guaranteeHeader: "rate" }, [])).toMatch(/already has a column/);
  });
});

describe("versions", () => {
  const v1 = version({ effectiveFrom: "2026-01-01", servicePct: 0.4 });
  const v2 = version({ effectiveFrom: "2026-03-15", servicePct: 0.45, createdAt: "2026-03-01T10:00:00Z" });
  const v2b = version({ effectiveFrom: "2026-03-15", servicePct: 0.5, createdAt: "2026-03-01T11:00:00Z" });
  const sorted = sortVersions([v1, v2, v2b]);

  it("the version in effect is the latest start on or before the day; a same-day save replaces the earlier one", () => {
    expect(versionOn(sorted, "2025-12-31")).toBeNull();
    expect(versionOn(sorted, "2026-03-14")).toBe(v1);
    expect(versionOn(sorted, "2026-03-15")).toBe(v2b);
    expect(timeline([v1, v2, v2b], "2026-03-10").map((v) => [v.servicePct, v.status, v.until])).toEqual([
      [0.5, "scheduled", null],
      [0.45, "replaced", null],
      [0.4, "current", "2026-03-14"],
    ]);
  });

  it("a change can't start in or before a locked pay period", () => {
    const ok = { ...v1, effectiveFrom: "2026-03-01" };
    expect(versionProblem(ok, ctx)).toBeNull();
    expect(versionProblem({ ...ok, effectiveFrom: "2026-02-28" }, ctx)).toMatch(/2026-03-01 at the earliest/);
    expect(versionProblem({ ...ok, effectiveFrom: "2029-01-01" }, ctx)).toMatch(/two years/);
  });

  it("checks rates, overrides, tiers, rent, guarantee and tips", () => {
    const ok = { ...v1, effectiveFrom: "2026-03-01" };
    expect(versionProblem({ ...ok, servicePct: 1.2 }, ctx)).toMatch(/0% and 100%/);
    expect(versionProblem({ ...ok, shopHourlyRates: [{ shopId: "00000000-0000-0000-0000-0000000000ff", cents: 1500 }] }, ctx)).toMatch(/doesn't work at/);
    expect(versionProblem({ ...ok, shopHourlyRates: [{ shopId: A, cents: 1500 }, { shopId: A, cents: 1600 }] }, ctx)).toMatch(/one hourly rate/);
    expect(versionProblem({ ...ok, serviceOverrides: [{ kind: "category", ref: "beard", pct: 0.5 }] }, ctx)).toBeNull();
    expect(versionProblem({ ...ok, serviceOverrides: [{ kind: "category", ref: "Color", pct: 0.5 }] }, ctx)).toMatch(/no service category/);
    expect(versionProblem({ ...ok, serviceOverrides: [{ kind: "service", ref: CUT, pct: 0.5 }, { kind: "service", ref: CUT, pct: 0.6 }] }, ctx)).toMatch(/one rate/);
    expect(versionProblem({ ...ok, serviceTiers: [{ fromCents: 500000, pct: 0.45 }, { fromCents: 300000, pct: 0.5 }] }, ctx)).toMatch(/higher monthly/);
    expect(versionProblem({ ...ok, boothRentCents: 25000, boothRentFrequency: null }, ctx)).toMatch(/both an amount/);
    expect(versionProblem({ ...ok, guaranteeCents: 100000, guaranteePer: null }, ctx)).toMatch(/both an amount/);
    expect(versionProblem({ ...ok, tipMethod: "payroll" }, { ...ctx, tipMethods: ["cash"] })).toMatch(/doesn't allow/);
    expect(versionProblem({ ...ok, hourlyRateCents: 60000 }, ctx)).toMatch(/\$500/);
  });

  it("notes can't carry card, SSN or tax ID numbers", () => {
    const ok = { ...v1, effectiveFrom: "2026-03-01" };
    expect(versionProblem({ ...ok, note: "Raise after review" }, ctx)).toBeNull();
    expect(versionProblem({ ...ok, note: "SSN 123-45-6789" }, ctx)).toMatch(/Stripe and iSolved/);
    expect(versionProblem({ ...ok, note: "card 4242 4242 4242 4242" }, ctx)).toMatch(/Stripe and iSolved/);
  });
});

describe("rates", () => {
  it("per service, then per category, then tiers, then the default, then Payroll setup", () => {
    const v = version({
      servicePct: 0.4,
      serviceOverrides: [
        { kind: "service", ref: BEARD, pct: 0.6 },
        { kind: "category", ref: "beard", pct: 0.55 },
      ],
      productPct: 0.2,
    });
    expect(lineRate(v, { kind: "service", refId: BEARD, category: "Beard", shopId: A }, setup)).toEqual({ pct: 0.6, source: "override" });
    expect(lineRate(v, { kind: "service", refId: "other", category: "Beard", shopId: A }, setup)).toEqual({ pct: 0.55, source: "override" });
    expect(lineRate(v, { kind: "service", refId: CUT, category: "Haircuts", shopId: A }, setup)).toEqual({ pct: 0.4, source: "flat" });
    expect(lineRate({ ...v, serviceTiers: [{ fromCents: 0, pct: 0.4 }] }, { kind: "service", refId: CUT, category: "Haircuts", shopId: A }, setup)).toEqual({ source: "tier" });
    expect(lineRate(version(), { kind: "service", refId: CUT, category: null, shopId: B }, setup)).toEqual({ pct: 0.35, source: "flat" });
    expect(lineRate(null, { kind: "product", refId: null, category: null, shopId: A }, setup)).toEqual({ pct: 0.15, source: "product" });
    expect(lineRate(v, { kind: "product", refId: null, category: null, shopId: A }, setup)).toEqual({ pct: 0.2, source: "product" });
  });

  it("an hourly rate per location beats the general one; a mid-period change is hours-weighted", () => {
    const sorted = sortVersions([version({ hourlyRateCents: 1500, shopHourlyRates: [{ shopId: B, cents: 1800 }] }), version({ effectiveFrom: "2026-03-08", hourlyRateCents: 1700 })]);
    const days = [
      { date: "2026-03-02", centi: 800 },
      { date: "2026-03-09", centi: 800 },
    ];
    expect(blendedHourly(days, sorted, A, setup, "2026-03-14")).toBe(16);
    expect(blendedHourly(days.slice(0, 1), sorted, A, setup, "2026-03-14")).toBe(15);
    expect(blendedHourly(days.slice(0, 1), sorted, B, setup, "2026-03-14")).toBe(18);
    expect(blendedHourly([], sorted, A, setup, "2026-03-14")).toBe(17);
    expect(blendedHourly([], [], A, setup, "2026-03-14")).toBe(12);
  });

  it("tiers: step pays the whole month at the tier reached; sliding pays each slice at its rate", () => {
    const tiers = [
      { fromCents: 300000, pct: 0.45 },
      { fromCents: 500000, pct: 0.5 },
    ];
    expect(tierCommissionCents(tiers, "step", 0.4, 200000)).toBe(80000);
    expect(tierCommissionCents(tiers, "step", 0.4, 400000)).toBe(180000);
    expect(tierCommissionCents(tiers, "step", 0.4, 600000)).toBe(300000);
    expect(tierCommissionCents(tiers, "marginal", 0.4, 400000)).toBe(300000 * 0.4 + 100000 * 0.45);
    expect(tierCommissionCents(tiers, "marginal", 0.4, 600000)).toBe(300000 * 0.4 + 200000 * 0.45 + 100000 * 0.5);
    expect(tierCommissionCents(tiers, "marginal", 0.4, -5000)).toBe(-2000);
    expect(tierRate(tiers, "step", 0.4, 0)).toBe(0.4);
    expect(tierRate([{ fromCents: 0, pct: 0.42 }], "step", 0.4, 0)).toBe(0.42);
  });
});

describe("commission", () => {
  it("flat rates per line from the version in effect on the sale's date, net of discounts and refunds", () => {
    const vs = sortVersions([version({ servicePct: 0.4, productPct: 0.2 }), version({ effectiveFrom: "2026-03-10", servicePct: 0.5 })]);
    const lines = [
      line({ date: "2026-03-05", netCents: 4000, grossCents: 5000, discountCents: 1000 }),
      line({ date: "2026-03-12", netCents: 5000 }),
      line({ date: "2026-03-12", netCents: 2000, kind: "product", refId: null, category: null }),
      line({ date: "2026-03-13", saleDate: "2026-03-05", netCents: -4000 }),
      line({ date: "2026-03-13", netCents: 3000, shopId: B }),
    ];
    const c = commissionBetween(lines, vs, setup, "2026-03-01", "2026-03-31");
    const a = c.get(A)!;
    expect(a.serviceGrossCents).toBe(10000);
    expect(a.serviceDiscountCents).toBe(1000);
    expect(a.serviceRefundCents).toBe(4000);
    expect(a.serviceNetCents).toBe(5000);
    expect(a.serviceCommissionCents).toBeCloseTo(4000 * 0.4 + 5000 * 0.5 - 4000 * 0.4, 9);
    // Each version is the whole plan: the March 10 one leaves product % blank, so Payroll setup's 15% applies.
    expect(a.productCommissionCents).toBeCloseTo(300, 9);
    expect(c.get(B)!.serviceCommissionCents).toBeCloseTo(1500, 9);
    expect(a.serviceGrossCents - a.serviceDiscountCents - a.serviceRefundCents).toBe(a.serviceNetCents);
  });

  it("tiers on the month to date: split periods add up to the whole month, and reaching a tier lands in the period it happens", () => {
    const vs = [version({ servicePct: 0.4, serviceTiers: [{ fromCents: 300000, pct: 0.5 }], serviceOverrides: [{ kind: "service", ref: BEARD, pct: 0.6 }] })];
    const lines = [
      line({ date: "2026-03-03", netCents: 200000 }),
      line({ date: "2026-03-05", netCents: 50000, refId: BEARD }),
      line({ date: "2026-03-20", netCents: 100000, shopId: B }),
    ];
    const whole = commissionBetween(lines, vs, setup, "2026-03-01", "2026-03-31");
    const first = commissionBetween(lines, vs, setup, "2026-03-01", "2026-03-14");
    const second = commissionBetween(lines, vs, setup, "2026-03-15", "2026-03-31");
    // Month: 350k service sales reach the 50% tier. The beard line (override) counts toward it but earns its own 60%.
    const total = (m: Map<string, { serviceCommissionCents: number }>) => [...m.values()].reduce((x, t) => x + t.serviceCommissionCents, 0);
    expect(total(whole)).toBeCloseTo(300000 * 0.5 + 50000 * 0.6, 6);
    expect(total(first)).toBeCloseTo(200000 * 0.4 + 50000 * 0.6, 6);
    expect(total(second)).toBeCloseTo(300000 * 0.5 - 200000 * 0.4, 6);
    expect(total(first) + total(second)).toBeCloseTo(total(whole), 6);
    // The catch-up for earlier sales goes where this period's tiered sales were.
    expect(second.get(B)!.serviceCommissionCents).toBeCloseTo(70000, 6);
    expect(second.get(A)?.serviceCommissionCents ?? 0).toBe(0);
  });

  it("sliding tiers across a month boundary start again each month", () => {
    const vs = [version({ servicePct: 0.4, serviceTiers: [{ fromCents: 100000, pct: 0.5 }], tierMode: "marginal" })];
    const lines = [line({ date: "2026-03-30", netCents: 150000 }), line({ date: "2026-04-02", netCents: 50000 })];
    const c = commissionBetween(lines, vs, setup, "2026-03-25", "2026-04-07");
    expect(c.get(A)!.serviceCommissionCents).toBeCloseTo(100000 * 0.4 + 50000 * 0.5 + 50000 * 0.4, 6);
    expect(monthsBetween("2026-03-25", "2026-04-07")).toEqual([
      { start: "2026-03-25", end: "2026-03-31" },
      { start: "2026-04-01", end: "2026-04-07" },
    ]);
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
  });

  it("without a plan, Payroll setup's rates", () => {
    const c = commissionBetween([line({ date: "2026-03-03", netCents: 10000, shopId: B })], [], setup, "2026-03-01", "2026-03-31");
    expect(c.get(B)!.serviceCommissionCents).toBeCloseTo(3500, 9);
  });
});

describe("guarantee and booth rent", () => {
  it("prorates on a 52-week year", () => {
    expect(guaranteeForDays({ cents: 100000, per: "pay_period" }, 14, 14)).toBe(100000);
    expect(guaranteeForDays({ cents: 50000, per: "week" }, 14, 14)).toBe(100000);
    expect(guaranteeForDays({ cents: 260000, per: "month" }, 14, 14)).toBe(120000);
    expect(guaranteeForDays({ cents: 2600000, per: "year" }, 14, 14)).toBe(100000);
    expect(boothRentForDays({ cents: 30000, frequency: "weekly" }, 14)).toBe(60000);
    expect(boothRentForDays({ cents: 30000, frequency: "biweekly" }, 7)).toBe(15000);
    expect(boothRentForDays({ cents: 130000, frequency: "monthly" }, 14)).toBe(60000);
  });

  it("tops up to the minimum across shops, on the shop with the most hours", () => {
    const t = guaranteeTopUps(
      [
        { staffId: "x", shopId: A, earned: 300.1, hours: 20 },
        { staffId: "x", shopId: B, earned: 200, hours: 30 },
        { staffId: "y", shopId: A, earned: 900, hours: 40 },
        { staffId: "z", shopId: A, earned: 10, hours: 1 },
      ],
      (id) => (id === "z" ? null : 800),
    );
    expect([...t.entries()]).toEqual([[`x|${B}`, 299.9]]);
  });

  it("payroll: a top-up is labor cost and its own export column, and the file is unchanged without one", () => {
    const input = (o: Partial<LineInput> = {}): LineInput => ({
      staffId: "x",
      name: "X",
      shopId: A,
      employeeNumber: "12",
      keyIsText: false,
      isolvedName: "X",
      hourlyRate: 10,
      servicePct: 0.4,
      productPct: 0.1,
      trainingRate: null,
      workedHours: 40,
      otHours: 0,
      ptoHours: 0,
      trainingHours: 0,
      serviceSales: 500,
      productSales: 0,
      tips: 0,
      ...o,
    });
    const plain = assemble([{ shopId: A, shop: "A", inputs: [input()] }], DEFAULT_PAYROLL_SETTINGS, { guaranteeHeader: "G" });
    expect(plain.blocks[0].exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(plain.blocks[0].lines[0].laborCost).toBe(400);
    const topped = assemble([{ shopId: A, shop: "A", inputs: [input({ guaranteeTopUp: 100 })] }], DEFAULT_PAYROLL_SETTINGS, {
      guaranteeHeader: "G",
      extras: [
        { header: "SC", from: "commission" },
        { header: "R", from: "wage" },
      ],
    });
    const b = topped.blocks[0];
    expect(b.exportHeaders).toEqual([...EXPORT_COLUMNS.map((c) => c.header), "G", "SC", "R"]);
    expect(b.exportRows[0].values.slice(6)).toEqual([100, 200, 10]);
    expect(b.lines[0].laborCost).toBe(500);
    expect(topped.mismatches).toEqual([]);
    expect(reconcile([{ ...b, exportRows: [{ ...b.exportRows[0], values: [...b.exportRows[0].values.slice(0, 6), 90, 200, 10] }] }], topped.grand).map((m) => m.column)).toEqual(["Guarantee top-up"]);
    expect(reconcile([{ ...b, exportRows: [{ ...b.exportRows[0], values: [...b.exportRows[0].values.slice(0, 7), 150, 10] }] }], topped.grand).map((m) => m.column)).toEqual(["Commission$"]);
    expect(exportHeaders([computeLine(input(), DEFAULT_PAYROLL_SETTINGS)], DEFAULT_PAYROLL_SETTINGS)).toHaveLength(6);
  });
});

describe("custom employee fields", () => {
  it("refuses bank, card, SSN and tax ID fields", () => {
    for (const l of ["SSN", "Social Security #", "Bank name", "Routing number", "Account number", "Card number", "Tax ID", "TIN", "EIN", "Date of birth", "Driver's license", "Passport"]) {
      expect(sensitiveLabel(l), l).toBe(true);
      expect(fieldProblem({ label: l, kind: "text", options: [] }, []), l).toMatch(/Stripe and iSolved/);
    }
    for (const l of ["Shirt size", "Clipper brand", "Start date", "Chair number", "Continuing education hours", "License expires"]) expect(fieldProblem({ label: l, kind: "text", options: [] }, []), l).toBeNull();
    expect(fieldProblem({ label: "Size", kind: "dropdown", options: ["S", "Bank"] }, [])).toMatch(/Stripe and iSolved/);
  });

  it("refuses biometric fields (ST-I17) but not barbershop words that look close", () => {
    for (const l of ["Biometric", "Fingerprint", "Finger print on file", "Thumbprints", "Face scan", "Faceprint", "Face ID", "Facial recognition", "Retina scan", "Iris scan", "Voiceprint", "Hand geometry", "Palm vein"])
      expect(fieldProblem({ label: l, kind: "text", options: [] }, []), l).toMatch(/biometric/);
    expect(fieldProblem({ label: "Clock-in", kind: "dropdown", options: ["PIN", "Fingerprint"] }, [])).toMatch(/biometric/);
    for (const l of ["Facial certified", "Facials", "Iris", "Hand towels", "Face shave", "Beard lineup"]) expect(fieldProblem({ label: l, kind: "text", options: [] }, []), l).toBeNull();
  });

  it("checks names, types and choices", () => {
    expect(fieldProblem({ label: "Shirt size", kind: "text", options: [] }, ["shirt size"])).toMatch(/already/);
    expect(fieldProblem({ label: "Shirt size", kind: "dropdown", options: [] }, [])).toMatch(/1 to 30/);
    expect(fieldProblem({ label: "Shirt size", kind: "dropdown", options: ["S", "s"] }, [])).toMatch(/once/);
    expect(fieldProblem({ label: "Shirt size", kind: "number", options: ["S"] }, [])).toMatch(/Only dropdowns/);
  });

  it("values by type, never a card, SSN or EIN", () => {
    expect(fieldValue({ kind: "text", options: [] }, "  Medium ")).toEqual({ value: "Medium" });
    expect(fieldValue({ kind: "text", options: [] }, "")).toEqual({ value: null });
    expect(fieldValue({ kind: "number", options: [] }, "1,200.5")).toEqual({ value: "1200.5" });
    expect(fieldValue({ kind: "number", options: [] }, "abc")).toEqual({ error: "Enter a number" });
    expect(fieldValue({ kind: "percent", options: [] }, "45%")).toEqual({ value: "45" });
    expect(fieldValue({ kind: "percent", options: [] }, "145")).toMatchObject({ error: expect.stringMatching(/0 to 100/) });
    expect(fieldValue({ kind: "date", options: [] }, "2026-02-30")).toEqual({ error: "Enter a date" });
    expect(fieldValue({ kind: "date", options: [] }, "2026-02-28")).toEqual({ value: "2026-02-28" });
    expect(fieldValue({ kind: "dropdown", options: ["Small", "Large"] }, "large")).toEqual({ value: "Large" });
    expect(fieldValue({ kind: "dropdown", options: ["Small", "Large"] }, "XL")).toEqual({ error: "Pick one of the choices" });
    expect(fieldValue({ kind: "text", options: [] }, "123-45-6789")).toMatchObject({ error: expect.stringMatching(/Stripe and iSolved/) });
    expect(fieldValue({ kind: "number", options: [] }, "4242424242424242")).toMatchObject({ error: expect.stringMatching(/Stripe and iSolved/) });
  });
});

describe("describing a plan", () => {
  it("says what each part is, and what applies where the plan is blank", () => {
    const names = { shop: () => "Moline", service: () => "Cut", tipMethod: (m: string) => m.toUpperCase() };
    expect(describePlan(version(), names)).toEqual([
      { label: "Hourly", value: "Payroll setup's rate" },
      { label: "Service commission", value: "Payroll setup's %" },
      { label: "Product commission", value: "Payroll setup's %" },
    ]);
    const full = version({
      hourlyRateCents: 1550,
      shopHourlyRates: [{ shopId: A, cents: 1600 }],
      servicePct: 0.45,
      serviceOverrides: [
        { kind: "service", ref: CUT, pct: 0.5 },
        { kind: "category", ref: "Beard", pct: 0.4 },
      ],
      serviceTiers: [{ fromCents: 500000, pct: 0.5 }],
      tierMode: "marginal",
      productPct: 0.125,
      boothRentCents: 25000,
      boothRentFrequency: "weekly",
      guaranteeCents: 100000,
      guaranteePer: "pay_period",
      tipMethod: "payroll",
    });
    expect(describePlan(full, names).map((l) => `${l.label}: ${l.value}`)).toEqual([
      "Hourly: $15.50/h",
      "Hourly at Moline: $16.00/h",
      "Service commission: 45%",
      "Cut: 50%",
      "Beard (category): 40%",
      "Tiers (sliding): 50% from $5,000.00",
      "Product commission: 12.5%",
      "Booth rent: $250.00 a week",
      "Guaranteed minimum: $1,000.00 a pay period",
      "Tips paid by: PAYROLL",
    ]);
  });
});
