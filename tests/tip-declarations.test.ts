import { describe, expect, it } from "vitest";
import { DEFAULT_PAYROLL_SETTINGS } from "@/domain/payroll/calc";
import { closesOn, declarationProblem, lastMonthOf, monthClosed, ordinal, reminderDue, type DeclarationAttempt } from "@/domain/tip-declarations";

const rules = DEFAULT_PAYROLL_SETTINGS.declarations;
const ok: DeclarationAttempt = { businessDate: "2026-10-20", amountCents: 4500, attested: true, manager: false, periodLocked: false };

describe("cash tip declarations (SB-C3)", () => {
  it("a month closes on the lock day of the next month, across the year end", () => {
    expect(closesOn("2026-10-31", rules)).toBe("2026-11-10");
    expect(closesOn("2026-12-01", rules)).toBe("2027-01-10");
    expect(closesOn("2026-01-15", { lockDay: 3 })).toBe("2026-02-03");
    expect(monthClosed("2026-10-02", "2026-11-10", rules)).toBe(false);
    expect(monthClosed("2026-10-02", "2026-11-11", rules)).toBe(true);
    expect(lastMonthOf("2027-01-04")).toBe("2026-12");
  });

  it("reminds from the 1st to the reminder day, only those who haven't declared", () => {
    expect(reminderDue("2026-11-01", rules, false)).toBe(true);
    expect(reminderDue("2026-11-09", rules, false)).toBe(true);
    expect(reminderDue("2026-11-10", rules, false)).toBe(false);
    expect(reminderDue("2026-11-03", rules, true)).toBe(false);
    expect(reminderDue("2026-11-03", { ...rules, enabled: false }, false)).toBe(false);
  });

  it("needs the attestation, a real amount and a day that has happened; never in a locked period; a manager can fix a closed month with a reason", () => {
    const today = "2026-10-27";
    expect(declarationProblem(ok, today, rules)).toBeNull();
    expect(declarationProblem({ ...ok, amountCents: 0 }, today, rules)).toBeNull();
    expect(declarationProblem({ ...ok, attested: false }, today, rules)).toMatch(/Check the box/);
    expect(declarationProblem({ ...ok, amountCents: -1 }, today, rules)).toMatch(/Enter an amount/);
    expect(declarationProblem({ ...ok, amountCents: 1_000_001 }, today, rules)).toMatch(/Enter an amount/);
    expect(declarationProblem({ ...ok, amountCents: 12.5 }, today, rules)).toMatch(/Enter an amount/);
    expect(declarationProblem({ ...ok, businessDate: "2026-10-28" }, today, rules)).toMatch(/hasn't happened/);
    expect(declarationProblem({ ...ok, businessDate: "Oct 20" }, today, rules)).toMatch(/Pick the day/);
    expect(declarationProblem({ ...ok, periodLocked: true }, today, rules)).toMatch(/locked/);
    expect(declarationProblem({ ...ok, periodLocked: true, manager: true, reason: "x" }, today, rules)).toMatch(/locked/);

    const closed = { ...ok, businessDate: "2026-09-12" };
    expect(declarationProblem(closed, today, rules)).toBe("Declarations for that month closed on the 10th. Ask a manager to correct it.");
    expect(declarationProblem({ ...closed, manager: true }, today, rules)).toMatch(/Say why/);
    expect(declarationProblem({ ...closed, manager: true, reason: "Missed at close" }, today, rules)).toBeNull();
    expect(declarationProblem(ok, today, { ...rules, enabled: false })).toMatch(/turned off/);
  });

  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]);
  });
});
