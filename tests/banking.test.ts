/**
 * Per-location banking: where each shop's card money settles (the brand's account, its own
 * connected account, or no cards), the go-live gate, statement descriptors, receipts, payout
 * breakdowns, and who may change any of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AccountFlags,
  PAYMENTS_MODES,
  descriptorSuffix,
  payoutScheduleLabel,
  paymentsStep,
  receiptBranding,
  statementDescriptorProblem,
  summarizePayout,
  takesCards,
} from "@/domain/connect";
import { LocationDraft, draftDefaults } from "@/domain/location-draft";
import { goLiveBlockers } from "@/domain/location-lifecycle";
import { PAGE_ACCESS } from "@/domain/navigation";
import { Grantor, OWNER_GRANTS, UserAccessState, effectiveAccess, roleChangeDenied, templateFor, userAccessChangeDenied } from "@/domain/permissions";

const flags = (o: Partial<AccountFlags> = {}): AccountFlags => ({
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
  disabledReason: null,
  deauthorizedAt: null,
  ...o,
});
const enabled = flags({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });

describe("payments mode", () => {
  it("cards work on the brand's account at once, on the shop's own once Stripe enables charges, and never when cash only", () => {
    expect(takesCards("brand", null)).toBe(true);
    expect(takesCards("connected", null)).toBe(false);
    expect(takesCards("connected", flags({ detailsSubmitted: true }))).toBe(false);
    expect(takesCards("connected", flags({ chargesEnabled: true, detailsSubmitted: true }))).toBe(true);
    expect(takesCards("connected", { ...enabled, deauthorizedAt: new Date() })).toBe(false);
    expect(takesCards("cash_only", enabled)).toBe(false);
  });

  it("the go-live step waits for charges_enabled on the shop's own account, not for payouts", () => {
    expect(paymentsStep("connected", null)).toMatchObject({ done: false });
    expect(paymentsStep("connected", flags({ requirementsDue: ["external_account"] }))).toMatchObject({ done: false });
    expect(paymentsStep("connected", flags({ detailsSubmitted: true }))).toMatchObject({ done: false });
    expect(paymentsStep("connected", flags({ chargesEnabled: true, detailsSubmitted: true, requirementsDue: ["external_account"] })).done).toBe(true);
    expect(paymentsStep("connected", enabled)).toMatchObject({ done: true, detail: expect.stringMatching(/payouts go to the shop's bank/) });
    expect(paymentsStep("brand", null)).toMatchObject({ done: true });
    expect(paymentsStep("cash_only", null)).toMatchObject({ done: true, detail: expect.stringMatching(/Cash and gift cards only/) });
  });

  it("an unfinished payments step blocks go-live", () => {
    const step = (done: boolean) => [{ key: "payments" as const, title: "Payments and banking", detail: "", required: true, done }];
    expect(goLiveBlockers(step(paymentsStep("connected", null).done))).toEqual(["payments"]);
    expect(goLiveBlockers(step(paymentsStep("brand", null).done))).toEqual([]);
    expect(goLiveBlockers(step(false), { cashOnly: true })).toEqual([]);
  });

  it("the wizard defaults to the shop's own account", () => {
    const d = LocationDraft.parse(draftDefaults({ name: "Ray'z Iowa City", slug: "iowa-city", address: "1 Main", city: "Iowa City", state: "IA", zip: "52240" }));
    expect(d.paymentsMode).toBe("connected");
    expect(d.statementDescriptor).toBeNull();
    expect(d.receipt).toEqual({ headline: null, footer: null, showLogo: true, showAddress: true, showPhone: true, reviewUrl: null, allowPrint: false, reviewFollowUp: { enabled: false, delayHours: 3, repeatDays: 90 }, reviewMinVisits: null, reviewSnoozeDays: null });
    expect(PAYMENTS_MODES).toEqual(["connected", "entity", "brand", "cash_only"]);
  });
});

describe("statement descriptor", () => {
  it("follows Stripe's rules", () => {
    expect(statementDescriptorProblem(null)).toBeNull();
    expect(statementDescriptorProblem("RAYZ CORALVILLE")).toBeNull();
    expect(statementDescriptorProblem("RAYZ")).toMatch(/5 to 22/);
    expect(statementDescriptorProblem("RAYZ CORALVILLE IOWA CITY")).toMatch(/5 to 22/);
    expect(statementDescriptorProblem("12345")).toMatch(/letter/);
    expect(statementDescriptorProblem("RAYZ*CUTS")).toMatch(/can't contain/);
    expect(statementDescriptorProblem("RAYZ ÇUTS")).toBeTruthy();
  });

  it("the wizard uppercases it and refuses a bad one", () => {
    const base = draftDefaults({ name: "Ray'z Iowa City", slug: "iowa-city", address: "1 Main", city: "Iowa City", state: "IA", zip: "52240" });
    expect(LocationDraft.parse({ ...base, statementDescriptor: " rayz iowa city " }).statementDescriptor).toBe("RAYZ IOWA CITY");
    expect(LocationDraft.parse({ ...base, statementDescriptor: "" }).statementDescriptor).toBeNull();
    expect(LocationDraft.safeParse({ ...base, statementDescriptor: "bad'one" }).success).toBe(false);
  });

  it("on the brand's account only the suffix after the brand prefix is sent, within 22 characters overall", () => {
    expect(descriptorSuffix("RAYZ CORALVILLE", "RAYZ")).toBe("CORALVILLE");
    expect(descriptorSuffix("CORALVILLE", "RAYZ")).toBe("CORALVILLE");
    const s = descriptorSuffix("RAYZ NORTH LIBERTY IOWA", "RAYZ")!;
    expect("RAYZ".length + 2 + s.length).toBeLessThanOrEqual(22);
    expect(descriptorSuffix("RAYZ", "RAYZ")).toBeNull();
  });
});

describe("payout schedule and breakdown", () => {
  it("reads Stripe's schedule in plain words", () => {
    expect(payoutScheduleLabel(null)).toMatch(/Not reported/);
    expect(payoutScheduleLabel({ interval: "daily", delayDays: 2 })).toBe("Daily, 2 days after the charge");
    expect(payoutScheduleLabel({ interval: "weekly", delayDays: 7, weeklyAnchor: "friday" })).toMatch(/^Weekly on Friday/);
    expect(payoutScheduleLabel({ interval: "monthly", delayDays: 7, monthlyAnchor: 15 })).toMatch(/^Monthly on the 15th/);
    expect(payoutScheduleLabel({ interval: "manual", delayDays: null })).toMatch(/^Manual/);
  });

  it("splits a payout into gross, fees and refunds, counting our application fee as a fee", () => {
    const items = [
      { type: "payment", amount: 3_000, fee: 0, sourceTransfer: "tr_1" },
      { type: "payment", amount: 5_000, fee: 0, sourceTransfer: "tr_2" },
      { type: "payment_refund", amount: -1_000, fee: 0 },
      { type: "adjustment", amount: -15, fee: 15 },
      { type: "payout", amount: -6_985, fee: 0 },
    ];
    const s = summarizePayout(items, new Map([["tr_1", 117], ["tr_2", 175]]));
    expect(s).toEqual({ grossCents: 8_292, feeCents: 307, refundCents: 1_000, itemCount: 4 });
    expect(s.grossCents - s.feeCents - s.refundCents).toBe(8_292 - 307 - 1_000);
  });

  it("a brand-account payout counts Stripe's own fee", () => {
    const s = summarizePayout([{ type: "charge", amount: 10_000, fee: 320 }], new Map());
    expect(s).toMatchObject({ grossCents: 10_000, feeCents: 320, refundCents: 0, itemCount: 1 });
  });
});

describe("receipt branding", () => {
  it("falls back to the brand's receipt", () => {
    expect(receiptBranding(null)).toEqual({ headline: null, footer: null, showLogo: true, showAddress: true, showPhone: true, reviewUrl: null, allowPrint: false, reviewFollowUp: { enabled: false, delayHours: 3, repeatDays: 90 }, reviewMinVisits: null, reviewSnoozeDays: null });
    expect(receiptBranding({ headline: "Ray'z Iowa City", showPhone: false })).toMatchObject({ headline: "Ray'z Iowa City", showPhone: false, showAddress: true });
    expect(receiptBranding({ headline: "x".repeat(200) })).toEqual(receiptBranding({}));
  });
});

describe("banking permission", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const access = (key: string) => effectiveAccess(templateFor(key)!);
  const grantor = (key: string, staffId: string): Grantor => {
    const a = access(key);
    return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope: "all", shopIds: [A] };
  };
  const owner = grantor("brand_owner", "owner");
  const admin = grantor("brand_admin", "admin");
  const state = (key: string, extra: string[] = []): UserAccessState => {
    const a = access(key);
    return { staffId: "target", isOwner: a.isOwner, permissions: new Set([...a.permissions, ...(extra as never[])]), maxDiscountPct: a.maxDiscountPct, scope: "all", shopIds: [] };
  };

  it("comes with the Brand Owner role only; Brand Admin doesn't have it", () => {
    expect(OWNER_GRANTS.has("payments.banking")).toBe(true);
    expect(access("brand_owner").permissions.has("payments.banking")).toBe(true);
    expect(access("brand_admin").permissions.has("payments.banking")).toBe(false);
    expect(access("brand_admin").permissions.has("payments.accounts")).toBe(true);
  });

  it("only the Brand Owner grants or removes it, on a role or a person", () => {
    const custom = (permissions: string[]) => ({ key: null, name: "Bookkeeper", permissions, maxDiscountPct: 0 });
    expect(roleChangeDenied(owner, null, custom(["payments.banking"]))).toBeNull();
    expect(roleChangeDenied(admin, null, custom(["payments.banking"]))).toMatch(/Only the Brand Owner can grant or remove/);
    expect(roleChangeDenied({ ...admin, permissions: new Set([...admin.permissions, "payments.banking"]) }, custom(["payments.banking"]), custom([]))).toMatch(/Only the Brand Owner/);

    const t = state("brand_admin");
    const give = { ...t, permissions: new Set([...t.permissions, "payments.banking" as const]), overrides: { "payments.banking": true } };
    expect(userAccessChangeDenied(owner, t, give, { activeOwners: 1 })).toBeNull();
    expect(userAccessChangeDenied(admin, t, give, { activeOwners: 1 })).toMatch(/Only the Brand Owner can grant or remove/);
    const had = state("brand_admin", ["payments.banking"]);
    const take = { ...had, permissions: new Set([...had.permissions].filter((p) => p !== "payments.banking")), overrides: {} };
    expect(userAccessChangeDenied({ ...admin, permissions: new Set([...admin.permissions, "payments.banking"]) }, had, take, { activeOwners: 1 })).toMatch(/Only the Brand Owner/);
  });

  it("guards Stripe's stand-in onboarding page; payouts need the Shop P&L report", () => {
    expect(PAGE_ACCESS["/admin/setup/simulated-onboarding"]).toEqual(["payments.banking"]);
    expect(PAGE_ACCESS["/admin/payouts"]).toEqual(["report.shop_accounts.view"]);
  });
});

describe("no bank or identity numbers in our database", () => {
  it("the schema has no column for account, routing, SSN or EIN numbers", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    const migrations = ["core_0029_location_banking", "core_0033_tip_payouts", "core_0034_staff_banking"].map((f) => readFileSync(`drizzle/${f}.sql`, "utf8"));
    for (const src of [schema, ...migrations]) {
      expect(src).not.toMatch(/routing_number|account_number_full|bank_account_number|\bssn\b|ssn_last|tax_id_number|\bein\b/i);
    }
    expect(schema).not.toMatch(/\w+\("(routing|ssn|ein|bank_account)\w*"/i);
  });
});
