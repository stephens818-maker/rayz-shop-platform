import { describe, expect, it } from "vitest";
import { OFFLINE_READABLE, STAFF_DEVICE_POLICY, WIPE_FOR, cacheRuleFor, queuedPunchProblem } from "@/domain/staff-device-policy";

describe("the staff app's data on the phone (ST-I18)", () => {
  it("keeps only their own day's GETs, never clients, pay or anything sent", () => {
    for (const p of ["/api/staff/v1/me", "/api/staff/v1/me/calendar", "/api/staff/v1/clock", "/api/staff/v1/me/timecard/", "/config"]) expect(cacheRuleFor("GET", p), p).toBe("offline-24h");
    for (const p of ["/api/staff/v1/clients", "/api/staff/v1/clients/abc", "/api/staff/v1/me/earnings", "/api/staff/v1/tips", "/api/staff/v1/banking", "/api/staff/v1/timecards", "/api/staff/v1/me/sessions"])
      expect(cacheRuleFor("GET", p), p).toBe("none");
    expect(cacheRuleFor("POST", "/api/staff/v1/clock")).toBe("none");
    expect(OFFLINE_READABLE.some((r) => r.test("/clients"))).toBe(false);
  });

  it("a queued punch can be sent for 24 hours, and not from a phone clock that runs ahead", () => {
    const now = new Date("2026-10-27T15:00:00Z");
    expect(queuedPunchProblem(new Date("2026-10-27T14:20:00Z"), now)).toBeNull();
    expect(queuedPunchProblem(new Date("2026-10-26T15:30:00Z"), now)).toBeNull();
    expect(queuedPunchProblem(new Date("2026-10-26T14:59:00Z"), now)).toMatch(/24 hours/);
    expect(queuedPunchProblem(new Date("2026-10-27T15:01:00Z"), now)).toBeNull();
    expect(queuedPunchProblem(new Date("2026-10-27T15:05:00Z"), now)).toMatch(/future/);
    expect(queuedPunchProblem(new Date("nope"), now)).toMatch(/read/);
  });

  it("wipes everything when the session was taken away, the cache when it ran out, nothing for a token refresh", () => {
    expect(WIPE_FOR).toEqual({ token_expired: "none", session_expired: "cache", session_ended: "all", account_ended: "all", other_device: "all" });
    expect(STAFF_DEVICE_POLICY.cache.ttlHours).toBe(24);
    expect(STAFF_DEVICE_POLICY.offline.queued).toEqual(["clock_punch"]);
  });
});
