import "server-only";
import { type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { NO_BARBER } from "@/domain/barbers";
import {
  CLIENT_TYPES,
  type ClientType,
  RANK_BY,
  RETURN_DAYS,
  type RankBy,
  type RebookCounts,
  type RebookRates,
  type ReturnWindow,
  type TrendGrain,
  WINDOW_LABEL,
  parseClientType,
  parseRankBy,
  parseTrend,
  parseWindow,
  periodLabel,
  periodStarts,
  pctText,
  ptsLabel,
  rankBoard,
  rebookRates,
  windowDays,
  windowLabel,
  zeroCounts,
} from "@/domain/rebook";
import { type Cell, type Column, type ColumnKind, type Metric, type ReportTable, TOTAL, type ViewCtx, metricTable, parseSegKey, staffName, viewOf } from "@/domain/report-views";
import { SHOP_TZ, addDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";
import type { ReportData, ReportOption } from "./report-data";
import { type Grain, type ReportScope, atGrains, grainsFor, grp, ids, keyOf, rows, sgrp, staffFilter, staffSelection } from "./report-sql";

/**
 * The Rebook Rate report: rebooked at checkout, back within 30/45/60 days or the client's own gap,
 * new-client rebook rate and 2nd-visit retention, and future appointments, by location and barber
 * with the brand rollup, a weekly or monthly trend, leaderboards and the brand average alongside.
 * Definitions are in src/domain/rebook.ts.
 */

export interface RebookFilters {
  serviceId: string | null;
  clients: ClientType;
  window: ReturnWindow;
  now: Date;
}

const span = (s: ReportScope) => ({ start: startOfLocalDay(s.from).toISOString(), end: endOfLocalDay(s.to).toISOString() });
const TZ = sql`coalesce(sh.timezone, ${SHOP_TZ})`;
const NONE = sql`null::text`;

/** Week (from Sunday) or month of the visit's local day, as YYYY-MM-DD. */
const periodOf = (g: TrendGrain | undefined, col: SQL) =>
  !g ? NONE : g === "week" ? sql`to_char(${col} - extract(dow from ${col})::int, 'YYYY-MM-DD')` : sql`to_char(date_trunc('month', ${col})::date, 'YYYY-MM-DD')`;

/**
 * Appointment `b` was the next visit the client of visit `v` left with: booked before the end of the
 * visit's local day (`dayEnd`) for a later day, and not cancelled by then. Squire rows without a
 * booked-at time can't say when they were booked, so they never count. Custom reports use it too.
 */
export const nextBookedWhere = (v: string, dayEnd: SQL) => {
  const x = sql.raw(v);
  return sql`b.customer_id = ${x}.customer_id and b.id <> ${x}.id and b.booked_at_known and b.starts_at >= ${dayEnd} and b.created_at < ${dayEnd}
    and (b.status <> 'cancelled' or coalesce(b.cancelled_at, b.created_at) >= ${dayEnd})`;
};

/** The end of the local day of `a.starts_at`, in the time zone of shop `sh`. */
export const DAY_END = sql`(((a.starts_at at time zone ${TZ})::date + 1)::timestamp at time zone ${TZ})`;

/** `w`: the completed visits in scope, with the client-type filter applied. */
function visitCtes(s: ReportScope, f: RebookFilters): SQL {
  const { start, end } = span(s);
  return sql`v as (
      select a.id, a.shop_id, a.staff_id, a.customer_id, a.starts_at, a.booked_at_known known,
        (a.starts_at at time zone ${TZ})::date local_day,
        ${DAY_END} day_end,
        not exists (select 1 from appointments p where p.customer_id = a.customer_id and p.status = 'completed'
          and (p.starts_at < a.starts_at or (p.starts_at = a.starts_at and p.id < a.id))) is_new
      from appointments a join shops sh on sh.id = a.shop_id
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start}::timestamptz and a.starts_at < ${end}::timestamptz ${staffFilter(sql`a.staff_id`, s)}
        ${f.serviceId ? sql`and exists (select 1 from appointment_items i where i.appointment_id = a.id and i.service_id = ${f.serviceId}::uuid)` : sql``}
    ), w as (select * from v ${f.clients === "new" ? sql`where is_new` : f.clients === "returning" ? sql`where not is_new` : sql``})`;
}

interface Key {
  shop_id: string | null;
  staff_id: string | null;
  period: string | null;
}

/** Visit counts: rebooked at checkout, overall and on first-ever visits. */
async function visitCounts(s: ReportScope, f: RebookFilters, o: Grain, period?: TrendGrain) {
  return rows<Key & { visits: number; known: number; rebooked: number; same_day: number; new_visits: number; new_known: number; new_rebooked: number }>(sql`
    with ${visitCtes(s, f)}, r as (
      select w.*, nb.created_at is not null rebooked, nb.created_at >= w.starts_at same_day from w
      left join lateral (
        select b.created_at from appointments b where w.known and ${nextBookedWhere("w", sql`w.day_end`)}
        order by b.created_at desc limit 1
      ) nb on true
    )
    select ${grp(o, sql`r.shop_id`)} shop_id, ${sgrp(o, sql`r.staff_id`)} staff_id, ${periodOf(period, sql`r.local_day`)} period,
      count(*)::int visits, count(*) filter (where known)::int known, count(*) filter (where rebooked)::int rebooked,
      count(*) filter (where rebooked and same_day)::int same_day,
      count(*) filter (where is_new)::int new_visits, count(*) filter (where is_new and known)::int new_known, count(*) filter (where is_new and rebooked)::int new_rebooked
    from r group by 1, 2, 3`);
}

/** Client counts, each client once per group, judged from their first visit in it. */
async function clientCounts(s: ReportScope, f: RebookFilters, o: Grain, period?: TrendGrain) {
  const now = f.now.toISOString();
  const keys = [grp(o, sql`w.shop_id`), sgrp(o, sql`w.staff_id`), periodOf(period, sql`w.local_day`)];
  const closed = (days: SQL) => sql`day_end + make_interval(days => ${days}) <= ${now}::timestamptz`;
  const within = (days: SQL) => sql`${closed(days)} and next_at < day_end + make_interval(days => ${days})`;
  const newDays = sql`${windowDays(f.window)}::int`;
  return rows<
    Key & {
      clients: number;
      j30: number;
      b30: number;
      j45: number;
      b45: number;
      j60: number;
      b60: number;
      j_own: number;
      b_own: number;
      new_clients: number;
      new_judged: number;
      new_back: number;
      prebooked: number;
    }
  >(sql`
    with ${visitCtes(s, f)}, k as (
      select w.*, ${keys[0]} g_shop, ${keys[1]} g_staff, ${keys[2]} g_period from w
    ), f as (
      select distinct on (g_shop, g_staff, g_period, customer_id) g_shop shop_id, g_staff staff_id, g_period period, customer_id, starts_at, day_end, is_new
      from k order by g_shop, g_staff, g_period, customer_id, starts_at, id
    ), x as (
      select f.*, h.n prior_n, h.first_at,
        (select min(b.starts_at) from appointments b where b.customer_id = f.customer_id and b.status = 'completed' and b.starts_at >= f.day_end) next_at,
        exists (select 1 from appointments b where b.customer_id = f.customer_id and b.status in ('booked', 'confirmed') and b.starts_at > ${now}::timestamptz) has_next
      from f left join lateral (
        select count(*)::int n, min(p.starts_at) first_at from appointments p where p.customer_id = f.customer_id and p.status = 'completed' and p.starts_at < f.starts_at
      ) h on true
    ), y as (
      select x.*, case when prior_n > 0 then greatest(1, ceil(extract(epoch from (starts_at - first_at)) / 86400.0 / prior_n))::int end own_days from x
    )
    select shop_id, staff_id, period, count(*)::int clients,
      ${sql.join(
        RETURN_DAYS.map((n) => sql`count(*) filter (where ${closed(sql`${n}::int`)})::int ${sql.raw(`j${n}`)}, count(*) filter (where ${within(sql`${n}::int`)})::int ${sql.raw(`b${n}`)}`),
        sql`, `,
      )},
      count(*) filter (where own_days is not null and ${closed(sql`own_days`)})::int j_own,
      count(*) filter (where own_days is not null and ${within(sql`own_days`)})::int b_own,
      count(*) filter (where is_new)::int new_clients,
      count(*) filter (where is_new and ${closed(newDays)})::int new_judged,
      count(*) filter (where is_new and ${within(newDays)})::int new_back,
      count(*) filter (where has_next)::int prebooked
    from y group by 1, 2, 3`);
}

/** Booked or confirmed appointments still to come at the scope's shops, with its barbers and service. */
async function futureCounts(s: ReportScope, f: RebookFilters, o: Grain) {
  const done = sql`exists (select 1 from appointments p where p.customer_id = b.customer_id and p.status = 'completed')`;
  return rows<Key & { future: number }>(sql`
    select ${grp(o, sql`b.shop_id`)} shop_id, ${sgrp(o, sql`b.staff_id`)} staff_id, null::text period, count(*)::int future
    from appointments b
    where b.shop_id in ${ids(s)} and b.status in ('booked', 'confirmed') and b.customer_id is not null and b.starts_at > ${f.now.toISOString()}::timestamptz
      ${staffFilter(sql`b.staff_id`, s)}
      ${f.serviceId ? sql`and exists (select 1 from appointment_items i where i.appointment_id = b.id and i.service_id = ${f.serviceId}::uuid)` : sql``}
      ${f.clients === "new" ? sql`and not ${done}` : f.clients === "returning" ? sql`and ${done}` : sql``}
    group by 1, 2`);
}

type Merged = Map<string, RebookCounts>;

function merge(
  keyOfRow: (r: Key) => string,
  visits: Awaited<ReturnType<typeof visitCounts>>,
  clients: Awaited<ReturnType<typeof clientCounts>>,
  future: Awaited<ReturnType<typeof futureCounts>> = [],
  base: Merged = new Map(),
): Merged {
  const at = (k: string) => {
    if (!base.has(k)) base.set(k, zeroCounts());
    return base.get(k)!;
  };
  for (const r of visits)
    Object.assign(at(keyOfRow(r)), { visits: r.visits, known: r.known, rebooked: r.rebooked, sameDay: r.same_day, newVisits: r.new_visits, newKnown: r.new_known, newRebooked: r.new_rebooked });
  for (const r of clients)
    Object.assign(at(keyOfRow(r)), {
      clients: r.clients,
      judged: { 30: r.j30, 45: r.j45, 60: r.j60, own: r.j_own },
      back: { 30: r.b30, 45: r.b45, 60: r.b60, own: r.b_own },
      newClients: r.new_clients,
      newJudged: r.new_judged,
      newBack: r.new_back,
      prebookedClients: r.prebooked,
    });
  for (const r of future) at(keyOfRow(r)).future = r.future;
  return base;
}

/** The counts per segment key (see report-views), at each grain asked for. Visits always; clients and future appointments unless left out. */
export async function rebookAt(s: ReportScope, f: RebookFilters, grains: Grain[], parts: { clients?: boolean; future?: boolean } = {}): Promise<Record<string, RebookCounts>> {
  return atGrains(grains, async (g) => {
    const [v, c, fu] = await Promise.all([visitCounts(s, f, g), parts.clients === false ? [] : clientCounts(s, f, g), parts.future === false ? [] : futureCounts(s, f, g)]);
    const out = merge(keyOf, v, c, fu);
    if (!g.byShop && !g.byStaff && !out.has(TOTAL)) out.set(TOTAL, zeroCounts());
    return out;
  });
}

/** The counts per week or month over the whole scope. */
export async function rebookTrend(s: ReportScope, f: RebookFilters, g: TrendGrain): Promise<Map<string, RebookCounts>> {
  const [v, c] = await Promise.all([visitCounts(s, f, {}, g), clientCounts(s, f, {}, g)]);
  return merge((r) => r.period ?? "", v, c);
}

/** Every shop in the brand, for the brand average. */
export async function brandShopIds(): Promise<string[]> {
  return (await rows<{ id: string }>(sql`select id from shops order by name`)).map((r) => r.id);
}

/** The brand average: the same range and filters over every shop and barber. */
export async function brandScope(s: ReportScope): Promise<{ scope: ReportScope; same: boolean }> {
  const all = await brandShopIds();
  const same = !staffSelection(s) && all.every((id) => s.shopIds.includes(id));
  return { scope: { shopIds: all, from: s.from, to: s.to }, same };
}

async function serviceChoices(): Promise<{ id: string; name: string }[]> {
  return db.execute(sql`select id, name from services where active and kind = 'service' order by sort_order, name`) as unknown as Promise<{ id: string; name: string }[]>;
}

const option = (param: string, label: string, value: string, choices: [string, string][], select?: boolean): ReportOption => ({
  param,
  label,
  value,
  choices: choices.map(([v, l]) => ({ value: v, label: l })),
  ...(select ? { select } : {}),
});

const SUFFIX = { combined: "", shops: " by location", barbers: " by barber", shops_barbers: " by location and barber" } as const;

export async function rebookReportData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>, now = new Date()): Promise<ReportData> {
  const services = await serviceChoices();
  const serviceId = services.some((x) => x.id === params.service) ? params.service! : null;
  const f: RebookFilters = { serviceId, clients: parseClientType(params.clients), window: parseWindow(params.window), now };
  const trend = parseTrend(params.trend, scope.from, scope.to);
  const rankBy: RankBy = parseRankBy(params.rank);
  const multiShop = loc.shops.length > 1;
  const grains = [...grainsFor(loc), { byStaff: true }, ...(multiShop ? [{ byShop: true }] : [])].filter(
    (g, i, xs) => xs.findIndex((y) => !!y.byShop === !!g.byShop && !!y.byStaff === !!g.byStaff) === i,
  );
  const brand = await brandScope(scope);
  const [at, trendAt, brandAt, brandTrend] = await Promise.all([
    rebookAt(scope, f, grains),
    rebookTrend(scope, f, trend),
    brand.same ? Promise.resolve(null) : rebookAt(brand.scope, f, [{}]),
    brand.same ? Promise.resolve(null) : rebookTrend(brand.scope, f, trend),
  ]);
  const total = at[TOTAL] ?? zeroCounts();
  const brandTotal = brandAt?.[TOTAL] ?? total;
  const w = f.window;
  const rates: Record<string, RebookRates> = Object.fromEntries(Object.entries(at).map(([k, c]) => [k, rebookRates(c, w)]));
  const t = rebookRates(total, w);
  const b = rebookRates(brandTotal, w);
  const wl = windowLabel(w);
  const newDays = windowDays(w);

  const m = (label: string, kind: ColumnKind, get: (c: RebookCounts, r: RebookRates) => number | null, additive?: boolean): Metric => ({
    label,
    kind,
    at: Object.fromEntries(Object.entries(at).map(([k, c]) => [k, get(c, rates[k])])),
    additive,
  });
  const named = viewOf(loc);
  const summary = metricTable(loc, {
    id: "rebook",
    title: `Rebook rate${SUFFIX[named]}`,
    subtitle:
      "Rebooked at checkout: the client left with their next visit booked (at checkout, later that day, or already on the books), not cancelled that day. Return rates count each client once, from their first visit in the range, and only once the window has closed. A client seen at two shops or by two barbers counts in each row and once in the total.",
    metrics: [
      m("Completed visits", "int", (c) => c.visits),
      m("Visits with a booking time", "int", (c) => c.known),
      m("Rebooked at checkout", "int", (c) => c.rebooked),
      m("Booked during the visit or that day", "int", (c) => c.sameDay),
      m("Rebook rate", "pct", (_, r) => r.rebook),
      m("New-client visits", "int", (c) => c.newVisits),
      m("New clients rebooked at checkout", "int", (c) => c.newRebooked),
      m("New-client rebook rate", "pct", (_, r) => r.newRebook),
      m("Clients seen", "int", (c) => c.clients, false),
      ...RETURN_DAYS.map((n) => m(`Back within ${n} days`, "pct", (_, r) => r.back[n])),
      m("Back within their usual gap", "pct", (_, r) => r.back.own),
      m("New clients", "int", (c) => c.newClients, false),
      m(`2nd-visit retention (${newDays} days)`, "pct", (_, r) => r.secondVisit),
      m("Clients with a visit booked now", "pct", (_, r) => r.prebooked),
      m("Future appointments booked", "int", (c) => c.future),
    ],
  });

  const compareRows: [string, number | null, number | null][] = [
    ["Rebook rate", t.rebook, b.rebook],
    ["New-client rebook rate", t.newRebook, b.newRebook],
    ...RETURN_DAYS.map((n): [string, number | null, number | null] => [`Back within ${n} days`, t.back[n], b.back[n]]),
    ["Back within their usual gap", t.back.own, b.back.own],
    [`2nd-visit retention (${newDays} days)`, t.secondVisit, b.secondVisit],
    ["Clients with a visit booked now", t.prebooked, b.prebooked],
  ];
  const selectionLabel = loc.shops.length === 1 && !loc.byBarber ? loc.shops[0].name : loc.totalLabel;
  const compare: ReportTable = {
    id: "brand",
    title: "Against the brand average",
    subtitle: "The brand average is every location and barber over the same dates, service and client type. Differences are in percentage points.",
    columns: [{ label: "Measure" }, { label: selectionLabel, kind: "pct" }, { label: "Brand average", kind: "pct" }, { label: "Difference" }],
    rows: compareRows.map(([label, x, y]) => [label, x, y, ptsLabel(x, y)]),
  };

  const name = (id: string) => staffName(loc, id);
  const shopName = new Map(loc.shops.map((x) => [x.id, x.name]));
  const boardColumns = (who: string): Column[] => [
    { label: "Rank", kind: "int", sum: false },
    { label: who },
    { label: "Visits", kind: "int" },
    { label: "Rebook rate", kind: "pct" },
    { label: "Vs brand" },
    { label: "New-client rebook", kind: "pct" },
    { label: `Back within ${wl}`, kind: "pct" },
    { label: "2nd-visit retention", kind: "pct" },
    { label: "Future appointments", kind: "int", sum: false },
  ];
  const boardRow = (rank: number | null, label: string, c: RebookCounts): Cell[] => {
    const r = rebookRates(c, w);
    return [rank, label, c.visits, r.rebook, ptsLabel(r.rebook, b.rebook), r.newRebook, r.returned, r.secondVisit, c.future];
  };
  const keysAt = (byShop: boolean, byStaff: boolean) =>
    Object.keys(at)
      .map((k) => ({ k, ...parseSegKey(k) }))
      .filter((p) => (p.shopId !== null) === byShop && (p.staffId !== null) === byStaff && p.staffId !== NO_BARBER && at[p.k].visits > 0);
  const barbers = rankBoard(
    keysAt(false, true).map((p) => ({ name: name(p.staffId!), counts: at[p.k] })),
    rankBy,
    w,
  );
  const locations = multiShop
    ? rankBoard(
        keysAt(true, false).map((p) => ({ name: shopName.get(p.shopId!) ?? "", counts: at[p.k] })),
        rankBy,
        w,
      )
    : [];
  const board = (id: string, title: string, who: string, list: typeof barbers): ReportTable => ({
    id,
    title: `${title}: ${RANK_BY[rankBy].label.toLowerCase()}`,
    subtitle: `Ranked highest first. Fewer than 10 ${rankBy === "second_visit" ? "new clients judged" : rankBy === "return" ? "clients judged" : "visits"} and they're listed at the end without a rank. Vs brand is the rebook rate against the brand average.`,
    columns: boardColumns(who),
    rows: [...list.map((x) => boardRow(x.rank, x.item.name, x.item.counts)), [null, "Brand average", brandTotal.visits, b.rebook, null, b.newRebook, b.returned, b.secondVisit, brandTotal.future]],
    rowStyles: [...list.map(() => undefined), "total"],
  });

  const starts = periodStarts(scope.from, scope.to, trend);
  const tr = (k: string) => rebookRates(trendAt.get(k) ?? zeroCounts(), w);
  const br = (k: string) => (brandTrend ? rebookRates(brandTrend.get(k) ?? zeroCounts(), w) : tr(k));
  const trendTable: ReportTable = {
    id: "trend",
    title: `Trend by ${trend}`,
    subtitle: `Each ${trend} on its own: a client seen in two ${trend}s counts in each. A dash means no visits, or the return window hasn't closed yet.`,
    columns: [
      { label: trend === "week" ? "Week of" : "Month" },
      { label: "Visits", kind: "int" },
      { label: "Rebooked", kind: "int" },
      { label: "Rebook rate", kind: "pct" },
      { label: "Brand rebook rate", kind: "pct" },
      { label: "New-client visits", kind: "int" },
      { label: "New-client rebook", kind: "pct" },
      { label: `Back within ${wl}`, kind: "pct" },
      { label: "2nd-visit retention", kind: "pct" },
    ],
    rows: starts.map((d) => {
      const c = trendAt.get(d) ?? zeroCounts();
      const r = tr(d);
      return [d, c.visits, c.rebooked, r.rebook, br(d).rebook, c.newVisits, r.newRebook, r.returned, r.secondVisit];
    }),
  };
  const labels = starts.map((d) => periodLabel(d, trend));
  const tone = (x: number | null, y: number | null) => (x === null || y === null || brand.same || Math.round((x - y) * 100) === 0 ? undefined : x > y ? ("up" as const) : ("down" as const));
  const vs = (x: number | null, y: number | null) => (brand.same ? undefined : `brand ${pctText(y)}${ptsLabel(x, y) && ptsLabel(x, y) !== "even" ? ` (${ptsLabel(x, y)})` : ""}`);

  return {
    stats: [
      { label: "Rebook rate", value: pctText(t.rebook), hint: [`${total.rebooked} of ${total.known} visits`, vs(t.rebook, b.rebook)].filter(Boolean).join(" · "), tone: tone(t.rebook, b.rebook) },
      { label: "New-client rebook rate", value: pctText(t.newRebook), hint: [`${total.newRebooked} of ${total.newKnown} first visits`, vs(t.newRebook, b.newRebook)].filter(Boolean).join(" · "), tone: tone(t.newRebook, b.newRebook) },
      { label: "2nd-visit retention", value: pctText(t.secondVisit), hint: [`${total.newBack} of ${total.newJudged} new clients within ${newDays} days`, vs(t.secondVisit, b.secondVisit)].filter(Boolean).join(" · "), tone: tone(t.secondVisit, b.secondVisit) },
      { label: `Back within ${wl}`, value: pctText(t.returned), hint: [`${total.back[w]} of ${total.judged[w]} clients`, vs(t.returned, b.returned)].filter(Boolean).join(" · "), tone: tone(t.returned, b.returned) },
      { label: "Future appointments", value: total.future.toLocaleString("en-US"), hint: `${total.prebookedClients} of ${total.clients} clients seen have a visit booked` },
    ],
    options: [
      option("clients", "Clients", f.clients, Object.entries(CLIENT_TYPES) as [string, string][]),
      option("window", "Return window", String(w), [
        ["30", WINDOW_LABEL["30"]],
        ["45", WINDOW_LABEL["45"]],
        ["60", WINDOW_LABEL["60"]],
        ["own", WINDOW_LABEL.own],
      ]),
      option("trend", "Trend", trend, [
        ["week", "Weekly"],
        ["month", "Monthly"],
      ]),
      option("rank", "Rank by", rankBy, (Object.keys(RANK_BY) as RankBy[]).map((k) => [k, RANK_BY[k].label])),
      option("service", "Service", serviceId ?? "", [["", "Every service"], ...services.map((x): [string, string] => [x.id, x.name])], true),
    ],
    charts: [
      {
        id: "trend_rebook",
        title: `Rebook rate by ${trend}`,
        labels,
        series: [
          { label: selectionLabel, values: starts.map((d) => tr(d).rebook) },
          ...(brand.same ? [] : [{ label: "Brand average", values: starts.map((d) => br(d).rebook), dashed: true }]),
        ],
      },
      {
        id: "trend_new",
        title: `New clients by ${trend}`,
        labels,
        series: [
          { label: "New-client rebook rate", values: starts.map((d) => tr(d).newRebook) },
          { label: "2nd-visit retention", values: starts.map((d) => tr(d).secondVisit), tone: "alt" },
        ],
      },
    ],
    tables: [summary, ...(brand.same ? [] : [compare]), board("barbers", "Barber leaderboard", "Barber", barbers), ...(multiShop ? [board("locations", "Location leaderboard", "Location", locations)] : []), trendTable],
    notes: [
      ...(brand.same ? ["This is every location and barber, so the total is the brand average."] : []),
      `${total.visits > total.known ? `Rebook rate leaves out ${total.visits - total.known} imported visits with no booking time. ` : ""}Back within ${wl} and 2nd-visit retention count a return to any Ray'z shop or barber, booked at checkout or later.`,
      "The Operations KPIs report has the stricter rebook within 15 minutes of checkout; Retention and rebook KPIs counts a booking up to 24 hours after the visit.",
    ],
  };
}

const BRAND_TTL_MS = 10 * 60_000;
const brandCache = new Map<string, { at: number; v: Promise<RebookCounts> }>();

/** The brand's counts for a range, shared for a few minutes: every barber's Today page refreshes every 30 seconds. */
function cachedBrand(from: string, to: string, f: RebookFilters): Promise<RebookCounts> {
  const k = `${from}|${to}|${f.window}`;
  const hit = brandCache.get(k);
  if (hit && f.now.getTime() - hit.at < BRAND_TTL_MS) return hit.v;
  const v = brandShopIds()
    .then((all) => rebookAt({ shopIds: all, from, to }, f, [{}]))
    .then((r) => r[TOTAL] ?? zeroCounts());
  v.catch(() => brandCache.delete(k));
  brandCache.set(k, { at: f.now.getTime(), v });
  return v;
}

/**
 * One person's own numbers for their card on Today, against the brand: rebooks over the 30 days to
 * `today`, and 2nd-visit retention of the new clients they first saw 60 to 89 days ago, whose 60
 * days have closed.
 */
export async function myRebook(staffId: string, shopIds: string[], today: string, now = new Date()) {
  const f: RebookFilters = { serviceId: null, clients: "all", window: 60, now };
  const from = addDays(today, -29);
  const cohort = { from: addDays(today, -89), to: addDays(today, -60) };
  const mine = { shopIds, staffIds: [staffId] };
  const [recent, older, brand, brandOlder] = await Promise.all([
    rebookAt({ ...mine, from, to: today }, f, [{}], { clients: false }),
    rebookAt({ ...mine, ...cohort }, f, [{}], { future: false }),
    cachedBrand(from, today, f),
    cachedBrand(cohort.from, cohort.to, f),
  ]);
  const c = recent[TOTAL] ?? zeroCounts();
  const o = older[TOTAL] ?? zeroCounts();
  return { counts: c, rates: rebookRates(c, f.window), brand: rebookRates(brand, f.window), second: rebookRates(o, f.window).secondVisit, brandSecond: rebookRates(brandOlder, f.window).secondVisit, newJudged: o.newJudged };
}
