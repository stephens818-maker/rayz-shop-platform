import "server-only";
import { sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import type { JobTaskStatus } from "@/db/schema";
import { addDays, todayLocal, toZoned } from "@/lib/time";
import { runBadgeJob } from "./badges";
import { runTriggers } from "./marketing/engine";

/**
 * Background work that grows with the number of locations, split into small tasks in job_tasks:
 *  - rollup: one location's day into location_daily_stats (the brand's comparison reports);
 *  - triggers: one location's automated campaigns for a 15-minute slot;
 *  - badges: one slice of the client file (BADGE_BUCKETS of them) for the day.
 * Each cron run (or the local worker) queues what's due, then claims tasks one at a time with
 * FOR UPDATE SKIP LOCKED until its time is up, so any number of runs share the work without
 * overlapping. A claimed task holds a lease; if its run dies, the lease runs out and another run
 * picks it up. A task that fails MAX_ATTEMPTS times stays failed for someone to look at.
 */

export const JOB_KINDS = ["rollup", "triggers", "badges"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const BADGE_BUCKETS = 16;
const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;

export interface JobTask {
  id: string;
  kind: JobKind;
  shard: string;
  runOn: string;
  status: JobTaskStatus;
  attempts: number;
}

/** The 15-minute slot a time falls in, in shop time: "14:30". */
export function triggerSlot(now: Date): string {
  const t = toZoned(now);
  return `${String(t.hour).padStart(2, "0")}:${String(Math.floor(t.minute / 15) * 15).padStart(2, "0")}`;
}

export async function enqueue(kind: JobKind, shards: readonly string[], runOn: string, tx: DBorTx = db): Promise<number> {
  if (!shards.length) return 0;
  const r = (await tx.execute(sql`
    insert into job_tasks (kind, shard, run_on)
    select ${kind}, s, ${runOn}::date from unnest(${sql`array[${sql.join(
      shards.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[]`}) s
    on conflict (kind, shard, run_on) do nothing
    returning id`)) as unknown as unknown[];
  return r.length;
}

/**
 * Queues what's due now: yesterday's rollup for every location that isn't archived, this slot's
 * campaign triggers for every live location, and today's badge slices. Safe to call on every run.
 */
export async function enqueueDue(now = new Date(), kinds: readonly JobKind[] = JOB_KINDS): Promise<number> {
  const today = todayLocal(now);
  let n = 0;
  const shopsWhere = async (statuses: string[]) =>
    (await db.execute(sql`select id::text id from shops where status in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)}) order by id`)) as unknown as { id: string }[];
  if (kinds.includes("rollup")) n += await enqueue("rollup", (await shopsWhere(["live", "closed"])).map((s) => s.id), addDays(today, -1));
  if (kinds.includes("triggers")) {
    const slot = triggerSlot(now);
    n += await enqueue("triggers", (await shopsWhere(["live"])).map((s) => `${s.id}|${slot}`), today);
  }
  if (kinds.includes("badges")) n += await enqueue("badges", Array.from({ length: BADGE_BUCKETS }, (_, k) => `${k}/${BADGE_BUCKETS}`), today);
  return n;
}

/** Takes the next task: queued, or running with a lease that ran out. Oldest day first. */
export async function claim(now = new Date(), kinds: readonly JobKind[] = JOB_KINDS): Promise<JobTask | null> {
  const until = new Date(now.getTime() + LEASE_MS);
  const [row] = (await db.execute(sql`
    update job_tasks t set status = 'running', attempts = t.attempts + 1, locked_until = ${until.toISOString()}::timestamptz, started_at = ${now.toISOString()}::timestamptz, error = null
    where t.id = (
      select id from job_tasks
      where kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
        and (status = 'queued' or (status = 'running' and locked_until < ${now.toISOString()}::timestamptz))
        and attempts < ${MAX_ATTEMPTS}
      order by run_on, created_at
      for update skip locked
      limit 1
    )
    returning t.id, t.kind, t.shard, t.run_on::text "runOn", t.status, t.attempts`)) as unknown as JobTask[];
  return row ?? null;
}

async function finish(t: JobTask, outcome: "done" | "again" | "error", result: Record<string, unknown> | null, error: string | null) {
  const status: JobTaskStatus = outcome === "done" ? "done" : outcome === "again" || t.attempts < MAX_ATTEMPTS ? "queued" : "failed";
  await db.execute(sql`
    update job_tasks set status = ${status}, finished_at = now(), locked_until = null, result = ${result ? JSON.stringify(result) : null}::jsonb, error = ${error},
      attempts = attempts - ${outcome === "again" ? 1 : 0}
    where id = ${t.id}::uuid`);
}

/**
 * One location's day for the brand rollups. The owner is the one of that day (shop_owner_history)
 * and the region the location's current one. Imported history counts, so comparisons reach back
 * before go-live. Recomputing a day replaces it.
 */
export async function computeDailyStats(shopId: string, day: string, tx: DBorTx = db) {
  await tx.execute(sql`
    with sh as (select id, region_id, timezone from shops where id = ${shopId}::uuid),
    own as (
      select h.owner_entity_id from shop_owner_history h
      where h.shop_id = ${shopId}::uuid and h.valid_from <= ${day}::date and (h.valid_to is null or h.valid_to > ${day}::date)
      order by h.valid_from desc limit 1
    ),
    s as (
      select count(*)::int tickets, coalesce(sum(service_gross_cents + product_gross_cents), 0)::bigint gross, coalesce(sum(discount_cents), 0)::bigint disc,
        coalesce(sum(service_net_cents), 0)::bigint sn, coalesce(sum(product_net_cents), 0)::bigint pn,
        coalesce(sum(service_tax_cents + product_tax_cents), 0)::bigint tax, coalesce(sum(tip_cents), 0)::bigint tips,
        count(distinct customer_id)::int clients
      from sales where shop_id = ${shopId}::uuid and business_date = ${day}::date and status in ('paid', 'refunded', 'partially_refunded')
    ),
    nc as (
      select count(distinct x.customer_id)::int n from sales x
      where x.shop_id = ${shopId}::uuid and x.business_date = ${day}::date and x.status in ('paid', 'refunded', 'partially_refunded') and x.customer_id is not null
        and not exists (select 1 from sales y where y.customer_id = x.customer_id and y.status in ('paid', 'refunded', 'partially_refunded') and y.business_date < ${day}::date)
    ),
    r as (
      select coalesce(sum(service_net_cents + product_net_cents), 0)::bigint refund from refunds
      where shop_id = ${shopId}::uuid and business_date = ${day}::date and kind = 'refund'
    ),
    a as (
      select count(*) filter (where a.status <> 'cancelled')::int appts, count(*) filter (where a.status = 'no_show')::int no_shows
      from appointments a, sh
      where a.shop_id = sh.id and a.starts_at >= (${day}::date::timestamp at time zone sh.timezone) and a.starts_at < ((${day}::date + 1)::timestamp at time zone sh.timezone)
    )
    insert into location_daily_stats (shop_id, day, owner_entity_id, region_id, tickets, gross_cents, discount_cents, service_net_cents, product_net_cents, refund_cents, tax_cents, tip_cents, clients, new_clients, appointments, no_shows, computed_at)
    select sh.id, ${day}::date, (select owner_entity_id from own), sh.region_id, s.tickets, s.gross, s.disc, s.sn, s.pn, r.refund, s.tax, s.tips, s.clients, nc.n, a.appts, a.no_shows, now()
    from sh, s, nc, r, a
    on conflict (shop_id, day) do update set owner_entity_id = excluded.owner_entity_id, region_id = excluded.region_id, tickets = excluded.tickets,
      gross_cents = excluded.gross_cents, discount_cents = excluded.discount_cents, service_net_cents = excluded.service_net_cents,
      product_net_cents = excluded.product_net_cents, refund_cents = excluded.refund_cents, tax_cents = excluded.tax_cents, tip_cents = excluded.tip_cents,
      clients = excluded.clients, new_clients = excluded.new_clients, appointments = excluded.appointments, no_shows = excluded.no_shows, computed_at = now()`);
}

/** Queues rollups for every location over past days, e.g. after go-live or an import. */
export async function backfillRollups(from: string, to: string) {
  const shopIds = ((await db.execute(sql`select id::text id from shops where status <> 'archived'`)) as unknown as { id: string }[]).map((s) => s.id);
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) n += await enqueue("rollup", shopIds, d);
  return n;
}

/** A task's work. `again`: it stopped at its time limit with work left, so it goes back in the queue without counting as a failed attempt. */
async function execute(t: JobTask, now: Date, budgetMs: number): Promise<{ result: Record<string, unknown>; again?: boolean }> {
  if (t.kind === "rollup") {
    await computeDailyStats(t.shard, t.runOn);
    return { result: { day: t.runOn } };
  }
  if (t.kind === "triggers") {
    const [shopId] = t.shard.split("|");
    return { result: { ...(await runTriggers(now, { shopIds: [shopId] })) } };
  }
  const [k, of] = t.shard.split("/").map(Number);
  const r = await runBadgeJob(now, { bucket: { k, of }, budgetMs: Math.max(5_000, Math.min(budgetMs, LEASE_MS - 30_000)) });
  return { result: r, again: r.remaining > 0 };
}

export interface JobRun {
  enqueued: number;
  done: number;
  failed: number;
  remaining: number;
}

/** Queues what's due and works through tasks until the time is up. */
export async function runJobs(now = new Date(), o: { kinds?: readonly JobKind[]; budgetMs?: number } = {}): Promise<JobRun> {
  const kinds = o.kinds ?? JOB_KINDS;
  const budget = o.budgetMs ?? 240_000;
  const started = Date.now();
  const out: JobRun = { enqueued: await enqueueDue(now, kinds), done: 0, failed: 0, remaining: 0 };
  while (Date.now() - started < budget) {
    const t = await claim(now, kinds);
    if (!t) break;
    try {
      const r = await execute(t, now, budget - (Date.now() - started));
      await finish(t, r.again ? "again" : "done", r.result, null);
      if (!r.again) out.done++;
    } catch (e) {
      await finish(t, "error", null, e instanceof Error ? e.message.slice(0, 500) : String(e));
      out.failed++;
    }
  }
  const [r] = (await db.execute(sql`
    select count(*)::int n from job_tasks where kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}) and status in ('queued', 'running') and attempts < ${MAX_ATTEMPTS}`)) as unknown as { n: number }[];
  out.remaining = Number(r?.n ?? 0);
  return out;
}

/** Old finished tasks go after two weeks; failed ones stay until someone looks. */
export async function pruneJobs(now = new Date()) {
  await db.execute(sql`delete from job_tasks where status = 'done' and run_on < ${addDays(todayLocal(now), -14)}::date`);
}
