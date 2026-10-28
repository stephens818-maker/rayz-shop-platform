import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CartLine, computeCheckout, manualDiscountProblem } from "@/domain/checkout";
import { PAGE_ACCESS, navFor, pageAllowed, reportsFor } from "@/domain/navigation";
import {
  ALL_PERMISSIONS,
  BRAND_CAMPAIGN_CENTER,
  FEATURE_PERMISSIONS,
  Grantor,
  GRANT_ONLY,
  OWNER_GRANTS,
  OWNER_ONLY,
  Permission,
  REPORTS,
  ROLE_TEMPLATES,
  RoleDef,
  UserAccessState,
  accessByShop,
  assignableRoles,
  effectiveAccess,
  isPermission,
  reportExport,
  reportView,
  roleChangeDenied,
  sharedLoginAccess,
  staffEditDenied,
  templateFor,
  templateRow,
  userAccessChangeDenied,
} from "@/domain/permissions";
import { PRIVILEGED_PERMISSIONS } from "@/domain/staff-auth";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";
const role = (key: string): RoleDef => templateFor(key)!;
const access = (key: string, o = {}, max: number | null = null) => effectiveAccess(role(key), o, max);

function grantor(key: string, scope: Grantor["scope"], shopIds: string[], staffId = "caller"): Grantor {
  const a = access(key);
  return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope, shopIds };
}
function state(key: string, scope: UserAccessState["scope"], shopIds: string[], staffId = "target", o = {}): UserAccessState {
  const a = access(key, o);
  return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope, shopIds };
}
const next = (s: UserAccessState, roleKey: string, o: Record<string, boolean> = {}, patch: Partial<UserAccessState> = {}) => {
  const a = effectiveAccess(role(roleKey), o);
  return { ...s, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, overrides: o, ...patch };
};

const owner = grantor("brand_owner", "all", [A, B, C], "owner");
const admin = grantor("brand_admin", "all", [A, B, C], "admin");
const regional = { ...grantor("regional_manager", "selected", [A, B], "regional"), permissions: new Set([...access("regional_manager").permissions, "permissions.manage" as Permission]) };
const manager = grantor("shop_manager", "one", [A], "manager");

describe("permission catalog and templates", () => {
  it("has every report as its own view and export permission", () => {
    for (const r of REPORTS) {
      expect(isPermission(reportView(r.key))).toBe(true);
      expect(isPermission(reportExport(r.key))).toBe(true);
    }
    expect(ALL_PERMISSIONS).toHaveLength(FEATURE_PERMISSIONS.length + REPORTS.length * 2);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it("templates only use known permissions, and only Brand Owner has owner-only ones", () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(isPermission(p), `${t.key}: ${p}`).toBe(true);
      const a = effectiveAccess(t);
      for (const p of OWNER_ONLY) expect(a.permissions.has(p)).toBe(t.key === "brand_owner");
    }
  });

  it("Brand Owner has everything; Brand Admin everything except brand settings, banking and the client and Campaign Center exports", () => {
    expect(access("brand_owner").permissions.size).toBe(ALL_PERMISSIONS.length);
    expect(access("brand_admin").permissions.size).toBe(ALL_PERMISSIONS.length - OWNER_ONLY.size - OWNER_GRANTS.size - GRANT_ONLY.size - 2);
    expect(access("brand_admin").permissions.has("clients.export")).toBe(false);
    expect(access("brand_admin").permissions.has("campaign_center.export")).toBe(false);
    expect(access("brand_admin").permissions.has("payments.banking")).toBe(false);
    expect(access("brand_admin").permissions.has("settings.brand")).toBe(false);
    expect(access("brand_admin").permissions.has("clients.privacy")).toBe(true);
  });

  it("tip payouts: everyone sees their own tips, the brand approves payouts (managers only by a grant), only brand-level roles change the settings", () => {
    for (const k of ["brand_admin", "regional_manager", "shop_manager", "front_desk", "barber", "apprentice"]) {
      expect(access(k).permissions.has("tips.own"), k).toBe(true);
      expect(pageAllowed(access(k).permissions, "/admin/my-tips"), k).toBe(true);
      expect(pageAllowed(access(k).permissions, "/admin/my-banking"), k).toBe(true);
    }
    for (const k of ["brand_admin", "franchisee_owner"]) expect(pageAllowed(access(k).permissions, "/admin/tips"), k).toBe(true);
    for (const k of ["regional_manager", "shop_manager", "franchisee_manager", "front_desk", "barber"]) expect(pageAllowed(access(k).permissions, "/admin/tips"), k).toBe(false);
    for (const k of ["regional_manager", "shop_manager", "franchisee_manager"])
      for (const p of ["tips.approve", "payouts.view", "payouts.manage"] as Permission[]) expect(access(k).permissions.has(p), `${k} ${p}`).toBe(false);
    expect(pageAllowed(access("shop_manager", { "tips.approve": true }).permissions, "/admin/tips")).toBe(true);
    for (const k of ["regional_manager", "shop_manager", "front_desk", "barber"]) expect(access(k).permissions.has("tips.settings"), k).toBe(false);
    expect(access("brand_admin").permissions.has("tips.settings")).toBe(true);
    expect(effectiveAccess(role("brand_admin"), {}, null, "selected").permissions.has("tips.settings")).toBe(false);
  });

  it("tips to barbers on or off and the refund rule: their own permission, Brand Owner and Brand Admin only to start, brand-wide, with two-step sign-in", () => {
    for (const t of ROLE_TEMPLATES) expect(effectiveAccess(t).permissions.has("tips.barber_payouts"), t.key).toBe(t.key === "brand_owner" || t.key === "brand_admin");
    expect(effectiveAccess(role("brand_admin"), {}, null, "selected").permissions.has("tips.barber_payouts")).toBe(false);
    expect(FEATURE_PERMISSIONS.find((p) => p.key === "tips.barber_payouts")).toMatchObject({ group: "Tip payouts", brandOnly: true });
    expect(PRIVILEGED_PERMISSIONS).toContain("tips.barber_payouts");
    expect(pageAllowed(new Set<Permission>(["tips.barber_payouts"]), "/admin/tips/settings")).toBe(true);
  });

  it("only the Brand Owner can export the client list by default; managers can reveal, everyone who books can call and text", () => {
    for (const t of ROLE_TEMPLATES) expect(effectiveAccess(t).permissions.has("clients.export"), t.key).toBe(t.key === "brand_owner");
    for (const k of ["brand_admin", "regional_manager", "shop_manager"]) expect(access(k).permissions.has("clients.reveal"), k).toBe(true);
    for (const k of ["front_desk", "barber"]) expect(access(k).permissions.has("clients.reveal"), k).toBe(false);
    for (const k of ["front_desk", "barber", "shop_manager"]) expect(access(k).permissions.has("clients.message"), k).toBe(true);
  });

  it("the Campaign Center is the brand's: location roles get only We have openings and its report unless the brand grants more", () => {
    for (const k of ["regional_manager", "shop_manager", "front_desk"]) {
      const p = access(k).permissions;
      expect(p.has("campaign_center.openings"), k).toBe(true);
      expect(p.has("report.openings.view"), k).toBe(true);
      for (const b of BRAND_CAMPAIGN_CENTER) expect(p.has(b), `${k} ${b}`).toBe(false);
      expect(navFor(p).find((s) => s.title === "Campaign Center")?.items.map((i) => i.href), k).toEqual(["/admin/campaign-center/openings"]);
    }
    expect(access("barber").permissions.has("campaign_center.openings")).toBe(false);
    for (const k of ["brand_owner", "brand_admin"]) {
      expect(access(k).permissions.has("campaign_center.openings"), k).toBe(true);
      expect(access(k).permissions.has("campaign_center.send"), k).toBe(true);
    }
    expect(access("front_desk").permissions.has("report.openings.export")).toBe(false);
    expect(effectiveAccess(role("shop_manager"), { "campaign_center.send": true, "campaign_center.view": true }).permissions.has("campaign_center.send")).toBe(true);
    expect(pageAllowed(access("front_desk").permissions, "/admin/campaign-center/openings")).toBe(true);
    expect(pageAllowed(access("front_desk").permissions, "/admin/campaign-center")).toBe(false);
    expect(pageAllowed(access("shop_manager").permissions, "/admin/campaign-center/blasts/[id]")).toBe(false);
  });

  it("Barber gets their own sales, service times, rebook rate and PPH; Front Desk gets six reports, view only, and a 10% discount cap", () => {
    expect(reportsFor(access("barber").permissions).map((r) => [r.key, r.canExport])).toEqual([
      ["my_sales", true],
      ["rebook_rate", false],
      ["service_times", true],
      ["pph", false],
    ]);
    expect(reportsFor(access("apprentice").permissions).some((r) => r.key === "pph")).toBe(true);
    expect(reportsFor(access("front_desk").permissions).some((r) => r.key === "pph")).toBe(false);
    expect(reportsFor(access("front_desk").permissions).map((r) => [r.key, r.canExport])).toEqual([
      ["end_of_day", false],
      ["card_vs_cash", false],
      ["appointments", false],
      ["staffing", false],
      ["openings", false],
      ["cash_drawer", false],
    ]);
    expect(access("front_desk").maxDiscountPct).toBe(10);
    expect(access("barber").maxDiscountPct).toBe(0);
  });

  it("each person's tips, payroll, payouts and commission are the brand's to show: no shop role or shop login starts with them, and the brand can give them", () => {
    const pay = ["tips_payroll", "tip_payouts", "commission_payout"].flatMap((k) => [`report.${k}.view`, `report.${k}.export`]) as Permission[];
    for (const key of ["shop_manager", "regional_manager", "franchisee_manager", "front_desk", "shop_login", "barber", "apprentice", "marketing"])
      for (const p of pay) expect(access(key).permissions.has(p), `${key} ${p}`).toBe(false);
    for (const p of pay.slice(0, 4)) expect(access("franchisee_owner").permissions.has(p), p).toBe(true);
    for (const p of pay) expect(access("bookkeeper").permissions.has(p), p).toBe(true);
    expect(access("shop_manager", { "report.tips_payroll.view": true }).permissions.has("report.tips_payroll.view")).toBe(true);
    expect(sharedLoginAccess(effectiveAccess(role("shop_login"), { "report.tips_payroll.view": true }, null, "one")).permissions.has("report.tips_payroll.view")).toBe(false);
    // Approving hours stays the manager's job; tip payouts are the brand's unless granted (Charles, Oct 28).
    expect(access("shop_manager").permissions.has("timesheet.approve")).toBe(true);
    expect(access("shop_manager").permissions.has("tips.approve")).toBe(false);
    expect(access("shop_manager", { "tips.approve": true }).permissions.has("tips.approve")).toBe(true);
  });

  it("the migrations seed exactly the templates in code", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle/0009_permissions_and_catalog.sql"), "utf8");
    // Later migrations grant permissions to templates (|| '[...]'), take them away (- 'key') or rename
    // them in every role (a VALUES list of old and new names), in file order. Descriptions are
    // reworded only where they're still the old default.
    const later = readdirSync(join(process.cwd(), "drizzle"))
      .filter((f) => f.endsWith(".sql") && f > "0009")
      .sort()
      .map((f) => readFileSync(join(process.cwd(), "drizzle", f), "utf8"))
      .join("\n");
    const ALL_KEYS = ROLE_TEMPLATES.map((t) => t.key as string);
    const changes = [
      ...[...later.matchAll(/UPDATE "roles" SET "permissions" = "permissions" (?:\|\| '(\[.*?\])'::jsonb|- '([\w.]+)') WHERE "key" (?:IN \(([^)]*)\)|= ('\w+'))/g)].map((m) => ({
        at: m.index,
        add: m[1] ? (JSON.parse(m[1]) as string[]) : [],
        remove: m[2] ? [m[2]] : [],
        rename: [] as [string, string][],
        keys: [...(m[3] ?? m[4]).matchAll(/'(\w+)'/g)].map((k) => k[1]),
        holding: null as string | null,
      })),
      ...[...later.matchAll(/UPDATE "roles" SET "permissions" = "permissions" \|\| '(\[.*?\])'::jsonb WHERE "permissions" \? '([\w.]+)'/g)].map((m) => ({
        at: m.index,
        add: JSON.parse(m[1]) as string[],
        remove: [] as string[],
        rename: [] as [string, string][],
        keys: [] as string[],
        holding: m[2] as string | null,
      })),
      ...[...later.matchAll(/UPDATE "roles" r SET "permissions" = \([\s\S]*?LEFT JOIN \(VALUES([\s\S]*?)\) m\(k, n\)/g)].map((m) => ({
        at: m.index,
        add: [] as string[],
        remove: [] as string[],
        rename: [...m[1].matchAll(/\('([\w.]+)', '([\w.]+)'\)/g)].map((p) => [p[1], p[2]] as [string, string]),
        keys: [...ALL_KEYS],
        holding: null as string | null,
      })),
    ].sort((a, b) => a.at - b.at);
    const reworded = [...later.matchAll(/UPDATE "roles" SET "description" = '((?:[^']|'')*)' WHERE "key" = '(\w+)' AND "description" = '((?:[^']|'')*)'/g)].map((m) => ({
      key: m[2],
      to: m[1].replace(/''/g, "'"),
      from: m[3].replace(/''/g, "'"),
    }));
    const renamedRoles = [...later.matchAll(/UPDATE "roles" SET "name" = '((?:[^']|'')*)' WHERE "key" = '(\w+)' AND "name" = '((?:[^']|'')*)'/g)].map((m) => ({
      key: m[2],
      to: m[1].replace(/''/g, "'"),
      from: m[3].replace(/''/g, "'"),
    }));
    const grants = changes.filter((c) => c.add.length);
    const rows = [...sql.matchAll(/^\s*\('(\w+)', '((?:[^']|'')*)', '((?:[^']|'')*)', '(\[.*?\])'::jsonb, (\d+), '(\w+)', (\d+)\)/gm)].map((m) => ({
      key: m[1],
      name: m[2],
      description: m[3].replace(/''/g, "'"),
      permissions: JSON.parse(m[4]),
      maxDiscountPct: Number(m[5]),
      defaultScope: m[6],
      sortOrder: Number(m[7]),
    }));
    const inserted = [
      ...later.matchAll(/INSERT INTO "roles" \([^)]*\)\s*SELECT '(\w+)', '((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'(\[.*?\])'::jsonb,\s*(\d+), '(\w+)', (\d+)/g),
    ].map((m) => ({
      at: m.index,
      key: m[1],
      name: m[2],
      description: m[3].replace(/''/g, "'"),
      permissions: JSON.parse(m[4]),
      maxDiscountPct: Number(m[5]),
      defaultScope: m[6],
      sortOrder: Number(m[7]),
    }));
    const resorted = [...later.matchAll(/UPDATE "roles" SET "sort_order" = (\d+) WHERE "key" = '(\w+)'/g)].map((m) => ({ key: m[2], sortOrder: Number(m[1]) }));
    const all = [...rows.map((r) => ({ ...r, at: -1 })), ...inserted].map((r) => resorted.filter((s) => s.key === r.key).reduce<typeof r>((x, s) => ({ ...x, sortOrder: s.sortOrder }), r));
    const seeded = all.sort((a, b) => a.sortOrder - b.sortOrder).map(({ at, ...r }) => {
      const perms = new Set<string>(r.permissions);
      for (const c of changes.filter((c) => c.at > at)) {
        if (!c.keys.includes(r.key) && !(c.holding && perms.has(c.holding))) continue;
        c.add.forEach((p) => perms.add(p));
        c.remove.forEach((p) => perms.delete(p));
        const renamed = c.rename.filter(([from]) => perms.has(from));
        renamed.forEach(([from]) => perms.delete(from));
        renamed.forEach(([, to]) => perms.add(to));
      }
      const description = reworded.filter((w) => w.key === r.key).reduce((d, w) => (d === w.from ? w.to : d), r.description);
      const name = renamedRoles.filter((w) => w.key === r.key).reduce((n, w) => (n === w.from ? w.to : n), r.name);
      return { ...r, name, description, permissions: [...perms].sort() };
    });
    expect(grants.length).toBeGreaterThan(0);
    expect(seeded).toEqual(ROLE_TEMPLATES.map(templateRow).map((t) => ({ ...t, permissions: [...t.permissions].sort() })));
  });
});

describe("effective permissions", () => {
  it("per-user overrides add and remove on top of the role", () => {
    const a = access("barber", { "clients.reveal": true, "clients.rate": false });
    expect(a.permissions.has("clients.reveal")).toBe(true);
    expect(a.permissions.has("clients.rate")).toBe(false);
  });

  it("owner-only permissions can't be granted per user, and export needs view", () => {
    const a = access("brand_admin", { "settings.brand": true });
    expect(a.permissions.has("settings.brand")).toBe(false);
    const r = access("regional_manager", { "report.gift_cards.view": false, "report.gift_cards.export": true });
    expect(r.permissions.has("report.gift_cards.export")).toBe(false);
    // A brand-wide Brand Admin always sees every report, so the floor puts a removed view back.
    expect(access("brand_admin", { "report.gift_cards.view": false }).permissions.has("report.gift_cards.view")).toBe(true);
    expect(access("barber", { "report.sales_summary.export": true }).permissions.has("report.sales_summary.export")).toBe(false);
  });

  it("a personal discount limit replaces the role's, and no discount permission means 0%", () => {
    expect(access("front_desk", {}, 25).maxDiscountPct).toBe(25);
    expect(access("front_desk", { "pos.discount": false }, 25).maxDiscountPct).toBe(0);
    expect(access("front_desk", {}, 400).maxDiscountPct).toBe(100);
  });

  it("ignores unknown override keys", () => {
    expect(access("barber", { "do.anything": true } as never).permissions.size).toBe(access("barber").permissions.size);
  });
});

describe("a different role at each assigned shop", () => {
  const withId = (key: string) => ({ ...role(key), id: key });
  const kat = (shops: { shopId: string; role: string | null }[], o = {}, scope: Grantor["scope"] = "selected") =>
    accessByShop(withId("barber"), shops.map((s) => ({ shopId: s.shopId, role: s.role ? withId(s.role) : null })), o, null, scope);

  it("each shop gets its own role, with the person's overrides on top everywhere", () => {
    const a = kat([{ shopId: A, role: null }, { shopId: B, role: "shop_manager" }], { "clients.reveal": true });
    expect(a.uniform).toBe(false);
    expect(a.byShop.get(A)!.permissions.has("sales.view")).toBe(false);
    expect(a.byShop.get(B)!.permissions.has("sales.view")).toBe(true);
    expect(a.byShop.get(B)!.role.id).toBe("shop_manager");
    for (const shop of [A, B]) expect(a.byShop.get(shop)!.permissions.has("clients.reveal")).toBe(true);
    expect(a.union.permissions.has("sales.view")).toBe(true);
    expect(a.union.maxDiscountPct).toBe(100);
  });

  it("the same role everywhere is uniform, so they can work across their shops at once", () => {
    expect(kat([{ shopId: A, role: null }, { shopId: B, role: "barber" }]).uniform).toBe(true);
    expect(kat([{ shopId: A, role: null }]).uniform).toBe(true);
  });

  it("never Brand Owner at one shop, and brand-only permissions stay off", () => {
    const a = kat([{ shopId: A, role: "brand_owner" }, { shopId: B, role: "brand_admin" }]);
    expect(a.byShop.get(A)!.isOwner).toBe(false);
    expect(a.byShop.get(A)!.role.id).toBe("barber");
    expect(a.byShop.get(B)!.permissions.has("catalog.manage")).toBe(false);
    expect(a.union.permissions.has("settings.brand")).toBe(false);
  });

  it("per-shop roles don't apply to someone with every shop", () => {
    const a = kat([{ shopId: A, role: "shop_manager" }, { shopId: B, role: null }], {}, "all");
    expect(a.uniform).toBe(true);
    expect(a.byShop.get(A)!.permissions.has("sales.view")).toBe(false);
  });
});

describe("granting: roles", () => {
  const custom = (permissions: string[], maxDiscountPct = 0): RoleDef => ({ key: null, name: "Lead", permissions, maxDiscountPct });

  it("only people with every shop and permissions.manage edit roles", () => {
    expect(roleChangeDenied(admin, null, custom(["calendar.manage"]))).toBeNull();
    expect(roleChangeDenied(regional, null, custom(["calendar.manage"]))).toMatch(/all shops/);
    expect(roleChangeDenied(manager, null, custom([]))).toMatch(/can't manage permissions/);
  });

  it("nobody edits the Brand Owner role or adds brand-level settings to another role", () => {
    expect(roleChangeDenied(owner, role("brand_owner"), { ...role("brand_owner"), permissions: [] })).toMatch(/Brand Owner role/);
    expect(roleChangeDenied(owner, role("brand_admin"), { ...role("brand_admin"), permissions: [...role("brand_admin").permissions, "settings.brand"] })).toMatch(/Only the Brand Owner/);
  });

  it("you can't grant what you don't have, or a bigger discount than yours", () => {
    const limited = { ...admin, permissions: new Set([...admin.permissions].filter((p) => p !== "sales.refund")), maxDiscountPct: 20 };
    expect(roleChangeDenied(limited, null, custom(["sales.refund"]))).toMatch(/don't have/);
    expect(roleChangeDenied(limited, null, custom(["pos.discount"], 50))).toMatch(/discount limit/);
    expect(roleChangeDenied(limited, null, custom(["pos.discount"], 20))).toBeNull();
  });

  it("built-in roles can be reset but not deleted", () => {
    expect(roleChangeDenied(admin, role("barber"), null)).toMatch(/can't be deleted/);
    expect(roleChangeDenied(admin, custom([]), null)).toBeNull();
  });
});

describe("granting: people", () => {
  const opts = { activeOwners: 2 };

  it("only the Brand Owner grants Brand Owner or changes an owner", () => {
    const t = state("brand_admin", "all", []);
    expect(userAccessChangeDenied(admin, t, next(t, "brand_owner"), opts)).toMatch(/Only the Brand Owner can grant/);
    expect(userAccessChangeDenied(owner, t, next(t, "brand_owner"), opts)).toBeNull();
    const o = state("brand_owner", "all", []);
    expect(userAccessChangeDenied(admin, o, next(o, "brand_admin"), opts)).toMatch(/Brand Owner's access/);
  });

  it("the last Brand Owner can't be demoted, and nobody edits their own access", () => {
    const o = state("brand_owner", "all", [], "other-owner");
    expect(userAccessChangeDenied(owner, o, next(o, "brand_admin"), { activeOwners: 1 })).toMatch(/only Brand Owner/);
    const me = state("brand_admin", "all", [], "admin");
    expect(userAccessChangeDenied(admin, me, next(me, "brand_admin", { "settings.taxes": false }), opts)).toMatch(/your own access/);
  });

  it("brand-level settings can't be given as an override", () => {
    const t = state("shop_manager", "one", [A]);
    expect(userAccessChangeDenied(owner, t, next(t, "shop_manager", { "settings.brand": true }), opts)).toMatch(/Brand Owner role/);
  });

  it("shop scope: someone with some shops can only grant within them, never all shops", () => {
    const t = state("barber", "selected", [A]);
    expect(userAccessChangeDenied(regional, t, next(t, "barber", {}, { shopIds: [A, B] }), opts)).toBeNull();
    expect(userAccessChangeDenied(regional, t, next(t, "barber", {}, { shopIds: [A, C] }), opts)).toMatch(/your own shops/);
    expect(userAccessChangeDenied(regional, t, next(t, "barber", {}, { scope: "all", shopIds: [] }), opts)).toMatch(/all shops/);
    const elsewhere = state("barber", "selected", [A, C]);
    expect(userAccessChangeDenied(regional, elsewhere, next(elsewhere, "barber"), opts)).toMatch(/outside yours/);
  });

  it("scope shapes are checked", () => {
    const t = state("barber", "selected", [A]);
    expect(userAccessChangeDenied(admin, t, next(t, "barber", {}, { scope: "one", shopIds: [A, B] }), opts)).toMatch(/exactly one/);
    expect(userAccessChangeDenied(admin, t, next(t, "barber", {}, { scope: "selected", shopIds: [] }), opts)).toMatch(/at least one/);
  });

  it("no escalation past the caller, and nobody edits someone with access they don't have", () => {
    const t = state("barber", "selected", [A]);
    expect(userAccessChangeDenied(regional, t, next(t, "barber", { "clients.merge": true }), opts)).toMatch(/don't have/);
    const above = state("shop_manager", "one", [A], "target", { "clients.merge": true });
    expect(userAccessChangeDenied(regional, above, next(above, "barber"), opts)).toMatch(/access you don't/);
    const fd = state("front_desk", "one", [A]);
    const capped = { ...regional, maxDiscountPct: 15 };
    expect(userAccessChangeDenied(capped, fd, { ...next(fd, "front_desk"), maxDiscountPct: 30 }, opts)).toMatch(/discount limit/);
  });

  it("profile edits follow the same lines", () => {
    expect(staffEditDenied(manager, { ...state("brand_owner", "all", []), workShopIds: [A] })).toMatch(/Brand Owner/);
    expect(staffEditDenied(manager, { ...state("barber", "selected", [A]), workShopIds: [A] })).toBeNull();
    expect(staffEditDenied(manager, { ...state("barber", "selected", [B]), workShopIds: [B] })).toMatch(/team/);
    expect(staffEditDenied(manager, { ...state("brand_admin", "all", []), workShopIds: [A] })).not.toBeNull();
  });

  it("new hires can be given only roles within the caller's own access", () => {
    const roles = ROLE_TEMPLATES.map((t, i) => ({ ...t, id: String(i) }));
    expect(assignableRoles(manager, roles).map((r) => r.key)).toEqual(["shop_manager", "front_desk", "shop_login", "barber", "apprentice"]);
    expect(assignableRoles(admin, roles).map((r) => r.key)).not.toContain("brand_owner");
    expect(assignableRoles(owner, roles)).toHaveLength(roles.length);
  });
});

describe("navigation follows permissions", () => {
  it("lists exactly the pages someone can open", () => {
    const fd = access("front_desk").permissions;
    const hrefs = navFor(fd).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/admin/drawer");
    expect(hrefs).toContain("/admin/reports");
    expect(hrefs).not.toContain("/admin/permissions");
    expect(hrefs).not.toContain("/admin/catalog");
    for (const h of hrefs) expect(pageAllowed(fd, h as keyof typeof PAGE_ACCESS)).toBe(true);
    const barber = navFor(access("barber").permissions).flatMap((s) => s.items.map((i) => i.href));
    expect(barber).toEqual(["/admin", "/admin/calendar", "/admin/clock", "/admin/my-time", "/admin/my-tips", "/admin/my-banking", "/admin/milestones", "/admin/customers", "/admin/reports", "/admin/timesheets", "/admin/pay-questions"]);
    expect(hrefs).toContain("/admin/my-time");
    expect(hrefs).toContain("/admin/time-off");
    expect(barber).not.toContain("/admin/time-off");
  });

  it("every report page needs that report's view permission", () => {
    for (const r of REPORTS) expect(PAGE_ACCESS[r.href]).toEqual([reportView(r.key)]);
    const one = new Set<Permission>(["report.gift_cards.view"]);
    expect(pageAllowed(one, "/admin/reports/gift-cards")).toBe(true);
    expect(pageAllowed(one, "/admin/reports/loyalty")).toBe(false);
    expect(pageAllowed(one, "/admin/reports")).toBe(true);
  });
});

describe("server-side enforcement is wired everywhere", () => {
  const root = join(process.cwd(), "src/app/admin");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const files = walk(root);
  const routeOf = (f: string) => "/admin" + ("/" + relative(root, f)).replace(/\/(page\.tsx|route\.ts)$/, "").replace(/^\/$/, "");

  it("every admin page is in PAGE_ACCESS and checks it on the server", () => {
    for (const f of files.filter((x) => x.endsWith("page.tsx"))) {
      const route = routeOf(f) || "/admin";
      const src = readFileSync(f, "utf8");
      const report = REPORTS.find((r) => r.href === route);
      expect(route in PAGE_ACCESS, `${route} missing from PAGE_ACCESS`).toBe(true);
      if (report && !src.includes("guardPage(")) expect(src, route).toMatch(new RegExp(`ReportPage\\(\\{ report: "${report.key}"`));
      else expect(src, route).toContain(`guardPage("${route}")`);
    }
  });

  it("every admin route handler checks the session and a permission", () => {
    for (const f of files.filter((x) => x.endsWith("route.ts"))) expect(readFileSync(f, "utf8"), routeOf(f)).toMatch(/routeStaff\(/);
  });

  it("every exported server action authenticates before doing anything", () => {
    for (const f of files.filter((x) => x.endsWith("actions.ts"))) {
      const src = readFileSync(f, "utf8");
      expect(src.startsWith('"use server"'), f).toBe(true);
      const auth = ["authorize", "requireStaff", "requirePage", "getStaffContext", "endSession"];
      // Local helpers that authenticate (e.g. `guard(saleId)`) count too.
      for (const m of src.matchAll(/\n(?:async )?function (\w+)\(([\s\S]*?)\n}/g)) if (new RegExp(`await (${auth.join("|")})\\(`).test(m[2])) auth.push(m[1]);
      const bodies = src.split(/\nexport async function /).slice(1);
      expect(bodies.length, f).toBeGreaterThan(0);
      for (const b of bodies) {
        const name = b.slice(0, b.indexOf("("));
        const head = b.split(/\n(?:export )?(?:async )?function /)[0];
        expect(head, `${relative(root, f)}: ${name}`).toMatch(new RegExp(`await (${auth.join("|")})\\(`));
      }
    }
  });
});

describe("POS: discount limit and tax category", () => {
  const cut: CartLine = { key: "1", kind: "service", name: "Cut", unitPriceCents: 4000, qty: 1 };
  const card: CartLine = { key: "2", kind: "gift_card", name: "Gift card", unitPriceCents: 5000, qty: 1 };

  it("caps manual discounts at the person's limit, as a percent or an amount", () => {
    expect(manualDiscountProblem({ type: "percent", value: 10 }, [cut], 10)).toBeNull();
    expect(manualDiscountProblem({ type: "percent", value: 11 }, [cut], 10)).toMatch(/10%/);
    expect(manualDiscountProblem({ type: "amount", value: 400 }, [cut, card], 10)).toBeNull();
    expect(manualDiscountProblem({ type: "amount", value: 401 }, [cut, card], 10)).toMatch(/\$4\.00/);
    expect(manualDiscountProblem({ type: "amount", value: 1 }, [cut], 0)).toMatch(/can't give/);
    expect(manualDiscountProblem(null, [cut], 0)).toBeNull();
  });

  it("taxes each line by its tax category", () => {
    const rates = { serviceRate: 0.05, productRate: 0.1 };
    const fee = { enabled: false, rate: 0, appliesToTip: false };
    const exemptProduct: CartLine = { key: "3", kind: "product", name: "Gift box", unitPriceCents: 1000, qty: 1, taxCategory: "exempt" };
    const retailService: CartLine = { key: "4", kind: "service", name: "Kit", unitPriceCents: 1000, qty: 1, taxCategory: "product" };
    const t = computeCheckout({ lines: [exemptProduct, retailService], taxRates: rates, cardFee: fee, tender: { method: "cash" } });
    expect(t.productTaxCents).toBe(100);
    expect(t.serviceTaxCents).toBe(0);
    expect(t.serviceNetCents).toBe(1000);
  });
});
