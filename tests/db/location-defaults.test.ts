/**
 * Brand defaults reach every location that follows them, a location's own value stays put, and
 * switching it back puts the brand value on it. Shop settings forms make a changed value the
 * shop's own. The booking page gets the policies, headline and tracking IDs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let L: typeof import("@/server/location-defaults");
let pub: typeof import("@/server/public");
const shop: Record<string, { id: string; cutoff: number; accent: string | null }> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

beforeAll(async () => {
  m = await loadModules();
  L = await import("@/server/location-defaults");
  pub = await import("@/server/public");
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = { id: s.id, cutoff: s.cancelCutoffMinutes, accent: s.accentColor };
}, 120_000);

afterAll(async () => {
  await m.db.db.update(m.schema.brandSettings).set({ locationDefaults: {} });
  for (const s of Object.values(shop)) await m.db.db.update(m.schema.shops).set({ brandOverrides: {}, cancelCutoffMinutes: s.cutoff, accentColor: s.accent }).where(eq(m.schema.shops.id, s.id));
  await m?.db.closeDb();
});

const row = (id: string) => m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) }).then((r) => r!);

describe("brand defaults", () => {
  it("a brand change reaches following shops, not ones with their own value; switching back takes the brand value", async () => {
    await L.setShopOverride(actor, shop.moline.id, "cancelCutoffMinutes", 15);
    expect((await row(shop.moline.id)).cancelCutoffMinutes).toBe(15);

    const r = await L.saveBrandDefault(actor, "cancelCutoffMinutes", 120);
    expect(r.following).toBe(Object.keys(shop).length - 1);
    expect((await row(shop.coralville.id)).cancelCutoffMinutes).toBe(120);
    expect((await row(shop.moline.id)).cancelCutoffMinutes).toBe(15);

    const board = await L.locationDefaultsBoard([shop.moline.id, shop.coralville.id]);
    expect(board.brand.cancelCutoffMinutes).toBe(120);
    expect(board.shops.find((s) => s.shopId === shop.moline.id)!.effective.cancelCutoffMinutes).toEqual({ value: 15, scope: "shop" });
    expect(board.shops.find((s) => s.shopId === shop.coralville.id)!.effective.cancelCutoffMinutes).toEqual({ value: 120, scope: "all" });

    await L.clearShopOverride(actor, shop.moline.id, "cancelCutoffMinutes");
    expect((await row(shop.moline.id)).cancelCutoffMinutes).toBe(120);
    expect((await row(shop.moline.id)).brandOverrides).toEqual({});

    const actions = (await m.db.db.select({ a: m.schema.auditLog.action }).from(m.schema.auditLog)).map((x) => x.a);
    for (const a of ["brand.location_default", "shop.location_override", "shop.location_override_cleared"]) expect(actions).toContain(a);
  });

  it("refuses invalid values", async () => {
    await expect(L.saveBrandDefault(actor, "bookingWindowDays", 0)).rejects.toThrow(/Booking window: At least a day/);
    await expect(L.setShopOverride(actor, shop.moline.id, "ga4MeasurementId", "UA-123")).rejects.toThrow(/GA4 ID/);
    await expect(L.saveBrandDefault(actor, "nope" as never, 1)).rejects.toThrow(/Unknown setting/);
  });

  it("a shop settings save makes a changed value the shop's own, and the brand value keeps following", async () => {
    await L.noteShopColumnChanges(shop.silvis.id, { cancelCutoffMinutes: 45, accentColor: null });
    expect((await row(shop.silvis.id)).brandOverrides).toEqual({ cancelCutoffMinutes: 45 });
    await L.noteShopColumnChanges(shop.silvis.id, { cancelCutoffMinutes: 120 });
    expect((await row(shop.silvis.id)).brandOverrides).toEqual({});
  });

  it("the booking page and reminders use the location's values", async () => {
    await L.saveBrandDefault(actor, "cancellationPolicy", "Cancel up to 2 hours before.");
    await L.saveBrandDefault(actor, "ga4MeasurementId", "G-RAYZ1234");
    await L.setShopOverride(actor, shop.utica.id, "metaPixelId", "123456789012");
    await L.setShopOverride(actor, shop.utica.id, "bookingHeadline", "Utica's finest fades");
    await L.setShopOverride(actor, shop.utica.id, "reminderFirstHours", 18);
    const slug = (await row(shop.utica.id)).slug;
    const page = await pub.publicShopPage(slug);
    expect(page.tracking).toEqual({ ga4: "G-RAYZ1234", metaPixel: "123456789012" });
    expect(page.headline).toBe("Utica's finest fades");
    expect(page.cancellationPolicy).toBe("Cancel up to 2 hours before.");
    expect(await L.shopReminderHours(shop.utica.id)).toEqual({ firstHours: 18, secondHours: 2 });
    expect((await L.shopDefaults(shop.moline.id)).metaPixelId).toBeNull();
  });
});
