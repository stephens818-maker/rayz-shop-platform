import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CartLine, computeCheckout, manualDiscountProblem } from "@/domain/checkout";
import { PAGE_ACCESS, navFor, pageAllowed, reportsFor } from "@/domain/navigation";
import {
  ALL_PERMISSIONS,
  FEATURE_PERMISSIONS,
  Grantor,
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
  staffEditDenied,
  templateFor,
  templateRow,
  userAccessChangeDenied,
} from "@/domain/permissions";

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

  it("Brand Owner has everything; Brand Admin everything except brand settings, banking and the client export", () => {
    expect(access("brand_owner").permissions.size).toBe(ALL_PERMISSIONS.length);
    expect(access("brand_admin").permissions.size).toBe(ALL_PERMISSIONS.length - OWNER_ONLY.size - OWNER_GRANTS.size - 1);
    expect(access("brand_admin").permissions.has("payments.banking")).toBe(false);
    expect(access("brand_admin").permissions.has("settings.brand")).toBe(false);
    expect(access("brand_admin").permissions.has("clients.privacy")).toBe(true);
  });

  it("tip payouts: everyone sees their own tips, managers approve payouts, only brand-level roles change the settings", () => {
    for (const k of ["brand_admin", "regional_manager", "shop_manager", "front_desk", "barber"]) {
      expect(access(k).permissions.has("tips.own"), k).toBe(true);
      expect(pageAllowed(access(k).permissions, "/admin/my-tips"), k).toBe(true);
      expect(pageAllowed(access(k).permissions, "/admin/my-banking"), k).toBe(true);
    }
    for (const k of ["brand_admin", "regional_manager", "shop_manager"]) expect(pageAllowed(access(k).permissions, "/admin/tips"), k).toBe(true);
    for (const k of ["front_desk", "barber"]) expect(pageAllowed(access(k).permissions, "/admin/tips"), k).toBe(false);
    for (const k of ["regional_manager", "shop_manager", "front_desk", "barber"]) expect(access(k).permissions.has("tips.settings"), k).toBe(false);
    expect(access("brand_admin").permissions.has("tips.settings")).toBe(true);
    expect(effectiveAccess(role("brand_admin"), {}, null, "selected").permissions.has("tips.settings")).toBe(false);
  });

  it("only the Brand Owner can export the client list by default; managers can reveal, everyone who books can call and text", () => {
    for (const t of ROLE_TEMPLATES) expect(effectiveAccess(t).permissions.has("clients.export"), t.key).toBe(t.key === "brand_owner");
    for (const k of ["brand_admin", "regional_manager", "shop_manager"]) expect(access(k).permissions.has("clients.reveal"), k).toBe(true);
    for (const k of ["front_desk", "barber"]) expect(access(k).permissions.has("clients.reveal"), k).toBe(false);
    for (const k of ["front_desk", "barber", "shop_manager"]) expect(access(k).permissions.has("clients.message"), k).toBe(true);
  });

  it("Barber gets their own sales and service times; Front Desk gets three reports, view only, and a 10% discount cap", () => {
    expect(reportsFor(access("barber").permissions).map((r) => [r.key, r.canExport])).toEqual([
      ["my_sales", true],
      ["service_times", true],
    ]);
    expect(reportsFor(access("front_desk").permissions).map((r) => [r.key, r.canExport])).toEqual([
      ["card_vs_cash", false],
      ["staffing", false],
      ["cash_drawer", false],
    ]);
    expect(access("front_desk").maxDiscountPct).toBe(10);
    expect(access("barber").maxDiscountPct).toBe(0);
  });

  it("the migrations seed exactly the templates in code", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle/0009_permissions_and_catalog.sql"), "utf8");
    // Later migrations grant permissions to templates (|| '[...]') or take them away (- 'key'), in file order.
    const later = readdirSync(join(process.cwd(), "drizzle"))
      .filter((f) => f.endsWith(".sql") && f > "0009")
      .sort()
      .map((f) => readFileSync(join(process.cwd(), "drizzle", f), "utf8"))
      .join("\n");
    const changes = [...later.matchAll(/UPDATE "roles" SET "permissions" = "permissions" (?:\|\| '(\[.*?\])'::jsonb|- '([\w.]+)') WHERE "key" (?:IN \(([^)]*)\)|= ('\w+'))/g)].map((m) => ({
      add: m[1] ? (JSON.parse(m[1]) as string[]) : [],
      remove: m[2] ? [m[2]] : [],
      keys: [...(m[3] ?? m[4]).matchAll(/'(\w+)'/g)].map((k) => k[1]),
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
    const seeded = rows.map((r) => {
      const perms = new Set<string>(r.permissions);
      for (const c of changes.filter((c) => c.keys.includes(r.key))) {
        c.add.forEach((p) => perms.add(p));
        c.remove.forEach((p) => perms.delete(p));
      }
      return { ...r, permissions: [...perms].sort() };
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
    const a = access("brand_admin", { "settings.brand": true, "report.gift_cards.view": false });
    expect(a.permissions.has("settings.brand")).toBe(false);
    expect(a.permissions.has("report.gift_cards.export")).toBe(false);
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
    expect(userAccessChangeDenied(regional, t, next(t, "barber", { "import.run": true }), opts)).toMatch(/don't have/);
    const above = state("shop_manager", "one", [A], "target", { "import.run": true });
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
    expect(assignableRoles(manager, roles).map((r) => r.key)).toEqual(["shop_manager", "front_desk", "barber"]);
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
    expect(barber).toEqual(["/admin", "/admin/calendar", "/admin/clock", "/admin/my-time", "/admin/my-tips", "/admin/my-banking", "/admin/customers", "/admin/reports", "/admin/timesheets"]);
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
