import { describe, expect, it } from "vitest";
import { OWNER_KIND_LABEL, PAYMENTS_MODES, ownerEntityProblem, paymentsStep, takesCards } from "@/domain/connect";
import { Grantor, SHOP_SCOPES, UserAccessState, effectiveAccess, scopeProblem, scopeWithin, staffEditDenied, templateFor, userAccessChangeDenied } from "@/domain/permissions";

const E1 = "11111111-1111-1111-1111-111111111111";
const E2 = "22222222-2222-2222-2222-222222222222";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";
const S3 = "aaaaaaaa-0000-0000-0000-000000000003";

const ready = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [], disabledReason: null, deauthorizedAt: null };

describe("owner entity scope", () => {
  it("is a shop scope that needs an owner", () => {
    expect(SHOP_SCOPES).toEqual(["all", "entity", "selected", "one"]);
    expect(scopeProblem("entity", [], null)).toMatch(/Pick the owner/);
    expect(scopeProblem("entity", [], E1)).toBeNull();
  });

  it("is reachable whole only from the brand or the same owner", () => {
    expect(scopeWithin({ scope: "all" }, { scope: "entity", scopeEntityId: E1 })).toBe(true);
    expect(scopeWithin({ scope: "entity", scopeEntityId: E1 }, { scope: "entity", scopeEntityId: E1 })).toBe(true);
    expect(scopeWithin({ scope: "entity", scopeEntityId: E1 }, { scope: "entity", scopeEntityId: E2 })).toBe(false);
    expect(scopeWithin({ scope: "selected" }, { scope: "entity", scopeEntityId: E1 })).toBe(false);
    expect(scopeWithin({ scope: "entity", scopeEntityId: E1 }, { scope: "all" })).toBe(false);
    expect(scopeWithin({ scope: "entity", scopeEntityId: E1 }, { scope: "selected" })).toBe(true);
  });
});

describe("franchisee role templates", () => {
  it("default to an owner's shops and lose brand-only powers there", () => {
    for (const key of ["franchisee_owner", "franchisee_manager"]) {
      const t = templateFor(key)!;
      expect(t.defaultScope).toBe("entity");
      const a = effectiveAccess(t, {}, null, "entity");
      expect(a.isOwner).toBe(false);
      for (const p of ["locations.setup", "payments.accounts", "payments.banking", "network.settings"] as const) expect(a.permissions.has(p as never)).toBe(false);
      expect(a.permissions.has("po.approve")).toBe(true);
    }
    expect(effectiveAccess(templateFor("franchisee_owner")!, {}, null, "entity").permissions.has("permissions.manage")).toBe(true);
    expect(effectiveAccess(templateFor("franchisee_manager")!, {}, null, "entity").permissions.has("permissions.manage")).toBe(false);
  });

  const fo = effectiveAccess(templateFor("franchisee_owner")!, {}, null, "entity");
  const caller: Grantor = { staffId: "fo", isOwner: false, permissions: fo.permissions, maxDiscountPct: fo.maxDiscountPct, scope: "entity", scopeEntityId: E1, shopIds: [S1, S2] };
  const barber = effectiveAccess(templateFor("barber")!, {}, null, "one");
  const target: UserAccessState = { staffId: "b", isOwner: false, permissions: barber.permissions, maxDiscountPct: barber.maxDiscountPct, scope: "one", shopIds: [S1] };

  it("lets a franchisee owner manage people within their own shops only", () => {
    const next = (o: Partial<UserAccessState>) => ({ ...target, overrides: {}, ...o });
    expect(userAccessChangeDenied(caller, target, next({ scope: "selected", shopIds: [S1, S2] }), { activeOwners: 1 })).toBeNull();
    expect(userAccessChangeDenied(caller, target, next({ scope: "entity", scopeEntityId: E1, shopIds: [S1, S2] }), { activeOwners: 1 })).toBeNull();
    expect(userAccessChangeDenied(caller, target, next({ scope: "entity", scopeEntityId: E2, shopIds: [S1] }), { activeOwners: 1 })).toMatch(/whole owner/);
    expect(userAccessChangeDenied(caller, target, next({ scope: "selected", shopIds: [S3] }), { activeOwners: 1 })).toMatch(/your own shops/);
    expect(userAccessChangeDenied(caller, target, next({ scope: "all", shopIds: [] }), { activeOwners: 1 })).toMatch(/all shops/);
    expect(userAccessChangeDenied(caller, target, next({ scope: "entity", scopeEntityId: null }), { activeOwners: 1 })).toMatch(/Pick the owner/);
  });

  it("keeps a franchisee manager from editing someone over another owner", () => {
    const fm = effectiveAccess(templateFor("franchisee_manager")!, {}, null, "entity");
    const other = { staffId: "x", isOwner: false, permissions: fm.permissions, maxDiscountPct: fm.maxDiscountPct, scope: "entity" as const, scopeEntityId: E2, shopIds: [S1, S3], workShopIds: [] };
    expect(staffEditDenied(caller, other)).toMatch(/whole owner/);
    expect(staffEditDenied(caller, { ...other, scopeEntityId: E1, shopIds: [S1, S2] })).toBeNull();
  });
});

describe("owner-level Stripe accounts", () => {
  it("are a payments mode of their own", () => {
    expect(PAYMENTS_MODES).toContain("entity");
    expect(takesCards("entity", null)).toBe(false);
    expect(takesCards("entity", ready)).toBe(true);
  });

  it("point the payments step at the owner's account", () => {
    expect(paymentsStep("entity", null)).toEqual({ done: false, detail: expect.stringMatching(/owner's Stripe account under Owners/) });
    expect(paymentsStep("entity", ready)).toEqual({ done: true, detail: "Taking cards; payouts go to the owner's bank." });
    expect(paymentsStep("connected", ready).detail).toMatch(/the shop's bank/);
  });

  it("owners are Ray'z corporate or a franchisee", () => {
    expect(OWNER_KIND_LABEL).toEqual({ brand: "Ray'z corporate", franchisee: "Franchisee" });
    expect(ownerEntityProblem({ name: "Moline Cuts LLC", kind: "franchisee" })).toBeNull();
    expect(ownerEntityProblem({ name: "Moline Cuts LLC", kind: "partner" })).toMatch(/franchisee/);
    expect(ownerEntityProblem({ name: "M" })).toMatch(/name/);
  });
});
