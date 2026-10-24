/**
 * Permissions enforced on the server: every admin page, server actions, route handlers, shop
 * scoping, per-report view/export, and the audit trail. Runs pages and handlers in-process as each
 * demo login, with a fake cookie jar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PAGE_ACCESS, AdminPage, pageAllowed } from "@/domain/navigation";
import type { Permission } from "@/domain/permissions";
import { Mods, actor, loadModules } from "./setup";
import { pageOutcome, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const people: Record<string, { id: string; perms: ReadonlySet<Permission>; shopIds: string[] }> = {};
const shopId: Record<string, string> = {};
const LOGINS = ["owner", "admin", "regional", "michelle", "frontdesk", "makenna"] as const;
type Login = (typeof LOGINS)[number];

const pages = (import.meta as unknown as { glob(p: string): Record<string, () => Promise<unknown>> }).glob("/src/app/admin/**/page.tsx");
const routeOfFile = (f: string) => f.replace("/src/app", "").replace(/\/page\.tsx$/, "");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

async function refresh(login: Login) {
  const s = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${login}@rayz.test`) }))!;
  const a = (await (await import("@/server/auth/access")).loadStaffAccess(s.id))!;
  people[login] = { id: s.id, perms: a.permissions, shopIds: a.shopIds };
}
async function as(login: Login | null, shop?: string) {
  await signInAs(login ? people[login].id : null, shop);
}
async function render(route: string, params: Record<string, string> = {}, searchParams: Record<string, string> = {}) {
  const mod = (await pages[`/src/app${route}/page.tsx`]()) as { default: (p: unknown) => Promise<unknown> };
  return pageOutcome(() => mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) }));
}
async function get(handler: (req: Request, ctx?: unknown) => Promise<Response>, url: string, params?: Record<string, string>) {
  const res = await handler(new Request(`http://localhost${url}`), params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, text: res.status === 200 ? await res.text() : await res.text() };
}
const csvRows = (text: string) => text.trim().split("\n").slice(1).map((l) => l.split(","));

beforeAll(async () => {
  m = await loadModules();
  for (const l of LOGINS) await refresh(l);
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("every admin page checks permissions on the server", () => {
  const staticPages = Object.keys(PAGE_ACCESS).filter((p) => !p.includes("[")) as AdminPage[];

  it("covers every page file", () => {
    expect(Object.keys(pages).map(routeOfFile).sort()).toEqual(Object.keys(PAGE_ACCESS).sort());
  });

  for (const login of LOGINS) {
    it(`${login}: opens exactly the pages their permissions allow`, async () => {
      await as(login);
      const wrong: string[] = [];
      for (const page of staticPages) {
        const got = await render(page);
        const allowed = pageAllowed(people[login].perms, page);
        if (allowed ? got === "denied" || got === "login" : got !== "denied") wrong.push(`${page}: ${got} (allowed=${allowed})`);
      }
      expect(wrong).toEqual([]);
    }, 120_000);
  }

  it("signed out: every page goes to sign-in", async () => {
    await as(null);
    for (const page of staticPages) expect(await render(page), page).toBe("login");
  }, 60_000);

  it("dynamic pages: permission editors, other people's tickets, and staff outside your shops", async () => {
    await as("frontdesk");
    expect(await render("/admin/permissions/people/[id]", { id: people.makenna.id })).toBe("denied");
    expect(await render("/admin/permissions/roles/[id]", { id: "new" })).toBe("denied");
    await as("admin");
    expect(await render("/admin/permissions/people/[id]", { id: people.makenna.id })).toBe("ok");
    expect(await render("/admin/permissions/roles/[id]", { id: "new" })).toBe("ok");

    const theirs = (await m.db.db
      .select()
      .from(m.schema.sales)
      .where(m.drizzle.and(eq(m.schema.sales.shopId, shopId.coralville), m.drizzle.ne(m.schema.sales.staffId, people.makenna.id)))
      .limit(1))[0];
    await as("makenna");
    expect(await render("/admin/sales/[id]", { id: theirs.id })).toBe("denied");
    await as("frontdesk");
    expect(await render("/admin/sales/[id]", { id: theirs.id })).toBe("ok");

    const links = await m.db.db.select().from(m.schema.staffShops);
    const molineBarber = links.find(
      (l) => l.shopId === shopId.moline && links.every((o) => o.staffId !== l.staffId || !people.michelle.shopIds.includes(o.shopId)),
    )!.staffId;
    await as("michelle");
    expect(await render("/admin/staff/[id]", { id: molineBarber })).toBe("404");
  }, 60_000);
});

describe("a la carte reports", () => {
  let exportRoute: (r: Request) => Promise<Response>;
  beforeAll(async () => {
    exportRoute = (await import("@/app/admin/reports/export/route")).GET;
  });

  it("export needs both view and export for that report", async () => {
    await as(null);
    expect((await get(exportRoute, "/admin/reports/export?type=sales_summary")).status).toBe(401);
    await as("makenna");
    expect((await get(exportRoute, "/admin/reports/export?type=sales_summary")).status).toBe(403);
    expect((await get(exportRoute, "/admin/reports/export?type=my_sales")).status).toBe(200);
    await as("frontdesk");
    expect(await render("/admin/reports/tender")).toBe("ok");
    expect((await get(exportRoute, "/admin/reports/export?type=card_vs_cash")).status).toBe(403);
    expect((await get(exportRoute, "/admin/reports/export?type=sales_by_barber")).status).toBe(403);
    expect((await get(exportRoute, "/admin/reports/export?type=nope")).status).toBe(404);
    await as("admin");
    for (const type of ["sales_summary", "payroll", "discounts_refunds", "inventory", "gift_cards", "loyalty", "kpis", "heatmap", "cash_drawer", "audit_log", "services_vs_products", "card_vs_cash"])
      expect((await get(exportRoute, `/admin/reports/export?type=${type}`)).status, type).toBe(200);
  }, 60_000);

  it("My sales is always the viewer's own tickets, whatever the URL says", async () => {
    await as("makenna");
    const own = await get(exportRoute, "/admin/reports/export?type=my_sales&table=daily&preset=30d");
    const spoofed = await get(exportRoute, `/admin/reports/export?type=my_sales&table=daily&preset=30d&staff=${people.michelle.id}`);
    expect(spoofed.text).toBe(own.text);
  });

  it("reports only cover shops in the viewer's access", async () => {
    await as("michelle");
    expect((await get(exportRoute, `/admin/reports/export?type=sales_summary&shop=${shopId.moline}`)).status).toBe(403);
    await as("regional");
    const byShop = await get(exportRoute, "/admin/reports/export?type=sales_summary&table=shops&shop=all&preset=30d");
    expect(byShop.status).toBe(200);
    expect(csvRows(byShop.text).map((r) => r[0])).toEqual(["Moline", "Rock Island", "Total (2 shops)"]);
    const stock = await get(exportRoute, "/admin/reports/export?type=inventory&shop=all&view=shops");
    expect(new Set(csvRows(stock.text).map((r) => r[0]))).toEqual(new Set(["Moline", "Rock Island", "Total (2 shops)"]));
    await as("michelle");
    const audit = await get(exportRoute, "/admin/reports/export?type=audit_log");
    expect(audit.status).toBe(200);
    expect(audit.text).not.toMatch(/,Brand,/);
  });

  it("per-user report overrides: view without export, then export too", async () => {
    const { saveUserAccessAction } = await import("@/app/admin/permissions/actions");
    const fd = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.frontdesk.id) }))!;
    const base = { staffId: fd.id, roleId: fd.roleId, maxDiscountPct: null, scope: "one" as const, shopIds: [shopId.coralville] };
    await as("admin");
    expect(await saveUserAccessAction({ ...base, overrides: { "report.gift_cards.view": true } })).toMatchObject({ ok: true });
    await as("frontdesk");
    expect(await render("/admin/reports/gift-cards")).toBe("ok");
    expect((await get(exportRoute, "/admin/reports/export?type=gift_cards")).status).toBe(403);
    await as("admin");
    expect(await saveUserAccessAction({ ...base, overrides: { "report.gift_cards.view": true, "report.gift_cards.export": true, "report.cash_drawer.view": false } })).toMatchObject({ ok: true });
    await as("frontdesk");
    expect((await get(exportRoute, "/admin/reports/export?type=gift_cards")).status).toBe(200);
    expect(await render("/admin/reports/cash-drawer")).toBe("denied");
    await as("admin");
    expect(await saveUserAccessAction({ ...base, overrides: {} })).toMatchObject({ ok: true });
    await refresh("frontdesk");
  }, 60_000);

  it("client ratings export lists clients, so it's for brand-level people only", async () => {
    const ratings = (await import("@/app/admin/reports/ratings/export/route")).GET;
    for (const who of ["frontdesk", "michelle"] as const) {
      await as(who);
      expect((await get(ratings, "/admin/reports/ratings/export")).status, who).toBe(403);
    }
    await as("admin");
    expect((await get(ratings, "/admin/reports/ratings/export")).status).toBe(200);
  });
});

describe("server actions", () => {
  it("refunds, permissions, uploads and settings are refused without the permission", async () => {
    const sales = await import("@/app/admin/sales/actions");
    const perms = await import("@/app/admin/permissions/actions");
    const settings = await import("@/app/admin/settings/actions");
    const sale = (await m.db.db.select().from(m.schema.sales).where(eq(m.schema.sales.shopId, shopId.coralville)).limit(1))[0];
    await as("makenna");
    expect(await sales.voidAction(sale.id, "test")).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) });
    await as("frontdesk");
    expect(await sales.refundAction({ saleId: sale.id, items: [], tipCents: 0, reason: "x" } as never)).toMatchObject({ ok: false, error: expect.stringMatching(/manager.s PIN/) });
    expect(await perms.saveRoleAction({ id: null, name: "Sneaky", permissions: ["sales.refund"], maxDiscountPct: 0, defaultScope: "one" })).toMatchObject({ ok: false });
    await as("regional");
    expect(await perms.saveUserAccessAction({ staffId: people.makenna.id, roleId: (await m.db.db.select().from(m.schema.roles))[0].id, overrides: {}, maxDiscountPct: null, scope: "selected", shopIds: [shopId.moline] })).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) });
    await as("admin");
    expect(await settings.saveLoyaltyAction({} as never)).toMatchObject({ ok: false, error: expect.stringMatching(/Brand Owner/) });
  });

  it("shop scope: a shop manager can't touch another shop's stock or settings, and taxes need their own permission", async () => {
    const inv = await import("@/app/admin/inventory/actions");
    const settings = await import("@/app/admin/settings/actions");
    const sp = (await m.db.db.select().from(m.schema.shopProducts).where(eq(m.schema.shopProducts.shopId, shopId.moline)).limit(1))[0];
    await as("michelle");
    expect(await inv.adjustStockAction({ shopId: shopId.moline, productId: sp.productId, mode: "add", qty: 2, reason: "found" })).toMatchObject({ ok: false, error: "That shop is outside your access" });
    expect(await settings.saveShopInfoAction(shopId.moline, {} as never)).toMatchObject({ ok: false, error: "That shop is outside your access" });
    expect(await settings.saveShopMoneyAction(shopId.coralville, {} as never)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) });
    const mine = (await m.db.db.select().from(m.schema.shopProducts).where(eq(m.schema.shopProducts.shopId, shopId.coralville)).limit(1))[0];
    expect(await inv.adjustStockAction({ shopId: shopId.coralville, productId: mine.productId, mode: "add", qty: 2, reason: "found" })).toMatchObject({ ok: true });
    await as("frontdesk");
    expect(await inv.adjustStockAction({ shopId: shopId.coralville, productId: mine.productId, mode: "add", qty: 2, reason: "found" })).toMatchObject({ ok: false });
  });

  it("the POS caps a manual discount at the person's limit", async () => {
    const { finalizeAction } = await import("@/app/admin/checkout/actions");
    const svc = (await m.catalog.shopCatalog(shopId.coralville)).find((s) => s.slug === "rayz-cut-shampoo")!;
    const sale = await m.checkout.openBlankSale(shopId.coralville, actor);
    const input = (pct: number) => ({
      saleId: sale.id,
      lines: [{ kind: "service" as const, refId: svc.id, qty: 1 }],
      promoCode: null,
      manualDiscount: { type: "percent" as const, value: pct, reason: "regular" },
      loyaltyRewardId: null,
      tipCents: 0,
      giftCard: null,
      tender: { method: "cash" as const, cashTenderedCents: null },
      expectedTotalCents: null as unknown as number,
      rebookInWeeks: null,
    });
    await as("frontdesk");
    expect(await finalizeAction(input(20))).toMatchObject({ ok: false, error: "Your discount limit is 10%" });
    expect(await finalizeAction(input(10))).toMatchObject({ ok: true });
  });
});

describe("permission changes", () => {
  const auditOf = (action: string, entityId: string) =>
    m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(m.drizzle.and(eq(m.schema.auditLog.action, action), eq(m.schema.auditLog.entityId, entityId)));

  it("a custom role applies at once and every change is audited", async () => {
    const perms = await import("@/app/admin/permissions/actions");
    await as("admin");
    const made = await perms.saveRoleAction({ id: null, name: "Lead Barber", description: "Senior chair", permissions: ["clients.rate", "clients.reveal", "report.my_sales.view", "report.sales_by_barber.view"], maxDiscountPct: 0, defaultScope: "selected" });
    expect(made).toMatchObject({ ok: true });
    const roleId = (made as { data: { id: string } }).data.id;
    expect((await auditOf("permissions.role_create", roleId))[0].details).toMatchObject({ name: "Lead Barber", added: expect.arrayContaining(["report.sales_by_barber.view"]) });

    const mk = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.makenna.id) }))!;
    const barberRole = mk.roleId;
    expect(await perms.saveUserAccessAction({ staffId: mk.id, roleId, overrides: { "pos.discount": true }, maxDiscountPct: 5, scope: "selected", shopIds: [shopId.coralville] })).toMatchObject({ ok: true });
    const log = (await auditOf("permissions.user_update", mk.id)).at(-1)!;
    expect(log.details).toMatchObject({ role: { from: "Barber", to: "Lead Barber" }, added: expect.arrayContaining(["report.sales_by_barber.view", "pos.discount"]), maxDiscountPct: { from: 0, to: 5 } });
    expect(log.actorStaffId).toBe(people.admin.id);

    await as("makenna");
    expect(await render("/admin/reports/barbers")).toBe("ok");
    expect(await render("/admin/reports/sales")).toBe("denied");

    await as("admin");
    expect(await perms.saveRoleAction({ id: roleId, name: "Lead Barber", permissions: ["clients.rate", "report.my_sales.view"], maxDiscountPct: 0, defaultScope: "selected" })).toMatchObject({ ok: true });
    expect((await auditOf("permissions.role_update", roleId))[0].details).toMatchObject({ removed: expect.arrayContaining(["report.sales_by_barber.view", "clients.reveal"]) });
    await as("makenna");
    expect(await render("/admin/reports/barbers")).toBe("denied");

    await as("admin");
    expect(await perms.deleteRoleAction(roleId)).toMatchObject({ ok: false, error: expect.stringMatching(/1 person has this role/) });
    expect(await perms.saveUserAccessAction({ staffId: mk.id, roleId: barberRole, overrides: {}, maxDiscountPct: null, scope: "selected", shopIds: [shopId.coralville] })).toMatchObject({ ok: true });
    expect(await perms.deleteRoleAction(roleId)).toMatchObject({ ok: true });
    expect(await auditOf("permissions.role_delete", roleId)).toHaveLength(1);
  }, 60_000);

  it("only the Brand Owner grants Brand Owner or brand-level settings", async () => {
    const perms = await import("@/app/admin/permissions/actions");
    const roles = await m.db.db.select().from(m.schema.roles);
    const ownerRole = roles.find((r) => r.key === "brand_owner")!;
    const adminRole = roles.find((r) => r.key === "brand_admin")!;
    await as("admin");
    expect(await perms.saveUserAccessAction({ staffId: people.michelle.id, roleId: ownerRole.id, overrides: {}, maxDiscountPct: null, scope: "all", shopIds: [] })).toMatchObject({ ok: false, error: "Only the Brand Owner can grant Brand Owner" });
    expect(await perms.saveUserAccessAction({ staffId: people.michelle.id, roleId: (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.michelle.id) }))!.roleId, overrides: { "settings.brand": true }, maxDiscountPct: null, scope: "one", shopIds: [shopId.coralville] })).toMatchObject({ ok: false });
    expect(await perms.saveRoleAction({ id: adminRole.id, name: adminRole.name, permissions: [...adminRole.permissions, "settings.brand"], maxDiscountPct: 100, defaultScope: "all" })).toMatchObject({ ok: false });
    expect(await perms.saveUserAccessAction({ staffId: people.owner.id, roleId: adminRole.id, overrides: {}, maxDiscountPct: null, scope: "all", shopIds: [] })).toMatchObject({ ok: false, error: "Only the Brand Owner can change a Brand Owner's access" });
    await as("owner");
    expect(await perms.saveUserAccessAction({ staffId: people.owner.id, roleId: adminRole.id, overrides: {}, maxDiscountPct: null, scope: "all", shopIds: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/your own access/) });
  });

  it("route handlers: catalog downloads and skipped-row files", async () => {
    const template = (await import("@/app/admin/catalog/template/route")).GET;
    const exp = (await import("@/app/admin/catalog/export/route")).GET as unknown as (r: Request) => Promise<Response>;
    await as("makenna");
    expect((await get(template, "/admin/catalog/template")).status).toBe(403);
    expect((await get(exp, "/admin/catalog/export")).status).toBe(403);
    await as("michelle");
    const t = await get(template, "/admin/catalog/template");
    expect(t.status).toBe(200);
    expect(t.text.split("\n")[0]).toContain("price_coralville");
    expect(t.text.split("\n")[0]).not.toContain("moline");
    const x = await get(exp, "/admin/catalog/export");
    expect(x.text.split("\n")[0]).not.toContain("moline");
    const xlsx = await template(new Request("http://localhost/admin/catalog/template?format=xlsx"));
    expect(xlsx.headers.get("content-type")).toMatch(/spreadsheetml/);
  });
});
