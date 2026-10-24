/**
 * The event log against the seeded brand: what the triggers record for each kind of action, who
 * did it and from where, that it's append-only and never holds contact details, erasure and merge,
 * backfill, the booking funnel, the raw export and the warehouse copy, the Operations KPIs, and the
 * event source in the report builder and Rayz Assistant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let engine: typeof import("@/server/report-builder/engine");
let context: typeof import("@/server/report-builder/context");
let privacy: typeof import("@/server/client-privacy");
let rb: typeof import("@/domain/report-builder");
let tools: typeof import("@/server/assistant/tools");
let assistant: typeof import("@/server/assistant");
type Ctx = import("@/server/auth/staff").StaffContext;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];
const ctxOf = async (who: string) => (await context.staffContextFor(ids[who]))!;
const withPerms = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions, ...perms]) as Ctx["permissions"] });
const without = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions].filter((p) => !perms.includes(p))) as Ctx["permissions"] });
const eventsDef = (x: Record<string, unknown>) => rb.ReportDefinition.parse({ source: "events", columns: [{ field: "event" }], ...x });

beforeAll(async () => {
  m = await loadModules();
  engine = await import("@/server/report-builder/engine");
  context = await import("@/server/report-builder/context");
  privacy = await import("@/server/client-privacy");
  rb = await import("@/domain/report-builder");
  tools = await import("@/server/assistant/tools");
  assistant = await import("@/server/assistant");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
}, 180_000);

afterAll(async () => {
  await m.db.closeDb();
});

const actorOf = (id: string) => ({ staffId: id, label: "test" });
const eventsOf = (where: ReturnType<typeof sql>) => rows<Record<string, unknown>>(sql`select * from analytics_events where ${where} order by id`);
async function newCustomer(first: string) {
  const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: first, lastName: "Eventlog", homeShopId: shop.coralville }).returning({ id: m.schema.customers.id });
  return c.id;
}

describe("what the triggers record", () => {
  it("logs every seeded booking and paid ticket once, with its channel, lead time and money", async () => {
    const [a] = await rows<{ appts: number; booked: number; paid: number; tickets: number; lines: number; items: number }>(sql`select
      (select count(*)::int from appointments) appts, (select count(*)::int from analytics_events where event = 'booking.created') booked,
      (select count(*)::int from sales where paid_at is not null and status <> 'open') paid, (select count(*)::int from analytics_events where event = 'ticket.paid') tickets,
      (select count(*)::int from sale_items i join sales s on s.id = i.sale_id where s.paid_at is not null and s.status <> 'open') items, (select count(*)::int from analytics_events where event = 'ticket.line') lines`);
    expect(a.booked).toBe(a.appts);
    expect(a.tickets).toBe(a.paid);
    expect(a.lines).toBe(a.items);
    const [t] = await rows<{ amount: number; net: number; channels: string[] }>(sql`select
      (select sum(amount_cents)::float8 from analytics_events where event = 'ticket.paid') amount,
      (select sum(service_net_cents + product_net_cents)::float8 from sales where paid_at is not null and status <> 'open') net,
      (select array_agg(distinct channel order by channel) from analytics_events where event = 'booking.created') channels`);
    expect(t.amount).toBe(t.net);
    expect(t.channels.length).toBeGreaterThan(1);
    for (const e of ["appointment.arrived", "appointment.started", "appointment.finished", "payment.taken", "clock.in"]) {
      const [n] = await rows<{ n: number }>(sql`select count(*)::int n from analytics_events where event = ${e}`);
      expect(n.n, e).toBeGreaterThan(0);
    }
  });

  it("stamps who did it and from what device, and keeps the cancellation's reason without card numbers", async () => {
    const { withEventContext, setEventActor } = await import("@/db/event-context");
    const [a] = await rows<{ code: string; id: string }>(sql`select code, id from appointments where status = 'booked' and starts_at > now() + interval '3 hours' order by starts_at limit 1`);
    await withEventContext({ device: "tablet" }, async () => {
      setEventActor(ids.frontdesk);
      await m.booking.cancelAppointment(a.code, { actor: actorOf(ids.frontdesk), byCustomer: false, reason: "Car trouble, paid with 4242 4242 4242 4242" });
    });
    const [e] = await eventsOf(sql`event = 'booking.cancelled' and appointment_id = ${a.id}`);
    expect(e).toMatchObject({ actor_kind: "staff", actor_staff_id: ids.frontdesk, device: "tablet", channel: "staff", entity: "appointment" });
    expect(e.subtype).toMatch(/^(in_time|late)$/);
    expect(Number(e.minutes)).toBeGreaterThan(170);
    expect(String(e.reason)).toMatch(/^Car trouble/);
    expect(String(e.reason)).not.toContain("4242 4242");
    const [stored] = await rows<{ r: string }>(sql`select cancel_reason r from appointments where id = ${a.id}`);
    expect(stored.r).not.toContain("4242 4242");
  });

  it("stamps the signed-in person and their device through a server action", async () => {
    const { safe } = await import("@/server/action");
    const { authorize } = await import("@/server/auth/staff");
    const { signInAs, jar } = await import("./session");
    await signInAs(ids.michelle);
    jar.userAgent = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)";
    const michelle = await ctxOf("michelle");
    const [a] = await rows<{ code: string; id: string }>(sql`select code, id from appointments where status = 'booked' and starts_at > now() + interval '3 hours' and shop_id in (${m.drizzle.sql.join(
      michelle.shopIds.map((s) => sql`${s}::uuid`),
      sql`, `,
    )}) order by starts_at limit 1`);
    const r = await safe(async () => {
      await authorize([...michelle.permissions][0]);
      await m.booking.cancelAppointment(a.code, { actor: actorOf(ids.michelle), byCustomer: false });
    });
    jar.userAgent = undefined;
    expect(r.ok).toBe(true);
    const [e] = await eventsOf(sql`event = 'booking.cancelled' and appointment_id = ${a.id}`);
    expect(e).toMatchObject({ actor_staff_id: ids.michelle, device: "tablet", actor_kind: "staff" });
  });

  it("is append-only: rows can't be changed or deleted, only made anonymous", async () => {
    const [e] = await rows<{ id: number }>(sql`select id from analytics_events where customer_id is not null order by id limit 1`);
    await expect(m.db.db.execute(sql`update analytics_events set event = 'booking.created', amount_cents = 1 where id = ${e.id}`)).rejects.toThrow();
    await expect(m.db.db.execute(sql`delete from analytics_events where id = ${e.id}`)).rejects.toThrow();
    const [check] = await rows<{ amount: number | null }>(sql`select amount_cents amount from analytics_events where id = ${e.id}`);
    expect(check.amount).not.toBe(1);
  });

  it("never holds a client's phone number or email address", async () => {
    const phones = new Set((await rows<{ p: string }>(sql`select distinct right(regexp_replace(phone, '\\D', '', 'g'), 10) p from customers where length(regexp_replace(coalesce(phone, ''), '\\D', '', 'g')) >= 10`)).map((x) => x.p));
    expect(phones.size).toBeGreaterThan(10);
    const texts = await rows<{ t: string }>(sql`select props::text || ' ' || coalesce(reason, '') || ' ' || coalesce(subtype, '') || ' ' || coalesce(source, '') || ' ' || coalesce(entity_id, '') t from analytics_events`);
    const leaks = texts.filter(({ t }) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(t) || (t.match(/\d{10,}/g) ?? []).some((run) => [...Array(run.length - 9).keys()].some((i) => phones.has(run.slice(i, i + 10)))));
    expect(leaks).toEqual([]);
  });

  it("makes an erased client's events anonymous, here and for the warehouse", async () => {
    const c = await newCustomer("Erase");
    expect(await eventsOf(sql`customer_id = ${c}`)).toHaveLength(1);
    await m.db.db.delete(m.schema.customers).where(m.drizzle.eq(m.schema.customers.id, c));
    expect(await eventsOf(sql`customer_id = ${c}`)).toHaveLength(0);
    const removed = (await eventsOf(sql`event = 'client.removed'`)).at(-1);
    expect(removed).toMatchObject({ customer_id: null, entity_id: null, quantity: 1 });
    expect(await rows(sql`select 1 from analytics_customer_moves where from_customer = ${c} and to_customer is null`)).toHaveLength(1);
  });

  it("moves a merged client's events to the client kept", async () => {
    const keep = await newCustomer("Keep");
    const drop = await newCustomer("Drop");
    await m.customers.mergeCustomers(keep, drop, actorOf(ids.owner));
    expect(await eventsOf(sql`customer_id = ${drop}`)).toHaveLength(0);
    expect((await eventsOf(sql`customer_id = ${keep}`)).map((e) => e.entity_id)).toEqual(expect.arrayContaining([keep, drop]));
    expect(await rows(sql`select 1 from analytics_customer_moves where from_customer = ${drop} and to_customer = ${keep}`)).toHaveLength(1);
  });

  it("logs history once: a backfill marks what it adds and adds nothing the second time", async () => {
    const analytics = await import("@/server/analytics");
    await m.db.db.execute(sql`alter table customers disable trigger customers_analytics`);
    const c = await newCustomer("Before");
    await m.db.db.execute(sql`alter table customers enable trigger customers_analytics`);
    expect(await eventsOf(sql`customer_id = ${c}`)).toHaveLength(0);
    const first = await analytics.runBackfill({ tables: ["customers"], force: true });
    expect(first.done.customers).toBe(1);
    const [e] = await eventsOf(sql`customer_id = ${c}`);
    expect(e).toMatchObject({ event: "client.created", actor_kind: "system" });
    expect((e.props as Record<string, unknown>).backfilled).toBe(true);
    expect((await analytics.runBackfill({ tables: ["customers"], force: true })).done.customers).toBe(0);
    expect((await analytics.loadAnalyticsSettings()).backfilled).toContain("customers");
    expect((await analytics.runBackfill({ tables: ["customers"] })).done).toEqual({});
  });
});

describe("the online booking funnel", () => {
  it("logs each step once by the page's ids and slugs, ties the booked step to the appointment and caps a visitor", async () => {
    const analytics = await import("@/server/analytics");
    const f = "wtestfunnel0000000001";
    const [barber] = await rows<{ id: string; slug: string }>(sql`select s.id, s.public_slug slug from staff s join staff_shops ss on ss.staff_id = s.id where ss.shop_id = ${shop.coralville} and s.is_bookable limit 1`);
    const [svc] = await rows<{ id: string }>(sql`select service_id id from shop_services where shop_id = ${shop.coralville} limit 1`);
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
    await analytics.recordFunnelStep({ funnel: f, step: "viewed", shop: "coralville" }, ua);
    await analytics.recordFunnelStep({ funnel: f, step: "viewed", shop: "coralville" }, ua);
    await analytics.recordFunnelStep({ funnel: f, step: "service_picked", shop: "coralville", services: [svc.id] }, ua);
    await analytics.recordFunnelStep({ funnel: f, step: "barber_picked", shop: "coralville", staff: barber.slug }, ua);
    const [a] = await rows<{ id: string; code: string; customer: string }>(sql`select id, code, customer_id customer from appointments where shop_id = ${shop.coralville} and customer_id is not null limit 1`);
    await m.db.db.execute(sql`update appointments set created_at = now() where id = ${a.id}`);
    await analytics.recordFunnelStep({ funnel: f, step: "booked", shop: "coralville", appointment: a.code }, ua);
    const got = await eventsOf(sql`entity = 'funnel' and entity_id = ${f}`);
    expect(got.map((e) => e.event)).toEqual(["funnel.viewed", "funnel.service_picked", "funnel.barber_picked", "funnel.booked"]);
    expect(got.every((e) => e.device === "phone" && e.channel === "online" && e.actor_kind === "client" && e.shop_id === shop.coralville)).toBe(true);
    expect(got[2]).toMatchObject({ staff_id: barber.id, subtype: "barber" });
    expect(got[3]).toMatchObject({ appointment_id: a.id, customer_id: a.customer });
    expect(got.slice(0, 3).every((e) => e.customer_id === null)).toBe(true);
    await expect(analytics.recordFunnelStep({ funnel: f, step: "booked", shop: "coralville", appointment: "nope-not-a-code" }, ua)).rejects.toThrow();

    const g = "wtestfunnel0000000002";
    for (let i = 0; i < 45; i++) await analytics.recordFunnelStep({ funnel: g, step: "time_picked", shop: "coralville", startsAt: new Date(Date.now() + (i + 1) * 3_600_000).toISOString() }, ua);
    expect(await eventsOf(sql`entity_id = ${g}`)).toHaveLength(40);
  });

  it("marks a funnel abandoned an hour after its last step, once", async () => {
    const analytics = await import("@/server/analytics");
    const f = "wtestfunnel0000000003";
    const then = new Date(Date.now() - 2 * 3_600_000);
    await analytics.recordFunnelStep({ funnel: f, step: "viewed", shop: shop.coralville }, null, then);
    await analytics.recordFunnelStep({ funnel: f, step: "details", shop: shop.coralville }, null, new Date(then.getTime() + 5 * 60_000));
    await analytics.sweepAbandonedFunnels();
    await analytics.sweepAbandonedFunnels();
    const left = await eventsOf(sql`entity_id = ${f} and event = 'funnel.abandoned'`);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ subtype: "details", minutes: 5 });
    expect(await eventsOf(sql`entity_id = 'wtestfunnel0000000001' and event = 'funnel.abandoned'`)).toHaveLength(0);
  });
});

describe("raw export and the warehouse copy", () => {
  it("downloads the raw log as CSV for the Brand Owner only, and logs it", async () => {
    const { GET } = await import("@/app/admin/analytics/export/route");
    const { signInAs } = await import("./session");
    const { get } = await import("./render");
    const { EVENT_COLUMNS } = await import("@/domain/analytics");
    const { todayLocal, addDays } = m.time;
    const from = addDays(todayLocal(), -30);
    const to = addDays(todayLocal(), 30);
    for (const who of ["admin", "michelle", "makenna"]) {
      await signInAs(ids[who]);
      expect((await get(GET, `/admin/analytics/export?from=${from}&to=${to}`)).status, who).toBe(403);
    }
    await signInAs(ids.owner);
    const r = await get(GET, `/admin/analytics/export?from=${from}&to=${to}&category=booking`);
    expect(r.status).toBe(200);
    const lines = r.text.trim().split("\n");
    expect(lines[0]).toBe(EVENT_COLUMNS.map((c) => c.key).join(","));
    const [n] = await rows<{ n: number }>(sql`select count(*)::int n from analytics_events where category = 'booking' and business_date between ${from}::date and ${to}::date`);
    expect(lines.length - 1).toBe(n.n);
    expect(r.text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    expect(await rows(sql`select 1 from audit_log where action = 'analytics.export' and actor_staff_id = ${ids.owner}`)).toHaveLength(1);
  });

  it("copies new events to a Postgres warehouse once, applies merges and erasures there, and never stores the address", async () => {
    const analytics = await import("@/server/analytics");
    const postgres = (await import("postgres")).default;
    const base = (process.env.TEST_DATABASE_URL ?? "postgres://rayz:rayz@localhost:5432/rayz_test").replace(/\/[^/]+$/, "");
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await admin.unsafe("drop database if exists rayz_warehouse_test with (force)");
    await admin.unsafe("create database rayz_warehouse_test");
    await admin.end();
    const url = `${base}/rayz_warehouse_test`;
    expect(await analytics.exportToWarehouse({ url })).toEqual({ skipped: "off" });
    await analytics.saveAnalyticsSettings({ satisfaction: false, warehouse: true }, actorOf(ids.owner));
    const first = await analytics.exportToWarehouse({ url });
    if ("failed" in first) console.log((await analytics.warehouseRuns(1))[0]);
    const wh = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [{ n }] = await wh`select count(*)::int n from rayz_analytics_events`;
      const [local] = await rows<{ n: number; max: number }>(sql`select count(*)::int n, max(id)::int max from analytics_events`);
      expect(n).toBe(local.n);
      expect(first).toMatchObject({ rows: local.n, toId: local.max });
      expect((await analytics.exportToWarehouse({ url })) as { rows: number }).toMatchObject({ rows: 0 });

      const keep = await newCustomer("WhKeep");
      const drop = await newCustomer("WhDrop");
      await analytics.exportToWarehouse({ url });
      await m.customers.mergeCustomers(keep, drop, actorOf(ids.owner));
      const gone = await newCustomer("WhGone");
      await analytics.exportToWarehouse({ url });
      await m.db.db.delete(m.schema.customers).where(m.drizzle.eq(m.schema.customers.id, gone));
      await analytics.exportToWarehouse({ url });
      expect((await wh`select count(*)::int n from rayz_analytics_events where customer_id = ${drop}`)[0].n).toBe(0);
      expect((await wh`select count(*)::int n from rayz_analytics_events where customer_id = ${keep}`)[0].n).toBeGreaterThanOrEqual(2);
      expect((await wh`select count(*)::int n from rayz_analytics_events where customer_id = ${gone}`)[0].n).toBe(0);
      expect(await rows(sql`select 1 from analytics_customer_moves`)).toHaveLength(0);
    } finally {
      await wh.end();
    }
    const bad = await analytics.exportToWarehouse({ url: "postgres://rayz:s3cretpw@127.0.0.1:1/nowhere" });
    expect(bad).toMatchObject({ failed: true });
    const [run] = await analytics.warehouseRuns(1);
    expect(run.status).toBe("failed");
    expect(JSON.stringify(await rows(sql`select * from analytics_exports`))).not.toContain("s3cretpw");
    expect(JSON.stringify(await rows(sql`select analytics from brand_settings`))).not.toContain("rayz_warehouse_test");
    await analytics.saveAnalyticsSettings({ satisfaction: false, warehouse: false }, actorOf(ids.owner));
  });
});

describe("post-visit rating", () => {
  it("asks on the receipt when it's on, keeps the first answer and logs it", async () => {
    const analytics = await import("@/server/analytics");
    const { hashToken } = await import("@/domain/rebook-token");
    const [sale] = await rows<{ id: string; shop: string; customer: string; staff: string }>(sql`select id, shop_id shop, customer_id customer, staff_id staff from sales where status = 'paid' and customer_id is not null order by paid_at desc limit 1`);
    const token = "T".repeat(43);
    await m.db.db.insert(m.schema.receiptDeliveries).values({ saleId: sale.id, shopId: sale.shop, customerId: sale.customer, channel: "sms", destination: "+13195550000", masked: "•••0000", purpose: "counter", tokenHash: hashToken(token) });
    expect(await analytics.receiptSatisfaction(sale.id)).toBeNull();
    await expect(analytics.rateVisit(token, 4)).rejects.toThrow(/can't be rated/);
    await analytics.saveAnalyticsSettings({ satisfaction: true, warehouse: false }, actorOf(ids.owner));
    expect(await analytics.receiptSatisfaction(sale.id)).toEqual({ stars: null });
    await expect(analytics.rateVisit(token, 6)).rejects.toThrow();
    expect(await analytics.rateVisit(token, 4)).toEqual({ stars: 4 });
    expect(await analytics.rateVisit(token, 1)).toEqual({ stars: 4 });
    const got = await eventsOf(sql`event = 'visit.satisfaction' and sale_id = ${sale.id}`);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ value: 4, subtype: "receipt", actor_kind: "client", staff_id: sale.staff, customer_id: sale.customer });
    await analytics.saveAnalyticsSettings({ satisfaction: false, warehouse: false }, actorOf(ids.owner));
  });
});

describe("pages", () => {
  it("opens the event log page for the brand, with the download for the Brand Owner only", async () => {
    const { signInAs } = await import("./session");
    const { open } = await import("./render");
    await signInAs(ids.owner);
    const owner = await open("/admin/analytics");
    expect(owner.kind).toBe("ok");
    expect(owner.text).toContain("Download the raw log");
    expect(owner.text).toContain("booking.cancelled");
    await signInAs(ids.admin);
    const admin = await open("/admin/analytics");
    expect(admin.kind).toBe("ok");
    expect(admin.text).not.toContain("Download the raw log");
    await signInAs(ids.makenna);
    expect((await open("/admin/analytics")).kind).toBe("denied");
  });

  it("shows the Operations KPIs", async () => {
    const { signInAs } = await import("./session");
    const { open } = await import("./render");
    await signInAs(ids.owner);
    const r = await open("/admin/reports/operations", {}, { preset: "30d", shop: "all" });
    expect(r.kind).toBe("ok");
    for (const s of ["Utilization", "Rebooked at checkout", "Average ticket", "Revenue per chair hour", "On-time starts", "Retention by first-visit month"]) expect(r.text).toContain(s);
  });
});

describe("the event log in the report builder", () => {
  it("counts events by type the same as the table, for someone with the event log", async () => {
    const admin = await ctxOf("admin");
    const policy = await privacy.clientPolicy(admin);
    const def = eventsDef({ shops: "all", columns: [{ field: "event_code" }, { field: "events", agg: "sum" }, { field: "minutes", agg: "avg" }], groupBy: ["event_code"], summary: true, eventTypes: ["booking"] });
    const r = await engine.runReport(admin, policy, def, { pageSize: 200 });
    const counts = await rows<{ event: string; n: number }>(sql`select event, count(*)::int n from analytics_events where category = 'booking' group by event`);
    expect(r.noun).toBe("event");
    expect(r.customerIds).toEqual([]);
    const got = Object.fromEntries(r.lines.flatMap((l) => (l.kind === "group" ? [[l.values[0], l.cells[1]]] : [])));
    expect(got).toEqual(Object.fromEntries(counts.map((c) => [c.event, c.n])));
    expect(r.totals!.count).toBe(counts.reduce((s, c) => s + c.n, 0));
  });

  it("shows every field, keeps a barber to their own events and refuses people without the event log", async () => {
    const admin = await ctxOf("admin");
    const all = rb.EVENT_FIELDS.map((f) => ({ field: f.key }));
    const r = await engine.runReport(admin, await privacy.clientPolicy(admin), eventsDef({ shops: "all", columns: all, sort: [{ field: "occurred", dir: "desc" }] }), { pageSize: 20 });
    expect(r.columns.map((c) => c.key)).toEqual(rb.EVENT_FIELDS.map((f) => f.key));
    expect(r.lines.length).toBe(20);
    const first = r.lines[0];
    expect(first.kind === "row" && typeof first.cells[0]).toBe("string");

    const makenna = withPerms(await ctxOf("makenna"), ["analytics.events", "report_builder.build"]);
    const mine = await engine.runReport(makenna, await privacy.clientPolicy(makenna), eventsDef({ columns: [{ field: "barber" }], groupBy: ["barber"], summary: true }), { pageSize: 50 });
    expect(mine.lines.map((l) => (l.kind === "group" ? l.values[0] : null))).toEqual([makenna.staff.displayLabel]);

    const michelle = without(await ctxOf("michelle"), ["analytics.events"]);
    expect(await engine.reportProblem(michelle, await privacy.clientPolicy(michelle), eventsDef({}), { building: true })).toMatch(/event log/);
    expect(rb.definitionProblem(eventsDef({ filter: { ...eventsDef({}).filter, minVisits: 2 } }), { levels: {}, money: true, badges: [] }, [])).toMatch(/Client filters/);
    expect(rb.definitionProblem(eventsDef({ eventTypes: ["nope.nothing"] }), { levels: {}, money: true, badges: [] }, [])).toMatch(/isn't logged/);
  });
});

describe("the event log in Rayz Assistant", () => {
  it("offers event_report to people with the event log and answers with counts and what the measures mean", async () => {
    const settings = await assistant.loadAssistantSettings();
    expect((await tools.toolsFor(await ctxOf("makenna"), settings)).map((t) => t.name)).not.toContain("event_report");
    const admin = await ctxOf("admin");
    const tool = (await tools.toolsFor(admin, settings)).find((t) => t.name === "event_report")!;
    expect(tool).toBeTruthy();
    const out = await tool.run({ ctx: admin, settings, conversationId: "x", now: new Date() }, { eventTypes: ["appointment.started"], groupBy: ["location"], measures: ["minutes_avg"], preset: "all", locations: ["all"] });
    const [n] = await rows<{ n: number }>(sql`select count(*)::int n from analytics_events where event = 'appointment.started'`);
    expect(out.refused).toBeFalsy();
    expect(out.content).toContain(`${n.n.toLocaleString("en-US")} event`);
    expect(out.content).toMatch(/minutes = wait/);
    expect(out.cards[0]).toMatchObject({ kind: "report", title: "Event log" });
  });
});
