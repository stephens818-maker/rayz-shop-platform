/**
 * A shop login is the front desk's POS (Charles, Oct 28, as in Squire): calendar, check-in, checkout,
 * clients, the time clock, We have openings and its shop's reports. Settings, the menu, staff, roles,
 * payroll, tip payouts, the Campaign Center and integrations stay the brand's, whatever the login's
 * role, unless the brand allows one for that login.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { open, propsOf } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let perms: typeof import("@/app/admin/permissions/actions");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
const shopBy = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;
const as = async (email: string) => signInAs((await staffBy(email)).id);

async function access(staffId: string, patch: Partial<Parameters<typeof perms.saveUserAccessAction>[0]> = {}) {
  const a = (await (await import("@/server/auth/access")).loadStaffAccess(staffId))!;
  const row = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, staffId) }))!;
  return perms.saveUserAccessAction({
    staffId,
    roleId: a.role.id,
    overrides: (row.permissionOverrides ?? {}) as Record<string, boolean>,
    maxDiscountPct: null,
    scope: a.scope,
    scopeEntityId: a.scopeEntityId,
    scopeRegionId: a.scopeRegionId,
    shopIds: a.scope === "all" ? [] : a.shopIds,
    shopRoles: a.shopRoles,
    ...patch,
  });
}

const BRAND_PAGES = [
  "/admin/settings",
  "/admin/services",
  "/admin/staff",
  "/admin/permissions",
  "/admin/payroll/report",
  "/admin/tips/settings",
  "/admin/campaign-center",
  "/admin/brand-defaults",
  "/admin/sync-status",
  "/admin/import",
];
const FRONT_DESK = ["/admin", "/admin/calendar", "/admin/sales", "/admin/customers", "/admin/walk-ins", "/admin/clock/kiosk", "/admin/campaign-center/openings", "/admin/reports"];

beforeAll(async () => {
  m = await loadModules();
  perms = await import("@/app/admin/permissions/actions");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("shop login: the front desk's POS", () => {
  it("opens the front desk and none of the brand's pages", async () => {
    await as("coralville@rayz.test");
    for (const page of FRONT_DESK) expect((await open(page)).kind, page).toBe("ok");
    for (const page of BRAND_PAGES) expect((await open(page)).kind, page).not.toBe("ok");
  }, 120_000);

  it("stays a front desk even on the Shop Manager role", async () => {
    const desk = await staffBy("coralville@rayz.test");
    const manager = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "shop_manager") }))!;
    await as("owner@rayz.test");
    ok(await access(desk.id, { roleId: manager.id }));
    try {
      await as("coralville@rayz.test");
      for (const page of BRAND_PAGES.filter((p) => p !== "/admin/staff")) expect((await open(page)).kind, page).not.toBe("ok");
      const held = (await (await import("@/server/auth/access")).loadStaffAccess(desk.id))!.permissions;
      for (const p of ["staff.manage", "schedules.edit", "settings.shop", "catalog.prices", "campaign_center.send"] as const) expect(held.has(p), p).toBe(false);
      expect(held.has("checkout.any")).toBe(true);
      expect((await open("/admin/calendar")).kind).toBe("ok");
    } finally {
      await as("owner@rayz.test");
      ok(await access(desk.id, { roleId: desk.roleId! }));
    }
  }, 120_000);

  it("only the brand can allow a brand-controlled permission for one shop login", async () => {
    const desk = await staffBy("coralville@rayz.test");
    const michelle = await staffBy("michelle@rayz.test");
    await as("owner@rayz.test");
    ok(await access(michelle.id, { overrides: { ...michelle.permissionOverrides, "permissions.manage": true, "settings.shop_hours": true } }));
    try {
      await as("michelle@rayz.test");
      expect(await access(desk.id, { overrides: { "settings.shop_hours": true } })).toMatchObject({ ok: false, error: expect.stringMatching(/set by the brand/) });

      await as("owner@rayz.test");
      ok(await access(desk.id, { overrides: { "settings.shop_hours": true } }));
      await as("coralville@rayz.test");
      expect((await open("/admin/settings")).kind).toBe("ok");
      expect((await open("/admin/services")).kind).not.toBe("ok");

      await as("michelle@rayz.test");
      expect(await access(desk.id, { overrides: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/set by the brand/) });
    } finally {
      await as("owner@rayz.test");
      ok(await access(desk.id, { overrides: {} }));
      ok(await access(michelle.id, { overrides: michelle.permissionOverrides ?? {} }));
    }
    await as("coralville@rayz.test");
    expect((await open("/admin/settings")).kind).not.toBe("ok");
  }, 120_000);

  it("the desk's home is today's clients, the checkout queue and big buttons; other people keep the dashboard", async () => {
    await as("coralville@rayz.test");
    const desk = await open("/admin");
    expect(desk.kind).toBe("ok");
    const text = desk.kind === "ok" ? desk.text : "";
    for (const s of ["Today's clients", "Ready to check out", "New sale"]) expect(text, s).toContain(s);
    await as("owner@rayz.test");
    const owner = await open("/admin");
    expect(owner.kind === "ok" ? owner.text : "").not.toContain("Ready to check out");
  }, 120_000);

  it("checks a client in from the home, then offers checkout", async () => {
    const { DeskClientRow } = await import("@/app/admin/front-desk-row");
    const { setStatusAction } = await import("@/app/admin/calendar/actions");
    const cv = await shopBy("coralville");
    const barber = await staffBy("makenna@rayz.test");
    const customer = (await m.db.db.query.customers.findFirst())!;
    const startsAt = new Date(Math.max(m.time.startOfLocalDay(m.time.todayLocal()).getTime() + 60_000, Date.now() - 10 * 60_000));
    const [appt] = await m.db.db
      .insert(m.schema.appointments)
      .values({
        code: `DESK${Date.now() % 100000}`,
        shopId: cv.id,
        staffId: barber.id,
        customerId: customer.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: "booked",
        source: "staff",
        estimateCents: 2300,
      })
      .returning();
    try {
      await as("coralville@rayz.test");
      type Row = { id: string; step: string | null };
      const row = async () => (await propsOf<Row>(DeskClientRow, "/admin")).find((r) => r.id === appt.id);
      expect((await row())?.step).toBe("check_in");
      ok(await setStatusAction(appt.id, "checked_in"));
      expect((await row())?.step).toBe("check_out");
    } finally {
      await m.db.db.delete(m.schema.appointments).where(eq(m.schema.appointments.id, appt.id));
    }
  }, 120_000);

  it("after payment the receipt offers the next client", async () => {
    const cv = await shopBy("coralville");
    const sale = (await m.db.db.query.sales.findFirst({ where: m.drizzle.and(eq(m.schema.sales.shopId, cv.id), eq(m.schema.sales.status, "paid")) }))!;
    await as("coralville@rayz.test");
    const desk = await open("/admin/sales/[id]", { id: sale.id }, { done: "1" });
    expect(desk.kind === "ok" ? desk.text : "").toContain("Next client");
    await as("owner@rayz.test");
    const owner = await open("/admin/sales/[id]", { id: sale.id }, { done: "1" });
    expect(owner.kind === "ok" ? owner.text : "missing").not.toContain("Next client");
  }, 120_000);
});
