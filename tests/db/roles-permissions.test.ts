/**
 * The roles and permissions system on the server: voids apart from refunds, dollar limits on
 * refunds, voids and discounts with manager approval above them, temporary overrides, region scope
 * kept in step with the region, owner entity roles, the Bookkeeper and Marketing templates, the
 * QuickBooks gate, the calendar's all-barbers view, and who can open the matrix and "view as".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let perms: typeof import("@/app/admin/permissions/actions");
let sales: typeof import("@/app/admin/sales/actions");
let checkout: typeof import("@/app/admin/checkout/actions");
let exportRoute: (r: Request) => Promise<Response>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const shop: Record<string, string> = {};
const who: Record<string, string> = {};
const region: Record<string, string> = {};

const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
const roleOf = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!;
const as = (id: string) => signInAs(id);
const accessShops = async (id: string) =>
  (await m.db.db.select({ shopId: m.schema.staffAccessShops.shopId }).from(m.schema.staffAccessShops).where(eq(m.schema.staffAccessShops.staffId, id))).map((r) => r.shopId).sort();
const get = async (handler: (req: Request) => Promise<Response>, url: string) => {
  const res = await handler(new Request(`http://localhost${url}`));
  return { status: res.status, text: await res.text() };
};
const lastAudit = async (action: string, entityId: string) =>
  (
    await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(m.drizzle.and(eq(m.schema.auditLog.action, action), eq(m.schema.auditLog.entityId, entityId)))
      .orderBy(m.drizzle.desc(m.schema.auditLog.at))
      .limit(1)
  )[0];

async function person(label: string, roleKey: string, o: { scope: "all" | "one"; shopId?: string }) {
  const [s] = await m.db.db
    .insert(m.schema.staff)
    .values({ staffCode: `RP-${label}`, firstName: label, displayLabel: label, publicSlug: `rp-${label.toLowerCase()}`, roleId: (await roleOf(roleKey)).id, shopScope: o.scope, isBookable: false })
    .returning();
  if (o.shopId) await m.db.db.insert(m.schema.staffAccessShops).values({ staffId: s.id, shopId: o.shopId });
  return s.id;
}

/** What the people editor sends for someone as they are now, with changes on top. */
async function access(staffId: string, patch: Partial<Parameters<typeof perms.saveUserAccessAction>[0]> = {}) {
  const a = (await (await import("@/server/auth/access")).loadStaffAccess(staffId))!;
  return perms.saveUserAccessAction({
    staffId,
    roleId: a.role.id,
    overrides: {},
    maxDiscountPct: null,
    scope: a.scope,
    scopeEntityId: a.scopeEntityId,
    scopeRegionId: a.scopeRegionId,
    shopIds: a.scope === "all" ? [] : a.shopIds,
    shopRoles: a.shopRoles,
    ...patch,
  });
}

const CUT = async () => (await m.catalog.shopCatalog(shop.coralville)).find((s) => s.slug === "rayz-cut-shampoo")!;
const ticket = async (saleId: string, discountPct = 0) => ({
  saleId,
  lines: [{ kind: "service" as const, refId: (await CUT()).id, qty: 1 }],
  promoCode: null,
  manualDiscount: discountPct ? { type: "percent" as const, value: discountPct, reason: "regular" } : null,
  loyaltyRewardId: null,
  tipCents: 0,
  giftCard: null,
  tender: { method: "cash" as const, cashTenderedCents: null },
  expectedTotalCents: null as unknown as number,
  rebookInWeeks: null,
});
/** A $23 cash ticket at Coralville, rung up by the front desk. */
async function cashSale() {
  await as(who.frontdesk);
  const sale = await m.checkout.openBlankSale(shop.coralville, actor);
  ok(await checkout.finalizeAction(await ticket(sale.id)));
  const items = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, sale.id));
  return { id: sale.id, refund: { saleId: sale.id, items: items.map((i) => ({ saleItemId: i.id, qty: i.qty })), tipCents: 0, refundCardFee: false, reason: "Wrong service", restock: false } };
}

beforeAll(async () => {
  m = await loadModules();
  perms = await import("@/app/admin/permissions/actions");
  sales = await import("@/app/admin/sales/actions");
  checkout = await import("@/app/admin/checkout/actions");
  exportRoute = (await import("@/app/admin/reports/export/route")).GET;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const r of await m.db.db.select().from(m.schema.regions)) region[r.slug] = r.id;
  for (const l of ["owner", "admin", "michelle", "frontdesk", "makenna"]) who[l] = (await staffBy(`${l}@rayz.test`)).id;
  const tc = await import("@/server/time-clock");
  await tc.setPin(who.admin, "1357", actor);
  await tc.setPin(who.frontdesk, "2468", actor);
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("templates", () => {
  it("has every built-in role, Apprentice, Bookkeeper and Marketing included, under the brand's names", async () => {
    const roles = await m.db.db.select().from(m.schema.roles);
    const names = Object.fromEntries(roles.filter((r) => r.key).map((r) => [r.key, r.name]));
    expect(names).toMatchObject({
      brand_owner: "Brand Owner",
      brand_admin: "Brand Admin",
      regional_manager: "Regional / District Manager",
      shop_manager: "Shop Manager",
      front_desk: "Front Desk",
      barber: "Barber",
      apprentice: "Apprentice",
      bookkeeper: "Bookkeeper / Accountant",
      marketing: "Marketing",
    });
  });
});

describe("refunds, voids and dollar limits", () => {
  it("voiding is its own permission: without it, a manager approves with their PIN", async () => {
    const s = await cashSale();
    await as(who.admin);
    ok(await access(who.michelle, { overrides: { "sales.void": false } }));
    await as(who.michelle);
    expect(await sales.voidAction(s.id, "Rang up twice")).toMatchObject({ ok: false, error: "A manager's PIN is needed for voids" });
    expect(await sales.voidAction(s.id, "Rang up twice", { staffId: who.admin, pin: "0000" })).toMatchObject({ ok: false });
    ok(await sales.voidAction(s.id, "Rang up twice", { staffId: who.admin, pin: "1357" }));
    expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, s.id) }))!.status).toBe("voided");
    await as(who.admin);
    ok(await access(who.michelle));
  });

  it("a refund above the person's limit needs a manager whose own limit covers it", async () => {
    const s = await cashSale();
    await as(who.admin);
    ok(await access(who.michelle, { moneyLimits: { refundCents: 500 } }));
    ok(await access(who.frontdesk, { overrides: { "sales.refund": true }, moneyLimits: { refundCents: 100 } }));
    expect((await lastAudit("permissions.user_update", who.michelle)).details).toMatchObject({ moneyLimits: { from: "Role's", to: "Refund or void $5" } });

    await as(who.michelle);
    expect(await sales.refundAction(s.refund)).toMatchObject({ ok: false, error: expect.stringMatching(/above your \$5 limit/) });
    expect(await sales.refundAction(s.refund, { staffId: who.frontdesk, pin: "2468" })).toMatchObject({ ok: false, error: expect.stringMatching(/the most you and the approving manager can give back/) });
    ok(await sales.refundAction(s.refund, { staffId: who.admin, pin: "1357" }));
    const [refund] = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, s.id));
    expect(refund.approvedBy).toBe(who.admin);

    await as(who.admin);
    ok(await access(who.michelle));
    ok(await access(who.frontdesk));
  });

  it("a manual discount is capped in dollars as well as percent", async () => {
    const limit = Math.round((await CUT()).priceCents * 0.05);
    await as(who.admin);
    ok(await access(who.frontdesk, { moneyLimits: { discountCents: limit } }));
    await as(who.frontdesk);
    const sale = await m.checkout.openBlankSale(shop.coralville, actor);
    expect(await checkout.finalizeAction(await ticket(sale.id, 10))).toMatchObject({ ok: false, error: `Your discount limit is $${(limit / 100).toFixed(2)} a ticket` });
    ok(await checkout.finalizeAction(await ticket(sale.id, 4)));
    await as(who.admin);
    ok(await access(who.frontdesk));
  });

  it("nobody gives a limit above their own", async () => {
    await as(who.owner);
    ok(await access(who.admin, { moneyLimits: { refundCents: 1000 } }));
    await as(who.admin);
    ok(await access(who.michelle, { moneyLimits: { refundCents: 800 } }));
    expect(await access(who.michelle, { moneyLimits: { refundCents: 2000 } })).toMatchObject({ ok: false, error: expect.stringMatching(/refund or void limit above your own \(\$10\)/) });
    expect(await access(who.michelle, { moneyLimits: { refundCents: null } })).toMatchObject({ ok: false, error: expect.stringMatching(/above your own/) });
    expect(await access(who.michelle, { moneyLimits: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/above your own/) });
    await as(who.owner);
    ok(await access(who.admin));
    await as(who.admin);
    ok(await access(who.michelle));
  });
});

describe("temporary access", () => {
  it("an override with an end date counts through that day, then stops", async () => {
    const today = m.time.todayLocal();
    await as(who.admin);
    ok(await access(who.frontdesk, { overrides: { "report.gift_cards.view": true }, expires: { "report.gift_cards.view": today } }));
    expect((await lastAudit("permissions.user_update", who.frontdesk)).details).toMatchObject({
      overrideChanges: { "report.gift_cards.view": { from: "role default", to: `allow until ${today}` } },
    });
    await as(who.frontdesk);
    expect((await open("/admin/reports/gift-cards")).kind).toBe("ok");

    await m.db.db.update(m.schema.staff).set({ permissionOverrideExpires: { "report.gift_cards.view": m.time.addDays(today, -1) } }).where(eq(m.schema.staff.id, who.frontdesk));
    expect((await open("/admin/reports/gift-cards")).kind).toBe("denied");

    await as(who.admin);
    ok(await access(who.frontdesk, { overrides: { "report.gift_cards.view": true }, expires: { "report.gift_cards.view": m.time.addDays(today, -1) } }));
    expect((await staffBy("frontdesk@rayz.test")).permissionOverrides).toEqual({});
    ok(await access(who.frontdesk));
  });
});

describe("region scope", () => {
  it("covers the region's shops, follows shops moving in and out, and keeps the region from being deleted", async () => {
    const regions = await import("@/server/regions");
    const reggie = await person("Reggie", "regional_manager", { scope: "one", shopId: shop.moline });
    await as(who.admin);
    expect(await access(reggie, { scope: "region", scopeRegionId: null })).toMatchObject({ ok: false, error: "Pick the region" });
    ok(await access(reggie, { scope: "region", scopeRegionId: region["eastern-iowa"] }));
    expect(await accessShops(reggie)).toEqual([shop.coralville, shop.dubuque].sort());
    expect((await lastAudit("permissions.user_update", reggie)).details).toMatchObject({ scope: { from: "one", to: "region" }, scopeRegion: { from: null, to: region["eastern-iowa"] } });

    await regions.setShopRegion(actor, shop.utica, region["eastern-iowa"]);
    expect(await accessShops(reggie)).toContain(shop.utica);
    await regions.setShopRegion(actor, shop.utica, region["quad-cities"]);
    expect(await accessShops(reggie)).not.toContain(shop.utica);

    await expect(regions.deleteRegion(actor, region["eastern-iowa"])).rejects.toThrow(/access covers this region's shops/);
    ok(await access(reggie, { scope: "one", scopeRegionId: null, shopIds: [shop.moline] }));
  });
});

describe("owner entity roles", () => {
  it("a franchisee's own role is only for that owner's shops", async () => {
    const [fr] = await m.db.db.insert(m.schema.ownerEntities).values({ name: "QC Franchise Group", kind: "franchisee" }).returning();
    await m.db.db.update(m.schema.shops).set({ ownerEntityId: fr.id }).where(eq(m.schema.shops.id, shop.silvis));
    const roleId = crypto.randomUUID();
    await as(who.admin);
    ok(await brandAction("role", roleId, { name: "Franchise Lead", permissions: ["checkout.any", "sales.view"], maxDiscountPct: 0, defaultScope: "one", ownerEntityId: fr.id }));
    expect((await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.id, roleId) }))!.ownerEntityId).toBe(fr.id);

    const fran = await person("Fran", "barber", { scope: "one", shopId: shop.coralville });
    expect(await access(fran, { roleId, scope: "one", shopIds: [shop.coralville] })).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to another owner/) });
    expect(await access(fran, { roleId, scope: "all", shopIds: [] })).toMatchObject({ ok: false });
    ok(await access(fran, { roleId, scope: "one", shopIds: [shop.silvis] }));

    const brandRole = (await roleOf("front_desk")).id;
    expect(await brandAction("role", brandRole, { name: "Front Desk", permissions: [], maxDiscountPct: 0, defaultScope: "one", ownerEntityId: fr.id })).toMatchObject({ ok: false });
  });
});

describe("Bookkeeper and Marketing", () => {
  let customer: { id: string; email: string; phone: string };
  beforeAll(async () => {
    const [c] = await m.db.db
      .select()
      .from(m.schema.customers)
      .where(m.drizzle.and(m.drizzle.isNotNull(m.schema.customers.email), m.drizzle.isNotNull(m.schema.customers.phone), eq(m.schema.customers.homeShopId, shop.coralville)))
      .limit(1);
    customer = { id: c.id, email: c.email!, phone: c.phone! };
  });

  it("Bookkeeper: reports and the QuickBooks journal, but no checkout, refunds, client contact or settings", async () => {
    const bea = await person("Bea", "bookkeeper", { scope: "all" });
    const clients = (await import("@/app/admin/customers/export/route")).GET;
    await as(bea);
    expect((await open("/admin/reports/sales")).kind).toBe("ok");
    expect((await get(exportRoute, "/admin/reports/export?type=sales_summary&table=quickbooks&preset=30d")).status).toBe(200);
    expect((await get(clients, "/admin/customers/export")).status).toBe(403);
    expect((await open("/admin/permissions")).kind).toBe("denied");
    expect((await open("/admin/settings")).kind).toBe("denied");
    const page = await open("/admin/customers/[id]", { id: customer.id });
    if (page.kind === "ok") {
      expect(page.text).not.toContain(customer.email);
      expect(page.text).not.toContain(customer.phone);
    }
    const blank = await m.checkout.openBlankSale(shop.coralville, actor);
    expect(await checkout.finalizeAction(await ticket(blank.id))).toMatchObject({ ok: false, error: "You can only check out your own clients" });
    const s = await cashSale();
    await as(bea);
    expect(await sales.refundAction(s.refund)).toMatchObject({ ok: false, error: "A manager's PIN is needed for refunds" });

    await as(who.michelle);
    expect((await get(exportRoute, "/admin/reports/export?type=sales_summary&table=quickbooks&preset=30d")).status).not.toBe(200);
  });

  it("Marketing: the Campaign Center, without client lists or contact details", async () => {
    const mia = await person("Mia", "marketing", { scope: "all" });
    const clients = (await import("@/app/admin/customers/export/route")).GET;
    const audience = (await import("@/app/admin/campaign-center/export/route")).GET;
    await as(mia);
    expect((await open("/admin/campaign-center")).kind).toBe("ok");
    expect((await get(audience, "/admin/campaign-center/export")).status).toBe(403);
    expect((await get(clients, "/admin/customers/export")).status).toBe(403);
    expect((await open("/admin/sales")).kind).toBe("denied");
    const page = await open("/admin/customers/[id]", { id: customer.id });
    if (page.kind === "ok") {
      expect(page.text).not.toContain(customer.email);
      expect(page.text).not.toContain(customer.phone);
    }
  });
});

describe("calendar: own column or every barber's", () => {
  it("a barber with all barbers: view sees every column, read-only; managers can change them", async () => {
    const { DayCalendar } = await import("@/app/admin/calendar/day-calendar");
    let date = m.time.todayLocal();
    while (m.time.weekdayOf(date) !== 2) date = m.time.addDays(date, 1);
    const seen = async () => {
      let props: Record<string, unknown> | null = null;
      const r = await open("/admin/calendar", {}, { date, shop: shop.coralville }, (type, p) => {
        if (type === DayCalendar) props = p;
      });
      expect(r.kind).toBe("ok");
      const p = props as unknown as { othersReadOnly: boolean; data: { columns: { id: string }[] } };
      return { readOnly: p.othersReadOnly, columns: p.data.columns.map((c) => c.id) };
    };
    await as(who.makenna);
    expect((await seen()).columns).toEqual([who.makenna]);
    await as(who.admin);
    ok(await access(who.makenna, { overrides: { "calendar.view_all": true } }));
    await as(who.makenna);
    const all = await seen();
    expect(all.columns.length).toBeGreaterThan(1);
    expect(all.readOnly).toBe(true);
    await as(who.frontdesk);
    expect((await seen()).readOnly).toBe(false);
    await as(who.admin);
    ok(await access(who.makenna));
  });
});

describe("matrix, view as and effective permissions", () => {
  it("only people who manage permissions open them", async () => {
    for (const id of [who.frontdesk, who.michelle, who.makenna]) {
      await as(id);
      expect((await open("/admin/permissions/matrix")).kind).toBe("denied");
      expect((await open("/admin/permissions/view-as")).kind).toBe("denied");
    }
    await as(who.admin);
    const matrix = await open("/admin/permissions/matrix");
    expect(matrix.kind).toBe("ok");
    expect(matrix.text).toContain("Regional / District Manager");
    expect(matrix.text).toContain("Bookkeeper");
  });

  it("view as a role or a person shows their menu and what they see of clients", async () => {
    const { AccessBreakdown } = await import("@/components/access-breakdown");
    const book = await roleOf("bookkeeper");
    await as(who.admin);
    const role = await open("/admin/permissions/view-as", {}, { as: `role:${book.id}` });
    expect(role.kind).toBe("ok");
    expect(role.text).toMatch(/Viewing as\s+Bookkeeper/);
    expect(role.text).toContain("Reports");

    let columns: { held: string[]; label: string }[] = [];
    const person = await open("/admin/permissions/view-as", {}, { as: `staff:${who.makenna}`, shop: shop.coralville }, (type, p) => {
      if (type === AccessBreakdown) columns = p.columns as typeof columns;
    });
    expect(person.kind).toBe("ok");
    expect(columns).toHaveLength(1);
    expect(columns[0].held).not.toContain("checkout.any");
    expect(columns[0].held).not.toContain("calendar.view_all");
  });

  it("the person page shows their effective permissions shop by shop, with temporary overrides", async () => {
    const { AccessBreakdown } = await import("@/components/access-breakdown");
    const kat = await staffBy("kat@rayz.test");
    const until = m.time.addDays(m.time.todayLocal(), 7);
    await as(who.admin);
    ok(await access(kat.id, { overrides: { "pos.discount": true }, expires: { "pos.discount": until } }));
    type Props = { columns: { label: string; role: string; held: string[] }[]; expires: Record<string, string> };
    const seen: Props[] = [];
    const page = await open("/admin/permissions/people/[id]", { id: kat.id }, {}, (type, p) => {
      if (type === AccessBreakdown) seen.push(p as unknown as Props);
    });
    expect(page.kind).toBe("ok");
    const g = seen[0]!;
    expect(g.columns.length).toBeGreaterThan(1);
    expect(new Set(g.columns.map((c) => c.role))).toEqual(new Set(["Barber", "Shop Manager"]));
    expect(g.expires).toEqual({ "pos.discount": until });
    for (const c of g.columns) expect(c.held).toContain("pos.discount");
    ok(await access(kat.id));
  });
});
