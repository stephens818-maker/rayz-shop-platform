import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { parseLaunchAt } from "@/server/launch";

describe("LAUNCH_AT", () => {
  it("parses an ISO instant and treats a blank value as unset", () => {
    expect(parseLaunchAt("  ")).toBeNull();
    expect(parseLaunchAt(undefined)).toBeNull();
    expect(parseLaunchAt("2026-11-01T14:00:00.000Z")?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("refuses a timestamp that would not launch on purpose", () => {
    expect(() => parseLaunchAt("next tuesday")).toThrow(AppError);
    try {
      parseLaunchAt("next tuesday");
    } catch (e) {
      expect(e).toMatchObject({ code: "internal" });
    }
  });
});
