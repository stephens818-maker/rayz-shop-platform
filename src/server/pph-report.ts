import "server-only";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff, timeEntries } from "@/db/schema";
import { dailyHours } from "@/domain/payroll/overtime";
import {
  CLIENTS_LABEL,
  NA,
  PPH_LABEL,
  PPH_RANKS,
  PPH_TREND_LABEL,
  PPH_TRENDS,
  RANK_LABEL,
  type Bucket,
  type Pph,
  type PphOrder,
  type PphRank,
  clientsText,
  parsePphOrder,
  parsePphRank,
  parsePphTrend,
  pphCents,
  pphOf,
  pphSort,
  rankPph,
  trendBuckets,
} from "@/domain/pph";
import type { Cell, Column, ReportTable, RowStyle, ViewCtx } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { type LocalDate, addDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";
import { periodsEnding, payPeriodPresets } from "./payroll/periods";
import type { ReportData, ReportOption } from "./report-data";
import { PAID, type ReportScope, rows, staffFilter, staffSelection, uuids } from "./report-sql";
import { payrollSalesBetween } from "./reports";
import { brandShopIds } from "./rebook-report";
import { serviceTicketDays } from "./service-tickets";
import { squireEra } from "./squire-era";

/**
 * Productivity Per Hour (src/domain/pph.ts) from the live data: worked hours from the time clock,
 * read day by day as payroll reads them, service and product sales as payroll credits them
 * (payrollSalesBetween: net of discounts and refunds, before tax and tips), plus tickets imported
 * from Squire, which payroll leaves out because Squire paid them but which are still sales, and
 * completed service tickets (src/server/service-tickets.ts) for clients per hour.
 */

/** One person at one shop over a range: worked centi-hours, sales in cents and completed service tickets. */
export interface PphRow {
  staffId: string;
  shopId: string;
  centi: number;
  serviceCents: number;
  productCents: number;
  clients: number;
}

type Sel = Pick<ReportScope, "shopIds" | "staffId" | "staffIds">;
const k2 = (staffId: string, shopId: string) => `${staffId}|${shopId}`;

/** Worked centi-hours per person, shop and day in [from, to]: each day's punches rounded to hundredths, as payroll adds them up. */
export async function workedDays(s: Sel, from: LocalDate, to: LocalDate): Promise<{ staffId: string; shopId: string; date: LocalDate; centi: number }[]> {
  const sel = staffSelection(s);
  if (!s.shopIds.length || (sel && !sel.length)) return [];
  const list = await db
    .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.kind, "worked"),
        inArray(timeEntries.shopId, s.shopIds),
        sel ? inArray(timeEntries.staffId, sel) : undefined,
        lt(timeEntries.startsAt, endOfLocalDay(to)),
        gt(timeEntries.endsAt, startOfLocalDay(from)),
      ),
    );
  return dailyHours(list)
    .filter((d) => d.date >= from && d.date <= to && d.worked > 0)
    .map((d) => ({ staffId: d.staffId, shopId: d.shopId, date: d.date, centi: d.worked }));
}

/** Net service and product sales on Squire-era tickets per person, shop and business day. */
async function squireDays(s: Sel, from: LocalDate, to: LocalDate) {
  if (!s.shopIds.length) return [];
  return rows<{ staffId: string; shopId: string; date: LocalDate; sn: number; pn: number }>(sql`
    select s.staff_id "staffId", s.shop_id "shopId", s.business_date::text date, sum(s.service_net_cents)::int sn, sum(s.product_net_cents)::int pn
    from sales s
    where s.shop_id in ${uuids(s.shopIds)} and s.business_date between ${from} and ${to} and s.status in ${PAID}
      and s.staff_id is not null and ${squireEra()} ${staffFilter(sql`s.staff_id`, s)}
    group by 1, 2, 3`);
}

/** Sales per person and shop over [from, to]: payroll's, plus the Squire-era tickets of those days. */
async function salesBetween(s: Sel, from: LocalDate, to: LocalDate, squire: Awaited<ReturnType<typeof squireDays>>) {
  const out = new Map<string, { service: number; product: number }>();
  const add = (staffId: string, shopId: string, service: number, product: number) => {
    const v = out.get(k2(staffId, shopId)) ?? { service: 0, product: 0 };
    v.service += service;
    v.product += product;
    out.set(k2(staffId, shopId), v);
  };
  if (s.shopIds.length) for (const r of await payrollSalesBetween(s, from, to)) add(r.staffId, r.shopId, r.serviceSalesCents, r.productSalesCents);
  for (const r of squire) if (r.date >= from && r.date <= to) add(r.staffId, r.shopId, r.sn, r.pn);
  return out;
}

type Tickets = Awaited<ReturnType<typeof serviceTicketDays>>;

function rowsOf(days: Awaited<ReturnType<typeof workedDays>>, tickets: Tickets, sales: Map<string, { service: number; product: number }>, from: LocalDate, to: LocalDate): PphRow[] {
  const out = new Map<string, PphRow>();
  const at = (staffId: string, shopId: string) => {
    const k = k2(staffId, shopId);
    if (!out.has(k)) out.set(k, { staffId, shopId, centi: 0, serviceCents: 0, productCents: 0, clients: 0 });
    return out.get(k)!;
  };
  for (const d of days) if (d.date >= from && d.date <= to) at(d.staffId, d.shopId).centi += d.centi;
  for (const t of tickets) if (t.date >= from && t.date <= to) at(t.staffId, t.shopId).clients += t.n;
  for (const [k, v] of sales) {
    if (!v.service && !v.product) continue;
    const [staffId, shopId] = k.split("|");
    const r = at(staffId, shopId);
    r.serviceCents += v.service;
    r.productCents += v.product;
  }
  return [...out.values()];
}

/** Each person's hours, sales and service tickets at each shop over [from, to]. */
export async function pphRows(s: Sel, from: LocalDate, to: LocalDate): Promise<PphRow[]> {
  const [days, squire, tickets] = await Promise.all([workedDays(s, from, to), squireDays(s, from, to), serviceTicketDays(s, from, to)]);
  return rowsOf(days, tickets, await salesBetween(s, from, to, squire), from, to);
}

/** The same, for each period of a trend, from one read of the hours and tickets. */
async function pphTrendRows(s: Sel, from: LocalDate, to: LocalDate, buckets: readonly Bucket[]): Promise<{ range: PphRow[]; buckets: PphRow[][] }> {
  const [days, squire, tickets] = await Promise.all([workedDays(s, from, to), squireDays(s, from, to), serviceTicketDays(s, from, to)]);
  const [range, ...each] = await Promise.all([salesBetween(s, from, to, squire), ...buckets.map((b) => salesBetween(s, b.start, b.end, squire))]);
  return { range: rowsOf(days, tickets, range, from, to), buckets: buckets.map((b, i) => rowsOf(days, tickets, each[i], b.start, b.end)) };
}

export const totalOf = (xs: readonly PphRow[]): Pph =>
  pphCents(
    xs.reduce((a, r) => a + r.serviceCents, 0),
    xs.reduce((a, r) => a + r.productCents, 0),
    xs.reduce((a, r) => a + r.centi, 0),
    xs.reduce((a, r) => a + r.clients, 0),
  );

// ───────────────────────────── The report ─────────────────────────────

const option = (param: string, label: string, value: string, choices: [string, string][]): ReportOption => ({ param, label, value, choices: choices.map(([v, l]) => ({ value: v, label: l })) });
const ORDER_LABEL: Record<PphOrder, string> = { high: "Highest first", low: "Lowest first" };
const naCell = (v: number | null): Cell => (v === null ? NA : v);

const money = (label: string): Column => ({ label, kind: "money" });
const rate = (label: string, k: PphRank = "service"): Column => ({ label, kind: k === "clients" ? "decimal" : "money", sum: false });
/** In the order pphSort expects (src/domain/pph.ts). */
const figureColumns: Column[] = [
  { label: "Worked hours", kind: "pay_hours", sum: true },
  money("Service sales"),
  money("Product sales"),
  { label: "Service tickets", kind: "int", sum: true },
  rate(PPH_LABEL.service),
  rate(CLIENTS_LABEL, "clients"),
  rate(PPH_LABEL.product),
  rate(PPH_LABEL.total),
];
const figures = (p: Pph): Cell[] => [p.hours, p.service, p.product, p.clients, naCell(p.servicePph), naCell(p.clientsPerHour), naCell(p.productPph), naCell(p.totalPph)];
/** Pay periods for a trend, one calendar's worth: where shops' calendars differ, a period overlapping the one before is left out. */
async function trendPeriods(shopIds: readonly string[], from: LocalDate, to: LocalDate) {
  const { periods } = await periodsEnding(from, addDays(to, 40), shopIds);
  const out: { start: LocalDate; end: LocalDate }[] = [];
  for (const p of periods) if (p.start <= to && (!out.length || p.start > out[out.length - 1].end)) out.push(p);
  return out;
}

async function labelsOf(ids: string[]) {
  return new Map((ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : []).map((s) => [s.id, s.label]));
}

export interface PphViewer {
  /** Has every shop in the brand: the brand's own PPH shows alongside. */
  brandWide: boolean;
}

/**
 * The PPH report: per barber (across the selected shops, or per shop by location), per location and
 * for the brand, over any range or pay period, ranked by service PPH (the default), clients per hour,
 * product or total PPH, with a trend by day, week, month or pay period.
 */
export async function pphReportData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>, viewer: PphViewer): Promise<ReportData> {
  const measure: PphRank = parsePphRank(params.rank);
  const order: PphOrder = parsePphOrder(params.order);
  let { grain, coarsened } = parsePphTrend(params.trend, scope.from, scope.to);
  const periods = grain === "period" ? await trendPeriods(scope.shopIds, scope.from, scope.to) : [];
  if (grain === "period" && !periods.length) [grain, coarsened] = ["week", true];
  const buckets = trendBuckets(scope.from, scope.to, grain, periods);

  const allIds = viewer.brandWide ? await brandShopIds() : [];
  const whole = viewer.brandWide && !staffSelection(scope) && allIds.every((id) => scope.shopIds.includes(id));
  const showBrand = viewer.brandWide && !whole;
  const [mine, brand, presets] = await Promise.all([
    pphTrendRows(scope, scope.from, scope.to, buckets),
    showBrand ? pphTrendRows({ shopIds: allIds }, scope.from, scope.to, buckets) : null,
    payPeriodPresets(undefined, scope.shopIds),
  ]);
  const list = mine.range;
  const name = await labelsOf([...new Set(list.map((r) => r.staffId))]);
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));
  const multiShop = loc.shops.length > 1;
  const total = totalOf(list);
  const brandTotal = brand ? totalOf(brand.range) : null;
  const value = (p: Pph) => pphOf(p, measure);
  const m = RANK_LABEL[measure];
  const brandLabel = "Brand";

  const tail = (): { rows: Cell[][]; styles: (RowStyle | undefined)[] } => ({
    rows: [[null, loc.totalLabel, ...figures(total)], ...(brandTotal ? [[null, brandLabel, ...figures(brandTotal)]] : [])],
    styles: ["total", ...(brandTotal ? (["total"] as const) : [])],
  });

  // Barbers: across the selected shops, or ranked within each shop by location.
  const byStaff = (rs: readonly PphRow[]) => {
    const g = new Map<string, PphRow[]>();
    for (const r of rs) g.set(r.staffId, [...(g.get(r.staffId) ?? []), r]);
    return [...g].map(([staffId, xs]) => ({ staffId, name: name.get(staffId) ?? "Unknown", shops: xs.map((x) => x.shopId), p: totalOf(xs) }));
  };
  const rankRows = (xs: ReturnType<typeof byStaff>) => rankPph(xs, (x) => value(x.p), (x) => x.name, order);
  const perShop = multiShop && loc.view === "shops";
  const barberTable: ReportTable = perShop
    ? (() => {
        const out: Cell[][] = [];
        const styles: (RowStyle | undefined)[] = [];
        for (const s of loc.shops) {
          const here = list.filter((r) => r.shopId === s.id);
          if (!here.length) continue;
          for (const x of rankRows(byStaff(here))) {
            out.push([s.name, x.rank, x.item.name, ...figures(x.item.p)]);
            styles.push(undefined);
          }
          out.push([s.name, null, "Subtotal", ...figures(totalOf(here))]);
          styles.push("subtotal");
        }
        out.push([loc.totalLabel, null, null, ...figures(total)]);
        styles.push("total");
        if (brandTotal) {
          out.push([brandLabel, null, null, ...figures(brandTotal)]);
          styles.push("total");
        }
        return {
          id: "barbers",
          title: `Barbers by location: ${m}`,
          subtitle: "Ranked within each location: each barber's sales there over their hours there.",
          columns: [{ label: "Location" }, { label: "Rank", kind: "int", sum: false }, { label: "Barber" }, ...figureColumns],
          rows: out,
          rowStyles: styles,
          ...pphSort(3, measure, order),
        };
      })()
    : (() => {
        const ranked = rankRows(byStaff(list));
        const t = tail();
        return {
          id: "barbers",
          title: `Barber leaderboard: ${m}`,
          subtitle: multiShop ? "Each barber across the selected locations: their sales there over their hours there." : undefined,
          columns: [{ label: "Rank", kind: "int", sum: false }, { label: "Barber" }, ...(multiShop ? [{ label: "Locations" }] : []), ...figureColumns],
          rows: [
            ...ranked.map((x) => [x.rank, x.item.name, ...(multiShop ? [x.item.shops.map((id) => shopName.get(id) ?? "").join(", ")] : []), ...figures(x.item.p)]),
            ...t.rows.map((r) => (multiShop ? [...r.slice(0, 2), null, ...r.slice(2)] : r)),
          ],
          rowStyles: [...ranked.map(() => undefined), ...t.styles],
          ...pphSort(multiShop ? 3 : 2, measure, order),
        };
      })();

  const shopsRanked = rankPph(
    loc.shops.map((s) => {
      const here = list.filter((r) => r.shopId === s.id);
      return { name: s.name, barbers: new Set(here.filter((r) => r.centi > 0).map((r) => r.staffId)).size, p: totalOf(here) };
    }),
    (x) => value(x.p),
    (x) => x.name,
    order,
  );
  const shopTable: ReportTable = {
    id: "locations",
    title: `Location leaderboard: ${m}`,
    subtitle: "Each location's sales over every hour worked there.",
    columns: [{ label: "Rank", kind: "int", sum: false }, { label: "Location" }, { label: "Barbers with hours", kind: "int", sum: false }, ...figureColumns],
    rows: [
      ...shopsRanked.map((x) => [x.rank, x.item.name, x.item.barbers, ...figures(x.item.p)]),
      [null, loc.totalLabel, new Set(list.filter((r) => r.centi > 0).map((r) => r.staffId)).size, ...figures(total)],
      ...(brandTotal ? [[null, brandLabel, null, ...figures(brandTotal)]] : []),
    ],
    rowStyles: [...shopsRanked.map(() => undefined), "total", ...(brandTotal ? (["total"] as const) : [])],
    ...pphSort(3, measure, order),
  };

  const tr = mine.buckets.map(totalOf);
  const btr = brand ? brand.buckets.map(totalOf) : null;
  const trendTable: ReportTable = {
    id: "trend",
    title: `Trend: ${PPH_TREND_LABEL[grain].toLowerCase()}`,
    subtitle: "Each period on its own: its sales over its worked hours. N/A where nobody worked.",
    columns: [{ label: grain === "day" ? "Day" : grain === "week" ? "Week" : grain === "month" ? "Month" : "Pay period" }, ...figureColumns, ...(btr ? [rate(`Brand ${m}`, measure)] : [])],
    rows: buckets.map((b, i) => [b.label, ...figures(tr[i]), ...(btr ? [naCell(value(btr[i]))] : [])]),
  };
  const shopTrend: ReportTable = {
    id: "trend_locations",
    title: `${m} by location: ${PPH_TREND_LABEL[grain].toLowerCase()}`,
    columns: [{ label: trendTable.columns[0].label }, ...loc.shops.map((s) => rate(s.name, measure)), rate(loc.totalLabel, measure)],
    rows: buckets.map((b, i) => [b.label, ...loc.shops.map((s) => naCell(value(totalOf(mine.buckets[i].filter((r) => r.shopId === s.id))))), naCell(value(tr[i]))]),
  };

  const labels = buckets.map((b) => b.label);
  const shown = (k: PphRank, v: number) => (k === "clients" ? clientsText(v) : formatCents(v));
  const vs = (k: PphRank, x: number | null, y: number | null | undefined) =>
    (y === undefined ? "" : ` · brand ${y === null ? NA : shown(k, y)}`) + (x !== null && y !== null && y !== undefined && y ? ` (${x >= y ? "+" : "−"}${shown(k, Math.abs(x - y))})` : "");
  const what: Record<PphRank, string> = {
    service: "PPH, the default: service sales per worked hour",
    clients: `${total.clients.toLocaleString("en-US")} completed service tickets per worked hour`,
    product: "product sales per worked hour",
    total: "service and product sales per worked hour",
  };
  const stat = (k: PphRank) => {
    const v = pphOf(total, k);
    return { label: RANK_LABEL[k], value: v === null ? NA : shown(k, v), hint: `${what[k]}${vs(k, v, brandTotal ? pphOf(brandTotal, k) : undefined)}` };
  };
  const noHours = list.filter((r) => r.centi === 0 && (r.serviceCents || r.productCents || r.clients)).length;

  return {
    stats: [
      ...PPH_RANKS.map(stat),
      { label: "Worked hours", value: total.hours.toLocaleString("en-US", { maximumFractionDigits: 2 }), hint: noHours ? `${noHours} with sales but no worked hours: N/A` : "clocked, regular and overtime" },
    ],
    options: [
      option(
        "rank",
        "Rank by",
        measure,
        PPH_RANKS.map((k) => [k, RANK_LABEL[k]]),
      ),
      option("order", "Order", order, [
        ["high", ORDER_LABEL.high],
        ["low", ORDER_LABEL.low],
      ]),
      option(
        "trend",
        "Trend",
        grain,
        PPH_TRENDS.map((g) => [g, PPH_TREND_LABEL[g]]),
      ),
    ],
    presets: [
      { id: "yesterday", label: "Yesterday" },
      { id: "week", label: "This week" },
      { id: "30d", label: "Last 30 days" },
      { id: "month", label: "This month" },
      { id: "lastmonth", label: "Last month" },
      ...presets,
    ],
    charts: [
      {
        id: "trend_pph",
        title: `Service and product PPH: ${PPH_TREND_LABEL[grain].toLowerCase()}`,
        kind: "money",
        labels,
        series: [
          { label: PPH_LABEL.service, values: tr.map((p) => p.servicePph) },
          { label: PPH_LABEL.product, values: tr.map((p) => p.productPph), tone: "alt" },
        ],
      },
      {
        id: "trend_clients",
        title: btr ? `${CLIENTS_LABEL} against the brand` : `${CLIENTS_LABEL}: ${PPH_TREND_LABEL[grain].toLowerCase()}`,
        kind: "number",
        labels,
        series: [
          { label: btr ? (loc.shops.length === 1 ? loc.shops[0].name : loc.totalLabel) : CLIENTS_LABEL, values: tr.map((p) => p.clientsPerHour) },
          ...(btr ? [{ label: "Brand", values: btr.map((p) => p.clientsPerHour), dashed: true }] : []),
        ],
      },
      {
        id: "trend_total",
        title: btr && measure !== "clients" ? `${m} against the brand` : `${PPH_LABEL.total}: ${PPH_TREND_LABEL[grain].toLowerCase()}`,
        kind: "money",
        labels,
        series:
          btr && measure !== "clients"
            ? [
                { label: loc.shops.length === 1 ? loc.shops[0].name : loc.totalLabel, values: tr.map(value) },
                { label: "Brand", values: btr.map(value), dashed: true },
              ]
            : [{ label: PPH_LABEL.total, values: tr.map((p) => p.totalPph) }],
      },
    ],
    tables: [barberTable, ...(multiShop ? [shopTable] : []), trendTable, ...(multiShop ? [shopTrend] : [])],
    notes: [
      "Productivity Per Hour (PPH) is sales per clocked worked hour. PPH on its own is service PPH, the default: service sales before tax and tips, net of discounts and refunds, over regular and overtime hours from the time clock (training and PTO aren't working time). Product PPH is product sales over the same hours, and total PPH both. A total is the sales added up over the hours added up, never an average of PPHs.",
      "Clients per hour is completed service tickets over the same worked hours: paid or partly refunded tickets with a service on them, credited to the ticket's barber on the day it was sold. Fully refunded and voided tickets don't count, and a family ticket is one ticket.",
      "N/A means no worked hours in the range: sales with no hours aren't ranked and are listed last. Equal PPHs (or clients per hour, to the hundredth) share a rank.",
      "Over a pay period the hours and sales are the Payroll Report's before any typed-over figures, so its PPH columns match unless the commission base adds the card fee or loyalty rewards (I10) or there are tickets imported from Squire: those count here, on the days they were sold, but not in payroll's sales. Its clients per hour counts the same tickets as here.",
      ...(coarsened ? [`The range is too long for that trend, so it's shown ${PPH_TREND_LABEL[grain].toLowerCase()}.`] : []),
      ...(whole ? ["This is every location and barber, so the total is the brand."] : []),
    ],
  };
}
