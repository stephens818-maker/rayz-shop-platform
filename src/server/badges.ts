import "server-only";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, customBadges } from "@/db/schema";
import {
  BadgeSettingsSchema,
  CustomBadgeSchema,
  MORNING_BADGES,
  customBadgeProblem,
  customKey,
  deriveBadges,
  showBadges,
  type BadgeFacts,
  type BadgeSettings,
  type CustomBadge,
  type ShownBadge,
  type StoredBadge,
} from "@/domain/badges";
import { segmentProblem } from "@/domain/marketing";
import { SHOP_TZ, todayLocal, type LocalDate } from "@/lib/time";
import { audit } from "./audit";
import { can, type StaffContext } from "./auth/staff";
import { listCustomBadges, loadBadgeSettings } from "./badge-settings";
import { CLIENT_FACTS, segmentConditions } from "./client-filters";
import { clientPolicy, type ClientPolicy } from "./client-privacy";
import { consentColumns } from "./marketing/consent";
import { AppError, forbidden, notFound } from "./errors";
import { ratingSummaries } from "./ratings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const UPCOMING = sql.raw("('booked', 'confirmed', 'checked_in', 'in_service')");
const PAID = sql.raw("('paid', 'partially_refunded', 'refunded')");
const TZ = sql.raw(`'${SHOP_TZ}'`);
/** Missing or stale cached badges worked out while a page waits; the nightly job does the rest. */
const READ_REFRESH_CAP = 200;
/** Settings or custom badges changed: every cached row is recomputed. */
const STALE_DAY = "2000-01-01";

/** One array parameter, so a big batch stays under the bind-parameter limit. */
const idArray = (ids: readonly string[]) => sql`${`{${ids.filter((i) => UUID.test(i)).join(",")}}`}::uuid[]`;
const rowsOf = async <T>(q: Promise<unknown>) => (await q) as unknown as T[];

// ───────────────────────────── Settings ─────────────────────────────

const markAllStale = (tx: DBorTx = db) => tx.execute(sql`update client_badges set computed_on = ${STALE_DAY}::date`);

export async function saveBadgeSettings(ctx: StaffContext, raw: unknown): Promise<BadgeSettings> {
  if (!can(ctx, "badges.settings")) throw forbidden("You can't change client badges");
  const parsed = BadgeSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Check the badge settings");
  const before = await loadBadgeSettings();
  await db.update(brandSettings).set({ badges: parsed.data, updatedAt: new Date() });
  // Thresholds decide who has which badge; on, off and roles only decide who sees them.
  if (JSON.stringify(before.thresholds) !== JSON.stringify(parsed.data.thresholds)) await markAllStale();
  await audit(ctx.actor, "settings.badges", "brand_settings", "badges", parsed.data, null);
  return parsed.data;
}

/** Creates or edits a custom badge. The filter must be one the person could run themselves. */
export async function saveCustomBadge(ctx: StaffContext, raw: unknown): Promise<string> {
  if (!can(ctx, "badges.settings")) throw forbidden("You can't change client badges");
  const parsed = CustomBadgeSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Check the badge");
  const b = parsed.data;
  const filter = { ...b.filter, shopIds: [], channel: "any" as const };
  const policy = await clientPolicy(ctx);
  const sees = {
    birthday: policy.level("birthday") !== "hidden",
    ratings: policy.level("ratings") !== "hidden",
    preferredBarber: policy.level("preferred_barber") !== "hidden",
    level: policy.level,
    money: can(ctx, "clients.view_all"),
  };
  const problem = customBadgeProblem(filter) ?? segmentProblem(filter, sees);
  if (problem) throw new AppError("bad_request", problem);
  const values = { label: b.label, tooltip: b.tooltip, icon: b.icon, tone: b.tone, filter, active: b.active, updatedAt: new Date() };
  let id = b.id;
  if (id) {
    const [row] = await db
      .update(customBadges)
      .set(values)
      .where(sql`${customBadges.id} = ${id}::uuid`)
      .returning({ id: customBadges.id });
    if (!row) throw notFound("That badge was removed");
  } else {
    const [{ n }] = await rowsOf<{ n: number }>(db.execute(sql`select count(*)::int n from custom_badges`));
    if (n >= 30) throw new AppError("bad_request", "Up to 30 custom badges");
    const [row] = await db
      .insert(customBadges)
      .values({ ...values, sortOrder: n, createdBy: ctx.staff.id })
      .returning({ id: customBadges.id });
    id = row.id;
  }
  await markAllStale();
  await audit(ctx.actor, b.id ? "badges.custom_update" : "badges.custom_create", "custom_badge", id, { label: b.label, active: b.active }, null);
  return id;
}

export async function deleteCustomBadge(ctx: StaffContext, id: string) {
  if (!can(ctx, "badges.settings")) throw forbidden("You can't change client badges");
  if (!UUID.test(id)) throw notFound("That badge was removed");
  const [row] = await db
    .delete(customBadges)
    .where(sql`${customBadges.id} = ${id}::uuid`)
    .returning({ label: customBadges.label });
  if (!row) throw notFound("That badge was removed");
  const key = customKey(id);
  await db.execute(sql`update client_badges set keys = array_remove(keys, ${key}), computed_on = ${STALE_DAY}::date where ${key} = any(keys)`);
  await audit(ctx.actor, "badges.custom_delete", "custom_badge", id, { label: row.label }, null);
}

// ───────────────────────────── Facts ─────────────────────────────

/** 12 months of net spend (service and product, less refunds) per client, for `cond` over sales `s`. */
function spendSql(today: LocalDate, cond: SQL): SQL {
  const from = sql`(${today}::date - 365)`;
  return sql`select customer_id, sum(cents)::int cents from (
      select s.customer_id, s.service_net_cents + s.product_net_cents cents from sales s
      where s.status in ${PAID} and s.customer_id is not null and s.business_date > ${from}${cond}
      union all
      select s.customer_id, -(r.service_net_cents + r.product_net_cents) from refunds r join sales s on s.id = r.sale_id
      where s.customer_id is not null and r.business_date > ${from}${cond}
    ) x group by customer_id`;
}

const vipCache = new Map<string, { at: number; cents: number | null }>();

/** The least the top spenders spent: the brand's VIP line. Read every 10 minutes at most. */
export async function vipCutoff(topPct: number, now: Date, tx: DBorTx = db): Promise<number | null> {
  const today = todayLocal(now);
  const key = `${topPct}:${today}`;
  const hit = vipCache.get(key);
  if (hit && Math.abs(now.getTime() - hit.at) < 600_000) return hit.cents;
  const [row] = await rowsOf<{ cents: number | null }>(
    tx.execute(sql`select percentile_disc(${1 - topPct / 100}) within group (order by cents) cents from (${spendSql(today, sql``)}) t where cents > 0`),
  );
  const cents = row?.cents == null ? null : Number(row.cents);
  vipCache.set(key, { at: now.getTime(), cents });
  return cents;
}

export const resetBadgeCaches = () => vipCache.clear();

/** What the rules read, for each of these clients, in a handful of queries. */
export async function badgeFacts(ids: readonly string[], now: Date, t: BadgeSettings["thresholds"], tx: DBorTx = db): Promise<Map<string, BadgeFacts>> {
  const out = new Map<string, BadgeFacts>();
  if (!ids.length) return out;
  const these = idArray(ids);
  const today = todayLocal(now);
  const nowIso = now.toISOString();
  const yearAgo = new Date(now.getTime() - 365 * DAY).toISOString();
  const [people, visits, appts, spend, products, rewards, cards, coupons, clicks, outs, ratings] = await Promise.all([
    rowsOf<{
      id: string;
      created_on: string;
      bday: string | null;
      preferred_staff_id: string | null;
      source: string | null;
      referred_by: boolean;
      has_phone: boolean;
      has_email: boolean;
      opted_in: boolean;
      referrals: number;
    }>(
      tx.execute(sql`select c.id, to_char((c.created_at at time zone ${TZ})::date, 'YYYY-MM-DD') created_on, to_char(c.birthday, 'MM-DD') bday,
          c.preferred_staff_id, c.source, c.referred_by_id is not null referred_by,
          coalesce(btrim(c.phone), '') <> '' has_phone, coalesce(btrim(c.email), '') <> '' has_email, (c.sms_opt_in or c.email_opt_in) opted_in,
          (select count(*)::int from customers r where r.referred_by_id = c.id) referrals
        from customers c where c.id = any(${these})`),
    ),
    rowsOf<{ customer_id: string; d: string; staff_id: string }>(
      tx.execute(sql`select a.customer_id, to_char((a.starts_at at time zone ${TZ})::date, 'YYYY-MM-DD') d, (array_agg(a.staff_id order by a.starts_at desc))[1] staff_id
        from appointments a where a.status = 'completed' and a.customer_id = any(${these}) group by 1, 2 order by 1, 2`),
    ),
    rowsOf<{ customer_id: string; next_day: string | null; appts: number; no_shows: number; late: number; bookings: number; online: number }>(
      tx.execute(sql`select a.customer_id,
          min(to_char((a.starts_at at time zone ${TZ})::date, 'YYYY-MM-DD')) filter (where a.status in ${UPCOMING} and a.starts_at >= ${nowIso}) next_day,
          (count(*) filter (where a.status in ('completed', 'no_show') and a.starts_at >= ${yearAgo} and a.starts_at < ${nowIso}))::int appts,
          (count(*) filter (where a.status = 'no_show' and a.starts_at >= ${yearAgo}))::int no_shows,
          (count(*) filter (where a.status = 'cancelled' and a.cancelled_at is not null and a.starts_at >= ${yearAgo}
            and a.cancelled_at > a.starts_at - make_interval(hours => ${t.lateCancelHours}::int)))::int late,
          (count(*) filter (where a.created_at >= ${yearAgo} and a.source <> 'import'))::int bookings,
          (count(*) filter (where a.created_at >= ${yearAgo} and a.source in ('online', 'api')))::int online
        from appointments a where a.customer_id = any(${these}) group by 1`),
    ),
    rowsOf<{ customer_id: string; cents: number }>(tx.execute(spendSql(today, sql` and s.customer_id = any(${these})`))),
    rowsOf<{ customer_id: string; yr: number; ever: number }>(
      tx.execute(sql`select s.customer_id, coalesce(sum(si.qty - si.refunded_qty) filter (where s.business_date > (${today}::date - 365)), 0)::int yr, coalesce(sum(si.qty), 0)::int ever
        from sale_items si join sales s on s.id = si.sale_id where si.kind = 'product' and s.status in ${PAID} and s.customer_id = any(${these}) group by 1`),
    ),
    rowsOf<{ customer_id: string; cents: number }>(
      tx.execute(sql`select customer_id, sum(amount_cents)::int cents from loyalty_rewards
        where customer_id = any(${these}) and redeemed_at is null and (expires_at is null or expires_at > ${nowIso}) group by 1`),
    ),
    rowsOf<{ customer_id: string; cents: number }>(
      tx.execute(sql`select customer_id, sum(balance_cents)::int cents from gift_cards
        where customer_id = any(${these}) and status = 'active' and balance_cents > 0 and (expires_at is null or expires_at > ${nowIso}) group by 1`),
    ),
    rowsOf<{ customer_id: string; n: number }>(
      tx.execute(sql`select cc.customer_id, count(*)::int n from coupon_codes cc join promo_codes p on p.id = cc.promo_id
        where cc.customer_id = any(${these}) and cc.redeemed_at is null and (cc.expires_on is null or cc.expires_on >= ${today}::date)
          and p.active and (p.ends_on is null or p.ends_on >= ${today}::date) group by 1`),
    ),
    rowsOf<{ customer_id: string; n: number }>(
      tx.execute(sql`select s.customer_id, count(*)::int n from review_clicks rc join sales s on s.id = rc.sale_id where s.customer_id = any(${these}) group by 1`),
    ),
    rowsOf<{ id: string; channel: string }>(
      tx.execute(sql`select distinct c.id, u.channel from customers c join marketing_unsubscribes u
          on u.customer_id = c.id or (u.email is not null and lower(u.email) = lower(c.email)) or (u.phone is not null and u.phone = c.phone)
        where c.id = any(${these})
        union select c.id, 'sms' from customers c join contact_opt_outs o on o.phone = c.phone and o.channel = 'sms' where c.id = any(${these})`),
    ),
    ratingSummaries([...ids], tx),
  ]);

  const staffIds = new Set<string>();
  for (const v of visits) staffIds.add(v.staff_id);
  for (const p of people) if (p.preferred_staff_id) staffIds.add(p.preferred_staff_id);
  const barbers = staffIds.size
    ? await rowsOf<{ id: string; name: string; active: boolean }>(
        tx.execute(sql`select id, display_label name, (active and removed_at is null) active from staff where id = any(${idArray([...staffIds])})`),
      )
    : [];
  const barberMap = Object.fromEntries(barbers.map((b) => [b.id, { name: b.name, active: b.active }]));

  const by = <R extends { customer_id: string }>(rows: R[]) => new Map(rows.map((r) => [r.customer_id, r]));
  const apptBy = by(appts);
  const spendBy = by(spend);
  const productBy = by(products);
  const rewardBy = by(rewards);
  const cardBy = by(cards);
  const couponBy = by(coupons);
  const clickBy = by(clicks);
  const visitsBy = new Map<string, BadgeFacts["visits"]>();
  for (const v of visits) {
    const list = visitsBy.get(v.customer_id) ?? [];
    list.push({ day: v.d, staffId: v.staff_id });
    visitsBy.set(v.customer_id, list);
  }
  const outsBy = new Map<string, string[]>();
  for (const o of outs) outsBy.set(o.id, [...(outsBy.get(o.id) ?? []), o.channel]);

  for (const p of people) {
    const a = apptBy.get(p.id);
    const mine = visitsBy.get(p.id) ?? [];
    const own: BadgeFacts["barbers"] = {};
    for (const id of [p.preferred_staff_id, ...mine.map((v) => v.staffId)]) if (id && barberMap[id]) own[id] = barberMap[id];
    out.set(p.id, {
      visits: mine,
      nextBooked: a?.next_day ?? null,
      year: { appointments: a?.appts ?? 0, noShows: a?.no_shows ?? 0, lateCancels: a?.late ?? 0, bookings: a?.bookings ?? 0, online: a?.online ?? 0 },
      createdOn: p.created_on,
      birthday: p.bday,
      preferredStaffId: p.preferred_staff_id,
      barbers: own,
      spendCents: Number(spendBy.get(p.id)?.cents ?? 0),
      products: { year: Number(productBy.get(p.id)?.yr ?? 0), ever: Number(productBy.get(p.id)?.ever ?? 0) },
      rewardCents: Number(rewardBy.get(p.id)?.cents ?? 0),
      giftCardCents: Number(cardBy.get(p.id)?.cents ?? 0),
      coupons: Number(couponBy.get(p.id)?.n ?? 0),
      rating: ratings.get(p.id) ?? null,
      reviewClicks: Number(clickBy.get(p.id)?.n ?? 0),
      hasPhone: p.has_phone,
      hasEmail: p.has_email,
      optedIn: p.opted_in,
      optedOut: outsBy.get(p.id) ?? [],
      source: p.source,
      referredBy: p.referred_by,
      referrals: Number(p.referrals),
    });
  }
  return out;
}

/** Who each custom badge's filter matches: these clients, or (ids null) everyone, for the nightly run. */
export async function customMembers(custom: readonly CustomBadge[], now: Date, ids: readonly string[] | null, tx: DBorTx = db): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const c of custom) {
    if (!c.active) continue;
    const where = await segmentConditions(c.filter, now);
    if (!where.length) continue;
    if (ids) where.push(sql`c.id = any(${idArray(ids)})`);
    const rows = await rowsOf<{ id: string }>(
      tx.execute(sql`with ${CLIENT_FACTS} select c.id from customers c left join v on v.customer_id = c.id left join sp on sp.customer_id = c.id where ${sql.join(where, sql` and `)}`),
    );
    out.set(c.id, new Set(rows.map((r) => r.id)));
  }
  return out;
}

export interface BadgeRun {
  settings: BadgeSettings;
  custom: CustomBadge[];
  vip: number | null;
  /** Precomputed custom badge members for everyone; otherwise worked out per batch. */
  members?: Map<string, Set<string>>;
}

export async function badgeRun(now: Date, o: { allMembers?: boolean } = {}, tx: DBorTx = db): Promise<BadgeRun> {
  const [settings, custom] = await Promise.all([loadBadgeSettings(tx), listCustomBadges({ active: true }, tx)]);
  const vip = await vipCutoff(settings.thresholds.vipTopPct, now, tx);
  return { settings, custom, vip, members: o.allMembers && custom.length ? await customMembers(custom, now, null, tx) : undefined };
}

/** Every badge these clients earn (built-in and custom), whoever may see them. */
export async function computeBadges(ids: readonly string[], now: Date, run: BadgeRun, tx: DBorTx = db): Promise<Map<string, StoredBadge[]>> {
  const out = new Map<string, StoredBadge[]>();
  if (!ids.length) return out;
  const [facts, members] = await Promise.all([badgeFacts(ids, now, run.settings.thresholds, tx), run.members ?? (run.custom.length ? customMembers(run.custom, now, ids, tx) : new Map())]);
  const today = todayLocal(now);
  for (const [id, f] of facts) {
    const list = deriveBadges(f, { today, t: run.settings.thresholds, vipCutoffCents: run.vip });
    for (const c of run.custom) if (members.get(c.id)?.has(id)) list.push({ k: customKey(c.id) });
    out.set(id, list);
  }
  return out;
}

const hashOf = (b: readonly StoredBadge[]) => createHash("sha256").update(JSON.stringify(b)).digest("hex").slice(0, 32);

/**
 * Recomputes these clients and caches the result. Only rows whose badges changed are rewritten;
 * the rest just get today's date. Returns how many changed.
 */
export async function refreshBadges(ids: readonly string[], now: Date, run?: BadgeRun, tx: DBorTx = db): Promise<number> {
  const clean = [...new Set(ids.filter((i) => UUID.test(i)))];
  if (!clean.length) return 0;
  const r = run ?? (await badgeRun(now, {}, tx));
  const computed = await computeBadges(clean, now, r, tx);
  if (!computed.size) return 0;
  const today = todayLocal(now);
  const rows = [...computed].map(([id, b]) => ({ id, keys: b.map((x) => x.k), badges: b, hash: hashOf(b) }));
  const changed = await rowsOf<{ customer_id: string }>(
    tx.execute(sql`insert into client_badges (customer_id, keys, badges, hash, computed_on, computed_at, changed_at)
      select (x->>'id')::uuid, array(select jsonb_array_elements_text(x->'keys')), x->'badges', x->>'hash', ${today}::date, now(), now()
      from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) x
      on conflict (customer_id) do update set keys = excluded.keys, badges = excluded.badges, hash = excluded.hash,
        computed_on = excluded.computed_on, computed_at = excluded.computed_at, changed_at = excluded.changed_at
      where client_badges.hash <> excluded.hash
      returning customer_id`),
  );
  const changedIds = new Set(changed.map((c) => c.customer_id));
  const same = rows.map((x) => x.id).filter((id) => !changedIds.has(id));
  if (same.length) await tx.execute(sql`update client_badges set computed_on = ${today}::date, computed_at = now() where customer_id = any(${idArray(same)})`);
  return changedIds.size;
}

/** The nightly run: clients with no cached badges or stale ones, in batches, until the time is up. Run again to carry on. */
export async function runBadgeJob(now = new Date(), o: { budgetMs?: number; batch?: number } = {}): Promise<{ scanned: number; changed: number; remaining: number }> {
  const started = Date.now();
  const budget = o.budgetMs ?? 240_000;
  const batch = o.batch ?? 500;
  const today = todayLocal(now);
  const cols = await consentColumns();
  const alive = cols.deleted ? sql` and c.deleted_at is null` : sql``;
  const pending = () => sql`from customers c left join client_badges b on b.customer_id = c.id where (b.customer_id is null or b.computed_on < ${today}::date)${alive}`;
  const run = await badgeRun(now, { allMembers: true });
  let scanned = 0;
  let changed = 0;
  while (Date.now() - started < budget) {
    const ids = (await rowsOf<{ id: string }>(db.execute(sql`select c.id ${pending()} order by b.computed_on nulls first, c.id limit ${batch}`))).map((r) => r.id);
    if (!ids.length) break;
    changed += await refreshBadges(ids, now, run);
    scanned += ids.length;
  }
  const [{ n }] = await rowsOf<{ n: number }>(db.execute(sql`select count(*)::int n ${pending()}`));
  return { scanned, changed, remaining: Number(n) };
}

export async function badgeCacheStatus(now = new Date()) {
  const today = todayLocal(now);
  const [row] = await rowsOf<{ cached: number; fresh: number; clients: number; last: Date | null }>(
    db.execute(sql`select (select count(*)::int from client_badges) cached, (select count(*)::int from client_badges where computed_on >= ${today}::date) fresh,
      (select count(*)::int from customers) clients, (select max(computed_at) from client_badges) last`),
  );
  return { cached: Number(row.cached), fresh: Number(row.fresh), clients: Number(row.clients), last: row.last ? new Date(row.last) : null };
}

// ───────────────────────────── Reading ─────────────────────────────

/** The cached badges for these clients; missing or stale ones are recomputed first (up to a cap). */
export async function storedBadges(ids: readonly (string | null | undefined)[], now = new Date(), tx: DBorTx = db): Promise<Map<string, StoredBadge[]>> {
  const clean = [...new Set(ids.filter((i): i is string => !!i && UUID.test(i)))];
  const out = new Map<string, StoredBadge[]>();
  if (!clean.length) return out;
  const today = todayLocal(now);
  const read = () =>
    rowsOf<{ customer_id: string; badges: StoredBadge[]; fresh: boolean }>(
      tx.execute(sql`select customer_id, badges, computed_on >= ${today}::date fresh from client_badges where customer_id = any(${idArray(clean)})`),
    );
  let rows = await read();
  const have = new Map(rows.map((r) => [r.customer_id, r]));
  const todo = clean.filter((id) => !have.get(id)?.fresh).slice(0, READ_REFRESH_CAP);
  if (todo.length) {
    await refreshBadges(todo, now, undefined, tx);
    rows = await read();
  }
  for (const r of rows) out.set(r.customer_id, r.badges);
  return out;
}

/** The badges each client shows to this person, in catalog order. */
export async function shownBadges(policy: Pick<ClientPolicy, "badges" | "level" | "customBadges">, ids: readonly (string | null | undefined)[], now = new Date()): Promise<Map<string, ShownBadge[]>> {
  const out = new Map<string, ShownBadge[]>();
  if (!policy.badges.size) return out;
  const stored = await storedBadges(ids, now);
  const view = { keys: policy.badges, level: policy.level, custom: policy.customBadges };
  for (const [id, b] of stored) out.set(id, showBadges(b, view));
  return out;
}

/**
 * Today's booked clients at these locations, counted by badge: "3 at-risk clients booked today".
 * Only the badges in `keys`, in MORNING_BADGES order, and only those with someone.
 */
export async function badgeCounts(
  shopIds: readonly string[],
  day: LocalDate,
  keys: readonly string[],
  o: { now?: Date; staffId?: string | null } = {},
): Promise<{ key: string; count: number }[]> {
  const want = MORNING_BADGES.filter((k) => keys.includes(k));
  if (!shopIds.length || !want.length) return [];
  const mine = o.staffId && UUID.test(o.staffId) ? sql` and a.staff_id = ${o.staffId}::uuid` : sql``;
  const ids = (
    await rowsOf<{ id: string }>(
      db.execute(sql`select distinct a.customer_id id from appointments a where a.shop_id = any(${idArray([...shopIds])}) and a.customer_id is not null
        and a.status not in ('cancelled', 'no_show') and (a.starts_at at time zone ${TZ})::date = ${day}::date${mine}`),
    )
  ).map((r) => r.id);
  if (!ids.length) return [];
  const stored = await storedBadges(ids, o.now);
  const n = new Map<string, number>();
  for (const b of stored.values()) for (const s of b) if (want.includes(s.k as (typeof want)[number])) n.set(s.k, (n.get(s.k) ?? 0) + 1);
  return want.filter((k) => n.get(k)).map((k) => ({ key: k, count: n.get(k)! }));
}
