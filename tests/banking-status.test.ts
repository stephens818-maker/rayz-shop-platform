import { describe, expect, it } from "vitest";
import { bankingStatus, defaultDestination, destinationLabel, destinationOf, externalAccountsOf, instantDestination, requirementLabels, sameDestination, storedExternalAccounts } from "@/domain/banking";

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

describe("external accounts", () => {
  const bank = { id: "ba_1", object: "bank_account", bank_name: "Chase", last4: "6789", routing_number: "110000000", fingerprint: "fp", default_for_currency: true, available_payout_methods: ["standard"] };
  const card = { id: "card_1", object: "card", brand: "Visa", last4: "5556", funding: "debit", exp_year: 2030, default_for_currency: false, available_payout_methods: ["standard", "instant"] };

  it("keep only Stripe's id, the type, name and last 4, the default first", () => {
    const list = externalAccountsOf([card, bank, { id: "ba_bad", object: "bank_account", last4: "12" }, { id: "x", object: "card", last4: "1234" }]);
    expect(list).toEqual([
      { id: "ba_1", type: "bank_account", name: "Chase", last4: "6789", default: true, instant: false },
      { id: "card_1", type: "card", name: "Visa", last4: "5556", default: false, instant: true },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/110000000|fp|2030|debit/);
    expect(externalAccountsOf([{ ...card, default_for_currency: false }])[0].default).toBe(true);
  });

  it("instant payouts go to the default when it takes them, else the debit card that does", () => {
    const list = externalAccountsOf([bank, card]);
    expect(instantDestination(list)?.id).toBe("card_1");
    expect(instantDestination(externalAccountsOf([bank]))).toBeNull();
    expect(instantDestination(externalAccountsOf([{ ...card, default_for_currency: true }, bank]))?.id).toBe("card_1");
  });

  it("the saved list drops anything that isn't a clean entry", () => {
    expect(storedExternalAccounts([{ id: "card_1", type: "card", last4: "5556", name: "Visa", default: true, instant: true, number: "4000056655665556" }, { id: "ba_2", type: "bank_account", last4: "12345" }, "x"])).toEqual([
      { id: "card_1", type: "card", last4: "5556", name: "Visa", default: true, instant: true },
    ]);
    expect(storedExternalAccounts(null)).toEqual([]);
  });
});
