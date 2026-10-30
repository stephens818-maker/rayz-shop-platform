/**
 * One client profile for the whole brand, against a real database: staff at any shop find and book
 * a client from another shop by any part of their name; the client list is every shop's clients,
 * with home shop and shops visited as columns and filters while exports keep to the exporter's
 * shops; visits, loyalty, gift cards, ratings, cadence, badges and family add up across shops;
 * a shared shop login sees the visit history at every shop but no other shop's prices, tickets or
 * spend; a Squire file listing the same client at two shops ends as one profile (by phone, or by
 * name and birthday), with uncertain matches waiting on the duplicates page; and a merge of two
 * records that both have badges goes through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatCents } from "@/lib/money";
import { Mods, actor, loadModules } from "./setup";
import { get, open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh() {}, push() {} }) }));

let m: Mods;
type Ctx = import("@/server/auth/staff").StaffContext;
type Client = typeof import("@/db/schema").customers.$inferSelect;

const LOGINS = ["owner", "frontdesk", "makenna", "michelle", "manager.moline", "coralville", "moline"] as const;
type Login = (typeof LOGINS)[number];
const people = {} as Record<Login, string>;
const shop: Record<string, string> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
/** Shop staff work at their shop; shop logins have only theirs. */
const HOME: Partial<Record<Login, string>> = { frontdesk: "coralville", makenna: "coralville", michelle: "coralville", coralville: "coralville" };
const as = (l: Login) => signInAs(people[l], HOME[l] ? shop[HOME[l]] : undefined);
async function ctxAs(l: Login): Promise<Ctx> {
  await as(l);
  const { getStaffContext } = await import("@/server/auth/staff");
  return (await getStaffContext())!;
}

const c = {} as Record<"mollie" | "pip" | "otto", Client>;
const visit = {} as Record<"moline" | "coralville", { appt: string; sale: string; total: number; serviceNet: number; number: number }>;
const GIFT = "CWGC-8701-0000-0001";
const TAG = "fx-company-wide";
let slot = 0;

async function appointment(o: { shop: string; staffId: string; customerId: string; item: string; status?: "booked" | "completed"; daysAgo?: number }) {
  const today = m.time.todayLocal();
  const startsAt = m.time.zonedWallTime(m.time.addDays(today, -(o.daysAgo ?? 0)), 20 + 35 * slot++).toJSDate();
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `W${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: shop[o.shop],
      staffId: o.staffId,
      customerId: o.customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: o.status ?? "booked",
      source: "staff",
      estimateCents: 2300,
      completedAt: o.status === "completed" ? new Date(startsAt.getTime() + 30 * 60_000) : null,
    })
    .returning();
  await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, kind: "service", name: o.item, priceCents: 2300, durationMin: 30 });
  return a;
}

/** A visit checked out at the shop: the ticket earns loyalty, and the visit can be moved back in time. */
async function paidVisit(at: "moline" | "coralville", staffId: string, item: string, tipCents: number, daysAgo: number) {
  const a = await appointment({ shop: at, staffId, customerId: c.mollie.id, item });
  const sale = await m.checkout.openSaleForAppointment(a.id, actor);
  const service = (await m.catalog.shopCatalog(shop[at]))[0];
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: service.id, qty: 1 }], tipCents, tender: { method: "cash", cashTenderedCents: null }, actor });
  if (daysAgo) {
    const back = (d: Date) => new Date(d.getTime() - daysAgo * 86_400_000);
    await m.db.db.update(s().appointments).set({ startsAt: back(a.startsAt), endsAt: back(a.endsAt), completedAt: back(a.endsAt) }).where(eq(s().appointments.id, a.id));
    await m.db.db.update(s().sales).set({ businessDate: m.time.addDays(m.time.todayLocal(), -daysAgo) }).where(eq(s().sales.id, sale.id));
  }
  const paid = (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, sale.id) }))!;
  return { appt: a.id, sale: sale.id, total: paid.totalCents, serviceNet: paid.serviceNetCents, number: paid.number! };
}

beforeAll(async () => {
  m = await loadModules();
  for (const x of await m.db.db.select().from(s().shops)) shop[x.slug] = x.id;
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, `${l}@rayz.test`) }))!.id;
  const barberAt = async (slug: string, not: string[] = []) =>
    (await m.db.db.select({ id: s().staffShops.staffId }).from(s().staffShops).where(eq(s().staffShops.shopId, shop[slug]))).map((r) => r.id).find((id) => !not.includes(id))!;
  const molineBarber = await barberAt("moline");
  const coralBarber = await barberAt("coralville", [people.makenna]);

  const ins = async (v: typeof import("@/db/schema").customers.$inferInsert) => (await m.db.db.insert(s().customers).values(v).returning())[0];
  c.mollie = await ins({ firstName: "Mollie", lastName: "Crosstown", phone: "+13095558701", email: "mollie.crosstown@example.test", homeShopId: shop.moline, birthday: "1991-05-14" });
  c.pip = await ins({ firstName: "Pipwick", lastName: "Crosstown", guardianId: c.mollie.id, birthday: "2017-08-02" });
  c.otto = await ins({ firstName: "Otto", lastName: "Molineonly", phone: "+13095558702", homeShopId: shop.moline });
  await appointment({ shop: "moline", staffId: molineBarber, customerId: c.otto.id, item: "Ray'z Cut", status: "completed", daysAgo: 12 });

  visit.moline = await paidVisit("moline", molineBarber, "Molinecross Taper", 1300, 30);
  visit.coralville = await paidVisit("coralville", coralBarber, "Coralcross Cut", 0, 0);
  await m.db.db.insert(s().clientRatings).values([
    { customerId: c.mollie.id, shopId: shop.moline, appointmentId: visit.moline.appt, staffId: molineBarber, stars: 5 },
    { customerId: c.mollie.id, shopId: shop.coralville, appointmentId: visit.coralville.appt, staffId: coralBarber, stars: 3 },
  ]);
  await m.db.db.insert(s().giftCards).values({ code: GIFT, initialCents: 2500, balanceCents: 2500, customerId: c.mollie.id, issuedShopId: shop.moline });
  await m.db.db.insert(s().customerTags).values({ customerId: c.mollie.id, tag: TAG });
}, 180_000);

afterAll(async () => {
  await signInAs(null);
});

describe("staff at any shop find and book any client", () => {
  it("a Moline client by part of her name, her child's name, a whole number or a gift card, from Coralville's desk, chair and POS", async () => {
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    for (const who of ["frontdesk", "makenna", "coralville", "michelle"] as const) {
      await as(who);
      for (const [q, via] of [["Crosstown", "booking"], ["mollie cross", "pos"], ["Molie Crostown", "walk_in"], ["(309) 555-8701", "booking"], [GIFT, "pos"]] as const) {
        const r = await searchCustomersAction(q, via);
        expect(r.ok && r.data.map((h) => h.id), `${who} ${q}`).toContain(c.mollie.id);
      }
      const kid = await searchCustomersAction("Pipwick");
      expect(kid.ok && kid.data.map((h) => h.id).slice(0, 2), who).toEqual([c.pip.id, c.mollie.id]);
    }
    await as("makenna");
    const hit = await searchCustomersAction("Mollie Crosstown");
    expect(hit.ok && hit.data[0]).toMatchObject({ id: c.mollie.id, lastVisit: { shop: "Coralville" } });
    for (const secret of ["mollie.crosstown@example.test", "555-8701", "5558701"]) expect(JSON.stringify(hit)).not.toContain(secret);
  });

  it("the Coralville desk books her at Coralville; it's the same profile, not a copy", async () => {
    const { createStaffAppointmentAction } = await import("@/app/admin/calendar/actions");
    const service = (await m.catalog.shopCatalog(shop.coralville)).find((x) => x.slug === "rayz-cut")!;
    const today = m.time.todayLocal();
    let at: string | undefined;
    for (let i = 3; i < 30 && !at; i++) at = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: service.id, barberRef: people.makenna })).slots.at(-1)?.startsAt;
    expect(at, "makenna has an open slot").toBeTruthy();
    const before = (await m.db.db.select().from(s().customers)).length;
    await as("frontdesk");
    const r = await createStaffAppointmentAction({ shopId: shop.coralville, staffId: people.makenna, date: m.time.localDateOf(at!), startMin: m.time.localMinutesOf(at!), serviceId: service.id, addonIds: [], customerId: c.mollie.id });
    expect(r).toMatchObject({ ok: true });
    expect((await m.db.db.select().from(s().customers)).length).toBe(before);
    const booked = await m.db.db.query.appointments.findFirst({ where: eq(s().appointments.code, r.ok ? r.data.code : "") });
    expect(booked).toMatchObject({ customerId: c.mollie.id, shopId: shop.coralville });
    expect((await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, c.mollie.id) }))!.homeShopId).toBe(shop.moline);
  });
});

describe("the client list is the brand's", () => {
  const listText = async (who: Login, sp: Record<string, string> = {}) => {
    await as(who);
    const r = await open("/admin/customers", {}, sp);
    if (r.kind !== "ok") throw new Error(`client list: ${r.kind}`);
    return r.text!;
  };

  it("every shop's desk lists every client, with their home shop and every shop they've visited", async () => {
    for (const who of ["frontdesk", "coralville", "michelle", "manager.moline"] as const) {
      const text = await listText(who);
      expect(text, who).toContain("Every Ray'z client");
      expect(text, who).toContain("Otto M.");
      expect(text, who).toContain("Mollie C.");
      expect(text, who).not.toContain("Molineonly");
      expect(text, who).toContain("Coralville, Moline");
      expect(text, who).toContain("Shops visited");
      expect(text, who).not.toContain("mollie.crosstown@example.test");
      expect(text, who).not.toContain("555-8701");
    }
    expect(await listText("frontdesk", { q: "molineonly" })).toContain("Otto M.");
    expect(await listText("owner")).toContain("Otto Molineonly");
  });

  it("barbers' own list stays the people they've cut", async () => {
    const text = await listText("makenna");
    expect(text).toContain("Clients you've had in your chair");
    expect(text).not.toContain("Otto Molineonly");
  });

  it("home shop and shops visited filter the list; an export is a report and keeps to the exporter's shops", async () => {
    const { encodeFilter } = await import("@/domain/client-filters");
    const { SegmentSchema } = await import("@/domain/marketing");
    const f = (x: object) => encodeFilter(SegmentSchema.parse(x));
    const visitedMoline = await listText("owner", { f: f({ visitedShopIds: [shop.moline] }), q: "Crosstown" });
    expect(visitedMoline).toContain("Mollie Crosstown");
    const homeCoralville = await listText("owner", { f: f({ homeShopIds: [shop.coralville] }), q: "Crosstown" });
    expect(homeCoralville).not.toContain("Mollie Crosstown");

    const { clientListQuery } = await import("@/server/client-list");
    const { clientPolicy } = await import("@/server/client-privacy");
    const ctx = await ctxAs("michelle");
    const policy = await clientPolicy(ctx);
    const reach = async (purpose: "list" | "export") => {
      const q = await clientListQuery(ctx, policy, { q: "", purpose });
      return (await m.db.db.select({ id: s().customers.id }).from(s().customers).where(q.where)).map((r) => r.id);
    };
    const list = await reach("list");
    const exported = await reach("export");
    expect(list).toEqual(expect.arrayContaining([c.mollie.id, c.otto.id]));
    expect(exported).toContain(c.mollie.id);
    expect(exported).not.toContain(c.otto.id);
  });
});

describe("one profile adds up every shop", () => {
  it("visits, cadence, loyalty, ratings, badges, gift cards and family", async () => {
    const stats = await m.customers.customerStats(c.mollie.id);
    expect(stats).toMatchObject({ visits: 2, tickets: 2, ticketSpendCents: visit.moline.serviceNet + visit.coralville.serviceNet });
    const { clientCadence } = await import("@/server/visit-cadence");
    expect((await clientCadence(c.mollie.id, new Date())).cadence.cadenceDays).toBe(30);
    const earned = await m.db.db.select().from(s().loyaltyLedger).where(eq(s().loyaltyLedger.customerId, c.mollie.id));
    expect(new Set(earned.map((e) => e.saleId))).toEqual(new Set([visit.moline.sale, visit.coralville.sale]));
    const loyalty = await m.loyalty.loyaltyBalance(c.mollie.id);
    expect(loyalty.progressCents + loyalty.availableCents).toBeGreaterThan(0);
    const { ratingSummary } = await import("@/server/ratings");
    expect(await ratingSummary(c.mollie.id)).toMatchObject({ avg: 4, count: 2 });
    const { badgeFacts } = await import("@/server/badges");
    const { loadBadgeSettings } = await import("@/server/badge-settings");
    const facts = (await badgeFacts([c.mollie.id], new Date(), (await loadBadgeSettings()).thresholds)).get(c.mollie.id)!;
    expect(facts.visits).toHaveLength(2);
    expect(facts.spendCents).toBe(visit.moline.serviceNet + visit.coralville.serviceNet);
    expect(await m.checkout.lookupGiftCard(GIFT)).toMatchObject({ balanceCents: 2500 });
    expect((await m.db.db.query.giftCards.findFirst({ where: eq(s().giftCards.code, GIFT) }))!.customerId).toBe(c.mollie.id);

    await as("frontdesk");
    const p = await open("/admin/customers/[id]", { id: c.mollie.id });
    expect(p.kind).toBe("ok");
    for (const x of ["Moline", "Coralville", "Molinecross Taper", "Coralcross Cut", "3 appointments at every Ray'z shop", "Home shop Moline", "Pipwick", "Lifetime spend", formatCents(visit.moline.total)]) expect(p.text, x).toContain(x);
  });
});

describe("a shared shop login sees the history, not another shop's money", () => {
  it("Coralville's login: when, where and what at Moline, but Moline's prices, ticket and spend stay out", async () => {
    await as("coralville");
    const p = await open("/admin/customers/[id]", { id: c.mollie.id });
    expect(p.kind).toBe("ok");
    const text = p.text!;
    for (const x of ["Moline", "Molinecross Taper", "Coralcross Cut", "3 appointments at every Ray'z shop", "Prices show for this shop's visits only", "Spend at Coralville", "1 ticket at this shop"])
      expect(text, x).toContain(x);
    expect(text).toContain(formatCents(visit.coralville.total));
    expect(text).not.toContain(formatCents(visit.moline.total));
    expect(text).not.toContain("Lifetime spend");
    expect(text).not.toContain(`/admin/sales/${visit.moline.sale}`);
    expect(text).toContain(`/admin/sales/${visit.coralville.sale}`);
    expect(text).toContain(`${formatCents(visit.coralville.serviceNet)} after refunds`);
  });

  it("their reports and the report builder cover only their shop", async () => {
    const exp = (await import("@/app/admin/reports/export/route")).GET;
    await as("coralville");
    expect((await get(exp, `/admin/reports/export?type=sales_summary&shop=${shop.moline}`)).status).toBe(403);

    const engine = await import("@/server/report-builder/engine");
    const { staffContextFor } = await import("@/server/report-builder/context");
    const { clientPolicy } = await import("@/server/client-privacy");
    const rb = await import("@/domain/report-builder");
    const ctx = (await staffContextFor(people.coralville))!;
    const { SegmentSchema } = await import("@/domain/marketing");
    const def = rb.ReportDefinition.parse({
      shops: "all",
      columns: [{ field: "name" }, { field: "visits" }, { field: "total_spend" }, { field: "locations_visited" }],
      filter: SegmentSchema.parse({ tags: [TAG] }),
    });
    const r = await engine.runReport(ctx, await clientPolicy(ctx), def, { pageSize: 50 });
    const line = r.lines.find((l) => l.kind === "row" && l.id === c.mollie.id);
    expect(line, "Mollie is Coralville's client too").toBeTruthy();
    const cells = line!.cells;
    expect(cells[1]).toBe(1);
    expect(cells[2]).toBe(visit.coralville.serviceNet);
    expect(cells[3]).toEqual(["Coralville", "Moline"]);
  }, 60_000);
});

describe("Squire: one profile per client across Squire shops", () => {
  const CSV = [
    "Client ID,First Name,Last Name,Phone,Email,Location,Birthday",
    // The same phone and name at two shops: the importer folds them together.
    "SQ-CW-1,Brooklyn,Twoshop,(319) 555-8801,,Coralville,4/12/1990",
    "SQ-CW-2,Brooklyn,Twoshop,(319) 555-8801,,Moline,",
    // A phone at one shop, an email at the other, the same name and birthday: merged afterwards.
    "SQ-CW-3,Dario,Bdaymatch,(319) 555-8802,,Coralville,4/1/1985",
    "SQ-CW-4,Dario,Bdaymatch,,dario.bday@example.test,Moline,1985-04-01",
    // The same name and birthday but two different phones: for a person to decide.
    "SQ-CW-5,Elena,Conflicto,(319) 555-8803,,Coralville,7/7/1979",
    "SQ-CW-6,Elena,Conflicto,(309) 555-8804,,Moline,7/7/1979",
    // The same name, no birthday, different phones: two clients.
    "SQ-CW-7,Fynn,Nobday,(319) 555-8805,,Coralville,",
    "SQ-CW-8,Fynn,Nobday,(309) 555-8806,,Moline,",
  ].join("\n");
  const owner = async (squireId: string) => (await m.db.db.query.customerSquireIds.findFirst({ where: eq(s().customerSquireIds.squireId, squireId) }))!.customerId;

  it("a dry run says who'll become one; the import makes one profile each, and leaves the uncertain pair for review", async () => {
    const { importAction } = await import("@/app/admin/import/actions");
    await as("owner");
    const dry = await importAction({ kind: "clients", csv: CSV, dryRun: true });
    expect(dry.ok && dry.data.reconcile).toMatchObject({ withBirthday: 5, inFile: 2, merged: 0 });
    expect(await m.db.db.query.customerSquireIds.findFirst({ where: eq(s().customerSquireIds.squireId, "SQ-CW-1") })).toBeUndefined();

    const run = await importAction({ kind: "clients", csv: CSV, dryRun: false });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.stats).toMatchObject({ duplicatesMerged: 1 });
    expect(run.data.reconcile).toMatchObject({ birthdaysFilled: 5, merged: 1, review: 1, problems: [] });

    expect(await owner("SQ-CW-1")).toBe(await owner("SQ-CW-2"));
    const brooklyn = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, await owner("SQ-CW-1")) }))!;
    expect(brooklyn).toMatchObject({ birthday: "1990-04-12", homeShopId: shop.coralville });

    const dario = await owner("SQ-CW-3");
    expect(await owner("SQ-CW-4")).toBe(dario);
    expect(await m.db.db.select().from(s().customers).where(eq(s().customers.lastName, "Bdaymatch"))).toHaveLength(1);
    expect(await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, dario) })).toMatchObject({
      phone: "+13195558802",
      email: "dario.bday@example.test",
      birthday: "1985-04-01",
    });
    const squireIds = await m.db.db.select().from(s().customerSquireIds).where(eq(s().customerSquireIds.customerId, dario));
    expect(squireIds.map((x) => x.squireId).sort()).toEqual(["SQ-CW-3", "SQ-CW-4"]);

    expect(await owner("SQ-CW-5")).not.toBe(await owner("SQ-CW-6"));
    expect(await owner("SQ-CW-7")).not.toBe(await owner("SQ-CW-8"));
    const pairs = await m.customers.duplicatePairs({ squireOnly: true, limit: 500 });
    const elena = pairs.find((p) => p.a.lastName === "Conflicto" && p.b.lastName === "Conflicto");
    expect(elena).toMatchObject({ kind: "likely", signals: expect.arrayContaining(["same_name", "birthday"]) });
    const page = await open("/admin/customers/duplicates", {}, { from: "squire" });
    expect(page.text).toContain("Conflicto");
  }, 120_000);

  it("re-running the file changes nothing, and a pair marked 'not the same person' stays apart", async () => {
    const { importAction } = await import("@/app/admin/import/actions");
    await as("owner");
    const [e5, e6] = [await owner("SQ-CW-5"), await owner("SQ-CW-6")];
    await m.customers.dismissDuplicate(e5, e6, actor);
    const again = await importAction({ kind: "clients", csv: CSV, dryRun: false });
    expect(again.ok && again.data.reconcile).toMatchObject({ birthdaysFilled: 0, merged: 0, review: 0 });
    expect(await m.db.db.select().from(s().customers).where(eq(s().customers.lastName, "Bdaymatch"))).toHaveLength(1);
    expect(await owner("SQ-CW-5")).toBe(e5);
    expect(await owner("SQ-CW-6")).toBe(e6);
  }, 120_000);
});

describe("merging", () => {
  it("two records that both have badges merge, and the kept profile's badges are worked out again", async () => {
    const ins = async (v: typeof import("@/db/schema").customers.$inferInsert) => (await m.db.db.insert(s().customers).values(v).returning())[0];
    const keep = await ins({ firstName: "Badger", lastName: "Mergetwice", phone: "+13195558810" });
    const drop = await ins({ firstName: "Badger", lastName: "Mergetwice", email: "badger@example.test" });
    const { refreshBadges } = await import("@/server/badges");
    await refreshBadges([keep.id, drop.id], new Date());
    const cached = (id: string) => m.db.db.select().from(s().clientBadges).where(eq(s().clientBadges.customerId, id));
    expect(await cached(keep.id)).toHaveLength(1);
    expect(await cached(drop.id)).toHaveLength(1);
    await m.customers.mergeCustomers(keep.id, drop.id, actor);
    expect(await cached(drop.id)).toHaveLength(0);
    const [row] = await cached(keep.id);
    expect(row.computedOn < m.time.todayLocal()).toBe(true);
  });
});
