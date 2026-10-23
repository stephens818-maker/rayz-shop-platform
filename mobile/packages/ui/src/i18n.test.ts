import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";

describe("copy", () => {
  it("has a Spanish string for every English key", () => {
    expect(Object.keys(dictionaries.es).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const value of Object.values(dictionaries.en)) expect(value.length).toBeGreaterThan(0);
  });

  it("keeps the English gross label exact and out of payroll-vendor wording", () => {
    expect(dictionaries.en.gross).toBe("Gross earnings, before taxes and deductions");
    const blob = Object.values(dictionaries.en).join(" ").toLowerCase();
    expect(blob).not.toContain("isolved");
    expect(blob).not.toContain("net pay");
  });
});
