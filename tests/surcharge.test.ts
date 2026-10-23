import { describe, expect, it } from "vitest";
import { cardFeeFor, feeLabel, fundingForSurcharge } from "@/domain/checkout";
import { surchargeShare } from "@/domain/refunds";
import { chargeCard, simulatorLedger } from "@/server/payments/processor";

describe("credit surcharge", () => {
  it("sends the surcharge as its own Stripe line and never surcharges a debit card", async () => {
    const label = feeLabel({ rate: 0.03 });
    expect(label).toBe("Credit card surcharge (3%)");
    const credit = await chargeCard({
      paymentMethodId: "pm_card_visa",
      amountCents: 3696,
      description: "credit surcharge",
      metadata: {},
      idempotencyKey: `surcharge-credit-${Date.now()}`,
      surchargeCents: 93,
      surchargeLabel: label,
    });
    const intent = simulatorLedger().intents.find((row) => row.id === credit.paymentIntentId);
    expect(intent?.surchargeCents).toBe(93);
    expect(intent?.lineItems).toEqual([
      { productName: "Services", productCode: "services", unitCost: 3603, quantity: 1 },
      { productName: label, productCode: "surcharge", unitCost: 93, quantity: 1 },
    ]);

    const debit = await chargeCard({
      paymentMethodId: "pm_card_visa_debit",
      amountCents: 3603,
      description: "debit",
      metadata: {},
      idempotencyKey: `surcharge-debit-${Date.now()}`,
      surchargeCents: 93,
      surchargeLabel: label,
    });
    const debitIntent = simulatorLedger().intents.find((row) => row.id === debit.paymentIntentId);
    expect(debitIntent?.surchargeCents).toBe(0);
    expect(debitIntent?.lineItems).toEqual([]);
  });

  it("does not surcharge a wallet debit even when the wallet fee flag is on", () => {
    const amounts = { chargeCents: 3603, tipCents: 500 };
    const cfg = { enabled: true, rate: 0.03, appliesToTip: false };
    const debit = cardFeeFor(cfg, fundingForSurcharge("debit", true), amounts, { wallet: true, walletFeeOn: true });
    expect(debit.feeCents).toBe(0);
    expect(debit.reason).toBe("not_credit");
    const missing = cardFeeFor(cfg, fundingForSurcharge(null, true), amounts, { wallet: true, walletFeeOn: true });
    expect(missing.reason).toBe("not_credit");
    const credit = cardFeeFor(cfg, fundingForSurcharge("credit", true), amounts, { wallet: true, walletFeeOn: true });
    expect(credit.feeCents).toBe(93);
    expect(credit.label).toBe("Credit card surcharge (3%)");
  });

  it("prorates a partial refund and the parts add up to the original surcharge", () => {
    const half = surchargeShare(93, 3603, 0, 1800);
    const rest = surchargeShare(93, 3603, 1800, 1803);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(93);
    expect(half + rest).toBe(93);
    expect(surchargeShare(93, 3603, 0, 0)).toBe(0);
  });
});
