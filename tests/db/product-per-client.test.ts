/**
 * Product sales per client (Charles, Oct 28) against a real database, in a pay period no other test
 * reaches: product sales before tax over the unique clients of completed tickets, a client counted
 * once however often they came and whoever cut them, a walk-in once per ticket, and refunded, voided
 * and gift-card-only tickets left out. Per barber, location and brand in the PPH report (ranked, with
 * the trend), on the dashboard card beside PPH (today, yesterday and the period to date, a shop's
 * dashboard, a barber's own, none without money), in the Morning Dashboard and in /me/earnings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportTable } from "@/domain/report-views";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", end: "", today: "", now: new Date() };
const client: Record<string, string> = {};
let barberB: string;
let barberM: string;
const label: Record<string, string> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const day = (n: number) => m.time.addDays(fx.start, n);
const at = (n: number, h: number) => m.time.zonedWallTime(day(n), h * 60).toJSDate();
/** A paid ticket with sales on the header and no lines; no client is a walk-in. */
async function sale(staffId: string, shopId: string, n: number, serviceNetCents: number, productNetCents: number, customerId: string | null = null) {
  await m.db.db.insert(m.schema.sales).values({ shopId, staffId, customerId, businessDate: day(n), status: "paid", serviceNetCents, productNetCents, paidAt: at(n, 12) });
}
/** A ticket with lines and nothing to sell: none of these is a completed ticket. */
async function ticket(staffId: string, shopId: string, n: number, status: "paid" | "refunded" | "voided", kind: "product" | "gift_card", customerId: string | null, refunded = false) {
  const [s] = await m.db.db
    .insert(m.schema.sales)
    .values({ shopId, staffId, customerId, businessDate: day(n), status, serviceNetCents: 0, productNetCents: 0, paidAt: at(n, 12) })
    .returning({ id: m.schema.sales.id });
  await m.db.db.insert(m.schema.saleItems).values({ saleId: s.id, kind, name: kind, unitPriceCents: 0, grossCents: 0, netCents: 0, qty: 1, refundedQty: refunded ? 1 : 0 });
}
async function bookable(shopId: string, except: string[]) {
  const links = await m.db.db
    .select({ id: m.schema.staffShops.staffId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, shopId), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  return links.map((l) => l.id).find((id) => !except.includes(id))!;
}
async function withoutMoney<T>(staffId: string, f: () => Promise<T>) {
  await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "reports.money": false } }).where(eq(m.schema.staff.id, staffId));
  try {
    return await f();
  } finally {
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, staffId));
  }
}

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  const run = await import("@/server/payroll/run");
  for (const l of ["owner", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  barberB = await bookable(shop.coralville, [ids.makenna]);
  barberM = await bookable(shop.moline, [ids.makenna, barberB]);
  for (const s of await m.db.db.select({ id: m.schema.staff.id, label: m.schema.staff.displayLabel }).from(m.schema.staff)) label[s.id] = s.label;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2030-05-15");
  [fx.start, fx.end] = [p.start, p.end];
  expect(m.time.weekdayOf(fx.start)).toBe(0);
  fx.today = day(9);
  fx.now = at(9, 15);
  for (const k of ["c1", "c2"])
    client[k] = (await m.db.db.insert(m.schema.customers).values({ firstName: "Per", lastName: `Client ${k}`, homeShopId: shop.coralville }).returning({ id: m.schema.customers.id }))[0].id;

  // Makenna at Coralville: client 1 twice ($20 and $10 of product), a walk-in with no product, a
  // walk-in buying only product ($15), and today a walk-in with $9. Four unique clients, $54.
  await sale(ids.makenna, shop.coralville, 1, 3_000, 2_000, client.c1);
  await sale(ids.makenna, shop.coralville, 3, 3_000, 1_000, client.c1);
  await sale(ids.makenna, shop.coralville, 3, 2_500, 0);
  await sale(ids.makenna, shop.coralville, 4, 0, 1_500);
  await sale(ids.makenna, shop.coralville, 9, 2_000, 900);
  // Not clients: refunded, voided and gift-card-only tickets.
  await ticket(ids.makenna, shop.coralville, 5, "refunded", "product", client.c2, true);
  await ticket(ids.makenna, shop.coralville, 5, "voided", "product", client.c2);
  await ticket(ids.makenna, shop.coralville, 6, "paid", "gift_card", null);
  // Barber B at Coralville: client 1 too ($30), and yesterday client 2 ($12). Two clients, $42.
  await sale(barberB, shop.coralville, 2, 2_000, 3_000, client.c1);
  await sale(barberB, shop.coralville, 8, 3_000, 1_200, client.c2);
  // Barber M at Moline: client 1 again ($6).
  await sale(barberM, shop.moline, 2, 2_000, 600, client.c1);
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function load(who: string, p: Record<string, string | string[]>) {
  await signInAs(ids[who]);
  const S = await import("@/app/admin/reports/scope");
  const L = await import("@/server/report-data");
  const access = await import("@/server/report-access");
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const rctx = await access.reportContext(ctx, "pph");
  const q = { from: fx.start, to: fx.end, ...p };
  const scope = await S.resolveScope(rctx, q, "pph");
  const params = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return L.loadReport("pph", { scope, loc: scope.loc, viewer: rctx, params } as never);
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id)!;
const col = (t: ReportTable, l: string) => t.columns.findIndex((c) => c.label === l);
const cells = (t: ReportTable, ...ls: string[]) => t.rows.map((r) => ls.map((l) => r[col(t, l)]));

describe("the PPH report", () => {
  it("ranks barbers by product sales per client; locations and the brand count each client once", async () => {
    const d = await load("owner", { shop: Object.values(shop), rank: "perClient" });
    const b = table(d, "barbers");
    expect(b.title).toBe("Barber leaderboard: Product sales per client");
    expect(cells(b, "Rank", "Barber", "Product sales", "Unique clients", "Product sales per client")).toEqual([
      [1, label[barberB], 4_200, 2, 2_100],
      [2, label[ids.makenna], 5_400, 4, 1_350],
      [3, label[barberM], 600, 1, 600],
      [null, expect.any(String), 10_200, 5, 2_040],
    ]);
    expect(b.sorted).toEqual({ column: col(b, "Product sales per client"), dir: "desc" });
    expect(b.columns[col(b, "Unique clients")].sum).toBe(false);
    expect(cells(table(d, "locations"), "Location", "Unique clients", "Product sales per client").filter((r) => r[1])).toEqual([
      ["Coralville", 5, 1_920],
      ["Moline", 1, 600],
      [expect.any(String), 5, 2_040],
    ]);
    expect(d.stats.find((s) => s.label === "Product sales per client")).toMatchObject({ value: "$20.40", hint: "product sales over 5 unique clients" });
    expect(d.options?.find((o) => o.param === "rank")?.choices.map((c) => c.value)).toEqual(["service", "clients", "product", "total", "perClient"]);
    expect(d.notes?.join(" ")).toContain("a walk-in, a ticket with no client on it, counts once per ticket");
  });

  it("shows the brand beside one location, and trends it day by day (client 1 at both shops on day 2 is one brand client)", async () => {
    const d = await load("owner", { shop: shop.coralville, trend: "day" });
    const rows = table(d, "barbers").rows;
    const pc = col(table(d, "barbers"), "Product sales per client");
    expect(rows.slice(-2).map((r) => [r[1], r[pc]])).toEqual([
      [expect.any(String), 1_920],
      ["Brand", 2_040],
    ]);
    const t = table(d, "trend");
    expect(cells(t, "Unique clients", "Product sales per client").slice(0, 7)).toEqual([[0, "N/A"], [1, 2_000], [1, 3_000], [2, 500], [1, 1_500], [0, "N/A"], [0, "N/A"]]);
    const chart = d.charts?.find((c) => c.id === "trend_per_client");
    expect(chart).toMatchObject({ kind: "money", title: "Product sales per client against the brand" });
    expect(chart?.series[1].values.slice(0, 3)).toEqual([null, 2_000, 3_600]);
  });
});

describe("the dashboard card", () => {
  async function card(who: string, shopIds: string[] | null, rankBy: "today" | "yesterday" | "period" = "period") {
    const dash = await import("@/server/pph-dashboard");
    const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids[who]))!;
    const shops = access.shops.filter((s) => (shopIds ? shopIds.includes(s.id) : true)).map((s) => ({ id: s.id, name: s.name }));
    return (await dash.pphDashboard({ access, shops, brand: shopIds === null, today: fx.today, now: fx.now, rankBy: "period", perClientBy: rankBy }))!;
  }

  it("the brand: today, yesterday and the period to date, barbers and locations ranked, and the sparkline", async () => {
    const c = (await card("owner", null)).perClient!;
    expect(c.total).toEqual({
      today: { productCents: 900, clients: 1, perClient: 900 },
      yesterday: { productCents: 1_200, clients: 1, perClient: 1_200 },
      period: { productCents: 10_200, clients: 5, perClient: 2_040 },
    });
    expect(c.barbers.map((x) => [x.rank, x.item.id, x.item.f.perClient])).toEqual([
      [1, barberB, 2_100],
      [2, ids.makenna, 1_350],
      [3, barberM, 600],
    ]);
    expect(c.shops.filter((x) => x.item.f.clients).map((x) => [x.rank, x.item.name, x.item.f.perClient])).toEqual([
      [1, "Coralville", 1_920],
      [2, "Moline", 600],
    ]);
    const spark = new Map(c.spark.map((s) => [s.date, s.value]));
    expect([spark.get(day(1)), spark.get(day(2)), spark.get(day(5)), spark.get(fx.today)]).toEqual([2_000, 3_600, null, 900]);
    const today = (await card("owner", null, "today")).perClient!;
    expect(today.barbers.map((x) => x.item.id)).toEqual([ids.makenna]);
  });

  it("a shop's dashboard is only that shop; a barber sees only their own; none without money", async () => {
    const one = (await card("owner", [shop.coralville])).perClient!;
    expect(one.shops).toEqual([]);
    expect(one.total.period).toEqual({ productCents: 9_600, clients: 5, perClient: 1_920 });
    const own = await card("makenna", null);
    expect(own.scope).toBe("own");
    expect(own.perClient?.barbers).toEqual([]);
    expect(own.perClient?.total.period).toEqual({ productCents: 5_400, clients: 4, perClient: 1_350 });
    expect((await withoutMoney(ids.makenna, () => card("makenna", null))).perClient).toBeNull();
  });
});

describe("other places", () => {
  it("the Morning Dashboard: product sales per client on the day and week to date, per barber and against the brand", async () => {
    const md = await import("@/server/morning-dashboard");
    const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids.owner))!;
    const d = (await md.buildMorningDashboard({ access, firstName: "Owner", shopIds: [shop.coralville], today: day(7), now: at(7, 7), allSections: true }))!;
    expect(d.periods.reportDay).toBe(day(6));
    const p = d.pph!;
    expect([p.product.day, p.served.day, p.product.wtd, p.served.wtd]).toEqual([0, 0, 7_500, 3]);
    expect(p.brand?.wtd).toMatchObject({ product: 8_100, served: 3 });
    expect(p.byBarber.find((b) => b.staffId === ids.makenna)?.wtd).toMatchObject({ product: 4_500, served: 3 });
    const { renderMorningText } = await import("@/domain/morning-render");
    const body = renderMorningText(d).body;
    expect(body).toMatch(/Product sales per client: N\/A .*WTD \$25\.00/);
    expect(body).toContain("Brand product sales per client: N/A on the day, $27.00 week to date.");
  });

  it("/me/earnings: their own product sales per client for the period and per shop; none without money", async () => {
    const token = (await api.login("makenna@rayz.test")).accessToken;
    const r = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token });
    expect(r.status, r.text).toBe(200);
    expect(r.json.productPerClient).toEqual({ productSalesCents: 5_400, uniqueClients: 4, productSalesPerClientCents: 1_350, na: false });
    expect((r.json.shops as J[]).find((s) => s.shopId === shop.coralville).productPerClient).toEqual({ productSalesCents: 5_400, uniqueClients: 4, productSalesPerClientCents: 1_350, na: false });
    expect(JSON.stringify(r.json)).not.toContain(barberB);
    const hidden = await withoutMoney(ids.makenna, async () => api.call("GET", `me/earnings?periodId=${fx.start}`, { token: (await api.login("makenna@rayz.test")).accessToken }));
    expect(hidden.json.productPerClient).toBeNull();
  });
});
