import { describe, expect, it } from "vitest";
import { bankingStatus, defaultDestination, destinationLabel, destinationOf, requirementLabels, sameDestination } from "@/domain/banking";

const facts = (o: Partial<Parameters<typeof bankingStatus>[0] & object> = {}) => ({
  stripeAccountId: "acct_1",
  detailsSubmitted: true,
  payoutsEnabled: true,
  requirementsDue: [] as string[],
  disabledReason: null,
  ...o,
});

describe("banking status", () => {
  it("is not set up until Stripe's onboarding is finished", () => {
    expect(bankingStatus(null)).toBe("not_set_up");
    expect(bankingStatus(facts({ stripeAccountId: null }))).toBe("not_set_up");
    expect(bankingStatus(facts({ detailsSubmitted: false, payoutsEnabled: false, requirementsDue: ["external_account"] }))).toBe("not_set_up");
  });

  it("is pending verification while Stripe checks what was sent, ready once payouts are on", () => {
    expect(bankingStatus(facts({ payoutsEnabled: false }))).toBe("pending_verification");
    expect(bankingStatus(facts())).toBe("ready");
  });

  it("is action needed while Stripe asks for anything, even if payouts still work until the deadline, or if it rejected the account", () => {
    expect(bankingStatus(facts({ requirementsDue: ["individual.verification.document"] }))).toBe("action_needed");
    expect(bankingStatus(facts({ payoutsEnabled: false, requirementsDue: ["external_account"] }))).toBe("action_needed");
    expect(bankingStatus(facts({ payoutsEnabled: false, disabledReason: "rejected.fraud" }))).toBe("action_needed");
    expect(bankingStatus(facts({ payoutsEnabled: false, disabledReason: "requirements.pending_verification" }))).toBe("pending_verification");
  });
});

describe("what Stripe needs, in plain words", () => {
  it("names each requirement once", () => {
    expect(requirementLabels(["individual.dob.day", "individual.dob.month", "individual.dob.year", "individual.address.line1", "individual.address.postal_code", "external_account", "individual.ssn_last_4"])).toEqual([
      "Your date of birth",
      "Your home address",
      "A bank account or debit card for payouts",
      "The last 4 digits of your Social Security number",
    ]);
  });
  it("falls back to readable words for keys it doesn't know", () => {
    expect(requirementLabels(["individual.political_exposure"])).toEqual(["political exposure"]);
    expect(requirementLabels([])).toEqual([]);
  });
});

describe("payout destination", () => {
  const bank = { object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789", routing_number: "110000000", account_holder_name: "Pat", fingerprint: "fp_1", default_for_currency: true };
  const card = { object: "card", brand: "Visa", last4: "5556", funding: "debit", fingerprint: "fp_2", exp_month: 12, exp_year: 2030 };

  it("keeps only the type, last 4 and bank or card name", () => {
    expect(destinationOf(bank)).toEqual({ type: "bank_account", last4: "6789", name: "STRIPE TEST BANK" });
    expect(destinationOf(card)).toEqual({ type: "card", last4: "5556", name: "Visa" });
    expect(JSON.stringify(destinationOf(bank))).not.toMatch(/110000000|Pat|fp_1/);
  });

  it("rejects anything that isn't a bank or card with a 4-digit last 4", () => {
    expect(destinationOf(null)).toBeNull();
    expect(destinationOf({ object: "person", last4: "1234" })).toBeNull();
    expect(destinationOf({ object: "card", last4: "4242424242424242" })).toBeNull();
    expect(destinationOf({ object: "card", last4: "12a4" })).toBeNull();
  });

  it("picks the default for USD, or the only one", () => {
    expect(defaultDestination([card, bank])).toMatchObject({ type: "bank_account" });
    expect(defaultDestination([card])).toMatchObject({ type: "card" });
    expect(defaultDestination([card, { ...bank, default_for_currency: false }])).toBeNull();
    expect(defaultDestination(undefined)).toBeNull();
  });

  it("compares and labels destinations", () => {
    const d = destinationOf(card)!;
    expect(sameDestination(d, { ...d })).toBe(true);
    expect(sameDestination(d, { ...d, last4: "0000" })).toBe(false);
    expect(sameDestination(null, null)).toBe(true);
    expect(sameDestination(d, null)).toBe(false);
    expect(destinationLabel(d)).toBe("Visa card ••5556");
    expect(destinationLabel(destinationOf(bank))).toBe("STRIPE TEST BANK ••6789");
    expect(destinationLabel({ type: "card", last4: "1111", name: null })).toBe("Debit card ••1111");
    expect(destinationLabel(null)).toBe("None yet");
  });
});
