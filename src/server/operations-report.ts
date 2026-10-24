import "server-only";
import { sql } from "drizzle-orm";
import { type Cell, type ColumnKind, type ListRow, type Metric, TOTAL, type ViewCtx, listTable, metricTable, viewOf } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { SHOP_TZ, endOfLocalDay, localDateOf, startOfLocalDay } from "@/lib/time";
import { availableMinutesAt } from "./available-minutes";
import type { ReportData } from "./report-data";
import { type Grain, PAID, type ReportScope, atGrains, grainsFor, grp, ids, keyOf, rows, sgrp, staffFilter, staffSelection, uuids } from "./report-sql";
import { ZERO_SALES, emptyKpis, kpisAt, salesTotalsAt } from "./reports";

/**
 * The operating KPIs, worked out from the records themselves (so any past range works, history
 * before the event log included): utilization, rebooked at checkout, client lifetime value,
 * average ticket, retail per service ticket, revenue per chair hour, wait and on-time starts, the
 * post-visit rating, and retention cohorts by first-visit month. By location and by barber.
 */

/** A next visit booked between the start of this one and this long after checkout counts as rebooked at checkout. */
export const REBOOK_AT_CHECKOUT_MIN = 15;
/** Same tolerance as ON_TIME_TOLERANCE_MIN in src/domain/service-times.ts. */
const ON_TIME_MIN = 5;
export const COHORT_MONTHS = [1, 3, 6, 12] as const;

export interface Ops {
  visits: number;
  rebookedAtCheckout: number;
  waited: number;
  waitMinutes: number;
  starts: number;
  onTime: number;
  serviceTickets: number;
  retailOnServiceCents: number;
  retailAttached: number;
  ratings: number;
  stars: number;
  clientsSeen: number;
  lifetimeCents: number;
  lifetimeVisits: number;
}

const ZERO: Ops = {
  visits: 0,
  rebookedAtCheckout: 0,
  waited: 0,
  waitMinutes: 0,
  starts: 0,
  onTime: 0,
  serviceTickets: 0,
  retailOnServiceCents: 0,
  retailAttached: 0,
  ratings: 0,
  stars: 0,
  clientsSeen: 0,
  lifetimeCents: 0,
  lifetimeVisits: 0,
};

const span = (s: ReportScope) => ({ start: startOfLocalDay(s.from).toISOString(), end: endOfLocalDay(s.to).toISOString() });

async function opsBy(s: ReportScope, o: Grain): Promise<Map<string, Ops>> {
  const { start, end } = span(s);
  const g = (col: string) => grp(o, sql.raw(col));
  const gs = (col: string) => sgrp(o, sql.raw(col));
  const [visits, timing, tickets, rated, ltv] = await Promise.all([
    rows<{ shop_id: string | null; staff_id: string | null; visits: number; rebooked: number }>(sql`
      select ${g("a.shop_id")} shop_id, ${gs("a.staff_id")} staff_id, count(*)::int visits,
        count(*) filter (where exists (
          select 1 from appointments b where b.customer_id = a.customer_id and b.id <> a.id and b.starts_at > a.starts_at and b.booked_at_known and b.source <> 'import'
            and b.created_at >= a.starts_at and b.created_at <= coalesce(t.checked_out_at, a.completed_at, a.ends_at) + make_interval(mins => ${REBOOK_AT_CHECKOUT_MIN})
        ))::int rebooked
      from appointments a left join appointment_times t on t.appointment_id = a.id
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null and a.source <> 'import'
        and a.starts_at >= ${start}::timestamptz and a.starts_at <= ${end}::timestamptz ${staffFilter(sql`a.staff_id`, s)}
      group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; waited: number; wait_min: number; starts: number; on_time: number }>(sql`
      select ${g("a.shop_id")} shop_id, ${gs("a.staff_id")} staff_id,
        count(*) filter (where t.arrived_at is not null)::int waited,
        coalesce(sum(greatest(0, extract(epoch from t.started_at - t.arrived_at) / 60)) filter (where t.arrived_at is not null), 0)::float8 wait_min,
        count(*) filter (where a.source <> 'walk_in')::int starts,
        count(*) filter (where a.source <> 'walk_in' and t.started_at <= a.starts_at + make_interval(mins => ${ON_TIME_MIN}))::int on_time
      from appointments a join appointment_times t on t.appointment_id = a.id
      where a.shop_id in ${ids(s)} and a.status = 'completed' and t.started_at is not null and coalesce(t.review::text, 'include') <> 'exclude'
        and a.starts_at >= ${start}::timestamptz and a.starts_at <= ${end}::timestamptz ${staffFilter(sql`a.staff_id`, s)}
      group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; svc: number; retail: number; attached: number }>(sql`
      select ${g("shop_id")} shop_id, ${gs("staff_id")} staff_id,
        count(*) filter (where service_gross_cents > 0)::int svc,
        coalesce(sum(product_net_cents) filter (where service_gross_cents > 0), 0)::int retail,
        count(*) filter (where service_gross_cents > 0 and product_gross_cents > 0)::int attached
      from sales where shop_id in ${ids(s)} and business_date between ${s.from} and ${s.to} and status in ${PAID} ${staffFilter(sql`staff_id`, s)}
      group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; n: number; stars: number }>(sql`
      select ${g("v.shop_id")} shop_id, ${gs("v.staff_id")} staff_id, count(*)::int n, coalesce(sum(v.stars), 0)::int stars
      from visit_satisfaction v join sales x on x.id = v.sale_id
      where v.shop_id in ${ids(s)} and x.business_date between ${s.from} and ${s.to} ${staffFilter(sql`v.staff_id`, s)}
      group by 1, 2`),
    rows<{ shop_id: string | null; staff_id: string | null; clients: number; cents: number; visits: number }>(sql`
      with seen as (
        select distinct ${g("a.shop_id")} shop_id, ${gs("a.staff_id")} staff_id, a.customer_id from appointments a
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
          and a.starts_at >= ${start}::timestamptz and a.starts_at <= ${end}::timestamptz ${staffFilter(sql`a.staff_id`, s)}
      ), who as (select distinct customer_id from seen),
      spend as (
        select x.customer_id, sum(x.service_net_cents + x.product_net_cents)::bigint net from sales x join who using (customer_id)
        where x.shop_id in ${ids(s)} and x.status in ${PAID} and x.business_date <= ${s.to} group by 1
      ), back as (
        select x.customer_id, sum(r.service_net_cents + r.product_net_cents)::bigint net from refunds r join sales x on x.id = r.sale_id join who using (customer_id)
        where r.shop_id in ${ids(s)} and r.kind = 'refund' and r.business_date <= ${s.to} group by 1
      ), visits as (
        select a.customer_id, count(*)::int n from appointments a join who using (customer_id)
        where a.shop_id in ${ids(s)} and a.status = 'completed' and a.starts_at <= ${end}::timestamptz group by 1
      )
      select seen.shop_id, seen.staff_id, count(*)::int clients, coalesce(sum(coalesce(spend.net, 0) - coalesce(back.net, 0)), 0)::float8 cents, coalesce(sum(visits.n), 0)::int visits
      from seen left join spend using (customer_id) left join back using (customer_id) left join visits using (customer_id)
      group by 1, 2`),
  ]);
  const out = new Map<string, Ops>();
  const at = (k: string) => {
    if (!out.has(k)) out.set(k, { ...ZERO });
    return out.get(k)!;
  };
  for (const x of visits) Object.assign(at(keyOf(x)), { visits: x.visits, rebookedAtCheckout: x.rebooked });
  for (const x of timing) Object.assign(at(keyOf(x)), { waited: x.waited, waitMinutes: x.wait_min, starts: x.starts, onTime: x.on_time });
  for (const x of tickets) Object.assign(at(keyOf(x)), { serviceTickets: x.svc, retailOnServiceCents: x.retail, retailAttached: x.attached });
  for (const x of rated) Object.assign(at(keyOf(x)), { ratings: x.n, stars: x.stars });
  for (const x of ltv) Object.assign(at(keyOf(x)), { clientsSeen: x.clients, lifetimeCents: x.cents, lifetimeVisits: x.visits });
  return out;
}

export const opsAt = (s: ReportScope, grains: Grain[]) => atGrains(grains, (g) => opsBy(s, g));

export interface Cohort {
  shopId: string | null;
  staffId: string | null;
  month: string;
  clients: number;
  back: Record<(typeof COHORT_MONTHS)[number], number>;
}

/**
 * New clients by the month of their first visit at the selected locations (with the selected
 * barbers), and how many came back within 1, 3, 6 and 12 months, at any of those locations.
 */
export async function cohorts(s: ReportScope, o: Grain): Promise<Cohort[]> {
  const { start, end } = span(s);
  const sel = staffSelection(s);
  const r = await rows<{ shop_id: string | null; staff_id: string | null; month: string; clients: number; m1: number; m3: number; m6: number; m12: number }>(sql`
    with firsts as (
      select a.customer_id, a.shop_id, a.staff_id, a.starts_at first_at from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start}::timestamptz and a.starts_at <= ${end}::timestamptz
        and not exists (select 1 from appointments p where p.customer_id = a.customer_id and p.status = 'completed' and p.shop_id in ${ids(s)}
          and (p.starts_at < a.starts_at or (p.starts_at = a.starts_at and p.id < a.id)))
    )
    select ${grp(o, sql`f.shop_id`)} shop_id, ${sgrp(o, sql`f.staff_id`)} staff_id, to_char(f.first_at at time zone ${SHOP_TZ}, 'YYYY-MM') month, count(*)::int clients,
      ${sql.join(
        COHORT_MONTHS.map(
          (n) => sql`count(*) filter (where exists (select 1 from appointments b where b.customer_id = f.customer_id and b.status = 'completed' and b.shop_id in ${ids(s)}
            and b.starts_at > f.first_at and b.starts_at <= f.first_at + make_interval(months => ${n})))::int ${sql.raw(`m${n}`)}`,
        ),
        sql`, `,
      )}
    from firsts f ${sel ? sql`where f.staff_id in ${uuids(sel)}` : sql``}
    group by 1, 2, 3 order by 3`);
  return r.map((x) => ({ shopId: x.shop_id, staffId: x.staff_id, month: x.month, clients: x.clients, back: { 1: x.m1, 3: x.m3, 6: x.m6, 12: x.m12 } }));
}

/** The last day of month `ym` plus n months has passed, so everyone in the cohort had the full window. */
export function cohortWindowClosed(ym: string, months: number, today: string): boolean {
  const [y, m] = ym.split("-").map(Number);
  const endMonth = m + months;
  const last = new Date(Date.UTC(y, endMonth, 0)).toISOString().slice(0, 10);
  return last < today;
}

export interface OpsRates {
  utilization: number | null;
  rebookAtCheckout: number | null;
  avgTicketCents: number | null;
  retailPerServiceTicketCents: number | null;
  retailAttach: number | null;
  chairHourCents: number | null;
  avgWaitMin: number | null;
  onTime: number | null;
  satisfaction: number | null;
  lifetimeValueCents: number | null;
  lifetimeVisits: number | null;
}

const ratio = (a: number, b: number) => (b ? a / b : null);

export function opsRates(o: Ops, x: { netSalesCents: number; tickets: number; refundCents: number }, bookedMin: number, availableMin: number): OpsRates {
  return {
    utilization: ratio(bookedMin, availableMin),
    rebookAtCheckout: ratio(o.rebookedAtCheckout, o.visits),
    avgTicketCents: x.tickets ? Math.round((x.netSalesCents + x.refundCents) / x.tickets) : null,
    retailPerServiceTicketCents: o.serviceTickets ? Math.round(o.retailOnServiceCents / o.serviceTickets) : null,
    retailAttach: ratio(o.retailAttached, o.serviceTickets),
    chairHourCents: availableMin ? Math.round(x.netSalesCents / (availableMin / 60)) : null,
    avgWaitMin: o.waited ? Math.round((o.waitMinutes / o.waited) * 10) / 10 : null,
    onTime: ratio(o.onTime, o.starts),
    satisfaction: o.ratings ? Math.round((o.stars / o.ratings) * 100) / 100 : null,
    lifetimeValueCents: o.clientsSeen ? Math.round(o.lifetimeCents / o.clientsSeen) : null,
    lifetimeVisits: o.clientsSeen ? Math.round((o.lifetimeVisits / o.clientsSeen) * 10) / 10 : null,
  };
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export async function operationsData(scope: ReportScope, loc: ViewCtx, now = new Date()): Promise<ReportData> {
  const grains = grainsFor(loc);
  const [ops, sales, kpis, avail, cohortRows] = await Promise.all([
    opsAt(scope, grains),
    salesTotalsAt(scope, grains),
    kpisAt(scope, grains),
    availableMinutesAt(scope, grains),
    cohorts(scope, { byShop: loc.view === "shops", byStaff: loc.byBarber }),
  ]);
  const keys = [...new Set([...Object.keys(ops), ...Object.keys(sales), ...Object.keys(kpis), ...Object.keys(avail)])];
  const rate: Record<string, OpsRates & { o: Ops; booked: number; available: number }> = Object.fromEntries(
    keys.map((k) => {
      const o = ops[k] ?? ZERO;
      const booked = (kpis[k] ?? emptyKpis(scope)).bookedMinutes;
      const available = avail[k] ?? 0;
      return [k, { ...opsRates(o, sales[k] ?? ZERO_SALES(), booked, available), o, booked, available }];
    }),
  );
  type R = (typeof rate)[string];
  const m = (label: string, kind: ColumnKind, f: (x: R) => number | null, additive?: boolean): Metric => ({
    label,
    kind,
    at: Object.fromEntries(Object.entries(rate).map(([k, x]) => [k, f(x)])),
    additive,
  });
  const t = rate[TOTAL];
  const today = localDateOf(now);
  const named = viewOf(loc);
  const cohortTable = listTable(loc, {
    id: "cohorts",
    title: `Retention by first-visit month${named === "combined" ? "" : named === "shops" ? " by location" : named === "barbers" ? " by barber" : " by location and barber"}`,
    subtitle: "New clients by the month of their first visit here, and the share who came back within 1, 3, 6 and 12 months. A dash means that window hasn't closed yet.",
    columns: [
      { label: "First-visit month" },
      { label: "New clients", kind: "int" },
      ...COHORT_MONTHS.flatMap((n) => [
        { label: `Back within ${n} mo`, kind: "int" as const },
        { label: `${n}-month retention`, kind: "pct" as const, sum: false },
      ]),
    ],
    rows: cohortRows.map(
      (c): ListRow => ({
        shopId: c.shopId ?? loc.shops[0]?.id ?? "",
        staffId: loc.byBarber ? c.staffId : undefined,
        key: c.month,
        cells: [c.month, c.clients, ...COHORT_MONTHS.flatMap((n) => [c.back[n], null])],
      }),
    ),
    merge: true,
    totals: false,
    derive: (cells: Cell[]) =>
      cells.map((v, i) => {
        if (i < 2 || (i - 2) % 2 === 0) return v;
        const n = COHORT_MONTHS[(i - 3) / 2];
        const month = typeof cells[0] === "string" ? cells[0] : null;
        const clients = typeof cells[1] === "number" ? cells[1] : 0;
        return month && clients && cohortWindowClosed(month, n, today) ? (cells[i - 1] as number) / clients : null;
      }),
  });
  return {
    stats: [
      { label: "Utilization", value: pct(t?.utilization ?? null), hint: t ? `${Math.round(t.booked / 60)} of ${Math.round(t.available / 60)} scheduled hours booked` : undefined },
      { label: "Rebooked at checkout", value: pct(t?.rebookAtCheckout ?? null), hint: t ? `${t.o.rebookedAtCheckout} of ${t.o.visits} visits` : undefined },
      { label: "Average ticket", value: t?.avgTicketCents != null ? formatCents(t.avgTicketCents) : "—", hint: t?.retailPerServiceTicketCents != null ? `${formatCents(t.retailPerServiceTicketCents)} retail per service ticket` : undefined },
      { label: "Revenue per chair hour", value: t?.chairHourCents != null ? formatCents(t.chairHourCents) : "—" },
      {
        label: "On-time starts",
        value: pct(t?.onTime ?? null),
        hint: t?.avgWaitMin != null ? `${t.avgWaitMin} min average wait from arrival` : undefined,
      },
      ...(t && t.o.ratings ? [{ label: "Post-visit rating", value: `${t.satisfaction} / 5`, hint: `${t.o.ratings} ratings` }] : []),
    ],
    tables: [
      metricTable(loc, {
        id: "operations",
        title: `Operations KPIs${named === "combined" ? "" : named === "shops" ? " by location" : named === "barbers" ? " by barber" : " by location and barber"}`,
        subtitle:
          "Utilization is booked time over scheduled time. Rebooked at checkout: the client's next visit was booked between the start of this one and 15 minutes after checkout. Lifetime value is what the clients seen in the range have spent here in all, after refunds.",
        metrics: [
          m("Utilization", "pct", (x) => x.utilization),
          m("Booked hours", "hours", (x) => x.booked / 60),
          m("Scheduled hours", "hours", (x) => x.available / 60),
          m("Rebooked at checkout", "pct", (x) => x.rebookAtCheckout),
          m("Visits", "int", (x) => x.o.visits),
          m("Visits rebooked at checkout", "int", (x) => x.o.rebookedAtCheckout),
          m("Average ticket", "money", (x) => x.avgTicketCents, false),
          m("Retail per service ticket", "money", (x) => x.retailPerServiceTicketCents, false),
          m("Service tickets with retail", "pct", (x) => x.retailAttach),
          m("Revenue per chair hour", "money", (x) => x.chairHourCents, false),
          m("Average wait (min)", "decimal", (x) => x.avgWaitMin),
          m("On-time starts", "pct", (x) => x.onTime),
          m("Post-visit rating", "decimal", (x) => x.satisfaction),
          m("Ratings", "int", (x) => x.o.ratings),
          m("Client lifetime value", "money", (x) => x.lifetimeValueCents, false),
          m("Lifetime visits per client", "decimal", (x) => x.lifetimeVisits),
          m("Clients seen", "int", (x) => x.o.clientsSeen, false),
        ],
      }),
      cohortTable,
    ],
    notes: [
      "Worked out from appointments, service times and tickets, so any past range works. The raw events behind them are in the event log (Insights > Event log), and in custom reports as the Events source.",
    ],
  };
}
