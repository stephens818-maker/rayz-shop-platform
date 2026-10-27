/**
 * Custom reports against the seeded brand: the query builder's numbers against plain SQL, which
 * clients each person reaches, Client data masking and hidden fields, grouping, subtotals and
 * pages, saving and sharing (and a shared report cut down to the viewer's locations), exports and
 * their logging, scheduled emails sent once however often the cron runs, and the Morning Dashboard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_SEGMENT } from "@/domain/marketing";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { get, open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let engine: typeof import("@/server/report-builder/engine");
let saved: typeof import("@/server/report-builder/saved");
let deliver: typeof import("@/server/report-builder/deliver");
let preview: typeof import("@/server/report-builder/preview");
let context: typeof import("@/server/report-builder/context");
let privacy: typeof import("@/server/client-privacy");
let rb: typeof import("@/domain/report-builder");
type Ctx = import("@/server/auth/staff").StaffContext;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const roleId: Record<string, string> = {};
let customField: string;
const NOW = new Date();

const rows = async <T>(q: ReturnType<Mods["drizzle"]["sql"]>) => (await m.db.db.execute(q)) as unknown as T[];
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const ctxOf = async (who: string) => (await context.staffContextFor(ids[who]))!;
const without = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions].filter((p) => !perms.includes(p))) as Ctx["permissions"] });
const withPerms = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions, ...perms]) as Ctx["permissions"] });
const def = (x: Record<string, unknown>) => rb.ReportDefinition.parse({ columns: [{ field: "name" }], ...x });
const policyOf = (c: Ctx, levels: Record<string, "full" | "masked" | "hidden">) =>
  privacy.makePolicy({ staffId: c.staff.id, isOwner: false, fullContact: true, canReveal: false, custom: [{ id: customField, label: "Beard style" }], levels: new Map(Object.entries(levels) as [never, never][]) });
const FULL = (): Record<string, "full" | "masked" | "hidden"> => ({ phone: "full", email: "full", address: "full", birthday: "full", preferred_barber: "full", ratings: "full", notes: "full", [`custom:${customField}`]: "full" });

beforeAll(async () => {
  m = await loadModules();
  engine = await import("@/server/report-builder/engine");
  saved = await import("@/server/report-builder/saved");
  deliver = await import("@/server/report-builder/deliver");
  preview = await import("@/server/report-builder/preview");
  context = await import("@/server/report-builder/context");
  privacy = await import("@/server/client-privacy");
  rb = await import("@/domain/report-builder");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const r of await m.db.db.select().from(m.schema.roles)) if (r.key) roleId[r.key] = r.id;
  [{ id: customField }] = await m.db.db.insert(m.schema.clientFields).values({ label: "Beard style" }).returning({ id: m.schema.clientFields.id });
  const [c] = await rows<{ id: string }>(sql`select id from customers order by number limit 1`);
  await m.db.db.execute(sql`update customers set custom_fields = jsonb_build_object(${customField}::text, 'Full beard') where id = ${c.id}`);
});

afterAll(async () => {
  await m.db.db.delete(m.schema.savedReports);
  await m.db.db.delete(m.schema.clientFields).where(m.drizzle.eq(m.schema.clientFields.id, customField));
});

describe("the query builder", () => {
  it("lists every client for the owner, with visits and spend that match the tickets and appointments", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const r = await engine.runReport(owner, policy, def({ shops: "all", columns: [{ field: "name" }, { field: "visits", agg: "sum" }, { field: "total_spend", agg: "sum" }, { field: "tips", agg: "sum" }], sort: [{ field: "visits", dir: "desc" }] }), { pageSize: 200 });
    const [all] = await rows<{ n: number }>(sql`select count(*)::int n from customers`);
    expect(r.total).toBe(all.n);
    const [visits] = await rows<{ n: number }>(sql`select count(*)::int n from appointments where status = 'completed' and customer_id is not null`);
    expect(r.totals!.cells[1]).toBe(visits.n);
    const [spend] = await rows<{ gross: number; refunded: number; tips: number; rtips: number }>(sql`
      select (select coalesce(sum(service_net_cents + product_net_cents), 0)::float8 from sales where status in ('paid', 'partially_refunded', 'refunded') and customer_id is not null) gross,
        (select coalesce(sum(r.service_net_cents + r.product_net_cents), 0)::float8 from refunds r join sales s on s.id = r.sale_id where r.kind = 'refund' and s.status <> 'voided' and s.customer_id is not null) refunded,
        (select coalesce(sum(tip_cents), 0)::float8 from sales where status in ('paid', 'partially_refunded', 'refunded') and customer_id is not null) tips,
        (select coalesce(sum(r.tip_cents), 0)::float8 from refunds r join sales s on s.id = r.sale_id where r.kind = 'refund' and s.status <> 'voided' and s.customer_id is not null) rtips`);
    expect(r.totals!.cells[2]).toBe(spend.gross - spend.refunded);
    expect(r.totals!.cells[3]).toBe(spend.tips - spend.rtips);
    const counts = r.lines.flatMap((l) => (l.kind === "row" ? [l.cells[1] as number] : []));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts[0]).toBeGreaterThan(0);
  });

  it("counts activity only in the report's dates, locations and barbers", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const today = m.time.todayLocal(NOW);
    const r = await engine.runReport(owner, policy, def({ shops: shop.coralville, range: { preset: "7d" }, rows: "visited", columns: [{ field: "name" }, { field: "visits", agg: "sum" }] }), { pageSize: 200, now: NOW });
    const from = m.time.startOfLocalDay(m.time.addDays(today, -6)).toISOString();
    const to = m.time.endOfLocalDay(today).toISOString();
    const [x] = await rows<{ clients: number; visits: number }>(
      sql`select count(distinct customer_id)::int clients, count(*)::int visits from appointments where status = 'completed' and customer_id is not null and shop_id = ${shop.coralville} and starts_at >= ${from} and starts_at < ${to}`,
    );
    expect(r.total).toBe(x.clients);
    expect(r.totals!.cells[1]).toBe(x.visits);
    expect(r.rangeLabel).toMatch(/^Last 7 days/);
    expect(r.scopeLabel).toBe("Coralville");
  });

  it("reaches only the clients of a manager's locations, and only their own clients without \"Look up any client\"", async () => {
    const michelle = await ctxOf("michelle");
    const r = await engine.runReport(michelle, await privacy.clientPolicy(michelle), def({}), { pageSize: 1 });
    const [reach] = await rows<{ n: number }>(
      sql`select count(*)::int n from customers c where c.home_shop_id = ${shop.coralville} or exists (select 1 from appointments a where a.customer_id = c.id and a.shop_id = ${shop.coralville})`,
    );
    expect(r.total).toBe(reach.n);
    const own = without(michelle, ["clients.view_all", "reports.all_staff"]);
    const o = await engine.runReport(own, await privacy.clientPolicy(own), def({}), { pageSize: 1 });
    const [mine] = await rows<{ n: number }>(sql`select count(distinct customer_id)::int n from appointments a where a.staff_id = ${ids.michelle} and a.shop_id = ${shop.coralville} and a.status = 'completed'`);
    expect(o.total).toBe(mine.n);
    expect(o.scope.staffIds).toEqual([ids.michelle]);
    expect(o.scope.notes.join(" ")).toMatch(/only clients you've served/);
    await expect(engine.runReport(michelle, await privacy.clientPolicy(michelle), def({ shops: shop.moline }))).rejects.toThrow(/outside your access/);
  });

  it("masks what Client data masks, refuses what it hides, and never totals a masked value", async () => {
    const owner = await ctxOf("owner");
    const cols = { columns: [{ field: "name" }, { field: "phone" }, { field: "email" }, { field: "city" }, { field: `custom:${customField}` }], filter: EMPTY_SEGMENT, shops: "all" };
    const full = await engine.runReport(owner, policyOf(owner, FULL()), def({ ...cols, columns: [...cols.columns.slice(0, 4), { field: `custom:${customField}` }] }), { all: true });
    const masked = await engine.runReport(owner, policyOf(owner, { ...FULL(), phone: "masked", email: "masked", address: "masked", [`custom:${customField}`]: "masked" }), def(cols), { all: true });
    expect(masked.columns.map((c) => c.masked)).toEqual([false, true, true, false, true]);
    const withPhone = full.lines.findIndex((l) => l.kind === "row" && l.cells[1]);
    const a = full.lines[withPhone] as Extract<(typeof full.lines)[number], { kind: "row" }>;
    const b = masked.lines.find((l) => l.kind === "row" && l.id === a.id) as typeof a;
    expect(b.cells[1]).not.toBe(a.cells[1]);
    expect(String(b.cells[1])).toMatch(/\*/);
    expect(String(b.cells[1]).slice(-4)).toBe(String(a.cells[1]).replace(/\D/g, "").slice(-4));
    expect(b.cells[3]).toBe(a.cells[3]);
    const beard = masked.lines.find((l) => l.kind === "row" && l.cells[4]) as typeof a;
    expect(beard.cells[4]).not.toBe("Full beard");
    expect((full.lines.find((l) => l.kind === "row" && l.id === beard.id) as typeof a).cells[4]).toBe("Full beard");
    const hidden = policyOf(owner, { ...FULL(), phone: "hidden" });
    await expect(engine.runReport(owner, hidden, def({ columns: [{ field: "phone" }] }))).rejects.toThrow(/phone is hidden/);
    const maskedPolicy = policyOf(owner, { ...FULL(), email: "masked", birthday: "masked" });
    await expect(engine.runReport(owner, maskedPolicy, def({ sort: [{ field: "email" }] }))).rejects.toThrow(/don't see it in full/);
    await expect(engine.runReport(owner, maskedPolicy, def({ columns: [{ field: "birthday", agg: "max" }] }))).rejects.toThrow(/only be counted/);
    const counted = await engine.runReport(owner, maskedPolicy, def({ shops: "all", columns: [{ field: "birthday", agg: "count" }] }), { pageSize: 1 });
    const [bd] = await rows<{ n: number }>(sql`select count(birthday)::int n from customers`);
    expect(counted.totals!.cells[0]).toBe(bd.n);
  });

  it("keeps spend for people who see every client", async () => {
    const michelle = without(await ctxOf("michelle"), ["clients.view_all"]);
    await expect(engine.runReport(michelle, await privacy.clientPolicy(michelle), def({ columns: [{ field: "total_spend" }] }))).rejects.toThrow(/every client/);
  });

  it("refuses spend, tips and gift cards to people whose reports hide dollar amounts", async () => {
    const admin = without(await ctxOf("admin"), ["reports.money"]);
    const policy = await privacy.clientPolicy(admin);
    await expect(engine.runReport(admin, policy, def({ columns: [{ field: "name" }, { field: "total_spend" }] }))).rejects.toThrow(/dollar amounts need "See dollar amounts in reports"/i);
    const r = await engine.runReport(admin, policy, def({ columns: [{ field: "name" }, { field: "visits" }] }));
    expect(r.total).toBeGreaterThan(0);
  });

  it("applies the segment builder's filters", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const filter = { ...EMPTY_SEGMENT, minVisits: 2 };
    const r = await engine.runReport(owner, policy, def({ shops: "all", filter, columns: [{ field: "name" }, { field: "visits" }] }), { pageSize: 200 });
    const cf = await import("@/server/client-filters");
    const where = (await cf.filteredClientIds(filter, NOW))!;
    const [n] = await rows<{ n: number }>(sql`select count(*)::int n from customers where id in ${where}`);
    expect(r.total).toBe(n.n);
    expect(r.lines.every((l) => l.kind !== "row" || (l.cells[1] as number) >= 2)).toBe(true);
  });

  it("groups with subtotals that add up, as a summary, and across pages", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const d = def({ shops: "all", groupBy: ["home_location"], columns: [{ field: "name" }, { field: "visits", agg: "sum" }, { field: "last_visit", agg: "max" }] });
    const all = await engine.runReport(owner, policy, d, { all: true });
    const groups = all.lines.filter((l) => l.kind === "group");
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.reduce((a, g) => a + (g.kind === "group" ? g.count : 0), 0)).toBe(all.total);
    expect(groups.reduce((a, g) => a + Number(g.cells[1]), 0)).toBe(all.totals!.cells[1]);
    const summary = await engine.runReport(owner, policy, { ...d, summary: true }, { all: true });
    expect(summary.total).toBe(groups.length);
    expect(summary.lines.map((l) => l.kind === "group" && [l.values[0], l.count, l.cells[1]])).toEqual(groups.map((l) => l.kind === "group" && [l.values[0], l.count, l.cells[1]]));
    // A page that starts inside a group repeats its header, marked as continued.
    const first = groups[0];
    if (first.kind === "group" && first.count > 2) {
      const p2 = await engine.runReport(owner, policy, d, { pageSize: 2, page: 2 });
      expect(p2.lines[0]).toMatchObject({ kind: "group", values: first.values, count: first.count, continued: true });
    }
  });

  it("builds SQL only from whitelisted fields, with custom field ids as parameters", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    for (const field of ["c.password_hash", "name; drop table customers", "custom:x' or '1'='1"]) await expect(engine.runReport(owner, policy, def({ columns: [{ field }] }))).rejects.toThrow(/isn't a field/);
    const every = rb.allFields(policy.custom).map((f) => ({ field: f.key }));
    const r = await engine.runReport(owner, policy, def({ shops: "all", columns: every.slice(0, 40), range: { preset: "30d" } }), { pageSize: 5 });
    expect(r.columns).toHaveLength(Math.min(40, every.length));
    if (every.length > 40) await engine.runReport(owner, policy, def({ shops: "all", columns: every.slice(40) }), { pageSize: 5 });
  });
});

describe("sales and appointments", () => {
  const sales = (x: Record<string, unknown>) => rb.ReportDefinition.parse({ source: "sales", shops: "all", range: { preset: "all" }, columns: [{ field: "ticket" }], ...x });
  const appts = (x: Record<string, unknown>) => rb.ReportDefinition.parse({ source: "appointments", shops: "all", range: { preset: "all" }, columns: [{ field: "status" }], ...x });

  it("totals paid tickets like the tickets themselves, net of refunds", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const cols = ["tickets", "services", "products", "net_sales", "tips", "card_fee", "refunded"].map((field) => ({ field, agg: "sum" }));
    const r = await engine.runReport(owner, policy, sales({ columns: [{ field: "ticket" }, ...cols] }), { pageSize: 5 });
    const [t] = await rows<Record<string, number>>(sql`
      select count(*)::int n, coalesce(sum(service_net_cents), 0)::float8 services, coalesce(sum(product_net_cents), 0)::float8 products,
        coalesce(sum(tip_cents), 0)::float8 tips, coalesce(sum(card_fee_cents), 0)::float8 card_fee,
        (select coalesce(sum(r.service_net_cents + r.product_net_cents), 0)::float8 from refunds r join sales s on s.id = r.sale_id where r.kind = 'refund' and s.status in ('paid', 'partially_refunded', 'refunded')) rnet,
        (select coalesce(sum(r.amount_cents), 0)::float8 from refunds r join sales s on s.id = r.sale_id where r.kind = 'refund' and s.status in ('paid', 'partially_refunded', 'refunded')) refunded
      from sales where status in ('paid', 'partially_refunded', 'refunded')`);
    expect(t.n).toBeGreaterThan(0);
    expect(r.noun).toBe("ticket");
    expect(r.total).toBe(t.n);
    expect(r.totals!.cells.slice(1)).toEqual([t.n, t.services, t.products, t.services + t.products - t.rnet, t.tips, t.card_fee, t.refunded]);
    const byShop = await engine.runReport(owner, policy, sales({ groupBy: ["location"], summary: true, columns: [{ field: "location" }, { field: "net_sales", agg: "sum" }] }), { all: true });
    expect(byShop.lines.reduce((a, l) => a + (l.kind === "group" ? l.count : 0), 0)).toBe(t.n);
    expect(byShop.lines.reduce((a, l) => a + (l.kind === "group" ? Number(l.cells[1]) : 0), 0)).toBeCloseTo(t.services + t.products - t.rnet);
  });

  it("keeps a barber to their own tickets and appointments, and hides dollars and tips without the permissions", async () => {
    const own = without(await ctxOf("michelle"), ["reports.all_staff"]);
    const policy = await privacy.clientPolicy(own);
    const r = await engine.runReport(own, policy, sales({ shops: null, columns: [{ field: "barber" }, { field: "tickets", agg: "sum" }] }), { all: true });
    const [mine] = await rows<{ n: number }>(sql`select count(*)::int n from sales where staff_id = ${ids.michelle} and shop_id = ${shop.coralville} and status in ('paid', 'partially_refunded', 'refunded')`);
    expect(mine.n).toBeGreaterThan(0);
    expect(r.total).toBe(mine.n);
    expect(r.scope.staffIds).toEqual([ids.michelle]);
    const a = await engine.runReport(own, policy, appts({ shops: null }), { pageSize: 1 });
    const [ma] = await rows<{ n: number }>(sql`select count(*)::int n from appointments where staff_id = ${ids.michelle} and shop_id = ${shop.coralville}`);
    expect(a.total).toBe(ma.n);
    const noMoney = without(await ctxOf("admin"), ["reports.money"]);
    const p2 = await privacy.clientPolicy(noMoney);
    await expect(engine.runReport(noMoney, p2, rb.DEFAULT_SALES_REPORT)).rejects.toThrow(/See dollar amounts in reports/);
    await expect(engine.runReport(noMoney, p2, appts({ columns: [{ field: "estimate", agg: "sum" }] }))).rejects.toThrow(/See dollar amounts in reports/);
    expect((await engine.runReport(noMoney, p2, sales({ columns: [{ field: "tickets", agg: "sum" }] }), { pageSize: 1 })).total).toBeGreaterThan(0);
    const noPay = without(await ctxOf("admin"), ["report.tips_payroll.view"]);
    const p3 = await privacy.clientPolicy(noPay);
    await expect(engine.runReport(noPay, p3, sales({ columns: [{ field: "tips", agg: "sum" }] }))).rejects.toThrow(/Tips and payroll export/);
    const tips = await engine.runReport(noPay, p3, rb.ReportDefinition.parse({ source: "events", shops: "all", range: { preset: "all" }, eventTypes: ["tip"], columns: [{ field: "event" }, { field: "amount" }] }), { all: true });
    expect(tips.total).toBeGreaterThan(0);
    expect(tips.lines.every((l) => l.kind !== "row" || l.cells[1] === null)).toBe(true);
  });

  it("counts appointments by status like the calendar", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const r = await engine.runReport(owner, policy, appts({ columns: [{ field: "status" }, ...["appointments", "completed", "no_shows", "cancellations"].map((field) => ({ field, agg: "sum" }))] }), { pageSize: 5 });
    const [c] = await rows<Record<string, number>>(sql`select count(*)::int n, (count(*) filter (where status = 'completed'))::int done, (count(*) filter (where status = 'no_show'))::int ns, (count(*) filter (where status = 'cancelled'))::int cx from appointments`);
    expect(r.noun).toBe("appointment");
    expect(r.total).toBe(c.n);
    expect(r.totals!.cells.slice(1)).toEqual([c.n, c.done, c.ns, c.cx]);
    await expect(engine.runReport(owner, policy, appts({ filter: { ...EMPTY_SEGMENT, minVisits: 2 } }))).rejects.toThrow(/Client filters are for customer reports/);
  });
});

describe("staff, inventory, tips and campaigns", () => {
  const flat = (source: string, x: Record<string, unknown>) => rb.ReportDefinition.parse({ source, shops: "all", range: { preset: "all" }, ...x });

  it("runs every field of every source, over all time and a week", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    for (const source of ["sales", "appointments", "staff", "inventory", "tips", "campaigns", "events"])
      for (const preset of ["all", "7d"]) {
        const every = rb.allFields([], source).map((f) => ({ field: f.key }));
        const r = await engine.runReport(owner, policy, flat(source, { columns: every, range: { preset } }), { pageSize: 3 });
        expect(r.columns).toHaveLength(every.length);
        expect(r.noun).toBe(rb.nounOf(source as never));
      }
  });

  it("counts staff appointments and clocked hours as the calendar and the Labor report do", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const r = await engine.runReport(owner, policy, flat("staff", { columns: [{ field: "barber" }, ...["completed", "no_shows", "clocked_hours", "service_sales", "product_sales"].map((field) => ({ field, agg: "sum" }))], range: { preset: "30d" } }), { pageSize: 5 });
    const { from, to } = r.scope.range!;
    const [c] = await rows<{ done: number; ns: number }>(sql`
      select (count(*) filter (where a.status = 'completed'))::int done, (count(*) filter (where a.status = 'no_show'))::int ns
      from appointments a join staff_shops ss on ss.staff_id = a.staff_id and ss.shop_id = a.shop_id join staff st on st.id = a.staff_id and st.kind = 'person'
      where a.starts_at >= ${m.time.startOfLocalDay(from).toISOString()} and a.starts_at < ${m.time.endOfLocalDay(to).toISOString()}`);
    expect(c.done).toBeGreaterThan(0);
    expect(r.totals!.cells.slice(1, 3)).toEqual([c.done, c.ns]);
    const { laborRows } = await import("@/server/time-clock-export");
    const all = (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id);
    const pairs = new Set((await rows<{ k: string }>(sql`select ss.staff_id::text || ss.shop_id::text k from staff_shops ss join staff st on st.id = ss.staff_id and st.kind = 'person'`)).map((x) => x.k));
    const labor = (await laborRows(all, from, to, null)).filter((l) => pairs.has(l.staffId + l.shopId));
    expect(r.totals!.cells[3]).toBeCloseTo(labor.reduce((a, l) => a + l.workedMin, 0) / 60, 5);
    expect(r.totals!.cells[4]).toBe(labor.reduce((a, l) => a + l.serviceCents, 0));
    expect(r.totals!.cells[5]).toBe(labor.reduce((a, l) => a + l.productCents, 0));
    const noLabor = without(owner, ["report.labor.view"]);
    await expect(engine.runReport(noLabor, await privacy.clientPolicy(noLabor), flat("staff", { columns: [{ field: "clocked_hours" }] }))).rejects.toThrow(/can't add "Clocked hours": it needs "Labor hours and cost"/);
    const noBarbers = without(owner, ["report.sales_by_barber.view"]);
    await expect(engine.runReport(noBarbers, await privacy.clientPolicy(noBarbers), rb.DEFAULT_STAFF_REPORT)).rejects.toThrow(/The Staff source needs "Barber performance"/);
    const own = without(await ctxOf("michelle"), ["reports.all_staff"]);
    const mine = await engine.runReport(own, await privacy.clientPolicy(own), flat("staff", { shops: null, columns: [{ field: "barber" }] }), { all: true });
    expect(mine.lines.every((l) => l.kind !== "row" || String(l.id).startsWith(ids.michelle))).toBe(true);
  });

  it("matches the inventory ledger: stock now, and what was sold and received", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const r = await engine.runReport(owner, policy, flat("inventory", { columns: [{ field: "product" }, ...["on_hand", "sold", "received", "returned"].map((field) => ({ field, agg: "sum" }))] }), { pageSize: 5 });
    const [l] = await rows<Record<string, number>>(sql`select
      (select coalesce(sum(stock), 0)::int from shop_products) on_hand,
      coalesce(sum(-delta) filter (where kind = 'sale'), 0)::int sold,
      coalesce(sum(delta) filter (where kind = 'receive'), 0)::int received,
      coalesce(sum(delta) filter (where kind in ('refund', 'void')), 0)::int returned from inventory_ledger`);
    expect(l.sold).toBeGreaterThan(0);
    expect(r.totals!.cells.slice(1)).toEqual([l.on_hand, l.sold, l.received, l.returned]);
    const noInv = without(owner, ["report.inventory.view"]);
    await expect(engine.runReport(noInv, await privacy.clientPolicy(noInv), rb.DEFAULT_INVENTORY_REPORT)).rejects.toThrow(/The Inventory source needs "Inventory valuation"/);
  });

  it("lists every tip entry, signed, and needs Tip payouts", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const r = await engine.runReport(owner, policy, flat("tips", { columns: [{ field: "entry" }, { field: "entries", agg: "sum" }, { field: "amount", agg: "sum" }] }), { pageSize: 5 });
    const [t] = await rows<{ n: number; cents: number }>(sql`select count(*)::int n, coalesce(sum(amount_cents), 0)::float8 cents from tip_ledger`);
    expect(t.n).toBeGreaterThan(0);
    expect(r.totals!.cells.slice(1)).toEqual([t.n, t.cents]);
    const noTips = without(owner, ["report.tip_payouts.view"]);
    await expect(engine.runReport(noTips, await privacy.clientPolicy(noTips), rb.DEFAULT_TIP_REPORT)).rejects.toThrow(/The Tips source needs "Tip payouts"/);
    const noMoney = without(owner, ["reports.money"]);
    await expect(engine.runReport(noMoney, await privacy.clientPolicy(noMoney), rb.DEFAULT_TIP_REPORT)).rejects.toThrow(/See dollar amounts in reports/);
  });

  it("credits campaign messages as the Campaign Center report does", async () => {
    const owner = await ctxOf("owner");
    const policy = await privacy.clientPolicy(owner);
    const [camp] = await m.db.db.insert(m.schema.marketingCampaigns).values({ kind: "blast", name: "Report builder blast" }).returning();
    const [cu] = await rows<{ id: string }>(sql`select id from customers order by number limit 2`);
    await m.db.db.insert(m.schema.marketingSends).values([
      { campaignId: camp.id, customerId: cu.id, shopId: shop.coralville, channel: "sms", status: "queued", dedupeKey: `rb:${camp.id}:1`, token: `rb-${camp.id}-1`, clicks: 2, firstClickAt: new Date(), costCents: 1 },
      { campaignId: camp.id, customerId: cu.id, shopId: shop.coralville, channel: "email", status: "queued", dedupeKey: `rb:${camp.id}:2`, token: `rb-${camp.id}-2`, costCents: 0.1 },
      { campaignId: camp.id, customerId: cu.id, shopId: shop.coralville, channel: "sms", status: "holdout", dedupeKey: `rb:${camp.id}:3`, token: `rb-${camp.id}-3` },
    ]);
    const r = await engine.runReport(owner, policy, flat("campaigns", { columns: [{ field: "campaign" }, ...["messages", "clicked", "bookings", "revenue"].map((field) => ({ field, agg: "sum" }))] }), { pageSize: 5 });
    const report = await import("@/server/marketing/report");
    const settings = await (await import("@/server/marketing/settings")).loadMarketingSettings();
    const sends = (await report.sendOutcomes(sql`ms.status = 'queued'`, { days: settings.attributionDays, basis: settings.attributeOn })).filter((s) => !s.held);
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(r.total).toBe(sends.length);
    expect(r.lines.find((l) => l.kind === "row" && l.cells[0] === "Report builder blast")).toBeTruthy();
    expect(r.totals!.cells.slice(1)).toEqual([sends.length, sends.filter((s) => s.clicked).length, sends.reduce((a, s) => a + s.bookings, 0), sends.reduce((a, s) => a + s.revenue, 0)]);
    const noCc = without(owner, ["report.campaign_center.view"]);
    await expect(engine.runReport(noCc, await privacy.clientPolicy(noCc), rb.DEFAULT_CAMPAIGN_REPORT)).rejects.toThrow(/The Campaigns source needs "Campaign Center"/);
    await m.db.db.delete(m.schema.marketingCampaigns).where(m.drizzle.eq(m.schema.marketingCampaigns.id, camp.id));
  });
});

describe("saving and sharing", () => {
  it("keeps a private report to its owner, shares with roles, and keeps templates for people with every shop", async () => {
    const michelle = await ctxOf("michelle");
    const moline = await ctxOf("manager.moline");
    const id = await saved.saveReport(michelle, { name: "Coralville regulars", definition: def({ columns: [{ field: "name" }, { field: "visits", agg: "sum" }] }) });
    expect((await saved.listSavedReports(michelle)).map((r) => r.id)).toContain(id);
    expect((await saved.listSavedReports(moline)).map((r) => r.id)).not.toContain(id);
    await expect(saved.openSavedReport(moline, id)).rejects.toThrow(/not found/i);
    await expect(saved.saveReport(michelle, { name: "Everyone's", visibility: "template", definition: def({}) })).rejects.toThrow(/access to all shops/);
    await expect(saved.saveReport(michelle, { name: "Shared", visibility: "roles", definition: def({}) })).rejects.toThrow(/at least one role/);
    await saved.saveReport(michelle, { id, name: "Coralville regulars", visibility: "roles", roleIds: [roleId.shop_manager], definition: def({ columns: [{ field: "name" }, { field: "visits", agg: "sum" }] }) });
    const shared = await saved.openSavedReport(moline, id);
    expect(shared).toMatchObject({ mine: false, mayEdit: false });
    await expect(saved.saveReport(moline, { id, name: "Mine now", definition: def({}) })).rejects.toThrow(/Duplicate it/);
    await expect(saved.deleteReport(moline, id)).rejects.toThrow(/Only its owner/);
    const copy = await saved.duplicateReport(moline, id);
    const c = await saved.openSavedReport(moline, copy);
    expect(c).toMatchObject({ mine: true, mayEdit: true, row: { name: "Copy of Coralville regulars", visibility: "private", schedule: null } });
    const admin = await ctxOf("admin");
    const t = await saved.saveReport(admin, { name: "Brand template", visibility: "template", definition: def({}) });
    expect((await saved.listSavedReports(moline)).find((r) => r.id === t)).toMatchObject({ visibility: "template", mayEdit: false });
    expect((await saved.listSavedReports(await ctxOf("owner"))).find((r) => r.id === t)?.mayEdit).toBe(true);
    expect((await saved.listSavedReports(await ctxOf("regional"))).find((r) => r.id === t)?.mayEdit).toBe(false);
    await saved.deleteReport(moline, copy);
    await expect(saved.openSavedReport(moline, copy)).rejects.toThrow(/not found/i);
    const [audit] = await rows<{ n: number }>(sql`select count(*)::int n from audit_log where entity = 'saved_report' and action in ('report_builder.create', 'report_builder.update', 'report_builder.duplicate', 'report_builder.delete')`);
    expect(audit.n).toBeGreaterThanOrEqual(5);
  });

  it("cuts someone else's report down to the viewer's locations and barbers", async () => {
    const regional = await ctxOf("regional");
    const moline = await ctxOf("manager.moline");
    const both = await saved.saveReport(regional, { name: "Quad Cities", visibility: "roles", roleIds: [roleId.shop_manager], definition: def({ shops: `${shop.moline},${shop["rock-island"]}` }) });
    const p = await preview.previewReport(moline, { id: both });
    expect(p.notes.join(" ")).toMatch(/only the report's locations you have access to/);
    expect(p.result.scopeLabel).toBe("Moline");
    const ri = await saved.saveReport(regional, { name: "Rock Island", visibility: "roles", roleIds: [roleId.shop_manager], definition: def({ shops: shop["rock-island"] }) });
    await expect(preview.previewReport(moline, { id: ri })).rejects.toThrow(/outside your access/);
    // Their own definitions must stay inside their access.
    await expect(preview.previewReport(moline, { definition: def({ shops: shop["rock-island"] }) })).rejects.toThrow(/outside your access/);
  });

  it("lets viewers look at other dates but not change a report, and needs the filter permission for new filters", async () => {
    const michelle = await ctxOf("michelle");
    const id = await saved.saveReport(michelle, { name: "With a filter", definition: def({ filter: { ...EMPTY_SEGMENT, minVisits: 1 } }) });
    const viewer = without(michelle, ["report_builder.build"]);
    expect((await preview.previewReport(viewer, { id, range: { preset: "30d" } })).result.rangeLabel).toMatch(/^Last 30 days/);
    await expect(preview.previewReport(viewer, { id, definition: def({}) })).rejects.toThrow(/Changing a report/);
    const noFilters = without(michelle, ["clients.filters"]);
    expect((await preview.previewReport(noFilters, { id, definition: def({ filter: { ...EMPTY_SEGMENT, minVisits: 1 }, columns: [{ field: "visits" }] }) })).result.total).toBeGreaterThan(0);
    await expect(preview.previewReport(noFilters, { id, definition: def({ filter: { ...EMPTY_SEGMENT, minVisits: 2 } }) })).rejects.toThrow(/advanced client filters/);
    const none = without(michelle, ["report_builder.build", "report_builder.view"]);
    await expect(preview.previewReport(none, { id })).rejects.toThrow(/Custom reports need/);
  });

  it("logs a page with contact details like browsing the client list, and offers it as a blast", async () => {
    const michelle = await ctxOf("michelle");
    const before = await rows<{ n: number }>(sql`select count(*)::int n from client_access_log where staff_id = ${ids.michelle} and kind = 'list'`);
    const plain = await preview.previewReport(michelle, { definition: def({ columns: [{ field: "name" }, { field: "visits" }] }) });
    const mid = await rows<{ n: number }>(sql`select count(*)::int n from client_access_log where staff_id = ${ids.michelle} and kind = 'list'`);
    expect(mid[0].n).toBe(before[0].n);
    await preview.previewReport(michelle, { definition: def({ columns: [{ field: "name" }, { field: "phone" }] }) });
    const after = await rows<{ n: number }>(sql`select count(*)::int n from client_access_log where staff_id = ${ids.michelle} and kind = 'list'`);
    expect(after[0].n).toBe(before[0].n + 1);
    expect(plain.blast).toBeNull();
    const owner = await ctxOf("owner");
    const b = await preview.previewReport(owner, { definition: def({ shops: shop.moline, rows: "visited", range: { preset: "30d" }, filter: { ...EMPTY_SEGMENT, minVisits: 1 } }) });
    expect(b.blast!.shops).toBe(shop.moline);
    const { decodeFilter } = await import("@/domain/client-filters");
    expect(decodeFilter(b.blast!.f)).toMatchObject({ minVisits: 1, lastVisitFrom: m.time.addDays(m.time.todayLocal(), -29) });
  });
});

describe("exports", () => {
  it("needs the export permission and, for clients, \"Export the client list\"; logs what went out", async () => {
    const owner = await ctxOf("owner");
    const d = { id: null, name: "Owner's list", own: true, definition: def({ shops: "all", columns: [{ field: "name" }, { field: "phone" }, { field: "total_spend", agg: "sum" }] }) };
    const admin = await ctxOf("admin");
    await expect(deliver.exportReport(admin, d, "csv")).rejects.toThrow(/Export the client list/);
    await expect(deliver.exportReport(without(owner, ["report_builder.export"]), d, "csv")).rejects.toThrow(/export to CSV/);
    const { file, result } = await deliver.exportReport(owner, d, "csv", { now: NOW });
    const text = new TextDecoder().decode(file.bytes);
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/Name,Phone,Total spend/);
    expect(lines.at(-1)).toMatch(/^"?Total \(/);
    expect(lines.length).toBe(result.total + 2);
    expect(file.filename).toMatch(/^owners-list-\d{4}-\d{2}-\d{2}\.csv$/);
    const xlsx = await deliver.exportReport(owner, d, "xlsx");
    expect(Buffer.from(xlsx.file.bytes).subarray(0, 2).toString()).toBe("PK");
    const pdf = await deliver.exportReport(owner, { ...d, definition: def({ shops: "all", groupBy: ["home_location"], summary: true, columns: [{ field: "name" }, { field: "visits", agg: "sum" }] }) }, "pdf");
    expect(Buffer.from(pdf.file.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const [log] = await rows<{ detail: { fields: string[]; format: string } }>(sql`select detail from client_access_log where staff_id = ${ids.owner} and kind = 'export' order by at desc limit 1`);
    expect(log.detail.format).toBe("pdf");
    const [a] = await rows<{ details: { customerIds: string[]; format: string } }>(sql`select details from audit_log where action = 'report_builder.export' and details->>'format' = 'csv' order by at desc limit 1`);
    expect(a.details.customerIds).toHaveLength(result.total);
  });

  it("guards spreadsheet formulas in Excel", async () => {
    const owner = await ctxOf("owner");
    const [c] = await rows<{ id: string }>(sql`select id from customers order by number limit 1`);
    await m.db.db.execute(sql`update customers set nickname = '=HYPERLINK("http://x")' where id = ${c.id}`);
    const { file } = await deliver.exportReport(owner, { id: null, name: "Nicknames", own: true, definition: def({ shops: "all", columns: [{ field: "nickname" }], filter: { ...EMPTY_SEGMENT, fieldsSet: ["nickname"] } }) }, "xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(file.bytes) as never);
    const values = wb.worksheets[0].getColumn(1).values.map(String);
    expect(values.some((v) => v.includes("HYPERLINK"))).toBe(true);
    expect(values.some((v) => v.startsWith("="))).toBe(false);
  });
});

describe("scheduled emails and the Morning Dashboard", () => {
  it("checks recipients, sends each once a period, drops the file from the outbox, and refuses to serve it", async () => {
    const owner = await ctxOf("owner");
    const michelle = await ctxOf("michelle");
    const sched = { frequency: "daily", timeMin: 0, format: "csv" };
    await expect(saved.saveReport(michelle, { name: "Daily", schedule: { ...sched, recipients: [ids["manager.moline"]] }, definition: def({}) })).rejects.toThrow(/doesn't work at your shops/);
    await expect(saved.saveReport(owner, { name: "Daily", schedule: { ...sched, recipients: [ids.michelle] }, definition: def({}) })).rejects.toThrow(/can't open this report/);
    const id = await saved.saveReport(owner, {
      name: "Owner daily",
      visibility: "roles",
      roleIds: [roleId.shop_manager],
      schedule: { ...sched, recipients: [ids.owner, ids.michelle] },
      morning: true,
      definition: def({ columns: [{ field: "name" }, { field: "visits", agg: "sum" }] }),
    });
    const first = await deliver.sendDueReports(NOW);
    expect(first.queued).toBeGreaterThanOrEqual(2);
    const again = await Promise.all([deliver.sendDueReports(NOW), deliver.sendDueReports(NOW)]);
    expect(again.map((r) => r.queued)).toEqual([0, 0]);
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.eq(m.schema.notificationJobs.kind, "saved_report"));
    const mine = jobs.filter((j) => j.subject?.startsWith("Owner daily"));
    expect(mine).toHaveLength(2);
    for (const j of mine) {
      expect(j.attachments).toBeNull();
      expect(j.body).toMatch(/\/admin\/reports\/custom\//);
      expect(j.body).toMatch(/Sum of Visits/);
    }
    // Michelle may not export client lists, so her copy has no file; the owner's had one.
    expect(mine.find((j) => j.to === "michelle@rayz.test")!.body).toMatch(/No file is attached: client lists can only be downloaded by brand-level roles/);
    const sends = await m.db.db.select().from(m.schema.savedReportSends).where(m.drizzle.eq(m.schema.savedReportSends.reportId, id));
    expect(sends.map((s) => s.status)).toEqual(["queued", "queued"]);
    // Even with a file still on it, the outbox won't hand out a scheduled report's attachment.
    await m.db.db.update(m.schema.notificationJobs).set({ attachments: [{ filename: "x.csv", contentType: "text/csv", content: "eA==" }] }).where(m.drizzle.eq(m.schema.notificationJobs.id, mine[0].id));
    await signInAs(ids.owner);
    const route = await import("@/app/admin/notifications/[id]/attachment/route");
    expect((await get(route.GET as never, `/admin/notifications/${mine[0].id}/attachment?i=0`, { id: mine[0].id })).status).toBe(404);
    // The totals go in the Morning Dashboard for the owner and the people it's sent to.
    const reports = await deliver.morningReportsFor(ids.michelle, NOW);
    expect(reports.find((r) => r.id === id)).toMatchObject({ name: "Owner daily", href: `/admin/reports/custom/${id}` });
    expect(reports.find((r) => r.id === id)!.lines.join(" ")).toMatch(/clients.*Sum of Visits/);
    const md = await import("@/server/morning-dashboard");
    const access = await import("@/server/auth/access");
    const d = (await md.buildMorningDashboard({ access: (await access.loadStaffAccess(ids.michelle))!, firstName: "Michelle", shopIds: [shop.coralville], now: NOW, savedReports: true }))!;
    const { morningDoc } = await import("@/domain/morning-render");
    const section = morningDoc(d).sections.find((s) => s.key === "saved_reports")!;
    expect(section.blocks[0]).toMatchObject({ kind: "list", items: expect.arrayContaining([expect.objectContaining({ title: "Owner daily" })]) });
    expect((await deliver.morningReportsFor(ids["manager.moline"], NOW)).find((r) => r.id === id)).toBeUndefined();
  });
});

describe("pages", () => {
  it("opens the list, the builder and a report for people who may, and nothing for others", async () => {
    const michelle = await ctxOf("michelle");
    const id = await saved.saveReport(michelle, { name: "Michelle's private", definition: def({}) });
    await signInAs(ids.michelle);
    const list = await open("/admin/reports/custom");
    expect(list.kind).toBe("ok");
    expect(list.text).toContain("Michelle's private");
    expect((await open("/admin/reports/custom/new")).kind).toBe("ok");
    expect((await open("/admin/reports/custom/[id]", { id })).kind).toBe("ok");
    expect((await open("/admin/reports")).text).toContain("Custom reports");
    await signInAs(ids["manager.moline"]);
    expect((await open("/admin/reports/custom/[id]", { id })).kind).toBe("404");
    await signInAs(ids.makenna);
    expect((await open("/admin/reports/custom")).kind).toBe("denied");
    expect((await open("/admin/reports/custom/new")).kind).toBe("denied");
    expect((await open("/admin/reports/custom/[id]", { id })).kind).toBe("denied");
    await signInAs(null);
  });

  it("hides fields Client data hides from the builder's picker", async () => {
    const michelle = await ctxOf("michelle");
    const { builderOptions } = await import("@/app/admin/reports/custom/data");
    const o = await builderOptions(withPerms(michelle, []));
    const f = (k: string) => o.fields.find((x) => x.key === k)!;
    const policy = await privacy.clientPolicy(michelle);
    for (const k of ["phone", "email", "birthday"] as const) expect(f(k).use.use).toBe(policy.level(k) === "hidden" ? "none" : policy.level(k));
    expect(o.may).toMatchObject({ build: true, template: false });
    expect(o.may.export).toMatch(/only be downloaded by brand-level roles/);
    expect((await builderOptions(withPerms(michelle, ["clients.export"]))).may.export).toMatch(/only be downloaded by brand-level roles/);
  });
});
