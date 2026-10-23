import { describe, expect, it } from "vitest";
import { loadRange } from "./range-store";

describe("remembered earnings range", () => {
  const today = "2026-10-23";

  it("recomputes a preset from today and keeps a custom range", () => {
    const preset = loadRange(JSON.stringify({ preset: "last_week", from: "2020-01-01", to: "2020-01-07" }), today);
    expect(preset).toEqual({ preset: "last_week", from: "2026-10-12", to: "2026-10-18" });
    const custom = loadRange(JSON.stringify({ preset: "custom", from: "2026-10-16", to: "2026-10-20" }), today);
    expect(custom).toEqual({ preset: "custom", from: "2026-10-16", to: "2026-10-20" });
  });

  it("falls back to the current period when nothing valid is stored", () => {
    expect(loadRange(null, today).preset).toBe("current_period");
    expect(loadRange("nope", today)).toEqual({ preset: "current_period", from: "2026-10-18", to: "2026-10-31" });
  });
});
