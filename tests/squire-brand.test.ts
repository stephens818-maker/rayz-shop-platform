import { describe, expect, it } from "vitest";
import { REPORTS, ROLE_TEMPLATES, isPermission, type Permission } from "@/domain/permissions";
import { MATRIX_ACTIONS, MATRIX_AREAS, MATRIX_PERMISSIONS, cellOverride, cellState, nextOverride, setCell } from "@/domain/permission-matrix";
import { REPORT_GROUP, REPORT_GROUPS, groupReports } from "@/domain/report-groups";
import { lastBusinessDay, presetRange } from "@/domain/report-range";
import { ANALYTICS_PERIODS, comparePeriod, periodChange, yearBefore } from "@/domain/period-compare";
import { WATERFALL, waterfallGap } from "@/domain/sales-waterfall";
import { matchesFilters, parseAppointmentFilters, paymentOf, platformOf } from "@/domain/appointment-report";

describe("report navigation and defaults", () => {
  it("puts every report in one category, in category order", () => {
    for (const r of REPORTS) expect(REPORT_GROUPS.some((g) => g.id === REPORT_GROUP[r.key]), r.key).toBe(true);
    const groups = groupReports(REPORTS);
    expect(groups.flatMap((g) => g.reports).length).toBe(REPORTS.length);
    expect(groups.map((g) => g.id)).toEqual(REPORT_GROUPS.map((g) => g.id));
    expect(groupReports(REPORTS.filter((r) => r.key === "my_sales")).map((g) => g.id)).toEqual(["sales"]);
  });

  it("the last business day skips Sundays: Monday opens on Saturday", () => {
    expect(lastBusinessDay("2026-10-26")).toBe("2026-10-24"); // Monday → Saturday
    expect(lastBusinessDay("2026-10-25")).toBe("2026-10-24"); // Sunday → Saturday
    expect(lastBusinessDay("2026-10-28")).toBe("2026-10-27"); // Wednesday → Tuesday
    expect(lastBusinessDay("2026-10-27", [0, 1])).toBe("2026-10-24"); // closed Mondays too
    expect(presetRange("lastday", "2026-10-26")).toEqual({ from: "2026-10-24", to: "2026-10-24" });
    expect(presetRange("4w", "2026-10-26")).toEqual({ from: "2026-09-29", to: "2026-10-26" });
  });
});

describe("sales waterfall", () => {
  const x = { grossSalesCents: 100_00, refundCents: 10_00, discountCents: 5_00, taxCents: 6_00, tipsCents: 15_00, cardFeeCents: 2_00, giftCardsSoldCents: 25_00, giftCardCents: 20_00, cardCents: 90_00, cashCents: 23_00 };
  const at = (label: string) => WATERFALL.find((w) => w.label === label)!.value(x);

  it("adds up from gross to collected, with card fees apart from tax", () => {
    expect(at("= Net sales")).toBe(85_00);
    expect(at("= Total paid")).toBe(85_00 + 6_00 + 15_00 + 2_00 + 25_00);
    expect(at("= Collected")).toBe(113_00);
    expect(waterfallGap(x)).toBe(0);
    expect(waterfallGap({ ...x, cashCents: 20_00 })).toBe(-3_00);
    expect(WATERFALL.map((w) => w.label).indexOf("+ Taxes")).toBeLessThan(WATERFALL.map((w) => w.label).indexOf("+ Card fees paid by clients"));
  });
});

describe("appointments report filters", () => {
  it("maps booking source to platform and payments to a payment label", () => {
    expect(platformOf("online")).toBe("web");
    expect(platformOf("api")).toBe("app");
    expect(platformOf("walk_in")).toBe("in_shop");
    expect(platformOf("import")).toBe("import");
    expect(paymentOf(null)).toBe("unpaid");
    expect(paymentOf(["cash"])).toBe("cash");
    expect(paymentOf(["card", "gift_card"])).toBe("split");
  });

  it("filters on status, method, platform and payment; unknown values are ignored", () => {
    const f = parseAppointmentFilters({ status: "completed", method: "online", platform: "bogus", payment: "gift_card" });
    expect(f).toEqual({ status: "completed", method: "online", platform: null, payment: "gift_card" });
    expect(matchesFilters({ status: "completed", source: "online", methods: ["card", "gift_card"] }, f)).toBe(true);
    expect(matchesFilters({ status: "completed", source: "online", methods: ["card"] }, f)).toBe(false);
    expect(matchesFilters({ status: "booked", source: "api", methods: null }, parseAppointmentFilters({ payment: "unpaid", platform: "app" }))).toBe(true);
  });
});

describe("per-staff permission matrix", () => {
  it("covers Squire's areas, and every cell is a real permission", () => {
    expect(MATRIX_AREAS.map((a) => a.label)).toEqual([
      "Appointments",
      "Contact info",
      "Clients",
      "Services",
      "Schedules",
      "Bank accounts",
      "Profile",
      "Reports",
      "Products",
      "Inventory",
      "Campaigns",
      "Register",
      "Open cash drawer",
      "Custom charge",
    ]);
    expect(MATRIX_ACTIONS.map((a) => a.label)).toEqual(["View", "Add/Edit", "Book", "Modify", "History", "Cancel", "Block time"]);
    for (const p of MATRIX_PERMISSIONS) expect(isPermission(p), p).toBe(true);
  });

  it("a cell is on, off or partly on, and allow/deny/default sets each permission behind it", () => {
    const cell: Permission[] = ["pos.discount", "pos.price_override"];
    expect(cellState(new Set<Permission>(["pos.discount"]), cell)).toBe("partial");
    expect(cellState(new Set<Permission>(cell), cell)).toBe("on");
    expect(cellState(new Set<Permission>(), "always")).toBe("always");
    const allowed = setCell({ "sales.view": true }, cell, true);
    expect(allowed).toEqual({ "sales.view": true, "pos.discount": true, "pos.price_override": true });
    expect(cellOverride(allowed, cell)).toBe(true);
    expect(cellOverride({ "pos.discount": false }, cell)).toBe("mixed");
    expect(setCell(allowed, cell, null)).toEqual({ "sales.view": true });
    expect([null, true, false, "mixed"].map((o) => nextOverride(o as boolean | null | "mixed"))).toEqual([true, false, null, true]);
  });

  it("the drawer's no-sale opening and custom charges go to the roles that run the register", () => {
    const perms = (k: string) => new Set(ROLE_TEMPLATES.find((t) => t.key === k)!.permissions);
    expect(perms("shop_manager").has("drawer.no_sale")).toBe(true);
    expect(perms("shop_manager").has("pos.custom_charge")).toBe(true);
    expect(perms("front_desk").has("drawer.no_sale")).toBe(true);
    expect(perms("front_desk").has("pos.custom_charge")).toBe(false);
    expect(perms("barber").has("drawer.no_sale")).toBe(false);
  });
});

describe("analytics period over period", () => {
  it("offers 1W, 4W, MTD, QTD and YTD as the report presets they are", () => {
    expect(ANALYTICS_PERIODS.map((p) => p.label)).toEqual(["1W", "4W", "MTD", "QTD", "YTD"]);
    const today = "2026-10-25";
    expect(ANALYTICS_PERIODS.map((p) => presetRange(p.id, today))).toEqual([
      { from: "2026-10-19", to: "2026-10-25" },
      { from: "2026-09-28", to: "2026-10-25" },
      { from: "2026-10-01", to: "2026-10-25" },
      { from: "2026-10-01", to: "2026-10-25" },
      { from: "2026-01-01", to: "2026-10-25" },
    ]);
  });

  it("compares like with like", () => {
    expect(comparePeriod("2026-10-19", "2026-10-25", "7d", "prior")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(comparePeriod("2026-09-28", "2026-10-25", "4w", "prior")).toEqual({ from: "2026-08-31", to: "2026-09-27" });
    // Month to date against the same days of last month, capped at its end.
    expect(comparePeriod("2026-10-01", "2026-10-25", "month", "prior")).toEqual({ from: "2026-09-01", to: "2026-09-25" });
    expect(comparePeriod("2026-03-01", "2026-03-31", "month", "prior")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // Quarter to date: as many days into last quarter.
    expect(comparePeriod("2026-10-01", "2026-10-25", "quarter", "prior")).toEqual({ from: "2026-07-01", to: "2026-07-25" });
    // Year to date and "last year": the same dates a year back.
    expect(comparePeriod("2026-01-01", "2026-10-25", "ytd", "prior")).toEqual({ from: "2025-01-01", to: "2025-10-25" });
    expect(comparePeriod("2026-10-19", "2026-10-25", "7d", "year")).toEqual({ from: "2025-10-19", to: "2025-10-25" });
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });

  it("change and percent change, with nothing before as no percent", () => {
    expect(periodChange(150, 100)).toEqual({ diff: 50, pct: 0.5 });
    expect(periodChange(50, 0)).toEqual({ diff: 50, pct: null });
    expect(periodChange(null, 10)).toEqual({ diff: null, pct: null });
  });
});
