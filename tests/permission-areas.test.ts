import { describe, expect, it } from "vitest";
import { AREAS, AREA_ROWS, levelIndex, levelPermissions, rowMatches, rowPermissions, withLevel } from "@/domain/permission-areas";
import { ALL_PERMISSIONS, Permission, ROLE_TEMPLATES, effectiveAccess } from "@/domain/permissions";

describe("permission areas", () => {
  it("put every permission in exactly one row", () => {
    const seen = new Map<string, string[]>();
    for (const r of AREA_ROWS) for (const p of rowPermissions(r)) seen.set(p, [...(seen.get(p) ?? []), r.id]);
    expect(ALL_PERMISSIONS.filter((p) => !seen.has(p))).toEqual([]);
    expect([...seen].filter(([, rows]) => rows.length > 1)).toEqual([]);
    expect([...seen.keys()].filter((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p))).toEqual([]);
  });

  it("have unique keys and row ids", () => {
    expect(new Set(AREAS.map((a) => a.key)).size).toBe(AREAS.length);
    expect(new Set(AREA_ROWS.map((r) => r.id)).size).toBe(AREA_ROWS.length);
  });

  it("cover the areas the brand asked for", () => {
    const labels = AREAS.map((a) => a.label);
    for (const want of [
      "Calendar and booking",
      "Checkout, refunds and voids",
      "Cash drawer",
      "Client profiles, notes and contact info",
      "Client export",
      "Staff profiles",
      "Staff pay rates and commissions",
      "Time clock and timesheets",
      "Tip payouts",
      "Inventory and products",
      "Services and pricing",
      "Reports: sales",
      "Reports: P&L and payouts",
      "Reports: payroll and labor",
      "Reports: card fees",
      "Reports: rebook and retention",
      "Campaign Center",
      "Settings",
      "Stripe and banking",
      "Integrations and exports",
      "Location wizard",
      "Roles and permissions",
      "Audit log",
    ])
      expect(labels).toContain(want);
  });

  it("levels are cumulative and setting one sets the whole row", () => {
    const cal = AREA_ROWS.find((r) => r.id === "calendar")!;
    expect(levelPermissions(cal, 2)).toEqual(["calendar.view_all", "calendar.manage"]);
    const none = new Set<Permission>();
    expect(levelIndex(cal, none)).toBe(0);
    const all = withLevel(cal, none, 2);
    expect(levelIndex(cal, all)).toBe(2);
    expect(levelIndex(cal, withLevel(cal, all, 1))).toBe(1);
    // Manage without view-all is no level on the row: "custom".
    expect(levelIndex(cal, new Set<Permission>(["calendar.manage"]))).toBe(-1);
  });

  it("templates read as levels the brand expects", () => {
    const at = (key: string, row: string) => {
      const r = AREA_ROWS.find((x) => x.id === row)!;
      const t = ROLE_TEMPLATES.find((x) => x.key === key)!;
      return r.levels[levelIndex(r, effectiveAccess(t).permissions)]?.key ?? "custom";
    };
    expect(at("barber", "calendar")).toBe("own");
    expect(at("front_desk", "calendar")).toBe("edit");
    expect(at("shop_manager", "refunds")).toBe("approve");
    expect(at("front_desk", "refunds")).toBe("none");
    expect(at("bookkeeper", "contact")).toBe("none");
    expect(at("bookkeeper", "checkout")).toBe("own");
    expect(at("bookkeeper", "report.card_fees")).toBe("export");
    expect(at("marketing", "campaigns")).toBe("approve");
    expect(at("marketing", "contact")).toBe("none");
    expect(at("marketing", "report.lapsed_clients")).toBe("export");
    expect(at("barber", "timesheets")).toBe("own");
    expect(at("shop_manager", "payroll.rates")).toBe("none");
    expect(at("shop_manager", "compensation")).toBe("none");
  });

  it("search matches labels, areas and permission keys", () => {
    const hits = (q: string) => AREA_ROWS.filter((r) => rowMatches(r, q)).map((r) => r.id);
    expect(hits("quickbooks")).toContain("exports.accounting");
    expect(hits("void")).toContain("voids");
    expect(hits("sales.refund")).toEqual(["refunds"]);
    expect(hits("")).toHaveLength(AREA_ROWS.length);
  });
});
