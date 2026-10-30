/**
 * The customer app's first endpoints against a real database: a shop still booking on its old site
 * (bookingMode external) shows its link and refuses online bookings here while the desk keeps
 * booking; the client's own preferences note stays apart from the staff note and loses card numbers
 * and contact details; an app build below the minimum version gets 426 on every route but the config.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let token: string;
let jordanId: string;
let shopRoute: typeof import("@/app/api/v1/shops/[shop]/route");
let shopsRoute: typeof import("@/app/api/v1/shops/route");
let meRoute: typeof import("@/app/api/v1/me/route");
let configRoute: typeof import("@/app/api/v1/app/config/route");
let apptRoute: typeof import("@/app/api/v1/appointments/route");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P,>(params: P) => ({ params: Promise.resolve(params) });

beforeAll(async () => {
  m = await loadModules();
  shopRoute = await import("@/app/api/v1/shops/[shop]/route");
  shopsRoute = await import("@/app/api/v1/shops/route");
  meRoute = await import("@/app/api/v1/me/route");
  configRoute = await import("@/app/api/v1/app/config/route");
  apptRoute = await import("@/app/api/v1/appointments/route");
  jordanId = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, "+13195550100") }))!.id;
  token = (await m.auth.issueTokens(jordanId, null)).accessToken;
});

afterAll(async () => {
  await m.db.db.update(m.schema.shops).set({ bookingMode: "platform", externalBookingUrl: null });
  for (const k of ["APP_IOS_MIN_VERSION", "APP_IOS_STORE_URL", "APP_MAINTENANCE_MESSAGE"]) delete process.env[k];
});

describe("a shop still booking on its old site", () => {
  it("can't be set to external without an https link", async () => {
    await expect(m.db.db.update(m.schema.shops).set({ bookingMode: "external" }).where(eq(m.schema.shops.slug, "moline"))).rejects.toThrow();
    await expect(
      m.db.db.update(m.schema.shops).set({ bookingMode: "external", externalBookingUrl: "http://old.example.com" }).where(eq(m.schema.shops.slug, "moline")),
    ).rejects.toThrow();
  });

  it("shows its link, refuses online bookings here, and the desk still books it", async () => {
    await m.db.db.update(m.schema.shops).set({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-moline" }).where(eq(m.schema.shops.slug, "moline"));
    const shop = await (await shopRoute.GET(req("/api/v1/shops/moline"), ctx({ shop: "moline" }))).json();
    expect(shop).toMatchObject({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-moline", bookingEnabled: false });
    const list = (await (await shopsRoute.GET(req("/api/v1/shops"), ctx({}))).json()).shops as { slug: string; bookingMode: string; externalBookingUrl: string | null }[];
    expect(list.find((s) => s.slug === "coralville")).toMatchObject({ bookingMode: "platform", externalBookingUrl: null });

    const moline = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "moline") }))!;
    const svc = (await m.catalog.shopCatalog(moline.id, { onlineOnly: true })).find((s) => s.kind === "service")!;
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(16, 0, 0, 0);
    const res = await apptRoute.POST(
      req("/api/v1/appointments", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ shopId: "moline", serviceId: svc.id, startsAt: start.toISOString() }) }),
      ctx({}),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/Online booking is turned off/);

    const avail = await m.booking.getAvailability({ shopRef: "moline", date: m.time.addDays(m.time.todayLocal(), 2), serviceId: svc.id, staffOverride: true });
    expect(avail.reason ?? "").not.toMatch(/Online booking/);
  });
});

describe("the client's own preferences note", () => {
  it("is saved apart from the staff note, scrubbed and contact-redacted, with a preferred barber", async () => {
    await m.db.db.update(m.schema.customers).set({ notes: "Staff: tips well" }).where(eq(m.schema.customers.id, jordanId));
    const makenna = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
    const res = await meRoute.PATCH(
      req("/api/v1/me", {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ preferencesNote: "Low fade, no product. Card 4242424242424242, text me at 319-555-0177", preferredBarberId: makenna.publicSlug }),
      }),
      ctx({}),
    );
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.preferences.preferredBarber).toEqual({ id: makenna.id, slug: makenna.publicSlug, displayName: makenna.displayLabel });
    expect(me.preferences.note).toContain("Low fade, no product.");
    expect(me.preferences.note).not.toContain("4242424242424242");
    expect(me.preferences.note).not.toContain("555-0177");
    expect(me.preferences.updatedAt).toBeTruthy();
    expect(JSON.stringify(me)).not.toContain("tips well");

    const row = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, jordanId) }))!;
    expect(row.notes).toBe("Staff: tips well");
    expect(row.preferredStaffId).toBe(makenna.id);

    const cleared = await (await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ preferencesNote: "", preferredBarberId: null }) }), ctx({}))).json();
    expect(cleared.preferences).toMatchObject({ note: null, preferredBarber: null });
  });

  it("refuses an unknown barber and a note over 500 characters", async () => {
    const bad = await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ preferredBarberId: "nobody-here" }) }), ctx({}));
    expect(bad.status).toBe(404);
    const long = await meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ preferencesNote: "x".repeat(501) }) }), ctx({}));
    expect(long.status).toBe(400);
  });
});

describe("the app version gate", () => {
  it("426s an old build everywhere but the config, and leaves the website alone", async () => {
    process.env.APP_IOS_MIN_VERSION = "1.4.0";
    process.env.APP_IOS_STORE_URL = "https://apps.apple.com/app/id000";
    const old = { "x-client": "ios", "x-app-version": "1.3.9", authorization: `Bearer ${token}` };
    const blocked = await meRoute.GET(req("/api/v1/me", { headers: old }), ctx({}));
    expect(blocked.status).toBe(426);
    expect((await blocked.json()).error).toMatchObject({ code: "upgrade_required", details: { platform: "ios", minVersion: "1.4.0", storeUrl: "https://apps.apple.com/app/id000" } });

    const cfg = await configRoute.GET(req("/api/v1/app/config", { headers: old }), ctx({}));
    expect(cfg.status).toBe(200);
    expect((await cfg.json()).client).toMatchObject({ platform: "ios", version: "1.3.9", updateRequired: true });

    expect((await meRoute.GET(req("/api/v1/me", { headers: { ...old, "x-app-version": "1.4.0" } }), ctx({}))).status).toBe(200);
    expect((await meRoute.GET(req("/api/v1/me", { headers: { authorization: `Bearer ${token}` } }), ctx({}))).status).toBe(200);
    expect((await meRoute.GET(req("/api/v1/me", { headers: { ...old, "x-client": "android" } }), ctx({}))).status).toBe(200);
  });

  it("reports a maintenance notice", async () => {
    process.env.APP_MAINTENANCE_MESSAGE = "Booking is down for 10 minutes.";
    const cfg = await (await configRoute.GET(req("/api/v1/app/config"), ctx({}))).json();
    expect(cfg.maintenance).toEqual({ active: true, message: "Booking is down for 10 minutes." });
    expect(cfg.client).toBeNull();
  });
});
