/**
 * Location profiles against the seeded brand: saving the address (pinned at the ZIP's centre without
 * a geocoder key, or where it was moved by hand), the E.164 phone, socials, amenities, Place ID,
 * review link and tax jurisdiction with their permissions; photos and the logo; the public locations
 * API (near a ZIP, radius, detail, open now, next slot, OpenAPI); calendar invites; the widget
 * script; the address in confirmations, reminders and receipts; the Add Location wizard's profile
 * and the checklist; and the Settings cards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

type Ctx = import("@/server/auth/staff").StaffContext;
let m: Mods;
let LP: typeof import("@/server/location-profile");
let PL: typeof import("@/server/public-locations");
let D: typeof import("@/domain/location-profile");
let context: typeof import("@/server/report-builder/context");
let setup: typeof import("@/app/admin/setup/actions");
let profileActions: typeof import("@/app/admin/settings/profile-actions");
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
let original: Record<string, unknown> = {};
const env = { key: process.env.GOOGLE_MAPS_API_KEY, geocoder: process.env.GEOCODER };

const PLACE = "ChIJrayzDubuqueTest0001";
const WRITE = `https://search.google.com/local/writereview?placeid=${PLACE}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const LE_CLAIRE_ZIP = { lat: 41.6213, lng: -90.3817 };

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ctxOf = async (who: string) => (await context.staffContextFor(ids[who]))!;
const without = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions].filter((p) => !perms.includes(p))) as Ctx["permissions"] });
const row = async (id: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) }))!;
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const form = (o: Record<string, unknown> = {}) => ({ address: "200 Main St", address2: "Suite 3", city: "Le Claire", state: "IA", zip: "52753", ...o });

beforeAll(async () => {
  m = await loadModules();
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GEOCODER;
  LP = await import("@/server/location-profile");
  PL = await import("@/server/public-locations");
  D = await import("@/domain/location-profile");
  context = await import("@/server/report-builder/context");
  setup = await import("@/app/admin/setup/actions");
  profileActions = await import("@/app/admin/settings/profile-actions");
  for (const k of ["owner", "manager.moline"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  original = { ...(await row(shop.dubuque)) };
}, 180_000);

afterAll(async () => {
  if (m) {
    await m.db.db.delete(m.schema.shopPhotos).where(eq(m.schema.shopPhotos.shopId, shop.dubuque));
    const { id: _, createdAt: __, ...rest } = original as typeof m.schema.shops.$inferSelect;
    await m.db.db.update(m.schema.shops).set(rest).where(eq(m.schema.shops.id, shop.dubuque));
    await m.db.closeDb();
  }
  if (env.key !== undefined) process.env.GOOGLE_MAPS_API_KEY = env.key;
  if (env.geocoder !== undefined) process.env.GEOCODER = env.geocoder;
});

describe("saving a location's profile", () => {
  it("saves the address, E.164 phone, email, Place ID, review link, socials, directions and amenities, pinning a typed address at its ZIP", async () => {
    const owner = await ctxOf("owner");
    const before = await row(shop.dubuque);
    const r = await LP.saveLocationProfile(owner, shop.dubuque, {
      ...form(),
      phone: "(563) 555-0177",
      email: "Dubuque@Rayz.Example",
      latitude: before.latitude,
      longitude: before.longitude,
      geocodeSource: before.geocodeSource,
      googlePlaceId: PLACE,
      reviewUrl: PLACE,
      social: { instagram: "@rayzdbq", website: "rayz.example/dubuque" },
      directions: "Park behind the building",
      amenities: ["wifi", "kids", "hot_tub"],
    });
    expect(r).toMatchObject({ latitude: LE_CLAIRE_ZIP.lat, longitude: LE_CLAIRE_ZIP.lng, geocodeSource: "zip", phone: "+15635550177" });
    const s = await row(shop.dubuque);
    expect(s).toMatchObject({
      address: "200 Main St",
      address2: "Suite 3",
      zip: "52753",
      phone: "+15635550177",
      email: "dubuque@rayz.example",
      googlePlaceId: PLACE,
      social: { instagram: "https://www.instagram.com/rayzdbq", website: "https://rayz.example/dubuque" },
      directions: "Park behind the building",
      amenities: ["wifi", "kids"],
      geocodeSource: "zip",
    });
    expect(s.geocodedAt).toBeInstanceOf(Date);
    expect((s.receipt as { reviewUrl: string }).reviewUrl).toBe(WRITE);
    const [a] = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.action, "shop.location_profile"), eq(m.schema.auditLog.entityId, shop.dubuque)));
    expect(a.details).toMatchObject({ changed: { phone: "+15635550177", address2: "Suite 3" }, reviewUrl: WRITE });
  });

  it("keeps a pin moved by hand, and clearing the review link turns its follow-up off", async () => {
    const owner = await ctxOf("owner");
    const s0 = await row(shop.dubuque);
    await m.db.db
      .update(m.schema.shops)
      .set({ receipt: { ...(s0.receipt as object), reviewFollowUp: { enabled: true, delayHours: 3, repeatDays: 90 } } })
      .where(eq(m.schema.shops.id, shop.dubuque));
    await LP.saveLocationProfile(owner, shop.dubuque, { ...form(), phone: "5635550177", latitude: 41.6001, longitude: -90.3502, geocodeSource: "manual", reviewUrl: "", social: { instagram: "@rayzdbq" } });
    const s = await row(shop.dubuque);
    expect(s).toMatchObject({ latitude: 41.6001, longitude: -90.3502, geocodeSource: "manual", social: { instagram: "https://www.instagram.com/rayzdbq" }, amenities: [], directions: null });
    expect(s.receipt).toMatchObject({ reviewUrl: null, reviewFollowUp: { enabled: false } });
  });

  it("needs the shop's details, its checkout part for the review link, and taxes for the jurisdiction", async () => {
    const owner = await ctxOf("owner");
    const manager = await ctxOf("manager.moline");
    await expect(LP.saveLocationProfile(manager, shop.dubuque, form())).rejects.toThrow(/outside your access/);
    await expect(LP.saveLocationProfile(without(owner, ["settings.shop", "settings.shop_details"]), shop.dubuque, form())).rejects.toThrow(/details/);
    const noCheckout = without(owner, ["settings.shop", "settings.shop_checkout"]);
    await expect(LP.saveLocationProfile(noCheckout, shop.dubuque, { ...form(), reviewUrl: PLACE })).rejects.toThrow(/review link/);
    await LP.saveLocationProfile(noCheckout, shop.dubuque, { ...form(), latitude: 41.6001, longitude: -90.3502, geocodeSource: "manual" });
    const tax = { county: "Scott", city: "Le Claire", district: null, code: "82-001" };
    await expect(LP.saveLocationProfile(without(owner, ["settings.taxes"]), shop.dubuque, { ...form(), latitude: 41.6001, longitude: -90.3502, taxJurisdiction: tax })).rejects.toThrow(/tax jurisdiction/);
    await LP.saveLocationProfile(owner, shop.dubuque, { ...form(), latitude: 41.6001, longitude: -90.3502, geocodeSource: "manual", taxJurisdiction: tax });
    expect((await row(shop.dubuque)).taxJurisdiction).toEqual(tax);
    await expect(LP.saveLocationProfile(owner, shop.dubuque, { ...form(), phone: "555-0100" })).rejects.toThrow(/US number/);
    await expect(LP.saveLocationProfile(owner, shop.dubuque, { ...form(), social: { tiktok: "https://evil.example/x" } })).rejects.toThrow(/TikTok/);
  });

  it("the Settings action authenticates and reports problems inline", async () => {
    await signInAs(null);
    await expect(profileActions.saveLocationProfileAction(shop.dubuque, form())).rejects.toThrow(/NEXT_REDIRECT/);
    await signInAs(ids["manager.moline"]);
    expect(await profileActions.saveLocationProfileAction(shop.dubuque, form())).toMatchObject({ ok: false });
    await signInAs(ids.owner);
    expect(await profileActions.saveLocationProfileAction(shop.dubuque, { ...form(), phone: "nope" })).toMatchObject({ ok: false, error: expect.stringMatching(/US number/) });
    expect(await profileActions.saveLocationProfileAction(shop.dubuque, { ...form(), latitude: 41.6001, longitude: -90.3502, geocodeSource: "manual" })).toMatchObject({ ok: true });
    expect(await profileActions.addressSuggestionsAction("200 Main", null)).toEqual({ ok: true, data: [] });
    expect(await profileActions.geocodeAddressAction(form())).toMatchObject({ ok: true, data: { lat: LE_CLAIRE_ZIP.lat, lng: LE_CLAIRE_ZIP.lng, source: "zip", approximate: true } });
    await signInAs(null);
  });
});

describe("photos and the logo", () => {
  it("adds photos in order, keeps one logo, moves and removes them, and caps the count", async () => {
    const owner = await ctxOf("owner");
    const a = await LP.addShopPhoto(owner, shop.dubuque, { kind: "photo", dataUrl: PNG, alt: "Chairs" });
    const b = await LP.addShopPhoto(owner, shop.dubuque, { kind: "photo", dataUrl: PNG, alt: "Front" });
    await LP.addShopPhoto(owner, shop.dubuque, { kind: "logo", dataUrl: PNG });
    const logo = await LP.addShopPhoto(owner, shop.dubuque, { kind: "logo", dataUrl: PNG });
    let view = await LP.loadLocationProfile(shop.dubuque);
    expect(view.photos.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(view.logo?.id).toBe(logo.id);
    await LP.moveShopPhoto(owner, b.id, -1);
    view = await LP.loadLocationProfile(shop.dubuque);
    expect(view.photos.map((p) => p.alt)).toEqual(["Front", "Chairs"]);
    await expect(LP.addShopPhoto(owner, shop.dubuque, { kind: "photo", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" })).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(LP.addShopPhoto(await ctxOf("manager.moline"), shop.dubuque, { kind: "photo", dataUrl: PNG })).rejects.toThrow(/outside your access/);
    for (let i = 0; i < 10; i++) await LP.addShopPhoto(owner, shop.dubuque, { kind: "photo", dataUrl: PNG });
    await expect(LP.addShopPhoto(owner, shop.dubuque, { kind: "photo", dataUrl: PNG })).rejects.toThrow(/Up to 12/);
    await LP.removeShopPhoto(owner, a.id);
    expect((await LP.loadLocationProfile(shop.dubuque)).photos).toHaveLength(11);
  });

  it("serves them publicly for a live shop, and to its staff in Settings", async () => {
    const view = await LP.loadLocationProfile(shop.dubuque);
    const pub = (await import("@/app/(public)/locations/[shop]/photos/[id]/route")).GET;
    const r = await pub(new Request("http://x"), params({ shop: "dubuque", id: view.logo!.id }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect((await pub(new Request("http://x"), params({ shop: "moline", id: view.logo!.id }))).status).toBe(404);
    const staffRoute = (await import("@/app/admin/settings/photos/[id]/route")).GET;
    await signInAs(null);
    expect((await staffRoute(new Request("http://x"), params({ id: view.logo!.id }))).status).toBe(401);
    await signInAs(ids["manager.moline"]);
    expect((await staffRoute(new Request("http://x"), params({ id: view.logo!.id }))).status).not.toBe(200);
    await signInAs(ids.owner);
    const own = await staffRoute(new Request("http://x"), params({ id: view.logo!.id }));
    expect(own.status).toBe(200);
    expect(own.headers.get("Cache-Control")).toMatch(/^private/);
    await signInAs(null);
    const l = await PL.publicLocation("dubuque", { nextSlot: false });
    expect(l.logoUrl).toMatch(new RegExp(`/locations/dubuque/photos/${view.logo!.id}$`));
    expect(l.photos).toHaveLength(11);
  });
});

describe("the public locations API", () => {
  const api = async () => ({ list: (await import("@/app/api/locations/route")).GET, one: (await import("@/app/api/locations/[slug]/route")).GET, doc: (await import("@/app/api/locations/openapi.json/route")).GET });

  it("lists every live location nearest first from a ZIP, within a radius, in the documented shape", async () => {
    const { list } = await api();
    const r = await list(new Request("http://x/api/locations?zip=52753"), params({}));
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toMatch(/^public/);
    const body = D.LocationListSchema.parse(await r.json());
    const live = (await m.db.db.select({ slug: m.schema.shops.slug }).from(m.schema.shops).where(m.drizzle.inArray(m.schema.shops.status, ["live", "closed"]))).map((x) => x.slug);
    expect(body.locations.map((l) => l.slug).sort()).toEqual(live.sort());
    const d = body.locations.map((l) => l.distanceMiles ?? Infinity);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(body.locations.slice(0, 2).map((l) => l.slug).sort()).toEqual(["dubuque", "le-claire"]);
    const near = D.LocationListSchema.parse(await (await list(new Request("http://x/api/locations?near=41.598,-90.344&radius=5"), params({}))).json());
    expect(near.locations.every((l) => l.distanceMiles !== null && l.distanceMiles <= 5)).toBe(true);
    expect(near.locations.map((l) => l.slug)).toContain("le-claire");
    expect((await list(new Request("http://x/api/locations?zip=00000"), params({}))).status).toBe(400);
    expect((await list(new Request("http://x/api/locations?near=here"), params({}))).status).toBe(400);
  });

  it("shows one location with its address, click-to-call, hours, open now, next slot and links", async () => {
    const { one } = await api();
    const r = await one(new Request("http://x/api/locations/le-claire"), params({ slug: "le-claire" }));
    expect(r.status).toBe(200);
    const l = D.LocationSchema.parse(await r.json());
    const s = await row(shop["le-claire"]);
    expect(l).toMatchObject({
      slug: "le-claire",
      address: { line1: s.address, city: s.city, state: s.state, zip: s.zip, country: "US", full: D.fullAddress(s) },
      geo: { lat: s.latitude, lng: s.longitude, approximate: false },
      phone: { e164: s.phone, href: `tel:${s.phone}` },
      timezone: "America/Chicago",
      links: { booking: expect.stringMatching(/\/book\/le-claire$/), app: "rayz://book/le-claire", embed: expect.stringMatching(/\/embed\/book\/le-claire$/), location: expect.stringMatching(/\/locations\/le-claire$/) },
    });
    expect(l.weeklyHours).toHaveLength(7);
    expect(l.openStatus.label).toMatch(/Open now|Closed/);
    expect(l.nextAvailable).not.toBeNull();
    expect(l.nextAvailable!.bookUrl).toMatch(/\/book\/le-claire\?service=/);
    expect(new Date(l.nextAvailable!.startsAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(l)).not.toMatch(/taxJurisdiction|county/);
    expect((await one(new Request("http://x/api/locations/nowhere"), params({ slug: "nowhere" }))).status).toBe(404);
  });

  it("documents itself as OpenAPI", async () => {
    const { doc } = await api();
    const d = (await (await doc(new Request("http://x/api/locations/openapi.json"), params({}))).json()) as { openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(d.openapi).toMatch(/^3\.1/);
    expect(Object.keys(d.paths)).toEqual(expect.arrayContaining(["/locations", "/locations/{slug}"]));
    expect(d.components.schemas).toHaveProperty("Location");
  });
});

describe("calendar invites and the widget script", () => {
  it("serves an appointment's invite with the shop's full address and pin", async () => {
    const [a] = await m.db.db
      .select({ code: m.schema.appointments.code })
      .from(m.schema.appointments)
      .where(m.drizzle.and(eq(m.schema.appointments.shopId, shop["le-claire"]), m.drizzle.gt(m.schema.appointments.startsAt, new Date())))
      .limit(1);
    const route = (await import("@/app/(public)/a/[code]/calendar.ics/route")).GET;
    const r = await route(new Request("http://x"), params({ code: a.code }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/^text\/calendar/);
    const s = await row(shop["le-claire"]);
    const ics = (await r.text()).replace(/\r\n /g, "");
    expect(ics).toContain(`LOCATION:Ray'z Le Claire\\, ${D.fullAddress(s).replace(/,/g, "\\,")}`);
    expect(ics).toContain(`GEO:${s.latitude!.toFixed(6)};${s.longitude!.toFixed(6)}`);
    expect(ics).toContain(`URL:`);
    expect((await route(new Request("http://x"), params({ code: "NOPE99" }))).status).toBe(404);
  });

  it("serves the widget as cacheable JavaScript any site can load", async () => {
    const r = (await import("@/app/widget.js/route")).GET();
    expect(r.headers.get("Content-Type")).toMatch(/^application\/javascript/);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.text()).toMatch(/RayzBooking/);
  });
});

describe("the address in messages and receipts", () => {
  it("confirmation emails end with the address, phone and map and carry the invite; texts say where", async () => {
    const [a] = await m.db.db
      .select({ id: m.schema.appointments.id })
      .from(m.schema.appointments)
      .where(m.drizzle.and(eq(m.schema.appointments.shopId, shop["le-claire"]), m.drizzle.gt(m.schema.appointments.startsAt, new Date())))
      .limit(1);
    const c = { ...(await m.booking.messageContext(a.id)), email: "lp-confirm@rayz.example", emailOptIn: true, phone: "+15635550188", smsOptIn: true };
    const jobIds = await m.queue.queueAppointmentMessage("confirmation", c);
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.inArray(m.schema.notificationJobs.id, jobIds));
    const s = await row(shop["le-claire"]);
    const email = jobs.find((j) => j.channel === "email")!;
    const sms = jobs.find((j) => j.channel === "sms")!;
    expect(email.body).toContain(D.fullAddress(s));
    expect(email.body).toMatch(/\/locations\/le-claire\/directions/);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments![0].contentType).toMatch(/^text\/calendar/);
    const ics = Buffer.from(email.attachments![0].content, "base64").toString("utf8").replace(/\r\n /g, "");
    expect(ics).toContain("LOCATION:Ray'z Le Claire\\,");
    expect(ics).toContain(`GEO:${s.latitude!.toFixed(6)}`);
    expect(sms.attachments).toBeNull();
    expect(sms.body).toContain(s.address);
    const [r2] = await m.queue.queueAppointmentMessage("reminder_2h", { ...c, email: null, emailOptIn: false });
    const [reminder] = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.id, r2));
    expect(reminder.body).toMatch(/Directions: \S+\/locations\/le-claire\/directions/);
    await m.db.db.delete(m.schema.notificationJobs).where(m.drizzle.inArray(m.schema.notificationJobs.id, [...jobIds, r2]));
  });

  it("emailed receipts show the address, phone and a map link", async () => {
    const [sale] = await m.db.db
      .select({ id: m.schema.sales.id })
      .from(m.schema.sales)
      .where(m.drizzle.and(eq(m.schema.sales.shopId, shop["le-claire"]), m.drizzle.isNotNull(m.schema.sales.paidAt)))
      .limit(1);
    const R = await import("@/server/receipts");
    const r = await R.composeReceipt(sale.id, "email", "https://rayz.example/r/test");
    const s = await row(shop["le-claire"]);
    expect(r.body).toContain(D.fullAddress(s));
    expect(r.body).toContain("(563) 296-8350");
    expect(r.body).toMatch(/Directions: \S+\/locations\/le-claire\/directions/);
  });
});

describe("the Add Location wizard and the checklist", () => {
  const slug = `lp-${Date.now().toString(36)}`;
  let created = "";

  it("saves the profile with the new location, pinning it at the ZIP when no pin was picked", async () => {
    await signInAs(ids.owner);
    const { draftDefaults } = await import("@/domain/location-draft");
    const r = await setup.createLocationAction(
      draftDefaults({
        name: "LP Test",
        slug,
        address: "10 River Dr",
        address2: "Unit B",
        city: "Le Claire",
        state: "IA",
        zip: "52753",
        phone: "563-555-0123",
        googlePlaceId: PLACE,
        social: { instagram: "@lptest" },
        directions: "Side door",
        amenities: ["wifi", "bogus"],
        taxJurisdiction: { county: "Scott", city: null, district: null, code: null },
      }),
    );
    expect(r).toMatchObject({ ok: true });
    created = (r as { ok: true; data: { id: string } }).data.id;
    expect(await row(created)).toMatchObject({
      address2: "Unit B",
      phone: "+15635550123",
      latitude: LE_CLAIRE_ZIP.lat,
      longitude: LE_CLAIRE_ZIP.lng,
      geocodeSource: "zip",
      googlePlaceId: PLACE,
      social: { instagram: "https://www.instagram.com/lptest" },
      directions: "Side door",
      amenities: ["wifi"],
      taxJurisdiction: { county: "Scott", city: null, district: null, code: null },
    });
    expect(await setup.createLocationAction(draftDefaults({ name: "LP Bad", slug: `${slug}-x`, address: "1 A St", city: "X", state: "IA", zip: "52753", phone: "555" }))).toMatchObject({ ok: false, error: expect.stringMatching(/US number/) });
    await signInAs(null);
  });

  it("keeps a picked pin, and isn't public while it's being set up", async () => {
    await signInAs(ids.owner);
    const { draftDefaults } = await import("@/domain/location-draft");
    const r = await setup.createLocationAction(draftDefaults({ name: "LP Pin", slug: `${slug}-pin`, address: "11 River Dr", city: "Le Claire", state: "IA", zip: "52753", latitude: 41.59, longitude: -90.34, geocodeSource: "census" }));
    expect(r).toMatchObject({ ok: true });
    expect(await row((r as { ok: true; data: { id: string } }).data.id)).toMatchObject({ latitude: 41.59, longitude: -90.34, geocodeSource: "census" });
    await signInAs(null);
    await expect(PL.publicLocation(slug)).rejects.toThrow(/not found/i);
    expect((await PL.publicLocations({ nextSlot: false })).map((l) => l.slug)).not.toContain(slug);
  });

  it("the checklist recommends finishing the location page without blocking go-live", async () => {
    const { locationSetup } = await import("@/server/location-setup");
    const s = (await locationSetup(created))!;
    const step = s.steps.find((x) => x.key === "profile")!;
    expect(step).toMatchObject({ required: false, done: false });
    expect(step.detail).toMatch(/exact map pin.*photos or a logo/);
    expect(s.blockers).not.toContain("profile");
    const owner = await ctxOf("owner");
    await LP.saveLocationProfile(owner, created, { address: "10 River Dr", city: "Le Claire", state: "IA", zip: "52753", latitude: 41.6, longitude: -90.35, geocodeSource: "manual", googlePlaceId: PLACE });
    await LP.addShopPhoto(owner, created, { kind: "photo", dataUrl: PNG });
    expect((await locationSetup(created))!.steps.find((x) => x.key === "profile")).toMatchObject({ done: true });
  });
});

describe("Settings", () => {
  it("shows the location profile, photos and widget cards to people who edit the shop's details", async () => {
    await signInAs(ids.owner);
    const cards = new Map<string, Record<string, unknown>>();
    const page = await open("/admin/settings", {}, { shop: shop["le-claire"] }, (type, props) => {
      if (typeof type === "function" && type.name) cards.set(type.name, props);
    });
    expect(page.kind).toBe("ok");
    const s = await row(shop["le-claire"]);
    expect(cards.get("LocationProfileEditor")).toMatchObject({ shopId: s.id, geocoder: "zip", canReview: true, canTaxes: true, initial: { address: s.address, phone: s.phone, latitude: s.latitude } });
    expect(cards.get("LocationPhotosEditor")).toMatchObject({ shopId: s.id });
    expect(cards.get("BookingWidgetCard")).toMatchObject({ slug: "le-claire" });
    expect((cards.get("BookingWidgetCard")!.services as unknown[]).length).toBeGreaterThan(0);
    expect(cards.get("ShopInfoEditor")!.initial).not.toHaveProperty("address");
    await signInAs(null);
  });
});
