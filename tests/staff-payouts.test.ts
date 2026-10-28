import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DASHBOARDS,
  ACCOUNT_STATES,
  AFTER_PAYOUT_RULES,
  DEFAULT_STAFF_PAYOUT_SETTINGS,
  ONBOARDING_MODES,
  REVERSAL_RULES,
  SERVICE_AGREEMENTS,
  TIP_REFUND_OVERFLOW,
  accountState,
  bankingStatusOf,
  canReceiveIn,
  employerTaxIdLabel,
  expectedTransition,
  heldLabel,
  instantFeeTerms,
  instantOn,
  reversalOutcome,
  staffPayoutSettings,
  taxCheckDue,
  taxIdLast4,
  tipsPaidGap,
  tipsPaidStatus,
  type AccountFacts,
  type TipsPaidBuckets,
} from "@/domain/staff-payouts";
import { DEFAULT_BRAND_TIP_POLICY, brandTipPolicy, flooredTips } from "@/domain/tips";

const facts = (o: Partial<AccountFacts> = {}): AccountFacts => ({
  stripeAccountId: "acct_1",
  detailsSubmitted: true,
  payoutsEnabled: true,
  transfersCapability: "active",
  requirementsDue: [],
  requirementsPastDue: [],
  requirementsPending: [],
  disabledReason: null,
  deauthorizedAt: null,
  ...o,
});

describe("staff payout settings", () => {
  it("defaults to recipient accounts with no dashboard, embedded onboarding, owed through payroll, the shop absorbing refunded tips, the sale date and will-not-file", () => {
    expect(staffPayoutSettings(null)).toEqual(DEFAULT_STAFF_PAYOUT_SETTINGS);
    expect(DEFAULT_STAFF_PAYOUT_SETTINGS).toMatchObject({
      dashboard: "none",
      serviceAgreement: "recipient",
      onboarding: "embedded",
      owedVia: "payroll",
      reversalRule: "never",
      afterPayoutRefunds: "shop_cost",
      reversalWindowDays: 7,
      tipDate: "sale_date",
      taxForms: "will_not_file",
      instantFeeAck: true,
      tipsOnPaycheck: false,
    });
  });

  it("keeps good values and drops bad ones to the default", () => {
    expect(staffPayoutSettings({ reversalWindowDays: 30, tipDate: "payment_date", taxCheckMonth: 12, tipRefundOverflow: "shop" })).toMatchObject({ reversalWindowDays: 30, tipDate: "payment_date", taxCheckMonth: 12, tipRefundOverflow: "shop" });
    expect(staffPayoutSettings({ dashboard: "full", reversalWindowDays: 500, owedVia: "twice", taxCheckMonth: 13, taxForms: "file", instantFeeAck: "yes", tipsOnPaycheck: "on" })).toEqual(DEFAULT_STAFF_PAYOUT_SETTINGS);
    expect(staffPayoutSettings({ reversalWindowDays: 2.5 }).reversalWindowDays).toBe(7);
  });

  it("fixes barber accounts to recipient, no Stripe dashboard and embedded onboarding: settings saved as Express, full or hosted read as the fixed values (ST-I9)", () => {
    expect(ACCOUNT_DASHBOARDS).toEqual(["none"]);
    expect(SERVICE_AGREEMENTS).toEqual(["recipient"]);
    expect(ONBOARDING_MODES).toEqual(["embedded"]);
    expect(staffPayoutSettings({ dashboard: "express", serviceAgreement: "full", onboarding: "hosted" })).toMatchObject({ dashboard: "none", serviceAgreement: "recipient", onboarding: "embedded", taxForms: "will_not_file" });
  });

  it("a refund bigger than the sale's portion is absorbed by the platform unless the brand picks the shop", () => {
    expect(DEFAULT_STAFF_PAYOUT_SETTINGS.tipRefundOverflow).toBe("platform");
    expect(TIP_REFUND_OVERFLOW).toEqual(["platform", "shop"]);
    expect(staffPayoutSettings({ tipRefundOverflow: "barber" }).tipRefundOverflow).toBe("platform");
  });

  it("instant payouts are off by default (ST-I12)", () => {
    expect(DEFAULT_BRAND_TIP_POLICY.instantAllowed).toBe(false);
    expect(brandTipPolicy(null).instantAllowed).toBe(false);
  });
});

describe("the seven account states (ST-C12)", () => {
  it("reads each state from Stripe's view of the account", () => {
    expect(accountState(null)).toBe("not_started");
    expect(accountState(facts({ stripeAccountId: null }))).toBe("not_started");
    expect(accountState(facts({ detailsSubmitted: false, payoutsEnabled: false, transfersCapability: "inactive" }))).toBe("in_progress");
    expect(accountState(facts({ payoutsEnabled: false, transfersCapability: "pending", requirementsPending: ["individual.verification.document"] }))).toBe("pending_verification");
    expect(accountState(facts({ payoutsEnabled: false, transfersCapability: "inactive", disabledReason: "requirements.pending_verification" }))).toBe("pending_verification");
    expect(accountState(facts({ requirementsDue: ["individual.id_number"] }))).toBe("requirements_due");
    expect(accountState(facts({ payoutsEnabled: false, transfersCapability: "inactive", requirementsDue: ["individual.id_number"], requirementsPastDue: ["individual.id_number"], disabledReason: "requirements.past_due" }))).toBe("restricted");
    expect(accountState(facts())).toBe("active");
    expect(accountState(facts({ disabledReason: "rejected.fraud" }))).toBe("rejected");
    expect(accountState(facts({ deauthorizedAt: new Date() }))).toBe("rejected");
  });

  it("reads accounts saved before the transfers capability was tracked from payouts_enabled", () => {
    expect(accountState(facts({ transfersCapability: null }))).toBe("active");
    expect(accountState(facts({ transfersCapability: null, payoutsEnabled: false }))).toBe("pending_verification");
    expect(accountState(facts({ transfersCapability: null, payoutsEnabled: false, requirementsDue: ["external_account"] }))).toBe("restricted");
  });

  it("pays only active accounts (and active ones with something due), and maps to the four banking statuses", () => {
    expect(ACCOUNT_STATES.filter(canReceiveIn)).toEqual(["requirements_due", "active"]);
    expect(Object.fromEntries(ACCOUNT_STATES.map((s) => [s, bankingStatusOf(s)]))).toEqual({
      not_started: "not_set_up",
      in_progress: "not_set_up",
      pending_verification: "pending_verification",
      requirements_due: "action_needed",
      restricted: "action_needed",
      active: "ready",
      rejected: "action_needed",
    });
  });

  it("flags the moves Stripe's events shouldn't make", () => {
    expect(expectedTransition("in_progress", "active")).toBe(true);
    expect(expectedTransition("active", "restricted")).toBe(true);
    expect(expectedTransition("active", "active")).toBe(true);
    expect(expectedTransition("rejected", "active")).toBe(false);
    expect(expectedTransition("active", "not_started")).toBe(false);
  });
});

describe("tip reversals (ST-C15)", () => {
  const d = { ...DEFAULT_STAFF_PAYOUT_SETTINGS, reversalRule: "full_refund_in_window" as const };
  it("the shop absorbs every refunded tip by default", () => {
    expect(reversalOutcome(DEFAULT_STAFF_PAYOUT_SETTINGS, { saleDate: "2026-10-01", refundDate: "2026-10-01", fullyRefunded: true })).toBe("absorb_rule");
  });
  it("with the window rule, takes an unpaid tip back on a full refund within the window, counted from the sale date", () => {
    expect(reversalOutcome(d, { saleDate: "2026-10-01", refundDate: "2026-10-08", fullyRefunded: true })).toBe("reverse");
    expect(reversalOutcome(d, { saleDate: "2026-10-01", refundDate: "2026-10-09", fullyRefunded: true })).toBe("absorb_window");
    expect(reversalOutcome(d, { saleDate: "2026-10-01", refundDate: "2026-10-02", fullyRefunded: false })).toBe("absorb_partial");
    expect(reversalOutcome({ ...d, reversalWindowDays: 0 }, { saleDate: "2026-10-01", refundDate: "2026-10-01", fullyRefunded: true })).toBe("reverse");
  });
  it("follows the brand's rule", () => {
    expect(reversalOutcome({ ...d, reversalRule: "never" }, { saleDate: "2026-10-01", refundDate: "2026-10-01", fullyRefunded: true })).toBe("absorb_rule");
    expect(reversalOutcome({ ...d, reversalRule: "any_refund" }, { saleDate: "2026-10-01", refundDate: "2026-12-01", fullyRefunded: false })).toBe("reverse");
  });
  it("a tip already paid or in a payout is always the shop's cost, whatever the rule; an old saved deduct reads as the shop's cost", () => {
    const paid = { saleDate: "2026-10-01", refundDate: "2026-10-02", fullyRefunded: true, afterPayout: true };
    expect(AFTER_PAYOUT_RULES).toEqual(["shop_cost"]);
    for (const reversalRule of REVERSAL_RULES) expect(reversalOutcome({ ...d, reversalRule }, paid)).toBe("absorb_after_payout");
    expect(staffPayoutSettings({ afterPayoutRefunds: "deduct" }).afterPayoutRefunds).toBe("shop_cost");
  });
});

describe("tips paid identity (ST-C13)", () => {
  const b = (o: Partial<TipsPaidBuckets> = {}): TipsPaidBuckets => ({ earnedCents: 10_000, transferredCents: 4_000, cashCents: 1_000, payrollCents: 3_000, owedCents: 2_000, inFlightCents: 0, ...o });
  it("is final once locked, nothing in flight, and earned = transferred + cash + payroll + owed", () => {
    expect(tipsPaidGap(b())).toBe(0);
    expect(tipsPaidStatus(b(), true)).toEqual({ status: "final", problems: [] });
  });
  it("is a draft with the reasons otherwise", () => {
    expect(tipsPaidStatus(b(), false).status).toBe("draft");
    expect(tipsPaidStatus(b({ owedCents: 0, inFlightCents: 2_000 }), true).problems).toEqual(["$20.00 is sent and not paid yet"]);
    expect(tipsPaidStatus(b({ payrollCents: 2_500 }), true).problems).toEqual(["$5.00 of tips isn't in any bucket"]);
    expect(tipsPaidStatus(b({ payrollCents: 3_500 }), true).problems).toEqual(["$5.00 of tips is counted twice"]);
  });
  it("flags owed that nets below zero, never taken back (ST-C0b)", () => {
    expect(tipsPaidStatus(b({ earnedCents: 7_500, owedCents: -500 }), true).problems).toEqual(["owed nets to -$5.00: never taken back, only offset by this employee's later unpaid tips"]);
  });
});

describe("payable tips never go below zero (ST-C0b)", () => {
  it("floors the total and splits it card first", () => {
    expect(flooredTips(1_000, 500)).toEqual({ cardCents: 1_000, cashCents: 500 });
    expect(flooredTips(-300, 500)).toEqual({ cardCents: 0, cashCents: 200 });
    expect(flooredTips(1_000, -400)).toEqual({ cardCents: 600, cashCents: 0 });
    expect(flooredTips(-300, -200)).toEqual({ cardCents: 0, cashCents: 0 });
  });
});

describe("instant payouts (ST-I12)", () => {
  const terms = instantFeeTerms({ pct: 1.5, minCents: 50 });
  it("words the fee as the employee accepts it", () => {
    expect(terms).toBe("1.5% (at least $0.50) per instant payout");
    expect(instantFeeTerms({ pct: 1, minCents: 0 })).toBe("1% per instant payout");
  });
  it("is on only when asked, allowed and (where required) the current fee is accepted", () => {
    const on = { asked: true, allowed: true, ackRequired: true, acceptedTerms: terms };
    expect(instantOn(on, terms)).toBe(true);
    expect(instantOn({ ...on, asked: false }, terms)).toBe(false);
    expect(instantOn({ ...on, allowed: false }, terms)).toBe(false);
    expect(instantOn({ ...on, acceptedTerms: null }, terms)).toBe(false);
    expect(instantOn({ ...on, acceptedTerms: "1% per instant payout" }, terms)).toBe(false);
    expect(instantOn({ ...on, ackRequired: false, acceptedTerms: null }, terms)).toBe(true);
  });
});

describe("tax forms and employers (ST-I13, ST-I14)", () => {
  it("the yearly check for the year just ended is due from the check month until recorded", () => {
    expect(taxCheckDue("2027-01-05", 1, [])).toEqual({ due: true, taxYear: 2026 });
    expect(taxCheckDue("2027-01-05", 1, [2026])).toEqual({ due: false, taxYear: 2026 });
    expect(taxCheckDue("2027-01-05", 2, [])).toEqual({ due: false, taxYear: 2026 });
    expect(taxCheckDue("2027-11-05", 12, [])).toEqual({ due: false, taxYear: 2026 });
  });
  it("only ever shows or keeps the last 4 of an EIN", () => {
    expect(employerTaxIdLabel("6789")).toBe("EIN ••6789");
    expect(employerTaxIdLabel(null)).toBe("EIN not on file");
    expect(employerTaxIdLabel("12-3456789")).toBe("EIN not on file");
    expect(taxIdLast4("12-3456789")).toBe("6789");
    expect(taxIdLast4("12")).toBeNull();
  });
  it("labels owed payouts", () => {
    expect(heldLabel({ status: "held", holdKind: "stripe_setup" })).toBe("Waiting for your Stripe setup");
    expect(heldLabel({ status: "held", holdKind: "transfers_pending" })).toBe("Owed: paid through payroll unless sent first");
    expect(heldLabel({ status: "held", holdKind: "manager" })).toBeNull();
    expect(heldLabel({ status: "approved", holdKind: null })).toBeNull();
  });
});
