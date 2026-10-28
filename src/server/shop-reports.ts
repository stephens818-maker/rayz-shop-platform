import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { shops as shopsTable } from "@/db/schema";
import { NO_BARBER } from "@/domain/barbers";
import { ATTRIBUTION_DAYS, OPERATOR_CHOICE_LABEL, OperatorChoice, cleanOperator, operatorMetrics } from "@/domain/phone-operator";
import { Cell, Column, ColumnKind, ListRow, Metric, ReportTable, TOTAL, ViewCtx, listTable, metricTable, parseSegKey, segKey, staffName, viewOf } from "@/domain/report-views";
import { priorPeriod } from "@/domain/report-range";
import { taxJurisdiction, taxJurisdictionLabel } from "@/domain/location-profile";
import { settingFor } from "./brand-sync/settings";
import { FILING_LABEL, PERIOD_OF, TaxPeriod, filingFor, type FilingFrequency, parsePeriod, periodKey, periodLabel, stateCode, stateName } from "@/domain/sales-tax";
import { formatCents } from "@/lib/money";
import { addDays, diffDays, endOfLocalDay, formatDate, formatTime, startOfLocalDay } from "@/lib/time";
import { availableMinutesAt } from "./available-minutes";
import { drawerSummary } from "./checkout";
import type { ReportData, ReportOption } from "./report-data";
import { Grain, PAID, ReportScope, grainsFor, grp, ids, keyOf, rows, sgrp, staffFilter } from "./report-sql";
import { ZERO_SALES, ZERO_TENDER, emptyKpis, itemMix, kpisAt, refundLog, salesTotalsAt, tenderAt } from "./reports";

/**
 * The shop-level reports that match what a single shop's login gets elsewhere: the end of the day,
 * a barber leaderboard, sales tax by state, client retention, acquisition channels and the phone
 * operator. Every one takes the barber filter; where part of a report has no barber (the cash
 * drawer, calls to the shop) it says so.
 */

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ratio = (a: number, b: number) => (b ? a / b : null);
const money = (label: string): Column => ({ label, kind: "money" });
const int = (label: string): Column => ({ label, kind: "int" });
const text = (label: string): Column => ({ label });
const each = <T>(xs: Record<string, T>, f: (x: T) => number | null) => Object.fromEntries(Object.entries(xs).map(([k, x]) => [k, f(x)]));
const m = <T>(label: string, kind: ColumnKind, xs: Record<string, T>, f: (x: T) => number | null, additive?: boolean): Metric => ({ label, kind, at: each(xs, f), additive });
const SUFFIX = { combined: "", shops: " by location", barbers: " by barber", shops_barbers: " by location and barber" } as const;
const titled = (v: ViewCtx, title: string) => title + SUFFIX[viewOf(v)];
const noBarbers = (v: ViewCtx): ViewCtx => ({ ...v, byBarber: false });
const span = (s: Pick<ReportScope, "from" | "to">) => ({ start: startOfLocalDay(s.from).toISOString(), end: endOfLocalDay(s.to).toISOString() });
const option = (param: string, label: string, value: string, choices: [string, string][]): ReportOption => ({ param, label, value, choices: choices.map(([v, l]) => ({ value: v, label: l })) });

/** Appointment `b` is in the same segment (shop, barber) as row `v` of a grouped query. */
const inSegment = (s: ReportScope, v: string, b: string) =>
  sql`${sql.raw(b)}.shop_id in ${ids(s)} and (${sql.raw(v)}.shop_id is null or ${sql.raw(b)}.shop_id = ${sql.raw(v)}.shop_id)
    and (${sql.raw(v)}.staff_id is null or coalesce(${sql.raw(b)}.staff_id::text, ${NO_BARBER}) = ${sql.raw(v)}.staff_id) ${staffFilter(sql.raw(`${b}.staff_id`), s)}`;

// ───────────────────────────── End of day ─────────────────────────────

/**
 * One day's close (or any range): sales, tax and tips, how it was paid, each barber's tickets and
 * tips, refunds and voids, and every shop's cash drawer. The drawer is the shop's whatever barbers
 * are picked.
 */
export async function endOfDayData(scope: ReportScope, loc: ViewCtx, opts: { personTips?: boolean } = {}): Promise<ReportData> {
  const personTips = opts.personTips ?? true;
  const lv = noBarbers(loc);
  const g = grainsFor(lv);
  const bv: ViewCtx = { ...loc, byBarber: true };
  const bg = grainsFor(bv);
  const n = diffDays(scope.to, scope.from) + 1;
  const days = n <= 7 ? Array.from({ length: n }, (_, i) => addDays(scope.from, i)) : [];
  const [x, tender, bx, btender, log, drawers] = await Promise.all([
    salesTotalsAt(scope, g),
    tenderAt(scope, g),
    salesTotalsAt(scope, bg),
    tenderAt(scope, bg),
    refundLog(scope),
    Promise.all(scope.shopIds.flatMap((shopId) => days.map(async (day) => ({ shopId, day, s: await drawerSummary(shopId, day) })))),
  ]);
  const s = x[TOTAL] ?? ZERO_SALES();
  const t = tender[TOTAL] ?? ZERO_TENDER();
  const expected = drawers.reduce((a, d) => a + d.s.expectedCents, 0);
  const counted = drawers.filter((d) => d.s.drawer?.closedAt);
  const short = counted.reduce((a, d) => a + (d.s.drawer!.varianceCents ?? 0), 0);
  return {
    stats: [
      { label: "Net sales", value: formatCents(s.netSalesCents), hint: `${s.tickets} tickets · avg ${formatCents(s.avgTicketCents)}` },
      { label: "Tax collected", value: formatCents(s.taxCents), hint: s.refundCents ? `after ${formatCents(s.refundCents)} refunds` : undefined },
      { label: "Tips", value: formatCents(s.tipsCents), hint: `card ${formatCents(t.cardTipsCents)} · cash ${formatCents(t.cashTipsCents)}` },
      days.length
        ? { label: "Cash in drawers", value: formatCents(expected), hint: counted.length ? `${counted.length} closed · ${formatCents(short, { sign: true })} over / short` : "expected, none closed yet", tone: short < 0 ? "down" : undefined }
        : { label: "Card / cash", value: `${formatCents(t.cardCents)} / ${formatCents(t.cashCents)}` },
    ],
    tables: [
      metricTable(lv, {
        id: "sales",
        title: titled(lv, "Sales"),
        metrics: [
          m("Tickets", "int", x, (v) => v.tickets),
          m("Gross sales", "money", x, (v) => v.grossSalesCents),
          m("Discounts", "money", x, (v) => v.discountCents),
          m("Refunds", "money", x, (v) => v.refundCents),
          m("Net services", "money", x, (v) => v.netServicesCents),
          m("Net products", "money", x, (v) => v.netProductsCents),
          m("Net sales", "money", x, (v) => v.netSalesCents),
          m("Tax", "money", x, (v) => v.taxCents),
          m("Tips", "money", x, (v) => v.tipsCents),
          m("Card surcharges", "money", x, (v) => v.cardFeeCents),
          m("Gift cards sold", "money", x, (v) => v.giftCardsSoldCents),
          m("Avg ticket", "money", x, (v) => v.avgTicketCents, false),
        ],
      }),
      metricTable(lv, {
        id: "payments",
        title: titled(lv, "How it was paid"),
        subtitle: "After refunds, with tips and surcharges.",
        label: "Tender",
        metrics: [
          m("Card (credit)", "money", tender, (v) => v.cardCreditCents),
          m("Card (debit / prepaid)", "money", tender, (v) => v.cardDebitCents),
          m("Cash", "money", tender, (v) => v.cashCents),
          m("Gift card", "money", tender, (v) => v.giftCardCents),
          m("Total collected", "money", tender, (v) => v.cardCents + v.cashCents + v.giftCardCents),
        ],
      }),
      metricTable(bv, {
        id: "barbers",
        title: loc.view === "shops" ? "Each barber's day by location" : "Each barber's day",
        subtitle: personTips
          ? "Tickets and tips go to the barber on the ticket. Reassigned tickets count for the barber they were moved to."
          : "Tickets go to the barber on the ticket. Each person's tips are pay data, shown at the brand level. Reassigned tickets count for the barber they were moved to.",
        metrics: [
          m("Tickets", "int", bx, (v) => v.tickets),
          m("Services", "money", bx, (v) => v.netServicesCents),
          m("Products", "money", bx, (v) => v.netProductsCents),
          ...(personTips
            ? [m("Card tips", "money", btender, (v) => v.cardTipsCents), m("Cash tips", "money", btender, (v) => v.cashTipsCents), m("Total tips", "money", bx, (v) => v.tipsCents)]
            : []),
          m("Discounts", "money", bx, (v) => v.discountCents),
          m("Refunds", "money", bx, (v) => v.refundCents),
          m("Avg ticket", "money", bx, (v) => v.avgTicketCents, false),
        ],
      }),
      listTable(loc, {
        id: "refunds",
        title: "Refunds and voids",
        subtitle: log.length >= 2000 ? "Showing the latest 2,000." : undefined,
        columns: [text("Date"), { label: "Ticket", kind: "int", sum: false }, text("Barber"), text("Kind"), text("Tender"), money("Amount"), text("Reason"), text("Issued by"), text("Approved by")],
        rows: log.map((r) => ({ shopId: r.shopId, staffId: r.staffId, cells: [r.day, r.number, r.barber, r.kind, r.method, r.amountCents, r.reason, r.by, r.approvedBy] })),
        keepShop: loc.shops.length > 1,
      }),
      ...(days.length
        ? [
            listTable(lv, {
              id: "drawer",
              title: "Cash drawer",
              subtitle: "The shop's drawer, whichever barbers are picked. Expected is the opening balance plus cash sales, less cash refunds, paid-outs and cash tip payouts.",
              columns: [text("Date"), money("Opening"), money("Cash sales"), money("Cash refunds"), money("Paid out"), money("Tip payouts"), money("Expected"), money("Counted"), money("Over / short"), text("Status")],
              rows: drawers.map(({ shopId, day, s: d }) => ({
                shopId,
                key: day,
                cells: [
                  day,
                  d.openingFloatCents,
                  d.cashSalesCents,
                  d.cashRefundsCents,
                  d.payoutsCents,
                  d.tipPayoutsCents,
                  d.expectedCents,
                  d.drawer?.closedAt ? (d.drawer.countedCents ?? 0) : null,
                  d.drawer?.closedAt ? (d.drawer.varianceCents ?? 0) : null,
                  d.drawer?.closedAt ? `Closed ${formatTime(d.drawer.closedAt)}` : d.opened ? "Open" : "Not opened",
                ],
              })),
              keepShop: loc.shops.length > 1,
            }),
          ]
        : []),
    ],
    notes: days.length ? undefined : ["The cash drawer is shown for ranges of a week or less. The Cash drawer report has every close."],
  };
}

// ───────────────────────────── Leaderboard ─────────────────────────────

type Board = { service: number; product: number; tickets: number; avgTicket: number; retailTickets: number; newClients: number; booked: number; available: number };
const RANK_BY = {
  service: { label: "Service sales", kind: "money", get: (b: Board) => b.service },
  product: { label: "Product sales", kind: "money", get: (b: Board) => b.product },
  productivity: { label: "Productivity", kind: "pct", get: (b: Board) => ratio(b.booked, b.available) },
  avg_ticket: { label: "Average ticket", kind: "money", get: (b: Board) => (b.tickets ? b.avgTicket : null) },
  new_clients: { label: "New clients", kind: "int", get: (b: Board) => b.newClients },
  retail: { label: "Tickets with retail", kind: "int", get: (b: Board) => b.retailTickets },
} as const satisfies Record<string, { label: string; kind: ColumnKind; get: (b: Board) => number | null }>;
type RankBy = keyof typeof RANK_BY;
const isRankBy = (v: unknown): v is RankBy => typeof v === "string" && v in RANK_BY;
const shown = (kind: ColumnKind, v: number | null) => (v === null ? "—" : kind === "money" ? formatCents(v) : kind === "pct" ? pct(v) : String(v));

/**
 * Barbers ranked on one measure (service sales by default), with every other measure alongside,
 * the leader in each, and the top services and products. Productivity is booked time against the
 * time they were scheduled to be available. By location ranks barbers within each shop.
 */
export async function leaderboardData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>): Promise<ReportData> {
  const rankBy: RankBy = isRankBy(params.rank) ? params.rank : "service";
  const byShop = loc.view === "shops";
  const grains: Grain[] = [{ byStaff: true }, {}, ...(byShop ? [{ byShop: true, byStaff: true }] : [])];
  const [x, k, avail, items, itemsBy] = await Promise.all([
    salesTotalsAt(scope, grains),
    kpisAt(scope, grains),
    availableMinutesAt(scope, grains),
    itemMix(scope, {}),
    itemMix(scope, { byStaff: true }),
  ]);
  const board = (key: string): Board => {
    const s = x[key] ?? ZERO_SALES();
    const kp = k[key] ?? emptyKpis(scope);
    return { service: s.netServicesCents, product: s.netProductsCents, tickets: s.tickets, avgTicket: s.avgTicketCents, retailTickets: s.productTickets, newClients: kp.newClients, booked: kp.bookedMinutes, available: avail[key] ?? 0 };
  };
  const barbers = [...new Set([...Object.keys(x), ...Object.keys(k), ...Object.keys(avail)])].map((key) => ({ key, ...parseSegKey(key) })).filter((p) => p.staffId && p.staffId !== NO_BARBER);
  const keys = barbers.filter((p) => (byShop ? p.shopId : !p.shopId));
  const name = (id: string) => staffName(loc, id);
  const shopName = new Map(loc.shops.map((s) => [s.id, s.name]));
  const r = RANK_BY[rankBy];
  const rank = (a: { key: string }, b: { key: string }) => (r.get(board(b.key)) ?? -1) - (r.get(board(a.key)) ?? -1) || name(parseSegKey(a.key).staffId!).localeCompare(name(parseSegKey(b.key).staffId!));
  const groups = byShop ? loc.shops.map((s) => keys.filter((p) => p.shopId === s.id)) : [keys];
  const columns: Column[] = [
    { label: "Rank", kind: "int", sum: false },
    ...(byShop ? [text("Location")] : []),
    text("Barber"),
    money("Service sales"),
    money("Product sales"),
    int("Tickets"),
    { label: "Avg ticket", kind: "money", sum: false },
    int("Tickets with retail"),
    { label: "Retail attach", kind: "pct" },
    { label: "New clients", kind: "int", sum: false },
    { label: "Productivity", kind: "pct" },
    { label: "Service sales per available hour", kind: "money", sum: false },
  ];
  const line = (b: Board): Cell[] => [
    b.service,
    b.product,
    b.tickets,
    b.tickets ? b.avgTicket : null,
    b.retailTickets,
    ratio(b.retailTickets, b.tickets),
    b.newClients,
    ratio(b.booked, b.available),
    b.available ? Math.round(b.service / (b.available / 60)) : null,
  ];
  const out: Cell[][] = [];
  const styles: ("total" | undefined)[] = [];
  const unassigned = Object.keys(x)
    .map((key) => ({ key, ...parseSegKey(key) }))
    .filter((p) => p.staffId === NO_BARBER && (byShop ? p.shopId : !p.shopId) && (x[p.key]?.tickets ?? 0) > 0);
  for (const [gi, g] of groups.entries()) {
    [...g].sort(rank).forEach((p, i) => {
      out.push([i + 1, ...(byShop ? [shopName.get(p.shopId!) ?? ""] : []), name(p.staffId!), ...line(board(p.key))]);
      styles.push(undefined);
    });
    for (const p of unassigned.filter((u) => !byShop || u.shopId === loc.shops[gi].id)) {
      out.push([null, ...(byShop ? [shopName.get(p.shopId!) ?? ""] : []), "No barber", ...line(board(p.key))]);
      styles.push(undefined);
    }
  }
  out.push([null, ...(byShop ? [null] : []), loc.totalLabel, ...line(board(TOTAL))]);
  styles.push("total");

  const people = barbers.filter((p) => !p.shopId);
  const leaders = (Object.keys(RANK_BY) as RankBy[]).map((id) => {
    const d = RANK_BY[id];
    const sorted = people
      .map((p) => ({ p, v: d.get(board(p.key)) }))
      .filter((y) => y.v !== null && y.v > 0)
      .sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
    return { id, label: d.label, kind: d.kind, first: sorted[0], second: sorted[1] };
  });
  const topSeller = (kind: "product" | "service", itemName: string) => {
    const best = itemsBy.filter((i) => (kind === "product" ? i.kind === "product" : i.kind !== "product") && i.name === itemName && i.staffId && i.staffId !== NO_BARBER).sort((a, b) => b.netCents - a.netCents)[0];
    return best ? name(best.staffId!) : null;
  };
  const top = (kind: "product" | "service"): ReportTable => ({
    id: kind === "product" ? "top_products" : "top_services",
    title: kind === "product" ? "Top products" : "Top services",
    columns: [{ label: "Rank", kind: "int", sum: false }, text(kind === "product" ? "Product" : "Service"), int("Qty"), int("Tickets"), money("Net sales"), text("Sold most by")],
    rows: items
      .filter((i) => (kind === "product" ? i.kind === "product" : i.kind !== "product"))
      .sort((a, b) => b.netCents - a.netCents)
      .slice(0, 10)
      .map((i, n) => [n + 1, i.name, i.qty, i.tickets, i.netCents, topSeller(kind, i.name)]),
  });
  const tile = (id: RankBy, label: string) => {
    const l = leaders.find((y) => y.id === id)!;
    return { label, value: l.first ? name(l.first.p.staffId!) : "—", hint: l.first ? shown(l.kind, l.first.v) : undefined };
  };
  return {
    stats: [tile("service", "Top in service sales"), tile("product", "Top in product sales"), tile("productivity", "Most productive"), tile("new_clients", "Most new clients")],
    options: [option("rank", "Rank by", rankBy, (Object.keys(RANK_BY) as RankBy[]).map((id) => [id, RANK_BY[id].label]))],
    tables: [
      {
        id: "leaderboard",
        title: `${byShop ? "Leaderboard by location" : "Leaderboard"}: ${r.label.toLowerCase()}`,
        subtitle: "Productivity: hours booked against hours scheduled, less closures and time off. Service sales per available hour uses the same hours. Barbers at more than one shop are added up across the shops picked.",
        columns,
        rows: out,
        rowStyles: styles,
      },
      {
        id: "leaders",
        title: "Leaders",
        columns: [text("Measure"), text("Leader"), text("Value"), text("Runner-up"), text("Value")],
        rows: leaders.map((l) => [l.label, l.first ? name(l.first.p.staffId!) : null, l.first ? shown(l.kind, l.first.v) : null, l.second ? name(l.second.p.staffId!) : null, l.second ? shown(l.kind, l.second.v) : null]),
      },
      top("service"),
      top("product"),
    ],
  };
}

// ───────────────────────────── Sales tax by state ─────────────────────────────

type TaxRow = { shopId: string; staffId: string | null; day: string; tickets: number; ts: number; es: number; tp: number; ep: number; tax: number; gc: number };
type TaxRefundRow = { shopId: string; staffId: string | null; day: string; ts: number; es: number; tp: number; ep: number; tax: number };

/**
 * Taxable and non-taxable sales and the tax collected, per state and filing period, after refunds.
 * A ticket's services (or products) are taxable when tax was charged on them, at the shop's rates
 * at the time. Refunds count in the period they were issued, the way the return is filed.
 */
export async function salesTaxData(scope0: ReportScope, loc0: ViewCtx, params: Record<string, string | undefined>): Promise<ReportData> {
  const [shopRows, filingAt] = await Promise.all([
    scope0.shopIds.length
      ? db.select({ id: shopsTable.id, name: shopsTable.name, state: shopsTable.state, verified: shopsTable.taxRatesVerified, jurisdiction: shopsTable.taxJurisdiction }).from(shopsTable).where(inArray(shopsTable.id, scope0.shopIds))
      : Promise.resolve([]),
    settingFor<Record<string, FilingFrequency>>("tax_filing", scope0.shopIds),
  ]);
  const filing = filingAt(scope0.shopIds.length === 1 ? scope0.shopIds[0] : null);
  const stateOf = new Map(shopRows.map((s) => [s.id, stateCode(s.state)]));
  const states = [...new Set(stateOf.values())].sort();
  const state = params.state ? stateCode(params.state) : "";
  const picked = state && states.includes(state) ? state : "";
  const scope = picked ? { ...scope0, shopIds: scope0.shopIds.filter((id) => stateOf.get(id) === picked) } : scope0;
  const loc = picked ? { ...loc0, shops: loc0.shops.filter((s) => stateOf.get(s.id) === picked) } : loc0;
  const period: TaxPeriod = parsePeriod(params.period) ?? (picked ? PERIOD_OF[filingFor(filing, picked)] : "month");
  const [sold, back] = await Promise.all([
    rows<TaxRow>(sql`
      select s.shop_id "shopId", s.staff_id "staffId", to_char(s.business_date, 'YYYY-MM-DD') "day", count(*)::int tickets,
        coalesce(sum(s.service_net_cents) filter (where s.service_tax_cents > 0), 0)::int ts, coalesce(sum(s.service_net_cents) filter (where s.service_tax_cents = 0), 0)::int es,
        coalesce(sum(s.product_net_cents) filter (where s.product_tax_cents > 0), 0)::int tp, coalesce(sum(s.product_net_cents) filter (where s.product_tax_cents = 0), 0)::int ep,
        coalesce(sum(s.service_tax_cents + s.product_tax_cents), 0)::int tax, coalesce(sum(s.gift_card_sales_cents), 0)::int gc
      from sales s where s.shop_id in ${ids(scope)} and s.business_date between ${scope.from} and ${scope.to} and s.status in ${PAID}
      ${staffFilter(sql`s.staff_id`, scope)}
      group by 1, 2, 3`),
    rows<TaxRefundRow>(sql`
      select r.shop_id "shopId", s.staff_id "staffId", to_char(r.business_date, 'YYYY-MM-DD') "day",
        coalesce(sum(r.service_net_cents) filter (where s.service_tax_cents > 0), 0)::int ts, coalesce(sum(r.service_net_cents) filter (where s.service_tax_cents = 0), 0)::int es,
        coalesce(sum(r.product_net_cents) filter (where s.product_tax_cents > 0), 0)::int tp, coalesce(sum(r.product_net_cents) filter (where s.product_tax_cents = 0), 0)::int ep,
        coalesce(sum(r.tax_cents), 0)::int tax
      from refunds r join sales s on s.id = r.sale_id
      where r.shop_id in ${ids(scope)} and r.business_date between ${scope.from} and ${scope.to} and r.kind = 'refund'
      ${staffFilter(sql`s.staff_id`, scope)}
      group by 1, 2, 3`),
  ]);
  type Acc = { shopId: string; staffId: string | null; period: string; state: string; tickets: number; ts: number; tp: number; exempt: number; tax: number; refundedTax: number; gc: number };
  const acc = new Map<string, Acc>();
  const at = (r: { shopId: string; staffId: string | null; day: string }) => {
    const p = periodKey(r.day, period);
    const k = `${r.shopId}|${r.staffId}|${p}`;
    const st = stateOf.get(r.shopId) ?? "";
    if (!acc.has(k)) acc.set(k, { shopId: r.shopId, staffId: r.staffId, period: p, state: st, tickets: 0, ts: 0, tp: 0, exempt: 0, tax: 0, refundedTax: 0, gc: 0 });
    return acc.get(k)!;
  };
  for (const r of sold) {
    const a = at(r);
    a.tickets += r.tickets;
    a.ts += r.ts;
    a.tp += r.tp;
    a.exempt += r.es + r.ep;
    a.tax += r.tax;
    a.gc += r.gc;
  }
  for (const r of back) {
    const a = at(r);
    a.ts -= r.ts;
    a.tp -= r.tp;
    a.exempt -= r.es + r.ep;
    a.refundedTax += r.tax;
  }
  const list = [...acc.values()];
  const cols: Column[] = [text("Period"), text("State"), int("Tickets"), money("Taxable services"), money("Taxable products"), money("Taxable sales"), money("Non-taxable sales"), money("Tax charged"), money("Tax refunded"), money("Net tax collected"), money("Gift cards sold (not taxed)")];
  const cells = (a: Acc, first: string): Cell[] => [first, stateName(a.state), a.tickets, a.ts, a.tp, a.ts + a.tp, a.exempt, a.tax, a.refundedTax, a.tax - a.refundedTax, a.gc];
  const toRow = (a: Acc, key: string, first: string): ListRow => ({ shopId: a.shopId, staffId: a.staffId, key, cells: cells(a, first) });
  const t = (f: (a: Acc) => number) => list.reduce((s, a) => s + f(a), 0);
  const unverified = shopRows.filter((s) => !s.verified && (!picked || stateOf.get(s.id) === picked));
  const jurisdictions = shopRows
    .filter((s) => !picked || stateOf.get(s.id) === picked)
    .map((s) => ({ name: s.name, j: taxJurisdiction(s.jurisdiction), state: stateCode(s.state) }))
    .filter((s) => s.j.county || s.j.city || s.j.district || s.j.code)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    stats: [
      { label: "Net tax collected", value: formatCents(t((a) => a.tax - a.refundedTax)), hint: `${formatCents(t((a) => a.refundedTax))} refunded` },
      { label: "Taxable sales", value: formatCents(t((a) => a.ts + a.tp)), hint: `services ${formatCents(t((a) => a.ts))} · products ${formatCents(t((a) => a.tp))}` },
      { label: "Non-taxable sales", value: formatCents(t((a) => a.exempt)) },
      { label: "Filing", value: picked ? FILING_LABEL[filingFor(filing, picked)] : `${states.length} ${states.length === 1 ? "state" : "states"}`, hint: picked ? stateName(picked) : states.map(stateName).join(", ") || undefined },
    ],
    options: [
      option("period", "Period", period, [
        ["month", "By month"],
        ["quarter", "By quarter"],
      ]),
      ...(states.length > 1 || picked ? [option("state", "State", picked, [["", "Every state"], ...states.map((s): [string, string] => [s, stateName(s)])])] : []),
    ],
    tables: [
      listTable(loc, {
        id: "periods",
        title: titled(loc, period === "month" ? "By state and month" : "By state and quarter"),
        columns: cols,
        rows: list.map((a) => toRow(a, `${a.period}|${a.state}`, periodLabel(a.period))),
        merge: true,
        shopsColumnAt: loc.shops.length > 1 ? 2 : undefined,
        sort: (a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])),
        labelAt: 0,
      }),
      listTable(noBarbers(loc), {
        id: "states",
        title: "By state, whole range",
        columns: [text("State"), ...cols.slice(2)],
        rows: list.map((a) => ({ shopId: a.shopId, key: a.state, cells: cells(a, "").slice(1) })),
        merge: true,
        sort: (a, b) => String(a[0]).localeCompare(String(b[0])),
      }),
    ],
    notes: [
      "Tax is what each ticket was charged at its shop's rates in Shop settings. Check the totals against the state's return; Ray'z doesn't file for you.",
      ...(unverified.length ? [`Tax rates not marked as checked yet: ${unverified.map((s) => s.name).join(", ")}.`] : []),
      ...(jurisdictions.length ? [`Jurisdictions: ${jurisdictions.map((s) => `${s.name}: ${taxJurisdictionLabel(s.state, s.j)}`).join("; ")}.`] : []),
      ...(states.length ? [`Filing schedule: ${states.map((s) => `${stateName(s)} ${FILING_LABEL[filingFor(filing, s)].toLowerCase()}`).join(", ")}.`] : []),
    ],
  };
}

// ───────────────────────────── Client retention ─────────────────────────────

type Ret = { newN: number; newBack: number; oldN: number; oldBack: number; elsewhere: number; switched: number };

async function retentionBy(s: ReportScope, prior: { from: string }, visits: number, o: Grain): Promise<Map<string, Ret>> {
  const { start, end } = span(s);
  const prevStart = startOfLocalDay(prior.from).toISOString();
  const g = grp(o, sql`a.shop_id`);
  const gs = sgrp(o, sql`a.staff_id`);
  const r = await rows<{ shop_id: string | null; staff_id: string | null } & Ret>(sql`
    with q as (
      select ${g} shop_id, ${gs} staff_id, a.customer_id from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${prevStart} and a.starts_at < ${start} ${staffFilter(sql`a.staff_id`, s)}
      group by 1, 2, 3 having count(*) >= ${visits}
    ), f as (
      select q.*,
        (select min(b.starts_at) from appointments b where b.customer_id = q.customer_id and b.status = 'completed' and ${inSegment(s, "q", "b")}) < ${prevStart} existing,
        exists (select 1 from appointments b where b.customer_id = q.customer_id and b.status = 'completed' and ${inSegment(s, "q", "b")} and b.starts_at >= ${start} and b.starts_at < ${end}) back,
        exists (select 1 from appointments b where b.customer_id = q.customer_id and b.status = 'completed' and b.starts_at >= ${start} and b.starts_at < ${end}) anywhere,
        exists (
          select 1 from appointments b where b.customer_id = q.customer_id and b.status = 'completed' and ${inSegment(s, "q", "b")} and b.starts_at >= ${start} and b.starts_at < ${end}
            and b.staff_id in (select c.staff_id from appointments c where c.customer_id = q.customer_id and c.status = 'completed' and ${inSegment(s, "q", "c")} and c.starts_at >= ${prevStart} and c.starts_at < ${start})
        ) same_barber
      from q
    )
    select shop_id, staff_id,
      count(*) filter (where not existing)::int "newN", count(*) filter (where not existing and back)::int "newBack",
      count(*) filter (where existing)::int "oldN", count(*) filter (where existing and back)::int "oldBack",
      count(*) filter (where not back and anywhere)::int elsewhere, count(*) filter (where back and not same_barber)::int switched
    from f group by 1, 2`);
  const out = new Map<string, Ret>(r.map((x) => [keyOf(x), x]));
  if (!o.byShop && !o.byStaff && !out.has(TOTAL)) out.set(TOTAL, { newN: 0, newBack: 0, oldN: 0, oldBack: 0, elsewhere: 0, switched: 0 });
  return out;
}

/**
 * Clients who had 1, 2 or 3+ completed visits in the period before (the quarter or month before
 * for a quarter or month, otherwise the same length just before) and came back in the range, split into new clients (first visit here was in that
 * period) and existing ones. "Went elsewhere": didn't come back here but saw another Ray'z barber
 * or shop. "Switched barbers": came back here, but not to a barber they'd seen before.
 */
export async function retentionData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>): Promise<ReportData> {
  const visits = params.visits === "2" ? 2 : params.visits === "3" ? 3 : 1;
  const grains = grainsFor(loc);
  const prior = priorPeriod(scope.from, scope.to, params.preset);
  const maps = await Promise.all(grains.map((g) => retentionBy(scope, prior, visits, g)));
  const at: Record<string, Ret> = Object.fromEntries(maps.flatMap((x) => [...x]));
  const t = at[TOTAL] ?? { newN: 0, newBack: 0, oldN: 0, oldBack: 0, elsewhere: 0, switched: 0 };
  const all = (r: Ret) => r.newN + r.oldN;
  const lost = (r: Ret) => all(r) - r.newBack - r.oldBack;
  return {
    stats: [
      { label: "Retention", value: pct(ratio(t.newBack + t.oldBack, all(t))), hint: `${t.newBack + t.oldBack} of ${all(t)} clients came back` },
      { label: "Existing clients", value: pct(ratio(t.oldBack, t.oldN)), hint: `${t.oldBack} of ${t.oldN} retained` },
      { label: "New clients", value: pct(ratio(t.newBack, t.newN)), hint: `${t.newBack} of ${t.newN} came back for another visit` },
      { label: "Went to another barber or shop", value: String(t.elsewhere), hint: `of ${lost(t)} who didn't come back here`, tone: t.elsewhere ? "down" : undefined },
    ],
    options: [
      option("visits", "Visits to qualify", String(visits), [
        ["1", "1+ visit"],
        ["2", "2+ visits"],
        ["3", "3+ visits"],
      ]),
    ],
    tables: [
      metricTable(loc, {
        id: "retention",
        title: titled(loc, "Retention"),
        subtitle: `Qualifying clients had ${visits === 1 ? "a completed visit" : `${visits} or more completed visits`} ${formatDate(prior.from, "MMM d, yyyy")} – ${formatDate(prior.to, "MMM d, yyyy")}, here. A client seen at two shops or by two barbers counts in each row and once in the total.`,
        metrics: [
          m("Qualifying clients", "int", at, all, false),
          m("Existing clients", "int", at, (r) => r.oldN, false),
          m("Existing clients retained", "int", at, (r) => r.oldBack, false),
          m("Existing client retention", "pct", at, (r) => ratio(r.oldBack, r.oldN)),
          m("New clients", "int", at, (r) => r.newN, false),
          m("New clients retained", "int", at, (r) => r.newBack, false),
          m("New client retention", "pct", at, (r) => ratio(r.newBack, r.newN)),
          m("Total retention", "pct", at, (r) => ratio(r.newBack + r.oldBack, all(r))),
          m("Didn't come back", "int", at, lost, false),
          m("Went to another barber or shop", "int", at, (r) => r.elsewhere, false),
          ...(loc.byBarber ? [] : [m("Came back to a different barber", "int", at, (r) => r.switched, false)]),
        ],
      }),
    ],
    notes: ["For a quarter against the quarter before, pick Quarter to date or Last quarter. The Lapsed clients report lists the clients to win back."],
  };
}

// ───────────────────────────── Acquisition channels ─────────────────────────────

const BOOKED_LABEL: Record<string, string> = { online: "Online booking", api: "Ray'z app", staff: "Booked by staff", walk_in: "Walk-in", rebook: "Rebook link", import: "Squire import" };
type Acq = { n: number; back: number; ticket: number; source: Record<string, { n: number; back: number }>; booked: Record<string, { n: number; back: number }> };

async function acquisitionBy(s: ReportScope, o: Grain): Promise<Map<string, Acq>> {
  const { start, end } = span(s);
  const g = grp(o, sql`a.shop_id`);
  const gs = sgrp(o, sql`a.staff_id`);
  const r = await rows<{ shop_id: string | null; staff_id: string | null; source: string; booked: string; n: number; back: number; ticket: number }>(sql`
    with v as (
      select distinct ${g} shop_id, ${gs} staff_id, a.customer_id from appointments a
      where a.shop_id in ${ids(s)} and a.status = 'completed' and a.customer_id is not null
        and a.starts_at >= ${start} and a.starts_at < ${end} ${staffFilter(sql`a.staff_id`, s)}
    ), f as (
      select v.*, (select b.id from appointments b where b.customer_id = v.customer_id and b.status = 'completed' and ${inSegment(s, "v", "b")} order by b.starts_at limit 1) first_id
      from v
    )
    select f.shop_id, f.staff_id,
      coalesce(nullif(trim(c.source), ''), case when c.referred_by_id is not null then 'Referred by a client' end, 'Not recorded') source, b.source::text booked,
      count(*)::int n,
      count(*) filter (where exists (select 1 from appointments x where x.customer_id = f.customer_id and x.status = 'completed' and ${inSegment(s, "f", "x")} and x.starts_at > b.starts_at))::int back,
      coalesce(sum((select sa.service_net_cents + sa.product_net_cents from sales sa where sa.appointment_id = b.id and sa.status in ${PAID} limit 1)), 0)::int ticket
    from f join appointments b on b.id = f.first_id join customers c on c.id = f.customer_id
    where b.starts_at >= ${start} and b.starts_at < ${end}
    group by 1, 2, 3, 4`);
  const out = new Map<string, Acq>();
  for (const x of r) {
    const k = keyOf(x);
    const a = out.get(k) ?? { n: 0, back: 0, ticket: 0, source: {}, booked: {} };
    a.n += x.n;
    a.back += x.back;
    a.ticket += x.ticket;
    for (const [bucket, name] of [
      [a.source, x.source],
      [a.booked, BOOKED_LABEL[x.booked] ?? x.booked],
    ] as const) {
      const b = bucket[name] ?? { n: 0, back: 0 };
      b.n += x.n;
      b.back += x.back;
      bucket[name] = b;
    }
    out.set(k, a);
  }
  if (!o.byShop && !o.byStaff && !out.has(TOTAL)) out.set(TOTAL, { n: 0, back: 0, ticket: 0, source: {}, booked: {} });
  return out;
}

/**
 * New clients (first completed visit here in the range) by how they found us (the client's source,
 * or a client referral) and how they first booked, with how many came back for a second visit
 * and what the first ticket came to.
 */
export async function acquisitionData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const grains = grainsFor(loc);
  const maps = await Promise.all(grains.map((g) => acquisitionBy(scope, g)));
  const at: Record<string, Acq> = Object.fromEntries(maps.flatMap((x) => [...x]));
  const t = at[TOTAL] ?? { n: 0, back: 0, ticket: 0, source: {}, booked: {} };
  const names = (f: (a: Acq) => Record<string, { n: number }>) => [...new Set(Object.values(at).flatMap((a) => Object.keys(f(a))))].sort((a, b) => (f(t)[b]?.n ?? 0) - (f(t)[a]?.n ?? 0) || a.localeCompare(b));
  const sources = names((a) => a.source);
  const booked = names((a) => a.booked);
  const topSource = sources.find((s) => s !== "Not recorded");
  const online = (t.booked[BOOKED_LABEL.online]?.n ?? 0) + (t.booked[BOOKED_LABEL.api]?.n ?? 0);
  return {
    stats: [
      { label: "New clients", value: String(t.n), hint: t.n ? `avg first ticket ${formatCents(Math.round(t.ticket / t.n))}` : undefined },
      { label: "Came back", value: pct(ratio(t.back, t.n)), hint: `${t.back} had a second visit here` },
      { label: "Top channel", value: topSource ?? "—", hint: topSource ? `${t.source[topSource].n} new clients` : undefined },
      { label: "Booked online", value: pct(ratio(online, t.n)), hint: "first visit booked online or in the app" },
    ],
    tables: [
      metricTable(loc, {
        id: "sources",
        title: titled(loc, "New clients by how they found us"),
        subtitle: "From each client's source on their profile. A client new to two shops or two barbers counts in each and once in the total.",
        label: "Channel",
        metrics: [...sources.map((s) => m(s, "int", at, (a) => a.source[s]?.n ?? 0, false)), m("All new clients", "int", at, (a) => a.n, false)],
      }),
      metricTable(loc, {
        id: "booked",
        title: titled(loc, "How new clients first booked"),
        label: "First booking",
        metrics: [...booked.map((s) => m(s, "int", at, (a) => a.booked[s]?.n ?? 0, false)), m("All new clients", "int", at, (a) => a.n, false)],
      }),
      metricTable(loc, {
        id: "second_visit",
        title: titled(loc, "Came back for a second visit"),
        subtitle: "Share of each channel's new clients with another completed visit here since, up to today.",
        label: "Channel",
        metrics: [...sources.map((s) => m(s, "pct", at, (a) => ratio(a.source[s]?.back ?? 0, a.source[s]?.n ?? 0))), m("All new clients", "pct", at, (a) => ratio(a.back, a.n)), m("Avg first ticket", "money", at, (a) => (a.n ? Math.round(a.ticket / a.n) : null), false)],
      }),
    ],
    notes: t.source["Not recorded"]?.n ? [`${t.source["Not recorded"].n} new clients have no source on their profile. Ask "how did you hear about us?" at checkout and set it on the client.`] : undefined,
  };
}

// ───────────────────────────── Phone operator ─────────────────────────────

type CallRow = { shopId: string; day: string; operator: boolean; status: string; autoTextSent: boolean; choice: string | null; staffId: string | null; bookedCents: number | null; bookedFor: string | null };

/**
 * Calls to each shop's number: answered by staff, taken by the phone operator, or missed; what
 * callers pressed; and the bookings that followed. A booking counts toward an operator call when
 * the same number books at the same shop within ATTRIBUTION_DAYS. The barber filter applies to
 * those bookings; calls are the shop's.
 */
export async function phoneOperatorData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const { start, end } = span(scope);
  const [calls, shopRows] = await Promise.all([
    rows<CallRow>(sql`
      select c.shop_id "shopId", to_char((c.created_at at time zone sh.timezone)::date, 'YYYY-MM-DD') "day", c.operator, c.status,
        c.auto_text_sent "autoTextSent", c.operator_choice choice, b.staff_id "staffId", b.estimate_cents "bookedCents",
        to_char((b.starts_at at time zone sh.timezone)::date, 'YYYY-MM-DD') "bookedFor"
      from call_logs c join shops sh on sh.id = c.shop_id
      left join lateral (
        select a.staff_id, coalesce(a.estimate_cents, 0)::int estimate_cents, a.starts_at from appointments a join customers cu on cu.id = a.customer_id
        where c.operator and a.shop_id = c.shop_id and cu.phone = c.phone and a.created_at >= c.created_at
          and a.created_at < c.created_at + ${sql.raw(`interval '${ATTRIBUTION_DAYS} days'`)} and a.status <> 'cancelled' and a.source <> 'walk_in'
          ${staffFilter(sql`a.staff_id`, scope)}
        order by a.created_at limit 1
      ) b on true
      where c.shop_id in ${ids(scope)} and c.direction = 'in' and c.kind = 'inbound' and c.created_at >= ${start} and c.created_at < ${end}
      order by c.created_at`),
    scope.shopIds.length ? db.select({ id: shopsTable.id, name: shopsTable.name, op: shopsTable.phoneOperator }).from(shopsTable).where(inArray(shopsTable.id, scope.shopIds)) : Promise.resolve([]),
  ]);
  const ops = new Map(shopRows.map((s) => [s.id, cleanOperator(s.op)]));
  const lv = noBarbers(loc);
  const perShop = Object.fromEntries(loc.shops.map((s) => [segKey(s.id, null), operatorMetrics(calls.filter((c) => c.shopId === s.id), ops.get(s.id)?.minutesPerCall ?? 3)]));
  const total = { ...operatorMetrics(calls, 0), minutesSaved: Object.values(perShop).reduce((a, x) => a + x.minutesSaved, 0) };
  const x = { ...perShop, [TOTAL]: total };
  const handled = calls.filter((c) => c.operator);
  const choices = Object.keys(OPERATOR_CHOICE_LABEL) as OperatorChoice[];
  const choiceAt = (choice: OperatorChoice) =>
    Object.fromEntries([...loc.shops.map((s) => [segKey(s.id, null), handled.filter((c) => c.shopId === s.id && (c.choice ?? "none") === choice).length]), [TOTAL, handled.filter((c) => (c.choice ?? "none") === choice).length]]);
  const off = shopRows.filter((s) => !ops.get(s.id)?.enabled);
  return {
    stats: [
      { label: "Dollars booked", value: formatCents(total.bookedCents), hint: `${total.bookings} bookings after operator calls` },
      { label: "Calls answered", value: pct(total.answerRate), hint: `${total.staffAnswered} by staff · ${total.handled} by the operator · ${total.missed} missed` },
      { label: "Book rate", value: pct(total.bookRate), hint: `${total.linksTexted} booking links texted` },
      { label: "Staff minutes saved", value: String(total.minutesSaved), hint: `${(total.minutesSaved / 60).toFixed(1)} hours` },
    ],
    tables: [
      metricTable(lv, {
        id: "calls",
        title: titled(lv, "Calls"),
        metrics: [
          m("Calls in", "int", x, (v) => v.calls),
          m("Answered by staff", "int", x, (v) => v.staffAnswered),
          m("Taken by the operator", "int", x, (v) => v.handled),
          m("Missed, no operator", "int", x, (v) => v.missed),
          m("Calls answered", "pct", x, (v) => v.answerRate),
          m("Booking links texted", "int", x, (v) => v.linksTexted),
          m(`Bookings within ${ATTRIBUTION_DAYS} days`, "int", x, (v) => v.bookings),
          m("Dollars booked", "money", x, (v) => v.bookedCents),
          m("Book rate", "pct", x, (v) => v.bookRate),
          m("Staff minutes saved", "int", x, (v) => v.minutesSaved),
        ],
      }),
      metricTable(lv, {
        id: "pressed",
        title: titled(lv, "What callers did"),
        label: "On the operator's menu",
        metrics: choices.map((c) => ({ label: OPERATOR_CHOICE_LABEL[c], kind: "int" as const, at: choiceAt(c) })),
      }),
      listTable(lv, {
        id: "daily",
        title: "By day",
        columns: [text("Date"), int("Calls in"), int("Taken by the operator"), int("Links texted"), int("Bookings"), money("Dollars booked")],
        rows: calls.map((c) => ({ shopId: c.shopId, key: c.day, cells: [c.day, 1, c.operator ? 1 : 0, c.operator && c.autoTextSent ? 1 : 0, c.bookedCents !== null ? 1 : 0, c.bookedCents ?? 0] })),
        merge: true,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])),
      }),
      listTable(loc, {
        id: "bookings",
        title: "Bookings after an operator call",
        subtitle: "The caller's number isn't shown here; the call is on the client's profile.",
        columns: [text("Called"), text("Pressed"), text("Appointment"), money("Booked")],
        rows: handled
          .filter((c) => c.bookedCents !== null)
          .map((c) => ({ shopId: c.shopId, staffId: c.staffId, cells: [c.day, OPERATOR_CHOICE_LABEL[(c.choice ?? "none") as OperatorChoice] ?? c.choice, c.bookedFor, c.bookedCents] })),
        keepShop: loc.shops.length > 1,
        sort: (a, b) => String(b[0]).localeCompare(String(a[0])),
      }),
    ],
    notes: [
      `Minutes saved: each call the operator handled without putting it through to the shop, at the shop's minutes per call (Shop settings, Phone line).`,
      ...(off.length ? [`The phone operator is off at ${off.map((s) => s.name).join(", ")}: missed and after-hours calls there get the missed-call text only.`] : []),
    ],
  };
}
