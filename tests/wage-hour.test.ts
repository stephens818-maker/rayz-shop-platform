/** State wage-hour rules (ST-I16): Illinois and Iowa minimum wage, Illinois paid leave accrual and meal periods. */
import { describe, expect, it } from "vitest";
import { STATE_RULES, mealCheck, mealPromptDue, minimumWageCents, minimumWageShortfallCents, paidLeaveYear, rulesFor, workStateOf } from "@/domain/wage-hour";

const IL = STATE_RULES.IL;
const at = (h: number) => new Date(Date.UTC(2026, 9, 5, 13) + h * 3_600_000);

describe("work state and minimum wage", () => {
  it("reads the shop's address state, and falls back to federal for anything else", () => {
    expect(workStateOf(" il ")).toBe("IL");
    expect(workStateOf("Iowa")).toBeNull();
    expect(workStateOf("")).toBeNull();
    expect(rulesFor("IA").name).toBe("Iowa");
    expect(rulesFor("WI").name).toBe("Federal");
    expect(rulesFor(null).paidLeave).toBeNull();
  });

  it("Illinois is $15.00 from 2025, $14.00 in 2024; Iowa and anywhere else is the federal $7.25", () => {
    expect(minimumWageCents("IL", "2026-10-05")).toBe(1500);
    expect(minimumWageCents("IL", "2025-01-01")).toBe(1500);
    expect(minimumWageCents("IL", "2024-12-31")).toBe(1400);
    expect(minimumWageCents("IA", "2026-10-05")).toBe(725);
    expect(minimumWageCents("WI", "2026-10-05")).toBe(725);
    expect(minimumWageCents(null, "2026-10-05")).toBe(725);
  });

  it("the shortfall is what straight-time pay misses over the hours paid; never negative", () => {
    expect(minimumWageShortfallCents(60_000, 40, 1500)).toBe(0);
    expect(minimumWageShortfallCents(48_000, 40, 1500)).toBe(12_000);
    expect(minimumWageShortfallCents(0, 0, 1500)).toBe(0);
  });
});

describe("Illinois paid leave", () => {
  const rule = IL.paidLeave!;
  it("an hour per 40 worked, capped at 40 a year, with what carried in, less what's used", () => {
    expect(paidLeaveYear(rule, { workedHours: 1000, usedHours: 0, carriedInHours: 0 })).toMatchObject({ accruedHours: 25, balanceHours: 25, capped: false });
    expect(paidLeaveYear(rule, { workedHours: 2080, usedHours: 8, carriedInHours: 10 })).toMatchObject({ accruedHours: 40, balanceHours: 42, capped: true });
    expect(paidLeaveYear(rule, { workedHours: 165, usedHours: 0, carriedInHours: 0 }).accruedHours).toBe(4.13);
    expect(paidLeaveYear(rule, { workedHours: 40, usedHours: 8, carriedInHours: 0 }).balanceHours).toBe(0);
  });
  it("Iowa has no state paid leave law", () => {
    expect(STATE_RULES.IA.paidLeave).toBeNull();
  });
});

describe("Illinois meal periods (One Day Rest in Seven Act)", () => {
  const rule = IL.mealPeriod!;
  it("a shift of 7½ hours or more needs 20 minutes starting by hour 5, and another past 12 hours", () => {
    expect(mealCheck(rule, { start: at(0), end: at(7), breaks: [] }, at(8))).toMatchObject({ needed: 0, missed: false });
    expect(mealCheck(rule, { start: at(0), end: at(8), breaks: [] }, at(9))).toMatchObject({ needed: 1, taken: 0, missed: true });
    expect(mealCheck(rule, { start: at(0), end: at(8), breaks: [{ start: at(4), end: at(4.5) }] }, at(9))).toMatchObject({ needed: 1, taken: 1, missed: false });
    expect(mealCheck(rule, { start: at(0), end: at(8), breaks: [{ start: at(5.5), end: at(6) }] }, at(9)).missed).toBe(true);
    expect(mealCheck(rule, { start: at(0), end: at(8), breaks: [{ start: at(3), end: at(3.25) }] }, at(9)).missed).toBe(true);
    expect(mealCheck(rule, { start: at(0), end: at(12.5), breaks: [{ start: at(4), end: at(4.5) }] }, at(13))).toMatchObject({ needed: 2, missed: true });
    expect(mealCheck(rule, { start: at(0), end: null, breaks: [] }, at(9)).missed).toBe(false);
  });

  it("prompts an open shift half an hour before the meal has to start, not while on a break or after one", () => {
    const open = { start: at(0), end: null, breaks: [] };
    expect(mealPromptDue(rule, open, at(4))).toBe(false);
    expect(mealPromptDue(rule, open, at(4.5))).toBe(true);
    expect(mealPromptDue(rule, open, at(5.5))).toBe(true);
    expect(mealPromptDue(rule, open, at(6.5))).toBe(false);
    expect(mealPromptDue(rule, { ...open, breaks: [{ start: at(4.4), end: null }] }, at(4.6))).toBe(false);
    expect(mealPromptDue(rule, { ...open, breaks: [{ start: at(2), end: at(2.5) }] }, at(4.6))).toBe(false);
    expect(mealPromptDue(rule, { ...open, breaks: [{ start: at(2), end: at(2.1) }] }, at(4.6))).toBe(true);
    expect(STATE_RULES.IA.mealPeriod).toBeNull();
  });
});
