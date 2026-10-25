import { describe, expect, it } from "vitest";
import { REPORTS, ROLE_TEMPLATES, isPermission, type Permission } from "@/domain/permissions";
import { MATRIX_ACTIONS, MATRIX_AREAS, MATRIX_PERMISSIONS, cellOverride, cellState, nextOverride, setCell } from "@/domain/permission-matrix";
import { REPORT_GROUP, REPORT_GROUPS, groupReports } from "@/domain/report-groups";
import { lastBusinessDay, presetRange } from "@/domain/report-range";
import { ANALYTICS_PERIODS, comparePeriod, periodChange, yearBefore } from "@/domain/period-compare";
import { WATERFALL, waterfallGap } from "@/domain/sales-waterfall";
import { highProblem } from "@/domain/inventory";
import { applyPriceChange, bulkSummary, describePriceChange, templateProblem, weeklyHours } from "@/domain/bulk-edit";
import { brandDefaults, cleanPartial, columnPatch, effectiveDefaults, overridesFromColumns, parseDefault } from "@/domain/location-defaults";
import { reminderHours } from "@/domain/staff-notifications";
import { CONVERSION_EVENTS, trackBookingStep } from "@/lib/conversion-tracking";
import { jurisdictionGroups, ratePct } from "@/domain/tax-fees";
import { matchesFilters, parseAppointmentFilters, paymentOf, platformOf } from "@/domain/appointment-report";
import { ReconcileInput, isReconcilable, notYetPaidOut, unmatched } from "@/domain/payout-reconcile";
import { IssueCompInput, ledgerLabel, reloadProblem } from "@/domain/gift-cards";
import { PlanInput, membershipDiscounts, monthlyRecurring, periodEnd, planProblem, planSummary, visitsLeft } from "@/domain/memberships";
import { computeCheckout } from "@/domain/checkout";
import { callOutcome, choiceFromSpeech, cleanOperator, formatCallLength, needsFollowUp, operatorScript } from "@/domain/phone-operator";
import { gather } from "@/domain/twiml";

describe("report navigation and defaults", () => {
  it("puts every report in one category, in category order", () => {
    for (const r of REPORTS) expect(REPORT_GROUPS.some((g) => g.id === REPORT_GROUP[r.key]), r.key).toBe(true);
    const groups = groupReports(REPORTS);
    expect(groups.flatMap((g) => g.reports).length).toBe(REPORTS.length);
    expect(groups.map((g) => g.id)).toEqual(REPORT_GROUPS.map((g) => g.id));
    expect(groupReports(REPORTS.filter((r) => r.key === "my_sales")).map((g) => g.id)).toEqual(["sales"]);
  });

  it("the last business day skips Sundays: Monday opens on Saturday", () => {
    expect(lastBusinessDay("2026-10-26")).toBe("2026-10-24"); // Monday → Saturday
    expect(lastBusinessDay("2026-10-25")).toBe("2026-10-24"); // Sunday → Saturday
    expect(lastBusinessDay("2026-10-28")).toBe("2026-10-27"); // Wednesday → Tuesday
    expect(lastBusinessDay("2026-10-27", [0, 1])).toBe("2026-10-24"); // closed Mondays too
    expect(presetRange("lastday", "2026-10-26")).toEqual({ from: "2026-10-24", to: "2026-10-24" });
    expect(presetRange("4w", "2026-10-26")).toEqual({ from: "2026-09-29", to: "2026-10-26" });
  });
});

describe("sales waterfall", () => {
  const x = { grossSalesCents: 100_00, refundCents: 10_00, discountCents: 5_00, taxCents: 6_00, tipsCents: 15_00, cardFeeCents: 2_00, giftCardsSoldCents: 25_00, giftCardCents: 20_00, cardCents: 90_00, cashCents: 23_00 };
  const at = (label: string) => WATERFALL.find((w) => w.label === label)!.value(x);

  it("adds up from gross to collected, with card fees apart from tax", () => {
    expect(at("= Net sales")).toBe(85_00);
    expect(at("= Total paid")).toBe(85_00 + 6_00 + 15_00 + 2_00 + 25_00);
    expect(at("= Collected")).toBe(113_00);
    expect(waterfallGap(x)).toBe(0);
    expect(waterfallGap({ ...x, cashCents: 20_00 })).toBe(-3_00);
    expect(WATERFALL.map((w) => w.label).indexOf("+ Taxes")).toBeLessThan(WATERFALL.map((w) => w.label).indexOf("+ Card fees paid by clients"));
  });
});

describe("appointments report filters", () => {
  it("maps booking source to platform and payments to a payment label", () => {
    expect(platformOf("online")).toBe("web");
    expect(platformOf("api")).toBe("app");
    expect(platformOf("walk_in")).toBe("in_shop");
    expect(platformOf("import")).toBe("import");
    expect(paymentOf(null)).toBe("unpaid");
    expect(paymentOf(["cash"])).toBe("cash");
    expect(paymentOf(["card", "gift_card"])).toBe("split");
  });

  it("filters on status, method, platform and payment; unknown values are ignored", () => {
    const f = parseAppointmentFilters({ status: "completed", method: "online", platform: "bogus", payment: "gift_card" });
    expect(f).toEqual({ status: "completed", method: "online", platform: null, payment: "gift_card" });
    expect(matchesFilters({ status: "completed", source: "online", methods: ["card", "gift_card"] }, f)).toBe(true);
    expect(matchesFilters({ status: "completed", source: "online", methods: ["card"] }, f)).toBe(false);
    expect(matchesFilters({ status: "booked", source: "api", methods: null }, parseAppointmentFilters({ payment: "unpaid", platform: "app" }))).toBe(true);
  });
});

describe("per-staff permission matrix", () => {
  it("covers Squire's areas, and every cell is a real permission", () => {
    expect(MATRIX_AREAS.map((a) => a.label)).toEqual([
      "Appointments",
      "Contact info",
      "Clients",
      "Services",
      "Schedules",
      "Bank accounts",
      "Profile",
      "Reports",
      "Products",
      "Inventory",
      "Campaigns",
      "Register",
      "Open cash drawer",
      "Custom charge",
    ]);
    expect(MATRIX_ACTIONS.map((a) => a.label)).toEqual(["View", "Add/Edit", "Book", "Modify", "History", "Cancel", "Block time"]);
    for (const p of MATRIX_PERMISSIONS) expect(isPermission(p), p).toBe(true);
  });

  it("a cell is on, off or partly on, and allow/deny/default sets each permission behind it", () => {
    const cell: Permission[] = ["pos.discount", "pos.price_override"];
    expect(cellState(new Set<Permission>(["pos.discount"]), cell)).toBe("partial");
    expect(cellState(new Set<Permission>(cell), cell)).toBe("on");
    expect(cellState(new Set<Permission>(), "always")).toBe("always");
    const allowed = setCell({ "sales.view": true }, cell, true);
    expect(allowed).toEqual({ "sales.view": true, "pos.discount": true, "pos.price_override": true });
    expect(cellOverride(allowed, cell)).toBe(true);
    expect(cellOverride({ "pos.discount": false }, cell)).toBe("mixed");
    expect(setCell(allowed, cell, null)).toEqual({ "sales.view": true });
    expect([null, true, false, "mixed"].map((o) => nextOverride(o as boolean | null | "mixed"))).toEqual([true, false, null, true]);
  });

  it("the drawer's no-sale opening and custom charges go to the roles that run the register", () => {
    const perms = (k: string) => new Set(ROLE_TEMPLATES.find((t) => t.key === k)!.permissions);
    expect(perms("shop_manager").has("drawer.no_sale")).toBe(true);
    expect(perms("shop_manager").has("pos.custom_charge")).toBe(true);
    expect(perms("front_desk").has("drawer.no_sale")).toBe(true);
    expect(perms("front_desk").has("pos.custom_charge")).toBe(false);
    expect(perms("barber").has("drawer.no_sale")).toBe(false);
  });
});

describe("analytics period over period", () => {
  it("offers 1W, 4W, MTD, QTD and YTD as the report presets they are", () => {
    expect(ANALYTICS_PERIODS.map((p) => p.label)).toEqual(["1W", "4W", "MTD", "QTD", "YTD"]);
    const today = "2026-10-25";
    expect(ANALYTICS_PERIODS.map((p) => presetRange(p.id, today))).toEqual([
      { from: "2026-10-19", to: "2026-10-25" },
      { from: "2026-09-28", to: "2026-10-25" },
      { from: "2026-10-01", to: "2026-10-25" },
      { from: "2026-10-01", to: "2026-10-25" },
      { from: "2026-01-01", to: "2026-10-25" },
    ]);
  });

  it("compares like with like", () => {
    expect(comparePeriod("2026-10-19", "2026-10-25", "7d", "prior")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(comparePeriod("2026-09-28", "2026-10-25", "4w", "prior")).toEqual({ from: "2026-08-31", to: "2026-09-27" });
    // Month to date against the same days of last month, capped at its end.
    expect(comparePeriod("2026-10-01", "2026-10-25", "month", "prior")).toEqual({ from: "2026-09-01", to: "2026-09-25" });
    expect(comparePeriod("2026-03-01", "2026-03-31", "month", "prior")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // Quarter to date: as many days into last quarter.
    expect(comparePeriod("2026-10-01", "2026-10-25", "quarter", "prior")).toEqual({ from: "2026-07-01", to: "2026-07-25" });
    // Year to date and "last year": the same dates a year back.
    expect(comparePeriod("2026-01-01", "2026-10-25", "ytd", "prior")).toEqual({ from: "2025-01-01", to: "2025-10-25" });
    expect(comparePeriod("2026-10-19", "2026-10-25", "7d", "year")).toEqual({ from: "2025-10-19", to: "2025-10-25" });
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });

  it("change and percent change, with nothing before as no percent", () => {
    expect(periodChange(150, 100)).toEqual({ diff: 50, pct: 0.5 });
    expect(periodChange(50, 0)).toEqual({ diff: 50, pct: null });
    expect(periodChange(null, 10)).toEqual({ diff: null, pct: null });
  });
});

describe("brand products and taxes vs card fees", () => {
  it("a high line can't sit below par; none means no limit", () => {
    expect(highProblem(6, null)).toBeNull();
    expect(highProblem(6, 6)).toBeNull();
    expect(highProblem(6, 5)).toMatch(/below par/);
  });

  it("groups locations by jurisdiction and flags split rates within one", () => {
    const row = (shop: string, jurisdiction: string, service: number, product = 0.07) => ({ shopId: shop, shop, jurisdiction, serviceTaxRate: service, productTaxRate: product, verified: true });
    const g = jurisdictionGroups([row("Moline", "IL · Rock Island County · Moline", 0), row("Silvis", "IA · Scott County", 0.07), row("Utica", "IL · Rock Island County · Moline", 0.01)]);
    expect(g.map((x) => [x.jurisdiction, x.shops.map((s) => s.shop), x.mismatch])).toEqual([
      ["IA · Scott County", ["Silvis"], false],
      ["IL · Rock Island County · Moline", ["Moline", "Utica"], true],
    ]);
    expect(ratePct(0.0825)).toBe("8.25%");
    expect(ratePct(0.07)).toBe("7%");
    expect(ratePct(0)).toBe("0%");
  });
});

describe("brand defaults with location overrides", () => {
  it("fills missing brand values with the built-ins and drops invalid stored ones", () => {
    const b = brandDefaults({ cancelCutoffMinutes: 120, ga4MeasurementId: "g-abc1234", metaPixelId: "not-digits", junk: 1 });
    expect(b.cancelCutoffMinutes).toBe(120);
    expect(b.ga4MeasurementId).toBe("G-ABC1234");
    expect(b.metaPixelId).toBeNull();
    expect(b.minLeadMinutes).toBe(15);
    expect(b.reminderFirstHours).toBe(24);
    expect("junk" in b).toBe(false);
  });

  it("a location's own value wins and is labelled this shop only; the rest follow the brand", () => {
    const b = brandDefaults({ cancelCutoffMinutes: 60 });
    const e = effectiveDefaults(b, cleanPartial({ cancelCutoffMinutes: 15, reminderSecondHours: 7 }));
    expect(e.cancelCutoffMinutes).toEqual({ value: 15, scope: "shop" });
    expect(e.reminderSecondHours).toEqual({ value: 2, scope: "all" });
    expect(e.minLeadMinutes).toEqual({ value: 15, scope: "all" });
  });

  it("validates each field", () => {
    expect(parseDefault("bookingWindowDays", 0)).toEqual({ ok: false, error: "At least a day" });
    expect(parseDefault("reminderFirstHours", 5).ok).toBe(false);
    expect(parseDefault("accentColor", "#ABCDEF")).toEqual({ ok: true, value: "#abcdef" });
    expect(parseDefault("accentColor", "")).toEqual({ ok: true, value: null });
    expect(parseDefault("metaPixelId", "1234567890")).toEqual({ ok: true, value: "1234567890" });
    expect(parseDefault("cancellationPolicy", "x".repeat(501)).ok).toBe(false);
  });

  it("maps column-backed fields to shop columns both ways", () => {
    expect(columnPatch({ cancelCutoffMinutes: 45, bookingHeadline: "Hi", accentColor: null })).toEqual({ cancelCutoffMinutes: 45, accentColor: null });
    expect(overridesFromColumns({ minLeadMinutes: 30, name: "Moline", accentColor: "#112233" })).toEqual({ minLeadMinutes: 30, accentColor: "#112233" });
  });

  it("a barber's reminder times beat the location's, which beat the built-ins", () => {
    expect(reminderHours({ events: {}, firstHours: 12 }, { firstHours: 18, secondHours: 0 })).toEqual({ firstHours: 12, secondHours: 0 });
    expect(reminderHours(null)).toEqual({ firstHours: 24, secondHours: 2 });
  });
});

describe("booking-site conversion tracking", () => {
  it("sends GA4 and Meta events with the shop and step only", () => {
    const calls: unknown[][] = [];
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = { gtag: (...a: unknown[]) => calls.push(["ga4", ...a]), fbq: (...a: unknown[]) => calls.push(["meta", ...a]) };
    try {
      trackBookingStep("booked", { shop: "moline", channel: "online", appointment: "ABC123" });
      trackBookingStep("barber_picked", { shop: "moline", channel: "online" });
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
    expect(calls).toEqual([
      ["ga4", "event", "book_appointment", { shop: "moline", channel: "online", transaction_id: "ABC123" }],
      ["meta", "track", "Schedule", { content_category: "appointment", shop: "moline" }],
    ]);
    expect(Object.keys(CONVERSION_EVENTS)).toContain("details");
  });
});

describe("bulk edit", () => {
  it("applies a price change as a new amount, a step or a percent, never below zero", () => {
    expect(applyPriceChange(3000, { mode: "set", value: 3500, round: "cent" })).toBe(3500);
    expect(applyPriceChange(3000, { mode: "add", value: -500, round: "cent" })).toBe(2500);
    expect(applyPriceChange(3000, { mode: "add", value: -5000, round: "cent" })).toBe(0);
    expect(applyPriceChange(2499, { mode: "pct", value: 10, round: "cent" })).toBe(2749);
    expect(applyPriceChange(2499, { mode: "pct", value: 10, round: "dollar" })).toBe(2700);
    expect(describePriceChange({ mode: "pct", value: 5, round: "dollar" })).toBe("+5% (to the dollar)");
    expect(describePriceChange({ mode: "add", value: -250, round: "cent" })).toBe("−$2.50");
  });

  it("a template's shifts end after they start and don't overlap on a day", () => {
    expect(templateProblem([{ weekday: 1, startMin: 540, endMin: 1020 }])).toBeNull();
    expect(templateProblem([{ weekday: 1, startMin: 600, endMin: 540 }])).toMatch(/^Mon:/);
    expect(templateProblem([{ weekday: 2, startMin: 540, endMin: 780 }, { weekday: 2, startMin: 720, endMin: 1020 }])).toBe("Tue: two shifts overlap");
    expect(weeklyHours([{ weekday: 1, startMin: 540, endMin: 1020 }, { weekday: 2, startMin: 540, endMin: 780 }])).toBe(12);
    expect(bulkSummary([{ id: "a", label: "A", ok: true }, { id: "b", label: "B", ok: false, error: "x" }])).toBe("Updated 1 of 2");
  });
});

describe("payout reconciliation", () => {
  it("only deposits that left Stripe can be matched, and unmatched counts those not yet ticked off", () => {
    expect(["paid", "in_transit", "pending", "failed", "canceled"].map(isReconcilable)).toEqual([true, true, false, false, false]);
    const payouts = [
      { id: "a", status: "paid", amountCents: 1000 },
      { id: "b", status: "in_transit", amountCents: 500 },
      { id: "c", status: "failed", amountCents: 700 },
      { id: "d", status: "paid", amountCents: 300 },
    ];
    const u = unmatched(payouts, new Map([["d", {}]]));
    expect(u.rows.map((p) => p.id)).toEqual(["a", "b"]);
    expect([u.count, u.cents]).toEqual([2, 1500]);
  });

  it("what's not yet paid out never goes negative, and blank references are dropped", () => {
    expect(notYetPaidOut(10_000, 6_000, 1_500)).toBe(2_500);
    expect(notYetPaidOut(10_000, 9_000, 3_000)).toBe(0);
    const v = ReconcileInput.parse({ payoutId: "6f1e0c3e-3b9e-4c55-9a51-0d6b2d1c9f10", bankReference: "  ", note: " ok " });
    expect([v.bankReference, v.note]).toEqual([null, "ok"]);
    expect(() => ReconcileInput.parse({ payoutId: "6f1e0c3e-3b9e-4c55-9a51-0d6b2d1c9f10", bankReference: "x".repeat(61) })).toThrow(/60 characters/);
  });
});

describe("gift card management", () => {
  const now = new Date("2026-10-25T15:00:00Z");
  const card = { id: "g1", code: "AAAA-BBBB-CCCC-DDDD", status: "active", balanceCents: 2000, expiresAt: null };

  it("a reload needs a live, unexpired card, one per line, not paid with itself, and stays under $1,000", () => {
    expect(reloadProblem(card, { qty: 1, now, payingWith: null, amountCents: 5000 })).toBeNull();
    expect(reloadProblem(undefined, { qty: 1, now, payingWith: null })).toMatch(/wasn't found/);
    expect(reloadProblem({ ...card, status: "void" }, { qty: 1, now, payingWith: null })).toMatch(/voided/);
    expect(reloadProblem({ ...card, expiresAt: new Date("2026-01-01") }, { qty: 1, now, payingWith: null })).toMatch(/expired/);
    expect(reloadProblem(card, { qty: 2, now, payingWith: null })).toMatch(/one card per line/);
    expect(reloadProblem(card, { qty: 1, now, payingWith: "g1" })).toMatch(/its own reload/);
    expect(reloadProblem(card, { qty: 1, now, payingWith: null, amountCents: 98_001 })).toMatch(/\$1,000/);
  });

  it("comp cards need a reason and a sensible amount; ledger kinds read plainly", () => {
    const shopId = "6f1e0c3e-3b9e-4c55-9a51-0d6b2d1c9f10";
    expect(() => IssueCompInput.parse({ shopId, amountCents: 1000, reason: " " })).toThrow(/Add a reason/);
    expect(() => IssueCompInput.parse({ shopId, amountCents: 50, reason: "x" })).toThrow(/at least \$1/);
    expect(IssueCompInput.parse({ shopId, amountCents: 1000, reason: " Recovery " }).reason).toBe("Recovery");
    expect([ledgerLabel("reload"), ledgerLabel("reload_refund"), ledgerLabel("something_new")]).toEqual(["Reloaded", "Reload refunded", "something new"]);
  });
});

describe("memberships", () => {
  const cut = "00000000-0000-4000-8000-000000000001";
  const beard = "00000000-0000-4000-8000-000000000002";
  const coverage = { membershipId: "m1", customerId: "dad", memberName: "Dad", planName: "Buzz Club", serviceIds: [cut], visitsLeft: null as number | null, productDiscountPct: 0, periodStart: "2026-10-01" };
  const line = (key: string, refId: string, unitPriceCents: number, forCustomerId: string | null, qty = 1) => ({ key, kind: "service" as const, name: key, refId, unitPriceCents, qty, forCustomerId });

  it("covers only the member's own plan services, most expensive first, up to the visits left", () => {
    const lines = [line("a", cut, 2500, "dad"), line("b", cut, 3000, "dad"), line("c", cut, 2500, "kid"), line("d", beard, 1500, "dad")];
    const all = membershipDiscounts(coverage, lines);
    expect(all.visits).toBe(2);
    expect(all.discounts).toEqual([expect.objectContaining({ source: "membership", type: "amount", value: 5500, lineKeys: ["b", "a"], refId: "m1" })]);
    const one = membershipDiscounts({ ...coverage, visitsLeft: 1 }, lines);
    expect([one.visits, one.discounts[0].value, one.discounts[0].lineKeys]).toEqual([1, 3000, ["b"]]);
    expect(membershipDiscounts({ ...coverage, visitsLeft: 0 }, lines)).toEqual({ discounts: [], visits: 0 });
  });

  it("takes the plan's percent off retail, and checkout keeps the covered amount on the member's lines", () => {
    const lines = [line("a", cut, 2500, "dad"), line("c", cut, 2500, "kid"), { key: "p", kind: "product" as const, name: "Pomade", refId: beard, unitPriceCents: 2000, qty: 1, forCustomerId: "dad" }];
    const r = membershipDiscounts({ ...coverage, productDiscountPct: 10 }, lines);
    expect(r.discounts.map((d) => [d.type, d.value, d.appliesTo])).toEqual([
      ["amount", 2500, "services"],
      ["percent", 10, "products"],
    ]);
    const t = computeCheckout({ lines, discounts: r.discounts, taxRates: { serviceRate: 0, productRate: 0 }, cardFee: { enabled: false, rate: 0, appliesToTip: false }, tender: { method: "cash" } });
    expect(t.discountCents).toBe(2500 + 200);
    expect(t.lines.map((l) => [l.key, l.discountCents])).toEqual([
      ["a", 2500],
      ["c", 0],
      ["p", 200],
    ]);
  });

  it("validates plans and counts months and recurring revenue", () => {
    expect(planProblem(PlanInput.parse({ name: "Retail", priceCents: 1000, productDiscountPct: 10 }))).toBeNull();
    expect(planProblem(PlanInput.parse({ name: "Empty", priceCents: 1000 }))).toMatch(/needs services/);
    expect(() => PlanInput.parse({ name: "Cheap", priceCents: 50, serviceIds: [cut] })).toThrow(/at least \$1/);
    expect([periodEnd("2026-10-25"), periodEnd("2027-01-31"), periodEnd("2028-01-31")]).toEqual(["2026-11-25", "2027-02-28", "2028-02-29"]);
    expect([visitsLeft(null, 9), visitsLeft(2, 1), visitsLeft(2, 5)]).toEqual([null, 1, 0]);
    expect(planSummary({ priceCents: 3900, visitsPerPeriod: null, productDiscountPct: 10 }, ["Buzz cut"])).toBe("Unlimited Buzz cut · 10% off retail");
    expect(
      monthlyRecurring([
        { status: "active", priceCents: 3900, cancelAtPeriodEnd: false },
        { status: "past_due", priceCents: 3900, cancelAtPeriodEnd: false },
        { status: "active", priceCents: 3900, cancelAtPeriodEnd: true },
        { status: "incomplete", priceCents: 3900, cancelAtPeriodEnd: false },
        { status: "canceled", priceCents: 3900, cancelAtPeriodEnd: false },
      ]),
    ).toBe(7800);
  });
});

describe("phone agent", () => {
  it("hears what callers say as a menu choice", () => {
    expect(["I'd like to book a haircut", "Can I get an appointment", "one", "what are your hours", "when do you close", "can I talk to someone", "Operator!", "uh what is this", "someone told me to call", ""].map(choiceFromSpeech)).toEqual([
      "1",
      "1",
      "1",
      "2",
      "2",
      "3",
      "3",
      null,
      "3",
      null,
    ]);
  });

  it("names each call's outcome and which ones want a ring back", () => {
    const base = { operator: true, status: "after_hours", choice: null, autoTextSent: false, bookedCents: null, endedAt: new Date() };
    expect(callOutcome({ ...base, choice: "book", autoTextSent: true, bookedCents: 3300 })).toBe("booked");
    expect(callOutcome({ ...base, choice: "book", autoTextSent: true })).toBe("link_texted");
    expect(callOutcome({ ...base, choice: "none", autoTextSent: true })).toBe("link_texted");
    expect(callOutcome({ ...base, choice: "hours" })).toBe("hours");
    expect(callOutcome({ ...base, choice: "shop", status: "answered", autoTextSent: true })).toBe("put_through");
    expect(callOutcome({ ...base, choice: "none" })).toBe("hung_up");
    expect(callOutcome({ ...base, status: "ringing", endedAt: null })).toBe("in_progress");
    expect(callOutcome({ ...base, operator: false, status: "answered" })).toBe("staff_answered");
    expect(callOutcome({ ...base, operator: false, status: "missed" })).toBe("missed");
    expect(callOutcome({ ...base, operator: false, status: "after_hours", autoTextSent: true })).toBe("after_hours");
    expect([needsFollowUp("missed", "missed"), needsFollowUp("hung_up", "after_hours"), needsFollowUp("put_through", "missed"), needsFollowUp("put_through", "answered"), needsFollowUp("booked", "after_hours")]).toEqual([true, true, true, false, false]);
    expect([formatCallLength(null), formatCallLength(42), formatCallLength(95)]).toEqual(["—", "42s", "1m 35s"]);
  });

  it("listens for speech only when the shop turns it on, and keeps transcripts by default", () => {
    expect(cleanOperator({})).toMatchObject({ speech: false, transcripts: true });
    expect(cleanOperator({ speech: true, transcripts: false })).toMatchObject({ speech: true, transcripts: false });
    expect(gather({ action: "/x" })).not.toContain("speech");
    expect(gather({ action: "/x", speech: { hints: "book, hours" } })).toContain('input="dtmf speech" speechTimeout="auto" hints="book, hours"');
    const s = operatorScript({ shop: "Rays Kimberly", greeting: null, open: true, missed: false, canRing: true, speech: true });
    expect(s.menu).toContain("Press 1 or say book");
    expect(s.menu).toContain("Press 3 or say someone");
  });
});
