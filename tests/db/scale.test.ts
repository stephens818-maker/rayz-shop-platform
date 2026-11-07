/**
 * Scale readiness: optional regions over locations, the per-location daily rollups and the
 * location comparison built on them, and the background job queue that runs rollups, badges and
 * campaign triggers in small claimed tasks. Regions are brand-wide records: a shop- or
 * region-scoped person can't change them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViewCtx } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let jobs: typeof import("@/server/jobs");
let regions: typeof import("@/server/regions");
let setup: typeof import("@/app/admin/setup/actions");
let rollup: typeof import("@/server/rollup-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T,>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];

const shop: Record<string, string> = {};
const people: Record<string, string> = {};
const region: Record<string, string> = {};
let today = "";
let yesterday = "";

const input = (shopIds: string[], from: string, to: string, params: Record<string, string> = {}) => ({
  scope: { shopIds, from, to },
  loc: { view: "combined", shops: [], totalLabel: "Brand total" } as ViewCtx,
  viewer: { brandWide: true, currentShopId: null, shopIds },
  params,
});
const regionOf = async (id: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) }))!.regionId;

beforeAll(async () => {
  m = await loadModules();
  jobs = await import("@/server/jobs");
  regions = await import("@/server/regions");
  setup = await import("@/app/admin/setup/actions");
  rollup = await import("@/server/rollup-report");
  today = m.time.todayLocal();
  yesterday = m.time.addDays(today, -1);
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const r of await m.db.db.select().from(m.schema.regions)) region[r.name] = r.id;
  for (const l of ["owner", "admin", "regional", "michelle"]) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("regions", () => {
  it("are seeded over the locations, with rolled-up history carrying them", async () => {
    expect(Object.keys(region).sort()).toEqual(["Eastern Iowa", "Quad Cities"]);
    expect(await regionOf(shop.moline)).toBe(region["Quad Cities"]);
    expect(await regionOf(shop.coralville)).toBe(region["Eastern Iowa"]);
    const [{ off }] = await rows<{ off: number }>(sql`select count(*)::int off from location_daily_stats d join shops s on s.id = d.shop_id where d.region_id is distinct from s.region_id`);
    expect(off).toBe(0);
    const [{ days }] = await rows<{ days: number }>(sql`select count(*)::int days from location_daily_stats where day = ${yesterday}::date`);
    expect(days).toBe(Object.keys(shop).length);
  });

  it("are added, renamed and deleted by the brand, with names kept unique", async () => {
    await signInAs(people.admin);
    const made = await setup.saveRegionAction(null, "  Northern Illinois ");
    expect(made).toMatchObject({ ok: true });
    const id = (made as { data: { id: string } }).data.id;
    expect(await m.db.db.query.regions.findFirst({ where: eq(m.schema.regions.id, id) })).toMatchObject({ name: "Northern Illinois", slug: "northern-illinois" });
    expect(await setup.saveRegionAction(null, "quad cities")).toMatchObject({ ok: false, error: /already a region called/ });
    expect(await setup.saveRegionAction(null, "X")).toMatchObject({ ok: false });
    expect(await setup.saveRegionAction(id, "Northern Illinois")).toMatchObject({ ok: true });
    expect(await setup.saveRegionAction(id, "Rockford Area")).toMatchObject({ ok: true });
    expect((await m.db.db.query.regions.findFirst({ where: eq(m.schema.regions.id, id) }))!.name).toBe("Rockford Area");

    expect(await setup.setShopRegionAction(shop.silvis, id)).toEqual({ ok: true, data: null });
    expect(await regionOf(shop.silvis)).toBe(id);
    expect(await setup.deleteRegionAction(id)).toEqual({ ok: true, data: null });
    expect(await regionOf(shop.silvis)).toBeNull();
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from location_daily_stats where shop_id = ${shop.silvis}::uuid and region_id is not null`);
    expect(n).toBe(0);
    expect(await setup.setShopRegionAction(shop.silvis, region["Quad Cities"])).toEqual({ ok: true, data: null });
    const log = await rows<{ action: string }>(sql`select action from audit_log where action like 'region.%' or action = 'shop.region' order by at`);
    expect(log.map((l) => l.action)).toEqual(["region.create", "region.update", "region.update", "shop.region", "region.delete", "shop.region"]);
  });

  it("move a location's rolled-up history with it", async () => {
    await regions.setShopRegion(actor, shop.dubuque, region["Quad Cities"]);
    const [{ off }] = await rows<{ off: number }>(sql`select count(*)::int off from location_daily_stats where shop_id = ${shop.dubuque}::uuid and region_id <> ${region["Quad Cities"]}::uuid`);
    expect(off).toBe(0);
    await regions.setShopRegion(actor, shop.dubuque, region["Eastern Iowa"]);
  });

  it("can't be changed by anyone without every shop", async () => {
    for (const [who, at] of [
      [people.regional, shop.moline],
      [people.michelle, shop.coralville],
    ]) {
      await signInAs(who, at);
      expect(await setup.saveRegionAction(null, "Mine")).toMatchObject({ ok: false });
      expect(await setup.saveRegionAction(region["Quad Cities"], "Renamed")).toMatchObject({ ok: false });
      expect(await setup.deleteRegionAction(region["Eastern Iowa"])).toMatchObject({ ok: false });
      expect(await setup.setShopRegionAction(at, region["Eastern Iowa"])).toMatchObject({ ok: false });
    }
    expect(await m.db.db.query.regions.findFirst({ where: eq(m.schema.regions.name, "Mine") })).toBeUndefined();
    expect(await regionOf(shop.moline)).toBe(region["Quad Cities"]);
    expect(await regionOf(shop.coralville)).toBe(region["Eastern Iowa"]);
  });

  it("show on Location setup, which only people with every shop can open", async () => {
    await signInAs(people.owner);
    const all = await open("/admin/setup");
    expect(all.kind).toBe("ok");
    expect(all.text).toMatch(/Quad Cities/);
    expect(all.text).toMatch(/Eastern Iowa/);
    for (const [who, at] of [
      [people.regional, shop.moline],
      [people.michelle, shop.coralville],
    ]) {
      await signInAs(who, at);
      expect((await open("/admin/setup")).kind).toBe("denied");
    }
  });
});

describe("daily rollups and the location comparison", () => {
  it("roll a location's day up to match its tickets", async () => {
    // The last day Coralville had tickets: yesterday is a closed Sunday when the suite runs on a Monday.
    const [{ day }] = await rows<{ day: string }>(
      sql`select max(business_date)::text as day from sales where shop_id = ${shop.coralville}::uuid and business_date < ${today}::date and status = 'paid'`,
    );
    await jobs.enqueue("rollup", [shop.coralville], day);
    await m.db.db.execute(sql`delete from location_daily_stats where shop_id = ${shop.coralville}::uuid and day = ${day}::date`);
    const { computeDailyStats } = await import("@/server/rollups");
    await computeDailyStats(shop.coralville, day);
    const [want] = await rows<{ tickets: number; net: number; tips: number }>(
      sql`select count(*)::int tickets, coalesce(sum(service_net_cents + product_net_cents), 0)::int net, coalesce(sum(tip_cents), 0)::int tips from sales
        where shop_id = ${shop.coralville}::uuid and business_date = ${day}::date and status in ('paid', 'refunded', 'partially_refunded')`,
    );
    const [got] = await rows<{ tickets: number; net: number; tips: number; region: string }>(
      sql`select tickets, (service_net_cents + product_net_cents)::int net, tip_cents::int tips, region_id::text region from location_daily_stats where shop_id = ${shop.coralville}::uuid and day = ${day}::date`,
    );
    expect(got).toEqual({ ...want, region: region["Eastern Iowa"] });
    expect(want.tickets).toBeGreaterThan(0);
    await computeDailyStats(shop.coralville, day);
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from location_daily_stats where shop_id = ${shop.coralville}::uuid and day = ${day}::date`);
    expect(n).toBe(1);
    await m.db.db.execute(sql`delete from job_tasks where kind = 'rollup' and run_on = ${day}::date`);
  });

  it("compare locations and regions, adding up to the same totals", async () => {
    const all = Object.values(shop);
    const from = m.time.addDays(today, -7);
    const byLocation = await rollup.rollupData(input(all, from, yesterday));
    const byRegion = await rollup.rollupData(input(all, from, yesterday, { by: "region" }));
    const t = byLocation.tables[0];
    const col = (label: string) => t.columns.findIndex((c) => c.label === label);
    expect(t.rows).toHaveLength(all.length);
    expect(t.rows.map((r) => r[0])).toEqual(all.map((_, i) => i + 1));
    const nets = t.rows.map((r) => Number(r[col("Net sales")]));
    expect(nets).toEqual([...nets].sort((a, b) => b - a));
    expect(byRegion.tables[0].rows.map((r) => r[1]).sort()).toEqual(["Eastern Iowa", "Quad Cities"]);
    const sum = (rs: typeof t.rows, c: number) => rs.reduce((a, r) => a + Number(r[c]), 0);
    for (const label of ["Tickets", "Net sales", "Locations"]) expect(sum(byRegion.tables[0].rows, col(label))).toBe(sum(t.rows, col(label)));
    const qc = byRegion.tables[0].rows.find((r) => r[1] === "Quad Cities")!;
    expect(qc[col("Locations")]).toBe(6);
    expect(byRegion.options?.[0]).toMatchObject({ param: "by", value: "region" });
  });

  it("say which days aren't rolled up yet, and leave out other locations", async () => {
    const r = await rollup.rollupData(input([shop.moline], today, today));
    expect(r.tables[0].rows).toEqual([]);
    expect(r.notes?.join(" ")).toMatch(/1 location-days in this range aren't rolled up yet/);
    const one = await rollup.rollupData(input([shop.moline, shop.utica], m.time.addDays(today, -3), yesterday));
    expect(one.tables[0].rows.map((x) => x[1]).sort()).toEqual(
      (await m.db.db.select({ name: m.schema.shops.name }).from(m.schema.shops).where(m.drizzle.inArray(m.schema.shops.id, [shop.moline, shop.utica]))).map((x) => x.name).sort(),
    );
  });

  it("is a report for whoever has the KPIs report", async () => {
    const [{ missing }] = await rows<{ missing: number }>(
      sql`select count(*)::int missing from roles where permissions ? 'report.kpis.view' and not permissions ? 'report.rollup.view'`,
    );
    expect(missing).toBe(0);
    await signInAs(people.owner);
    const page = await open("/admin/reports/rollup", {}, { by: "region" });
    expect(page.kind).toBe("ok");
    expect(page.text).toMatch(/Regions compared/);
  });
});

describe("background jobs", () => {
  it("queue each location's rollup once, and work through them", async () => {
    await m.db.db.execute(sql`delete from job_tasks`);
    const run = await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 60_000 });
    const live = (await m.db.db.select().from(m.schema.shops)).filter((s) => s.status !== "archived").length;
    expect(run).toMatchObject({ enqueued: live, done: live, failed: 0, remaining: 0 });
    expect(await jobs.enqueueDue(new Date(), ["rollup"])).toBe(0);
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from location_daily_stats where day = ${yesterday}::date`);
    expect(n).toBe(live);
  });

  it("hand a task to one worker at a time, and to another when the lease runs out", async () => {
    await jobs.enqueue("rollup", [shop.coralville], "2030-01-01");
    const now = new Date();
    const first = await jobs.claim(now, ["rollup"]);
    expect(first).toMatchObject({ shard: shop.coralville, runOn: "2030-01-01", status: "running", attempts: 1 });
    expect(await jobs.claim(now, ["rollup"])).toBeNull();
    const later = await jobs.claim(new Date(now.getTime() + 6 * 60_000), ["rollup"]);
    expect(later).toMatchObject({ id: first!.id, attempts: 2 });
    await m.db.db.execute(sql`delete from job_tasks where id = ${first!.id}::uuid`);
  });

  it("stop retrying a task that keeps failing, and leave it failed for someone to look at", async () => {
    await jobs.enqueue("rollup", ["not-a-shop"], today);
    const run = await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 30_000 });
    expect(run.failed).toBe(jobs.MAX_ATTEMPTS);
    const [t] = await rows<{ status: string; attempts: number; error: string }>(sql`select status, attempts, error from job_tasks where shard = 'not-a-shop'`);
    expect(t).toMatchObject({ status: "failed", attempts: jobs.MAX_ATTEMPTS });
    expect(t.error).toBeTruthy();
    expect((await jobs.runJobs(new Date(), { kinds: ["rollup"], budgetMs: 5_000 })).failed).toBe(0);
  });

  it("split badges into slices that together cover every client", async () => {
    const run = await jobs.runJobs(new Date(), { kinds: ["badges"], budgetMs: 120_000 });
    expect(run).toMatchObject({ enqueued: jobs.BADGE_BUCKETS, failed: 0, remaining: 0 });
    const [{ n }] = await rows<{ n: number }>(sql`select count(*)::int n from customers c left join client_badges b on b.customer_id = c.id where b.computed_on is distinct from ${today}::date`);
    expect(n).toBe(0);
  }, 180_000);

  it("run campaign triggers per location, once per slot", async () => {
    const now = new Date();
    const run = await jobs.runJobs(now, { kinds: ["triggers"], budgetMs: 60_000 });
    const live = (await m.db.db.select().from(m.schema.shops)).filter((s) => s.status !== "archived").length;
    expect(run).toMatchObject({ enqueued: live, failed: 0, remaining: 0 });
    const shards = await rows<{ shard: string }>(sql`select shard from job_tasks where kind = 'triggers'`);
    expect(new Set(shards.map((s) => s.shard.split("|")[0])).size).toBe(live);
    expect(await jobs.enqueueDue(now, ["triggers"])).toBe(0);
  }, 120_000);

  it("run each location's nudges once per 5-minute slot, and each due blast and sequence as its own task", async () => {
    const now = new Date();
    const live = (await m.db.db.select().from(m.schema.shops)).filter((s) => s.status === "live").length;
    const [blast] = await m.db.db
      .insert(m.schema.marketingCampaigns)
      .values({ kind: "blast", name: "Fan-out blast", shopIds: [shop.coralville], channels: ["sms"], segment: { minVisits: 9999 }, status: "scheduled", scheduledAt: new Date(now.getTime() - 60_000) })
      .returning();
    const [later] = await m.db.db
      .insert(m.schema.marketingCampaigns)
      .values({ kind: "blast", name: "Not yet", shopIds: [shop.coralville], channels: ["sms"], status: "scheduled", scheduledAt: new Date(now.getTime() + 3_600_000) })
      .returning();
    const run = await jobs.runJobs(now, { kinds: ["nudges", "campaigns", "reports", "payouts"], budgetMs: 60_000 });
    expect(run).toMatchObject({ failed: 0, remaining: 0 });
    const shards = await rows<{ kind: string; shard: string; status: string }>(sql`select kind, shard, status from job_tasks where kind in ('nudges', 'campaigns')`);
    const nudges = shards.filter((t) => t.kind === "nudges");
    expect(nudges).toHaveLength(live);
    expect(new Set(nudges.map((t) => t.shard.split("|")[1]))).toEqual(new Set([jobs.triggerSlot(now, jobs.NUDGE_SLOT_MINUTES)]));
    const campaigns = shards.filter((t) => t.kind === "campaigns").map((t) => t.shard);
    expect(campaigns.filter((x) => x.startsWith(`blast:${blast.id}|`))).toHaveLength(1);
    expect(campaigns.some((x) => x.includes(later.id))).toBe(false);
    expect((await m.db.db.query.marketingCampaigns.findFirst({ where: eq(m.schema.marketingCampaigns.id, blast.id) }))!.status).toBe("sent");
    expect(await jobs.enqueueDue(now, ["nudges", "campaigns"])).toBe(0);
    expect(await jobs.enqueueDue(new Date(now.getTime() + 5 * 60_000), ["nudges"])).toBe(live);
    await m.db.db.delete(m.schema.marketingCampaigns).where(m.drizzle.inArray(m.schema.marketingCampaigns.id, [blast.id, later.id]));
  }, 120_000);
});

describe("the sales list", () => {
  const date = "2023-03-14";
  const made: string[] = [];

  beforeAll(async () => {
    const at = new Date("2023-03-14T18:00:00.123456Z");
    const base = { shopId: shop.coralville, businessDate: date, totalCents: 1000 };
    for (let i = 0; i < 7; i++) {
      // Three share a timestamp, so the cursor has to break ties on id.
      const createdAt = new Date(at.getTime() - (i < 3 ? 0 : i * 60_000));
      const [s] = await m.db.db.insert(m.schema.sales).values({ ...base, status: "paid", paidAt: createdAt, createdAt }).returning();
      made.push(s.id);
    }
    await m.db.db.insert(m.schema.sales).values({ ...base, status: "voided", createdAt: at });
    await m.db.db.insert(m.schema.sales).values({ ...base, status: "open", createdAt: at });
  });

  it("pages through a day newest first, never skipping or repeating a ticket, and counts the whole day", async () => {
    const list = await import("@/server/sales-list");
    const seen: string[] = [];
    let before: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const p: Awaited<ReturnType<typeof list.salesPage>> = await list.salesPage({ shopIds: [shop.coralville], date, before, limit: 3 });
      seen.push(...p.rows.map((r) => r.id));
      if (!p.next) break;
      before = p.next;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(made.every((id) => seen.includes(id))).toBe(true);
    expect(await list.salesDayTotals([shop.coralville], date)).toEqual({ tickets: 8, paidCents: 7000 });
    expect(await list.openSales([shop.coralville], date)).toHaveLength(1);
    expect(await list.salesDayTotals([shop.moline], date)).toEqual({ tickets: 0, paidCents: 0 });
  });

  it("shows the day's totals from every ticket, with a link to the older ones", async () => {
    await signInAs(people.owner);
    const r = await open("/admin/sales", {}, { date });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.text).toContain("8 tickets · $70.00 collected");
    expect(r.text).not.toContain("sales-older");
  });
});
