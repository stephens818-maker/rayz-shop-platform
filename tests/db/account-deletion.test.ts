/**
 * A client deleting their account (C10) and the pages the stores link to (C19): they see what
 * happens, confirm with a fresh code, and only their profile (with their children's) goes. The row
 * stays, anonymized, so past tickets still add up; sessions stop working; a later Squire import
 * can't bring the details back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let deleteRoute: typeof import("@/app/api/v1/me/delete/route");
let deleteStart: typeof import("@/app/api/v1/me/delete/start/route");
let meRoute: typeof import("@/app/api/v1/me/route");
let configRoute: typeof import("@/app/api/v1/app/config/route");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P,>(params: P) => ({ params: Promise.resolve(params) });
const row = (id: string) => m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, id) });

beforeAll(async () => {
  m = await loadModules();
  process.env.AUTH_DEV_CODES = "true";
  deleteRoute = await import("@/app/api/v1/me/delete/route");
  deleteStart = await import("@/app/api/v1/me/delete/start/route");
  meRoute = await import("@/app/api/v1/me/route");
  configRoute = await import("@/app/api/v1/app/config/route");
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("deleting an account", () => {
  it("shows what happens, needs a fresh code, and anonymizes only that family", async () => {
    const phone = "+13197770501";
    const mom = await m.customers.findOrCreateCustomer({ firstName: "Rosa", lastName: "Vale", phone, email: "rosa@fixture.test" }, null);
    const roommate = await m.customers.findOrCreateCustomer({ firstName: "Sam", lastName: "Ortiz", phone }, null);
    const fam = await import("@/server/family");
    const kid = await fam.addChild(mom.id, { firstName: "Tito", age: 8 }, actor);
    await m.db.db.insert(m.schema.customerSquireIds).values({ squireId: "SQ-DEL-1", customerId: mom.id, shopId: null });
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const svc = (await m.catalog.shopCatalog(shop.id, { onlineOnly: true })).find((s) => s.kind === "service")!;
    let startsAt: string | null = null;
    for (let d = 1; d <= 7 && !startsAt; d++) {
      const avail = await m.booking.getAvailability({ shopRef: shop.slug, date: m.time.addDays(m.time.todayLocal(), d), serviceId: svc.id });
      startsAt = avail.slots[0]?.startsAt ?? null;
    }
    const { accessToken } = await m.auth.issueTokens(mom.id, "phone");
    const auth = { authorization: `Bearer ${accessToken}` };
    const appt = await m.booking.createAppointment({
      shopRef: shop.slug,
      serviceId: svc.id,
      addonIds: [],
      barberRef: "any",
      startsAt: startsAt!,
      customerId: mom.id,
      customer: null,
      source: "api",
      notes: "Call me at 319-555-0101",
      idempotencyKey: null,
      actor,
    });

    const preview = await (await deleteRoute.GET(req("/api/v1/me/delete", { headers: auth }), ctx({}))).json();
    expect(preview).toMatchObject({ profile: { id: mom.id, firstName: "Rosa" }, dependents: [{ id: kid.id, firstName: "Tito" }], canDelete: true });
    expect(preview.consequences.join(" ")).toMatch(/Tito/);

    const wrong = await deleteRoute.POST(req("/api/v1/me/delete", { method: "POST", headers: auth, body: JSON.stringify({ code: "000000" }) }), ctx({}));
    expect(wrong.status).toBe(401);
    expect((await row(mom.id))?.deletedAt).toBeNull();

    const sent = await (await deleteStart.POST(req("/api/v1/me/delete/start", { method: "POST", headers: auth }), ctx({}))).json();
    const done = await deleteRoute.POST(req("/api/v1/me/delete", { method: "POST", headers: auth, body: JSON.stringify({ code: sent.devCode }) }), ctx({}));
    expect(await done.json()).toEqual({ deleted: true, profiles: 2 });

    const gone = await row(mom.id);
    expect(gone).toMatchObject({ firstName: "Deleted client", lastName: null, phone: null, email: null, notes: null, smsOptIn: false });
    expect(gone?.deletedAt).toBeInstanceOf(Date);
    expect((await row(kid.id))?.deletedAt).toBeInstanceOf(Date);
    expect(await row(roommate.id)).toMatchObject({ firstName: "Sam", phone, deletedAt: null });
    const a = await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, appt.id) });
    expect(a).toMatchObject({ status: "cancelled", notes: null });
    const tokens = await m.db.db.select().from(m.schema.refreshTokens).where(eq(m.schema.refreshTokens.customerId, mom.id));
    expect(tokens).toEqual([]);
    expect((await meRoute.GET(req("/api/v1/me", { headers: auth }), ctx({}))).status).toBe(401);
    const [log] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, mom.id));
    expect(log).toMatchObject({ action: "customer.deleted_by_client" });

    // A later Squire import of the same client doesn't bring the details back.
    const r = await m.importer.runImport("clients", "Client ID,First Name,Last Name,Phone,Email\nSQ-DEL-1,Rosa,Vale,(319) 777-0501,rosa@fixture.test\n", { dryRun: false, actor, filename: "clients.csv" });
    expect(r.inserted + r.updated).toBe(0);
    expect((await row(mom.id))?.phone).toBeNull();
  });

  it("a parent can delete just a child's profile; a membership has to be cancelled first", async () => {
    const parent = await m.customers.findOrCreateCustomer({ firstName: "Uma", phone: "+13197770502" }, null);
    const fam = await import("@/server/family");
    const kid = await fam.addChild(parent.id, { firstName: "Vera", age: 6 }, actor);
    const { accessToken } = await m.auth.issueTokens(parent.id, null);
    const auth = { authorization: `Bearer ${accessToken}` };
    const preview = await (await deleteRoute.GET(req(`/api/v1/me/delete?profileId=${kid.id}`, { headers: auth }), ctx({}))).json();
    expect(preview).toMatchObject({ profile: { id: kid.id }, dependents: [] });
    const sent = await m.auth.startDeletionCode(parent.id);
    await deleteRoute.POST(req("/api/v1/me/delete", { method: "POST", headers: auth, body: JSON.stringify({ code: sent.devCode, profileId: kid.id }) }), ctx({}));
    expect((await row(kid.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await row(parent.id))?.deletedAt).toBeNull();

    const stranger = await m.customers.findOrCreateCustomer({ firstName: "Wes", phone: "+13197770503" }, null);
    expect((await deleteRoute.GET(req(`/api/v1/me/delete?profileId=${stranger.id}`, { headers: auth }), ctx({}))).status).toBe(404);

    const [plan] = await m.db.db.select().from(m.schema.membershipPlans).limit(1);
    if (plan) {
      const shop = (await m.db.db.query.shops.findFirst())!;
      await m.db.db.insert(m.schema.memberships).values({ planId: plan.id, customerId: parent.id, homeShopId: shop.id, priceCents: 3000, currentPeriodStart: "2026-10-01", currentPeriodEnd: "2026-10-31" });
      const blocked = await (await deleteRoute.GET(req("/api/v1/me/delete", { headers: auth }), ctx({}))).json();
      expect(blocked).toMatchObject({ canDelete: false });
      const code = (await m.auth.startDeletionCode(parent.id)).devCode;
      const res = await deleteRoute.POST(req("/api/v1/me/delete", { method: "POST", headers: auth, body: JSON.stringify({ code }) }), ctx({}));
      expect(res.status).toBe(409);
    }
  });
});

describe("store links (C19)", () => {
  it("/app/config points at this site's privacy, terms, support and delete-account pages", async () => {
    const cfg = await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json();
    expect(cfg.links).toMatchObject({ privacy: expect.stringMatching(/\/privacy$/), terms: expect.stringMatching(/\/terms$/), support: expect.stringMatching(/\/support$/), deleteAccount: expect.stringMatching(/\/account\/delete$/) });
  });
});
