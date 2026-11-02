import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADJUST_DIRECTION, ADJUST_REASONS } from "@/domain/inventory";

describe("inventory count reasons", () => {
  it("adds lost and expired, and the shrink reports count them", () => {
    expect(ADJUST_REASONS).toEqual(["lost", "damage", "theft", "back_bar", "count_correction", "expired", "found", "other"]);
    expect(ADJUST_DIRECTION.lost).toBe("out");
    expect(ADJUST_DIRECTION.expired).toBe("out");
    expect(ADJUST_DIRECTION.damage).toBe("out");
    for (const file of ["src/server/inventory/reports.ts", "src/server/report-builder/engine.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("'lost'");
      expect(src, file).toContain("'expired'");
    }
  });
});
