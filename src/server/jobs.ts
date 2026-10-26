import "server-only";
import { sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import type { JobTaskStatus } from "@/db/schema";
import { addDays, todayLocal, toZoned } from "@/lib/time";
import { runBadgeJob } from "./badges";
import { runFollowUps } from "./call-ins";
import { sendDueRebookReminders } from "./checkout-prompts";
import { STALE_SENDING_MS, runBlasts, runSequences, runTriggers } from "./marketing/engine";
import { dueReports, sendReport } from "./report-builder/deliver";
import { queueReviewFollowUps } from "./reviews";
import { computeDailyStats } from "./rollups";
import { buildDuePayout, duePayouts } from "./tips/payouts";

/**
 * Background work that grows with the number of locations, split into small tasks in job_tasks:
 *  - rollup: one location's day into location_daily_stats (the brand's comparison reports);
 *  - triggers: one location's automated campaigns for a 15-minute slot;
 *  - badges: one slice of the client file (BADGE_BUCKETS of them) for the day;
 *  - campaigns: one blast that's due (by its send time), or one sequence for a 15-minute slot;
 *  - reports: one scheduled custom report's period, to each of its recipients;
 *  - nudges: one location's rebook reminders, review asks and call-in follow-ups for a 5-minute slot;
 *  - payouts: one location's daily or weekly tip payout draft, on the day it's due.
 * Each cron run (or the local worker) queues what's due, then claims tasks one at a time with
 * FOR UPDATE SKIP LOCKED until its time is up, so any number of runs share the work without
 * overlapping. A claimed task holds a lease; if its run dies, the lease runs out and another run
 * picks it up. A task that fails MAX_ATTEMPTS times stays failed for someone to look at.
 */

export const JOB_KINDS = ["rollup", "triggers", "badges", "campaigns", "reports", "nudges", "payouts"] as const;
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

/** The slot a time falls in, in shop time: "14:30" for 15 minutes. */
export function triggerSlot(now: Date, minutes = 15): string {
  const t = toZoned(now);
  return `${String(t.hour).padStart(2, "0")}:${String(Math.floor(t.minute / minutes) * minutes).padStart(2, "0")}`;
}

/** Nudges run every 5 minutes, as often as the notifications cron. */
export const NUDGE_SLOT_MINUTES = 5;

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
  if (kinds.includes("campaigns")) {
    const slot = triggerSlot(now);
    const stale = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
    const due = (await db.execute(sql`
      select id::text id, kind, coalesce(to_char(updated_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'), '') at from marketing_campaigns
      where (kind = 'blast' and scheduled_at <= ${now.toISOString()}::timestamptz and (status = 'scheduled' or (status = 'sending' and updated_at <= ${stale}::timestamptz)))
        or (kind = 'sequence' and enabled)
      order by id`)) as unknown as { id: string; kind: string; at: string }[];
    // A blast's shard carries its last change, so a send that stalled is queued again.
    n += await enqueue("campaigns", due.map((c) => (c.kind === "blast" ? `blast:${c.id}|${c.at}` : `sequence:${c.id}|${slot}`)), today);
  }
  if (kinds.includes("reports")) n += await enqueue("reports", (await dueReports(now)).map((r) => `${r.id}|${r.period}`), today);
  if (kinds.includes("nudges")) {
    const slot = triggerSlot(now, NUDGE_SLOT_MINUTES);
    n += await enqueue("nudges", (await shopsWhere(["live"])).map((s) => `${s.id}|${slot}`), today);
  }
  if (kinds.includes("payouts")) n += await enqueue("payouts", (await duePayouts(now)).map((d) => `${d.shopId}|${d.kind}|${d.cutoff}`), today);
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
  if (t.kind === "campaigns") {
    const [what, id] = t.shard.split("|")[0].split(":");
    return { result: { ...(what === "blast" ? await runBlasts(now, { ids: [id] }) : await runSequences(now, { ids: [id] })) } };
  }
  if (t.kind === "reports") {
    const [id, period] = t.shard.split("|");
    return { result: await sendReport(id, period, now) };
  }
  if (t.kind === "nudges") {
    const shopIds = [t.shard.split("|")[0]];
    const [rebook, reviews, followUps] = [await sendDueRebookReminders(now, 200, shopIds), await queueReviewFollowUps(now, { shopIds }), await runFollowUps(now, { shopIds })];
    return { result: { rebook, reviews, followUps } };
  }
  if (t.kind === "payouts") {
    const [shopId, kind, cutoff] = t.shard.split("|");
    return { result: { built: await buildDuePayout({ shopId, kind: kind as "daily_delay" | "weekly", cutoff }, now) } };
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

/** Old finished tasks go after two weeks (the many-a-day kinds after two days); failed ones stay until someone looks. */
export async function pruneJobs(now = new Date()) {
  await db.execute(sql`delete from job_tasks where status = 'done' and run_on < ${addDays(todayLocal(now), -14)}::date`);
  await db.execute(sql`delete from job_tasks where status = 'done' and kind in ('triggers', 'nudges', 'campaigns') and run_on < ${addDays(todayLocal(now), -2)}::date`);
}
