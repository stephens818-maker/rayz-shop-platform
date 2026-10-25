import "server-only";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { type DBorTx, db } from "@/db";
import { brandSettings, marketingTemplates, notificationJobs, staff, staffMilestoneBaselines, staffMilestoneRules, staffMilestones, staffShops } from "@/db/schema";
import {
  BEST_METRICS,
  BUILT_IN_RULES,
  MILESTONE_TEMPLATE,
  type BestMetric,
  COUNT_METRICS,
  type CountMetric,
  MIN_REBOOK_VISITS,
  type MilestoneKind,
  type MilestoneSettings,
  NOTIFY_DAYS,
  PACE_DAYS,
  type PeriodValue,
  type RuleLike,
  type StreakEvent,
  type StreakMetric,
  type Upcoming,
  anniversaryDate,
  bestIsNews,
  bestRecord,
  birthdayIn,
  cleanThresholds,
  eventIndexFor,
  milestoneSettings,
  milestoneTitle,
  monthEnd,
  paceDate,
  recordedSentence,
  ruleUnit,
  streakHits,
} from "@/domain/milestones";
import { weekStartOf } from "@/domain/payroll/overtime";
import { appBaseUrl } from "@/lib/deployment";
import { LocalDate, SHOP_TZ, addDays, diffDays, formatDate, todayLocal } from "@/lib/time";
import { recordEvent } from "../analytics";
import { SYSTEM, audit } from "../audit";
import { type StaffAccess, loadStaffAccess } from "../auth/access";
import { processDueJobs } from "../notifications/queue";
import { rows, uuids } from "../report-sql";

export async function loadMilestoneSettings(): Promise<MilestoneSettings> {
  const [b] = await db.select({ m: brandSettings.milestones }).from(brandSettings).limit(1);
  return milestoneSettings(b?.m);
}

/**
 * Puts back the built-in milestones and the celebrate template when they're missing, e.g. after a
 * reset that truncated staff (both reference it). A built-in the brand turned off stays off.
 */
export async function ensureMilestoneDefaults() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('milestones:defaults'))`);
    await tx
      .insert(staffMilestoneRules)
      .values(BUILT_IN_RULES.map((r) => ({ ...r, thresholds: [...r.thresholds], builtIn: true })))
      .onConflictDoNothing({ target: staffMilestoneRules.key });
    const [t] = await tx.select({ id: marketingTemplates.id }).from(marketingTemplates).where(eq(marketingTemplates.purpose, "milestone")).limit(1);
    if (!t) await tx.insert(marketingTemplates).values({ ...MILESTONE_TEMPLATE, templates: { ...MILESTONE_TEMPLATE.templates }, channels: ["sms", "email", "push"], status: "approved", approvedAt: new Date(), purpose: "milestone" });
  });
}

export async function loadRules(o: { activeOnly?: boolean } = {}): Promise<RuleLike[]> {
  const read = () => db.select().from(staffMilestoneRules).orderBy(asc(staffMilestoneRules.sortOrder), asc(staffMilestoneRules.name));
  let list = await read();
  if (!list.some((r) => r.builtIn)) {
    await ensureMilestoneDefaults();
    list = await read();
  }
  return list.filter((r) => !o.activeOnly || r.active).map((r) => ({ ...r, thresholds: cleanThresholds(r.thresholds ?? []), serviceIds: r.serviceIds ?? [] }));
}

export interface Person {
  id: string;
  firstName: string;
  label: string;
  hireDate: LocalDate | null;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  shared: boolean;
  workShops: string[];
}

/** Active people (not shop logins) with the shops they work at. */
export async function people(ids?: readonly string[]): Promise<Person[]> {
  if (ids && !ids.length) return [];
  const list = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      label: staff.displayLabel,
      hireDate: staff.hireDate,
      birthdayMonth: staff.birthdayMonth,
      birthdayDay: staff.birthdayDay,
      shared: staff.milestonesShared,
      shops: sql<string[]>`coalesce((select array_agg(ss.shop_id::text order by ss.is_primary desc, ss.shop_id) from staff_shops ss where ss.staff_id = ${staff.id}), '{}')`,
    })
    .from(staff)
    .where(and(eq(staff.kind, "person"), eq(staff.active, true), isNull(staff.removedAt), ids ? inArray(staff.id, [...ids]) : undefined))
    .orderBy(asc(staff.displayLabel));
  return list.map(({ shops, ...p }) => ({ ...p, workShops: shops ?? [] }));
}

// ───────────────────────────── Counting ─────────────────────────────

const TZ = sql.raw(`'${SHOP_TZ}'`);
const localDay = (col: SQL) => sql`(${col} at time zone ${TZ})::date`;

/** One row per thing counted: who gets it, when, the shop and how many (products count each unit). */
function eventsSql(metric: CountMetric, serviceIds: readonly string[], now: Date): SQL {
  const at = now.toISOString();
  const done = sql`a.status = 'completed' and a.starts_at <= ${at}`;
  const pick = sql`a.staff_id, a.starts_at at_, ${localDay(sql`a.starts_at`)} day_, a.shop_id, 1 w`;
  switch (metric) {
    case "services":
      return sql`select ${pick} from appointments a where ${done}${
        serviceIds.length ? sql` and exists (select 1 from appointment_items i where i.appointment_id = a.id and i.service_id in ${uuids([...serviceIds])})` : sql``
      }`;
    case "clients":
      return sql`select distinct on (a.staff_id, a.customer_id) ${pick} from appointments a where ${done} and a.customer_id is not null order by a.staff_id, a.customer_id, a.starts_at`;
    case "new_clients":
      return sql`select distinct on (a.customer_id) ${pick} from appointments a where ${done} and a.customer_id is not null order by a.customer_id, a.starts_at`;
    case "rebooks":
      return sql`select ${pick} from appointments a where ${done} and a.customer_id is not null and a.booked_at_known and exists (
        select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.booked_at_known and b.starts_at > a.starts_at
          and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours')`;
    case "products":
      return sql`select coalesce(si.staff_id, s.staff_id) staff_id, coalesce(s.paid_at, s.created_at) at_, s.business_date day_, s.shop_id, (si.qty - si.refunded_qty) w
        from sale_items si join sales s on s.id = si.sale_id
        where si.kind = 'product' and s.status in ('paid', 'partially_refunded') and si.qty > si.refunded_qty and coalesce(si.staff_id, s.staff_id) is not null`;
  }
}

/** The counted rows on or after each person's baseline date (the baseline counts what came before). */
function countedSql(metric: CountMetric, serviceIds: readonly string[], useBaseline: boolean, staffIds: readonly string[], now: Date) {
  return sql`select ev.* from (${eventsSql(metric, serviceIds, now)}) ev
    ${useBaseline ? sql`left join staff_milestone_baselines bl on bl.staff_id = ev.staff_id and bl.metric = ${metric}` : sql``}
    where ev.staff_id in ${uuids([...staffIds])} ${useBaseline ? sql`and (bl.as_of is null or ev.day_ >= bl.as_of)` : sql``}`;
}

/** Baselines apply to a built-in metric counted in full, not to a rule that counts only some services. */
const usesBaseline = (r: Pick<RuleLike, "serviceIds">) => r.serviceIds.length === 0;

export async function baselines(staffIds?: readonly string[]) {
  const list = await db
    .select()
    .from(staffMilestoneBaselines)
    .where(staffIds ? inArray(staffMilestoneBaselines.staffId, staffIds.length ? [...staffIds] : ["00000000-0000-0000-0000-000000000000"]) : undefined);
  return new Map(list.map((b) => [`${b.staffId}|${b.metric}`, { count: b.count, asOf: b.asOf }]));
}

export interface CountTotal {
  total: number;
  /** In the last PACE_DAYS days, for the pace estimate. */
  recent: number;
  /** Booked for later today (cuts and services only). */
  laterToday: number;
}

/** Each person's total for a count rule: their baseline plus what's counted since. */
export async function countTotals(rule: Pick<RuleLike, "metric" | "serviceIds">, staffIds: readonly string[], now: Date): Promise<Map<string, CountTotal>> {
  const out = new Map<string, CountTotal>();
  if (!staffIds.length) return out;
  const metric = rule.metric as CountMetric;
  const base = usesBaseline(rule);
  const today = todayLocal(now);
  const got = await rows<{ staff_id: string; total: number; recent: number }>(sql`
    select staff_id, coalesce(sum(w), 0)::int total, coalesce(sum(w) filter (where day_ >= ${addDays(today, -PACE_DAYS)} and day_ < ${today}), 0)::int recent
    from (${countedSql(metric, rule.serviceIds, base, staffIds, now)}) c group by 1`);
  const bl = base ? await baselines(staffIds) : new Map();
  for (const id of staffIds) {
    const r = got.find((g) => g.staff_id === id);
    out.set(id, { total: (r?.total ?? 0) + (bl.get(`${id}|${metric}`)?.count ?? 0), recent: r?.recent ?? 0, laterToday: 0 });
  }
  if (metric === "services") {
    const later = await rows<{ staff_id: string; n: number }>(sql`
      select a.staff_id, count(*)::int n from appointments a
      where a.staff_id in ${uuids([...staffIds])} and a.status in ('booked', 'confirmed', 'checked_in', 'in_service')
        and ${localDay(sql`a.starts_at`)} = ${today}
        ${rule.serviceIds.length ? sql`and exists (select 1 from appointment_items i where i.appointment_id = a.id and i.service_id in ${uuids([...rule.serviceIds])})` : sql``}
      group by 1`);
    for (const l of later) {
      const t = out.get(l.staff_id);
      if (t) t.laterToday = l.n;
    }
  }
  return out;
}

/** The day and shop of each person's Nth counted row. */
async function nthEvents(rule: RuleLike, wanted: { key: string; staffId: string; n: number }[], now: Date) {
  const found = new Map<string, { day: LocalDate; shopId: string | null }>();
  if (!wanted.length) return found;
  const staffIds = [...new Set(wanted.map((w) => w.staffId))];
  const list = sql.join(
    wanted.map((w) => sql`(${w.key}, ${w.staffId}::uuid, ${w.n}::int)`),
    sql`, `,
  );
  const got = await rows<{ k: string; day: string; shop_id: string | null }>(sql`
    with r as materialized (
      select staff_id, day_, shop_id, sum(w) over (partition by staff_id order by at_, day_ rows unbounded preceding) cum
      from (${countedSql(rule.metric as CountMetric, rule.serviceIds, usesBaseline(rule), staffIds, now)}) c
    )
    select p.k, x.day_::text as "day", x.shop_id from (values ${list}) p(k, staff_id, n)
    cross join lateral (select r.day_, r.shop_id from r where r.staff_id = p.staff_id and r.cum >= p.n order by r.cum limit 1) x`);
  for (const g of got) found.set(g.k, { day: g.day, shopId: g.shop_id });
  return found;
}

// ───────────────────────────── Personal bests ─────────────────────────────

const SALES_NET = sql`(si.net_cents::numeric * (si.qty - si.refunded_qty) / nullif(si.qty, 0))`;

/** Each person's value per closed period, for a personal best. */
export async function bestSeries(metric: BestMetric, staffIds: readonly string[], today: LocalDate): Promise<Map<string, PeriodValue[]>> {
  const out = new Map<string, PeriodValue[]>();
  if (!staffIds.length) return out;
  const who = uuids([...staffIds]);
  const thisWeek = weekStartOf(today);
  const thisMonth = `${today.slice(0, 7)}-01`;
  let q: SQL;
  if (metric === "sales_day" || metric === "sales_week" || metric === "sales_month") {
    const period =
      metric === "sales_day"
        ? sql`s.business_date::text`
        : metric === "sales_week"
          ? sql`(s.business_date - extract(dow from s.business_date)::int)::text`
          : sql`to_char(s.business_date, 'YYYY-MM')`;
    const before = metric === "sales_day" ? today : metric === "sales_week" ? thisWeek : thisMonth;
    q = sql`select coalesce(si.staff_id, s.staff_id) staff_id, ${period} period, round(sum(${SALES_NET}))::bigint v, mode() within group (order by s.shop_id) shop_id
      from sale_items si join sales s on s.id = si.sale_id
      where si.kind in ('service', 'addon', 'product') and s.status in ('paid', 'partially_refunded') and s.business_date < ${before}
        and coalesce(si.staff_id, s.staff_id) in ${who}
      group by 1, 2 having round(sum(${SALES_NET})) > 0`;
  } else if (metric === "cuts_day") {
    q = sql`select a.staff_id, ${localDay(sql`a.starts_at`)}::text period, count(*)::bigint v, mode() within group (order by a.shop_id) shop_id
      from appointments a where a.status = 'completed' and a.staff_id in ${who} and ${localDay(sql`a.starts_at`)} < ${today}
      group by 1, 2`;
  } else {
    q = sql`select a.staff_id, to_char(${localDay(sql`a.starts_at`)}, 'YYYY-MM') period,
        round(1000.0 * count(*) filter (where exists (
          select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.booked_at_known and b.starts_at > a.starts_at
            and b.created_at between a.starts_at and coalesce(a.completed_at, a.ends_at) + interval '24 hours')) / count(*))::bigint v,
        mode() within group (order by a.shop_id) shop_id
      from appointments a where a.status = 'completed' and a.customer_id is not null and a.booked_at_known and a.staff_id in ${who}
        and ${localDay(sql`a.starts_at`)} < ${thisMonth}
      group by 1, 2 having count(*) >= ${MIN_REBOOK_VISITS}`;
  }
  const got = await rows<{ staff_id: string; period: string; v: string | number; shop_id: string | null }>(q);
  for (const g of got) {
    const end = metric === "sales_week" ? addDays(g.period, 6) : metric === "sales_month" || metric === "rebook_month" ? monthEnd(g.period) : g.period;
    const list = out.get(g.staff_id) ?? [];
    list.push({ period: g.period, end, value: Number(g.v), shopId: g.shop_id });
    out.set(g.staff_id, list);
  }
  return out;
}

// ───────────────────────────── Streaks ─────────────────────────────

/** Each person's events in order: a 5-star answer or not, an on-time start or not. */
export async function streakEvents(metric: StreakMetric, staffIds: readonly string[]): Promise<Map<string, StreakEvent[]>> {
  const out = new Map<string, StreakEvent[]>();
  if (!staffIds.length) return out;
  const who = uuids([...staffIds]);
  const got =
    metric === "five_star"
      ? await rows<{ staff_id: string; id: string; day: string; shop_id: string | null; ok: boolean }>(sql`
          select v.staff_id, v.id::text id, ${localDay(sql`v.created_at`)}::text as "day", v.shop_id, v.stars = 5 ok
          from visit_satisfaction v where v.staff_id in ${who} order by v.staff_id, v.created_at, v.id`)
      : await rows<{ staff_id: string; id: string; day: string; shop_id: string | null; ok: boolean }>(sql`
          select a.staff_id, a.id::text id, ${localDay(sql`a.starts_at`)}::text as "day", a.shop_id, t.started_at <= a.starts_at + interval '5 minutes' ok
          from appointments a join appointment_times t on t.appointment_id = a.id
          where a.staff_id in ${who} and a.status = 'completed' and a.source <> 'walk_in' and t.started_at is not null
          order by a.staff_id, a.starts_at, a.id`);
  for (const g of got) {
    const list = out.get(g.staff_id) ?? [];
    list.push({ id: g.id, day: g.day, shopId: g.shop_id, ok: g.ok });
    out.set(g.staff_id, list);
  }
  return out;
}

// ───────────────────────────── Finding milestones ─────────────────────────────

export interface Found {
  staffId: string;
  ruleId: string;
  kind: MilestoneKind;
  metric: string;
  threshold: number | null;
  value: number | null;
  previous: number | null;
  period: string | null;
  achievedOn: LocalDate;
  shopId: string | null;
  title: string;
  silent: boolean;
  dedupeKey: string;
}

const isOld = (day: LocalDate, today: LocalDate) => diffDays(today, day) > NOTIFY_DAYS;

/**
 * Every milestone reached so far that isn't recorded yet. Those reached more than NOTIFY_DAYS ago
 * (history, a new hire date, a Squire baseline) are silent: kept for the trophy case, never announced.
 */
export async function findMilestones(now: Date, o: { staffIds?: string[] } = {}): Promise<Found[]> {
  const settings = await loadMilestoneSettings();
  if (!settings.enabled) return [];
  const today = todayLocal(now);
  const [rules, team, have] = await Promise.all([
    loadRules({ activeOnly: true }),
    people(o.staffIds),
    db.select({ k: staffMilestones.dedupeKey }).from(staffMilestones).then((r) => new Set(r.map((x) => x.k))),
  ]);
  if (!team.length) return [];
  const ids = team.map((p) => p.id);
  const home = new Map(team.map((p) => [p.id, p.workShops[0] ?? null]));
  const out: Found[] = [];
  const add = (f: Found) => {
    if (have.has(f.dedupeKey)) return;
    have.add(f.dedupeKey);
    out.push(f);
  };

  for (const rule of rules) {
    const facts = { kind: rule.kind, metric: rule.metric };
    const unit = ruleUnit(rule);
    if (rule.kind === "count" && (COUNT_METRICS as readonly string[]).includes(rule.metric)) {
      const totals = await countTotals(rule, ids, now);
      const bl = usesBaseline(rule) ? await baselines(ids) : new Map<string, { count: number; asOf: LocalDate }>();
      const wanted: { key: string; staffId: string; n: number; threshold: number }[] = [];
      for (const id of ids) {
        const total = totals.get(id)?.total ?? 0;
        for (const t of rule.thresholds.filter((x) => x <= total)) {
          const key = `count:${rule.id}:${id}:${t}`;
          if (have.has(key)) continue;
          const b = bl.get(`${id}|${rule.metric}`) ?? null;
          const n = eventIndexFor(t, b);
          if (n <= 0) add({ staffId: id, ruleId: rule.id, ...facts, threshold: t, value: t, previous: null, period: null, achievedOn: b!.asOf, shopId: home.get(id) ?? null, title: milestoneTitle({ ...facts, unit, threshold: t, value: t }), silent: true, dedupeKey: key });
          else wanted.push({ key, staffId: id, n, threshold: t });
        }
      }
      const at = await nthEvents(rule, wanted, now);
      for (const w of wanted) {
        const hit = at.get(w.key);
        if (!hit) continue;
        add({ staffId: w.staffId, ruleId: rule.id, ...facts, threshold: w.threshold, value: w.threshold, previous: null, period: null, achievedOn: hit.day, shopId: hit.shopId, title: milestoneTitle({ ...facts, unit, threshold: w.threshold, value: w.threshold }), silent: isOld(hit.day, today), dedupeKey: w.key });
      }
    } else if (rule.kind === "anniversary") {
      for (const p of team) {
        if (!p.hireDate) continue;
        for (const t of rule.thresholds) {
          const on = anniversaryDate(p.hireDate, t);
          if (on > today) continue;
          add({ staffId: p.id, ruleId: rule.id, ...facts, threshold: t, value: t, previous: null, period: null, achievedOn: on, shopId: home.get(p.id) ?? null, title: milestoneTitle({ ...facts, unit, threshold: t, value: t }), silent: isOld(on, today), dedupeKey: `anniversary:${rule.id}:${p.id}:${t}` });
        }
      }
    } else if (rule.kind === "birthday") {
      if (!settings.birthdays) continue;
      const year = Number(today.slice(0, 4));
      for (const p of team) {
        if (!p.birthdayMonth || !p.birthdayDay) continue;
        const on = birthdayIn(year, p.birthdayMonth, p.birthdayDay);
        if (on > today) continue;
        add({ staffId: p.id, ruleId: rule.id, ...facts, threshold: null, value: null, previous: null, period: String(year), achievedOn: on, shopId: home.get(p.id) ?? null, title: "Birthday", silent: isOld(on, today), dedupeKey: `birthday:${p.id}:${year}` });
      }
    } else if (rule.kind === "best" && (BEST_METRICS as readonly string[]).includes(rule.metric)) {
      const metric = rule.metric as BestMetric;
      const series = await bestSeries(metric, ids, today);
      for (const [id, list] of series) {
        const r = bestRecord(list);
        if (!r) continue;
        const f = { ...facts, threshold: null, value: r.value };
        add({ staffId: id, ruleId: rule.id, ...f, previous: r.previous, period: r.period, achievedOn: r.end, shopId: r.shopId, title: milestoneTitle(f), silent: !bestIsNews(r, metric, today), dedupeKey: `best:${rule.id}:${id}:${r.period}` });
      }
    } else if (rule.kind === "streak") {
      const events = await streakEvents(rule.metric as StreakMetric, ids);
      for (const [id, list] of events) {
        for (const h of streakHits(list, rule.thresholds).hits) {
          const f = { ...facts, threshold: h.threshold, value: h.threshold };
          add({ staffId: id, ruleId: rule.id, ...f, previous: null, period: null, achievedOn: h.day, shopId: h.shopId, title: milestoneTitle({ ...f, unit }), silent: isOld(h.day, today), dedupeKey: `streak:${rule.id}:${id}:${h.threshold}` });
        }
      }
    }
  }
  return out;
}

// ───────────────────────────── Recording and alerts ─────────────────────────────

/** Who hears about a milestone: the brand, and the managers of the shops the person works at. Never the person themselves. */
export function alertAudience(a: Pick<StaffAccess, "staffId" | "scope" | "permissions" | "byShop">, subject: Pick<Person, "id" | "workShops">, s: MilestoneSettings) {
  if (a.staffId === subject.id) return null;
  if (a.scope === "all") return s.alertBrand && a.permissions.has("milestones.view") ? "brand" : null;
  if (!s.alertManagers) return null;
  return subject.workShops.some((id) => a.byShop.get(id)?.permissions.has("milestones.view")) ? "manager" : null;
}

type Recorded = typeof staffMilestones.$inferSelect;

async function queueAlerts(list: Recorded[], team: Person[], s: MilestoneSettings, now: Date, tx: DBorTx) {
  if (!list.length || (!s.alertBrand && !s.alertManagers)) return [];
  const recipients = await db
    .select({ id: staff.id, firstName: staff.firstName, email: staff.email })
    .from(staff)
    .where(and(eq(staff.kind, "person"), eq(staff.active, true), isNull(staff.removedAt), sql`${staff.email} is not null`));
  const byId = new Map(team.map((p) => [p.id, p]));
  const shopNames = new Map((await rows<{ id: string; name: string }>(sql`select id::text id, name from shops`)).map((x) => [x.id, x.name]));
  const jobs: string[] = [];
  for (const r of recipients) {
    const access = await loadStaffAccess(r.id);
    if (!access) continue;
    const mine = list.filter((m) => {
      const p = byId.get(m.staffId);
      return p && alertAudience(access, p, s);
    });
    if (!mine.length) continue;
    const lines = mine.map((m) => {
      const p = byId.get(m.staffId)!;
      const where = [m.shopId ? shopNames.get(m.shopId) : null, formatDate(m.achievedOn, "EEE MMM d")].filter(Boolean).join(", ");
      return `- ${recordedSentence(p.label, m)}${where ? ` (${where})` : ""}`;
    });
    const first = recordedSentence(byId.get(mine[0].staffId)!.label, mine[0]);
    const subject = mine.length === 1 ? `Milestone: ${first}` : `${mine.length} staff milestones: ${first} and ${mine.length - 1} more`;
    const body = [
      `Hi ${r.firstName},`,
      "",
      "Worth a shout-out:",
      "",
      ...lines,
      "",
      `See what's coming up: ${appBaseUrl()}/admin/milestones`,
      "",
      "You get these because you see staff milestones at their shops. The brand chooses who's told under Setup → Staff milestones.",
    ].join("\n");
    const [job] = await tx.insert(notificationJobs).values({ kind: "milestone", channel: "email", to: r.email!, subject, body, runAt: now }).returning({ id: notificationJobs.id });
    jobs.push(job.id);
  }
  return jobs;
}

/**
 * The hourly job: records every milestone reached, logs each in the event log, and emails the brand
 * and the person's managers about the new ones (not silent). Each milestone is recorded once, so a
 * repeated or overlapping run adds and sends nothing.
 */
export async function runMilestones(now: Date = new Date(), o: { staffIds?: string[]; send?: boolean } = {}) {
  const s = await loadMilestoneSettings();
  if (!s.enabled) return { recorded: 0, announced: 0, emails: 0 };
  const found = await findMilestones(now, o);
  const inserted: Recorded[] = [];
  for (let i = 0; i < found.length; i += 500) {
    const chunk = found.slice(i, i + 500);
    await db.transaction(async (tx) => {
      const got = await tx.insert(staffMilestones).values(chunk).onConflictDoNothing({ target: staffMilestones.dedupeKey }).returning();
      for (const m of got) {
        await recordEvent(
          {
            event: "milestone.achieved",
            at: new Date(Math.min(now.getTime(), Date.parse(`${m.achievedOn}T17:00:00Z`))),
            key: `milestone:${m.id}`,
            shop: m.shopId ?? undefined,
            staff: m.staffId,
            actorKind: "system",
            entity: "staff_milestone",
            entityId: m.id,
            value: m.kind === "best" ? (m.value ?? undefined) : (m.threshold ?? undefined),
            subtype: m.kind,
            props: m.silent ? { metric: m.metric, silent: true } : { metric: m.metric },
          },
          tx,
        );
      }
      inserted.push(...got);
    });
  }
  // New ones, and any an earlier run recorded but couldn't announce.
  const news = await db
    .select()
    .from(staffMilestones)
    .where(
      and(
        eq(staffMilestones.silent, false),
        isNull(staffMilestones.notifiedAt),
        sql`${staffMilestones.achievedOn} >= ${addDays(todayLocal(now), -NOTIFY_DAYS)}`,
        o.staffIds ? inArray(staffMilestones.staffId, o.staffIds.length ? o.staffIds : ["00000000-0000-0000-0000-000000000000"]) : undefined,
      ),
    );
  let jobs: string[] = [];
  if (news.length) {
    const team = await people([...new Set(news.map((m) => m.staffId))]);
    jobs = await db.transaction(async (tx) => {
      const ids = await queueAlerts(news, team, s, now, tx);
      await tx
        .update(staffMilestones)
        .set({ notifiedAt: now })
        .where(
          inArray(
            staffMilestones.id,
            news.map((m) => m.id),
          ),
        );
      await audit(SYSTEM, "milestones.announced", "staff_milestone", null, { milestones: news.map((m) => ({ id: m.id, staffId: m.staffId, title: m.title })), emails: ids.length }, null, tx);
      return ids;
    });
    if (o.send !== false && jobs.length) await processDueJobs({ ids: jobs, now });
  }
  return { recorded: inserted.length, announced: news.length, emails: jobs.length };
}

// ───────────────────────────── Coming up ─────────────────────────────

/**
 * What these people should reach in the next `horizon` days: cuts booked for later today that
 * cross a threshold, anniversaries and birthdays on their date, and other counts at their pace.
 */
export async function upcomingFor(team: Person[], now: Date, horizon: number, s?: MilestoneSettings): Promise<Upcoming[]> {
  const settings = s ?? (await loadMilestoneSettings());
  if (!settings.enabled || !team.length) return [];
  const today = todayLocal(now);
  const rules = await loadRules({ activeOnly: true });
  const ids = team.map((p) => p.id);
  const out: Upcoming[] = [];
  for (const rule of rules) {
    const facts = { kind: rule.kind, metric: rule.metric, unit: ruleUnit(rule), value: null };
    if (rule.kind === "count") {
      const totals = await countTotals(rule, ids, now);
      for (const id of ids) {
        const t = totals.get(id);
        if (!t) continue;
        const next = rule.thresholds.find((x) => x > t.total);
        if (!next) continue;
        if (t.laterToday && t.total + t.laterToday >= next) out.push({ ...facts, staffId: id, threshold: next, on: today, sure: true, left: next - t.total });
        else {
          const on = paceDate(t.total, next, t.recent / PACE_DAYS, today, horizon);
          if (on) out.push({ ...facts, staffId: id, threshold: next, on, sure: false, left: next - t.total });
        }
      }
    } else if (rule.kind === "anniversary") {
      for (const p of team) {
        if (!p.hireDate) continue;
        for (const y of rule.thresholds) {
          const on = anniversaryDate(p.hireDate, y);
          if (on > today && diffDays(on, today) <= horizon) out.push({ ...facts, staffId: p.id, threshold: y, on, sure: true, left: null });
        }
      }
    } else if (rule.kind === "birthday" && settings.birthdays) {
      const year = Number(today.slice(0, 4));
      for (const p of team) {
        if (!p.birthdayMonth || !p.birthdayDay) continue;
        const on = [birthdayIn(year, p.birthdayMonth, p.birthdayDay), birthdayIn(year + 1, p.birthdayMonth, p.birthdayDay)].find((d) => d > today);
        if (on && diffDays(on, today) <= horizon) out.push({ ...facts, staffId: p.id, threshold: null, on, sure: true, left: null });
      }
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on) || Number(b.sure) - Number(a.sure));
}

/** Staff working at these shops. */
export async function teamAt(shopIds: readonly string[]) {
  if (!shopIds.length) return [];
  const ids = await db
    .selectDistinct({ id: staffShops.staffId })
    .from(staffShops)
    .where(inArray(staffShops.shopId, [...shopIds]));
  return people(ids.map((x) => x.id));
}
