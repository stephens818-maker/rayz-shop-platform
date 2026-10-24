import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  BRAND_LEVEL_ONLY,
  Grantor,
  Overrides,
  Permission,
  ROLE_TEMPLATES,
  RoleDef,
  SHOP_LOGIN_NEVER,
  UserAccessState,
  effectiveAccess,
  isBrandLevelPerson,
  isBrandLevelRole,
  roleChangeDenied,
  sharedLoginAccess,
  templateFor,
  userAccessChangeDenied,
} from "@/domain/permissions";

const A = "11111111-1111-1111-1111-111111111111";
const role = (key: string): RoleDef => templateFor(key)!;
const everything: Overrides = Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, true]));
const SHOP_AND_STAFF = ROLE_TEMPLATES.filter((t) => t.key !== "brand_owner" && t.key !== "brand_admin").map((t) => t.key as string);
const brandLevelIn = (perms: ReadonlySet<Permission>) => [...perms].filter((p) => BRAND_LEVEL_ONLY.has(p));

function grantor(key: string, staffId: string): Grantor {
  const a = effectiveAccess(role(key));
  return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope: "all", shopIds: [] };
}
const owner = grantor("brand_owner", "owner");
const admin = grantor("brand_admin", "admin");

describe("brand-level permissions", () => {
  it("are the client list exports, the raw event log, the Squire import and Client data settings", () => {
    expect([...BRAND_LEVEL_ONLY].sort()).toEqual(["analytics.export", "campaign_center.export", "clients.export", "clients.privacy", "import.run", "report.client_ratings.export"]);
    for (const p of BRAND_LEVEL_ONLY) expect(SHOP_LOGIN_NEVER.has(p), p).toBe(true);
  });

  it("no shop or staff template holds one, and none can be switched on for them by overrides, at any scope", () => {
    for (const key of SHOP_AND_STAFF) {
      expect(brandLevelIn(new Set(templateFor(key)!.permissions as Permission[])), key).toEqual([]);
      for (const scope of ["all", "selected", "one"] as const) expect(brandLevelIn(effectiveAccess(role(key), everything, null, scope).permissions), `${key} ${scope}`).toEqual([]);
    }
  });

  it("shop logins never hold one, even under the Brand Admin role", () => {
    for (const key of [...SHOP_AND_STAFF, "brand_admin"]) expect(brandLevelIn(sharedLoginAccess(effectiveAccess(role(key), everything, null, "one")).permissions), key).toEqual([]);
  });

  it("a custom role holds them only when the Brand Owner made it brand-level, and only with every shop", () => {
    const auditor = { key: null, name: "Auditor", permissions: ["clients.view_all", "clients.export"], maxDiscountPct: 0 };
    expect(effectiveAccess({ ...auditor, brandLevel: true }, {}, null, "all").permissions.has("clients.export")).toBe(true);
    expect(effectiveAccess({ ...auditor, brandLevel: true }, {}, null, "selected").permissions.has("clients.export")).toBe(false);
    expect(effectiveAccess(auditor, {}, null, "all").permissions.has("clients.export")).toBe(false);
    expect(effectiveAccess(auditor, { "clients.export": true }, null, "all").permissions.has("clients.export")).toBe(false);
  });

  it("built-in shop and staff roles are never brand-level, whatever the row says", () => {
    expect(isBrandLevelRole(role("brand_owner"))).toBe(true);
    expect(isBrandLevelRole(role("brand_admin"))).toBe(true);
    for (const key of SHOP_AND_STAFF) expect(isBrandLevelRole({ key, brandLevel: true }), key).toBe(false);
    expect(isBrandLevelRole({ key: null, brandLevel: true })).toBe(true);
    expect(isBrandLevelRole({ key: null })).toBe(false);
  });

  it("a brand-level person is a person, not a shop login, with every shop", () => {
    const r = role("brand_admin");
    expect(isBrandLevelPerson({ kind: "person", scope: "all", role: r })).toBe(true);
    expect(isBrandLevelPerson({ kind: "person", scope: "selected", role: r })).toBe(false);
    expect(isBrandLevelPerson({ kind: "shop", scope: "all", role: r })).toBe(false);
    expect(isBrandLevelPerson({ kind: "person", scope: "all", role: role("regional_manager") })).toBe(false);
  });
});

describe("they can't be granted to a shop or staff role", () => {
  const custom = (permissions: string[], brandLevel?: boolean): RoleDef => ({ key: null, name: "Lead", permissions, maxDiscountPct: 0, brandLevel });

  it("not to a built-in shop or staff role, not even by the Brand Owner", () => {
    for (const key of SHOP_AND_STAFF)
      for (const p of BRAND_LEVEL_ONLY) {
        const before = role(key);
        expect(roleChangeDenied(owner, before, { ...before, permissions: [...before.permissions, p] }), `${key} ${p}`).toMatch(/only for brand-level roles/);
      }
  });

  it("not to a custom role unless it's brand-level, which only the Brand Owner decides", () => {
    expect(roleChangeDenied(owner, null, custom(["clients.export"]))).toMatch(/only for brand-level roles/);
    expect(roleChangeDenied(owner, null, custom(["clients.view_all", "clients.export"], true))).toBeNull();
    expect(roleChangeDenied(admin, null, custom([], true))).toMatch(/Only the Brand Owner can make a role brand-level/);
    expect(roleChangeDenied(admin, custom([], true), custom([], false))).toMatch(/Only the Brand Owner/);
    expect(roleChangeDenied(owner, custom(["clients.export"], true), custom(["clients.export"], false))).toMatch(/only for brand-level roles/);
    const before = role("shop_manager");
    expect(roleChangeDenied(owner, before, { ...before, brandLevel: true })).toMatch(/Built-in roles can't be made brand-level/);
  });

  it("not to a person as an override unless they're brand-level", () => {
    const t: UserAccessState = { staffId: "michelle", isOwner: false, permissions: effectiveAccess(role("shop_manager")).permissions, maxDiscountPct: 0, scope: "one", shopIds: [A] };
    for (const p of BRAND_LEVEL_ONLY) {
      const overrides = { [p]: true } as Overrides;
      expect(userAccessChangeDenied(owner, t, { ...t, overrides }, { activeOwners: 1 }), p).toMatch(/only for brand-level roles/);
      expect(userAccessChangeDenied(owner, t, { ...t, overrides: { [p]: false } as Overrides }, { activeOwners: 1 }), p).toBeNull();
    }
    const a: UserAccessState = { ...t, staffId: "auditor", scope: "all", shopIds: [] };
    expect(userAccessChangeDenied(owner, a, { ...a, overrides: { "clients.export": true }, brandLevel: true }, { activeOwners: 1 })).toBeNull();
  });
});

describe("every client list download refuses anyone who isn't brand-level", () => {
  const routes = [
    "customers/export/route.ts",
    "campaign-center/export/route.ts",
    "reports/ratings/export/route.ts",
    "import/[runId]/errors/route.ts",
    "client-data/access/export/route.ts",
    "reports/export/route.ts",
  ];
  it.each(routes)("%s", (r) => {
    expect(readFileSync(join(process.cwd(), "src/app/admin", r), "utf8")).toMatch(/clientListDenied\(ctx\)/);
  });

  it("custom reports on clients, on screen, by email or downloaded", () => {
    expect(readFileSync(join(process.cwd(), "src/server/report-builder/saved.ts"), "utf8")).toMatch(/source === "customers"\) \{\s*const denied = clientListDenied\(ctx\)/);
  });
});
