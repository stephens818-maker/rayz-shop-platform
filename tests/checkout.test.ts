import { describe, expect, it } from "vitest";
import { CardFeeConfig, CartLine, allocateRefund, computeCheckout, tipSuggestions } from "@/domain/checkout";

const fee: CardFeeConfig = { enabled: true, rate: 0.03, appliesToTip: false, mode: "surcharge" };
const iowa = { serviceRate: 0.07, productRate: 0.07 };
const illinois = { serviceRate: 0, productRate: 0.085 };

const cut: CartLine = { key: "1", kind: "service", name: "Haircut w/ Shampoo", unitPriceCents: 3300, qty: 1 };
const beard: CartLine = { key: "2", kind: "addon", name: "Beard line up", unitPriceCents: 500, qty: 1 };
const pomade: CartLine = { key: "3", kind: "product", name: "Reuzel Pomade", unitPriceCents: 2000, qty: 1 };
const giftCard: CartLine = { key: "4", kind: "gift_card", name: "Gift card", unitPriceCents: 5000, qty: 1 };

describe("checkout: taxes", () => {
  it("taxes services and products at their own per-shop rates", () => {
    const t = computeCheckout({ lines: [cut, pomade], taxRates: { serviceRate: 0.06, productRate: 0.07 }, cardFee: fee, tender: { method: "cash" } });
    expect(t.serviceTaxCents).toBe(198);
    expect(t.productTaxCents).toBe(140);
    expect(t.totalCents).toBe(3300 + 2000 + 198 + 140);
  });

  it("Illinois-style config: services untaxed, products taxed", () => {
    const t = computeCheckout({ lines: [cut, pomade], taxRates: illinois, cardFee: fee, tender: { method: "cash" } });
    expect(t.serviceTaxCents).toBe(0);
    expect(t.productTaxCents).toBe(170);
  });

  it("tax is charged on the discounted price; gift card sales are never taxed", () => {
    const t = computeCheckout({
      lines: [cut, giftCard],
      discounts: [{ source: "promo", label: "WELCOME5", type: "amount", value: 500, appliesTo: "services" }],
      taxRates: iowa,
      cardFee: fee,
      tender: { method: "cash" },
    });
    expect(t.serviceNetCents).toBe(2800);
    expect(t.serviceTaxCents).toBe(196);
    expect(t.giftCardSalesCents).toBe(5000);
    expect(t.totalCents).toBe(2800 + 196 + 5000);
  });
});

describe("checkout: discounts and promo codes", () => {
  it("applies percent before amount and never discounts below zero", () => {
    const t = computeCheckout({
      lines: [cut, beard, pomade],
      discounts: [
        { source: "manual", label: "$100 off", type: "amount", value: 10_000, appliesTo: "services" },
        { source: "promo", label: "10%", type: "percent", value: 10, appliesTo: "all" },
      ],
      taxRates: iowa,
      cardFee: fee,
      tender: { method: "cash" },
    });
    expect(t.discountBreakdown[0]).toMatchObject({ label: "10%", cents: 580 });
    expect(t.serviceNetCents).toBe(0);
    expect(t.productNetCents).toBe(1800);
    expect(t.lines.every((l) => l.netCents >= 0)).toBe(true);
  });

  it("splits a discount across lines so the parts add up exactly", () => {
    const t = computeCheckout({
      lines: [cut, beard],
      discounts: [{ source: "manual", label: "x", type: "amount", value: 333, appliesTo: "services" }],
      taxRates: iowa,
      cardFee: fee,
      tender: { method: "cash" },
    });
    expect(t.lines.reduce((a, l) => a + l.discountCents, 0)).toBe(333);
  });
});

describe("checkout: credit-only card fee", () => {
  const base = { lines: [cut], taxRates: iowa, tipCents: 700, cardFee: fee };

  it("adds the fee only when Stripe reports funding = credit", () => {
    const credit = computeCheckout({ ...base, tender: { method: "card", cardFunding: "credit" } });
    // fee base = 3300 + 231 tax (tip excluded by default)
    expect(credit.cardFeeBaseCents).toBe(3531);
    expect(credit.cardFeeCents).toBe(106);
    expect(credit.totalCents).toBe(3300 + 231 + 700 + 106);
    expect(credit.disclosures.join(" ")).toMatch(/credit card/i);

    for (const cardFunding of ["debit", "prepaid", "unknown"] as const) {
      expect(computeCheckout({ ...base, tender: { method: "card", cardFunding } }).cardFeeCents).toBe(0);
    }
    expect(computeCheckout({ ...base, tender: { method: "cash" } }).cardFeeCents).toBe(0);
  });

  it("can include the tip in the fee base when configured", () => {
    const t = computeCheckout({ ...base, cardFee: { ...fee, appliesToTip: true }, tender: { method: "card", cardFunding: "credit" } });
    expect(t.cardFeeCents).toBe(Math.round((3300 + 231 + 700) * 0.03));
  });

  it("is capped at 3% even if misconfigured", () => {
    const t = computeCheckout({ ...base, cardFee: { ...fee, rate: 0.05 }, tender: { method: "card", cardFunding: "credit" } });
    expect(t.cardFeeRate).toBe(0.03);
    expect(t.cardFeeCents).toBe(106);
  });

  it("is off when disabled, but still discloses nothing", () => {
    const t = computeCheckout({ ...base, cardFee: { ...fee, enabled: false }, tender: { method: "card", cardFunding: "credit" } });
    expect(t.cardFeeCents).toBe(0);
    expect(t.disclosures).toHaveLength(0);
  });

  it("supports cash-discount wording", () => {
    const t = computeCheckout({ ...base, cardFee: { ...fee, mode: "cash_discount" }, tender: { method: "card", cardFunding: "credit" } });
    expect(t.disclosures.join(" ")).toMatch(/discount for cash/i);
    expect(t.cardFeeCents).toBe(106);
  });
});

describe("checkout: gift cards", () => {
  it("gift card pays first; the fee applies only to the credit-card remainder", () => {
    const t = computeCheckout({
      lines: [cut],
      taxRates: iowa,
      tipCents: 500,
      cardFee: fee,
      tender: { method: "card", cardFunding: "credit", giftCardCents: 2000, giftCardBalanceCents: 2000 },
    });
    expect(t.giftCardAppliedCents).toBe(2000);
    expect(t.primaryBaseCents).toBe(3300 + 231 + 500 - 2000);
    // tip (500) rides on the card but is excluded from the fee base
    expect(t.cardFeeBaseCents).toBe(t.primaryBaseCents - 500);
    expect(t.cardFeeCents).toBe(Math.round((t.primaryBaseCents - 500) * 0.03));
  });

  it("is limited by the card balance and can cover the whole ticket", () => {
    const partial = computeCheckout({ lines: [cut], taxRates: iowa, cardFee: fee, tender: { method: "cash", giftCardCents: 9999, giftCardBalanceCents: 1000 } });
    expect(partial.giftCardAppliedCents).toBe(1000);
    const full = computeCheckout({ lines: [cut], taxRates: iowa, cardFee: fee, tender: { method: "none", giftCardCents: 9999, giftCardBalanceCents: 9999 } });
    expect(full.giftCardAppliedCents).toBe(3531);
    expect(full.primaryChargeCents).toBe(0);
    expect(full.cardFeeCents).toBe(0);
  });

  it("cannot be used to buy another gift card", () => {
    const t = computeCheckout({ lines: [giftCard], taxRates: iowa, cardFee: fee, tender: { method: "cash", giftCardCents: 5000, giftCardBalanceCents: 5000 } });
    expect(t.giftCardAppliedCents).toBe(0);
  });
});

describe("checkout: loyalty base, tips, refunds", () => {
  it("loyalty counts net services only (after discounts, before tax) — not products, tips or gift cards", () => {
    const t = computeCheckout({
      lines: [cut, beard, pomade, giftCard],
      discounts: [{ source: "promo", label: "x", type: "amount", value: 800, appliesTo: "services" }],
      taxRates: iowa,
      tipCents: 1000,
      cardFee: fee,
      tender: { method: "cash" },
    });
    expect(t.loyaltyEligibleCents).toBe(3300 + 500 - 800);
  });

  it("tip suggestions are based on the service subtotal", () => {
    expect(tipSuggestions(3300, [20, 25, 30])).toEqual([
      { percent: 20, cents: 660 },
      { percent: 25, cents: 825 },
      { percent: 30, cents: 990 },
    ]);
  });

  it("partial refunds are allocated across components and never exceed what's left", () => {
    const sale = { serviceNetCents: 3300, productNetCents: 2000, giftCardSalesCents: 0, taxCents: 371, tipCents: 700, cardFeeCents: 0 };
    const r1 = allocateRefund(sale, null, 2000);
    expect(Object.values(r1).reduce((a, b) => a + b, 0)).toBe(2000);
    const r2 = allocateRefund(sale, r1, 1_000_000);
    expect(Object.values(r2).reduce((a, b) => a + b, 0)).toBe(6371 - 2000);
  });
});
