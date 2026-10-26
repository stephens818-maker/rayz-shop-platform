/**
 * Staff-only client ratings against a real database: who may rate, edit and remove, the audit
 * trail, the lowest/highest report, and that no rating or note ever reaches a customer through
 * the public or customer API.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Permission } from "@/domain/permissions";
import type { RatingViewer } from "@/domain/ratings";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let r: typeof import("@/server/ratings");

beforeAll(async () => {
  m = await loadModules();
  r = await import("@/server/ratings");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const staffNamed = async (label: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!;
const shopNamed = (slug: string) => m.catalog.getShop(slug);

let phoneSeq = 0;
async function client(firstName: string, lastName = "Rated") {
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName, lastName, phone: `+1319555${String(7000 + ++phoneSeq)}` })
    .returning();
  return c;
}

// Far in the past, a day apart, so these never collide with seeded bookings or each other.
let slotSeq = 0;
const nextSlot = () => new Date(Date.UTC(2024, 0, 1, 15) + ++slotSeq * 86_400_000);

async function visit(o: { customerId: string; shop?: string; barber?: string; status?: "completed" | "booked" | "cancelled" | "no_show" }) {
  const shop = await shopNamed(o.shop ?? "coralville");
  const staff = await staffNamed(o.barber ?? "Makenna");
  const at = nextSlot();
  const status = o.status ?? "completed";
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `R${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: shop.id,
      staffId: staff.id,
      customerId: o.customerId,
      startsAt: at,
      endsAt: new Date(at.getTime() + 30 * 60_000),
      status,
      source: "staff",
      estimateCents: 2300,
      completedAt: status === "completed" ? new Date(at.getTime() + 30 * 60_000) : null,
    })
    .returning();
  return a;
}

async function ticket(o: { customerId: string; shop?: string; staffId?: string | null; appointmentId?: string | null; status?: "paid" | "open" | "voided" }) {
  const shop = await shopNamed(o.shop ?? "coralville");
  const at = o.appointmentId ? undefined : nextSlot();
  const [s] = await m.db.db
    .insert(m.schema.sales)
    .values({
      shopId: shop.id,
      customerId: o.customerId,
      appointmentId: o.appointmentId ?? null,
      staffId: o.staffId ?? null,
      status: o.status ?? "paid",
      businessDate: m.time.todayLocal(),
      totalCents: 2500,
      paidAt: (o.status ?? "paid") === "paid" ? (at ?? new Date()) : null,
      ...(at ? { createdAt: at } : {}),
    })
    .returning();
  return s;
}

async function viewerFor(label: string, override: Partial<RatingViewer> = {}): Promise<RatingViewer> {
  const s = await staffNamed(label);
  const a = (await (await import("@/server/auth/access")).loadStaffAccess(s.id))!;
  const has = (p: Permission) => a.permissions.has(p);
  return { staffId: s.id, shopIds: a.shopIds, canRate: has("clients.rate"), seesAll: has("clients.ratings_all"), moderates: has("clients.ratings_moderate"), ...override };
}

const auditFor = (ratingId: string) =>
  m.db.db
    .select()
    .from(m.schema.auditLog)
    .where(m.drizzle.and(eq(m.schema.auditLog.entity, "client_rating"), eq(m.schema.auditLog.entityId, ratingId)))
    .orderBy(m.schema.auditLog.at);

let admin: RatingViewer, manager: RatingViewer, barber: RatingViewer, otherBarber: RatingViewer, molineManager: RatingViewer;
let coralvilleId: string;

beforeAll(async () => {
  admin = await viewerFor("Owner");
  manager = await viewerFor("Michelle");
  barber = await viewerFor("Makenna");
  otherBarber = await viewerFor("Jessica");
  molineManager = await viewerFor("Jen", { seesAll: true });
  coralvilleId = (await shopNamed("coralville")).id;
});

describe("rating a visit", () => {
  it("the barber who served the visit rates it, and the audit log records it with the shop", async () => {
    const c = await client("Rhett");
    const a = await visit({ customerId: c.id });
    const out = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 4, note: "  great tipper  " });
    expect(out.created).toBe(true);
    const row = (await m.db.db.query.clientRatings.findFirst({ where: eq(m.schema.clientRatings.id, out.id) }))!;
    expect(row).toMatchObject({ customerId: c.id, shopId: coralvilleId, appointmentId: a.id, staffId: barber.staffId, stars: 4, note: "great tipper" });
    const log = await auditFor(out.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "client_rating.create", shopId: coralvilleId });
    expect(log[0].details).toMatchObject({ customerId: c.id, stars: 4, note: "great tipper" });
  });

  it("rating the same visit again changes your rating instead of adding a second one", async () => {
    const c = await client("Rerate");
    const a = await visit({ customerId: c.id });
    const first = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 2, note: "late" });
    const again = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 3, note: "" });
    expect(again).toEqual({ id: first.id, created: false });
    const rows = await m.db.db.select().from(m.schema.clientRatings).where(eq(m.schema.clientRatings.customerId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stars: 3, note: null });
    const log = await auditFor(first.id);
    expect(log.map((l) => l.action)).toEqual(["client_rating.create", "client_rating.update"]);
    expect(log[1].details).toMatchObject({ stars: { from: 2, to: 3 }, note: { from: "late", to: null } });
  });

  it("rating from the receipt lands on the same visit as rating from the profile", async () => {
    const c = await client("Receipt");
    const a = await visit({ customerId: c.id });
    const s = await ticket({ customerId: c.id, appointmentId: a.id, staffId: barber.staffId });
    const fromProfile = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 5 });
    const fromReceipt = await r.rateVisit(barber, actor, { customerId: c.id, saleId: s.id, stars: 4 });
    expect(fromReceipt.id).toBe(fromProfile.id);
    const v = await r.visitForSale(barber, s.id);
    expect(v).toMatchObject({ customerId: c.id, appointmentId: a.id, saleId: s.id, myRating: { id: fromProfile.id, stars: 4 } });
  });

  it("a walk-in ticket with no appointment can be rated by the barber on the ticket", async () => {
    const c = await client("Walkin");
    const s = await ticket({ customerId: c.id, staffId: barber.staffId });
    const out = await r.rateVisit(barber, actor, { customerId: c.id, saleId: s.id, stars: 5 });
    const row = (await m.db.db.query.clientRatings.findFirst({ where: eq(m.schema.clientRatings.id, out.id) }))!;
    expect(row).toMatchObject({ appointmentId: null, saleId: s.id, shopId: coralvilleId });
    await expect(r.rateVisit(otherBarber, actor, { customerId: c.id, saleId: s.id, stars: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("only staff who served the visit, its shop's manager, or the brand admin may rate it", async () => {
    const c = await client("Perms");
    const a = await visit({ customerId: c.id });
    await expect(r.rateVisit(otherBarber, actor, { customerId: c.id, appointmentId: a.id, stars: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.rateVisit(molineManager, actor, { customerId: c.id, appointmentId: a.id, stars: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.rateVisit(manager, actor, { customerId: c.id, appointmentId: a.id, stars: 3 })).resolves.toMatchObject({ created: true });
    await expect(r.rateVisit(admin, actor, { customerId: c.id, appointmentId: a.id, stars: 4 })).resolves.toMatchObject({ created: true });
    expect(await r.visitForSale(otherBarber, (await ticket({ customerId: c.id, appointmentId: a.id })).id)).toBeNull();
  });

  it("a barber who rang up the ticket counts as having served the visit", async () => {
    const c = await client("Ringup");
    const a = await visit({ customerId: c.id, barber: "Delaney" });
    await ticket({ customerId: c.id, appointmentId: a.id, staffId: barber.staffId });
    await expect(r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 4 })).resolves.toMatchObject({ created: true });
  });

  it("rejects bad stars, long notes, and visits that didn't happen or aren't this client's", async () => {
    const c = await client("Invalid");
    const other = await client("Stranger");
    const a = await visit({ customerId: c.id });
    for (const stars of [0, 6, 3.5, "four", "", true, null]) {
      await expect(r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars })).rejects.toMatchObject({ code: "bad_request" });
    }
    await expect(r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 4, note: "x".repeat(501) })).rejects.toMatchObject({ code: "bad_request" });
    for (const status of ["booked", "cancelled"] as const) {
      const v = await visit({ customerId: c.id, status });
      await expect(r.rateVisit(barber, actor, { customerId: c.id, appointmentId: v.id, stars: 4 })).rejects.toMatchObject({ code: "bad_request" });
    }
    const noShow = await visit({ customerId: c.id, status: "no_show" });
    await expect(r.rateVisit(barber, actor, { customerId: c.id, appointmentId: noShow.id, stars: 1, note: "no-show" })).resolves.toMatchObject({ created: true });
    await expect(r.rateVisit(barber, actor, { customerId: other.id, appointmentId: a.id, stars: 4 })).rejects.toMatchObject({ code: "not_found" });
    const open = await ticket({ customerId: c.id, staffId: barber.staffId, status: "open" });
    await expect(r.rateVisit(barber, actor, { customerId: c.id, saleId: open.id, stars: 4 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(r.rateVisit(barber, actor, { customerId: c.id, stars: 4 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("the database refuses out-of-range stars and ratings with no visit even if the app is bypassed", async () => {
    const c = await client("Bypass");
    const a = await visit({ customerId: c.id });
    const base = { customerId: c.id, shopId: coralvilleId, staffId: barber.staffId };
    await expect(m.db.db.insert(m.schema.clientRatings).values({ ...base, appointmentId: a.id, stars: 7 })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.clientRatings).values({ ...base, appointmentId: a.id, stars: 0 })).rejects.toThrow();
    await expect(m.db.db.insert(m.schema.clientRatings).values({ ...base, stars: 3 })).rejects.toThrow();
    await m.db.db.insert(m.schema.clientRatings).values({ ...base, appointmentId: a.id, stars: 3 });
    await expect(m.db.db.insert(m.schema.clientRatings).values({ ...base, appointmentId: a.id, stars: 4 })).rejects.toThrow();
  });

  it("two simultaneous ratings of the same visit by the same barber leave one row", async () => {
    const c = await client("Race");
    const a = await visit({ customerId: c.id });
    const out = await Promise.allSettled([1, 2, 3, 4].map((stars) => r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars })));
    for (const o of out) if (o.status === "rejected") expect(o.reason).toMatchObject({ code: "conflict" });
    expect(out.some((o) => o.status === "fulfilled")).toBe(true);
    const rows = await m.db.db.select().from(m.schema.clientRatings).where(eq(m.schema.clientRatings.customerId, c.id));
    expect(rows).toHaveLength(1);
  });
});

describe("editing and removing", () => {
  it("each person edits only their own rating; the admin can remove any, and both are audited", async () => {
    const c = await client("Edits");
    const a = await visit({ customerId: c.id });
    const mine = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a.id, stars: 2, note: "difficult" });
    const mgr = await r.rateVisit(manager, actor, { customerId: c.id, appointmentId: a.id, stars: 4 });

    await expect(r.updateRating(barber, actor, mgr.id, { stars: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.updateRating(manager, actor, mine.id, { stars: 5 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.updateRating(admin, actor, mine.id, { stars: 5 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.deleteRating(barber, actor, mgr.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.deleteRating(manager, actor, mine.id)).rejects.toMatchObject({ code: "forbidden" });

    await expect(r.updateRating(barber, actor, mine.id, { stars: 3, note: "better today" })).resolves.toEqual({ id: mine.id, customerId: c.id });
    const edited = (await m.db.db.query.clientRatings.findFirst({ where: eq(m.schema.clientRatings.id, mine.id) }))!;
    expect(edited).toMatchObject({ stars: 3, note: "better today" });

    await r.deleteRating(admin, actor, mine.id);
    expect(await m.db.db.query.clientRatings.findFirst({ where: eq(m.schema.clientRatings.id, mine.id) })).toBeUndefined();
    const log = await auditFor(mine.id);
    expect(log.map((l) => l.action)).toEqual(["client_rating.create", "client_rating.update", "client_rating.delete"]);
    expect(log[2]).toMatchObject({ shopId: coralvilleId, details: { customerId: c.id, ratedBy: barber.staffId, stars: 3, note: "better today" } });

    await r.deleteRating(manager, actor, mgr.id);
    await expect(r.updateRating(manager, actor, mgr.id, { stars: 4 })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("reading ratings", () => {
  it("managers and the admin see every rating; a barber sees only their own but the same average", async () => {
    const c = await client("History");
    const a1 = await visit({ customerId: c.id });
    const a2 = await visit({ customerId: c.id, barber: "Jessica" });
    await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: a1.id, stars: 2, note: "late" });
    await r.rateVisit(otherBarber, actor, { customerId: c.id, appointmentId: a2.id, stars: 5, note: "great tipper" });
    await r.rateVisit(manager, actor, { customerId: c.id, appointmentId: a2.id, stars: 5 });

    for (const v of [manager, admin, molineManager]) expect(await r.ratingHistory(v, c.id)).toHaveLength(3);
    const own = await r.ratingHistory(barber, c.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ stars: 2, note: "late", ratedBy: "Makenna", shop: "Coralville", appointmentId: a1.id, mine: true });
    expect(own[0].visitAt?.getTime()).toBe(a1.startsAt.getTime());

    const sum = await r.ratingSummary(c.id);
    expect(sum.count).toBe(3);
    expect(sum.avg).toBeCloseTo(4);
    expect(sum.byStars).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 2 });
    const badges = await r.ratingSummaries([c.id, null, (await client("Nobody")).id]);
    expect(badges.size).toBe(1);
    expect(badges.get(c.id)!.avg).toBeCloseTo(4);
  });

  it("the visit picker lists only visits this viewer may rate, with their own rating attached", async () => {
    const c = await client("Picker");
    const mine = await visit({ customerId: c.id });
    const theirs = await visit({ customerId: c.id, barber: "Jessica" });
    await visit({ customerId: c.id, status: "booked" });
    const walkIn = await ticket({ customerId: c.id, staffId: barber.staffId });
    const rated = await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: mine.id, stars: 4 });

    const forBarber = await r.rateableVisits(barber, c.id);
    expect(forBarber.map((v) => v.appointmentId ?? v.saleId).sort()).toEqual([mine.id, walkIn.id].sort());
    expect(forBarber.find((v) => v.appointmentId === mine.id)!.myRating).toMatchObject({ id: rated.id, stars: 4 });
    expect((await r.rateableVisits(manager, c.id)).map((v) => v.appointmentId ?? v.saleId).sort()).toEqual([mine.id, theirs.id, walkIn.id].sort());
    expect(await r.rateableVisits(molineManager, c.id)).toEqual([]);
  });

  it("merging duplicate clients carries the ratings over", async () => {
    const keep = await client("Keep");
    const drop = await client("Drop");
    const a = await visit({ customerId: drop.id });
    const rated = await r.rateVisit(barber, actor, { customerId: drop.id, appointmentId: a.id, stars: 5 });
    await m.customers.mergeCustomers(keep.id, drop.id, actor);
    const row = (await m.db.db.query.clientRatings.findFirst({ where: eq(m.schema.clientRatings.id, rated.id) }))!;
    expect(row.customerId).toBe(keep.id);
    expect((await r.ratingSummary(keep.id)).count).toBe(1);
  });
});

describe("lowest- and highest-rated clients by shop", () => {
  // Dubuque has no seeded ratings, so the expected lists are exact.
  async function rateAtDubuque(name: string, stars: number[], at?: Date) {
    const c = await client(name, "Dubuque");
    for (const s of stars) {
      const t = await ticket({ customerId: c.id, shop: "dubuque" });
      await r.rateVisit(admin, actor, { customerId: c.id, saleId: t.id, stars: s, note: `${name} ${s}` }, at);
    }
    return c;
  }

  it("ranks clients by their average at that shop and never lists anyone twice", async () => {
    const dubuque = await shopNamed("dubuque");
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    const low = await rateAtDubuque("Lowe", [1, 2]);
    const mid = await rateAtDubuque("Middle", [3]);
    const high = await rateAtDubuque("Hyde", [5, 5]);
    const good = await rateAtDubuque("Goode", [4, 5]);
    const old = await rateAtDubuque("Olden", [1], longAgo);

    const [all] = await r.ratingsByShop({ shopIds: [dubuque.id], limit: 10 });
    expect(all.shop).toBe("Dubuque");
    expect(all.ratedClients).toBe(5);
    expect(all.lowest.map((x) => x.customerId)).toEqual([old.id, low.id, mid.id]);
    expect(all.highest.map((x) => x.customerId)).toEqual([high.id, good.id]);
    expect(all.lowest[1]).toMatchObject({ name: "Lowe D.", avg: 1.5, count: 2, lastNote: "Lowe 2" });
    const [named] = await r.ratingsByShop({ shopIds: [dubuque.id], limit: 10, name: (f, l) => `${f} ${l}` });
    expect(named.lowest[1].name).toBe("Lowe Dubuque");

    const [top] = await r.ratingsByShop({ shopIds: [dubuque.id], limit: 1 });
    expect(top.lowest.map((x) => x.customerId)).toEqual([old.id]);
    expect(top.highest.map((x) => x.customerId)).toEqual([high.id]);

    const [recent] = await r.ratingsByShop({ shopIds: [dubuque.id], since: new Date(Date.now() - 90 * 86_400_000) });
    expect(recent.ratedClients).toBe(4);
    expect([...recent.lowest, ...recent.highest].map((x) => x.customerId)).not.toContain(old.id);

    const [repeat] = await r.ratingsByShop({ shopIds: [dubuque.id], minRatings: 2 });
    expect(repeat.ratedClients).toBe(3);
    expect(repeat.lowest.map((x) => x.customerId)).toEqual([low.id, good.id]);
    expect(repeat.highest.map((x) => x.customerId)).toEqual([high.id]);
  });

  it("only reports the shops asked for, and a rating at one shop doesn't count at another", async () => {
    const dubuque = await shopNamed("dubuque");
    const c = await client("Twoshop");
    await r.rateVisit(barber, actor, { customerId: c.id, appointmentId: (await visit({ customerId: c.id })).id, stars: 1 });
    const out = await r.ratingsByShop({ shopIds: [dubuque.id] });
    expect(out.map((s) => s.shopId)).toEqual([dubuque.id]);
    expect([...out[0].lowest, ...out[0].highest].map((x) => x.customerId)).not.toContain(c.id);
    const [cv] = await r.ratingsByShop({ shopIds: [coralvilleId], limit: 500 });
    expect(cv.lowest.map((x) => x.customerId)).toContain(c.id);
    expect(await r.ratingsByShop({ shopIds: [] })).toEqual([]);
  });
});

describe("ratings never reach customers", () => {
  const SECRET = "SECRET-NOTE-do-not-show";
  const leaks = (text: string) => [SECRET, "rating", "stars", "client_rating"].filter((w) => text.toLowerCase().includes(w.toLowerCase()));

  let customerId: string;
  let code: string;
  let token: string;

  beforeAll(async () => {
    const c = await client("Private", "Client");
    customerId = c.id;
    const a = await visit({ customerId });
    code = a.code;
    await r.rateVisit(barber, actor, { customerId, appointmentId: a.id, stars: 1, note: SECRET });
    await r.rateVisit(manager, actor, { customerId, appointmentId: a.id, stars: 2, note: SECRET });
    token = (await m.auth.issueTokens(customerId, null)).accessToken;
  });

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
    });
  }

  it("no GET under /api/v1 returns a rating, star count or note for the signed-in client", async () => {
    const svc = (await m.public.publicServices("coralville")).services[0];
    const date = m.time.addDays(m.time.todayLocal(), 5);
    const root = path.resolve(__dirname, "../../src/app/api/v1");
    const files = routeFiles(root);
    expect(files.length).toBeGreaterThan(10);
    const params: Record<string, string> = { shop: "coralville", slug: "coralville", code };
    let checked = 0;
    for (const file of files) {
      const mod = (await import(file)) as { GET?: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> };
      if (!mod.GET) continue;
      const rel = path.relative(root, path.dirname(file));
      const segs = rel ? rel.split(path.sep) : [];
      const p: Record<string, string> = {};
      const urlPath = segs.map((s) => {
        const k = s.match(/^\[(.+)\]$/)?.[1];
        if (!k) return s;
        p[k] = params[k];
        return p[k];
      });
      const url = new URL(`http://localhost/api/v1/${urlPath.join("/")}`);
      url.search = new URLSearchParams({ date, from: date, serviceId: svc.id, days: "7" }).toString();
      const res = await mod.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve(p) });
      const text = await res.text();
      // No receipt, ticket or family booking group is set up for this client; a 404 returns nothing.
      if (res.status === 404 && (segs.includes("[id]") || rel === path.join("me", "family", "booking-groups", "[code]"))) continue;
      expect(res.status, `${rel}: ${text.slice(0, 200)}`).toBeLessThan(400);
      expect(leaks(text), rel).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("booking, updating the profile and signing in as that client return nothing about ratings", async () => {
    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    let slot: string | undefined;
    for (let i = 6; i < 25 && !slot; i++) {
      const a = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(m.time.todayLocal(), i), serviceId: svc.id, barberRef: "any" });
      slot = a.slots.at(-1)?.startsAt;
    }
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const appts = await import("@/app/api/v1/appointments/route");
    const booked = await appts.POST(new Request("http://localhost/api/v1/appointments", { method: "POST", headers: auth, body: JSON.stringify({ shopId: "coralville", serviceId: svc.id, startsAt: slot }) }), { params: Promise.resolve({}) });
    const bookedText = await booked.text();
    expect(booked.status, bookedText).toBe(201);
    expect(leaks(bookedText)).toEqual([]);

    const me = await import("@/app/api/v1/me/route");
    const patched = await me.PATCH(new Request("http://localhost/api/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ firstName: "Private" }) }), { params: Promise.resolve({}) });
    expect(patched.status).toBe(200);
    expect(leaks(await patched.text())).toEqual([]);

    const tokens = await m.auth.issueTokens(customerId, "test");
    const payloads = [
      await m.public.publicMe(customerId),
      await m.public.myAppointments(customerId),
      await m.booking.getAppointmentByCode(code),
      await m.public.tokenResponse({ ...tokens, isNew: false, customer: { id: customerId } }),
    ];
    for (const p of payloads) expect(leaks(JSON.stringify(p))).toEqual([]);
  });

  it("the OpenAPI document doesn't describe ratings", async () => {
    const { openApiDocument } = await import("@/server/openapi");
    expect(leaks(JSON.stringify(openApiDocument("http://localhost")))).toEqual([]);
  });

  it("the rating was really there to leak", async () => {
    const rows = await r.ratingHistory(manager, customerId);
    expect(rows.map((x) => x.note)).toEqual([SECRET, SECRET]);
  });
});