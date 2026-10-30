import { describe, expect, it } from "vitest";
import { defaultCityTaxLabel, defaultStateTaxLabel, receiptTaxLines, taxDisplayOf } from "@/domain/receipt-tax";
import { formatRate } from "@/lib/money";

describe("receipt tax labels", () => {
  it("names the state, and prints a rate without a stray dot", () => {
    expect(defaultStateTaxLabel("IA")).toBe("State of Iowa sales tax");
    expect(defaultStateTaxLabel("il")).toBe("State of Illinois sales tax");
    expect(defaultCityTaxLabel("Coralville")).toBe("City of Coralville sales tax");
    expect(formatRate(0.07)).toBe("7%");
    expect(formatRate(0.065)).toBe("6.5%");
    expect(formatRate(0.0825)).toBe("8.25%");
    expect(formatRate(0)).toBe("0%");
    const [line] = receiptTaxLines({ state: "IA", city: "Coralville", serviceTaxCents: 210, productTaxCents: 0, serviceRate: 0.07, productRate: 0 });
    expect(line).toEqual({ label: "State of Iowa sales tax", cents: 210, rate: 0.07 });
    expect(line.label).not.toContain("7.%");
  });

  it("shows a tax line only when that tax was charged", () => {
    expect(receiptTaxLines({ state: "IL", city: "Moline", serviceTaxCents: 0, productTaxCents: 0, serviceRate: 0, productRate: 0 })).toEqual([]);
    expect(receiptTaxLines({ state: "IL", city: "Moline", serviceTaxCents: 0, productTaxCents: 80, serviceRate: 0, productRate: 0.0625 })).toEqual([
      { label: "State of Illinois sales tax", cents: 80, rate: 0.0625 },
    ]);
  });

  it("splits service tax into state and city lines, and a shop can rename them", () => {
    const lines = receiptTaxLines({
      state: "IA",
      city: "Coralville",
      serviceTaxCents: 700,
      productTaxCents: 100,
      serviceRate: 0.07,
      productRate: 0.07,
      stateRate: 0.06,
      cityRate: 0.01,
    });
    expect(lines.map((l) => l.label)).toEqual(["State of Iowa sales tax", "City of Coralville sales tax", "Product sales tax"]);
    expect(lines[0].cents + lines[1].cents).toBe(700);
    expect(lines.reduce((a, l) => a + l.cents, 0)).toBe(800);
    expect(
      receiptTaxLines({ state: "IA", city: "Iowa City", serviceTaxCents: 100, productTaxCents: 0, serviceRate: 0.07, productRate: 0, cityRate: 0.01 }),
    ).toEqual([{ label: "City of Iowa City sales tax", cents: 100, rate: 0.01 }]);
    expect(
      receiptTaxLines({ state: "IA", city: "Iowa City", serviceTaxCents: 100, productTaxCents: 0, serviceRate: 0.07, productRate: 0, stateLabel: "Local option tax" }),
    ).toEqual([{ label: "Local option tax", cents: 100, rate: 0.07 }]);
    expect(taxDisplayOf({ taxDisplay: { stateLabel: "  County tax  ", stateRate: 0 } })).toMatchObject({ stateLabel: "County tax", stateRate: null });
  });
});
