/**
 * Clients and the Squire import: a realistic, messy export of a few hundred clients and ~1,100
 * history rows (scripts/squire-fixture.ts), checked against its ground truth. Plus the client
 * review items: matching, consent, merge, search scope, profile stats, and OTP on shared phones.
 */
import Papa from "papaparse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeSquireFixture, SquireFixture } from "../../scripts/squire-fixture";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let fx: SquireFixture;
type Kind = "clients" | "appointments" | "transactions" | "loyalty" | "gift_cards";
const KINDS: Kind[] = ["clients", "appointments", "transactions", "loyalty", "gift_cards"];
type Result = Awaited<ReturnType<Mods["importer"]["runImport"]>>;
const first: Partial<Record<Kind, Result>> = {};

beforeAll(async () => {
  m = await loadModules();
  // This file is the pre-launch bulk import. Shops are still on Squire, so the gate is open for deltas.
  await m.db.db.execute(m.drizzle.sql`update shops set launch_at = null`);
  // Export "today", so upcoming Squire bookings land 30-75 days out, past the seeded calendar.
  fx = makeSquireFixture({ exportDate: m.time.todayLocal() });
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const run = (kind: Kind, csv: string, dryRun = false) => m.importer.runImport(kind, csv, { dryRun, actor, now: fx.now, filename: `${kind}.csv` });
async function count(q: ReturnType<typeof sql>): Promise<number> {
  const [r] = (await m.db.db.execute(q)) as unknown as { n: number }[];
  return Number(r.n);
}
const bySquireId = (id: string) => m.customers.customerBySquireId(m.db.db, id);

async function snapshot() {
  return {
    customers: await count(sql`select count(*)::int n from customers`),
    squireIds: await count(sql`select count(*)::int n from customer_squire_ids`),
    appointments: await count(sql`select count(*)::int n from appointments where source = 'import'`),
    items: await count(sql`select count(*)::int n from appointment_items i join appointments a on a.id = i.appointment_id where a.source = 'import'`),
    sales: await count(sql`select count(*)::int n from sales where is_imported`),
    saleItems: await count(sql`select count(*)::int n from sale_items i join sales s on s.id = i.sale_id where s.is_imported`),
    payments: await count(sql`select count(*)::int n from payments where processor = 'squire_import'`),
    rewards: await count(sql`select count(*)::int n from loyalty_rewards where redeemed_at is null`),
    progress: await count(sql`select coalesce(sum(progress_cents), 0)::int n from loyalty_accounts`),
    giftCards: await count(sql`select count(*)::int n from gift_cards where source = 'import'`),
    giftBalance: await count(sql`select coalesce(sum(balance_cents), 0)::int n from gift_cards where source = 'import'`),
    pendingJobs: await count(sql`select count(*)::int n from notification_jobs where status = 'pending'`),
    staff: await count(sql`select count(*)::int n from staff`),
  };
}

describe("Squire import of a realistic export", () => {
  it("a dry run reports the same reconciliation and writes nothing", async () => {
    const before = await snapshot();
    const dry = await run("clients", fx.files.clients, true);
    expect(dry.dryRun).toBe(true);
    expect(dry.stats.clientsCreated).toBe(fx.expected.clients.created);
    expect(dry.stats.duplicatesMerged).toBe(fx.expected.clients.merged);
    expect(dry.skippedByReason).toEqual(fx.expected.clients.skipped);
    expect(dry.runId).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it("imports all five files and every count reconciles with the export", async () => {
    const before = await snapshot();
    for (const k of KINDS) first[k] = await run(k, fx.files[k]);
    const [c, a, t, l, g] = KINDS.map((k) => first[k]!);
    const e = fx.expected;

    expect(c.totalRows).toBe(e.clients.rows);
    expect(c.stats).toMatchObject({ clientsCreated: e.clients.created, clientsUpdated: e.clients.updated, duplicatesMerged: e.clients.merged });
    expect(c.inserted).toBe(e.clients.created);
    expect(c.updated).toBe(e.clients.updated + e.clients.merged);
    expect(c.skippedByReason).toEqual(e.clients.skipped);
    expect(c.inserted + c.updated + c.skipped).toBe(c.totalRows);

    expect(a.totalRows).toBe(e.appointments.rows);
    expect(a.stats).toMatchObject({
      appointmentsImported: e.appointments.imported,
      pastVisits: e.appointments.pastVisits,
      noShows: e.appointments.noShows,
      cancellations: e.appointments.cancellations,
      upcomingImported: e.appointments.upcoming,
      clientsCreated: e.appointments.clientsCreated,
      formerBarbersCreated: e.appointments.formerBarbers,
    });
    expect(a.skippedByReason).toEqual(e.appointments.skipped);
    expect(a.inserted + a.skipped).toBe(a.totalRows);

    expect(t.totalRows).toBe(e.transactions.rows);
    expect(t.stats).toMatchObject({
      salesImported: e.transactions.imported,
      salesVoided: e.transactions.voided,
      salesLinkedToVisits: e.transactions.linked,
      salesTotalCents: e.transactions.totalCents,
      tipsCents: e.transactions.tipsCents,
      alreadyImported: e.transactions.alreadyImported,
    });
    expect(t.skippedByReason).toEqual({ ...e.transactions.skipped, "Already imported": e.transactions.alreadyImported });

    expect(l.stats).toMatchObject({ loyaltyAccounts: e.loyalty.accounts, rewardsImported: e.loyalty.rewards });
    expect(l.skippedByReason).toEqual(e.loyalty.skipped);

    expect(g.stats).toMatchObject({ giftCards: e.giftCards.imported, giftCardBalanceCents: e.giftCards.balanceCents });
    expect(g.skippedByReason).toEqual(e.giftCards.skipped);

    const after = await snapshot();
    expect(after.customers - before.customers).toBe(e.clientsTotal);
    expect(after.appointments - before.appointments).toBe(e.appointments.imported);
    expect(after.sales - before.sales).toBe(e.transactions.imported + e.transactions.voided);
    expect(after.giftCards - before.giftCards).toBe(e.giftCards.imported);
    expect(after.staff - before.staff).toBe(e.appointments.formerBarbers);

    // Every skipped row is in the saved run's error list with its reason and original columns.
    const runs = await m.db.db.select().from(m.schema.importRuns);
    const saved = runs.find((r) => r.id === c.runId)!;
    expect(saved.errors).toHaveLength(c.skipped);
    expect(saved.stats).toMatchObject({ clientsCreated: e.clients.created, "skipped:Missing name": 2 });
    expect(saved.errors[0].data).toHaveProperty("Client ID");
  });

  it("every person in the export is one client with the right contact, consent, history, spend, and loyalty", async () => {
    const cfg = await m.loyalty.getLoyaltyConfig();
    const seen = new Set<string>();
    for (const p of fx.people) {
      const ids = p.records.map((r) => r.squireId);
      const matches = await Promise.all(ids.map(bySquireId));
      const c = matches[0];
      expect(c, `${p.key} ${ids[0]}`).toBeTruthy();
      // Two Squire records at two shops are one client here.
      for (const other of matches) expect(other?.id, p.key).toBe(c!.id);
      expect(seen.has(c!.id), `${p.key} shares a client with someone else`).toBe(false);
      seen.add(c!.id);

      expect(c!.firstName, p.key).toBe(p.first);
      expect(c!.phone, p.key).toBe(p.phone);
      expect(c!.email, p.key).toBe(p.email);
      expect({ sms: c!.smsOptIn, email: c!.emailOptIn }, p.key).toEqual({ sms: p.expect.smsOptIn, email: p.expect.emailOptIn });

      const s = await m.customers.customerStats(c!.id, m.db.db, fx.now);
      expect({ visits: s.visits, noShows: s.noShows, cancellations: s.cancellations, upcoming: s.upcoming }, p.key).toEqual({
        visits: p.visits.completed,
        noShows: p.visits.noShows,
        cancellations: p.visits.cancelled,
        upcoming: p.visits.upcoming,
      });
      expect(s.ticketSpendCents, `${p.key} ticket spend`).toBe(p.visits.ticketSpendCents);
      expect(s.squireVisitSpendCents, `${p.key} visits without a ticket`).toBe(p.visits.visitSpendCents);
      expect(s.tipsCents, p.key).toBe(p.visits.tipsCents);

      const bal = await m.loyalty.loyaltyBalance(c!.id);
      if (p.loyalty) {
        expect(bal.progressCents, `${p.key} progress`).toBe(p.loyalty.progressCents);
        expect(bal.rewards.length, `${p.key} rewards`).toBe(p.loyalty.rewards);
        expect(bal.rewards.every((r) => r.amountCents === cfg.rewardCents)).toBe(true);
      } else expect(bal.progressCents, p.key).toBe(0);
    }
    expect(seen.size).toBe(fx.expected.clientsTotal);
  });

  it("keeps messy rows honest: families and same names stay apart, odd names and phones are noted", async () => {
    const people = (kind: string) => fx.people.filter((p) => p.kind === kind);
    for (const [parent, kid] of [0, 1, 2, 3, 4, 5].map((i) => [fx.people.find((p) => p.key === `family-${i}-parent`)!, fx.people.find((p) => p.key === `family-${i}-kid`)!])) {
      const [a, b] = [await bySquireId(parent.records[0].squireId), await bySquireId(kid.records[0].squireId)];
      expect(a!.id).not.toBe(b!.id);
      expect(a!.phone).toBe(b!.phone);
    }
    const sameName = people("same_name");
    expect(new Set(await Promise.all(sameName.map(async (p) => (await bySquireId(p.records[0].squireId))!.id))).size).toBe(sameName.length);

    const okafor = await bySquireId(people("last_name_only")[0].records[0].squireId);
    expect(okafor).toMatchObject({ firstName: "Okafor", lastName: null });
    expect(okafor!.notes).toMatch(/no first name/);
    const hector = await bySquireId(people("bad_phone")[0].records[0].squireId);
    expect(hector!.phone).toBeNull();
    expect(hector!.notes).toMatch(/Squire phone not recognized: call the shop/);

    // Walk-in placeholders and first-name-only rows keep the visit, not a fake client.
    const walkIns = await count(sql`select count(*)::int n from appointments where source = 'import' and customer_id is null`);
    expect(walkIns).toBe(fx.expected.appointments.walkInsWithoutClient);
    expect(await count(sql`select count(*)::int n from appointments where source = 'import' and notes = 'Walk-in (Squire)'`)).toBe(12);
    expect(await count(sql`select count(*)::int n from appointments where source = 'import' and notes like 'Squire client: %'`)).toBe(3);
    expect(await count(sql`select count(*)::int n from customers where lower(first_name) in ('walk', 'walk in', 'walk-in')`)).toBe(0);

    // Former barbers keep their history but can't be booked or seen publicly.
    const former = await m.db.db.select().from(m.schema.staff).where(sql`${m.schema.staff.squireName} in ('Brittany', 'Destiny')`);
    expect(former).toHaveLength(2);
    for (const f of former) expect(f).toMatchObject({ active: false, isBookable: false, displayLabel: `${f.firstName} (former)` });
    const kimberly = await m.catalog.shopBarbers((await m.catalog.getShop("kimberly")).id, { onlineOnly: true });
    expect(JSON.stringify(kimberly)).not.toMatch(/Brittany/);

    // Squire rows without a booked-at time are kept out of the rebook rate rather than counted as "no".
    expect(await count(sql`select count(*)::int n from appointments where source = 'import' and not booked_at_known`)).toBe(fx.expected.appointments.bookedAtUnknown);

    // A bulk import does not text or email. Reminders exist only when notifyClients is passed.
    const jobs = (await m.db.db.execute(sql`
      select j.kind, count(*)::int n from notification_jobs j join appointments a on a.id = j.appointment_id
      where a.source = 'import' group by 1`)) as unknown as { kind: string; n: number }[];
    expect(jobs).toEqual([]);
  });

  it("re-running every file changes nothing: no new clients, visits, tickets, rewards, or reminders", async () => {
    const before = await snapshot();
    const again = {} as Record<Kind, Result>;
    for (const k of KINDS) again[k] = await run(k, fx.files[k]);
    expect(await snapshot()).toEqual(before);
    expect(again.clients.inserted).toBe(0);
    expect(again.clients.stats.duplicatesMerged).toBe(0);
    expect(again.appointments.inserted).toBe(0);
    expect(again.appointments.stats.appointmentsImported).toBe(0);
    expect(again.transactions.inserted).toBe(0);
    expect(again.transactions.stats.alreadyImported).toBe(fx.expected.transactions.imported + fx.expected.transactions.voided + 1);
    expect(again.loyalty.inserted).toBe(0);
    expect(again.loyalty.stats.rewardsImported).toBe(fx.expected.loyalty.rewards);
    expect(again.gift_cards.inserted).toBe(0);
  });

  it("imported tickets don't double count: loyalty, the drawer, and reports see each visit once", async () => {
    // Loyalty comes from Squire's balance, never from replaying imported tickets.
    expect(await count(sql`select coalesce(sum(loyalty_earned_cents), 0)::int n from sales where is_imported`)).toBe(0);
    expect(await count(sql`select count(*)::int n from loyalty_ledger where kind = 'earn' and sale_id in (select id from sales where is_imported)`)).toBe(0);

    // A day of Squire history: the drawer counts none of it; reports count each ticket once.
    const [day] = (await m.db.db.execute(sql`
      select s.shop_id, s.business_date::text d, count(*)::int n from sales s join payments p on p.sale_id = s.id
      where s.is_imported and p.method = 'cash' and s.status = 'paid' group by 1, 2 order by 3 desc limit 1`)) as unknown as { shop_id: string; d: string; n: number }[];
    const drawer = await m.checkout.drawerSummary(day.shop_id, day.d);
    expect(drawer.cashSalesCents).toBe(0);
    expect(drawer.cashTickets).toBe(0);
    expect(drawer.cardCents).toBe(0);

    const scope = { shopIds: (await m.db.db.select().from(m.schema.shops)).map((s) => s.id), from: m.time.addDays(fx.exportDate, -600), to: m.time.addDays(fx.exportDate, -4) };
    const summary = await m.reports.salesSummary(scope);
    const imported = (await m.db.db.execute(sql`
      select count(*)::int n, coalesce(sum(service_net_cents + product_net_cents), 0)::int net, coalesce(sum(tip_cents), 0)::int tips
      from sales where is_imported and status = 'paid' and business_date between ${scope.from} and ${scope.to}`)) as unknown as { n: number; net: number; tips: number }[];
    expect(summary.tickets).toBe(imported[0].n);
    expect(summary.netSalesCents).toBe(imported[0].net);
    expect(summary.tipsCents).toBe(imported[0].tips);

    // KPIs count visits from appointments, so a visit with its ticket is still one visit.
    const k = await m.reports.kpis(scope);
    const visits = await count(sql`select count(*)::int n from appointments where status = 'completed' and customer_id is not null and booked_at_known
      and starts_at >= ${m.time.startOfLocalDay(scope.from).toISOString()} and starts_at < ${m.time.endOfLocalDay(scope.to).toISOString()}`);
    expect(k.visits).toBe(visits);
    expect(k.visitsWithoutBookingTime).toBeGreaterThan(0);
  });

  it("the error file lists each skipped row with its reason and the original Squire columns", async () => {
    const r = first.appointments!;
    const parsed = Papa.parse<Record<string, string>>(m.importErrors.errorsCsv(r.errors), { header: true, skipEmptyLines: true });
    expect(parsed.data).toHaveLength(r.skipped);
    expect(parsed.meta.fields!.slice(0, 3)).toEqual(["Import row", "Skip reason", "Details"]);
    expect(parsed.meta.fields).toEqual(expect.arrayContaining(["Appointment ID", "Location", "Barber"]));
    const reasons: Record<string, number> = {};
    for (const row of parsed.data) reasons[row["Skip reason"]] = (reasons[row["Skip reason"]] ?? 0) + 1;
    expect(reasons).toEqual(fx.expected.appointments.skipped);
    expect(parsed.data.find((x) => x["Skip reason"] === "Unknown shop")!.Location).toBe("Clinton");
  });
});

// ───────────────────────────── Re-imports after cutover ─────────────────────────────

const CLIENT_HEADER = "Client ID,First Name,Last Name,Phone,Email,Location,SMS Opt In,Email Marketing";

describe("Squire re-imports", () => {
  it("a corrected phone in Squire lands on re-import (review P2#28)", async () => {
    const p = fx.people.find((x) => x.kind === "regular" && x.phone && x.records[0].sms === "Yes")!;
    const r = p.records[0];
    const r1 = await run("clients", `${CLIENT_HEADER}\n${r.squireId},${r.first},${r.last},(563) 555-9911,${r.emailRaw.trim()},${r.shop},Yes,\n`);
    expect(r1.updated).toBe(1);
    expect((await bySquireId(r.squireId))!.phone).toBe("+15635559911");
  });

  it("an explicit opt-out wins on re-import, and a file without the column changes nothing (review P1#16)", async () => {
    const p = fx.people.find((x) => x.kind === "regular" && x.phone && x.expect.smsOptIn && x.key !== "regular-0")!;
    const r = p.records[0];
    await run("clients", `${CLIENT_HEADER}\n${r.squireId},${r.first},${r.last},${r.phoneRaw},,${r.shop},No,No\n`);
    expect(await bySquireId(r.squireId)).toMatchObject({ smsOptIn: false, emailOptIn: false });
    await run("clients", `Client ID,First Name,Last Name,Phone\n${r.squireId},${r.first},${r.last},${r.phoneRaw}\n`);
    expect((await bySquireId(r.squireId))!.smsOptIn).toBe(false);

    // A brand-new client from a file with no consent columns is opted out until they say yes.
    await run("clients", `Client ID,First Name,Last Name,Phone\nSQ-88001,Quentin,Abara,309-555-9101\n`);
    expect(await bySquireId("SQ-88001")).toMatchObject({ smsOptIn: false, emailOptIn: false });
  });

  it("re-running the loyalty file replaces the balance instead of adding rewards (review P1#17)", async () => {
    const p = fx.people.find((x) => x.kind === "regular" && x.loyalty && x.loyalty.rewards === 0)!;
    const r = p.records[0];
    const csv = `Client ID,Progress,Rewards Available\n${r.squireId},$120.00,2\n`;
    await run("loyalty", csv);
    await run("loyalty", csv);
    const bal = await m.loyalty.loyaltyBalance((await bySquireId(r.squireId))!.id);
    expect(bal.progressCents).toBe(12_000);
    expect(bal.rewards).toHaveLength(2);
  });

  it("an imported gift card used at checkout keeps its balance here on re-import", async () => {
    const [card] = await m.db.db.select().from(m.schema.giftCards).where(eq(m.schema.giftCards.code, "SQGC-3001"));
    await m.db.db.update(m.schema.giftCards).set({ balanceCents: card.balanceCents - 500 }).where(eq(m.schema.giftCards.id, card.id));
    await m.db.db.insert(m.schema.giftCardLedger).values({ giftCardId: card.id, deltaCents: -500, kind: "redeem" });
    const r = await run("gift_cards", fx.files.gift_cards);
    expect(r.skippedByReason["Gift card used here"]).toBe(1);
    expect((await m.checkout.lookupGiftCard("SQGC-3001")).balanceCents).toBe(card.balanceCents - 500);
  });

  it("an upcoming Squire booking that has been checked in here isn't overwritten", async () => {
    const [a] = (await m.db.db.execute(sql`select id, squire_id from appointments where source = 'import' and status = 'booked' limit 1`)) as unknown as { id: string; squire_id: string }[];
    await m.db.db.update(m.schema.appointments).set({ status: "checked_in" }).where(eq(m.schema.appointments.id, a.id));
    const r = await run("appointments", fx.files.appointments);
    expect(r.stats.alreadyImported).toBeGreaterThanOrEqual(1);
    expect((await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, a.id) }))!.status).toBe("checked_in");
  });
});

// ───────────────────────────── Client model (review P1#13-18, P2#30-32) ─────────────────────────────

let phoneSeq = 0;
const nextPhone = () => `+1319555${String(9200 + ++phoneSeq)}`;
const staffNamed = async (label: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!;
const shopNamed = (slug: string) => m.catalog.getShop(slug);

async function visit(o: { customerId: string; shop: string; barber: string; at: Date; status?: "completed" | "booked"; bookedAt?: Date | null; estimateCents?: number }) {
  const shop = await shopNamed(o.shop);
  const staff = await staffNamed(o.barber);
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `T${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: shop.id,
      staffId: staff.id,
      customerId: o.customerId,
      startsAt: o.at,
      endsAt: new Date(o.at.getTime() + 30 * 60_000),
      status: o.status ?? "completed",
      source: "staff",
      estimateCents: o.estimateCents ?? 2300,
      completedAt: (o.status ?? "completed") === "completed" ? new Date(o.at.getTime() + 30 * 60_000) : null,
      createdAt: o.bookedAt ?? new Date(o.at.getTime() - 86_400_000),
      bookedAtKnown: o.bookedAt !== null,
    })
    .returning();
  return a;
}

describe("one client record, matched the same way everywhere", () => {
  it("simultaneous bookings for a new client create one record, not two (review P1#15)", async () => {
    const phone = nextPhone();
    const make = (first: string) => m.db.db.transaction((tx) => m.customers.findOrCreateCustomer({ firstName: first, lastName: "Race", phone }, null, tx));
    const out = await Promise.all(["Samuel", "Sam", "Samuel", "Samuel", "sam", "Samuel"].map(make));
    expect(new Set(out.map((c) => c.id)).size).toBe(1);
    expect(await count(sql`select count(*)::int n from customers where phone = ${phone}`)).toBe(1);
  });

  it("a family on one phone stays separate people; a nickname is the same person", async () => {
    const phone = nextPhone();
    const dad = await m.customers.findOrCreateCustomer({ firstName: "Michael", lastName: "Ortiz", phone }, null);
    const kid = await m.customers.findOrCreateCustomer({ firstName: "Luis", lastName: "Ortiz", phone }, null);
    const mike = await m.customers.findOrCreateCustomer({ firstName: "Mike", phone }, null);
    expect(kid.id).not.toBe(dad.id);
    expect(mike.id).toBe(dad.id);
    // Without a first name, a shared phone is ambiguous, so it matches no one.
    expect(await m.customers.matchCustomer(m.db.db, { phone })).toBeNull();
    const pairs = await m.customers.duplicatePairs({ forId: dad.id });
    expect(pairs.find((p) => [p.a.id, p.b.id].includes(kid.id))?.kind).toBe("shared_contact");
  });

  it("an explicit opt-out on a later booking sticks; no answer keeps what's on file (review P1#16)", async () => {
    const phone = nextPhone();
    const c = await m.customers.findOrCreateCustomer({ firstName: "Opal", phone, smsOptIn: true, emailOptIn: true, email: "opal@fixture.test" }, null);
    expect(c).toMatchObject({ smsOptIn: true, emailOptIn: true });
    await m.customers.findOrCreateCustomer({ firstName: "Opal", phone, smsOptIn: false, emailOptIn: false }, null);
    await m.customers.findOrCreateCustomer({ firstName: "Opal", phone }, null);
    const row = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.id) });
    expect(row).toMatchObject({ smsOptIn: false, emailOptIn: false });
    // New records default to no.
    const fresh = await m.customers.findOrCreateCustomer({ firstName: "Pia", phone: nextPhone() }, null);
    expect(fresh).toMatchObject({ smsOptIn: false, emailOptIn: false });
  });

  it("signing in on a shared phone asks who you are instead of picking the newest profile (review P1#15)", async () => {
    process.env.AUTH_DEV_CODES = "true";
    const phone = nextPhone();
    const mom = await m.customers.findOrCreateCustomer({ firstName: "Dana", lastName: "Quill", phone }, null);
    const son = await m.customers.findOrCreateCustomer({ firstName: "Eli", lastName: "Quill", phone }, null);
    const start = await m.auth.startOtp({ phone });
    if (!("devCode" in start) || !start.devCode) throw new Error("expected a dev code");
    const r = await m.auth.verifyOtp({ phone, code: start.devCode });
    expect(r).toMatchObject({ needsProfile: false, chooseProfile: true });
    if (!("profiles" in r) || !r.profiles) throw new Error("expected a profile choice");
    expect(r.profiles.map((p) => p.firstName).sort()).toEqual(["Dana", "Eli"]);
    expect(JSON.stringify(r.profiles)).not.toMatch(/Quill/);

    const asSon = await m.auth.completeSignIn({ selectionToken: r.selectionToken, customerId: son.id });
    if (!("customer" in asSon)) throw new Error("expected a signed-in customer");
    expect(asSon.customer.id).toBe(son.id);
    const stranger = await m.customers.findOrCreateCustomer({ firstName: "Zed", phone: nextPhone() }, null);
    await expect(m.auth.completeSignIn({ selectionToken: r.selectionToken, customerId: stranger.id })).rejects.toMatchObject({ code: "forbidden" });
    // A third family member on the same phone gets their own profile.
    const dad = await m.auth.completeSignIn({ selectionToken: r.selectionToken, firstName: "Frank", lastName: "Quill" });
    if (!("customer" in dad)) throw new Error("expected a signed-in customer");
    expect(dad.isNew).toBe(true);
    expect([mom.id, son.id]).not.toContain(dad.customer.id);
  });

  it("a walk-in with no phone still becomes a client (review P1#14)", async () => {
    const shop = await shopNamed("coralville");
    const svc = (await m.catalog.shopCatalog(shop.id)).find((s) => s.slug === "rayz-cut")!;
    const r = await m.booking.quickWalkIn({ shopId: shop.id, serviceId: svc.id, name: "Rocco Vance", actor });
    const customerId = r.seated ? r.appointment.customer?.id : r.entry.customerId;
    expect(customerId).toBeTruthy();
    const c = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, customerId!) });
    expect(c).toMatchObject({ firstName: "Rocco", lastName: "Vance", phone: null });
  });

  it("the waitlist ready text respects an SMS opt-out (review P2#31)", async () => {
    const no = await m.customers.findOrCreateCustomer({ firstName: "Nell", phone: nextPhone(), smsOptIn: false }, null);
    const yes = await m.customers.findOrCreateCustomer({ firstName: "Yuri", phone: nextPhone(), smsOptIn: true }, null);
    expect(await m.customers.textingDeclined(no.id, no.phone!)).toBe(true);
    expect(await m.customers.textingDeclined(yes.id, yes.phone!)).toBe(false);
    expect(await m.customers.textingDeclined(null, no.phone!)).toBe(true);
    // A new walk-in who gave a number to be texted is opted in for it.
    const shop = await shopNamed("coralville");
    const walkIn = await m.db.db.transaction((tx) => m.customers.findOrCreateCustomer({ firstName: "Wren", phone: nextPhone() }, shop.id, tx, { allowNoContact: true, smsOptInIfNew: true }));
    expect(await m.customers.textingDeclined(walkIn.id, walkIn.phone!)).toBe(false);
  });

  it("merging two records moves history, tickets, gift cards, loyalty, and Squire IDs, then deletes the duplicate", async () => {
    const keep = await m.customers.findOrCreateCustomer({ firstName: "Gus", lastName: "Merge", phone: nextPhone(), smsOptIn: true }, null);
    const drop = (
      await m.db.db.insert(m.schema.customers).values({ firstName: "Gus", lastName: "Merge", email: "gus@fixture.test", smsOptIn: false, notes: "Likes a #3" }).returning()
    )[0];
    await m.db.db.insert(m.schema.customerSquireIds).values({ squireId: "SQ-MERGE-1", customerId: drop.id });
    const a = await visit({ customerId: drop.id, shop: "kimberly", barber: "Beth", at: new Date(Date.now() - 40 * 86_400_000) });
    const [sale] = await m.db.db
      .insert(m.schema.sales)
      .values({ shopId: a.shopId, customerId: drop.id, appointmentId: a.id, status: "paid", businessDate: m.time.localDateOf(a.startsAt), serviceNetCents: 2300, totalCents: 2300 })
      .returning();
    const [card] = await m.db.db.insert(m.schema.giftCards).values({ code: "MERGE-GC-1", initialCents: 2500, balanceCents: 2500, customerId: drop.id }).returning();
    await m.db.db.insert(m.schema.loyaltyAccounts).values([
      { customerId: keep.id, progressCents: 20_000 },
      { customerId: drop.id, progressCents: 15_000 },
    ]);

    const r = await m.customers.mergeCustomers(keep.id, drop.id, actor);
    expect(r.moved).toMatchObject({ appointments: 1, sales: 1, giftCards: 1, squireIds: 1 });
    expect(r.rewardsIssued).toBe(1);
    expect(await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, drop.id) })).toBeUndefined();
    const merged = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, keep.id) }))!;
    expect(merged).toMatchObject({ email: "gus@fixture.test", notes: "Likes a #3", smsOptIn: false });
    expect((await bySquireId("SQ-MERGE-1"))!.id).toBe(keep.id);
    expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, sale.id) }))!.customerId).toBe(keep.id);
    expect((await m.db.db.query.giftCards.findFirst({ where: eq(m.schema.giftCards.id, card.id) }))!.customerId).toBe(keep.id);
    const bal = await m.loyalty.loyaltyBalance(keep.id);
    expect(bal.progressCents).toBe(5_000);
    expect(bal.rewards).toHaveLength(1);
    expect((await m.customers.customerStats(keep.id)).visits).toBe(1);
    expect(await count(sql`select count(*)::int n from audit_log where action = 'customer.merge' and entity_id = ${keep.id}`)).toBe(1);
  });
});

describe("profiles, search, and access", () => {
  it("lifetime spend and visit counts are computed in SQL and net of refunds (review P1#18)", async () => {
    const { slot, svc } = await (async () => {
      const shop = await shopNamed("coralville");
      const svc = (await m.catalog.shopCatalog(shop.id)).find((s) => s.slug === "rayz-cut-shampoo")!;
      for (let i = 3; i < 20; i++) {
        const a = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(m.time.todayLocal(), i), serviceId: svc.id, barberRef: "any" });
        if (a.slots.length) return { slot: a.slots[0], svc };
      }
      throw new Error("no slots");
    })();
    const phone = nextPhone();
    const appt = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: "any", startsAt: slot.startsAt, customer: { firstName: "Rhea", phone }, source: "staff", actor });
    const sale = await m.checkout.openSaleForAppointment(appt.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    await m.checkout.finalizeSale({ saleId: sale.id, lines: ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty })), tipCents: 400, tender: { method: "cash", cashTenderedCents: null }, actor });
    const before = await m.customers.customerStats(appt.customer!.id);
    expect(before.ticketSpendCents).toBe(svc.priceCents);
    expect(before.tipsCents).toBe(400);
    const [item] = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, sale.id));
    await m.checkout.refundSale({ saleId: sale.id, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 400, refundCardFee: false, reason: "Redo", restock: false, actor });
    const after = await m.customers.customerStats(appt.customer!.id);
    expect(after.ticketSpendCents).toBe(0);
    expect(after.tipsCents).toBe(0);
    expect(after.lifetimeSpendCents).toBe(0);
  });

  it("barbers search only clients seen at their shops and open only their own clients (review P1#13)", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Ximena", lastName: "Searchable", phone: nextPhone() }, null);
    await visit({ customerId: c.id, shop: "coralville", barber: "Makenna", at: new Date(Date.now() - 10 * 86_400_000) });
    const coralville = await shopNamed("coralville");
    const kimberly = await shopNamed("kimberly");
    expect((await m.customers.searchCustomers("ximena", { shops: [coralville.id] })).map((x) => x.id)).toContain(c.id);
    expect((await m.customers.searchCustomers("ximena", { shops: [kimberly.id] })).map((x) => x.id)).not.toContain(c.id);
    expect((await m.customers.searchCustomers("ximena searchable", { shops: [kimberly.id] })).map((x) => x.id)).toContain(c.id);
    expect((await m.customers.searchCustomers(c.phone!.slice(-4), {})).map((x) => x.id)).toContain(c.id);
    expect((await m.customers.searchCustomers("searchab", {})).map((x) => x.id)).toContain(c.id);

    const makenna = await staffNamed("Makenna");
    const beth = await staffNamed("Beth");
    expect(await m.customers.customerAccess({ staffId: makenna.id, viewAll: false }, c.id)).toBe("barber");
    expect(await m.customers.customerAccess({ staffId: beth.id, viewAll: false }, c.id)).toBeNull();
    expect(await m.customers.customerAccess({ staffId: beth.id, viewAll: true }, c.id)).toBe("full");
  });
});

describe("KPIs on imported and shared history (review P2#30)", () => {
  it("a client new to this shop counts as new here even if another shop has seen them", async () => {
    const c = await m.customers.findOrCreateCustomer({ firstName: "Nadia", lastName: "Kpi", phone: nextPhone() }, null);
    const day = (d: number) => m.time.zonedWallTime(m.time.addDays(m.time.todayLocal(), d), 10 * 60).toJSDate();
    await visit({ customerId: c.id, shop: "moline", barber: "Jilane", at: day(-200) });
    await visit({ customerId: c.id, shop: "silvis", barber: "Abigail", at: day(-150), bookedAt: null });
    const coralville = await shopNamed("coralville");
    const from = m.time.addDays(m.time.todayLocal(), -120);
    const to = m.time.addDays(m.time.todayLocal(), -100);
    const before = await m.reports.kpis({ shopIds: [coralville.id], from, to });
    await visit({ customerId: c.id, shop: "coralville", barber: "Makenna", at: day(-110) });
    const after = await m.reports.kpis({ shopIds: [coralville.id], from, to });
    expect(after.newClients - before.newClients).toBe(1);
    expect(after.newToBrand - before.newToBrand).toBe(0);
    expect(after.returningClients - before.returningClients).toBe(0);

    // A visit with no known booking time is left out of the rebook rate, not counted as "not rebooked".
    const silvis = await shopNamed("silvis");
    const k = await m.reports.kpis({ shopIds: [silvis.id], from: m.time.addDays(m.time.todayLocal(), -151), to: m.time.addDays(m.time.todayLocal(), -149) });
    expect(k.visitsWithoutBookingTime).toBeGreaterThanOrEqual(1);
  });
});
