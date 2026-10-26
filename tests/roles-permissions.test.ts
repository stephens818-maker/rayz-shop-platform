/**
 * Roles and permissions rules that don't need a database: dollar limits, override end dates,
 * region scope, owner entity roles, the permissions split out of older ones, and where each
 * effective permission comes from.
 */
import { describe, expect, it } from "vitest";
import { blockedBecause, permissionSource } from "@/domain/permission-areas";
import {
  Grantor,
  NO_LIMITS,
  Permission,
  ROLE_TEMPLATES,
  RoleDef,
  accessByShop,
  effectiveAccess,
  limitsFor,
  liveOverrides,
  overrideChanges,
  roleChangeDenied,
  roleFitsShop,
  scopeProblem,
  scopeWithin,
  sharedLoginAccess,
  userAccessChangeDenied,
} from "@/domain/permissions";

const tpl = (key: string) => ROLE_TEMPLATES.find((t) => t.key === key)!;
const role = (permissions: string[], extra: Partial<RoleDef> = {}): RoleDef & { id: string } => ({ id: crypto.randomUUID(), key: null, name: "Test", permissions, maxDiscountPct: 10, ...extra });
const admin: Grantor = { ...effectiveAccess(tpl("brand_admin")), staffId: "admin", scope: "all", shopIds: [], limits: { ...NO_LIMITS } };

describe("dollar limits", () => {
  it("come from the role, a person's own replace them key by key, and are zero without the permission", () => {
    const perms = new Set<Permission>(["pos.discount", "sales.refund"]);
    expect(limitsFor(perms, { discountCents: 500, refundCents: 2000 }, {})).toEqual({ discountCents: 500, refundCents: 2000, waiverCents: 0 });
    expect(limitsFor(perms, { discountCents: 500, refundCents: 2000 }, { refundCents: null })).toEqual({ discountCents: 500, refundCents: null, waiverCents: 0 });
    expect(limitsFor(new Set(["sales.void"]), { refundCents: 2000 }, { refundCents: 700 })).toMatchObject({ refundCents: 700, discountCents: 0 });
  });

  it("a shop login keeps none for refunds and voids, whatever its role says", () => {
    const a = effectiveAccess(role(["sales.refund", "sales.void", "pos.discount"], { moneyLimits: { refundCents: 5000, discountCents: 300 } }), {}, null, "one");
    expect(sharedLoginAccess(a).limits).toEqual({ discountCents: 300, refundCents: 0, waiverCents: 0 });
  });

  it("nobody sets or lifts a limit above their own", () => {
    const capped: Grantor = { ...admin, limits: { discountCents: null, refundCents: 5000, waiverCents: null } };
    const r = role(["sales.refund"], { moneyLimits: { refundCents: 2000 } });
    expect(roleChangeDenied(capped, r, { ...r, moneyLimits: { refundCents: 4000 } })).toBeNull();
    expect(roleChangeDenied(capped, r, { ...r, moneyLimits: { refundCents: 6000 } })).toMatch(/refund or void limit above your own \(\$50\)/);
    expect(roleChangeDenied(capped, r, { ...r, moneyLimits: {} })).toMatch(/above your own/);
    expect(roleChangeDenied(admin, r, { ...r, moneyLimits: {} })).toBeNull();

    const person = { staffId: "p", isOwner: false, permissions: new Set<Permission>(["sales.refund"]), maxDiscountPct: 0, scope: "one" as const, shopIds: ["s1"] };
    const next = (refundCents: number | null) => ({ ...person, overrides: {}, limits: { discountCents: 0, refundCents, waiverCents: 0 } });
    const cur = { ...person, limits: { discountCents: 0, refundCents: 1000, waiverCents: 0 } };
    expect(userAccessChangeDenied(capped, cur, next(3000), { activeOwners: 1 })).toBeNull();
    expect(userAccessChangeDenied(capped, cur, next(null), { activeOwners: 1 })).toMatch(/above your own/);
  });
});

describe("temporary overrides", () => {
  it("count through their last day, then drop off", () => {
    const o = { "pos.discount": true, "sales.refund": true, "clients.reveal": false } as const;
    const ends = { "pos.discount": "2026-11-01", "clients.reveal": "2026-10-30" } as const;
    expect(Object.keys(liveOverrides(o, ends, "2026-10-30")).sort()).toEqual(["clients.reveal", "pos.discount", "sales.refund"]);
    expect(Object.keys(liveOverrides(o, ends, "2026-11-01")).sort()).toEqual(["pos.discount", "sales.refund"]);
    expect(Object.keys(liveOverrides(o, ends, "2026-11-02"))).toEqual(["sales.refund"]);
  });

  it("are audited each with its old and new value and end date", () => {
    expect(
      overrideChanges(
        { overrides: { "pos.discount": true, "sales.refund": true }, expires: { "pos.discount": "2026-11-01" } },
        { overrides: { "pos.discount": true, "clients.reveal": false }, expires: { "pos.discount": "2026-11-08" } },
      ),
    ).toEqual({
      "pos.discount": { from: "allow until 2026-11-01", to: "allow until 2026-11-08" },
      "sales.refund": { from: "allow", to: "role default" },
      "clients.reveal": { from: "role default", to: "deny" },
    });
  });
});

describe("region scope", () => {
  it("needs a region, and only the brand or someone over the same region grants it", () => {
    expect(scopeProblem("region", [], null, null)).toBe("Pick the region");
    expect(scopeProblem("region", [], null, "r1")).toBeNull();
    expect(scopeWithin({ scope: "region", scopeRegionId: "r1" }, { scope: "region", scopeRegionId: "r1" })).toBe(true);
    expect(scopeWithin({ scope: "region", scopeRegionId: "r1" }, { scope: "region", scopeRegionId: "r2" })).toBe(false);
    expect(scopeWithin({ scope: "selected" }, { scope: "region", scopeRegionId: "r1" })).toBe(false);
    expect(scopeWithin({ scope: "all" }, { scope: "region", scopeRegionId: "r1" })).toBe(true);
  });

  it("is never all shops, so brand-only permissions stay off", () => {
    const a = effectiveAccess(tpl("regional_manager"), { "catalog.manage": true }, null, "region");
    expect(a.permissions.has("catalog.manage")).toBe(false);
  });
});

describe("owner entity roles", () => {
  it("give nothing at shops that owner doesn't run", () => {
    const own = role(["checkout.any", "sales.refund"], { ownerEntityId: "franchisee" });
    expect(roleFitsShop(own, "franchisee")).toBe(true);
    expect(roleFitsShop(own, "corporate")).toBe(false);
    expect(roleFitsShop(role([]), "corporate")).toBe(true);
    const { byShop, union } = accessByShop(
      own,
      [
        { shopId: "a", role: null, ownerEntityId: "franchisee" },
        { shopId: "b", role: null, ownerEntityId: "corporate" },
      ],
      { "pos.discount": true },
      null,
      "selected",
    );
    expect(byShop.get("a")!.permissions.has("checkout.any")).toBe(true);
    expect(byShop.get("b")!.permissions.size).toBe(0);
    expect(byShop.get("b")!.limits).toEqual({ discountCents: 0, refundCents: 0, waiverCents: 0 });
    expect(union.permissions.has("pos.discount")).toBe(true);
  });

  it("built-in roles stay the brand's, and a brand-level role can't belong to one owner", () => {
    const fd = tpl("front_desk");
    expect(roleChangeDenied(admin, fd, { ...fd, ownerEntityId: "franchisee" })).toMatch(/Built-in roles belong to the brand/);
    const c = role([], { brandLevel: true });
    expect(roleChangeDenied({ ...admin, isOwner: true }, c, { ...c, ownerEntityId: "franchisee" })).toMatch(/brand-level role belongs to the brand/);
    expect(roleChangeDenied(admin, role([]), { ...role([]), ownerEntityId: "franchisee" })).toBeNull();
  });
});

describe("split permissions keep least privilege", () => {
  it("managing the calendar includes seeing every column; viewing it doesn't include changing it", () => {
    expect(effectiveAccess(role(["calendar.manage"])).permissions.has("calendar.view_all")).toBe(true);
    expect(effectiveAccess(role(["calendar.view_all"])).permissions.has("calendar.manage")).toBe(false);
    expect(effectiveAccess(role(["staff.manage"])).permissions.has("staff.view")).toBe(true);
  });

  it("the QuickBooks journal needs the sales summary report", () => {
    expect(effectiveAccess(role(["exports.accounting"])).permissions.has("exports.accounting")).toBe(false);
    expect(effectiveAccess(role(["exports.accounting", "report.sales_summary.view"])).permissions.has("exports.accounting")).toBe(true);
  });

  it("Bookkeeper and Marketing can't check out, refund, see contact details or export clients", () => {
    for (const key of ["bookkeeper", "marketing"]) {
      const p = effectiveAccess(tpl(key)).permissions;
      for (const no of ["checkout.any", "sales.refund", "sales.void", "clients.reveal", "clients.export", "campaign_center.export", "permissions.manage", "settings.shop"] as Permission[])
        expect(p.has(no), `${key}: ${no}`).toBe(false);
    }
    expect(effectiveAccess(tpl("bookkeeper")).permissions.has("exports.accounting")).toBe(true);
    expect(effectiveAccess(tpl("bookkeeper")).permissions.has("payroll.export")).toBe(true);
    expect(effectiveAccess(tpl("marketing")).permissions.has("campaign_center.send")).toBe(true);
  });

  it("no location role has pay rates or compensation to start", () => {
    for (const key of ["regional_manager", "shop_manager", "front_desk", "barber", "marketing"]) {
      const p = effectiveAccess(tpl(key)).permissions;
      expect(p.has("payroll.rates") || p.has("compensation.view") || p.has("compensation.edit"), key).toBe(false);
    }
  });
});

describe("where a permission comes from", () => {
  const base = {
    isOwner: false,
    fromRole: new Set<Permission>(["sales.refund", "calendar.manage", "catalog.manage"]),
    overrides: { "pos.discount": true, "sales.refund": false } as const,
    expires: { "pos.discount": "2026-11-01" } as const,
    granted: new Set<Permission>(),
    scope: "one" as const,
    brandLevel: false,
    shopLogin: false,
    ownerMismatch: false,
  };
  const held = new Set<Permission>(["pos.discount", "calendar.manage", "calendar.view_all"]);
  const src = (p: Permission) => permissionSource(p, { ...base, held });

  it("names the role, overrides with their end date, inclusions and the rule that keeps it off", () => {
    expect(src("calendar.manage")).toEqual({ kind: "role", text: "From the role" });
    expect(src("pos.discount")).toEqual({ kind: "allowed", text: "Allowed for them until 2026-11-01" });
    expect(src("sales.refund")).toEqual({ kind: "denied", text: "Denied for them" });
    expect(src("calendar.view_all").kind).toBe("included");
    expect(src("catalog.manage")).toEqual({ kind: "blocked", text: "The role has it, but off: needs access to all shops" });
    expect(src("drawer.manage")).toEqual({ kind: "none", text: "Not given" });
    expect(blockedBecause("sales.refund", { held, scope: "one", brandLevel: false, shopLogin: true, ownerMismatch: false })).toMatch(/shop login/);
    expect(blockedBecause("sales.refund", { held, scope: "all", brandLevel: false, shopLogin: false, ownerMismatch: true })).toMatch(/another owner/);
  });
});
