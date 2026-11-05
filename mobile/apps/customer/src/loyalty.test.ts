import { describe, expect, it } from "vitest";
import { loyaltyBadge } from "./loyalty";

describe("loyalty badge", () => {
  it("stays blank when the home payload has no badge", () => {
    expect(loyaltyBadge(null)).toBeNull();
    expect(loyaltyBadge(undefined)).toBeNull();
    expect(loyaltyBadge({ label: "Regular", reason: "You keep coming back." })?.label).toBe("Regular");
  });
});
