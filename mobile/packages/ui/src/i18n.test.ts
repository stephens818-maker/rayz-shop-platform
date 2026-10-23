import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";

describe("copy", () => {
  it("has a Spanish string for every English key", () => {
    expect(Object.keys(dictionaries.es).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const value of Object.values(dictionaries.en)) expect(value.length).toBeGreaterThan(0);
  });

  it("keeps the English gross label exact and out of payroll-vendor wording", () => {
    expect(dictionaries.en.gross).toBe("Gross earnings, before taxes and deductions");
    expect(dictionaries.en.smsOffNote).toBe("Text START to resubscribe.");
    expect(dictionaries.en.cardSurchargeNote).toBe("We add a 3% surcharge to credit card payments. It is not more than what we pay to accept credit cards. Debit cards, prepaid cards, gift cards, and cash have no surcharge.");
    expect(dictionaries.en.comingSoon).toBe("Ray'z isn't open in the app yet. Coming soon.");
    expect(dictionaries.en.payrollTips).toBe("Tips paid through payroll.");
    const blob = Object.values(dictionaries.en).join(" ").toLowerCase();
    expect(blob).not.toContain("isolved");
    expect(blob).not.toContain("net pay");
  });
});
