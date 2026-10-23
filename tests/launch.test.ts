import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AppError } from "@/server/errors";
import { effectiveLaunch, parseLaunchAt } from "@/server/launch";
import { apnsMaterial } from "@/server/mobile/push";

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

  it("does not open a shop from the brand instant", () => {
    const brand = { launched: true, launchAt: "2000-01-01T00:00:00.000Z", scope: "brand" as const };
    expect(effectiveLaunch(null, brand).launched).toBe(false);
    expect(effectiveLaunch(new Date("2999-01-01T00:00:00.000Z"), brand, new Date("2026-01-01T00:00:00.000Z")).launched).toBe(false);
    expect(effectiveLaunch(new Date("2020-01-01T00:00:00.000Z"), { launched: false, launchAt: null, scope: "brand" }, new Date("2026-01-01T00:00:00.000Z")).launched).toBe(true);
  });
});

describe("APNs key", () => {
  it("reads the key id, team id, and .p8 from the environment on each call", () => {
    const prev = {
      APNS_KEY_ID: process.env.APNS_KEY_ID,
      APNS_TEAM_ID: process.env.APNS_TEAM_ID,
      APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
      APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
    };
    process.env.APNS_KEY_ID = "KEYOLD";
    process.env.APNS_TEAM_ID = "TEAMOLD";
    process.env.APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nold";
    process.env.APNS_BUNDLE_ID = "com.rayz.customer";
    const first = apnsMaterial();
    process.env.APNS_KEY_ID = "KEYNEW";
    process.env.APNS_TEAM_ID = "9LVG9R4Z5J";
    process.env.APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nnew";
    const second = apnsMaterial();
    expect(first.keyId).toBe("KEYOLD");
    expect(second).toMatchObject({ keyId: "KEYNEW", teamId: "9LVG9R4Z5J", privateKey: "-----BEGIN PRIVATE KEY-----\nnew" });
    expect(readFileSync("src/server/mobile/push.ts", "utf8")).not.toContain("9LVG9R4Z5J");
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
