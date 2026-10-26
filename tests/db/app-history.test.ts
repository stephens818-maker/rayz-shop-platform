/**
 * Sessions (I12): a session outlives refreshes, lists where I'm signed in, and ending one (or signing
 * out) stops its access token at once and its push devices. My appointments page by cursor, by
 * status, and with the children on my account (I6). The loyalty card's history (I7). Book again (I8).
 * The shop's policies on GET /shops/{shop} (I9). Home shop and birthday on /me (C16).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSet } from "./brand";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let sessionsRoute: typeof import("@/app/api/v1/me/sessions/route");
let sessionRoute: typeof import("@/app/api/v1/me/sessions/[id]/route");
let devicesRoute: typeof import("@/app/api/v1/me/devices/route");
let logoutRoute: typeof import("@/app/api/v1/auth/logout/route");
let meRoute: typeof import("@/app/api/v1/me/route");
let apptsRoute: typeof import("@/app/api/v1/me/appointments/route");
let ledgerRoute: typeof import("@/app/api/v1/me/loyalty/ledger/route");
let rebookRoute: typeof import("@/app/api/v1/me/suggested-rebook/route");
let shopRoute: typeof import("@/app/api/v1/shops/[shop]/route");
const fx = { shopId: "", michelle: "", cutId: "" };
const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, "x-client": "ios", "x-app-version": "2.4.0" });
const DAY = 86_400_000;

let seq = 0;
async function client(o: Partial<typeof m.schema.customers.$inferInsert> = {}) {
  const n = String(1000 + ++seq + Math.floor(Math.random() * 8000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Harper", lastName: "Hist", phone: `+1563555${n}`, ...o })
    .returning();
  return c;
}

let codes = 0;
async function appt(customerId: string, at: Date, status: "completed" | "booked" | "cancelled" | "no_show" = "completed") {
  // 10:00 UTC is before opening in Central, on the same local day, so it never lands on a seeded booking.
  const startsAt = new Date(`${m.time.localDateOf(at)}T10:00:00Z`);
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `HIST${++codes}${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
      shopId: fx.shopId,
      staffId: fx.michelle,
      customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status,
      source: "staff",
      estimateCents: 2300,
      completedAt: status === "completed" ? new Date(startsAt.getTime() + 30 * 60_000) : null,
      cancelledAt: status === "cancelled" ? new Date() : null,
    })
    .returning();
  await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, serviceId: fx.cutId, kind: "service", name: "Haircut", priceCents: 2300, durationMin: 30 });
  return a;
}

beforeAll(async () => {
  m = await loadModules();
  sessionsRoute = await import("@/app/api/v1/me/sessions/route");
  sessionRoute = await import("@/app/api/v1/me/sessions/[id]/route");
  devicesRoute = await import("@/app/api/v1/me/devices/route");
  logoutRoute = await import("@/app/api/v1/auth/logout/route");
  meRoute = await import("@/app/api/v1/me/route");
  apptsRoute = await import("@/app/api/v1/me/appointments/route");
  ledgerRoute = await import("@/app/api/v1/me/loyalty/ledger/route");
  rebookRoute = await import("@/app/api/v1/me/suggested-rebook/route");
  shopRoute = await import("@/app/api/v1/shops/[shop]/route");
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  fx.shopId = shop.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  fx.cutId = (await m.catalog.shopCatalog(shop.id)).find((x) => x.kind === "service")!.id;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const me = (token: string) => meRoute.GET(req("/api/v1/me", { headers: bearer(token) }), ctx({}));
const sessions = async (token: string) => (await (await sessionsRoute.GET(req("/api/v1/me/sessions", { headers: bearer(token) }), ctx({}))).json()).sessions;

describe("sessions (I12)", () => {
  it("a session lasts across refreshes; listing marks this one", async () => {
    const c = await client();
    const phone = await m.auth.issueTokens(c.id, "Harper's iPhone");
    const ipad = await m.auth.issueTokens(c.id, "iPad");
    const next = await m.auth.refresh(phone.refreshToken);
    expect((await me(phone.accessToken)).status).toBe(200);
    expect((await me(next.accessToken)).status).toBe(200);
    const list = await sessions(next.accessToken);
    expect(list).toHaveLength(2);
    expect(list.find((x: { current: boolean }) => x.current)).toMatchObject({ deviceName: "Harper's iPhone" });
    expect(list.find((x: { current: boolean }) => !x.current)).toMatchObject({ deviceName: "iPad" });
    expect((await sessions(ipad.accessToken)).find((x: { current: boolean }) => x.current).deviceName).toBe("iPad");
  });

  it("signing out everywhere else stops their access tokens at once and their push devices", async () => {
    const c = await client();
    const phone = await m.auth.issueTokens(c.id, "phone");
    const tablet = await m.auth.issueTokens(c.id, "tablet");
    const reg = await devicesRoute.POST(
      req("/api/v1/me/devices", { method: "POST", headers: bearer(tablet.accessToken), body: JSON.stringify({ platform: "ios", provider: "apns", token: `tok-${crypto.randomUUID()}` }) }),
      ctx({}),
    );
    expect(reg.status).toBe(201);
    const deviceId = (await reg.json()).device.id;

    const out = await sessionsRoute.DELETE(req("/api/v1/me/sessions", { method: "DELETE", headers: bearer(phone.accessToken) }), ctx({}));
    expect(await out.json()).toEqual({ ended: 1 });
    expect((await me(tablet.accessToken)).status).toBe(401);
    expect((await me(phone.accessToken)).status).toBe(200);
    await expect(m.auth.refresh(tablet.refreshToken)).rejects.toMatchObject({ code: "unauthorized" });
    const device = await m.db.db.query.customerDevices.findFirst({ where: eq(s().customerDevices.id, deviceId) });
    expect(device?.revokedAt).not.toBeNull();
    const [row] = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "customer.sessions_ended")).orderBy(m.drizzle.desc(s().auditLog.at)).limit(1);
    expect(row).toMatchObject({ entityId: c.id });
  });

  it("ends one session by id, 404 for someone else's; signing out ends this one", async () => {
    const c = await client();
    const other = await client();
    const a = await m.auth.issueTokens(c.id, "a");
    const b = await m.auth.issueTokens(c.id, "b");
    const theirs = await m.auth.issueTokens(other.id, "x");
    const bId = (await sessions(b.accessToken)).find((x: { current: boolean }) => x.current).id;
    const theirId = (await sessions(theirs.accessToken))[0].id;

    expect((await sessionRoute.DELETE(req(`/api/v1/me/sessions/${theirId}`, { method: "DELETE", headers: bearer(a.accessToken) }), ctx({ id: theirId }))).status).toBe(404);
    expect((await me(theirs.accessToken)).status).toBe(200);
    const res = await sessionRoute.DELETE(req(`/api/v1/me/sessions/${bId}`, { method: "DELETE", headers: bearer(a.accessToken) }), ctx({ id: bId }));
    expect(await res.json()).toEqual({ ended: 1 });
    expect((await me(b.accessToken)).status).toBe(401);
    expect((await me(a.accessToken)).status).toBe(200);

    const bye = await logoutRoute.POST(req("/api/v1/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: a.refreshToken }) }), ctx({}));
    expect(bye.status).toBe(204);
    expect((await me(a.accessToken)).status).toBe(401);
  });

  it("a reused refresh token ends every session", async () => {
    const c = await client();
    const a = await m.auth.issueTokens(c.id, "a");
    const b = await m.auth.issueTokens(c.id, "b");
    const a2 = await m.auth.refresh(a.refreshToken);
    await expect(m.auth.refresh(a.refreshToken)).rejects.toMatchObject({ code: "unauthorized" });
    for (const t of [a2.accessToken, b.accessToken]) expect((await me(t)).status).toBe(401);
  });
});

describe("my appointments (I6)", () => {
  it("keeps the first-page shape, pages by cursor and status, and adds children on request", async () => {
    const mom = await client({ firstName: "Mara" });
    const kid = await client({ firstName: "Kip", phone: null, guardianId: mom.id });
    const now = Date.now();
    const past = [await appt(mom.id, new Date(now - 30 * DAY)), await appt(mom.id, new Date(now - 20 * DAY)), await appt(mom.id, new Date(now - 10 * DAY), "no_show")];
    const soon = await appt(mom.id, new Date(now + 2 * DAY), "booked");
    await appt(mom.id, new Date(now + 3 * DAY), "cancelled");
    const kidVisit = await appt(kid.id, new Date(now + 4 * DAY), "booked");
    const t = (await m.auth.issueTokens(mom.id, null)).accessToken;
    const get = async (q = "") => apptsRoute.GET(req(`/api/v1/me/appointments${q}`, { headers: bearer(t) }), ctx({}));

    const first = await (await get()).json();
    expect(first.upcoming.map((a: { code: string }) => a.code)).toEqual([soon.code]);
    expect(first.past.map((a: { code: string }) => a.code)).toEqual(past.map((a) => a.code).reverse());
    expect(first.nextCursor).toEqual({ upcoming: null, past: null });

    const p1 = await (await get("?status=past&limit=2")).json();
    expect(p1.appointments.map((a: { code: string }) => a.code)).toEqual([past[2].code, past[1].code]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = await (await get(`?cursor=${p1.nextCursor}&limit=2`)).json();
    expect(p2).toMatchObject({ appointments: [{ code: past[0].code }], nextCursor: null });
    expect((await get(`?status=upcoming&cursor=${p1.nextCursor}`)).status).toBe(400);
    expect((await get("?cursor=nonsense")).status).toBe(400);

    const cancelled = await (await get("?status=cancelled")).json();
    expect(cancelled.appointments).toHaveLength(1);
    expect(cancelled.appointments[0].status).toBe("cancelled");

    const fam = await (await get("?status=upcoming&family=true")).json();
    expect(fam.appointments.map((a: { code: string; customer: { firstName: string } }) => [a.code, a.customer.firstName])).toEqual([
      [soon.code, "Mara"],
      [kidVisit.code, "Kip"],
    ]);

    await brandSet("app", "switches", { family: false });
    try {
      const off = await get("?family=true");
      expect(off.status).toBe(403);
      expect((await off.json()).error.details).toMatchObject({ switch: "family" });
      expect((await get()).status).toBe(200);
    } finally {
      await brandSet("app", "switches", { family: true });
    }
  });
});

describe("loyalty history (I7)", () => {
  it("newest first, paged, with the Squire balance flagged; nothing until an imported profile is confirmed", async () => {
    const c = await client();
    const base = Date.now() - 10 * DAY;
    await m.db.db.insert(s().loyaltyLedger).values([
      { customerId: c.id, kind: "import", progressDeltaCents: 4000, rewardCents: 0, createdAt: new Date(base) },
      { customerId: c.id, kind: "earn", progressDeltaCents: 2300, createdAt: new Date(base + DAY) },
      { customerId: c.id, kind: "reward_issued", rewardCents: 500, createdAt: new Date(base + 2 * DAY) },
    ]);
    const t = (await m.auth.issueTokens(c.id, null)).accessToken;
    const get = async (q = "") => (await ledgerRoute.GET(req(`/api/v1/me/loyalty/ledger${q}`, { headers: bearer(t) }), ctx({}))).json();
    const p1 = await get("?limit=2");
    expect(p1.redemptionLocked).toBe(false);
    expect(p1.entries.map((e: { kind: string }) => e.kind)).toEqual(["reward_issued", "earn"]);
    expect(p1.entries[1]).toMatchObject({ label: "Earned on a visit", progressDelta: 2300, imported: false, receiptId: null, shop: null });
    const p2 = await get(`?cursor=${p1.nextCursor}`);
    expect(p2).toMatchObject({ entries: [{ kind: "import", imported: true, label: "Brought over from Squire", progressDelta: 4000 }], nextCursor: null });

    const imported = await client({ source: "Squire import" });
    await m.db.db.insert(s().loyaltyLedger).values({ customerId: imported.id, kind: "import", progressDeltaCents: 1000 });
    const it = (await m.auth.issueTokens(imported.id, null)).accessToken;
    const locked = await (await ledgerRoute.GET(req("/api/v1/me/loyalty/ledger", { headers: bearer(it) }), ctx({}))).json();
    expect(locked).toEqual({ entries: [], nextCursor: null, redemptionLocked: true });
  });
});

describe("book again (I8)", () => {
  it("their usual interval, else the brand's default, for me and each child; a booked one shows its next visit", async () => {
    const dad = await client({ firstName: "Dale" });
    const kid = await client({ firstName: "Rory", phone: null, guardianId: dad.id });
    const now = new Date();
    await appt(dad.id, new Date(now.getTime() - 50 * DAY));
    await appt(dad.id, new Date(now.getTime() - 20 * DAY));
    await appt(kid.id, new Date(now.getTime() - 40 * DAY));
    const booked = await appt(kid.id, new Date(now.getTime() + 5 * DAY), "booked");
    await m.db.db.update(s().services).set({ rebookDays: null }).where(eq(s().services.id, fx.cutId));
    const t = (await m.auth.issueTokens(dad.id, null)).accessToken;
    const { suggestions } = await (await rebookRoute.GET(req("/api/v1/me/suggested-rebook", { headers: bearer(t) }), ctx({}))).json();
    expect(suggestions).toHaveLength(2);
    const [d, k] = suggestions;
    expect(d).toMatchObject({ customer: { id: dad.id, isChild: false }, intervalDays: 30, intervalSource: "client", nextVisit: null, daysUntil: 10 });
    expect(d.lastVisit).toMatchObject({ shop: { slug: "coralville" }, barber: { id: fx.michelle, displayName: "Michelle" }, services: [{ serviceId: fx.cutId, kind: "service", bookable: true }] });
    expect(d.suggestedDate).toBe(m.time.addDays(m.time.localDateOf(new Date(now.getTime() - 20 * DAY)), 30));
    expect(k).toMatchObject({ customer: { id: kid.id, firstName: "Rory", isChild: true }, intervalSource: "brand", intervalDays: 28, nextVisit: { code: booked.code } });

    const loner = await client();
    const lt = (await m.auth.issueTokens(loner.id, null)).accessToken;
    expect(await (await rebookRoute.GET(req("/api/v1/me/suggested-rebook", { headers: bearer(lt) }), ctx({}))).json()).toEqual({ suggestions: [] });
  });
});

describe("shop policies (I9)", () => {
  it("GET /shops/{shop} carries the cancellation and no-show policy", async () => {
    const before = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, fx.shopId) }))!.brandOverrides;
    await m.db.db
      .update(s().shops)
      .set({ brandOverrides: { ...(before ?? {}), cancellationPolicy: "Cancel 2 hours ahead, please.", noShowPolicy: "" } })
      .where(eq(s().shops.id, fx.shopId));
    try {
      const body = await (await shopRoute.GET(req("/api/v1/shops/coralville"), ctx({ shop: "coralville" }))).json();
      expect(body.policies).toEqual({ cancellation: "Cancel 2 hours ahead, please.", noShow: null, cancelCutoffMinutes: body.cancelCutoffMinutes });
      expect(body.slug).toBe("coralville");
    } finally {
      await m.db.db
        .update(s().shops)
        .set({ brandOverrides: before ?? {} })
        .where(eq(s().shops.id, fx.shopId));
    }
  });
});

describe("profile fields (C16)", () => {
  it("sets and clears the home shop and birthday; a birthday under 13 or a hidden shop is refused", async () => {
    const c = await client();
    const t = (await m.auth.issueTokens(c.id, null)).accessToken;
    const patch = (b: object) => meRoute.PATCH(req("/api/v1/me", { method: "PATCH", headers: bearer(t), body: JSON.stringify(b) }), ctx({}));
    const set = await patch({ homeShopId: "coralville", birthday: "1990-04-12" });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ homeShop: { id: fx.shopId, slug: "coralville" }, birthday: "1990-04-12" });
    const young = m.time.addDays(m.time.todayLocal(), -12 * 366);
    const under = await patch({ birthday: young });
    expect(under.status).toBe(400);
    expect((await under.json()).error.details).toMatchObject({ field: "birthday", reason: "under_13" });
    const [hidden] = await m.db.db
      .insert(s().shops)
      .values({ slug: `hidden-${crypto.randomUUID().slice(0, 6)}`, name: "Hidden", address: "1 Main", city: "Iowa City", state: "IA", zip: "52240", status: "setup" })
      .returning();
    expect((await patch({ homeShopId: hidden.slug })).status).toBe(404);
    expect(await (await patch({ homeShopId: null, birthday: null })).json()).toMatchObject({ homeShop: null, birthday: null });
  });
});
