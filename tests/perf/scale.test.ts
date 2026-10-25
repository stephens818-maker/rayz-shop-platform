/**
 * Scale: 50 locations across regions, 500 staff, 500k clients and a month of tickets. Checks that
 * the hot queries use indexes (no sequential scans of the big tables), that access loading, client
 * search, the brand-wide reports, the daily rollups and their comparisons, location setup and the
 * background jobs stay within time budgets, and that a job task keeps to its time limit whatever
 * the client count. Budgets are generous (shared CI machines vary); they catch a missing index or
 * an accidental per-row loop, not small regressions.
 *
 * Needs its own throwaway database (the name must contain "perf"); it is migrated, seeded and
 * grown to scale on the first run and reused after:
 *   createdb rayz_perf
 *   PERF_DATABASE_URL=postgres://rayz:rayz@localhost:5432/rayz_perf npm run test:perf
 * PERF_RESEED=1 starts it over.
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewCtx } from "@/domain/report-views";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const URL = process.env.PERF_DATABASE_URL;
const SCALE = { locations: 50, staff: 500, clients: 500_000 };
const BIG = ["customers", "sales", "payments", "appointments", "staff_access_shops", "location_daily_stats", "job_tasks", "client_badges"];

type Mods = {
  db: typeof import("@/db");
  drizzle: typeof import("drizzle-orm");
  time: typeof import("@/lib/time");
};
let m: Mods;
const results: { what: string; ms: number; budget: number }[] = [];
const ids = { shops: [] as string[], shopNames: [] as { id: string; name: string }[], regional: "", regionShops: [] as string[], customer: "" };

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T,>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];

/** The median of three runs after a warm-up, so one slow plan or cold cache doesn't decide it. */
async function timed<T>(what: string, budget: number, fn: () => Promise<T>, runs = 3): Promise<T> {
  let out = await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    times.push(performance.now() - t);
  }
  const ms = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  results.push({ what, ms: Math.round(ms), budget });
  expect(ms, `${what} took ${Math.round(ms)}ms (budget ${budget}ms)`).toBeLessThanOrEqual(budget);
  return out;
}

/**
 * Big relations a plan still reads with a sequential scan when the planner is told to avoid them,
 * i.e. no index serves the query. (Tables that stay small, like the job queue, are rightly scanned
 * otherwise.)
 */
async function seqScans(q: ReturnType<typeof sql>): Promise<string[]> {
  const plan = await m.db.db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const [r] = (await tx.execute(sql`explain (format json) ${q}`)) as unknown as { "QUERY PLAN": unknown }[];
    return r["QUERY PLAN"];
  });
  const out: string[] = [];
  const walk = (n: Record<string, unknown>) => {
    if (n["Node Type"] === "Seq Scan" && BIG.includes(String(n["Relation Name"]))) out.push(String(n["Relation Name"]));
    for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
  };
  walk((plan as { Plan: Record<string, unknown> }[])[0].Plan);
  return out;
}

const brandViewer = () => ({ brandWide: true, currentShopId: null, shopIds: ids.shops });
const loc = (view: "combined" | "shops"): ViewCtx => ({ view, shops: ids.shopNames, totalLabel: "Brand total" });

describe.skipIf(!URL)("scale: 50 locations, 500 staff, 500k clients", () => {
  let today = "";
  let monthAgo = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    const { assertThrowaway, seedScale, DEFAULT_SCALE } = await import("../../scripts/seed-scale");
    assertThrowaway(URL);
    const env = { ...process.env, DATABASE_URL: URL, MIGRATE_DATABASE_URL: URL, SEED_HISTORY_DAYS: "3" };
    execSync("npx tsx scripts/migrate.ts", { env, stdio: "pipe" });
    m = { db: await import("@/db"), drizzle: await import("drizzle-orm"), time: await import("@/lib/time") };
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from customers`);
    if (process.env.PERF_RESEED === "1" || n < SCALE.clients) {
      execSync("npx tsx scripts/seed.ts", { env, stdio: "pipe" });
      await seedScale({ ...DEFAULT_SCALE, log: (msg) => console.log(`[scale]${msg}`) });
    }
    today = m.time.todayLocal();
    monthAgo = m.time.addDays(today, -30);
    ids.shopNames = await rows<{ id: string; name: string }>(sql`select id::text id, name from shops where status = 'live' order by name`);
    ids.shops = ids.shopNames.map((r) => r.id);
    ids.regional = (await rows<{ id: string }>(sql`select id::text id from staff where staff_code = 'PRM1'`))[0].id;
    ids.regionShops = (await rows<{ id: string }>(sql`select shop_id::text id from staff_access_shops where staff_id = ${ids.regional}::uuid`)).map((r) => r.id);
    ids.customer = (await rows<{ id: string }>(sql`select customer_id::text id from sales where squire_ref like 'perf-%' order by squire_ref limit 1`))[0].id;
  }, 3_600_000);

  afterAll(async () => {
    console.table(results);
    await m?.db.closeDb();
  });

  it("has the data", async () => {
    const [c] = await rows<{ shops: number; staff: number; clients: number; sales: number; regions: number }>(
      sql`select (select count(*)::int from shops) shops, (select count(*)::int from staff) staff, (select count(*)::int from customers) clients,
        (select count(*)::int from sales) sales, (select count(*)::int from regions) regions`,
    );
    expect(c.shops).toBeGreaterThanOrEqual(SCALE.locations);
    expect(c.staff).toBeGreaterThanOrEqual(SCALE.staff);
    expect(c.clients).toBeGreaterThanOrEqual(SCALE.clients);
    expect(c.sales).toBeGreaterThan(30_000);
    expect(c.regions).toBeGreaterThanOrEqual(5);
    const [{ inRegion }] = await rows<{ inRegion: number }>(sql`select count(*)::int "inRegion" from shops where region_id = (select id from regions where slug = 'perf-region-1')`);
    expect(ids.regionShops.length).toBe(inRegion);
    expect(inRegion).toBeGreaterThanOrEqual(8);
  });

  it("reads the big tables through indexes", async () => {
    const shop = ids.shops[7];
    const some = ids.shops.slice(0, 10);
    const list = m.drizzle.sql.join(some.map((s) => sql`${s}::uuid`), sql`, `);
    const plans = {
      "client by phone": sql`select id from customers where phone = '+15630012345'`,
      "client by name": sql`select id from customers where search_name like '%smith12%' limit 8`,
      "client's visits": sql`select id from appointments where customer_id = ${ids.customer}::uuid order by starts_at desc limit 50`,
      "client's tickets": sql`select id from sales where customer_id = ${ids.customer}::uuid`,
      "location's day": sql`select id from sales where shop_id = ${shop}::uuid and business_date = ${today}::date`,
      "location's calendar": sql`select id from appointments where shop_id = ${shop}::uuid and starts_at >= now() and starts_at < now() + interval '1 day'`,
      "a person's locations": sql`select shop_id from staff_access_shops where staff_id = ${ids.regional}::uuid`,
      "who reaches a location": sql`select staff_id from staff_access_shops where shop_id = ${shop}::uuid`,
      "rollup range": sql`select * from location_daily_stats where shop_id in (${list}) and day between ${monthAgo}::date and ${today}::date`,
      "region's days": sql`select * from location_daily_stats where region_id = (select id from regions where slug = 'perf-region-1') and day between ${monthAgo}::date and ${today}::date`,
      "next job": sql`select id from job_tasks where status = 'queued' and kind in ('rollup') and attempts < 5 order by run_on, created_at limit 1`,
    };
    const scans: Record<string, string[]> = {};
    for (const [k, q] of Object.entries(plans)) {
      const s = await seqScans(q);
      if (s.length) scans[k] = s;
    }
    expect(scans).toEqual({});
  });

  it("loads a regional manager's access and finds clients quickly", async () => {
    const access = await import("@/server/auth/access");
    const a = await timed("load a Regional Manager's access (selected shops)", 150, () => access.loadStaffAccess(ids.regional));
    expect(new Set(a!.shopIds)).toEqual(new Set(ids.regionShops));
    const customers = await import("@/server/customers");
    const byName = await timed("search clients by name", 400, () => customers.searchCustomers("james smith12", 8));
    expect(byName.length).toBeGreaterThan(0);
    await timed("search clients by phone", 400, () => customers.searchCustomers("5630012345", 8));
    await timed("a client's stats", 300, () => customers.customerStats(ids.customer));
  });

  it("runs the sales summary over a month of every location", async () => {
    const { REPORT_LOADERS } = await import("@/server/report-data");
    const input = (view: "combined" | "shops") => ({ scope: { shopIds: ids.shops, from: monthAgo, to: today }, loc: loc(view), viewer: brandViewer(), params: {} });
    await timed("sales summary, all locations, a month", 4_000, () => REPORT_LOADERS.sales_summary(input("combined")));
    await timed("sales summary by location, all locations, a month", 4_000, () => REPORT_LOADERS.sales_summary(input("shops")));
  });

  it("rolls up every location's days in the background and compares them quickly", async () => {
    const jobs = await import("@/server/jobs");
    const { REPORT_LOADERS } = await import("@/server/report-data");
    const from = m.time.addDays(today, -7);
    await m.db.db.execute(sql`delete from job_tasks where kind = 'rollup'`);
    const queued = await jobs.backfillRollups(from, m.time.addDays(today, -1));
    expect(queued).toBeGreaterThanOrEqual(ids.shops.length * 7);
    const t = performance.now();
    const run = await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 300_000 });
    const per = (performance.now() - t) / Math.max(1, run.done);
    results.push({ what: "one location-day rollup (average)", ms: Math.round(per), budget: 250 });
    expect(run).toMatchObject({ failed: 0, remaining: 0 });
    expect(per).toBeLessThanOrEqual(250);
    const input = (by: string, shopIds = ids.shops) => ({ scope: { shopIds, from, to: m.time.addDays(today, -1) }, loc: loc("combined"), viewer: brandViewer(), params: { by } });
    const byLocation = await timed("compare by location, a week", 800, () => REPORT_LOADERS.rollup(input("location")));
    expect(byLocation.tables[0].rows.length).toBeGreaterThanOrEqual(SCALE.locations);
    const byRegion = await timed("compare by region, a week", 800, () => REPORT_LOADERS.rollup(input("region")));
    expect(byRegion.tables[0].rows.length).toBeGreaterThanOrEqual(5);
    const mine = await timed("compare a regional manager's locations, a week", 500, () => REPORT_LOADERS.rollup(input("location", ids.regionShops)));
    expect(mine.tables[0].rows.length).toBe(ids.regionShops.length);
  }, 600_000);

  it("claims job tasks quickly with thousands queued", async () => {
    const jobs = await import("@/server/jobs");
    await jobs.enqueue("triggers", Array.from({ length: 5_000 }, (_, i) => `${ids.shops[i % ids.shops.length]}|perf-${i}`), "2099-01-01");
    await timed("claim the next task", 50, async () => {
      const t = await jobs.claim(new Date(), ["triggers"]);
      if (t) await m.db.db.execute(sql`delete from job_tasks where id = ${t.id}::uuid`);
      return t;
    });
    await m.db.db.execute(sql`delete from job_tasks where run_on = '2099-01-01'`);
  });

  it("keeps a badge slice within its time limit, whatever the client count", async () => {
    const { runBadgeJob } = await import("@/server/badges");
    const budget = 8_000;
    await m.db.db.execute(sql`delete from client_badges where mod(abs(hashtext(customer_id::text)::bigint), 16) = 0`);
    const t = performance.now();
    const r = await runBadgeJob(new Date(), { bucket: { k: 0, of: 16 }, budgetMs: budget, batch: 500 });
    const ms = performance.now() - t;
    results.push({ what: `badge slice: ${r.scanned} clients scanned, ${r.remaining} left`, ms: Math.round(ms), budget: budget + 7_000 });
    expect(r.scanned).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(budget + 7_000);
  }, 60_000);

  it("lists every location's setup and moves a location to another region quickly", async () => {
    const { setupOverview } = await import("@/server/location-setup");
    const list = await timed("location setup overview, all locations", 2_500, () => setupOverview(ids.shops), 1);
    expect(list.length).toBe(ids.shops.length);
    const { setShopRegion } = await import("@/server/regions");
    const [s] = await rows<{ id: string; r: string }>(sql`select id::text id, region_id::text r from shops where slug = 'perf-1'`);
    const [other] = await rows<{ id: string }>(sql`select id::text id from regions where slug like 'perf-region-%' and id <> ${s.r}::uuid order by slug limit 1`);
    const actor = { staffId: null, label: "perf" };
    const t = performance.now();
    await setShopRegion(actor, s.id, other.id);
    const ms = performance.now() - t;
    results.push({ what: "move a location to another region (history included)", ms: Math.round(ms), budget: 1_000 });
    expect(ms).toBeLessThanOrEqual(1_000);
    const [{ stale }] = await rows<{ stale: number }>(sql`select count(*)::int stale from location_daily_stats where shop_id = ${s.id}::uuid and region_id is distinct from ${other.id}::uuid`);
    expect(stale).toBe(0);
    await setShopRegion(actor, s.id, s.r);
  });
});
