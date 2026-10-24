import { describe, expect, it } from "vitest";
import {
  applicationFee,
  entityProblem,
  entityTaxSettings,
  feeTermsProblem,
  franchiseData,
  isFranchiseePerson,
  legBase,
  parsePercentBps,
  periodOf,
  regionFitProblem,
  royaltyDue,
  royaltyStatement,
  slugify,
  termsOn,
  type FeeTerms,
} from "@/domain/franchise";
import { brandStandards, localPriceProblem, localServiceProblem, priceLimits, priceStandardProblem, shopPolicyProblems, standardsProblem } from "@/domain/brand-standards";
import { BRAND_ONLY, ROLE_TEMPLATES, SCOPE_LEVEL, isBrandLevelPerson, scopeProblem, scopeWithin, templateFor, type Permission } from "@/domain/permissions";

const terms = (effectiveFrom: string, royaltyBps: number, adFundBps: number): FeeTerms => ({ effectiveFrom, royaltyBps, adFundBps, collect: "application_fee" });

describe("owner groups and regions", () => {
  it("checks an owner group's name, kind, email and payroll code", () => {
    expect(entityProblem({ name: "Rayz QC LLC", kind: "franchisee" })).toBeNull();
    expect(entityProblem({ name: "R", kind: "franchisee" })).toMatch(/name/);
    expect(entityProblem({ name: "Rayz QC", kind: "partner" })).toMatch(/corporate or franchisee/);
    expect(entityProblem({ name: "Rayz QC", kind: "brand", contactEmail: "nope" })).toMatch(/email/);
    expect(entityProblem({ name: "Rayz QC", kind: "brand", payrollCompanyCode: "has space" })).toMatch(/payroll/);
    expect(entityProblem({ name: "Rayz QC", kind: "brand", payrollCompanyCode: "RAYZ-01" })).toBeNull();
  });

  it("reads tax settings defensively and never holds a tax ID", () => {
    expect(entityTaxSettings(null)).toEqual({ filer: "entity", frequency: {} });
    expect(entityTaxSettings({ filer: "brand", frequency: { IL: "monthly" } })).toEqual({ filer: "brand", frequency: { IL: "monthly" } });
    expect(entityTaxSettings({ filer: "brand", frequency: { Illinois: "monthly" } })).toEqual({ filer: "entity", frequency: {} });
    expect(entityTaxSettings({ ein: "12-3456789" })).not.toHaveProperty("ein");
  });

  it("keeps shops out of another owner group's region; brand markets take anyone", () => {
    expect(regionFitProblem(null, "e1")).toBeNull();
    expect(regionFitProblem({ ownerEntityId: null }, "e1")).toBeNull();
    expect(regionFitProblem({ ownerEntityId: "e1" }, "e1")).toBeNull();
    expect(regionFitProblem({ ownerEntityId: "e1" }, "e2")).toMatch(/another owner group/);
  });

  it("makes region slugs", () => {
    expect(slugify("Quad Cities — East")).toBe("quad-cities-east");
    expect(slugify("!!!")).toBe("region");
  });
});

describe("royalty and ad fund terms", () => {
  it("parses percents to basis points within the cap", () => {
    expect(parsePercentBps("6.5")).toBe(650);
    expect(parsePercentBps("2%")).toBe(200);
    expect(parsePercentBps(0)).toBe(0);
    expect(parsePercentBps("30")).toBe(3000);
    expect(parsePercentBps("30.01")).toBeNull();
    expect(parsePercentBps("-1")).toBeNull();
    expect(parsePercentBps("six")).toBeNull();
    expect(parsePercentBps("")).toBeNull();
  });

  it("checks terms", () => {
    expect(feeTermsProblem(terms("2026-01-01", 600, 200))).toBeNull();
    expect(feeTermsProblem(terms("Jan 1", 600, 200))).toMatch(/date/);
    expect(feeTermsProblem(terms("2026-01-01", 3001, 0))).toMatch(/royalty rate/);
    expect(feeTermsProblem(terms("2026-01-01", 0, 1.5))).toMatch(/ad fund rate/);
    expect(feeTermsProblem({ ...terms("2026-01-01", 0, 0), collect: "wire" as never })).toMatch(/collected/);
  });

  it("picks the terms in force on a day", () => {
    const list = [terms("2026-03-01", 700, 200), terms("2026-01-01", 600, 200)];
    expect(termsOn(list, "2025-12-31")).toBeNull();
    expect(termsOn(list, "2026-01-01")?.royaltyBps).toBe(600);
    expect(termsOn(list, "2026-02-28")?.royaltyBps).toBe(600);
    expect(termsOn(list, "2026-03-01")?.royaltyBps).toBe(700);
  });

  it("rounds what a base owes", () => {
    expect(royaltyDue(10_000, { royaltyBps: 650, adFundBps: 200 })).toEqual({ royaltyCents: 650, adFundCents: 200 });
    expect(royaltyDue(3_333, { royaltyBps: 650, adFundBps: 150 })).toEqual({ royaltyCents: 217, adFundCents: 50 });
    expect(royaltyDue(10_000, null)).toEqual({ royaltyCents: 0, adFundCents: 0 });
  });

  it("splits a sale's base over split-payment legs so they add up exactly", () => {
    const sale = { baseCents: 5_001, saleTotalCents: 6_000 };
    const first = legBase({ ...sale, legCents: 2_000, paidBeforeCents: 0, allocatedCents: 0 });
    const second = legBase({ ...sale, legCents: 2_000, paidBeforeCents: 2_000, allocatedCents: first });
    const last = legBase({ ...sale, legCents: 2_000, paidBeforeCents: 4_000, allocatedCents: first + second });
    expect(first).toBe(1_667);
    expect(first + second + last).toBe(5_001);
    expect(legBase({ ...sale, legCents: 6_000, paidBeforeCents: 0, allocatedCents: 0 })).toBe(5_001);
    expect(legBase({ baseCents: 0, saleTotalCents: 6_000, legCents: 6_000, paidBeforeCents: 0, allocatedCents: 0 })).toBe(0);
  });

  it("takes processing, then royalty, then ad fund, never more than the charge", () => {
    expect(applicationFee({ chargeCents: 10_000, processingCents: 320, royaltyCents: 600, adFundCents: 200 })).toEqual({
      applicationFeeCents: 1_120,
      processingCents: 320,
      royaltyCents: 600,
      adFundCents: 200,
    });
    expect(applicationFee({ chargeCents: 800, processingCents: 320, royaltyCents: 600, adFundCents: 200 })).toEqual({
      applicationFeeCents: 800,
      processingCents: 320,
      royaltyCents: 480,
      adFundCents: 0,
    });
    expect(applicationFee({ chargeCents: 0, processingCents: 30, royaltyCents: 60, adFundCents: 20 }).applicationFeeCents).toBe(0);
  });
});

describe("royalty statement", () => {
  const day = (d: string, base: number, refund = 0, royalty = 0, ad = 0) => ({
    day: d,
    grossSalesCents: base + 1_000,
    baseCents: base,
    refundBaseCents: refund,
    collectedRoyaltyCents: royalty,
    collectedAdFundCents: ad,
  });

  it("applies each day's rate, nets refunds and shows what's still owed", () => {
    const s = royaltyStatement([day("2026-02-27", 10_000, 0, 600, 200), day("2026-03-02", 20_000, 2_000, 1_000, 0)], [terms("2026-01-01", 600, 200), terms("2026-03-01", 700, 200)]);
    expect(s.netBaseCents).toBe(28_000);
    expect(s.royaltyDueCents).toBe(600 + 1_260);
    expect(s.adFundDueCents).toBe(200 + 360);
    expect(s.royaltyBalanceCents).toBe(1_860 - 1_600);
    expect(s.adFundBalanceCents).toBe(560 - 200);
    expect(s.grossSalesCents).toBe(32_000);
    expect(s.rates.map((r) => r.effectiveFrom)).toEqual(["2026-01-01", "2026-03-01"]);
  });

  it("leaves a credit when a refund follows a collected fee", () => {
    const s = royaltyStatement([day("2026-03-02", 0, 10_000)], [terms("2026-01-01", 600, 200)]);
    expect(s.royaltyDueCents).toBe(-600);
    expect(s.royaltyBalanceCents).toBe(-600);
  });

  it("owes nothing before the first terms", () => {
    expect(royaltyStatement([day("2025-12-01", 10_000)], [terms("2026-01-01", 600, 200)]).royaltyDueCents).toBe(0);
  });

  it("names months and quarters", () => {
    expect(periodOf("2026-03-31", "month")).toBe("2026-03");
    expect(periodOf("2026-03-31", "quarter")).toBe("2026-Q1");
    expect(periodOf("2026-10-01", "quarter")).toBe("2026-Q4");
  });
});

describe("client data for franchise agreements", () => {
  it("defaults to the most protective settings for the brand", () => {
    expect(franchiseData(null)).toEqual({ clientOwnership: "brand", crossOwnerHistory: "full", franchiseeExport: "never", onExit: "brand_keeps", agreementRef: null });
  });

  it("keeps the readable settings and drops the rest one by one", () => {
    expect(franchiseData({ clientOwnership: "shared", franchiseeExport: "always", agreementRef: " FA 2026 §14.3 " })).toMatchObject({
      clientOwnership: "shared",
      franchiseeExport: "never",
      agreementRef: "FA 2026 §14.3",
    });
  });

  it("calls someone a franchisee's only when everything they reach is a franchisee's", () => {
    expect(isFranchiseePerson(["franchisee", "franchisee"])).toBe(true);
    expect(isFranchiseePerson(["franchisee", "brand"])).toBe(false);
    expect(isFranchiseePerson(["franchisee", null])).toBe(false);
    expect(isFranchiseePerson([])).toBe(false);
  });
});

describe("brand standards", () => {
  const cut = { name: "Haircut", brandPriceCents: 3_000, localPrice: "range" as const, priceFloorCents: 2_500, priceCeilingCents: 4_000 };

  it("checks the brand's own price standard", () => {
    expect(priceStandardProblem(cut)).toBeNull();
    expect(priceStandardProblem({ ...cut, priceFloorCents: 5_000 })).toMatch(/floor is above the ceiling/);
    expect(priceStandardProblem({ ...cut, brandPriceCents: 2_000 })).toMatch(/below the floor/);
    expect(priceStandardProblem({ ...cut, brandPriceCents: 4_500 })).toMatch(/above the ceiling/);
    expect(priceStandardProblem({ ...cut, priceFloorCents: null, priceCeilingCents: null })).toMatch(/floor, a ceiling or both/);
    expect(priceStandardProblem({ ...cut, localPrice: "open", priceFloorCents: null, priceCeilingCents: null })).toBeNull();
  });

  it("keeps a location's price inside the range, at the brand price when locked, and anywhere when open", () => {
    expect(localPriceProblem(cut, null)).toBeNull();
    expect(localPriceProblem(cut, 3_500)).toBeNull();
    expect(localPriceProblem(cut, 2_000)).toMatch(/below the brand's floor of \$25\.00/);
    expect(localPriceProblem(cut, 4_100)).toMatch(/above the brand's ceiling of \$40\.00/);
    expect(localPriceProblem({ ...cut, localPrice: "locked" }, 3_100)).toMatch(/priced by the brand/);
    expect(localPriceProblem({ ...cut, localPrice: "locked" }, 3_000)).toBeNull();
    expect(localPriceProblem({ ...cut, localPrice: "open" }, 99_00)).toBeNull();
    expect(priceLimits({ ...cut, localPrice: "locked" })).toEqual({ min: 3_000, max: 3_000, locked: true });
    expect(priceLimits(cut)).toEqual({ min: 2_500, max: 4_000, locked: false });
  });

  it("locks names and durations unless the brand allows them", () => {
    const s = { name: "Fade", localName: false, localDuration: true };
    expect(localServiceProblem(s, { nameOverride: null, durationMin: 45 })).toBeNull();
    expect(localServiceProblem(s, { nameOverride: "Skin fade", durationMin: null })).toMatch(/brand's name/);
    expect(localServiceProblem({ ...s, localDuration: false }, { nameOverride: null, durationMin: 45 })).toMatch(/brand's duration/);
  });

  it("reads stored standards defensively, with coupons local and other content the brand's", () => {
    const s = brandStandards({ shop: { bufferMinutes: { mode: "weird" } }, toggles: { receipt: "brand", tipPresets: "x" }, content: { badges: "local" } });
    expect(s.shop.bufferMinutes.mode).toBe("open");
    expect(s.toggles.receipt).toBe("brand");
    expect(s.toggles.tipPresets).toBe("local");
    expect(s.content).toEqual({ marketingTemplates: "brand", messageTemplates: "brand", badges: "local", coupons: "local" });
    expect(standardsProblem(brandStandards({ shop: { bufferMinutes: { mode: "range" } } }))).toMatch(/minimum, a maximum or both/);
    expect(standardsProblem(brandStandards({ shop: { cardFeeRate: { mode: "locked" } } }))).toMatch(/value every location uses/);
  });

  it("only checks the shop settings that changed", () => {
    const s = brandStandards({
      shop: { cancelCutoffMinutes: { mode: "range", min: 60, max: 1440 }, cardFeeRate: { mode: "locked", value: 0.03 } },
      toggles: { branding: "brand" },
    });
    const before = { cancelCutoffMinutes: 30, cardFeeRate: 0.04, accentColor: "#111111", logoUrl: null };
    expect(shopPolicyProblems(s, before, { ...before })).toEqual([]);
    expect(shopPolicyProblems(s, before, { ...before, cancelCutoffMinutes: 2000 })).toEqual(["Cancellation cutoff must be between 60 and 1440 minutes"]);
    expect(shopPolicyProblems(s, before, { ...before, cancelCutoffMinutes: 120 })).toEqual([]);
    expect(shopPolicyProblems(s, before, { ...before, cardFeeRate: 0.05 })).toEqual(["Credit card fee is set by the brand"]);
    expect(shopPolicyProblems(s, before, { ...before, cardFeeRate: 0.03 })).toEqual([]);
    expect(shopPolicyProblems(s, before, { ...before, logoUrl: "https://x/logo.png" })).toEqual(["Booking page color and logo: set by the brand"]);
  });
});

describe("scopes and franchise role templates", () => {
  it("needs the owner group or region an entity or region scope points at", () => {
    expect(scopeProblem("entity", [], {})).toMatch(/owner group/);
    expect(scopeProblem("entity", [], { entityId: "e1" })).toBeNull();
    expect(scopeProblem("region", [], {})).toMatch(/region/);
    expect(scopeProblem("region", [], { regionId: "r1" })).toBeNull();
    expect(SCOPE_LEVEL).toEqual({ all: "brand", entity: "entity", region: "region", selected: "location", one: "location" });
  });

  it("lets a caller grant only scopes inside their own", () => {
    const owner = { scope: "entity" as const, scopeEntityId: "e1" };
    const regional = { scope: "region" as const, scopeRegionId: "r1" };
    expect(scopeWithin({ scope: "all" }, { scope: "all" })).toBe(true);
    expect(scopeWithin(owner, { scope: "all" })).toBe(false);
    expect(scopeWithin(owner, { scope: "entity", scopeEntityId: "e1" })).toBe(true);
    expect(scopeWithin(owner, { scope: "entity", scopeEntityId: "e2" })).toBe(false);
    expect(scopeWithin(owner, { scope: "region", scopeRegionId: "r1", regionEntityId: "e1" })).toBe(true);
    expect(scopeWithin(owner, { scope: "region", scopeRegionId: "r9", regionEntityId: null })).toBe(false);
    expect(scopeWithin(regional, { scope: "region", scopeRegionId: "r1" })).toBe(true);
    expect(scopeWithin(regional, { scope: "region", scopeRegionId: "r2" })).toBe(false);
    expect(scopeWithin(regional, { scope: "entity", scopeEntityId: "e1" })).toBe(false);
  });

  it("adds Franchisee Owner, Franchisee Manager and Regional Manager templates at their levels", () => {
    const fo = templateFor("franchisee_owner")!;
    const fm = templateFor("franchisee_manager")!;
    const rm = templateFor("regional_manager")!;
    expect([fo.defaultScope, fm.defaultScope, rm.defaultScope]).toEqual(["entity", "entity", "region"]);
    expect(fo.permissions).toEqual(expect.arrayContaining(["entity.finances", "entity.banking", "entity.settings", "report.royalties.view", "report.entity_pnl.view"]));
    expect(fm.permissions).not.toContain("entity.finances");
    expect(fm.permissions).not.toContain("report.royalties.view");
    for (const t of [fo, fm, rm]) {
      expect(t.permissions.filter((p) => BRAND_ONLY.has(p as Permission))).toEqual([]);
      expect(t.permissions).not.toContain("clients.export");
      expect(isBrandLevelPerson({ kind: "person", scope: "all", role: t })).toBe(false);
    }
  });

  it("keeps franchise administration and brand standards to the brand", () => {
    for (const p of ["entities.manage", "standards.manage", "catalog.manage"] as Permission[]) expect(BRAND_ONLY.has(p)).toBe(true);
    expect(ROLE_TEMPLATES.filter((t) => t.permissions.includes("entities.manage")).map((t) => t.key)).toEqual(["brand_owner", "brand_admin"]);
  });
});
