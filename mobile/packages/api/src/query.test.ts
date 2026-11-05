import { describe, expect, it } from "vitest";
import { GROSS_LABEL, PAYOUT_STATUS_LABEL, PAYROLL_STATUS_LABEL, TRANSFER_STATUS_LABEL } from "./labels";
import { earningsSearch, rangeFromSearch } from "./query";

describe("earnings query contract", () => {
  it("accepts from/to or a period and never sends staffId", () => {
    expect(earningsSearch({ from: "2026-10-16", to: "2026-10-20" })).toBe("from=2026-10-16&to=2026-10-20");
    expect(earningsSearch({ period: "current" })).toBe("period=current");
    expect(earningsSearch({ periodId: "2026-10-04" })).toBe("periodId=2026-10-04");
    expect(() => earningsSearch({ period: "current", staffId: "someone" } as never)).toThrow(/staffId/);
  });

  it("resolves current period in Chicago and rejects a mixed query", () => {
    const params = new URLSearchParams("period=current");
    expect(rangeFromSearch(params, "2026-10-23")).toEqual({ from: "2026-10-18", to: "2026-10-31" });
    expect("error" in rangeFromSearch(new URLSearchParams("from=2026-10-01&to=2026-10-23&periodId=2026-10-18"), "2026-10-23")).toBe(true);
    expect("error" in rangeFromSearch(new URLSearchParams("staffId=abc"), "2026-10-23")).toBe(true);
  });

  it("uses gross payroll wording and renders every payout status", () => {
    expect(GROSS_LABEL).toBe("Gross earnings, before taxes and deductions");
    expect(Object.values(PAYROLL_STATUS_LABEL).join(" ")).not.toMatch(/isolved|net pay/i);
    expect(Object.keys(TRANSFER_STATUS_LABEL).sort()).toEqual(["paid", "pending", "reversed"]);
    expect(TRANSFER_STATUS_LABEL.reversed).toBe("Returned by bank");
    expect(Object.keys(PAYOUT_STATUS_LABEL).sort()).toEqual(["canceled", "failed", "in_transit", "paid", "pending"]);
    for (const label of Object.values(PAYOUT_STATUS_LABEL)) expect(label.length).toBeGreaterThan(0);
  });
});
