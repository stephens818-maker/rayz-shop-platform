import { describe, expect, it } from "vitest";
import { CardFeeConfig, CartLine, cardFeeFor, computeCheckout } from "@/domain/checkout";

const on: CardFeeConfig = { enabled: true, rate: 0.03, appliesToTip: false };
const cut: CartLine = { key: "1", kind: "service", name: "Cut", unitPriceCents: 3000, qty: 1 };

describe("cardFeeFor (the calculation behind computeCardFee)", () => {
  it("charges credit only, on the amount before tip by default", () => {
    expect(cardFeeFor(on, "credit", { chargeCents: 3500, tipCents: 500 })).toMatchObject({
      feeCents: 90,
      rate: 0.03,
      basis: "charge_excluding_tip",
      basisCents: 3000,
      waivable: true,
      reason: "applies",
      label: "Credit card surcharge (3%)",
    });
    for (const f of ["debit", "prepaid", "unknown", null] as const)
      expect(cardFeeFor(on, f, { chargeCents: 3500 })).toMatchObject({ feeCents: 0, waivable: false, reason: "not_credit" });
  });

  it("includes the tip when the shop says so, and never more tip than is on the card", () => {
    expect(cardFeeFor({ ...on, appliesToTip: true }, "credit", { chargeCents: 3500, tipCents: 500 })).toMatchObject({
      feeCents: 105,
      basis: "charge_including_tip",
      basisCents: 3500,
    });
    expect(cardFeeFor(on, "credit", { chargeCents: 400, tipCents: 500 })).toMatchObject({ feeCents: 0, reason: "zero_amount" });
  });

  it("caps the rate at 3%, and is off when the shop turns it off", () => {
    expect(cardFeeFor({ ...on, rate: 0.05 }, "credit", { chargeCents: 10_000 })).toMatchObject({ feeCents: 300, rate: 0.03 });
    expect(cardFeeFor({ ...on, enabled: false }, "credit", { chargeCents: 10_000 })).toMatchObject({ feeCents: 0, reason: "disabled", disclosure: null });
  });

  it("skips wallet payments while the wallet fee is undecided", () => {
    expect(cardFeeFor(on, "credit", { chargeCents: 3000 }, { wallet: true })).toMatchObject({ feeCents: 0, reason: "wallet_fee_off" });
    expect(cardFeeFor(on, "credit", { chargeCents: 3000 }, { wallet: true, walletFeeOn: true })).toMatchObject({ feeCents: 90 });
  });

  it("matches what checkout charges", () => {
    for (const [cfg, tip] of [
      [on, 0],
      [on, 700],
      [{ ...on, appliesToTip: true }, 700],
    ] as const) {
      const t = computeCheckout({
        lines: [cut],
        taxRates: { serviceRate: 0.07, productRate: 0.07 },
        tipCents: tip,
        cardFee: cfg,
        tender: { method: "card", cardFunding: "credit" },
      });
      expect(cardFeeFor(cfg, "credit", { chargeCents: t.primaryBaseCents, tipCents: tip }).feeCents).toBe(t.cardFeeCents);
    }
  });
});
