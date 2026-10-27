/**
 * ST-N7: no tip pool, and any future one leaves out owners, managers and supervisors.
 * ST-N8: the staff app's and My pay's earnings are named as the iSolved paystub names them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tipWeights } from "@/domain/handoff";
import { DEFAULT_PAYROLL_SETTINGS, EXPORT_COLUMNS, paystubLines, paystubName } from "@/domain/payroll/calc";
import { effectiveAccess, templateFor } from "@/domain/permissions";
import { poolExcluded, tipPoolProblem } from "@/domain/tip-pool";

const member = (key: string, label: string) => {
  const a = effectiveAccess(templateFor(key)!, {}, null);
  return { staffId: key, label, isOwner: a.isOwner, permissions: a.permissions };
};

describe("tip pools (ST-N7)", () => {
  it("leaves owners, managers and supervisors out; barbers, apprentices and the front desk may share", () => {
    for (const k of ["barber", "apprentice", "front_desk"]) expect(poolExcluded(member(k, k)), k).toBe(false);
    for (const k of ["brand_owner", "franchisee_owner", "regional_manager", "shop_manager", "franchisee_manager"]) expect(poolExcluded(member(k, k)), k).toBe(true);
    expect(tipPoolProblem([member("barber", "Makenna"), member("apprentice", "Jo")])).toBeNull();
    expect(tipPoolProblem([member("barber", "Makenna"), member("shop_manager", "Michelle")])).toMatch(/^Michelle can't share a tip pool/);
  });

  it("today a ticket's tip goes only to the barbers on its services, never anyone else", () => {
    const lines = [
      { kind: "service", staffId: "barber-a", netCents: 3000 },
      { kind: "addon", staffId: "barber-b", netCents: 1000 },
      { kind: "product", staffId: "manager", netCents: 2500 },
    ];
    expect(tipWeights(lines, "services").map((w) => w.staffId)).toEqual(["barber-a", "barber-b"]);
    expect(tipWeights(lines, "even").map((w) => w.staffId)).toEqual(["barber-a", "barber-b"]);
    const typed = tipWeights(lines, "per_barber", [
      { staffId: "barber-a", cents: 500 },
      { staffId: "manager", cents: 500 },
    ]);
    expect(typed).toEqual([{ staffId: "barber-a", weight: 500 }]);
  });

  it("a tip pool table can't appear without these rules", () => {
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    const pools = [...schema.matchAll(/pgTable\(\s*"([^"]*pool[^"]*)"/g)].map((m) => m[1]);
    expect(pools, "A tip pool needs tipPoolProblem (src/domain/tip-pool.ts) on its members; then update this test").toEqual([]);
  });
});

describe("earnings named as on the paystub (ST-N8)", () => {
  it("reads the earning name from each iSolved column", () => {
    expect(EXPORT_COLUMNS.map((c) => paystubName(c.header).name)).toEqual(["Regular", "Overtime 1.5", "Cash Tips Recd", "Comm Sales", "Ray'z Paid Time", "Training"]);
    expect(paystubName("E_Regular_Hours").unit).toBe("hours");
    expect(paystubName(DEFAULT_PAYROLL_SETTINGS.tipsPaidOutHeader)).toEqual({ name: "Tips Paid Out", unit: "dollars", memo: true });
    for (const h of [DEFAULT_PAYROLL_SETTINGS.tipsInPayrollHeader, DEFAULT_PAYROLL_SETTINGS.owedTipsInPayrollHeader, DEFAULT_PAYROLL_SETTINGS.cashTipsDeclaredHeader, DEFAULT_PAYROLL_SETTINGS.stripeTipsPaidHeader])
      expect(h).toMatch(/^[EM]_.+_(Hours|Dollars)$/);
  });

  it("lists one person's lines in their shop's file, grouped for permissions, with memo tips marked", () => {
    const block = {
      exportHeaders: [...EXPORT_COLUMNS.map((c) => c.header), DEFAULT_PAYROLL_SETTINGS.tipsInPayrollHeader, DEFAULT_PAYROLL_SETTINGS.tipsPaidOutHeader],
      exportFrom: ["tipsInPayroll", "tipsPaidOut"] as const,
      exportRows: [
        { staffId: "me", key: 101, isolvedName: "Doe, Jo", values: [38.5, 2, 120, 412.35, 0, 1.5, 60, 120] },
        { staffId: "other", key: 102, isolvedName: "Roe, Al", values: [40, 0, 0, 0, 0, 0, 0, 0] },
      ],
    };
    const stub = paystubLines({ ...block, exportFrom: [...block.exportFrom] }, "me");
    expect(stub.map((l) => [l.name, l.unit, l.group, l.amount, l.memo])).toEqual([
      ["Regular", "hours", "hours", 38.5, false],
      ["Overtime 1.5", "hours", "hours", 2, false],
      ["Cash Tips Recd", "dollars", "tips", 120, false],
      ["Comm Sales", "dollars", "wages", 412.35, false],
      ["Training", "hours", "hours", 1.5, false],
      ["Tips Paid In Payroll", "dollars", "tips", 60, false],
      ["Tips Paid Out", "dollars", "tips", 120, true],
    ]);
    expect(paystubLines({ ...block, exportFrom: [...block.exportFrom] }, "nobody")).toEqual([]);
  });
});
