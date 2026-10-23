import { describe, expect, it } from "vitest";
import { receiptTotal, receiptView } from "./receipt-view";

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
});
