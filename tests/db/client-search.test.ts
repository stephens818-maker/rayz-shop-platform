/**
 * Client search, filters, saved searches and duplicates against a real database: fuzzy names in any
 * order, every identifier, what masked and hidden details allow, who reaches whom, the filter panel
 * on the client list and its export, saved searches by visibility, the photo route, a walk-in
 * attached to a returning client, and merges and duplicate handling that keep every record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { get, open, propsOf } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const shop: Record<string, string> = {};
const people: Record<string, string> = {};
const LOGINS = ["owner", "admin", "frontdesk", "makenna", "michelle", "regional"] as const;
type Login = (typeof LOGINS)[number];
const as = (l: Login, shopId?: string) => signInAs(people[l], shopId);
const TAG = "fx-search";

type Client = typeof import("@/db/schema").customers.$inferSelect;
const c = {} as Record<"dom" | "lena" | "moline" | "nomail", Client>;
const codes = {} as { ticket: number; appt: string; gift: string; coupon: string; card: string };

async function search(l: Login, q: string, via: "booking" | "pos" | "walk_in" = "booking") {
  await as(l, ["frontdesk", "makenna", "michelle"].includes(l) ? shop.coralville : undefined);
  const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
  const r = await searchCustomersAction(q, via);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

async function listed(l: Login, f: object, q = "") {
  await as(l, ["frontdesk", "makenna", "michelle"].includes(l) ? shop.coralville : undefined);
  const { encodeFilter } = await import("@/domain/client-filters");
  const { SegmentSchema } = await import("@/domain/marketing");
  const r = await open("/admin/customers", {}, { f: encodeFilter(SegmentSchema.parse({ tags: [TAG], ...f })), ...(q ? { q } : {}) });
  if (r.kind !== "ok") throw new Error(`client list: ${r.kind}`);
  return (Object.keys(c) as (keyof typeof c)[]).filter((k) => r.text.includes(`${c[k].firstName} ${c[k].lastName}`)).sort();
}

beforeAll(async () => {
  m = await loadModules();
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  const today = m.time.todayLocal();
  // After closing, so fixtures never collide with the seeded bookings.
  const at = (days: number) => m.time.zonedWallTime(m.time.addDays(today, days), 1290).toJSDate();
  const ins = async (v: typeof m.schema.customers.$inferInsert) => (await m.db.db.insert(m.schema.customers).values(v).returning())[0];
  c.dom = await ins({
    firstName: "Dominique",
    lastName: "Fairweather",
    nickname: "Dom",
    phone: "+13195557311",
    email: "dom.fairweather@example.test",
    address: "88 Quarry Rd, Coralville, IA 52241",
    birthday: "1990-03-09",
    notes: "Prefers the quiet chair",
    homeShopId: shop.coralville,
    smsOptIn: true,
    source: "Instagram",
  });
  c.lena = await ins({ firstName: "Lena", lastName: "Fairweather", phone: "+13195557312", email: "lena.f@example.test", address: "90 Quarry Rd, Coralville, IA 52241", homeShopId: shop.coralville });
  c.moline = await ins({ firstName: "Quincy", lastName: "Farnsworth", phone: "+13095557313", email: "quincy@example.test", address: "5 River Dr, Moline, IL 61265", homeShopId: shop.moline });
  c.nomail = await ins({ firstName: "Rory", lastName: "Fairbanks", phone: "+13195557314", homeShopId: shop.coralville });
  await m.db.db.insert(m.schema.customerTags).values([...Object.values(c).map((x) => ({ customerId: x.id, tag: TAG })), { customerId: c.dom.id, tag: "VIP" }]);

  const barber = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "makenna@rayz.test") }))!;
  const appt = async (customerId: string, shopId: string, staffId: string, days: number, status: "completed" | "booked" | "no_show") =>
    (
      await m.db.db
        .insert(m.schema.appointments)
        .values({
          code: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
          shopId,
          staffId,
          customerId,
          startsAt: at(days),
          endsAt: new Date(at(days).getTime() + 30 * 60_000),
          status,
          source: "staff",
          estimateCents: 2300,
          completedAt: status === "completed" ? new Date(at(days).getTime() + 30 * 60_000) : null,
        })
        .returning()
    )[0];
  const done = await appt(c.dom.id, shop.coralville, barber.id, -20, "completed");
  await appt(c.dom.id, shop.coralville, barber.id, 5, "booked");
  await appt(c.lena.id, shop.coralville, barber.id, -60, "no_show");
  const molineBarber = (await m.db.db.query.staffShops.findFirst({ where: eq(m.schema.staffShops.shopId, shop.moline) }))!.staffId;
  const molineVisit = await appt(c.moline.id, shop.moline, molineBarber, -10, "completed");
  const [sale] = await m.db.db
    .insert(m.schema.sales)
    .values({ shopId: shop.moline, customerId: c.moline.id, appointmentId: molineVisit.id, status: "paid", businessDate: m.time.addDays(today, -10), serviceNetCents: 2300, totalCents: 2300 })
    .returning();
  codes.ticket = sale.number!;
  codes.appt = done.code;
  codes.gift = "FXGC-7311-0000-0001";
  await m.db.db.insert(m.schema.giftCards).values({ code: codes.gift, initialCents: 2500, balanceCents: 2500, customerId: c.dom.id });
  const promo = (await m.db.db.select().from(m.schema.promoCodes).limit(1))[0];
  codes.coupon = "FXDOM7311";
  await m.db.db.insert(m.schema.couponCodes).values({ promoId: promo.id, code: codes.coupon, customerId: c.dom.id });
  await m.db.db.insert(m.schema.customerSquireIds).values({ squireId: "SQ-FX-7311", customerId: c.dom.id, shopId: shop.coralville });
  const { loyaltyCardValue } = await import("@/server/loyalty-card");
  codes.card = loyaltyCardValue(c.dom);

  // Makenna (a barber) doesn't see phone numbers at all.
  await as("owner");
  const { setFieldRuleAction } = await import("@/app/admin/client-data/actions");
  const r = await setFieldRuleAction({ field: "phone", level: "hidden", roleId: null, staffId: people.makenna, shopId: null });
  if (!r.ok) throw new Error(r.error);
}, 180_000);

afterAll(async () => {
  await signInAs(null);
});

describe("finding a client", () => {
  it("by name in any order, with typos, by nickname, or a name and the last 4", async () => {
    for (const q of ["Dominique Fairweather", "fairweather dominique", "Fairweather, Dominique", "Dominque Fairwether", "Dom Fairweather", "dom"])
      expect(ids(await search("admin", q)), q).toContain(c.dom.id);
    const both = ids(await search("admin", "Fairweather"));
    expect(both).toEqual(expect.arrayContaining([c.dom.id, c.lena.id]));
    expect(ids(await search("admin", "Fairweather 7312"))).toEqual([c.lena.id]);
  });

  it("by phone in any format and its last 4, email, client number, loyalty card and every code", async () => {
    for (const q of ["(319) 555-7311", "319.555.7311", "+1 319 555 7311", "7311", "dom.fairweather@example.test", `C${c.dom.number}`, codes.card, codes.gift, codes.coupon, "SQ-FX-7311", codes.appt])
      expect(ids(await search("admin", q)), q).toContain(c.dom.id);
    expect(ids(await search("admin", `#${codes.ticket}`))).toEqual([c.moline.id]);
    const forged = codes.card.slice(0, -10) + "AAAAAAAAAA";
    expect(ids(await search("admin", forged))).not.toContain(c.dom.id);
  });

  it("by birthday, address, zip, town, notes and tags", async () => {
    for (const q of ["3/9/1990", "1990-03-09", "88 Quarry Rd, Coralville, IA 52241", "note:quiet chair", "tag:vip", "quarry"])
      expect(ids(await search("admin", q)), q).toContain(c.dom.id);
    // Broad readings find clients there (many, so the first page needn't be these).
    expect((await search("admin", "zip:52241")).length).toBeGreaterThan(0);
    expect((await search("admin", "town:moline")).length).toBeGreaterThan(0);
  });

  it("results carry what tells two clients apart, and the phone masked", async () => {
    const [hit] = await search("admin", "Dominique Fairweather");
    expect(hit).toMatchObject({ id: c.dom.id, short: "Dominique F.", nickname: "Dom", number: c.dom.number, phone: expect.stringMatching(/7311$/) });
    expect(hit.phone).not.toContain("555");
    expect(hit.lastVisit).toMatchObject({ shop: expect.any(String) });
    expect(hit.barber).toBeTruthy();
    expect(hit.matched).toContain("Name");
  });
});

describe("hidden and masked details", () => {
  it("a hidden phone is found only by the whole number, and never shown", async () => {
    const exact = await search("makenna", "(319) 555-7311");
    expect(ids(exact)).toEqual([c.dom.id]);
    expect(exact[0].phone).toBeNull();
    expect(JSON.stringify(exact)).not.toMatch(/7311/);
    expect(await search("makenna", "7311")).toEqual([]);
    expect(await search("makenna", "5557311")).toEqual([]);
    expect(await search("makenna", "phone:319555731")).toEqual([]);
  });

  it("a masked email or a hidden address: the whole value only, no partial match to walk letter by letter", async () => {
    expect(ids(await search("frontdesk", "dom.fairweather@example.test"))).toEqual([c.dom.id]);
    expect(await search("frontdesk", "email:dom.fair")).toEqual([]);
    expect(ids(await search("frontdesk", "88 Quarry Rd, Coralville, IA 52241"))).toEqual([c.dom.id]);
    expect(ids(await search("frontdesk", "zip:52241"))).not.toContain(c.dom.id);
    expect(ids(await search("frontdesk", "7311"))).toContain(c.dom.id);
  });

  it("clients are the brand's: partial terms reach every shop's clients; a ticket number only the searcher's shops' tickets", async () => {
    for (const q of ["Farnsworth", "Farnswo", "Quincy Farnsworth", "(309) 555-7313", "7313"]) expect(ids(await search("frontdesk", q)), q).toContain(c.moline.id);
    for (const q of ["Farnsworth", "quincy"]) expect(ids(await search("makenna", q)), q).toContain(c.moline.id);
    expect(await search("frontdesk", `#${codes.ticket}`)).toEqual([]);
    expect(ids(await search("regional", `#${codes.ticket}`))).toEqual([c.moline.id]);
  });

  it("searches are logged by kind and count, never the term", async () => {
    await search("frontdesk", "(319) 555-7311", "pos");
    const rows = await m.db.db.select().from(m.schema.clientAccessLog).where(eq(m.schema.clientAccessLog.staffId, people.frontdesk));
    const pos = rows.filter((r) => r.kind === "search" && (r.detail as { via?: string }).via === "pos");
    expect(pos.length).toBeGreaterThan(0);
    expect(JSON.stringify(pos)).not.toMatch(/7311/);
    expect(pos.at(-1)!.detail).toMatchObject({ by: ["phone"], results: 1 });
  });

  it("the shared header search for staff without 'every client' only finds clients they've cut", async () => {
    await as("makenna", shop.coralville);
    const { quickFindClientsAction } = await import("@/app/admin/customers/actions");
    const r = await quickFindClientsAction("Fairweather");
    expect(r.ok && ids(r.data).sort()).toEqual([c.dom.id, c.lena.id].sort());
  });
});

describe("filters on the client list", () => {
  it("visit history, places, profile, and filled-in checks", async () => {
    expect(await listed("admin", {})).toEqual(["dom", "lena", "moline", "nomail"]);
    expect(await listed("admin", { minNoShows: 1 })).toEqual(["lena"]);
    expect(await listed("admin", { upcoming: "yes" })).toEqual(["dom"]);
    expect(await listed("admin", { minVisits: 1 })).toEqual(["dom", "moline"]);
    expect(await listed("admin", { homeShopIds: [shop.moline] })).toEqual(["moline"]);
    expect(await listed("admin", { zips: ["52241"] })).toEqual(["dom", "lena"]);
    expect(await listed("admin", { cities: ["moline"] })).toEqual(["moline"]);
    expect(await listed("admin", { near: { shopId: shop.coralville, miles: 10 } })).toEqual(["dom", "lena"]);
    expect(await listed("admin", { fieldsEmpty: ["email"] })).toEqual(["nomail"]);
    expect(await listed("admin", { fieldsSet: ["nickname"] })).toEqual(["dom"]);
    expect(await listed("admin", { sources: ["Instagram"] })).toEqual(["dom"]);
    expect(await listed("admin", { birthdayMonths: [3] })).toEqual(["dom"]);
    expect(await listed("admin", { excludeTags: ["VIP"] })).toEqual(["lena", "moline", "nomail"]);
    expect(await listed("admin", { giftCard: "has_balance" })).toEqual(["dom"]);
    expect(await listed("admin", {}, "Fairweather")).toEqual(["dom", "lena"]);
  });

  it("a filter on a detail the person can't see is refused, not quietly applied", async () => {
    await as("frontdesk", shop.coralville);
    const { encodeFilter } = await import("@/domain/client-filters");
    const { SegmentSchema } = await import("@/domain/marketing");
    const r = await open("/admin/customers", {}, { f: encodeFilter(SegmentSchema.parse({ tags: [TAG], zips: ["52241"] })) });
    expect(r.kind === "ok" && r.text).toMatch(/addresses are hidden from you\s*\. Showing the list without filters/);
  });

  it("the export follows the filters, for people allowed to export", async () => {
    const { GET } = await import("@/app/admin/customers/export/route");
    const { encodeFilter } = await import("@/domain/client-filters");
    const { SegmentSchema } = await import("@/domain/marketing");
    const f = encodeFilter(SegmentSchema.parse({ tags: [TAG], zips: ["52241"] }));
    await as("owner");
    const csv = await get(GET, `/admin/customers/export?f=${f}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Fairweather");
    expect(csv.text).not.toContain("Farnsworth");
    expect(csv.text).not.toContain("Fairbanks");
    await as("frontdesk", shop.coralville);
    expect((await get(GET, `/admin/customers/export?f=${f}`)).status).toBe(403);
  });
});

describe("saved searches", () => {
  it("private, location and brand visibility; only brand-wide people share with the brand", async () => {
    const { saveClientSearchAction, deleteClientSearchAction } = await import("@/app/admin/customers/actions");
    await as("frontdesk", shop.coralville);
    const mine = await saveClientSearchAction({ name: "Desk: no email", term: "", segment: { tags: [TAG], fieldsEmpty: ["email"] }, visibility: "private" });
    expect(mine.ok).toBe(true);
    const loc = await saveClientSearchAction({ name: "Coralville VIPs", term: "", segment: { tags: ["VIP"] }, visibility: "shop" });
    expect(loc.ok).toBe(true);
    expect(await saveClientSearchAction({ name: "Everyone", term: "x", segment: {}, visibility: "brand" })).toMatchObject({ ok: false });
    await as("admin");
    const brand = await saveClientSearchAction({ name: "Brand: lapsed VIPs", term: "", segment: { tags: ["VIP"], lastVisitOverDays: 60 }, visibility: "brand" });
    expect(brand.ok).toBe(true);

    await as("michelle", shop.coralville);
    const page = await open("/admin/customers");
    const text = page.kind === "ok" ? page.text : "";
    expect(text).toContain("Brand: lapsed VIPs");
    expect(text).toContain("Coralville VIPs");
    expect(text).not.toContain("Desk: no email");

    await as("frontdesk", shop.coralville);
    if (!brand.ok) throw new Error();
    expect(await deleteClientSearchAction(brand.data.id)).toMatchObject({ ok: false });
    if (!mine.ok) throw new Error();
    expect((await deleteClientSearchAction(mine.data.id)).ok).toBe(true);
  });
});

describe("profile photo and walk-ins", () => {
  const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  it("the photo route serves the image only to people who see photos and reach the client", async () => {
    const { setClientPhotoAction } = await import("@/app/admin/customers/actions");
    const { GET } = await import("@/app/admin/customers/[id]/photo/route");
    await as("owner");
    expect((await setClientPhotoAction(c.dom.id, PIXEL)).ok).toBe(true);
    const ok = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: c.dom.id }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toMatch(/private/);
    await as("makenna", shop.coralville);
    expect((await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: c.dom.id }) })).status).toBe(200);
    await m.db.db.insert(m.schema.clientPhotos).values({ customerId: c.moline.id, dataUrl: PIXEL });
    expect((await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: c.moline.id }) })).status).toBe(404);
  });

  it("a walk-in picked from the search is the returning client, not a new record", async () => {
    await as("frontdesk", shop.coralville);
    const { walkInAction } = await import("@/app/admin/walk-ins/actions");
    const svc = (await m.catalog.shopCatalog(shop.coralville)).find((s) => s.slug === "rayz-cut")!;
    const before = (await m.db.db.select().from(m.schema.customers)).length;
    const r = await walkInAction({ shopId: shop.coralville, serviceId: svc.id, name: "Rory", phone: "", preferredStaffId: null, customerId: c.nomail.id });
    expect(r.ok).toBe(true);
    expect((await m.db.db.select().from(m.schema.customers)).length).toBe(before);
    const appts = await m.db.db.select().from(m.schema.appointments).where(eq(m.schema.appointments.customerId, c.nomail.id));
    const waits = await m.db.db.select().from(m.schema.waitlistEntries).where(eq(m.schema.waitlistEntries.customerId, c.nomail.id));
    expect(appts.length + waits.length).toBeGreaterThan(0);
  });
});

describe("duplicates and merging", () => {
  it("a merge moves unsubscribes, coupons, tags (once) and the photo instead of deleting them", async () => {
    const ins = async (v: typeof m.schema.customers.$inferInsert) => (await m.db.db.insert(m.schema.customers).values(v).returning())[0];
    const keep = await ins({ firstName: "Theo", lastName: "Mergewell", phone: "+13195557400" });
    const drop = await ins({ firstName: "Theodore", lastName: "Mergewell", email: "theo.m@example.test", nickname: "Teddy", source: "Walk-in" });
    const promo = (await m.db.db.select().from(m.schema.promoCodes).limit(1))[0];
    await m.db.db.insert(m.schema.marketingUnsubscribes).values({ channel: "email", customerId: drop.id, email: "theo.m@example.test", source: "link" });
    await m.db.db.insert(m.schema.couponCodes).values({ promoId: promo.id, code: "FXMERGE1", customerId: drop.id });
    await m.db.db.insert(m.schema.customerTags).values([
      { customerId: keep.id, tag: "regular" },
      { customerId: drop.id, tag: "regular" },
      { customerId: drop.id, tag: "beard" },
    ]);
    await m.db.db.insert(m.schema.clientPhotos).values({ customerId: drop.id, dataUrl: "data:image/png;base64,AAAA" });
    await m.db.db.update(m.schema.customers).set({ referredById: drop.id }).where(eq(m.schema.customers.id, c.nomail.id));

    const r = await m.customers.mergeCustomers(keep.id, drop.id, actor);
    expect(r.moved).toMatchObject({ marketingUnsubscribes: 1, couponCodes: 1, customerTags: 1, clientPhotos: 1 });
    const tags = await m.db.db.select().from(m.schema.customerTags).where(eq(m.schema.customerTags.customerId, keep.id));
    expect(tags.map((t) => t.tag).sort()).toEqual(["beard", "regular"]);
    expect((await m.db.db.query.marketingUnsubscribes.findFirst({ where: eq(m.schema.marketingUnsubscribes.email, "theo.m@example.test") }))!.customerId).toBe(keep.id);
    expect((await m.db.db.query.couponCodes.findFirst({ where: eq(m.schema.couponCodes.code, "FXMERGE1") }))!.customerId).toBe(keep.id);
    expect((await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.nomail.id) }))!.referredById).toBe(keep.id);
    expect(await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, keep.id) })).toMatchObject({ nickname: "Teddy", source: "Walk-in", email: "theo.m@example.test" });
  });

  it("the Squire import pairs are found and grouped; 'not the same person' hides a pair; a bulk merge keeps the record with more visits", async () => {
    const pairs = await m.customers.duplicatePairs({ squireOnly: true });
    const pairOf = (first: string, last: string) => pairs.filter((p) => p.a.lastName === last && p.b.lastName === last && [p.a.firstName, p.b.firstName].includes(first));
    expect(pairOf("Mike", "Kowalski")[0]).toMatchObject({ kind: "likely" });
    expect(pairOf("Jonathon", "Reyes")[0]).toMatchObject({ kind: "similar_name", signals: expect.arrayContaining(["birthday"]) });
    expect(pairOf("Darnell", "Price")[0]).toMatchObject({ kind: "shared_contact", conflicts: ["birthday"] });
    expect(pairs.every((p) => p.a.squire || p.b.squire)).toBe(true);

    await as("owner");
    const { dismissDuplicateAction, mergeDuplicatesAction } = await import("@/app/admin/customers/actions");
    const price = pairOf("Darnell", "Price")[0];
    expect((await dismissDuplicateAction(price.b.id, price.a.id)).ok).toBe(true);
    expect(pairOf("Darnell", "Price").length).toBe(1);
    expect((await m.customers.duplicatePairs({ squireOnly: true })).some((p) => p.a.lastName === "Price")).toBe(false);

    const reyes = pairOf("Jonathon", "Reyes")[0];
    const imported = reyes.a.squire ? reyes.a : reyes.b;
    const other = reyes.a.squire ? reyes.b : reyes.a;
    await m.db.db.insert(m.schema.appointments).values({
      code: "SDUPVISIT1",
      shopId: shop.kimberly,
      staffId: (await m.db.db.query.staffShops.findFirst({ where: eq(m.schema.staffShops.shopId, shop.kimberly) }))!.staffId,
      customerId: other.id,
      startsAt: m.time.zonedWallTime(m.time.addDays(m.time.todayLocal(), -1), 1320).toJSDate(),
      endsAt: m.time.zonedWallTime(m.time.addDays(m.time.todayLocal(), -1), 1350).toJSDate(),
      status: "completed",
      source: "staff",
      estimateCents: 2300,
      completedAt: new Date(),
    });
    const r = await mergeDuplicatesAction([{ a: reyes.a.id, b: reyes.b.id }]);
    expect(r).toMatchObject({ ok: true, data: { merged: 1, failed: [] } });
    expect(await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, imported.id) })).toBeUndefined();
    const kept = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, other.id) }))!;
    expect(kept.address).toContain("Oak St");
    const squire = await m.db.db.query.customerSquireIds.findFirst({ where: eq(m.schema.customerSquireIds.squireId, "SQ-DEMO-1") });
    expect(squire!.customerId).toBe(other.id);
    expect(await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "client.duplicate_dismiss"))).toHaveLength(1);

    await as("frontdesk", shop.coralville);
    expect(await mergeDuplicatesAction([{ a: price.a.id, b: price.b.id }])).toMatchObject({ ok: false });
    expect(await dismissDuplicateAction(price.a.id, price.b.id)).toMatchObject({ ok: false });
  }, 60_000);

  it("the duplicates page groups pairs and filters to Squire imports", async () => {
    await as("owner");
    const r = await open("/admin/customers/duplicates", {}, { from: "squire" });
    expect(r.kind === "ok" && r.text).toMatch(/Likely the same person/);
    const { DuplicateGroup } = await import("@/app/admin/customers/duplicates/merge-buttons");
    const groups = await propsOf<{ rows: { a: { label: string; squire: boolean }; b: { label: string; squire: boolean }; keeps: string }[] }>(DuplicateGroup, "/admin/customers/duplicates", {}, { from: "squire" });
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.a.squire || x.b.squire)).toBe(true);
    expect(rows.find((x) => x.a.label.includes("Kowalski"))).toBeTruthy();
  }, 60_000);
});
