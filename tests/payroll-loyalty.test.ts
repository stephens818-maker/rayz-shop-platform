import { describe, expect, it } from "vitest";
import { payPeriodFor, payPeriodsBetween } from "@/domain/payroll";
import { DEFAULT_LOYALTY, accrue, progressExpired, reverseAccrual, rewardExpiry, usableRewards } from "@/domain/loyalty";
import { weekdayOf } from "@/lib/time";

describe("payroll periods (bi-weekly, ending Saturdays, anchored on Sat 2026-10-03)", () => {
  it("the anchor Saturday ends a period that starts on a Sunday 13 days earlier", () => {
    const p = payPeriodFor("2026-10-03");
    expect(p).toMatchObject({ start: "2026-09-20", end: "2026-10-03", index: 0 });
    expect(payPeriodFor("2026-09-20").index).toBe(0);
    expect(payPeriodFor("2026-09-19")).toMatchObject({ start: "2026-09-06", end: "2026-09-19", index: -1 });
  });

  it("the next period runs Sun 10/04 → Sat 10/17, then 10/18 → 10/31", () => {
    expect(payPeriodFor("2026-10-04")).toMatchObject({ start: "2026-10-04", end: "2026-10-17", index: 1 });
    expect(payPeriodFor("2026-10-17").end).toBe("2026-10-17");
    expect(payPeriodFor("2026-10-20")).toMatchObject({ start: "2026-10-18", end: "2026-10-31" });
  });

  it("every period ends on a Saturday and starts on a Sunday, for years in both directions", () => {
    for (let i = -60; i <= 60; i += 7) {
      const p = payPeriodsBetween("2025-01-01", "2028-12-31")[i + 60];
      if (!p) continue;
      expect(weekdayOf(p.end)).toBe(6);
      expect(weekdayOf(p.start)).toBe(0);
    }
  });

  it("is DST-safe: the period containing fall-back has 337 real hours, spring-forward 335", () => {
    const fall = payPeriodFor("2026-11-01"); // DST ends Sun Nov 1 2026
    expect(fall).toMatchObject({ start: "2026-11-01", end: "2026-11-14" });
    expect((fall.endsAt.getTime() - fall.startsAt.getTime()) / 3_600_000).toBe(14 * 24 + 1);
    expect(fall.startsAt.toISOString()).toBe("2026-11-01T05:00:00.000Z"); // midnight CDT
    expect(fall.endsAt.toISOString()).toBe("2026-11-15T06:00:00.000Z"); // midnight CST

    const spring = payPeriodFor("2027-03-14"); // DST starts Sun Mar 14 2027
    expect((spring.endsAt.getTime() - spring.startsAt.getTime()) / 3_600_000).toBe(14 * 24 - 1);
  });

  it("lists contiguous periods across a range", () => {
    const ps = payPeriodsBetween("2026-09-25", "2026-10-25");
    expect(ps.map((p) => p.end)).toEqual(["2026-10-03", "2026-10-17", "2026-10-31"]);
  });
});

describe("loyalty accrual ($15 per $300 net service spend)", () => {
  const cfg = DEFAULT_LOYALTY;

  it("accumulates progress below the threshold", () => {
    expect(accrue(0, 29_999, cfg)).toEqual({ progressCents: 29_999, rewardsIssued: 0, appliedCents: 29_999 });
  });

  it("issues a reward exactly at $300 and carries the remainder", () => {
    expect(accrue(29_000, 1_000, cfg)).toMatchObject({ progressCents: 0, rewardsIssued: 1 });
    expect(accrue(29_000, 3_300, cfg)).toMatchObject({ progressCents: 2_300, rewardsIssued: 1 });
  });

  it("issues multiple rewards for a large ticket", () => {
    expect(accrue(10_000, 65_000, cfg)).toMatchObject({ progressCents: 15_000, rewardsIssued: 2 });
  });

  it("refunds claw back progress", () => {
    expect(reverseAccrual(5_000, 3_300, 0, cfg)).toEqual({ progressCents: 1_700, rewardsRevoked: 0, unrecoveredCents: 0 });
  });

  it("review P1#5: a refund that crosses back over the threshold revokes the reward and restores pre-sale progress", () => {
    const earned = accrue(29_000, 3_300, cfg);
    expect(earned).toMatchObject({ progressCents: 2_300, rewardsIssued: 1 });
    expect(reverseAccrual(earned.progressCents, 3_300, 1, cfg)).toEqual({ progressCents: 29_000, rewardsRevoked: 1, unrecoveredCents: 0 });
  });

  it("if the reward was already spent, progress bottoms out at zero and the shortfall is reported", () => {
    expect(reverseAccrual(2_300, 3_300, 0, cfg)).toEqual({ progressCents: 0, rewardsRevoked: 0, unrecoveredCents: 1_000 });
  });

  it("does nothing when disabled", () => {
    expect(accrue(100, 50_000, { ...cfg, enabled: false })).toMatchObject({ progressCents: 100, rewardsIssued: 0 });
  });

  it("threshold and reward are configurable", () => {
    expect(accrue(0, 20_000, { ...cfg, thresholdCents: 10_000 })).toMatchObject({ rewardsIssued: 2, progressCents: 0 });
  });

  it("reward expiry and progress expiry are configurable", () => {
    const issued = new Date("2026-10-01T12:00:00Z");
    expect(rewardExpiry(issued, cfg)!.toISOString()).toBe("2027-10-01T12:00:00.000Z");
    expect(rewardExpiry(issued, { ...cfg, rewardExpiryDays: null })).toBeNull();
    const rewards = [
      { amountCents: 1500, expiresAt: new Date("2026-01-01"), redeemedAt: null },
      { amountCents: 1500, expiresAt: new Date("2027-06-01"), redeemedAt: null },
      { amountCents: 1500, expiresAt: null, redeemedAt: new Date("2026-05-01") },
    ];
    expect(usableRewards(rewards, new Date("2026-10-20"))).toHaveLength(1);
    expect(progressExpired(new Date("2026-01-01"), new Date("2026-10-20"), { ...cfg, progressExpiryDays: 180 })).toBe(true);
    expect(progressExpired(new Date("2026-01-01"), new Date("2026-10-20"), cfg)).toBe(false);
  });
});
