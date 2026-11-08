import { describe, expect, it } from "vitest";
import { chicagoToday } from "./today";

describe("Chicago today", () => {
  it("uses the Chicago civil date across midnight UTC", () => {
    expect(chicagoToday(new Date("2026-10-23T04:00:00.000Z"))).toBe("2026-10-22");
    expect(chicagoToday(new Date("2026-10-23T15:00:00.000Z"))).toBe("2026-10-23");
  });
});
