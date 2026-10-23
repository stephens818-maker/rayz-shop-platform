import { describe, expect, it } from "vitest";
import { receiptTotal, receiptView, refundPortionPhrase, settlementLines } from "./receipt-view";

describe("receipt display", () => {
  it("keeps the original total when a refund is listed and accepts a null receipt", () => {
    expect(receiptView({ receipt: null })).toBeNull();
    expect(receiptView({
      serviceCents: 2900,
      taxCents: 203,
      tipCents: 500,
      feeCents: 0,
      totalCents: 3603,
      tender: "card",
      refunds: [{ id: "r1", amountCents: 100 }],
    })?.totalCents).toBe(3603);
    const row = receiptView({
      receipt: {
        serviceCents: 2900,
        taxCents: 203,
        tipCents: 500,
        feeCents: 0,
        totalCents: 3603,
        tender: "card",
        refunds: [{ id: "r1", amountCents: 100 }],
      },
    });
    expect(receiptTotal(row)).toBe(3603);
    expect(row?.refunds[0].amountCents).toBe(100);
  });

  it("names the shop, the tip, and a split refund without changing the total", () => {
    expect(refundPortionPhrase({ from: "shop" })).toBe(" from the shop");
    expect(refundPortionPhrase({ from: "tip" })).toBe(" from the tip");
    expect(refundPortionPhrase({ from: "shop_and_tip", shopPortionCents: 150, tipPortionCents: 100 })).toBe(" from the shop $1.50 and the tip $1.00");
    const lines = settlementLines(500, { shopCents: 3103, tipCents: 500, tipStatus: "with_shop" }, "Makenna");
    expect(lines).toContain("Shop $31.03");
    expect(lines.some((line) => line.includes("stayed with the shop"))).toBe(true);
    expect(receiptTotal({ serviceCents: 2900, taxCents: 203, tipCents: 500, feeCents: 0, totalCents: 3603, tender: "card", refunds: [{ id: "r", amountCents: 250, from: "shop_and_tip", shopPortionCents: 150, tipPortionCents: 100 }] })).toBe(3603);
  });
});
