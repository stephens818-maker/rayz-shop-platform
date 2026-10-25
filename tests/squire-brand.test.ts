import { describe, expect, it } from "vitest";
import { REPORTS } from "@/domain/permissions";
import { REPORT_GROUP, REPORT_GROUPS, groupReports } from "@/domain/report-groups";
import { lastBusinessDay, presetRange } from "@/domain/report-range";
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
