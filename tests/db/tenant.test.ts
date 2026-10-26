/**
 * Shop workspaces. Coralville gets "canary" records carrying unique strings: a client, a barber who
 * works only there, a visit, a sale, a rating, a purchase order, a count, a transfer, a drawer, a
 * text message, a promo, a gift card, a walk-in, a time block and an audit entry. Then the Moline
 * shop login, Moline's manager, the regional manager (Moline and Rock Island) and Kat (a barber at
 * Moline and Silvis who manages Rock Island) open every admin page, by direct URL and with
 * Coralville in the query string, download every export, call the API, and aim every server action
 * at those records. No canary may appear anywhere except the client themselves, who is the brand's
 * (their name and home shop on the client list, their profile and visit history at every shop);
 * every action must be refused as "not found" or "outside your access", and nothing may change.
 * The brand owner sees every canary, so their absence means something.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PAGE_ACCESS } from "@/domain/navigation";
import { Mods, actor, loadModules } from "./setup";
import { found, get, open, textOf } from "./render";
import { jar, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);

const CANARY = {
  first: "Quillon",
  last: "Canaryfield",
  phone: "+13195557731",
  email: "quillon.canary@example.test",
  barber: "Canarybarber",
  floater: "Floaterbird",
  item: "Canaryitem Fade",
  apptNote: "CANARY-APPT-NOTE",
  floatNote: "CANARY-FLOAT-NOTE",
  ratingNote: "CANARY-RATING-NOTE",
  sharedRatingNote: "CANARY-SHARED-RATING",
  voidReason: "CANARY-VOID-REASON",
  poNote: "CANARY-PO-NOTE",
  poEmail: "CANARY-PO-EMAIL",
  countNote: "CANARY-COUNT-NOTE",
  transferNote: "CANARY-TRANSFER-NOTE",
  drawerNote: "CANARY-DRAWER-NOTE",
  sms: "CANARY-SMS-BODY",
  promo: "CANARYPROMO7731",
  giftCard: "CANARYGC7731",
  waitName: "Wendell Canarywait",
  waitNote: "CANARY-WAIT-NOTE",
  block: "CANARY-BLOCK-REASON",
  audit: "CANARY-AUDIT-ENTRY",
  address: "1701 2nd Street",
};
const CLIENT_NAME = `${CANARY.first} ${CANARY.last}`;
/** Records at Moline and at Rock Island, for checking that Kat sees only the shop she's working in. */
const MARK = {
  moline: { appt: "MARKER-MOLINE-APPT", promo: "MARKERMOLINE77", drawer: "MARKER-MOLINE-DRAWER" },
  ri: { appt: "MARKER-RI-APPT", promo: "MARKERRI77", drawer: "MARKER-RI-DRAWER" },
};
/** Never shown to anyone outside Coralville. */
const SECRETS = [
  CANARY.last,
  CANARY.email,
  "555-7731",
  "5557731",
  CANARY.barber,
  CANARY.item,
  CANARY.apptNote,
  CANARY.floatNote,
  CANARY.ratingNote,
  CANARY.sharedRatingNote,
  CANARY.voidReason,
  CANARY.poNote,
  CANARY.poEmail,
  CANARY.countNote,
  CANARY.transferNote,
  CANARY.drawerNote,
  CANARY.sms,
  CANARY.promo,
  CANARY.giftCard,
  CANARY.waitName,
  CANARY.block,
  CANARY.audit,
  CANARY.address,
];
/** A client's visit history follows them: any shop sees the barber, services and amounts of their visits at every shop. */
const VISIT_HISTORY = [CANARY.barber, CANARY.item];
/** What a shop user may not see even on a brand client's profile: other shops' notes, ratings, tickets and operations. */
const OTHER_SHOP_DETAIL = SECRETS.filter((s) => ![CANARY.last, CANARY.email, "555-7731", "5557731", ...VISIT_HISTORY].includes(s));
/** The client list is the brand's one client book: every shop's clients by name, with contact masked, home shop and shops visited. */
const CLIENT_LIST = "/admin/customers";
const ON_CLIENT_LIST = SECRETS.filter((s) => s !== CANARY.last);

const shop: Record<string, string> = {};
const people: Record<string, string> = {};
const ids = {} as {
  client: string;
  shared: string;
  barber: string;
  floater: string;
  appt: string;
  floatAppt: string;
  sale: string;
  saleItem: string;
  openSale: string;
  rating: string;
  po: string;
  poJob: string;
  count: string;
  transfer: string;
  drawer: string;
  smsJob: string;
  promo: string;
  giftCard: string;
  wait: string;
  block: string;
  reason: string;
  product: string;
  vendor: string;
  service: string;
  molineBarber: string;
  callIn: string;
  thread: string;
  tipBatch: string;
  tipPayout: string;
  blast: string;
  sequence: string;
  campaign: string;
  savedReport: string;
  marks: Record<keyof typeof MARK, { appt: string; promo: string; sale: string }>;
};
let today: string;

const MOLINE_SIDE = ["moline", "manager.moline", "regional"] as const;
type Login = (typeof MOLINE_SIDE)[number] | "owner" | "kat";
const email = (l: Login) => (l === "moline" ? "moline@rayz.test" : `${l}@rayz.test`);
const as = (l: Login | null, shopCookie?: string) => signInAs(l ? people[l] : null, shopCookie);
/** Everyone outside Coralville under test, with the shop they're working in: Kat in the shop she manages and one where she's a barber. */
const OUTSIDERS: { name: string; login: Login; at?: () => string }[] = [
  ...MOLINE_SIDE.map((login) => ({ name: login, login })),
  { name: "kat at Rock Island", login: "kat", at: () => shop["rock-island"] },
  { name: "kat at Moline", login: "kat", at: () => shop.moline },
];
const asOutsider = (o: (typeof OUTSIDERS)[number]) => as(o.login, o.at?.());
/** Markers of an assigned shop they aren't working in (or aren't assigned to). */
const notTheirs = (o: (typeof OUTSIDERS)[number]): string[] => (o.name === "regional" ? [] : Object.values(o.name === "kat at Rock Island" ? MARK.moline : MARK.ri));

// ───────────── Canary data ─────────────

async function newStaff(label: string, worksAt: string[]) {
  const role = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "barber") }))!;
  const [s] = await m.db.db
    .insert(m.schema.staff)
    .values({
      staffCode: `S-9${String(worksAt.length)}${label.length}${Math.floor(Math.random() * 90 + 10)}`,
      firstName: label,
      displayLabel: label,
      publicSlug: label.toLowerCase(),
      roleId: role.id,
      shopScope: "selected",
    })
    .returning();
  await m.db.db.insert(m.schema.staffShops).values(worksAt.map((shopId, i) => ({ staffId: s.id, shopId, isPrimary: i === 0 })));
  await m.db.db.insert(m.schema.staffAccessShops).values(worksAt.map((shopId) => ({ staffId: s.id, shopId })));
  await m.db.db
    .insert(m.schema.staffSchedules)
    .values(worksAt.flatMap((shopId) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ staffId: s.id, shopId, weekday, startMin: 8 * 60, endMin: 20 * 60 }))));
  return s.id;
}

async function appointment(o: { shopId: string; staffId: string; customerId: string; at: Date; notes?: string; status?: "completed" | "booked"; item?: string }) {
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `T${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: o.shopId,
      staffId: o.staffId,
      customerId: o.customerId,
      startsAt: o.at,
      endsAt: new Date(o.at.getTime() + 30 * 60_000),
      status: o.status ?? "completed",
      source: "staff",
      estimateCents: 2300,
      notes: o.notes ?? null,
      completedAt: (o.status ?? "completed") === "completed" ? new Date(o.at.getTime() + 30 * 60_000) : null,
    })
    .returning();
  await m.db.db.insert(m.schema.appointmentItems).values({ appointmentId: a.id, kind: "service", name: o.item ?? "Ray'z Cut", priceCents: 2300, durationMin: 30 });
  return a.id;
}

async function seedCanaries() {
  const cv = shop.coralville;
  const who = { actor, name: "test", shopIds: Object.values(shop) };
  const at = (daysAgo: number, min: number) => m.time.zonedWallTime(m.time.addDays(today, -daysAgo), min).toJSDate();

  expect(await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, CANARY.phone) })).toBeUndefined();
  const [client] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName: CANARY.first, lastName: CANARY.last, phone: CANARY.phone, email: CANARY.email, homeShopId: cv, smsOptIn: true })
    .returning();
  ids.client = client.id;
  ids.barber = await newStaff(CANARY.barber, [cv]);
  ids.floater = await newStaff(CANARY.floater, [shop.moline, cv]);
  await m.db.db.update(m.schema.customers).set({ preferredStaffId: ids.barber }).where(eq(m.schema.customers.id, client.id));
  ids.molineBarber = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, "Jilane") }))!.id;

  ids.appt = await appointment({ shopId: cv, staffId: ids.barber, customerId: client.id, at: at(0, 10 * 60), notes: CANARY.apptNote, item: CANARY.item });
  ids.floatAppt = await appointment({ shopId: cv, staffId: ids.floater, customerId: client.id, at: at(0, 11 * 60), notes: CANARY.floatNote, status: "booked", item: CANARY.item });

  ids.service = (await m.catalog.shopCatalog(cv))[0].id;
  const cash = { method: "cash" as const, cashTenderedCents: null };
  const s1 = await m.checkout.openBlankSale(cv, actor);
  await m.checkout.finalizeSale({ saleId: s1.id, lines: [{ kind: "service", refId: ids.service, qty: 1 }], tipCents: 500, tender: cash, actor });
  await m.db.db.update(m.schema.sales).set({ customerId: client.id, staffId: ids.barber, appointmentId: ids.appt }).where(eq(m.schema.sales.id, s1.id));
  ids.sale = s1.id;
  ids.saleItem = (await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, s1.id)))[0].id;
  const s2 = await m.checkout.openBlankSale(cv, actor);
  await m.checkout.finalizeSale({ saleId: s2.id, lines: [{ kind: "service", refId: ids.service, qty: 1 }], tipCents: 0, tender: cash, actor });
  await m.db.db.update(m.schema.sales).set({ customerId: client.id, staffId: ids.barber }).where(eq(m.schema.sales.id, s2.id));
  await m.checkout.voidSale(s2.id, CANARY.voidReason, actor);
  ids.openSale = (await m.checkout.openBlankSale(cv, actor)).id;

  const [r] = await m.db.db
    .insert(m.schema.clientRatings)
    .values({ customerId: client.id, shopId: cv, appointmentId: ids.appt, staffId: ids.barber, stars: 2, note: CANARY.ratingNote })
    .returning();
  ids.rating = r.id;

  // A client of both shops: Moline sees its own visit, not Coralville's.
  const [shared] = await m.db.db.insert(m.schema.customers).values({ firstName: "Sasha", lastName: "Twoshops", phone: "+13195557740", homeShopId: shop.moline }).returning();
  ids.shared = shared.id;
  await appointment({ shopId: shop.moline, staffId: ids.molineBarber, customerId: shared.id, at: at(20, 10 * 60) });
  const cvVisit = await appointment({ shopId: cv, staffId: ids.barber, customerId: shared.id, at: at(10, 14 * 60), item: CANARY.item });
  await m.db.db.insert(m.schema.clientRatings).values({ customerId: shared.id, shopId: cv, appointmentId: cvVisit, staffId: ids.barber, stars: 1, note: CANARY.sharedRatingNote });

  ids.vendor = (await m.db.db.query.vendors.findFirst({ where: eq(m.schema.vendors.active, true) }))!.id;
  const { created } = await m.purchasing.createPos(who, { picks: [{ shopId: cv, vendorId: ids.vendor }], fill: "empty", notes: CANARY.poNote });
  ids.po = created[0].id;
  ids.poJob = await m.queue.enqueueShopEmail({
    kind: "purchase_order",
    to: "orders@canary-vendor.test",
    subject: CANARY.poEmail,
    body: CANARY.poEmail,
    shopId: cv,
    purchaseOrderId: ids.po,
    attachments: [{ filename: "po.csv", contentType: "text/csv", content: Buffer.from(CANARY.poEmail).toString("base64") }],
  });

  const carried = await m.db.db
    .select({ productId: m.schema.shopProducts.productId })
    .from(m.schema.shopProducts)
    .where(and(eq(m.schema.shopProducts.shopId, cv), m.drizzle.gte(m.schema.shopProducts.stock, 3)));
  const atKimberly = new Set(
    (await m.db.db.select({ p: m.schema.shopProducts.productId }).from(m.schema.shopProducts).where(eq(m.schema.shopProducts.shopId, shop.kimberly))).map((r) => r.p),
  );
  ids.product = carried.find((c) => atKimberly.has(c.productId))!.productId;
  ids.count = (await m.counts.startCount(who, { shopId: cv, kind: "cycle", productIds: [ids.product], note: CANARY.countNote })).id;
  ids.transfer = (await m.transfers.createTransfer(who, { fromShopId: cv, toShopId: shop.kimberly, note: CANARY.transferNote, lines: [{ productId: ids.product, qty: 1 }] })).id;

  const drawer = { shopId: cv, date: today, openingFloatCents: 10_000, payoutsCents: 0, countedCents: 10_000, notes: CANARY.drawerNote, actor };
  await m.checkout.closeDrawer(drawer).catch(() => null);
  await m.db.db
    .update(m.schema.cashDrawers)
    .set({ notes: CANARY.drawerNote })
    .where(and(eq(m.schema.cashDrawers.shopId, cv), eq(m.schema.cashDrawers.businessDate, today)));
  ids.drawer = (await m.db.db.query.cashDrawers.findFirst({ where: and(eq(m.schema.cashDrawers.shopId, cv), eq(m.schema.cashDrawers.businessDate, today)) }))!.id;

  await m.queue.enqueueRaw({ kind: "confirmation", channel: "sms", to: CANARY.phone, body: CANARY.sms, customerId: client.id, shopId: cv });
  ids.smsJob = (await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.body, CANARY.sms) }))!.id;

  ids.promo = (await m.db.db.insert(m.schema.promoCodes).values({ code: CANARY.promo, description: CANARY.promo, type: "percent", value: 10, shopId: cv }).returning())[0].id;
  const [gc] = await m.db.db
    .insert(m.schema.giftCards)
    .values({ code: CANARY.giftCard, initialCents: 5000, balanceCents: 5000, issuedShopId: cv, customerId: client.id })
    .returning();
  ids.giftCard = gc.id;
  await m.db.db.insert(m.schema.giftCardLedger).values({ giftCardId: gc.id, deltaCents: 5000, kind: "issue" });

  ids.wait = (
    await m.db.db.insert(m.schema.waitlistEntries).values({ shopId: cv, customerId: client.id, name: CANARY.waitName, phone: CANARY.phone, notes: CANARY.waitNote }).returning()
  )[0].id;
  ids.block = (
    await m.db.db
      .insert(m.schema.timeBlocks)
      .values({ staffId: ids.barber, shopId: cv, startsAt: at(0, 15 * 60), endsAt: at(0, 16 * 60), reason: CANARY.block })
      .returning()
  )[0].id;
  ids.reason = (await m.db.db.query.blockReasons.findFirst({ where: eq(m.schema.blockReasons.key, "personal") }))!.id;
  await m.db.db.insert(m.schema.auditLog).values({ actorLabel: "test", shopId: cv, action: "test.canary", entity: "test", details: { note: CANARY.audit } });
  const tomorrow = m.time.addDays(today, 1);
  ids.callIn = (await (await import("@/server/call-ins")).markCallIn({ staffId: ids.barber, shopId: cv, kind: "sick", range: { fromDate: tomorrow, toDate: tomorrow, startMin: null, endMin: null } }, { actor })).callInId;
  ids.thread = (await m.db.db.insert(m.schema.messageThreads).values({ shopId: cv, phone: CANARY.phone, customerId: client.id }).returning())[0].id;
  ids.tipBatch = (await m.db.db.insert(m.schema.tipPayoutBatches).values({ shopId: cv, kind: "manual", cutoffDate: today, notes: CANARY.apptNote }).returning())[0].id;
  ids.blast = (await m.db.db.insert(m.schema.marketingCampaigns).values({ kind: "blast", name: `Coralville blast ${CANARY.apptNote}`, shopIds: [cv], channels: ["sms"] }).returning())[0].id;
  ids.sequence = (await m.db.db.insert(m.schema.marketingCampaigns).values({ kind: "sequence", name: `Coralville sequence ${CANARY.apptNote}`, shopIds: [cv], channels: ["sms"] }).returning())[0].id;
  const ownerId = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!.id;
  ids.savedReport = (await m.db.db.insert(m.schema.savedReports).values({ name: `Coralville report ${CANARY.apptNote}`, ownerId, definition: { columns: [{ field: "name" }], shops: cv } }).returning())[0].id;
  await m.db.db.insert(m.schema.marketingSteps).values({ campaignId: ids.sequence, position: 0, afterDays: 14, templates: { sms: "{shop}: hi {first_name}. Reply STOP to opt out." } });
  await (await import("@/server/marketing/campaigns")).ensureTriggerCampaigns();
  ids.campaign = (await m.db.db.query.marketingCampaigns.findFirst({ where: eq(m.schema.marketingCampaigns.trigger, "lapsed") }))!.id;
  ids.tipPayout = (await m.db.db.insert(m.schema.tipPayouts).values({ batchId: ids.tipBatch, shopId: cv, staffId: ids.barber, method: "cash", status: "pending", grossCents: 2300, netCents: 2300 }).returning())[0].id;

  ids.marks = {} as typeof ids.marks;
  const [walkIn] = await m.db.db.insert(m.schema.customers).values({ firstName: "Marker", lastName: "Client", phone: "+13095557790", homeShopId: shop.moline }).returning();
  for (const [key, slug, startMin] of [
    ["moline", "moline", 21 * 60 + 30],
    ["ri", "rock-island", 22 * 60 + 30],
  ] as const) {
    const sid = shop[slug];
    const mark = MARK[key];
    const appt = await appointment({ shopId: sid, staffId: people.kat, customerId: walkIn.id, at: at(0, startMin), notes: mark.appt, status: "booked" });
    const promo = (await m.db.db.insert(m.schema.promoCodes).values({ code: mark.promo, description: mark.promo, type: "percent", value: 5, shopId: sid }).returning())[0].id;
    const svc = (await m.catalog.shopCatalog(sid))[0].id;
    const sale = await m.checkout.openBlankSale(sid, actor);
    await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc, qty: 1 }], tipCents: 0, tender: cash, actor });
    await m.checkout.closeDrawer({ ...drawer, shopId: sid, notes: mark.drawer }).catch(() => null);
    await m.db.db
      .update(m.schema.cashDrawers)
      .set({ notes: mark.drawer })
      .where(and(eq(m.schema.cashDrawers.shopId, sid), eq(m.schema.cashDrawers.businessDate, today)));
    ids.marks[key] = { appt, promo, sale: sale.id };
  }
}

/** Every Coralville row the actions below could touch. */
async function coralvilleState() {
  const s = m.schema;
  const cv = shop.coralville;
  const q = m.db.db;
  return JSON.stringify({
    shop: await q.select().from(s.shops).where(eq(s.shops.id, cv)),
    paymentAccount: await q.select().from(s.shopPaymentAccounts).where(eq(s.shopPaymentAccounts.shopId, cv)),
    owners: await q.select().from(s.ownerEntities),
    hours: await q.select().from(s.shopHours).where(eq(s.shopHours.shopId, cv)),
    readers: await q.select().from(s.terminalReaders).where(eq(s.terminalReaders.shopId, cv)),
    closures: await q.select().from(s.shopClosures).where(eq(s.shopClosures.shopId, cv)),
    services: await q.select().from(s.shopServices).where(eq(s.shopServices.shopId, cv)),
    products: await q.select().from(s.shopProducts).where(eq(s.shopProducts.shopId, cv)),
    ledger: (await q.select({ n: m.drizzle.count() }).from(s.inventoryLedger).where(eq(s.inventoryLedger.shopId, cv)))[0],
    appts: await q.select().from(s.appointments).where(eq(s.appointments.shopId, cv)),
    sales: await q.select().from(s.sales).where(eq(s.sales.shopId, cv)),
    refunds: (await q.select({ n: m.drizzle.count() }).from(s.refunds))[0],
    waitlist: await q.select().from(s.waitlistEntries).where(eq(s.waitlistEntries.shopId, cv)),
    drawers: await q.select().from(s.cashDrawers).where(eq(s.cashDrawers.shopId, cv)),
    pos: await q.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.shopId, cv)),
    poLines: (await q.select({ n: m.drizzle.count() }).from(s.purchaseOrderLines))[0],
    transfers: await q.select().from(s.stockTransfers).where(eq(s.stockTransfers.fromShopId, cv)),
    counts: await q.select().from(s.stockCounts).where(eq(s.stockCounts.shopId, cv)),
    countLines: await q.select().from(s.stockCountLines).where(eq(s.stockCountLines.countId, ids.count)),
    promos: await q.select().from(s.promoCodes).where(eq(s.promoCodes.shopId, cv)),
    giftCards: await q.select().from(s.giftCards).where(eq(s.giftCards.issuedShopId, cv)),
    staff: await q
      .select()
      .from(s.staff)
      .where(m.drizzle.inArray(s.staff.id, [ids.barber, ids.floater])),
    schedules: await q.select().from(s.staffSchedules).where(eq(s.staffSchedules.shopId, cv)),
    staffShops: await q.select().from(s.staffShops).where(eq(s.staffShops.shopId, cv)),
    durations: await q.select().from(s.staffServiceDurations).where(m.drizzle.inArray(s.staffServiceDurations.staffId, [ids.barber, ids.floater])),
    brand: await q.select().from(s.brandSettings),
    service: await q.select().from(s.services).where(eq(s.services.id, ids.service)),
    blocks: await q.select().from(s.timeBlocks).where(eq(s.timeBlocks.staffId, ids.barber)),
    client: await q.select().from(s.customers).where(eq(s.customers.id, ids.client)),
    logins: await q.select().from(s.staff).where(eq(s.staff.email, "coralville@rayz.test")),
    jobs: await q.select({ id: s.notificationJobs.id, status: s.notificationJobs.status }).from(s.notificationJobs).where(eq(s.notificationJobs.shopId, cv)),
    tipBatches: await q.select().from(s.tipPayoutBatches).where(eq(s.tipPayoutBatches.shopId, cv)),
    tipPayouts: await q.select().from(s.tipPayouts).where(eq(s.tipPayouts.shopId, cv)),
    tipLedger: (await q.select({ n: m.drizzle.count() }).from(s.tipLedger).where(eq(s.tipLedger.shopId, cv)))[0],
  });
}

beforeAll(async () => {
  m = await loadModules();
  today = m.time.todayLocal();
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const l of [...MOLINE_SIDE, "owner", "kat"] as const) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email(l)) }))!.id;
  await seedCanaries();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

// ───────────── Pages ─────────────

const staticPages = Object.keys(PAGE_ACCESS).filter((p) => !p.includes("["));
const variants = (): Record<string, string>[] => [
  {},
  { shop: shop.coralville, date: today, staff: ids.barber, preset: "30d", view: "shops_barbers", status: "all" },
  { shop: "all", q: CANARY.last.slice(0, -1), gc: CANARY.giftCard.slice(0, 8), preset: "90d", view: "shops" },
];
/** Shop names on the transfer form's destination list are the one accepted exception: stock can be sent to any shop. */
const NAMES_LISTED = new Set(["/admin/inventory/transfers"]);

describe("the brand owner sees every canary (so their absence below means something)", () => {
  it("each canary shows up on some page when viewing Coralville", async () => {
    await as("owner", shop.coralville);
    let all = "";
    for (const page of staticPages)
      for (const sp of variants()) {
        const r = await open(page, {}, sp);
        if (r.kind === "ok") all += r.text;
      }
    for (const [route, params] of dynamicPages()) {
      const r = await open(route, params);
      if (r.kind === "ok") all += r.text;
    }
    // The raw number only appeared in a tel: link; calls now go through the shop line, so the owner sees it formatted.
    expect(SECRETS.filter((s) => !all.includes(s) && !(s === "5557731" && all.includes("555-7731")))).toEqual([]);
    expect(all).toContain("Coralville");
  }, 300_000);
});

describe("shop workspaces never show another shop's records", () => {
  for (const o of OUTSIDERS) {
    it(`${o.name}: no canary on any page, with or without Coralville in the URL`, async () => {
      await asOutsider(o);
      const leaks: string[] = [];
      let opened = 0;
      for (const page of staticPages)
        for (const sp of variants()) {
          const r = await open(page, {}, sp);
          if (r.kind !== "ok") continue;
          opened++;
          const hits = found(r.text, [...(page === CLIENT_LIST ? ON_CLIENT_LIST : NAMES_LISTED.has(page) ? SECRETS : [...SECRETS, "Coralville"]), ...notTheirs(o)]);
          if (hits.length) leaks.push(`${page}?${new URLSearchParams(sp)}: ${hits.join(", ")}`);
        }
      expect(leaks).toEqual([]);
      expect(opened).toBeGreaterThan(o.name === "moline" || o.name === "kat at Moline" ? 5 : 30);
    }, 300_000);
  }

  it("the shop switcher lists only the workspace's shops, with the shop's own name and address", async () => {
    const layout = (await import("@/app/admin/layout")).default as (p: { children: unknown }) => Promise<unknown>;
    const render = async () => textOf(await layout({ children: null }), new Set());
    await as("moline");
    const desk = await render();
    expect(desk).toContain("Moline");
    expect(desk).toContain("3002 Ave of Cities");
    expect(desk).toContain("Shop workspace");
    expect(desk).toContain("shared shop login");
    for (const other of ["Coralville", "Kimberly", "Rock Island", "Dubuque"]) expect(desk).not.toContain(other);
    await as("regional");
    const regional = await render();
    expect(regional).toContain("Rock Island");
    expect(regional).not.toContain("Coralville");
    await as("owner");
    const brand = await render();
    expect(brand).toContain("Brand · every shop");
    for (const s of ["Coralville", "Kimberly", "Moline", "Dubuque"]) expect(brand).toContain(s);
    await as("owner", shop.coralville);
    const viewing = await render();
    expect(viewing).toContain("Brand · viewing one shop");
    expect(viewing).toContain(CANARY.address);
  });
});

function dynamicPages(): [string, Record<string, string>][] {
  return [
    ["/admin/checkout/[saleId]", { saleId: ids.openSale }],
    ["/admin/sales/[id]", { id: ids.sale }],
    ["/admin/inventory/counts/[id]", { id: ids.count }],
    ["/admin/inventory/transfers/[id]", { id: ids.transfer }],
    ["/admin/purchase-orders/[id]", { id: ids.po }],
    ["/admin/purchase-orders/[id]/receive", { id: ids.po }],
    ["/admin/staff/[id]", { id: ids.barber }],
    ["/admin/staff/[id]/compensation", { id: ids.barber }],
    ["/admin/permissions/people/[id]", { id: ids.barber }],
    ["/admin/users/[id]", { id: ids.barber }],
    ["/admin/customers/[id]", { id: ids.client }],
    ["/admin/inventory/[id]", { id: ids.product }],
    ["/admin/vendors/[id]", { id: ids.vendor }],
    ["/admin/call-ins/[id]", { id: ids.callIn }],
    ["/admin/inbox/[id]", { id: ids.thread }],
    ["/admin/timesheets/[staffId]", { staffId: ids.barber }],
    ["/admin/tips/[id]", { id: ids.tipBatch }],
    ["/admin/campaign-center/blasts/[id]", { id: ids.blast }],
    ["/admin/campaign-center/sequences/[id]", { id: ids.sequence }],
    ["/admin/reports/custom/[id]", { id: ids.savedReport }],
    ["/admin/cutover/[shopId]", { shopId: shop.coralville }],
  ];
}

describe("direct URLs to another shop's records", () => {
  it("covers every dynamic page", () => {
    const covered = new Set([...dynamicPages().map(([r]) => r), "/admin/permissions/roles/[id]", "/admin/campaign-center/automations/[id]"]);
    expect(Object.keys(PAGE_ACCESS).filter((p) => p.includes("[") && !covered.has(p))).toEqual([]);
  });

  for (const o of OUTSIDERS) {
    it(`${o.name}: Coralville's records are not found; shared records show nothing of Coralville but the client's visit history`, async () => {
      await asOutsider(o);
      const wrong: string[] = [];
      for (const [route, params] of dynamicPages()) {
        const r = await open(route, params, { shop: shop.coralville });
        const shared = route === "/admin/customers/[id]" || route === "/admin/inventory/[id]" || route === "/admin/vendors/[id]";
        if (r.kind === "ok" && !shared) wrong.push(`${route}: opened`);
        if (r.kind === "ok") {
          const hits = found(r.text, route === "/admin/customers/[id]" ? OTHER_SHOP_DETAIL : [...SECRETS, "Coralville"]);
          if (hits.length) wrong.push(`${route}: ${hits.join(", ")}`);
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);
  }

  // Barbers look up only clients they've served (their role, not the shop); Kat as a Moline barber is covered below.
  for (const o of OUTSIDERS.filter((x) => x.name !== "kat at Moline")) {
    it(`${o.name}: a client's visit history at every shop is visible, but not other shops' notes, ratings or tickets`, async () => {
      await asOutsider(o);
      const profile = await open("/admin/customers/[id]", { id: ids.client });
      expect(profile.kind).toBe("ok");
      const text = profile.text!;
      expect(text).toContain(CLIENT_NAME);
      for (const s of ["Coralville", CANARY.barber, CANARY.item, "at every Ray'z shop", "Loyalty progress", "★ 2.0"]) expect(text, s).toContain(s);
      // A shared shop login sees when, where and what at other shops, but not what it cost.
      if (o.login === "moline") {
        expect(text).not.toContain("$23.00");
        expect(text).toContain("Prices show for this shop's visits only");
        expect(text).toContain("Spend at Moline");
      } else expect(text).toContain("$23.00");
      expect(found(text, OTHER_SHOP_DETAIL)).toEqual([]);
      expect(text).not.toContain(`/admin/sales/${ids.sale}`);
      expect(text).not.toContain("Another Ray'z shop");

      const shared = await open("/admin/customers/[id]", { id: ids.shared });
      for (const s of ["Jilane", "Moline", "Coralville", CANARY.barber, CANARY.item, "2 appointments"]) expect(shared.text, s).toContain(s);
      expect(shared.text).not.toContain(CANARY.sharedRatingNote);
    });
  }

  it("the brand sees the same history, plus every shop's ratings and notes", async () => {
    await as("owner");
    const brand = await open("/admin/customers/[id]", { id: ids.shared });
    expect(found(brand.text!, [CANARY.barber, CANARY.item, CANARY.sharedRatingNote, "Coralville", "Jilane"])).toHaveLength(5);
  });
});

// ───────────── Clients across shops ─────────────

describe("finding a brand client to book them", () => {
  it("any shop finds the client by any part of their name or a whole identifier, with contact still masked", async () => {
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    const { quickFindClientsAction } = await import("@/app/admin/customers/actions");
    for (const login of MOLINE_SIDE) {
      await as(login);
      for (const term of [CANARY.phone, "(319) 555-7731", CANARY.email, CLIENT_NAME, CLIENT_NAME.toLowerCase(), CANARY.last, CANARY.first, "Quillon Canary", "7731"]) {
        const r = await searchCustomersAction(term);
        expect(r.ok && r.data.some((c) => c.id === ids.client), `${login} ${term}`).toBe(true);
        expect(found(JSON.stringify(r), [CANARY.email, "555-7731", "5557731"]), `${login} ${term}`).toEqual([]);
      }
      // Partial digits and email letters need the full detail, which nobody below brand level sees.
      for (const term of ["5557731", "email:quillon.canary"]) {
        const r = await searchCustomersAction(term);
        expect(r.ok && r.data.some((c) => c.id === ids.client), `${login} ${term}`).toBe(false);
      }
      const header = await quickFindClientsAction(CANARY.last);
      expect(header.ok && header.data.some((c) => c.id === ids.client), `${login} header`).toBe(true);
      for (const q of [CANARY.phone, CANARY.last, ""]) {
        const list = await open("/admin/customers", {}, { q });
        expect(list.text, `${login} ${q}`).toContain(`/admin/customers/${ids.client}`);
        const shown = q ? list.text!.replaceAll(q, "") : list.text!;
        expect(found(shown, ON_CLIENT_LIST), `${login} ${q} (search box echo aside)`).toEqual([]);
      }
    }
    await as("owner");
    const r = await searchCustomersAction(CANARY.last);
    expect(r.ok && r.data.some((c) => c.id === ids.client)).toBe(true);
  });

  it("the brand-wide client list can't be exported or merged from a shop", async () => {
    const { mergeCustomersAction } = await import("@/app/admin/customers/actions");
    await as("manager.moline");
    const r = await mergeCustomersAction(ids.shared, ids.client);
    expect(r.ok).toBe(false);
    expect(await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, ids.client) })).toBeTruthy();
    expect(await open("/admin/customers/duplicates")).toMatchObject({ kind: "denied" });
  });
});

// ───────────── Routes, exports and the API ─────────────

describe("routes and exports", () => {
  it("PO documents and email attachments of another shop are not found", async () => {
    const doc = (await import("@/app/admin/purchase-orders/[id]/document/route")).GET;
    const att = (await import("@/app/admin/notifications/[id]/attachment/route")).GET;
    for (const login of ["manager.moline", "regional"] as const) {
      await as(login);
      expect((await get(doc as never, `/admin/purchase-orders/${ids.po}/document`, { id: ids.po })).status).toBe(404);
      expect((await get(doc as never, `/admin/purchase-orders/${ids.po}/document?format=csv`, { id: ids.po })).status).toBe(404);
      expect((await get(att as never, `/admin/notifications/${ids.poJob}/attachment`, { id: ids.poJob })).status).toBe(404);
    }
    await as("owner");
    expect((await get(doc as never, `/admin/purchase-orders/${ids.po}/document?format=csv`, { id: ids.po })).status).toBe(200);
    expect((await get(att as never, `/admin/notifications/${ids.poJob}/attachment`, { id: ids.poJob })).text).toBe(CANARY.poEmail);
  });

  it("report exports: Coralville is refused, and nothing of Coralville is in any file", async () => {
    const { REPORTS } = await import("@/domain/permissions");
    const exp = (await import("@/app/admin/reports/export/route")).GET;
    const ratings = (await import("@/app/admin/reports/ratings/export/route")).GET;
    const catalog = (await import("@/app/admin/catalog/export/route")).GET;
    for (const login of MOLINE_SIDE) {
      await as(login);
      const leaks: string[] = [];
      let files = 0;
      for (const r of REPORTS) {
        if (r.key === "client_ratings") continue;
        const own = await get(exp, `/admin/reports/export?type=${r.key}&preset=90d`);
        if (own.status === 403) continue;
        expect(own.status, r.key).toBe(200);
        expect((await get(exp, `/admin/reports/export?type=${r.key}&shop=${shop.coralville}`)).status, r.key).toBe(403);
        for (const extra of ["", "&shop=all&view=shops_barbers", `&staff=${ids.barber}`]) {
          const f = await get(exp, `/admin/reports/export?type=${r.key}&preset=90d${extra}`);
          if (f.status !== 200) continue;
          files++;
          const hits = found(f.text, [...SECRETS, "Coralville"]);
          if (hits.length) leaks.push(`${r.key}${extra}: ${hits.join(", ")}`);
        }
      }
      for (const url of ["/admin/reports/ratings/export?preset=90d", "/admin/reports/ratings/export?table=given&preset=90d&view=shops_barbers"]) {
        const f = await get(ratings, url);
        if (f.status === 200) leaks.push(...found(f.text, [...SECRETS, "Coralville"]).map((h) => `${url}: ${h}`));
      }
      if (login !== "moline") expect((await get(ratings, `/admin/reports/ratings/export?shop=${shop.coralville}`)).status).toBe(403);
      const cat = await get(catalog as never, "/admin/catalog/export");
      if (cat.status === 200) leaks.push(...found(cat.text, ["Coralville"]).map((h) => `catalog: ${h}`));
      expect(leaks).toEqual([]);
      if (login !== "moline") expect(files).toBeGreaterThan(10);
    }
    await as("owner");
    const combined = await get(exp, "/admin/reports/export?type=sales_summary&preset=30d&shop=all&view=shops");
    expect(combined.text).toContain("Coralville");
    expect(combined.text).toContain("Moline");
  }, 180_000);

  it("the customer API ignores a staff session", async () => {
    const me = await import("@/app/api/v1/me/route");
    await as("owner");
    const headers = { cookie: `rayz_session=${jar.token}`, authorization: `Bearer ${jar.token}`, "content-type": "application/json" };
    expect((await get(me.GET as never, "/api/v1/me", undefined, { headers })).status).toBe(401);
    expect((await get(me.PATCH as never, "/api/v1/me", undefined, { method: "PATCH", headers, body: JSON.stringify({ firstName: "x" }) })).status).toBe(401);
  });
});

// ───────────── Server actions ─────────────

const TENANT = /not found|outside your (access|shops)|shops outside yours|your own shops|isn't on your shops' team|every shop shares/i;

describe("server actions aimed at another shop's records", () => {
  it("are refused as not found or outside your access, and change nothing", async () => {
    const calendar = await import("@/app/admin/calendar/actions");
    const sales = await import("@/app/admin/sales/actions");
    const checkout = await import("@/app/admin/checkout/actions");
    const walkIns = await import("@/app/admin/walk-ins/actions");
    const drawer = await import("@/app/admin/drawer/actions");
    const po = await import("@/app/admin/purchase-orders/actions");
    const transfers = await import("@/app/admin/inventory/transfers/actions");
    const counts = await import("@/app/admin/inventory/counts/actions");
    const inventory = await import("@/app/admin/inventory/actions");
    const promos = await import("@/app/admin/promos/actions");
    const giftCards = await import("@/app/admin/gift-cards/actions");
    const settings = await import("@/app/admin/settings/actions");
    const staffActions = await import("@/app/admin/staff/actions");
    const services = await import("@/app/admin/services/actions");
    const customers = await import("@/app/admin/customers/actions");
    const permissions = await import("@/app/admin/permissions/actions");
    const logins = await import("@/app/admin/shop-logins/actions");
    const timing = await import("@/app/admin/booking-times/actions");
    const setup = await import("@/app/admin/setup/actions");
    const tips = await import("@/app/admin/tips/actions");
    const campaignCenter = await import("@/app/admin/campaign-center/actions");
    const openings = await import("@/app/admin/campaign-center/openings/actions");
    const cv = shop.coralville;
    const coralvilleLogin = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "coralville@rayz.test") }))!.id;
    const deskRole = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "front_desk") }))!.id;
    const cvShop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, cv) }))!;

    const calls: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
      ["calendar status", () => calendar.setStatusAction(ids.floatAppt, "cancelled")],
      ["calendar move", () => calendar.moveAppointmentAction(ids.floatAppt, ids.floater, today, 13 * 60)],
      ["calendar checkout", () => calendar.startCheckoutAction(ids.appt)],
      [
        "calendar book",
        () =>
          calendar.createStaffAppointmentAction({ shopId: cv, staffId: ids.barber, date: today, startMin: 17 * 60, serviceId: ids.service, addonIds: [], customerId: ids.client }),
      ],
      ["calendar block", () => calendar.createBlockAction({ shopId: cv, staffId: ids.floater, date: today, startMin: 18 * 60, endMin: 19 * 60, reasonId: ids.reason, allShops: false })],
      ["calendar unblock", () => calendar.deleteBlockAction(ids.block)],
      ["sale void", () => sales.voidAction(ids.sale, "x")],
      [
        "sale refund",
        () => sales.refundAction({ saleId: ids.sale, items: [{ saleItemId: ids.saleItem, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "x", restock: false }),
      ],
      ["checkout promo", () => checkout.promoAction(ids.openSale, CANARY.promo)],
      ["checkout client", () => checkout.attachCustomerAction(ids.openSale, ids.shared)],
      ["checkout barber", () => checkout.setBarberAction(ids.openSale, ids.molineBarber)],
      ["checkout hold", () => checkout.holdRetailAction(ids.openSale, [{ productId: ids.product, qty: 1 }])],
      [
        "checkout finalize",
        () =>
          checkout.finalizeAction({
            saleId: ids.openSale,
            lines: [{ kind: "service", refId: ids.service, qty: 1 }],
            tipCents: 0,
            tender: { method: "cash", cashTenderedCents: null },
          } as never),
      ],
      ["checkout product used", () => checkout.tagUsedProductAction(ids.openSale, ids.product, true)],
      ["checkout rebook", () => checkout.acceptRebookAction(ids.openSale, crypto.randomUUID(), { index: 0, startsAt: new Date().toISOString() })],
      ["checkout rebook not now", () => checkout.declinePromptAction(ids.openSale, crypto.randomUUID(), { reason: null, remind: true })],
      ["checkout prompt product", () => checkout.addPromptProductAction(ids.openSale, crypto.randomUUID(), ids.product)],
      ["walk-in add", () => walkIns.walkInAction({ shopId: cv, serviceId: ids.service, name: "Walk In", phone: "", preferredStaffId: null })],
      ["walk-in seat", () => walkIns.seatAction(ids.wait, ids.barber)],
      ["walk-in status", () => walkIns.waitlistStatusAction(ids.wait, "left")],
      ["walk-in notify", () => walkIns.notifyAction(ids.wait)],
      ["drawer close", () => drawer.closeDrawerAction({ shopId: cv, date: m.time.addDays(today, -1), openingFloatCents: 0, payoutsCents: 0, countedCents: 0, notes: "" })],
      ["po create", () => po.createPosAction({ picks: [{ shopId: cv, vendorId: ids.vendor }], fill: "empty" })],
      ["po edit", () => po.updatePoAction(ids.po, { notes: "x", lines: [] } as never)],
      ["po approve", () => po.approvePoAction(ids.po)],
      ["po send", () => po.sendPoAction(ids.po, { method: "manual", reference: "x" } as never)],
      ["po receive", () => po.receivePoAction(ids.po, { lines: [] } as never)],
      ["po cancel", () => po.cancelPoAction(ids.po, "x")],
      ["po close short", () => po.closePoShortAction(ids.po, "x")],
      ["transfer create", () => transfers.createTransferAction({ fromShopId: cv, toShopId: shop.moline, lines: [{ productId: ids.product, qty: 1 }] })],
      ["transfer edit", () => transfers.updateTransferAction(ids.transfer, { note: "x", lines: [{ productId: ids.product, qty: 2 }] })],
      ["transfer send", () => transfers.sendTransferAction(ids.transfer)],
      ["transfer receive", () => transfers.receiveTransferAction(ids.transfer, { lines: [] } as never)],
      ["transfer cancel", () => transfers.cancelTransferAction(ids.transfer)],
      ["count start", () => counts.startCountAction({ shopId: cv, kind: "cycle", productIds: [ids.product] })],
      ["count save", () => counts.saveCountAction(ids.count, [{ productId: ids.product, counted: 0 }])],
      ["count post", () => counts.postCountAction(ids.count, [{ productId: ids.product, counted: 0 }], true)],
      ["count cancel", () => counts.cancelCountAction(ids.count)],
      ["stock adjust", () => inventory.adjustStockAction({ shopId: cv, productId: ids.product, mode: "delta", qty: -1, reason: "damaged" } as never)],
      ["stock price", () => inventory.saveShopProductAction(cv, ids.product, { costCents: 1, priceCents: 1, active: false })],
      ["stock levels", () => inventory.saveShopLevelsAction({ shopId: cv, rows: [] } as never)],
      ["stock settings", () => inventory.saveInventorySettingsAction({ shopId: cv } as never)],
      ["low-stock alert", () => inventory.sendLowStockAlertsAction([cv], true)],
      ["promo toggle", () => promos.togglePromoAction(ids.promo, false)],
      ["promo create", () => promos.saveCouponAction(null, { code: "CVSNEAK1", type: "percent", value: 50, appliesTo: "all", shopIds: [cv] })],
      ["promo edit", () => promos.saveCouponAction(ids.promo, { code: "CVSNEAK2", type: "percent", value: 90, appliesTo: "all", shopIds: [shop.moline] })],
      ["gift card void", () => giftCards.voidGiftCardAction(ids.giftCard, "x")],
      ["gift card issue", () => giftCards.issueCompCardAction({ shopId: cv, amountCents: 1000, reason: "x" })],
      ["gift card comp", () => giftCards.compReloadAction({ id: ids.giftCard, amountCents: 1000, reason: "x" })],
      ["gift card reload ticket", () => giftCards.startReloadAction({ shopId: cv, id: ids.giftCard, amountCents: 1000 })],
      [
        "settings info",
        () =>
          settings.saveShopInfoAction(cv, {
            ...(cvShop as never as Record<string, never>),
            name: "Hijacked",
            address: "x",
            city: "x",
            state: "IA",
            zip: "x",
            phone: "",
            email: "",
            description: "",
            bookingEnabled: false,
            cancelCutoffMinutes: 0,
            minLeadMinutes: 0,
            bookingWindowDays: 30,
            bufferMinutes: 0,
            tipPresets: [20],
          }),
      ],
      [
        "settings money",
        () => settings.saveShopMoneyAction(cv, { serviceTaxRate: 0, productTaxRate: 0, taxRatesVerified: true }),
      ],
      ["settings shop card fee", () => settings.saveShopCardFeeAction(cv, { enabled: false })],
      ["settings hours", () => settings.saveHoursAction(cv, [])],
      ["settings closure", () => settings.addClosureAction(cv, m.time.addDays(today, 40), "x", false)],
      ["settings reopen", () => settings.removeClosureAction(cv, today)],
      ["service price", () => services.saveShopServiceAction(cv, ids.service, { priceCents: 1, durationMin: 15, active: false } as never)],
      [
        "staff profile",
        () => staffActions.saveProfileAction({ id: ids.barber, firstName: "x", displayLabel: "Renamed", color: "#000000", isBookable: true, active: true, shopIds: [shop.moline] }),
      ],
      ["staff schedule", () => staffActions.saveScheduleAction(ids.barber, [])],
      ["staff time off", () => staffActions.addTimeOffAction({ staffId: ids.barber, shopId: cv, from: today, to: today, allDay: true, startMin: 0, endMin: 0, reasonId: ids.reason })],
      ["staff time off delete", () => staffActions.deleteTimeOffAction(ids.block)],
      [
        "client home shop",
        () =>
          customers.updateCustomerAction(ids.client, {
            firstName: CANARY.first,
            lastName: CANARY.last,
            phone: CANARY.phone,
            email: CANARY.email,
            notes: "",
            smsOptIn: true,
            emailOptIn: false,
            homeShopId: shop.kimberly,
            preferredStaffId: null,
          }),
      ],
      ["client merge", () => customers.mergeCustomersAction(ids.client, ids.shared)],
      [
        "person access",
        () => permissions.saveUserAccessAction({ staffId: ids.barber, roleId: deskRole, scope: "one", shopIds: [shop.moline], overrides: {}, maxDiscountPct: null }),
      ],
      ["shop login create", () => logins.createShopLoginAction({ shopId: cv, label: "Sneaky", email: "sneaky@rayz.test", roleId: deskRole })],
      ["shop login reset", () => logins.resetShopLoginPasswordAction(coralvilleLogin)],
      ["shop login disable", () => logins.setShopLoginActiveAction(coralvilleLogin, false)],
      ["timing shop interval", () => timing.saveShopIntervalAction(cv, 30)],
      ["timing barber interval", () => timing.saveBarberIntervalAction(ids.barber, cv, 30)],
      ["timing barber everywhere", () => timing.saveBarberIntervalAction(ids.barber, null, 30)],
      ["timing floater at coralville", () => timing.saveBarberIntervalAction(ids.floater, cv, 30)],
      ["timing floater everywhere", () => timing.saveBarberIntervalAction(ids.floater, null, 30)],
      ["timing barber duration", () => timing.saveBarberDurationAction(ids.barber, ids.service, cv, 40)],
      ["timing floater duration everywhere", () => timing.saveBarberDurationAction(ids.floater, ids.service, null, 40)],
      ["timing shop duration", () => timing.saveShopDurationAction(cv, ids.service, 40)],
      ["timing brand interval", () => timing.saveBrandIntervalAction(30)],
      [
        "timing service",
        () => timing.saveServiceTimingAction(ids.service, { defaultDurationMin: 60, durationStepMin: 15, bookingIncrementMin: 30, bufferBeforeMin: 5, bufferAfterMin: 5 }),
      ],
      ["payments onboarding", () => setup.startPaymentsOnboardingAction(cv)],
      ["payments refresh", () => setup.refreshPaymentsAccountAction(cv)],
      ["payments simulated onboarding", () => setup.completeSimulatedOnboardingAction(cv, false)],
      ["payments dashboard", () => setup.expressDashboardAction(cv)],
      ["payments mode", () => setup.setPaymentsModeAction(cv, "cash_only")],
      ["payments statement descriptor", () => setup.saveStatementDescriptorAction(cv, "HIJACKED CUTS")],
      ["payments register reader", () => setup.registerReaderAction(cv, { label: "Sneaky", registrationCode: "simulated-wpe", serialNumber: null })],
      ["settings receipt", () => settings.saveReceiptAction(cv, { headline: "Hijacked", footer: null, showLogo: false, showAddress: false, showPhone: false })],
      ["shop owner", () => setup.setShopOwnerAction(cv, cvShop.ownerEntityId!)],
      ["owner entity edit", () => setup.saveOwnerEntityAction(cvShop.ownerEntityId!, { name: "Hijacked LLC", legalName: null, contactEmail: null })],
      ["owner entity create", () => setup.saveOwnerEntityAction(null, { name: "Sneaky LLC", legalName: null, contactEmail: null })],
      ["tips build batch", () => tips.buildBatchAction({ shopId: cv })],
      ["tips approve batch", () => tips.approveBatchAction(ids.tipBatch)],
      ["tips cancel batch", () => tips.cancelBatchAction(ids.tipBatch, "x")],
      ["tips hold", () => tips.payoutAction({ payoutId: ids.tipPayout, action: "hold", reason: "x" })],
      ["tips adjust", () => tips.payoutAction({ payoutId: ids.tipPayout, action: "adjust", reason: "x", cents: 500 })],
      ["tips remove", () => tips.payoutAction({ payoutId: ids.tipPayout, action: "remove", reason: "x" })],
      ["tips cash paid", () => tips.acknowledgeCashAction({ payoutId: ids.tipPayout, by: "name", name: CANARY.barber })],
      ["campaign center campaign on", () => campaignCenter.setLocationAutomationAction({ campaignId: ids.campaign, shopId: cv, enabled: true })],
      ["campaign center blast to coralville", () => campaignCenter.saveBlastAction({ name: "Sneaky", channels: ["push"], templates: { pushTitle: "Hi", pushBody: "Hi" }, segment: {}, shopIds: [cv] })],
      ["campaign center blast count", () => campaignCenter.previewBlastAction({ channels: ["push"], segment: {}, shopIds: [cv] })],
      ["campaign center blast edit", () => campaignCenter.saveBlastAction({ id: ids.blast, name: "Hijacked", channels: ["push"], templates: { pushTitle: "Hi", pushBody: "Hi" }, segment: {} })],
      ["campaign center blast send", () => campaignCenter.scheduleBlastAction(ids.blast, null)],
      ["campaign center blast cancel", () => campaignCenter.cancelBlastAction(ids.blast)],
      ["campaign center test", () => campaignCenter.sendTestAction({ campaignId: ids.campaign, shopId: cv, channel: "sms" })],
      [
        "campaign center sequence edit",
        () => campaignCenter.saveSequenceAction({ id: ids.sequence, name: "Hijacked", channels: ["push"], steps: [{ afterDays: 14, templates: { pushTitle: "Hi", pushBody: "Hi" } }] }),
      ],
      ["campaign center sequence on", () => campaignCenter.setSequenceEnabledAction(ids.sequence, true)],
      ["campaign center sequence delete", () => campaignCenter.deleteSequenceAction(ids.sequence)],
      ["campaign center sequence count", () => campaignCenter.previewSequenceAction({ channels: ["push"], shopIds: [cv], steps: [{ afterDays: 14 }] })],
      ["openings count", () => openings.previewOpeningsAction({ shopId: cv, staffIds: [ids.barber], dates: [today], channels: ["sms"] })],
      ["openings send", () => openings.sendOpeningsAction({ shopId: cv, staffIds: [ids.barber], dates: [today], channels: ["sms"] })],
    ];

    // Each call must be refused for every Moline-side login, and by the tenant check (not just a
    // missing permission) for at least one of them. Moline's manager is given every permission these
    // need, so only the shop boundary stands in the way.
    const manager = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people["manager.moline"]) }))!;
    await m.db.db
      .update(m.schema.staff)
      .set({
        permissionOverrides: {
          ...Object.fromEntries(["settings.taxes", "giftcards.void", "giftcards.issue", "checkout.any", "permissions.manage", "clients.merge", "po.approve", "payments.accounts", "payments.banking"].map((p) => [p, true])),
          ...Object.fromEntries(["promos.manage", "campaign_center.view", "campaign_center.create", "campaign_center.send"].map((p) => [p, true])),
        },
      })
      .where(eq(m.schema.staff.id, manager.id));
    const before = await coralvilleState();
    const errors: Record<string, string[]> = {};
    const wrong: string[] = [];
    for (const o of OUTSIDERS) {
      await asOutsider(o);
      for (const [name, call] of calls) {
        const r = await call();
        if (r.ok) wrong.push(`${o.name} ${name}: succeeded`);
        else (errors[name] ??= []).push(`${o.name}: ${r.error}`);
      }
    }
    for (const [name, list] of Object.entries(errors)) if (!list.some((e) => TENANT.test(e))) wrong.push(`${name}: ${list.join(" | ")}`);
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: manager.permissionOverrides }).where(eq(m.schema.staff.id, manager.id));
    expect(wrong).toEqual([]);
    expect(await coralvilleState()).toBe(before);
  }, 120_000);

  it("the same kind of change works on the workspace's own shop", async () => {
    const giftCards = await import("@/app/admin/gift-cards/actions");
    const settings = await import("@/app/admin/settings/actions");
    await as("manager.moline");
    expect(await giftCards.issueCompCardAction({ shopId: shop.moline, amountCents: 1000, reason: "test" })).toMatchObject({ ok: true });
    expect(await settings.addClosureAction(shop.moline, m.time.addDays(today, 41), "Test closure", false)).toMatchObject({ ok: true });
    expect(await settings.removeClosureAction(shop.moline, m.time.addDays(today, 41))).toMatchObject({ ok: true });
    const timing = await import("@/app/admin/booking-times/actions");
    const before = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, shop.moline) }))!.slotIntervalMinutes;
    expect(await timing.saveShopIntervalAction(shop.moline, 30)).toMatchObject({ ok: true });
    expect(await timing.saveShopIntervalAction(shop.moline, before)).toMatchObject({ ok: true });
  });
});

// ───────────── Staff assigned to several shops ─────────────

describe("staff assigned to several shops (Kat: barber at Moline and Silvis, Shop Manager at Rock Island)", () => {
  const ctxAt = async (cookie?: string) => {
    const { getStaffContext } = await import("@/server/auth/staff");
    await as("kat", cookie);
    return (await getStaffContext())!;
  };
  const assigned = () => [shop.moline, shop["rock-island"], shop.silvis].sort();
  // Coupons are the brand's to grant; this brand gives them to its shop managers.
  const managerRole = async () => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "shop_manager") }))!;
  let managerPerms: string[] = [];
  beforeAll(async () => {
    const r = await managerRole();
    managerPerms = r.permissions;
    await m.db.db.update(m.schema.roles).set({ permissions: [...r.permissions, "promos.manage"] }).where(eq(m.schema.roles.id, r.id));
  });
  afterAll(async () => {
    await m.db.db.update(m.schema.roles).set({ permissions: managerPerms }).where(eq(m.schema.roles.key, "shop_manager"));
  });

  it("works in one assigned shop at a time, under that shop's role", async () => {
    const first = await ctxAt();
    expect(first.assignedShops.map((s) => s.id).sort()).toEqual(assigned());
    expect(first.combinedView).toBe(false);
    expect(first.brandWide).toBe(false);
    expect(first.currentShopId).toBe(shop.moline);
    expect(first.shopIds).toEqual([shop.moline]);
    expect(first.staff.roleName).toBe("Barber");
    for (const p of ["sales.view", "staff.manage", "drawer.manage", "promos.manage"] as const) expect(first.permissions.has(p), p).toBe(false);

    const ri = await ctxAt(shop["rock-island"]);
    expect(ri.shopIds).toEqual([shop["rock-island"]]);
    expect(ri.shops.map((s) => s.id)).toEqual([shop["rock-island"]]);
    expect(ri.staff.roleName).toBe("Shop Manager");
    for (const p of ["sales.view", "staff.manage", "drawer.manage", "promos.manage", "report.sales_summary.view", "campaign_center.openings"] as const) expect(ri.permissions.has(p), p).toBe(true);
    for (const p of ["catalog.manage", "permissions.manage", "logins.manage"] as const) expect(ri.permissions.has(p), p).toBe(false);

    expect((await ctxAt(shop.silvis)).shopIds).toEqual([shop.silvis]);
    for (const cookie of ["all", shop.coralville, shop.kimberly]) {
      const c = await ctxAt(cookie);
      expect(c.currentShopId, cookie).toBe(shop.moline);
      expect(c.shopIds, cookie).toEqual([shop.moline]);
    }
  });

  it("switches between only her assigned shops", async () => {
    const { switchShop } = await import("@/app/admin/actions");
    await as("kat", shop.moline);
    for (const target of [shop.coralville, shop.kimberly, "all"]) {
      await switchShop(target);
      expect(jar.shop, target).toBe(shop.moline);
    }
    await switchShop(shop["rock-island"]);
    expect(jar.shop).toBe(shop["rock-island"]);

    const layout = (await import("@/app/admin/layout")).default as (p: { children: unknown }) => Promise<unknown>;
    const text = await textOf(await layout({ children: null }), new Set());
    for (const s of ["Moline", "Rock Island", "Silvis", "Your shops", "Shop Manager"]) expect(text, s).toContain(s);
    for (const s of ["All my shops", "Coralville", "Kimberly", "Dubuque", "Utica"]) expect(text, s).not.toContain(s);

    // Someone with the same role at each shop keeps the combined view.
    const { getStaffContext } = await import("@/server/auth/staff");
    await as("regional", "all");
    const regional = (await getStaffContext())!;
    expect(regional.combinedView).toBe(true);
    expect(regional.currentShopId).toBeNull();
    expect(regional.shopIds.sort()).toEqual([shop.moline, shop["rock-island"]].sort());
  });

  it("sees the shop she's working in, and none of her other shops' operations", async () => {
    const day = { date: today };
    await as("kat", shop["rock-island"]);
    expect((await open("/admin/calendar", {}, day)).text).toContain(MARK.ri.appt);
    expect((await open("/admin/promos")).text).toContain(MARK.ri.promo);
    expect((await open("/admin/drawer")).text).toContain(MARK.ri.drawer);
    expect(await open("/admin/sales/[id]", { id: ids.marks.ri.sale })).toMatchObject({ kind: "ok" });
    expect((await open("/admin/sales/[id]", { id: ids.marks.moline.sale })).kind).not.toBe("ok");
    expect((await open("/admin/customers/[id]", { id: ids.client })).text).toContain(CANARY.item);

    await as("kat", shop.moline);
    expect((await open("/admin/calendar", {}, day)).text).toContain(MARK.moline.appt);
    for (const page of ["/admin/promos", "/admin/drawer", "/admin/sales"]) expect((await open(page)).kind, page).toBe("denied");
    expect((await open("/admin/sales/[id]", { id: ids.marks.moline.sale })).kind).not.toBe("ok");
    expect((await open("/admin/customers/[id]", { id: ids.client })).kind).toBe("redirect");

    await as("manager.moline");
    expect((await open("/admin/promos")).text).toContain(MARK.moline.promo);
    expect((await open("/admin/drawer")).text).toContain(MARK.moline.drawer);
  });

  it("acts on a shop only with that shop's role, and never on her other shops from the one she's in", async () => {
    const promos = await import("@/app/admin/promos/actions");
    const giftCards = await import("@/app/admin/gift-cards/actions");
    const settings = await import("@/app/admin/settings/actions");
    const calendar = await import("@/app/admin/calendar/actions");
    const active = async (id: string) => (await m.db.db.query.promoCodes.findFirst({ where: eq(m.schema.promoCodes.id, id) }))!.active;
    const closure = m.time.addDays(today, 43);

    await as("kat", shop["rock-island"]);
    for (const [name, call] of [
      ["promo toggle", () => promos.togglePromoAction(ids.marks.moline.promo, false)],
      ["gift card", () => giftCards.issueCompCardAction({ shopId: shop.moline, amountCents: 1000, reason: "x" })],
      ["closure", () => settings.addClosureAction(shop.moline, closure, "x", false)],
      ["appointment", () => calendar.setStatusAction(ids.marks.moline.appt, "cancelled")],
    ] as const) {
      const r = await call();
      expect(r.ok, name).toBe(false);
      expect(r.ok ? "" : r.error, name).toMatch(TENANT);
    }
    expect(await active(ids.marks.moline.promo)).toBe(true);
    expect(await promos.togglePromoAction(ids.marks.ri.promo, false)).toMatchObject({ ok: true });
    expect(await promos.togglePromoAction(ids.marks.ri.promo, true)).toMatchObject({ ok: true });
    expect(await giftCards.issueCompCardAction({ shopId: shop["rock-island"], amountCents: 1000, reason: "test" })).toMatchObject({ ok: true });

    await as("kat", shop.moline);
    for (const call of [
      () => promos.togglePromoAction(ids.marks.moline.promo, false),
      () => giftCards.issueCompCardAction({ shopId: shop.moline, amountCents: 1000, reason: "x" }),
      () => promos.togglePromoAction(ids.marks.ri.promo, false),
    ])
      expect((await call()).ok).toBe(false);
    expect(await settings.addClosureAction(shop.moline, closure, "x", false)).toMatchObject({ ok: false });
    expect(await active(ids.marks.moline.promo)).toBe(true);
    expect(await active(ids.marks.ri.promo)).toBe(true);
  });

  it("assignments and per-shop roles change at once; nobody outside her shops can set them", async () => {
    const permissions = await import("@/app/admin/permissions/actions");
    const roleId = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!.id;
    const [barber, manager, owner] = [await roleId("barber"), await roleId("shop_manager"), await roleId("brand_owner")];
    const save = (shopIds: string[], shopRoles: Record<string, string>) =>
      permissions.saveUserAccessAction({ staffId: people.kat, roleId: barber, scope: "selected", shopIds, shopRoles, overrides: {}, maxDiscountPct: null });
    const ri = shop["rock-island"];

    await as("regional");
    expect(await save([shop.moline, ri], {})).toMatchObject({ ok: false });
    await as("manager.moline");
    expect(await save([shop.moline], {})).toMatchObject({ ok: false });

    await as("owner");
    expect(await save([shop.moline, ri], { [shop.silvis]: manager })).toMatchObject({ ok: false });
    expect(await save([shop.moline, ri], { [ri]: owner })).toMatchObject({ ok: false });
    expect(await save([shop.moline, ri], { [ri]: manager })).toMatchObject({ ok: true });
    const two = await ctxAt(shop.silvis);
    expect(two.assignedShops.map((s) => s.id).sort()).toEqual([shop.moline, ri].sort());
    expect(two.currentShopId).toBe(shop.moline);

    await as("owner");
    expect(await save([shop.moline, ri], {})).toMatchObject({ ok: true });
    const same = await ctxAt("all");
    expect(same.combinedView).toBe(true);
    expect(same.currentShopId).toBeNull();
    expect(same.shopIds.sort()).toEqual([shop.moline, ri].sort());
    expect(same.permissions.has("sales.view")).toBe(false);

    await as("owner");
    expect(await save(assigned(), { [ri]: manager })).toMatchObject({ ok: true });
    expect((await ctxAt(ri)).staff.roleName).toBe("Shop Manager");
    const audit = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(and(eq(m.schema.auditLog.entityId, people.kat), eq(m.schema.auditLog.action, "permissions.user_update")));
    expect(audit.some((a) => JSON.stringify(a.details).includes('"to":{"' + ri + '":"Shop Manager"}'))).toBe(true);
  });
});

// ───────────── Jobs and notifications ─────────────

describe("background jobs and notifications", () => {
  it("processing a shop's queue leaves other shops' messages alone", async () => {
    const pending = async () => (await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, ids.smsJob) }))!.status;
    await m.queue.processDueJobs({ shopIds: [shop.moline] });
    expect(await pending()).toBe("pending");
    const { processNowAction } = await import("@/app/admin/notifications/actions");
    for (const login of ["manager.moline", "regional"] as const) {
      await as(login);
      await processNowAction();
      expect(await pending()).toBe("pending");
    }
  });

  it("every message but a sign-in code names its shop", async () => {
    await expect(m.db.db.insert(m.schema.notificationJobs).values({ kind: "confirmation", channel: "sms", to: "+13195550000", body: "x", runAt: new Date() })).rejects.toThrow();
    await m.db.db.insert(m.schema.notificationJobs).values({ kind: "otp", channel: "sms", to: "+13195550000", body: "x", runAt: new Date(), status: "cancelled" });
  });
});

// ───────────── Shop logins ─────────────

describe("shop logins", () => {
  it("each shop login is scoped to its one shop and can't see the others", async () => {
    const { getStaffContext } = await import("@/server/auth/staff");
    await as("moline");
    const ctx = (await getStaffContext())!;
    expect(ctx.staff.kind).toBe("shop");
    expect(ctx.shops.map((s) => s.id)).toEqual([shop.moline]);
    expect(ctx.currentShopId).toBe(shop.moline);
    expect(ctx.brandWide).toBe(false);
    await as("moline", shop.coralville);
    expect((await getStaffContext())!.currentShopId).toBe(shop.moline);
    await as("regional");
    expect((await getStaffContext())!.shopIds.sort()).toEqual([shop.moline, shop["rock-island"]].sort());
    await as("owner");
    const brand = (await getStaffContext())!;
    expect(brand.brandWide).toBe(true);
    expect(brand.currentShopId).toBeNull();
    expect(brand.shops).toHaveLength(Object.keys(shop).length);
  });

  it("a regional manager creates, resets and disables logins only for their shops; resets and disables end sessions", async () => {
    const logins = await import("@/app/admin/shop-logins/actions");
    const { getStaffContext } = await import("@/server/auth/staff");
    const deskRole = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "front_desk") }))!.id;
    const ownerRole = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "brand_owner") }))!.id;

    await as("moline");
    expect((await logins.createShopLoginAction({ shopId: shop.moline, label: "Tablet", email: "tablet0@rayz.test", roleId: deskRole })).ok).toBe(false);
    await as("manager.moline");
    expect((await logins.createShopLoginAction({ shopId: shop.moline, label: "Tablet", email: "tablet0@rayz.test", roleId: deskRole })).ok).toBe(false);

    await as("regional");
    expect(await logins.createShopLoginAction({ shopId: shop.moline, label: "Tablet", email: "tablet1@rayz.test", roleId: ownerRole })).toMatchObject({ ok: false });
    const made = await logins.createShopLoginAction({ shopId: shop.moline, label: "Moline tablet", email: "tablet1@rayz.test", roleId: deskRole });
    if (!made.ok) throw new Error(made.error);
    const row = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, made.data.id) }))!;
    expect(row).toMatchObject({ kind: "shop", shopScope: "one", isBookable: false, active: true });
    expect(await (await import("bcryptjs")).compare(made.data.password, row.passwordHash!)).toBe(true);
    expect(await open("/admin/shop-logins")).toMatchObject({ kind: "ok" });
    const page = await open("/admin/shop-logins");
    expect(page.text).toContain("Moline tablet");
    expect(page.text).not.toContain("coralville@rayz.test");

    await signInAs(made.data.id);
    const tablet = (await getStaffContext())!;
    expect(tablet.shops.map((s) => s.id)).toEqual([shop.moline]);
    const oldToken = jar.token;

    await new Promise((r) => setTimeout(r, 1100));
    await as("regional");
    const reset = await logins.resetShopLoginPasswordAction(made.data.id);
    if (!reset.ok) throw new Error(reset.error);
    expect(reset.data.password).not.toBe(made.data.password);
    jar.token = oldToken;
    jar.shop = undefined;
    expect(await getStaffContext()).toBeNull();
    await signInAs(made.data.id);
    expect(await getStaffContext()).not.toBeNull();

    await as("regional");
    expect(await logins.setShopLoginActiveAction(made.data.id, false)).toMatchObject({ ok: true });
    await signInAs(made.data.id);
    expect(await getStaffContext()).toBeNull();
    await as("regional");
    expect(await logins.setShopLoginActiveAction(made.data.id, true)).toMatchObject({ ok: true });

    const audit = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(and(eq(m.schema.auditLog.entityId, made.data.id), m.drizzle.like(m.schema.auditLog.action, "shop_login.%")));
    expect(audit.map((a) => a.action).sort()).toEqual(["shop_login.create", "shop_login.disable", "shop_login.enable", "shop_login.reset_password"]);
    expect(audit.every((a) => a.shopId === shop.moline)).toBe(true);
  });

  it("the brand can switch into any shop and manage every shop's logins", async () => {
    await as("owner");
    const page = await open("/admin/shop-logins");
    for (const s of ["coralville@rayz.test", "moline@rayz.test", "dubuque@rayz.test"]) expect(page.text).toContain(s);
    await as("owner", shop.coralville);
    expect((await open("/admin/shop-logins")).text).not.toContain("moline@rayz.test");
    expect((await open("/admin/calendar")).text).toContain(CANARY.barber);
  });
});
