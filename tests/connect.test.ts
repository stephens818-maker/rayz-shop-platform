import { describe, expect, it } from "vitest";
import {
  AccountFlags,
  DEFAULT_PROCESSING_FEES,
  accountState,
  canCharge,
  formatFeeRate,
  ownerEntityProblem,
  parseFeeRate,
  processingFeeCents,
  requirementLabel,
} from "@/domain/connect";

const flags = (o: Partial<AccountFlags> = {}): AccountFlags => ({
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
  disabledReason: null,
  deauthorizedAt: null,
  ...o,
});

describe("connected account state", () => {
  it("walks from not set up to taking cards", () => {
    expect(accountState(null)).toBe("not_started");
    expect(accountState(flags({ requirementsDue: ["external_account", "tos_acceptance.date"] }))).toBe("onboarding");
    expect(accountState(flags({ detailsSubmitted: true }))).toBe("in_review");
    expect(accountState(flags({ detailsSubmitted: true, requirementsDue: ["company.tax_id"] }))).toBe("restricted");
    expect(accountState(flags({ detailsSubmitted: true, disabledReason: "rejected.other" }))).toBe("restricted");
    expect(accountState(flags({ detailsSubmitted: true, chargesEnabled: true, payoutsEnabled: true }))).toBe("enabled");
  });

  it("charges can work before payouts; that's flagged but still chargeable", () => {
    const noBank = flags({ detailsSubmitted: true, chargesEnabled: true, requirementsDue: ["external_account"] });
    expect(accountState(noBank)).toBe("restricted");
    expect(canCharge(noBank)).toBe(true);
  });

  it("a disconnected account can't charge, whatever its flags say", () => {
    const gone = flags({ detailsSubmitted: true, chargesEnabled: true, payoutsEnabled: true, deauthorizedAt: new Date() });
    expect(accountState(gone)).toBe("disconnected");
    expect(canCharge(gone)).toBe(false);
    expect(canCharge(null)).toBe(false);
    expect(canCharge(flags({ detailsSubmitted: true }))).toBe(false);
  });
});

describe("processing fee (the application fee)", () => {
  it("defaults to Stripe's US pricing, keyed and on the reader", () => {
    expect(processingFeeCents(10_000, DEFAULT_PROCESSING_FEES.keyed)).toBe(320);
    expect(processingFeeCents(10_000, DEFAULT_PROCESSING_FEES.terminal)).toBe(275);
    expect(processingFeeCents(3_531, DEFAULT_PROCESSING_FEES.keyed)).toBe(Math.round(3_531 * 0.029) + 30);
  });

  it("is never more than the charge, and nothing on nothing", () => {
    expect(processingFeeCents(20, DEFAULT_PROCESSING_FEES.keyed)).toBe(20);
    expect(processingFeeCents(0, DEFAULT_PROCESSING_FEES.keyed)).toBe(0);
    expect(processingFeeCents(-500, DEFAULT_PROCESSING_FEES.keyed)).toBe(0);
  });

  it("parses the env overrides and refuses nonsense", () => {
    expect(parseFeeRate("2.9%+30")).toEqual({ rate: 0.029, fixedCents: 30 });
    expect(parseFeeRate(" 2.6 % + 10¢ ")).toEqual({ rate: 0.026, fixedCents: 10 });
    expect(parseFeeRate("3%")).toEqual({ rate: 0.03, fixedCents: 0 });
    for (const bad of [undefined, null, "", "abc", "30", "25%+5", "-1%+5", "2.9%+x"]) expect(parseFeeRate(bad)).toBeNull();
  });

  it("formats for people", () => {
    expect(formatFeeRate(DEFAULT_PROCESSING_FEES.keyed)).toBe("2.9% + 30¢");
    expect(formatFeeRate({ rate: 0.03, fixedCents: 0 })).toBe("3%");
  });
});

describe("labels and owner checks", () => {
  it("names Stripe's requirement fields in plain words", () => {
    expect(requirementLabel("external_account")).toBe("Bank account for payouts");
    expect(requirementLabel("company.tax_id")).toBe("Business tax ID (EIN)");
    expect(requirementLabel("person_1Abc.verification.document")).toBe("Owner details (document)");
    expect(requirementLabel("settings.payments.statement_descriptor")).toBe("Statement descriptor");
  });

  it("checks an owner entity", () => {
    expect(ownerEntityProblem({ name: "Quad Cities Cuts LLC", kind: "franchisee", contactEmail: "q@example.test" })).toBeNull();
    expect(ownerEntityProblem({ name: " ", kind: "brand" })).toMatch(/name/);
    expect(ownerEntityProblem({ name: "Someone", kind: "partner" })).toMatch(/Rayz corporate or franchisee/);
    expect(ownerEntityProblem({ name: "Someone", kind: "brand", contactEmail: "nope" })).toMatch(/email/);
  });
});
