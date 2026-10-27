import { describe, expect, it } from "vitest";
import { CardFeeConfig, CartLine, computeCheckout, tipSuggestions } from "@/domain/checkout";
import { allocateAmount, allocateToTenders, componentsTotal, lineRefunds, unitsShare } from "@/domain/refunds";

const fee: CardFeeConfig = { enabled: true, rate: 0.03, appliesToTip: false };
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

  it("never takes the fee out of the tip, whatever the fee is charged on (ST-C18)", () => {
    for (const appliesToTip of [false, true]) {
      for (const cardFee of [{ ...fee, appliesToTip }, { ...fee, appliesToTip, type: "flat" as const, rate: 0, flatCents: 150 }]) {
        const t = computeCheckout({ ...base, cardFee, tender: { method: "card", cardFunding: "credit" } });
        expect(t.cardFeeCents).toBeGreaterThan(0);
        expect(t.tipCents).toBe(700);
        expect(t.totalCents).toBe(t.preFeeTotalCents + t.cardFeeCents);
        expect(t.preFeeTotalCents - t.serviceNetCents - t.productNetCents - t.giftCardSalesCents - t.taxCents).toBe(700);
      }
    }
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

  it("only ever describes the fee as a credit card surcharge (review P1#11: no false cash-discount wording)", () => {
    const t = computeCheckout({ ...base, cardFee: fee, tender: { method: "card", cardFunding: "credit" } });
    expect(t.disclosures.join(" ")).toMatch(/surcharge applies to credit card payments only/i);
    expect(t.disclosures.join(" ")).not.toMatch(/discount for cash/i);
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

});

describe("refunds (review P1#8): chosen lines, tip, and fee go back to the tender that took them", () => {
  const ticket = computeCheckout({ lines: [cut, giftCard], taxRates: iowa, tipCents: 700, cardFee: fee, tender: { method: "card", cardFunding: "credit" } });
  const lines = ticket.lines.map((l, i) => ({ id: `i${i}`, kind: l.kind, name: l.name, qty: l.qty, refundedQty: 0, netCents: l.netCents, taxCents: l.taxCents }));
  const card = { id: "card", method: "card" as const, availableCents: ticket.primaryChargeCents, tipAvailableCents: 700, feeAvailableCents: ticket.cardFeeCents };

  it("refunding the cut returns its price and tax only; the gift card, tip, and fee stay put", () => {
    const [r] = lineRefunds(lines, [{ saleItemId: "i0", qty: 1 }]);
    expect(r).toMatchObject({ netCents: 3300, taxCents: 231 });
    const plan = allocateToTenders({ serviceNetCents: 3300, productNetCents: 0, giftCardSalesCents: 0, taxCents: 231, tipCents: 0, cardFeeCents: 0 }, [card]);
    expect(plan).toEqual([{ tenderId: "card", method: "card", amountCents: 3531, components: { serviceNetCents: 3300, productNetCents: 0, giftCardSalesCents: 0, taxCents: 231, tipCents: 0, cardFeeCents: 0 } }]);
  });

  it("won't refund a line twice or more units than were sold", () => {
    expect(() => lineRefunds([{ ...lines[0], refundedQty: 1 }], [{ saleItemId: "i0", qty: 1 }])).toThrow(/already refunded/);
    expect(() => lineRefunds(lines, [{ saleItemId: "i0", qty: 2 }])).toThrow(/Only 1/);
  });

  it("splitting a multi-unit line in steps adds up to the line exactly", () => {
    const parts = [unitsShare(1001, 3, 0, 1), unitsShare(1001, 3, 1, 1), unitsShare(1001, 3, 2, 1)];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it("sends the tip to the tender that carried it and the fee to the card", () => {
    const gc = { id: "gc", method: "gift_card" as const, availableCents: 2000, tipAvailableCents: 0, feeAvailableCents: 0 };
    const cashT = { id: "cash", method: "cash" as const, availableCents: 3000, tipAvailableCents: 700, feeAvailableCents: 0 };
    const plan = allocateToTenders({ serviceNetCents: 1000, productNetCents: 0, giftCardSalesCents: 0, taxCents: 0, tipCents: 700, cardFeeCents: 0 }, [gc, cashT]);
    expect(plan.find((p) => p.tenderId === "cash")!.components.tipCents).toBe(700);
    expect(() => allocateToTenders({ serviceNetCents: 0, productNetCents: 0, giftCardSalesCents: 0, taxCents: 0, tipCents: 0, cardFeeCents: 50 }, [cashT])).toThrow(/card fee/);
  });

  it("never refunds a gift card purchase onto a gift card", () => {
    const gc = { id: "gc", method: "gift_card" as const, availableCents: 9999, tipAvailableCents: 0, feeAvailableCents: 0 };
    expect(() => allocateToTenders({ serviceNetCents: 0, productNetCents: 0, giftCardSalesCents: 5000, taxCents: 0, tipCents: 0, cardFeeCents: 0 }, [gc])).toThrow(/cash or card/);
  });

  it("a bare-amount refund (Stripe dashboard) is split without touching sold gift cards until nothing else is left", () => {
    const remaining = { serviceNetCents: 3300, productNetCents: 0, giftCardSalesCents: 5000, taxCents: 231, tipCents: 700, cardFeeCents: 106 };
    const a = allocateAmount(remaining, 700);
    expect(componentsTotal(a)).toBe(700);
    expect(a.giftCardSalesCents).toBe(0);
    const all = allocateAmount(remaining, 9337);
    expect(all).toEqual(remaining);
  });
});
