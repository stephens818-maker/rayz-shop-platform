/**
 * Report scope and dollar amounts on the server: reports and their CSVs without dollar amounts,
 * the QuickBooks journal behind them, every-shop reports for someone who works at one shop (and
 * nothing else widening with it), the Apprentice and Bookkeeper / Accountant templates, and App
 * switches behind App config, which only the Brand Owner grants.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let perms: typeof import("@/app/admin/permissions/actions");
let exportRoute: (r: Request) => Promise<Response>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const shop: Record<string, string> = {};
const who: Record<string, string> = {};

const roleOf = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!;
const csv = async (q: Record<string, string>, shops: string[] = []) => {
  const u = new URLSearchParams({ preset: "30d", ...q });
  for (const s of shops) u.append("shop", s);
  const res = await exportRoute(new Request(`http://localhost/admin/reports/export?${u}`));
  return { status: res.status, text: await res.text() };
};

async function person(label: string, roleKey: string, o: { scope: "all" | "one"; shopId?: string }) {
  const [s] = await m.db.db
    .insert(m.schema.staff)
    .values({ staffCode: `RS-${label}`, firstName: label, displayLabel: label, publicSlug: `rs-${label.toLowerCase()}`, roleId: (await roleOf(roleKey)).id, shopScope: o.scope, isBookable: false })
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
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

beforeAll(async () => {
  m = await loadModules();
  perms = await import("@/app/admin/permissions/actions");
  exportRoute = (await import("@/app/admin/reports/export/route")).GET;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const l of ["owner", "admin", "michelle"]) who[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("dollar amounts", () => {
  it("are hidden on the report page and in its CSV, and counts stay", async () => {
    await signInAs(who.michelle);
    const shown = await open("/admin/reports/sales");
    expect(shown.kind).toBe("ok");
    expect(shown.text).toMatch(/\$\d/);
    const shownCsv = await csv({ type: "sales_summary", table: "daily" });
    expect(shownCsv.status).toBe(200);

    await signInAs(who.admin);
    ok(await access(who.michelle, { overrides: { "reports.money": false } }));
    await signInAs(who.michelle);
    const page = await open("/admin/reports/sales");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Dollar amounts are hidden");
    expect(page.text).not.toMatch(/\$\d/);
    const hidden = await csv({ type: "sales_summary", table: "daily" });
    expect(hidden.status).toBe(200);
    const [head, ...rows] = hidden.text.trim().split("\n").map((l) => l.split(","));
    const [shownHead, ...shownRows] = shownCsv.text.trim().split("\n").map((l) => l.split(","));
    expect(head).toEqual(shownHead);
    const tickets = head.indexOf("Tickets");
    const gross = head.findIndex((h) => /Gross|Net sales/.test(h));
    expect(tickets).toBeGreaterThan(-1);
    expect(gross).toBeGreaterThan(-1);
    expect(rows.map((r) => r[tickets])).toEqual(shownRows.map((r) => r[tickets]));
    expect(rows.every((r) => r[gross] === "")).toBe(true);
    expect(shownRows.some((r) => r[gross] !== "")).toBe(true);

    await signInAs(who.admin);
    ok(await access(who.michelle));
  });

  it("the QuickBooks journal needs them", async () => {
    const bea = await person("Bea", "bookkeeper", { scope: "all" });
    await signInAs(bea);
    expect((await csv({ type: "sales_summary", table: "quickbooks" })).status).toBe(200);
    await signInAs(who.owner);
    ok(await access(bea, { overrides: { "reports.money": false } }));
    await signInAs(bea);
    expect((await csv({ type: "sales_summary", table: "quickbooks" })).status).not.toBe(200);
  });
});

describe("every-shop reports", () => {
  it("cover every shop for someone who works at one, and nothing else widens", async () => {
    const dee = await person("Dee", "shop_manager", { scope: "one", shopId: shop.coralville });
    await signInAs(dee);
    expect((await csv({ type: "sales_summary", table: "summary" }, [shop.moline])).status).toBe(403);

    await signInAs(who.admin);
    ok(await access(dee, { overrides: { "reports.all_shops": true, "report.audit_log.view": true, "report.audit_log.export": true } }));
    await signInAs(dee);
    const moline = await csv({ type: "sales_summary", table: "summary" }, [shop.moline]);
    expect(moline.status).toBe(200);
    const all = await csv({ type: "sales_summary", table: "summary", view: "shops", shop: "all" });
    expect(all.status).toBe(200);
    expect(all.text).toContain("Moline");
    expect(all.text).toContain("Coralville");
    expect((await csv({ type: "audit_log" }, [shop.moline])).status).toBe(403);
    expect((await csv({ type: "audit_log" }, [shop.coralville])).status).toBe(200);
    const ctx = (await (await import("@/server/report-builder/context")).staffContextFor(dee))!;
    expect(ctx.shopIds).toEqual([shop.coralville]);
    expect(ctx.brandWide).toBe(false);
  });

  it("a Bookkeeper / Accountant at one shop still reports on all of them", async () => {
    const bo = await person("Bo", "bookkeeper", { scope: "one", shopId: shop.coralville });
    await signInAs(bo);
    expect((await csv({ type: "sales_summary", table: "summary" }, [shop.moline])).status).toBe(200);
    expect((await csv({ type: "card_fees" }, [shop.kimberly])).status).toBe(200);
  });

  it("are never on a shop login", async () => {
    const login = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "coralville@rayz.test") }))!;
    expect(login.kind).toBe("shop");
    const ctx = (await (await import("@/server/report-builder/context")).staffContextFor(login.id))!;
    expect(ctx.permissions.has("reports.all_shops")).toBe(false);
  });
});

describe("Apprentice", () => {
  it("sees their own sales without dollar amounts and can't download them", async () => {
    const abe = await person("Abe", "apprentice", { scope: "one", shopId: shop.coralville });
    await signInAs(abe);
    const mine = await open("/admin/reports/my-sales");
    expect(mine.kind).toBe("ok");
    expect(mine.text).toContain("Dollar amounts are hidden");
    expect(mine.text).not.toMatch(/\$\d/);
    expect((await csv({ type: "my_sales" })).status).toBe(403);
    expect((await open("/admin/reports/sales")).kind).toBe("denied");
  });

  it("View as shows the report scope and whether dollar amounts show", async () => {
    await signInAs(who.admin);
    const apprentice = await open("/admin/permissions/view-as", {}, { as: `role:${(await roleOf("apprentice")).id}` });
    expect(apprentice.text).toMatch(/Scope: Own numbers/);
    expect(apprentice.text).toMatch(/Dollar amounts: Hidden/);
    const book = await open("/admin/permissions/view-as", {}, { as: `role:${(await roleOf("bookkeeper")).id}` });
    expect(book.text).toMatch(/Scope: All shops/);
    expect(book.text).toMatch(/Dollar amounts: Shown/);
  });
});

describe("App config", () => {
  it("App switches need it, and only the Brand Owner gives it", async () => {
    await signInAs(who.admin);
    expect((await open("/admin/app-switches")).kind).toBe("denied");
    expect(await brandAction("app", "switches", { family: false })).toMatchObject({ ok: false });
    const cal = await person("Cal", "regional_manager", { scope: "all" });
    expect(await access(cal, { overrides: { "settings.app": true } })).toMatchObject({ ok: false });

    await signInAs(who.owner);
    ok(await access(who.admin, { overrides: { "settings.app": true } }));
    await signInAs(who.admin);
    expect((await open("/admin/app-switches")).kind).toBe("ok");
    ok(await brandAction("app", "switches", { family: false }));
    ok(await brandAction("app", "switches", { family: true }));
    const [log] = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(m.drizzle.and(eq(m.schema.auditLog.actorStaffId, who.owner), eq(m.schema.auditLog.entityId, who.admin)))
      .orderBy(m.drizzle.desc(m.schema.auditLog.at))
      .limit(1);
    expect(JSON.stringify(log?.details ?? {})).toContain("settings.app");

    await signInAs(who.owner);
    ok(await access(who.admin));
  });
});
