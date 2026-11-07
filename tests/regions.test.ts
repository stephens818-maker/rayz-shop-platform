import { describe, expect, it } from "vitest";
import { regionNameProblem } from "@/domain/regions";

describe("region names", () => {
  it("need 2 to 60 characters, ignoring surrounding spaces", () => {
    expect(regionNameProblem("Quad Cities")).toBeNull();
    expect(regionNameProblem("  QC ")).toBeNull();
    expect(regionNameProblem(" Q ")).toMatch(/Give the region a name/);
    expect(regionNameProblem("")).toMatch(/Give the region a name/);
    expect(regionNameProblem("x".repeat(60))).toBeNull();
    expect(regionNameProblem("x".repeat(61))).toMatch(/60 characters/);
  });
});
