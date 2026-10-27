/** ST-I2: shop goals in the milestone settings, their week or month, and progress. */
import { describe, expect, it } from "vitest";
import { MilestoneSettings, goalPeriod, goalProgress, goalsAt, milestoneSettings } from "@/domain/milestones";

const SHOP_A = "11111111-1111-4111-8111-111111111111";
const SHOP_B = "22222222-2222-4222-8222-222222222222";

describe("shop goals (ST-I2)", () => {
  it("runs Sunday to Saturday or over the calendar month that today is in", () => {
    expect(goalPeriod("week", "2026-10-27")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(goalPeriod("week", "2026-10-25")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(goalPeriod("week", "2026-10-31")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(goalPeriod("week", "2026-11-01")).toEqual({ from: "2026-11-01", to: "2026-11-07" });
    expect(goalPeriod("month", "2026-10-27")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(goalPeriod("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("shows whole percent, never past 100, and reached at the goal", () => {
    expect(goalProgress(400, 0)).toEqual({ current: 0, target: 400, pct: 0, reached: false });
    expect(goalProgress(3, 2)).toMatchObject({ pct: 66, reached: false });
    expect(goalProgress(400, 399)).toMatchObject({ pct: 99, reached: false });
    expect(goalProgress(400, 400)).toMatchObject({ pct: 100, reached: true });
    expect(goalProgress(400, 900)).toMatchObject({ pct: 100, reached: true });
  });

  it("applies to every shop or the ones picked, counts only, and a bad goal list doesn't lose the other settings", () => {
    const s = MilestoneSettings.parse({
      goals: [
        { id: "a", metric: "services", period: "week", target: 100 },
        { id: "b", metric: "products", period: "month", target: 40, shopIds: [SHOP_B] },
      ],
    });
    expect(goalsAt(s.goals, SHOP_A).map((g) => g.id)).toEqual(["a"]);
    expect(goalsAt(s.goals, SHOP_B).map((g) => g.id)).toEqual(["a", "b"]);
    expect(MilestoneSettings.safeParse({ goals: [{ id: "x", metric: "sales_month", period: "month", target: 1 }] }).success).toBe(false);
    expect(MilestoneSettings.safeParse({ goals: [{ id: "x", metric: "services", period: "day", target: 1 }] }).success).toBe(false);
    expect(MilestoneSettings.safeParse({ goals: [{ id: "x", metric: "services", period: "week", target: 0 }] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, metric: "services", period: "week", target: 1 }));
    expect(MilestoneSettings.safeParse({ goals: many }).success).toBe(false);
    expect(milestoneSettings({ teamFeed: true, goals: many })).toMatchObject({ teamFeed: true, goals: [] });
  });
});
