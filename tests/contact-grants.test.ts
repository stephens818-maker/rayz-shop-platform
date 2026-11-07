import { describe, expect, it } from "vitest";
import {
  ContactGrant,
  GrantCaller,
  grantChangeDenied,
  grantInForce,
  grantPermissions,
  grantStatus,
  heldGrants,
  kindsAt,
  withGrantKinds,
} from "@/domain/contact-grants";
import {
  ALL_PERMISSIONS,
  GRANT_ONLY,
  Grantor,
  Overrides,
  Permission,
  ROLE_TEMPLATES,
  UserAccessState,
  effectiveAccess,
  roleChangeDenied,
  sharedLoginAccess,
  templateFor,
  userAccessChangeDenied,
} from "@/domain/permissions";

const NOW = new Date("2026-10-24T15:00:00Z");
const DAY = 86_400_000;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const ME = "33333333-3333-3333-3333-333333333333";
const g = (over: Partial<ContactGrant>): ContactGrant => ({ id: crypto.randomUUID(), kind: "full_contact", staffId: null, shopId: null, expiresAt: null, revokedAt: null, ...over });

describe("which grants are in force", () => {
  it("until revoked or past the end date", () => {
    expect(grantInForce(g({}), NOW)).toBe(true);
    expect(grantInForce(g({ expiresAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(true);
    expect(grantInForce(g({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
    expect(grantInForce(g({ revokedAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(false);
    expect(grantStatus(g({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(grantStatus(g({ revokedAt: NOW, expiresAt: new Date(0) }), NOW)).toBe("revoked");
    expect(grantStatus(g({}), NOW)).toBe("active");
  });

  it("a person's grant applies at every shop; a location's only there", () => {
    const held = heldGrants(
      [
        g({ staffId: ME, kind: "export" }),
        g({ shopId: A, kind: "full_contact" }),
        g({ shopId: B, kind: "export", revokedAt: NOW }),
        g({ staffId: "someone else", kind: "full_contact" }),
        g({ shopId: B, kind: "full_contact", expiresAt: new Date(NOW.getTime() - DAY) }),
      ],
      ME,
      NOW,
    );
    expect([...held.everywhere]).toEqual(["export"]);
    expect([...kindsAt(held, A)].sort()).toEqual(["export", "full_contact"]);
    expect([...kindsAt(held, B)]).toEqual(["export"]);
  });
});

describe("what a grant adds", () => {
  const front = effectiveAccess(templateFor("front_desk")!);
  it("viewing adds full contact details and nothing else", () => {
    expect(grantPermissions(new Set(["full_contact"]), front.permissions)).toEqual(["clients.contact_full"]);
  });

  it("exporting adds the client list, and the Campaign Center and ratings downloads only for people who can open them", () => {
    expect(grantPermissions(new Set(["export"]), new Set())).toEqual(["clients.export"]);
    expect(grantPermissions(new Set(["export"]), new Set<Permission>(["campaign_center.view", "report.client_ratings.view"])).sort()).toEqual(
      ["campaign_center.export", "clients.export", "report.client_ratings.export"].sort(),
    );
    const a = withGrantKinds(front, new Set());
    expect(a).toBe(front);
    expect(withGrantKinds(front, new Set(["export"])).permissions.has("clients.export")).toBe(true);
  });
});

describe("full contact details are only ever a grant", () => {
  const everything: Overrides = Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, true]));
  const grantor = (key: string): Grantor => {
    const a = effectiveAccess(templateFor(key)!);
    return { staffId: key, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope: "all", shopIds: [] };
  };

  it("no role or override gives it, at any scope, to a person or a shop login", () => {
    expect([...GRANT_ONLY]).toEqual(["clients.contact_full"]);
    for (const t of ROLE_TEMPLATES.filter((t) => t.key !== "brand_owner")) {
      for (const scope of ["all", "selected", "one"] as const) {
        const a = effectiveAccess({ ...templateFor(t.key!)!, permissions: [...t.permissions, "clients.contact_full"] }, everything, null, scope);
        expect(a.permissions.has("clients.contact_full"), `${t.key} ${scope}`).toBe(false);
        expect(sharedLoginAccess(a).permissions.has("clients.contact_full")).toBe(false);
      }
    }
  });

  it("roles and overrides that include it are refused, even by the Brand Owner", () => {
    const owner = grantor("brand_owner");
    const before = templateFor("shop_manager")!;
    expect(roleChangeDenied(owner, before, { ...before, permissions: [...before.permissions, "clients.contact_full"] })).toMatch(/Contact access/);
    expect(roleChangeDenied(owner, null, { key: null, name: "Analyst", permissions: ["clients.contact_full"], maxDiscountPct: 0, brandLevel: true })).toMatch(/isn't part of a role/);
    const t: UserAccessState = { staffId: "michelle", isOwner: false, permissions: effectiveAccess(before).permissions, maxDiscountPct: 0, scope: "one", shopIds: [A] };
    expect(userAccessChangeDenied(owner, t, { ...t, overrides: { "clients.contact_full": true } }, { activeOwners: 1 })).toMatch(/isn't part of a role/);
  });
});

describe("who may give or revoke a grant", () => {
  const brand: GrantCaller = { managesPrivacy: true, seesFullContact: true, mayExport: true };
  const ok = { kind: "full_contact" as const, staffId: ME, shopId: null };

  it("brand-level people who manage client data, and only what they have themselves", () => {
    expect(grantChangeDenied(brand, ok, NOW)).toBeNull();
    expect(grantChangeDenied(brand, { ...ok, kind: "export", staffId: null, shopId: A }, NOW)).toBeNull();
    expect(grantChangeDenied({ ...brand, managesPrivacy: false }, ok, NOW)).toMatch(/Only brand-level people/);
    expect(grantChangeDenied({ ...brand, seesFullContact: false }, ok, NOW)).toMatch(/don't see them yourself/);
    expect(grantChangeDenied({ ...brand, seesFullContact: false }, { ...ok, kind: "export" }, NOW)).toBeNull();
    expect(grantChangeDenied({ ...brand, mayExport: false }, { ...ok, kind: "export" }, NOW)).toMatch(/can't export the client list yourself/);
  });

  it("to exactly one person or one location, ending in the future if at all", () => {
    expect(grantChangeDenied(brand, { ...ok, shopId: A }, NOW)).toMatch(/location or a person/);
    expect(grantChangeDenied(brand, { ...ok, staffId: null }, NOW)).toMatch(/location or a person/);
    expect(grantChangeDenied(brand, { ...ok, kind: "everything" as never }, NOW)).toMatch(/Pick what/);
    expect(grantChangeDenied(brand, { ...ok, expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toMatch(/future/);
    expect(grantChangeDenied(brand, { ...ok, expiresAt: new Date(NOW.getTime() + DAY) }, NOW)).toBeNull();
  });
});
