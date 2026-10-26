import { describe, expect, it } from "vitest";
import { DEFAULT_CARD_FEE_POLICY, brandCardFeePolicy, cleanOverride, feeConfigFor, policyDiff, policyProblem, shopCardFeePolicy, stateRule } from "@/domain/card-fee-policy";
import { CardFeeConfig, CartLine, cardFeeFor, computeCheckout, describeFee, feeDisclosure } from "@/domain/checkout";
import { planSplitTenders } from "@/domain/combined-checkout";

const on: CardFeeConfig = { enabled: true, rate: 0.03, appliesToTip: false };
const cut: CartLine = { key: "1", kind: "service", name: "Cut", unitPriceCents: 3000, qty: 1 };

describe("cardFeeFor: fee types, cap and minimum", () => {
  it("adds a flat amount, alone or on top of the percent", () => {
    expect(cardFeeFor({ ...on, type: "flat", flatCents: 50 }, "credit", { chargeCents: 5000 })).toMatchObject({ feeCents: 50, rate: 0, flatCents: 50, label: "Credit card surcharge ($0.50)" });
    expect(cardFeeFor({ ...on, rate: 0.02, type: "both", flatCents: 30 }, "credit", { chargeCents: 5000 })).toMatchObject({
      feeCents: 130,
      effectiveRate: 0.026,
      label: "Credit card surcharge (2% + $0.30)",
    });
  });

  it("applies the minimum, then the cap, and never goes past 3% of the charge", () => {
    expect(cardFeeFor({ ...on, minCents: 100 }, "credit", { chargeCents: 2000 })).toMatchObject({ feeCents: 60, limitedBy: "legal" });
    expect(cardFeeFor({ ...on, rate: 0.01, minCents: 100 }, "credit", { chargeCents: 5000 })).toMatchObject({ feeCents: 100, limitedBy: "min" });
    expect(cardFeeFor({ ...on, capCents: 200 }, "credit", { chargeCents: 20_000 })).toMatchObject({ feeCents: 200, limitedBy: "cap" });
    // A flat part can't take a small charge over the limit either.
    expect(cardFeeFor({ ...on, type: "both", flatCents: 50 }, "credit", { chargeCents: 1000 })).toMatchObject({ feeCents: 30, limitedBy: "legal" });
  });

  it("holds to a lower state limit", () => {
    expect(cardFeeFor({ ...on, maxRate: 0.02 }, "credit", { chargeCents: 10_000 })).toMatchObject({ feeCents: 200, rate: 0.02 });
  });

  it("is off on a channel or in a state the policy rules out", () => {
    expect(cardFeeFor({ ...on, off: "channel_off" }, "credit", { chargeCents: 5000 })).toMatchObject({ feeCents: 0, reason: "channel_off", disclosure: null });
    expect(cardFeeFor({ ...on, off: "state_not_allowed" }, "credit", { chargeCents: 5000 })).toMatchObject({ feeCents: 0, reason: "state_not_allowed" });
  });

  it("charges a wallet only with the flag and that wallet turned on", () => {
    const cfg = { ...on, wallets: { applePay: true, googlePay: false } };
    expect(cardFeeFor(cfg, "credit", { chargeCents: 5000 }, { wallet: "apple_pay" })).toMatchObject({ reason: "wallet_fee_off" });
    expect(cardFeeFor(cfg, "credit", { chargeCents: 5000 }, { wallet: "apple_pay", walletFeeOn: true })).toMatchObject({ feeCents: 150 });
    expect(cardFeeFor(cfg, "credit", { chargeCents: 5000 }, { wallet: "google_pay", walletFeeOn: true })).toMatchObject({ reason: "wallet_fee_off" });
    expect(cardFeeFor(cfg, "debit", { chargeCents: 5000 }, { wallet: "apple_pay", walletFeeOn: true })).toMatchObject({ reason: "not_credit" });
  });

  it("waives it only where the brand allows, keeping what it would have been", () => {
    expect(cardFeeFor(on, "credit", { chargeCents: 5000 }, { waive: true })).toMatchObject({ feeCents: 0, waivedCents: 150, reason: "waived", waivable: true });
    expect(cardFeeFor({ ...on, waiverAllowed: false }, "credit", { chargeCents: 5000 }, { waive: true })).toMatchObject({ feeCents: 150, waivable: false });
    expect(cardFeeFor(on, "debit", { chargeCents: 5000 }, { waive: true })).toMatchObject({ waivedCents: 0, reason: "not_credit" });
  });

  it("puts the waiver on the checkout totals, and cash never pays", () => {
    const base = { lines: [cut], taxRates: { serviceRate: 0, productRate: 0 }, cardFee: on };
    const waived = computeCheckout({ ...base, tender: { method: "card", cardFunding: "credit", waiveFee: true } });
    expect(waived).toMatchObject({ cardFeeCents: 0, cardFeeWaivedCents: 90, totalCents: 3000 });
    expect(computeCheckout({ ...base, tender: { method: "cash" } })).toMatchObject({ cardFeeCents: 0, cardFeeWaivedCents: 0 });
  });

  it("uses the brand's notice, with {fee} filled in", () => {
    expect(feeDisclosure({ ...on, notice: "We add a {fee} surcharge on credit cards." })).toBe("We add a 3% surcharge on credit cards.");
    expect(feeDisclosure({ ...on, type: "both", rate: 0.02, flatCents: 30 })).toContain("2% + $0.30 surcharge");
    expect(feeDisclosure({ ...on, off: "state_not_allowed" })).toBeNull();
    expect(describeFee({ rate: 0.05 })).toBe("3%");
  });
});

describe("the card fee policy", () => {
  it("defaults to 3% on credit everywhere surcharges are allowed, debit, prepaid and wallets off", () => {
    const p = brandCardFeePolicy({});
    expect(p).toMatchObject({
      enabled: true,
      type: "percent",
      rate: 0.03,
      funding: { debit: false, prepaid: false, applePay: false, googlePay: false },
      waiverAllowed: true,
      refundRule: "proportional",
    });
    for (const s of ["CT", "MA", "ME", "PR"]) expect(p.states).not.toContain(s);
    expect(stateRule(p, "IA")).toEqual({ allowed: true, maxRate: 0.03 });
    expect(stateRule(p, "co")).toEqual({ allowed: true, maxRate: 0.02 });
    expect(stateRule(p, "CT").allowed).toBe(false);
    expect(stateRule(p, "").allowed).toBe(false);
  });

  it("turns into a config for a shop's state and channel", () => {
    const p = brandCardFeePolicy({ channels: { deposit: false } });
    expect(feeConfigFor(p, "IA", "pos")).toMatchObject({ enabled: true, rate: 0.03, maxRate: 0.03 });
    expect(feeConfigFor(p, "IA", "pos").off).toBeUndefined();
    expect(feeConfigFor(p, "IA", "deposit").off).toBe("channel_off");
    expect(feeConfigFor(p, "MA", "pos").off).toBe("state_not_allowed");
    expect(feeConfigFor(p, "CO", "app")).toMatchObject({ rate: 0.02, maxRate: 0.02 });
  });

  it("lets a shop override only its own keys, and keeps only what differs", () => {
    const brand = brandCardFeePolicy({ rate: 0.025 });
    const raw = { rate: 0.02, enabled: true, waiverAllowed: false, refundRule: "keep", states: ["MA"], channels: { app: false, pos: true } };
    expect(cleanOverride(brand, raw)).toEqual({ rate: 0.02, channels: { app: false } });
    const merged = shopCardFeePolicy(brand, raw);
    expect(merged).toMatchObject({ rate: 0.02, waiverAllowed: true, refundRule: "proportional", channels: { app: false, pos: true } });
    expect(merged.states).toEqual(brand.states);
    expect(cleanOverride(brand, { rate: 0.025 })).toBeNull();
  });

  it("refuses settings that break the rules", () => {
    const p = DEFAULT_CARD_FEE_POLICY;
    expect(policyProblem(p)).toBeNull();
    expect(policyProblem({ ...p, funding: { ...p.funding, debit: true } })).toMatch(/only allowed on credit/);
    expect(policyProblem({ ...p, funding: { ...p.funding, prepaid: true } })).toMatch(/only allowed on credit/);
    expect(policyProblem({ ...p, rate: 0.035 })).toMatch(/can't exceed 3%/);
    expect(policyProblem({ ...p, rate: 0 })).toMatch(/above 0%/);
    expect(policyProblem({ ...p, rate: 0, enabled: false })).toBeNull();
    expect(policyProblem({ ...p, type: "flat", flatCents: 0 })).toMatch(/flat amount/);
    expect(policyProblem({ ...p, type: "flat", flatCents: 1001 })).toMatch(/\$10\.00/);
    expect(policyProblem({ ...p, capCents: 100, minCents: 200 })).toMatch(/minimum can't be more than the cap/);
    expect(policyProblem({ ...p, notice: "A small fee applies." })).toMatch(/surcharge/);
    expect(policyProblem({ ...p, states: ["ZZ"] })).toMatch(/ZZ/);
    expect(policyProblem({ ...p, stateMaxRates: { CO: 0.04 } })).toMatch(/CO/);
  });

  it("lists what changed, for the audit log", () => {
    expect(policyDiff({ rate: 0.03, enabled: true }, { rate: 0.02, enabled: true })).toEqual({ rate: { from: 0.03, to: 0.02 } });
  });
});

describe("split tenders", () => {
  it("surcharges each credit part on its own, and a waiver drops all of it", () => {
    const tenders = [
      { key: "a", method: "card" as const, amountCents: 2000, funding: "credit" as const },
      { key: "b", method: "card" as const, amountCents: 2000, funding: "debit" as const },
      { key: "c", method: "cash" as const, amountCents: 1000 },
    ];
    expect(planSplitTenders({ tipCents: 0, cardFee: on, tenders })).toMatchObject({ cardFeeCents: 60, cardFeeWaivedCents: 0 });
    const w = planSplitTenders({ tipCents: 0, cardFee: on, tenders, waive: true });
    expect(w).toMatchObject({ cardFeeCents: 0, cardFeeWaivedCents: 60 });
    expect(w.parts.find((p) => p.key === "a")).toMatchObject({ feeCents: 0, feeWaivedCents: 60 });
  });
});
