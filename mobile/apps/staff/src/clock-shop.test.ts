import { describe, expect, it } from "vitest";
import { shopForClock } from "./clock-shop";

describe("clock shop picker", () => {
  it("does not guess the first shop when the barber works at two", () => {
    expect(shopForClock(["coralville", "moline"], null)).toBeNull();
    expect(shopForClock(["coralville", "moline"], "moline")).toBe("moline");
    expect(shopForClock(["coralville"], null)).toBe("coralville");
  });
});