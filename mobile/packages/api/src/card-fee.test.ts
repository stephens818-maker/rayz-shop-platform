import { describe, expect, it } from "vitest";
import { cardFeeFor, type CardFeeConfig } from "./card-fee";

const on: CardFeeConfig = { enabled: true, rate: 0.03, appliesToTip: false };

describe("card fee disclosure math", () => {
  it("charges credit only, on the amount before tip by default", () => {
    expect(cardFeeFor(on, "credit", { chargeCents: 3500, tipCents: 500 })).toMatchObject({
      feeCents: 90,
      rate: 0.03,
      basis: "charge_excluding_tip",
      basisCents: 3000,
      reason: "applies",
      label: "Credit card surcharge (3%)",
    });
    for (const funding of ["debit", "prepaid", "unknown", null] as const) {
      expect(cardFeeFor(on, funding, { chargeCents: 3500 }).reason).toBe("not_credit");
    }
  });

  it("skips wallet payments and caps the rate at 3%", () => {
    expect(cardFeeFor(on, "credit", { chargeCents: 3000 }, { wallet: true }).reason).toBe("wallet_fee_off");
    expect(cardFeeFor({ ...on, rate: 0.05 }, "credit", { chargeCents: 10_000 }).feeCents).toBe(300);
  });
});
