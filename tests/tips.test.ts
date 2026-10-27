import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND_TIP_POLICY,
  DEFAULT_SHOP_TIP_SETTINGS,
  PAYROLL_TIP_SETTINGS,
  defaultShopTipSettings,
  REMINDER_DAYS,
  REMINDER_MAX,
  availableOn,
  reminderPolicy,
  brandTipPolicy,
  draftPayouts,
  employeeFeeCents,
  instantFeePayer,
  receivedCents,
  shopCostCents,
  effectiveMethod,
  entryStatus,
  feeShareCents,
  instantFeeCents,
  parseInstantFee,
  payoutTotals,
  reversalFeeCents,
  scheduledBatch,
  settingsProblem,
  shopTipSettings,
  summarize,
  withPayoutRails,
  type LedgerEntry,
  type ShopTipSettings,
} from "@/domain/tips";

let n = 0;
const e = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: `e${++n}`, staffId: "b1", kind: "tip", method: "card", amountCents: 1000, feeCents: 0, businessDate: "2026-10-20", payoutId: null, ...over });
const settings = (over: Partial<ShopTipSettings> = {}): ShopTipSettings => ({ ...DEFAULT_SHOP_TIP_SETTINGS, cardDelayDays: 0, ...over });

describe("tip ledger math with refunds", () => {
  it("a refund's reversal nets against the tip; a full refund leaves nothing to pay", () => {
    const tip = e({ amountCents: 2000, feeCents: 62 });
    const refund = e({ kind: "refund", amountCents: -2000, feeCents: -reversalFeeCents(tip, 2000) });
    expect(refund.feeCents).toBe(-62);
    expect(payoutTotals([tip, refund], true)).toEqual({ grossCents: 0, feeCents: 0, adjustCents: 0, netCents: 0 });
    expect(draftPayouts([tip, refund], settings(), "2026-10-20", "2026-10-20").payouts).toEqual([]);
  });

  it("a partial tip refund takes back its share of the fee, rounded, and nets the rest", () => {
    const tip = e({ amountCents: 1500, feeCents: 47 });
    const back = reversalFeeCents(tip, 500);
    expect(back).toBe(16);
    const t = payoutTotals([tip, e({ kind: "refund", amountCents: -500, feeCents: -back })], true);
    expect(t).toEqual({ grossCents: 1000, feeCents: 31, adjustCents: 0, netCents: 969 });
    expect(payoutTotals([tip, e({ kind: "refund", amountCents: -500, feeCents: -back })], false).netCents).toBe(1000);
  });

  it("a refund after the tip was paid out carries a negative balance that the next batch nets off", () => {
    const paid = e({ amountCents: 3000, payoutId: "p1", payoutStatus: "paid" });
    const refund = e({ kind: "refund", amountCents: -3000, businessDate: "2026-10-21" });
    const next = e({ amountCents: 1200, method: "cash", businessDate: "2026-10-21" });
    const first = draftPayouts([paid, refund], settings(), "2026-10-21", "2026-10-21");
    expect(first.payouts).toEqual([]);
    expect(first.carried).toEqual([{ staffId: "b1", netCents: -3000 }]);
    const later = e({ amountCents: 2500, method: "cash", businessDate: "2026-10-22" });
    const second = draftPayouts([paid, refund, next, later], settings(), "2026-10-22", "2026-10-22");
    expect(second.payouts).toEqual([expect.objectContaining({ staffId: "b1", grossCents: 700, netCents: 700, entryIds: [refund.id, next.id, later.id] })]);
  });

  it("adjustments add to the net but aren't tips and don't carry a card fee", () => {
    const t = payoutTotals([e({ amountCents: 1000, feeCents: 30 }), e({ kind: "adjust", method: "adjust", amountCents: -250, feeCents: 99 })], true);
    expect(t).toEqual({ grossCents: 1000, feeCents: 30, adjustCents: -250, netCents: 720 });
  });

  it("the card fee share is pro rata to the charge", () => {
    expect(feeShareCents(310, 1000, 5000)).toBe(62);
    expect(feeShareCents(310, 0, 5000)).toBe(0);
    expect(feeShareCents(310, 1000, 0)).toBe(0);
    expect(reversalFeeCents({ amountCents: 1000, feeCents: 33 }, 1000)).toBe(33);
    expect(reversalFeeCents({ amountCents: 0, feeCents: 0 }, 100)).toBe(0);
  });

  it("each employee gets their own payout", () => {
    const r = draftPayouts([e({ staffId: "a", amountCents: 500 }), e({ staffId: "b", amountCents: 700 }), e({ staffId: "a", method: "cash", amountCents: 300 })], settings(), "2026-10-20", "2026-10-20");
    expect(Object.fromEntries(r.payouts.map((p) => [p.staffId, p.netCents]))).toEqual({ a: 800, b: 700 });
  });
});

describe("delayed availability", () => {
  const s = settings({ schedule: "daily_delay", cardDelayDays: 2 });

  it("card tips wait the shop's delay; cash and gift card tips, and refunds, count at once", () => {
    expect(availableOn(e({ method: "card" }), s)).toBe("2026-10-22");
    expect(availableOn(e({ method: "cash" }), s)).toBe("2026-10-20");
    expect(availableOn(e({ method: "gift_card" }), s)).toBe("2026-10-20");
    expect(availableOn(e({ kind: "refund", method: "card", amountCents: -500 }), s)).toBe("2026-10-20");
  });

  it("status goes pending settlement, available, in a payout, paid out", () => {
    const card = e({ method: "card" });
    expect(entryStatus(card, s, "2026-10-21")).toBe("pending_settlement");
    expect(entryStatus(card, s, "2026-10-22")).toBe("available");
    expect(entryStatus({ ...card, payoutId: "p", payoutStatus: "approved" }, s, "2026-10-22")).toBe("in_batch");
    expect(entryStatus({ ...card, payoutId: "p", payoutStatus: "paid" }, s, "2026-10-22")).toBe("paid_out");
  });

  it("a batch only takes card tips that have settled by the day it's paid", () => {
    const monday = e({ method: "card", amountCents: 1000, businessDate: "2026-10-19" });
    const tuesday = e({ method: "card", amountCents: 2000, businessDate: "2026-10-20" });
    const cash = e({ method: "cash", amountCents: 400, businessDate: "2026-10-20" });
    const r = draftPayouts([monday, tuesday, cash], s, "2026-10-20", "2026-10-21");
    expect(r.payouts[0]).toMatchObject({ grossCents: 1400, entryIds: [monday.id, cash.id] });
    expect(draftPayouts([monday, tuesday, cash], s, "2026-10-20", "2026-10-22").payouts[0].grossCents).toBe(3400);
  });

  it("nothing after the cutoff, and nothing already in a payout", () => {
    const r = draftPayouts([e({ method: "cash", businessDate: "2026-10-21" }), e({ method: "cash", payoutId: "p1" })], settings(), "2026-10-20", "2026-10-25");
    expect(r.payouts).toEqual([]);
  });

  it("the summary splits today, pending, available, in a payout and paid out", () => {
    const today = "2026-10-21";
    const sum = summarize(
      [
        e({ method: "card", amountCents: 1000, businessDate: today }),
        e({ method: "cash", amountCents: 300, businessDate: today }),
        e({ method: "card", amountCents: 800, businessDate: "2026-10-18" }),
        e({ method: "cash", amountCents: 200, businessDate: "2026-10-18", payoutId: "p", payoutStatus: "approved" }),
        e({ method: "cash", amountCents: 900, businessDate: "2026-10-10", payoutId: "q", payoutStatus: "paid" }),
      ],
      s,
      today,
    );
    expect(sum).toEqual({ todayCents: 1300, pendingSettlementCents: 1000, availableCents: 1100, inPayoutCents: 200, paidOutCents: 900 });
  });

  it("daily batches build every day through yesterday; weekly ones on their weekday", () => {
    expect(scheduledBatch(s, "2026-10-23", 5)).toEqual({ kind: "daily_delay", cutoff: "2026-10-22" });
    const weekly = settings({ schedule: "weekly", weeklyDay: 1 });
    expect(scheduledBatch(weekly, "2026-10-26", 1)).toEqual({ kind: "weekly", cutoff: "2026-10-25" });
    expect(scheduledBatch(weekly, "2026-10-27", 2)).toBeNull();
    expect(scheduledBatch(settings({ schedule: "end_of_night" }), "2026-10-23", 5)).toBeNull();
    expect(scheduledBatch(settings({ schedule: "manual" }), "2026-10-23", 5)).toBeNull();
    expect(scheduledBatch(settings({ schedule: "payroll" }), "2026-10-23", 5)).toBeNull();
  });
});

describe("settings and methods", () => {
  it("shop settings parse with safe defaults, and the delay defaults per schedule", () => {
    expect(shopTipSettings(null)).toEqual(DEFAULT_SHOP_TIP_SETTINGS);
    expect(shopTipSettings({ schedule: "daily_delay" }).cardDelayDays).toBe(2);
    expect(shopTipSettings({ schedule: "daily_delay", cardDelayDays: 3 }).cardDelayDays).toBe(3);
    expect(shopTipSettings({ schedule: "nope", cardDelayDays: -1, weeklyDay: 9, netCardFee: "yes" })).toEqual(DEFAULT_SHOP_TIP_SETTINGS);
    expect(shopTipSettings({ schedule: "payroll", defaultMethod: "cash" }).defaultMethod).toBe("payroll");
  });

  it("a shop can't default to a method the brand doesn't allow", () => {
    const policy = brandTipPolicy({ methods: ["stripe"] });
    expect(shopTipSettings({ schedule: "daily_delay", defaultMethod: "cash" }, policy).defaultMethod).toBe("stripe");
    expect(settingsProblem({ ...DEFAULT_SHOP_TIP_SETTINGS, schedule: "payroll", defaultMethod: "stripe" }, policy)).toMatch(/through payroll/);
    expect(settingsProblem({ ...DEFAULT_SHOP_TIP_SETTINGS, defaultMethod: "cash" }, policy)).toMatch(/doesn't allow/);
    expect(brandTipPolicy({ methods: [] }).methods).toEqual(DEFAULT_BRAND_TIP_POLICY.methods);
  });

  it("employees choose where the brand lets them; payroll-only shops pay everyone through payroll", () => {
    const shop = settings({ schedule: "daily_delay", defaultMethod: "cash" });
    expect(effectiveMethod(shop, DEFAULT_BRAND_TIP_POLICY, "stripe")).toBe("stripe");
    expect(effectiveMethod(shop, DEFAULT_BRAND_TIP_POLICY, null)).toBe("cash");
    expect(effectiveMethod(shop, { ...DEFAULT_BRAND_TIP_POLICY, employeeChooses: false }, "stripe")).toBe("cash");
    expect(effectiveMethod(shop, { ...DEFAULT_BRAND_TIP_POLICY, methods: ["cash"] }, "stripe")).toBe("cash");
    expect(effectiveMethod(settings({ schedule: "payroll" }), DEFAULT_BRAND_TIP_POLICY, "stripe")).toBe("payroll");
  });

  it("out of the box tips go by Stripe in a daily batch, payroll stays a choice; without the Stripe rail, a Stripe choice is paid through payroll or cash", () => {
    expect(shopTipSettings(null)).toMatchObject({ schedule: "daily_delay", cardDelayDays: 2, defaultMethod: "stripe" });
    expect(effectiveMethod(shopTipSettings(null), DEFAULT_BRAND_TIP_POLICY, null)).toBe("stripe");
    expect(effectiveMethod(shopTipSettings(null), DEFAULT_BRAND_TIP_POLICY, "payroll")).toBe("payroll");
    expect(effectiveMethod(shopTipSettings({ schedule: "payroll" }), DEFAULT_BRAND_TIP_POLICY, "stripe")).toBe("payroll");
    const held = withPayoutRails(DEFAULT_BRAND_TIP_POLICY, { stripe: false });
    expect(shopTipSettings(null, held)).toEqual(PAYROLL_TIP_SETTINGS);
    expect(defaultShopTipSettings(held)).toBe(PAYROLL_TIP_SETTINGS);
    expect(effectiveMethod(shopTipSettings(null, held), held, "stripe")).toBe("payroll");
    expect(held).toMatchObject({ methods: ["cash", "payroll"], instantAllowed: false });
    expect(withPayoutRails(brandTipPolicy({ methods: ["stripe"] }), { stripe: false }).methods).toEqual(["payroll"]);
    expect(withPayoutRails(DEFAULT_BRAND_TIP_POLICY, { stripe: true })).toBe(DEFAULT_BRAND_TIP_POLICY);
    const batches = settings({ schedule: "daily_delay", defaultMethod: "stripe" });
    expect(effectiveMethod(shopTipSettings(batches, held), held, "stripe")).toBe("payroll");
    expect(effectiveMethod(shopTipSettings(batches, held), held, "cash")).toBe("cash");
  });

  it("the instant payout fee is a percentage with a minimum, never more than the payout", () => {
    expect(instantFeeCents(10_000)).toBe(150);
    expect(instantFeeCents(1_000)).toBe(50);
    expect(instantFeeCents(30)).toBe(30);
    expect(instantFeeCents(0)).toBe(0);
    expect(parseInstantFee("1.75%min25")).toEqual({ pct: 1.75, minCents: 25 });
    expect(parseInstantFee("1%")).toEqual({ pct: 1, minCents: 0 });
    expect(parseInstantFee("cheap")).toBeNull();
    expect(instantFeeCents(10_000, { pct: 1.75, minCents: 25 })).toBe(175);
  });
});

describe("payout setup reminders in the brand's tip policy", () => {
  it("every 3 days, up to 4 after each invite, by default; out-of-range values fall back", () => {
    expect(reminderPolicy(brandTipPolicy({}))).toEqual({ everyDays: 3, max: 4 });
    expect(reminderPolicy(brandTipPolicy({ reminderEveryDays: 7, reminderMax: 0 }))).toEqual({ everyDays: 7, max: 0 });
    expect(reminderPolicy(brandTipPolicy({ reminderEveryDays: 0, reminderMax: 11 }))).toEqual({ everyDays: 3, max: 4 });
    expect(reminderPolicy(brandTipPolicy({ reminderEveryDays: 2.5, reminderMax: "2" }))).toEqual({ everyDays: 3, max: 4 });
    expect(brandTipPolicy({ reminderEveryDays: 14, reminderMax: 10 })).toMatchObject({ reminderEveryDays: REMINDER_DAYS.max, reminderMax: REMINDER_MAX.max });
  });
});

describe("who pays the instant payout fee", () => {
  it("the brand passes it on by default; absorbed, the employee gets the whole net and the shop pays it on top", () => {
    expect(brandTipPolicy({}).instantFeePassedOn).toBe(true);
    expect(brandTipPolicy({ instantFeePassedOn: false }).instantFeePassedOn).toBe(false);
    expect(brandTipPolicy({ instantFeePassedOn: "no" }).instantFeePassedOn).toBe(true);
    expect(instantFeePayer(DEFAULT_BRAND_TIP_POLICY)).toBe("employee");
    expect(instantFeePayer({ instantFeePassedOn: false })).toBe("shop");
    const passed = { netCents: 2500, instantFeeCents: 50, instantFeePaidBy: "employee" };
    const absorbed = { ...passed, instantFeePaidBy: "shop" };
    expect([receivedCents(passed), shopCostCents(passed), employeeFeeCents(passed)]).toEqual([2450, 2500, 50]);
    expect([receivedCents(absorbed), shopCostCents(absorbed), employeeFeeCents(absorbed)]).toEqual([2500, 2550, 0]);
    const standard = { netCents: 2500, instantFeeCents: 0, instantFeePaidBy: "shop" };
    expect([receivedCents(standard), shopCostCents(standard)]).toEqual([2500, 2500]);
  });
});
