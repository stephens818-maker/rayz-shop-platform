import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardFeeFor, feeLabel, fundingForSurcharge } from "@/domain/checkout";
import { surchargeShare } from "@/domain/refunds";
import { flags } from "@/lib/flags";
import { applyRate } from "@/lib/money";
import { assertIssuedStripeSecret, assertStripeTestMode } from "@/server/payments/processor";

/**
 * Numbers locked to mobile PR #7 mock-api flows:
 * Coralville service $29.00, 7% tax, $5.00 tip, 3% credit fee that skips the tip.
 */
const FIXTURE = {
  serviceCents: 2900,
  taxRate: 0.07,
  tipCents: 500,
  feeRate: 0.03,
};

describe("mock payment fixture math", () => {
  it("matches the sandbox credit, debit, and wallet previews", () => {
    const taxCents = applyRate(FIXTURE.serviceCents, FIXTURE.taxRate);
    expect(taxCents).toBe(203);
    const chargeCents = FIXTURE.serviceCents + taxCents + FIXTURE.tipCents;
    const credit = cardFeeFor(
      { enabled: true, rate: FIXTURE.feeRate, appliesToTip: false },
      "credit",
      { chargeCents, tipCents: FIXTURE.tipCents },
      { walletFeeOn: false },
    );
    expect(credit.feeCents).toBe(93);
    expect(credit.label).toMatch(/3%/);
    expect(credit.disclosure).toMatch(/credit card/i);
    expect(chargeCents + credit.feeCents).toBe(2900 + 203 + 500 + 93);
    const debit = cardFeeFor(
      { enabled: true, rate: FIXTURE.feeRate, appliesToTip: false },
      "debit",
      { chargeCents, tipCents: FIXTURE.tipCents },
      { walletFeeOn: false },
    );
    expect(debit.feeCents).toBe(0);
    expect(debit.reason).toBe("not_credit");
    const wallet = cardFeeFor(
      { enabled: true, rate: FIXTURE.feeRate, appliesToTip: false },
      "credit",
      { chargeCents, tipCents: FIXTURE.tipCents },
      { wallet: true, walletFeeOn: false },
    );
    expect(wallet.reason).toBe("wallet_fee_off");
    expect(credit.label).toBe(feeLabel({ rate: FIXTURE.feeRate }));
    const walletDebit = cardFeeFor(
      { enabled: true, rate: FIXTURE.feeRate, appliesToTip: false },
      fundingForSurcharge("debit", true),
      { chargeCents, tipCents: FIXTURE.tipCents },
      { wallet: true, walletFeeOn: true },
    );
    expect(walletDebit.feeCents).toBe(0);
    expect(walletDebit.reason).toBe("not_credit");
    const walletUnknown = cardFeeFor(
      { enabled: true, rate: FIXTURE.feeRate, appliesToTip: false },
      fundingForSurcharge(null, true),
      { chargeCents, tipCents: FIXTURE.tipCents },
      { wallet: true, walletFeeOn: true },
    );
    expect(walletUnknown.feeCents).toBe(0);
    expect(walletUnknown.reason).toBe("not_credit");
    const half = surchargeShare(credit.feeCents, chargeCents, 0, Math.floor(chargeCents / 2));
    const rest = surchargeShare(credit.feeCents, chargeCents, Math.floor(chargeCents / 2), chargeCents - Math.floor(chargeCents / 2));
    expect(half + rest).toBe(credit.feeCents);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(credit.feeCents);
  });

  it("does not create a PaymentIntent outside chargeCard", () => {
    const pay = readFileSync("src/server/mobile/pay.ts", "utf8");
    const cards = readFileSync("src/server/mobile/cards.ts", "utf8");
    expect(pay).not.toContain("paymentIntents.create");
    expect(pay).not.toContain("executeChargePlan");
    expect(pay).toContain("chargeCard");
    expect(pay).toContain("Confirm the payment sheet before charging.");
    expect(pay).toContain("computeCardFee");
    expect(pay).toContain("fundingForSurcharge");
    expect(pay).toContain("retrievePaymentIntent");
    expect(pay).toContain("recordExistingCharge");
    expect(pay).toContain("refundUnrecorded");
    expect(pay).not.toContain("input.wallet");
    expect(pay).not.toContain('wallet ? "credit"');
    const plan = readFileSync("src/server/payments/charge-plan.ts", "utf8");
    expect(plan).toContain("surchargeCents");
    expect(readFileSync("src/server/auth/customer.ts", "utf8")).not.toContain("lastInitial");
    expect(cards).not.toContain("paymentIntents.create");
    expect(cards).toContain("setupIntents.create");
    expect(cards).toContain("ephemeralKeys.create");
    expect(cards).toContain("Card numbers stay in Stripe");
  });

  it("accepts FEATURE_WALLET_FEE as 1, true, or on", () => {
    const previous = process.env.FEATURE_WALLET_FEE;
    try {
      for (const value of ["1", "true", "TRUE", "on", " On "]) {
        process.env.FEATURE_WALLET_FEE = value;
        expect(flags.walletFee(), value).toBe(true);
      }
      for (const value of ["yes", "false", "0", ""]) {
        process.env.FEATURE_WALLET_FEE = value;
        expect(flags.walletFee(), value).toBe(false);
      }
      delete process.env.FEATURE_WALLET_FEE;
      expect(flags.walletFee()).toBe(false);
      process.env.FEATURE_REVIEW_LOGIN = "on";
      expect(flags.reviewLogin()).toBe(false);
      process.env.FEATURE_REVIEW_LOGIN = "true";
      expect(flags.reviewLogin()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FEATURE_WALLET_FEE;
      else process.env.FEATURE_WALLET_FEE = previous;
      delete process.env.FEATURE_REVIEW_LOGIN;
    }
  });

  it("refuses live Stripe keys and live secrets unless STRIPE_MODE is live", () => {
    const secret = process.env.STRIPE_SECRET_KEY;
    const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    const mode = process.env.STRIPE_MODE;
    const demo = process.env.DEMO_MODE;
    try {
      delete process.env.STRIPE_MODE;
      process.env.STRIPE_SECRET_KEY = "sk_live_example";
      expect(() => assertStripeTestMode()).toThrow(/Live Stripe keys/);
      delete process.env.STRIPE_SECRET_KEY;
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_example";
      expect(() => assertStripeTestMode()).toThrow(/Live Stripe keys/);
      delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      process.env.STRIPE_SECRET_KEY = "sk_test_example";
      expect(() => assertStripeTestMode()).not.toThrow();
      delete process.env.STRIPE_SECRET_KEY;
      expect(() => assertStripeTestMode()).not.toThrow();
      process.env.DEMO_MODE = "true";
      process.env.STRIPE_SECRET_KEY = "sk_live_example";
      expect(() => assertStripeTestMode()).not.toThrow();
      delete process.env.DEMO_MODE;
      delete process.env.STRIPE_SECRET_KEY;
      expect(() => assertIssuedStripeSecret("pi_live_secret")).toThrow(/Live Stripe keys/);
      expect(() => assertIssuedStripeSecret("ek_live_secret")).toThrow(/Live Stripe keys/);
      expect(() => assertIssuedStripeSecret("pi_test_sandbox")).not.toThrow();
      process.env.STRIPE_MODE = "live";
      process.env.STRIPE_SECRET_KEY = "sk_live_example";
      expect(() => assertStripeTestMode()).not.toThrow();
      expect(() => assertIssuedStripeSecret("pi_live_secret")).not.toThrow();
    } finally {
      if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = secret;
      if (publishable === undefined) delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      else process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = publishable;
      if (mode === undefined) delete process.env.STRIPE_MODE;
      else process.env.STRIPE_MODE = mode;
      if (demo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = demo;
    }
  });
});
