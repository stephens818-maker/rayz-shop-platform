import { describe, expect, it } from "vitest";
import { CardFeeConfig, CartLine, computeCheckout } from "@/domain/checkout";
import { CouponInput, CouponLimits, CouponRule, couponDiscount, couponProblem, couponSummary, issuedExpiry, stackProblem, uniqueCode } from "@/domain/coupons";
import { addDays } from "@/lib/time";

const fee: CardFeeConfig = { enabled: false, rate: 0, appliesToTip: false };
const tax = { serviceRate: 0, productRate: 0 };
const CUT = "11111111-1111-4111-8111-111111111111";
const BEARD = "22222222-2222-4222-8222-222222222222";
const POMADE = "33333333-3333-4333-8333-333333333333";
const cut: CartLine = { key: "1", kind: "service", name: "Cut", unitPriceCents: 3300, qty: 1, refId: CUT };
const beard: CartLine = { key: "2", kind: "addon", name: "Beard", unitPriceCents: 500, qty: 1, refId: BEARD };
const pomade: CartLine = { key: "3", kind: "product", name: "Pomade", unitPriceCents: 2000, qty: 1, refId: POMADE };
const gift: CartLine = { key: "4", kind: "gift_card", name: "Gift card", unitPriceCents: 5000, qty: 1 };

const rule = (o: Partial<CouponRule>): CouponRule => ({
  promoId: "p1",
  code: "SAVE",
  label: "Coupon SAVE",
  type: "amount",
  value: 500,
  appliesTo: "services",
  serviceIds: [],
  productIds: [],
  freeItem: null,
  minSpendCents: null,
  stackable: true,
  via: "code",
  ...o,
});
const total = (lines: CartLine[], r: CouponRule) => computeCheckout({ lines, taxRates: tax, cardFee: fee, tender: { method: "cash" }, discounts: [couponDiscount(r, lines).discount!] });

describe("coupon discounts", () => {
  it("percent off only the targeted service; loyalty earns on the net services", () => {
    const t = total([cut, beard, pomade], rule({ type: "percent", value: 20, serviceIds: [CUT] }));
    expect(t.discountCents).toBe(660);
    expect(t.serviceNetCents).toBe(3300 + 500 - 660);
    expect(t.productNetCents).toBe(2000);
    expect(t.loyaltyEligibleCents).toBe(t.serviceNetCents);
  });

  it("dollars off a product", () => {
    const t = total([cut, pomade], rule({ value: 700, appliesTo: "products", productIds: [POMADE] }));
    expect(t.productNetCents).toBe(1300);
    expect(t.serviceNetCents).toBe(3300);
  });

  it("a free add-on takes off one of it, and needs it on the ticket", () => {
    const r = rule({ type: "free_item", value: 0, appliesTo: "all", freeItem: { kind: "addon", id: BEARD, name: "Beard" } });
    expect(couponDiscount(r, [cut]).problem).toBe("Add Beard to the ticket to use SAVE");
    const t = total([cut, { ...beard, qty: 2 }], r);
    expect(t.discountCents).toBe(500);
  });

  it("minimum spend is the ticket before discounts, without gift cards", () => {
    const r = rule({ minSpendCents: 4000 });
    expect(couponDiscount(r, [cut, gift]).problem).toMatch(/at least \$40\.00/);
    expect(couponDiscount(r, [cut, beard, pomade]).discount).not.toBeNull();
  });

  it("targets not on the ticket give nothing", () => {
    expect(couponDiscount(rule({ serviceIds: [BEARD] }), [cut]).problem).toMatch(/aren't on the ticket/);
  });

  it("stacking: the same coupon twice, a non-stackable coupon with another, or with a manual discount", () => {
    const a = rule({ promoId: "a", code: "A" });
    const b = rule({ promoId: "b", code: "B" });
    const solo = rule({ promoId: "s", code: "SOLO", stackable: false });
    expect(stackProblem([a, b])).toBeNull();
    expect(stackProblem([a, { ...a, code: "A2" }])).toMatch(/already on the ticket/);
    expect(stackProblem([a, solo])).toBe("SOLO can't be combined with other coupons");
    expect(stackProblem([solo], { manualDiscount: true })).toMatch(/manual discount/);
    expect(stackProblem([solo])).toBeNull();
  });
});

describe("coupon eligibility", () => {
  const limits = (o: Partial<CouponLimits> = {}): CouponLimits => ({ active: true, code: "SAVE", shopId: null, shopIds: [], startsOn: null, endsOn: null, maxRedemptions: null, redemptions: 0, maxPerCustomer: null, firstVisitOnly: false, codeMode: "shared", ...o });
  const check = { today: "2028-02-16", shopId: "cv", customerId: "c1", priorVisits: 0, customerUses: 0 };

  it("locations, dates, total uses", () => {
    expect(couponProblem(limits({ shopIds: ["other"] }), check)).toMatch(/location/);
    expect(couponProblem(limits({ startsOn: "2028-03-01" }), check)).toMatch(/isn't active yet/);
    expect(couponProblem(limits({ endsOn: "2028-02-15" }), check)).toMatch(/expired/);
    expect(couponProblem(limits({ maxRedemptions: 5, redemptions: 5 }), check)).toMatch(/fully redeemed/);
    expect(couponProblem(limits({ active: false }), check)).toMatch(/turned off/);
    expect(couponProblem(limits({ shopIds: ["cv"], startsOn: "2028-02-16", endsOn: "2028-02-16" }), check)).toBeNull();
  });

  it("per client and first visit; unknown clients (online booking) are checked again at checkout", () => {
    expect(couponProblem(limits({ maxPerCustomer: 1 }), { ...check, customerUses: 1 })).toMatch(/already used/);
    expect(couponProblem(limits({ maxPerCustomer: 3 }), { ...check, customerUses: 3 })).toMatch(/3 times/);
    expect(couponProblem(limits({ firstVisitOnly: true }), { ...check, priorVisits: 1 })).toMatch(/first visit/);
    expect(couponProblem(limits({ firstVisitOnly: true }), { ...check, customerId: null })).toMatch(/Attach a client/);
    expect(couponProblem(limits({ firstVisitOnly: true, maxPerCustomer: 1 }), { ...check, customerId: undefined, priorVisits: 9, customerUses: 9 })).toBeNull();
  });

  it("single-use codes: only with the code, once, for their client, until they expire", () => {
    const u = limits({ codeMode: "unique" });
    expect(couponProblem(u, check)).toMatch(/client's own code/);
    expect(couponProblem(u, { ...check, issued: { customerId: "c1", expiresOn: null, redeemed: true } })).toMatch(/already been used/);
    expect(couponProblem(u, { ...check, issued: { customerId: "c1", expiresOn: "2028-02-15", redeemed: false } })).toMatch(/expired/);
    expect(couponProblem(u, { ...check, issued: { customerId: "c2", expiresOn: null, redeemed: false } })).toMatch(/another client/);
    expect(couponProblem(u, { ...check, customerId: null, issued: { customerId: "c2", expiresOn: null, redeemed: false } })).toMatch(/Attach the client/);
    expect(couponProblem(u, { ...check, issued: { customerId: "c1", expiresOn: "2028-02-16", redeemed: false } })).toBeNull();
  });
});

describe("coupon setup", () => {
  const base = { code: "spring-10", type: "percent" as const, value: 10 };
  it("normalizes the code and checks the rules", () => {
    expect(CouponInput.parse(base).code).toBe("SPRING-10");
    expect(CouponInput.safeParse({ ...base, value: 0 }).success).toBe(false);
    expect(CouponInput.safeParse({ ...base, code: "no spaces" }).success).toBe(false);
    expect(CouponInput.safeParse({ ...base, type: "free_item", value: 0 }).error?.issues[0].message).toMatch(/free add-on/);
    expect(CouponInput.safeParse({ ...base, startsOn: "2028-03-01", endsOn: "2028-02-01" }).error?.issues[0].message).toMatch(/before the start/);
    expect(CouponInput.safeParse({ ...base, autoApply: true }).error?.issues[0].message).toMatch(/limit per client/);
    expect(CouponInput.safeParse({ ...base, autoApply: true, firstVisitOnly: true }).success).toBe(true);
    expect(CouponInput.safeParse({ ...base, autoApply: true, maxPerCustomer: 1, codeMode: "unique" }).error?.issues[0].message).toMatch(/Single-use/);
  });

  it("single-use codes and their expiry", () => {
    expect(uniqueCode("WEMISSYOUSOMUCH", () => "K7Q2PX")).toBe("WEMISSYOUSOM-K7Q2PX");
    expect(issuedExpiry("2028-02-16", 10, null, addDays)).toBe("2028-02-26");
    expect(issuedExpiry("2028-02-16", 10, "2028-02-20", addDays)).toBe("2028-02-20");
    expect(issuedExpiry("2028-02-16", null, "2028-03-01", addDays)).toBe("2028-03-01");
    expect(issuedExpiry("2028-02-16", null, null, addDays)).toBeNull();
  });

  it("summaries", () => {
    expect(couponSummary({ type: "percent", value: 20, appliesTo: "services", freeItem: null, minSpendCents: null })).toBe("20% off services");
    expect(couponSummary({ type: "amount", value: 1000, appliesTo: "all", freeItem: null, minSpendCents: 4000 })).toBe("$10.00 off on $40.00 or more");
    expect(couponSummary({ type: "free_item", value: 0, appliesTo: "all", freeItem: { kind: "addon", id: BEARD, name: "Beard Trim" }, minSpendCents: null })).toBe("Free Beard Trim");
  });
});
