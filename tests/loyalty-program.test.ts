import { describe, expect, it } from "vitest";
import { computeCheckout, type CardFeeConfig, type CartLine } from "@/domain/checkout";
import { DEFAULT_LOYALTY, accrue, convertProgress, earnUnits, goalOf, loyaltyAtShop, loyaltyConfig, loyaltyEligibleCents, loyaltyRules, progressLabel, progressShare, reverseAccrual, type LoyaltyConfig } from "@/domain/loyalty";

const visits: LoyaltyConfig = { ...DEFAULT_LOYALTY, type: "transaction", visitsGoal: 10, minVisitCents: 2000 };
const money = (c: number) => `$${c / 100}`;

describe("loyalty program settings", () => {
  it("the stored config gets defaults for anything missing: value based, $15 per $300, products and tips off, every location", () => {
    expect(loyaltyConfig(null)).toEqual(DEFAULT_LOYALTY);
    expect(DEFAULT_LOYALTY).toMatchObject({ enabled: true, type: "value", thresholdCents: 30_000, rewardCents: 1_500, includeProducts: false, includeTips: false, shopIds: null });
    const c = loyaltyConfig({ type: "transaction", visitsGoal: 8.4, minVisitCents: -5, includeTips: "yes", shopIds: ["a", "a", 3, "b"], rewardExpiryDays: null });
    expect(c).toMatchObject({ type: "transaction", visitsGoal: 8, minVisitCents: 0, includeTips: false, shopIds: ["a", "b"], rewardExpiryDays: null });
    expect(loyaltyConfig({ type: "points" }).type).toBe("value");
  });

  it("runs only where it's assigned, and nowhere when it's off", () => {
    expect(loyaltyAtShop({ enabled: true, shopIds: null }, "dbq")).toBe(true);
    expect(loyaltyAtShop({ enabled: true, shopIds: ["cv"] }, "cv")).toBe(true);
    expect(loyaltyAtShop({ enabled: true, shopIds: ["cv"] }, "dbq")).toBe(false);
    expect(loyaltyAtShop({ enabled: true, shopIds: ["cv"] }, null)).toBe(false);
    expect(loyaltyAtShop({ enabled: false, shopIds: null }, "cv")).toBe(false);
  });

  it("counts services always, products and tips only when switched on", () => {
    const t = { serviceNetCents: 3000, productNetCents: 2000, tipCents: 600 };
    expect(loyaltyEligibleCents(t, { includeProducts: false, includeTips: false })).toBe(3000);
    expect(loyaltyEligibleCents(t, { includeProducts: true, includeTips: false })).toBe(5000);
    expect(loyaltyEligibleCents(t, { includeProducts: true, includeTips: true })).toBe(5600);
    expect(loyaltyEligibleCents({ serviceNetCents: -100, productNetCents: 0, tipCents: 0 }, { includeProducts: true, includeTips: true })).toBe(0);
  });

  it("transaction based: a paid visit at the minimum spend counts once, and every 10 earn the reward", () => {
    expect(earnUnits(1999, visits)).toBe(0);
    expect(earnUnits(2000, visits)).toBe(1);
    expect(earnUnits(90_000, visits)).toBe(1);
    expect(earnUnits(0, { ...visits, minVisitCents: 0 })).toBe(0);
    expect(goalOf(visits)).toBe(10);
    expect(accrue(9, 4500, visits)).toEqual({ progressCents: 0, rewardsIssued: 1, appliedCents: 1 });
    expect(accrue(3, 500, visits)).toEqual({ progressCents: 3, rewardsIssued: 0, appliedCents: 0 });
    expect(reverseAccrual(0, 1, 1, visits)).toEqual({ progressCents: 9, rewardsRevoked: 1, unrecoveredCents: 0 });
    expect(accrue(29_000, 2_000, DEFAULT_LOYALTY)).toEqual({ progressCents: 1_000, rewardsIssued: 1, appliedCents: 2_000 });
  });

  it("switching type carries the same share of the way to a reward, never a free reward", () => {
    expect(convertProgress(15_000, DEFAULT_LOYALTY, visits)).toBe(5);
    expect(convertProgress(29_999, DEFAULT_LOYALTY, visits)).toBe(9);
    expect(convertProgress(9, visits, DEFAULT_LOYALTY)).toBe(27_000);
    expect(convertProgress(4, visits, { ...visits, visitsGoal: 4 })).toBe(1);
    expect(convertProgress(9, visits, { ...visits, visitsGoal: 4 })).toBe(3);
    expect(convertProgress(12_345, DEFAULT_LOYALTY, DEFAULT_LOYALTY)).toBe(12_345);
  });

  it("explains itself in words, and shows progress in the program's unit", () => {
    expect(loyaltyRules(DEFAULT_LOYALTY).earn).toBe("Every $300 in net service spend (after discounts, before tax) earns a $15 reward. Products and tips don't count.");
    expect(loyaltyRules({ ...DEFAULT_LOYALTY, includeProducts: true }).earn).toMatch(/service and product spend.*Tips don't count/);
    expect(loyaltyRules(visits).earn).toBe("Every 10 paid visits of at least $20 on services earns a $15 reward. Products and tips don't count.");
    expect(loyaltyRules({ ...DEFAULT_LOYALTY, shopIds: ["a", "b"] }, ["Coralville", "Moline"]).where).toBe("Earned and used at Coralville, Moline.");
    expect(loyaltyRules({ ...DEFAULT_LOYALTY, shopIds: [] }, []).where).toMatch(/Not running/);
    expect(progressLabel({ type: "value", progressCents: 12_000, thresholdCents: 30_000, visitsGoal: 10 }, money)).toBe("$120 of $300");
    expect(progressLabel({ type: "transaction", progressCents: 3, thresholdCents: 30_000, visitsGoal: 10 }, money)).toBe("3 of 10 visits");
    expect(progressShare({ type: "transaction", progressCents: 3, thresholdCents: 30_000, visitsGoal: 10 })).toBeCloseTo(0.3);
  });
});

describe("checkout: what a ticket earns", () => {
  const fee: CardFeeConfig = { enabled: false, rate: 0, appliesToTip: false };
  const cut: CartLine = { key: "1", kind: "service", name: "Cut", unitPriceCents: 3300, qty: 1 };
  const pomade: CartLine = { key: "2", kind: "product", name: "Pomade", unitPriceCents: 2000, qty: 1 };
  const base = { lines: [cut, pomade], taxRates: { serviceRate: 0.07, productRate: 0.07 }, cardFee: fee, tender: { method: "cash" as const }, tipCents: 700 };
  it("services only by default, products and tips when the brand counts them, nothing where the program doesn't run", () => {
    expect(computeCheckout(base).loyaltyEligibleCents).toBe(3300);
    expect(computeCheckout({ ...base, loyalty: { on: true, includeProducts: false, includeTips: false } }).loyaltyEligibleCents).toBe(3300);
    expect(computeCheckout({ ...base, loyalty: { on: true, includeProducts: true, includeTips: true } }).loyaltyEligibleCents).toBe(6000);
    expect(computeCheckout({ ...base, loyalty: { on: false, includeProducts: true, includeTips: true } }).loyaltyEligibleCents).toBe(0);
  });
});
