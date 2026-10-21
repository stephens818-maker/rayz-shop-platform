import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, shops } from "@/db/schema";
import { ReportKey } from "@/domain/permissions";
import {
  Cell,
  Column,
  ColumnKind,
  ListRow,
  Metric,
  ReportTable,
  TOTAL,
  ViewCtx,
  csvTable,
  listTable,
  metricSplitTable,
  metricTable,
  segKey,
  segments,
  splitTable,
  viewOf,
} from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import {
  Grain,
  ReportScope,
  ZERO_SALES,
  ZERO_TENDER,
  appointmentHeatmap,
  availableMinutesAt,
  dailyTotals,
  discountBreakdown,
  drawerHistory,
  emptyKpis,
  giftCardTotalsByShop,
  giftCardsIssued,
  inventoryStatus,
  itemMix,
  kpisAt,
  loyaltyActivity,
  loyaltyByShop,
  monthlyTotals,
  payrollTips,
  ratingsGivenAt,
  refundLog,
  refundTotals,
  salesTotalsAt,
  tenderAt,
  toCsv,
} from "./reports";

/**
 * Every a la carte report is one loader returning stats and tables. The report page renders them
 * and the export route turns the same tables into CSV, so what you see is what you download.
 *
 * Loaders fetch each grain a view shows (per shop, per barber, per barber per shop) and the total
 * from the same SQL, and the table builders lay them out. Lists are fetched at the finest grain and
 * added up by the builders. Tests check that every grain adds up to the next.
 */

export type { Cell, ColumnKind, ReportTable } from "@/domain/report-views";

export interface ReportStat {
  label: string;
  value: string;
  hint?: string;
  tone?: "up" | "down";
}
export interface Heatmap {
  title: string;
  cells: { dow: number; hour: number; n: number }[];
}
export interface ReportData {
  stats: ReportStat[];
  tables: ReportTable[];
  heatmaps?: Heatmap[];
  notes?: string[];
}

export interface ReportInput {
  scope: ReportScope;
  /** Combined, by location, by barber or by location and barber, over the selected shops and barbers. */
  loc: ViewCtx;
  /** The viewer's access: brand-level rows (no shop) are only for people with every shop. */
  viewer: { brandWide: boolean; currentShopId: string | null; shopIds: string[] };
  params: Record<string, string | undefined>;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ratio = (a: number, b: number) => (b ? a / b : null);
const money = (label: string): Column => ({ label, kind: "money" });
const int = (label: string): Column => ({ label, kind: "int" });
const text = (label: string): Column => ({ label });
/** Numbers that identify or describe a row rather than add up. */
const id = (label: string, kind: ColumnKind = "int"): Column => ({ label, kind, sum: false });

const byDay = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0]));
const byDayDesc = (a: Cell[], b: Cell[]) => String(b[0]).localeCompare(String(a[0]));
const sum = <T>(xs: Record<string, T>, f: (x: T) => number) => Object.values(xs).reduce((a, x) => a + f(x), 0);
const each = <T>(xs: Record<string, T>, f: (x: T) => number | null) => Object.fromEntries(Object.entries(xs).map(([k, x]) => [k, f(x)]));

/** A metric from values keyed by segment. Rates and averages are computed per segment, never added up. */
const m = <T>(label: string, kind: ColumnKind, xs: Record<string, T>, f: (x: T) => number | null, additive?: boolean): Metric => ({ label, kind, at: each(xs, f), additive });

/** Per-shop values (and the total) as metric keys. */
const shopKeyed = <T>(perShop: Record<string, T>, total: T): Record<string, T> => ({
  ...Object.fromEntries(Object.entries(perShop).map(([k, v]) => [segKey(k, null), v])),
  [TOTAL]: total,
});

/** The grains a view shows: its segments, the per-shop subtotals of the location and barber view, and the total. */
export function grainsFor(v: ViewCtx, o: { split?: boolean } = {}): Grain[] {
  const out: Grain[] = [{}];
  if (v.view === "shops") out.push({ byShop: true });
  if (v.byBarber) out.push({ byShop: v.view === "shops", byStaff: true });
  if (o.split && v.byBarber && v.shops.length > 1) out.push({ byShop: true, byStaff: true }, { byStaff: true });
  return [...new Map(out.map((g) => [`${!!g.byShop}${!!g.byStaff}`, g])).values()];
}
/** Lists are fetched per shop, and per barber when the view breaks out by barber. */
const listGrain = (v: ViewCtx): Grain => ({ byShop: true, byStaff: !!v.byBarber });

/** Rows keyed by segment, with a number added up per key. */
function keyedSum<T extends { shopId: string | null; staffId: string | null }>(rows: T[], f: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = segKey(r.shopId, r.staffId);
    out[k] = (out[k] ?? 0) + f(r);
  }
  return out;
}

const SUFFIX = { combined: "", shops: " by location", barbers: " by barber", shops_barbers: " by location and barber" } as const;
/** "Summary", "Summary by location", "Summary by barber", "Summary by location and barber". */
const titled = (v: ViewCtx, title: string) => title + SUFFIX[viewOf(v)];
/** Metric tables are stat tiles in the combined view, a table otherwise. */
const tilesOnly = (v: ViewCtx) => v.view !== "shops" && !v.byBarber;

async function salesData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const g = grainsFor(loc);
  const [x, tender, daily, monthly] = await Promise.all([salesTotalsAt(scope, g), tenderAt(scope, g), dailyTotals(scope, listGrain(loc)), monthlyTotals(scope, listGrain(loc))]);
  const s = x[TOTAL] ?? ZERO_SALES();
  const t = tender[TOTAL] ?? ZERO_TENDER();
  const summary = metricTable(loc, {
    id: "summary",
    title: titled(loc, "Summary"),
    exportOnly: tilesOnly(loc),
    metrics: [
      m("Tickets", "int", x, (v) => v.tickets),
      m("Gross sales", "money", x, (v) => v.grossSalesCents),
      m("Discounts", "money", x, (v) => v.discountCents),
      m("Refunds", "money", x, (v) => v.refundCents),
      m("Net services", "money", x, (v) => v.netServicesCents),
      m("Net products", "money", x, (v) => v.netProductsCents),
      m("Net sales", "money", x, (v) => v.netSalesCents),
      m("Avg ticket", "money", x, (v) => v.avgTicketCents, false),
      m("Tickets with retail", "int", x, (v) => v.productTickets),
      m("Tax", "money", x, (v) => v.taxCents),
      m("Tips", "money", x, (v) => v.tipsCents),
      m("Card surcharges", "money", x, (v) => v.cardFeeCents),
      m("Gift cards sold", "money", x, (v) => v.giftCardsSoldCents),
      m("Card", "money", tender, (v) => v.cardCents),
      m("Card (credit)", "money", tender, (v) => v.cardCreditCents),
      m("Card (debit/prepaid)", "money", tender, (v) => v.cardDebitCents),
      m("Cash", "money", tender, (v) => v.cashCents),
      m("Gift card redemptions", "money", tender, (v) => v.giftCardCents),
    ],
  });
  const dailyTable = listTable(loc, {
    id: "daily",
    title: "Daily totals",
    columns: [text("Date"), int("Tickets"), money("Gross"), money("Refunds"), money("Net"), money("Tips"), money("Card"), money("Cash")],
    rows: daily.map((d) => ({ shopId: d.shopId!, staffId: d.staffId, key: d.day, cells: [d.day, d.tickets, d.grossCents, d.refundCents, d.netCents, d.tipsCents, d.cardCents, d.cashCents] })),
    merge: true,
    sort: byDay,
  });
  const monthlyTable = listTable(loc, {
    id: "monthly",
    title: "Monthly totals",
    columns: [text("Month"), int("Tickets"), money("Gross"), money("Refunds"), money("Net services"), money("Net products"), money("Tips")],
    rows: monthly.map((d) => ({
      shopId: d.shopId!,
      staffId: d.staffId,
      key: d.month,
      cells: [d.month, d.tickets, d.grossCents, d.refundCents, d.netServicesCents, d.netProductsCents, d.tipsCents],
    })),
    merge: true,
    sort: byDay,
  });
  return {
    stats: [
      { label: "Gross sales", value: formatCents(s.grossSalesCents), hint: `${s.tickets} tickets · avg ${formatCents(s.avgTicketCents)}` },
      { label: "Net services", value: formatCents(s.netServicesCents), hint: s.discountCents ? `after ${formatCents(s.discountCents)} discounts` : undefined },
      { label: "Net products", value: formatCents(s.netProductsCents), hint: `${s.productTickets} tickets with retail` },
      { label: "Tips", value: formatCents(s.tipsCents), hint: `card ${formatCents(t.cardTipsCents)} · cash ${formatCents(t.cashTipsCents)}` },
      { label: "Tax collected", value: formatCents(s.taxCents), hint: `gift cards sold ${formatCents(s.giftCardsSoldCents)}` },
      { label: "Refunds", value: formatCents(s.refundCents) },
      { label: "Card surcharges", value: formatCents(s.cardFeeCents) },
      { label: "Card / cash", value: `${formatCents(t.cardCents)} / ${formatCents(t.cashCents)}` },
    ],
    tables: [summary, dailyTable, monthlyTable],
  };
}

/**
 * The barber scorecard: sales and tips, appointments and clients, time and ratings, for each
 * barber (or barber at each shop) and the total. Counts and amounts add up to the shop and brand
 * totals; rates, averages and client counts are worked out for each row on its own.
 */
async function barberPerformance(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const g = grainsFor(loc, { split: true });
  const [x, tender, k, avail, rated] = await Promise.all([salesTotalsAt(scope, g), tenderAt(scope, g), kpisAt(scope, g), availableMinutesAt(scope, g), ratingsGivenAt(scope, g)]);
  const keys = [...new Set([...Object.keys(x), ...Object.keys(tender), ...Object.keys(k), ...Object.keys(avail), ...Object.keys(rated)])];
  const kOf = (key: string) => k[key] ?? emptyKpis(scope);
  const time = Object.fromEntries(keys.map((key) => [key, { booked: kOf(key).bookedMinutes, available: avail[key] ?? 0 }]));
  const r = Object.fromEntries(keys.map((key) => [key, rated[key] ?? { n: 0, stars: 0 }]));

  const sales = [
    m("Tickets", "int", x, (v) => v.tickets),
    m("Service sales", "money", x, (v) => v.netServicesCents),
    m("Product sales", "money", x, (v) => v.netProductsCents),
    m("Card tips", "money", tender, (v) => v.cardTipsCents),
    m("Cash tips", "money", tender, (v) => v.cashTipsCents),
    m("Total tips", "money", x, (v) => v.tipsCents),
    m("Discounts", "money", x, (v) => v.discountCents),
    m("Refunds", "money", x, (v) => v.refundCents),
    m("Avg ticket", "money", x, (v) => v.avgTicketCents, false),
  ];
  const visits = [
    m("Appointments", "int", k, (v) => v.appointments),
    m("Walk-ins", "int", k, (v) => v.walkIns),
    m("No-shows", "int", k, (v) => v.noShows.n),
    m("Cancellations", "int", k, (v) => v.cancellations.n),
    m("Rebook rate", "pct", k, (v) => v.rebookRate),
    m("Retention", "pct", k, (v) => v.retentionRate),
    m("New clients", "int", k, (v) => v.newClients, false),
    m("Returning clients", "int", k, (v) => v.returningClients, false),
  ];
  const timeAndRatings = [
    m("Hours booked", "hours", time, (v) => v.booked),
    m("Hours available", "hours", time, (v) => v.available),
    m("Utilization", "pct", time, (v) => ratio(v.booked, v.available)),
    m("Ratings given", "int", r, (v) => v.n),
    m("Avg stars given", "decimal", r, (v) => (v.n ? v.stars / v.n : null)),
  ];
  const tot = x[TOTAL] ?? ZERO_SALES();
  const tt = tender[TOTAL] ?? ZERO_TENDER();
  const kt = kOf(TOTAL);
  const split = metricSplitTable(loc, {
    id: "split",
    title: "Barbers at more than one shop",
    subtitle: "Each ticket and appointment counts at the shop where it happened. Rates and client counts are worked out at each shop and across them.",
    metrics: [...sales, ...visits],
  });
  return {
    stats: [
      { label: "Service sales", value: formatCents(tot.netServicesCents), hint: `${tot.tickets} tickets · avg ${formatCents(tot.avgTicketCents)}` },
      { label: "Tips", value: formatCents(tot.tipsCents), hint: `card ${formatCents(tt.cardTipsCents)} · cash ${formatCents(tt.cashTipsCents)}` },
      { label: "Appointments", value: String(kt.appointments), hint: `${kt.walkIns} walk-ins · ${kt.noShows.n} no-shows · ${kt.cancellations.n} cancellations` },
      { label: "Utilization", value: pct(ratio(time[TOTAL]?.booked ?? 0, time[TOTAL]?.available ?? 0)), hint: `${hours(time[TOTAL]?.booked ?? 0)} of ${hours(time[TOTAL]?.available ?? 0)} hours booked` },
    ],
    tables: [
      metricTable(loc, {
        id: "sales",
        title: titled(loc, "Sales and tips"),
        subtitle: "Service credit and tips go to the barber on the ticket, at the shop where it was rung up. Refunds count when they were issued; the average ticket is before refunds.",
        metrics: sales,
      }),
      metricTable(loc, {
        id: "clients",
        title: titled(loc, "Appointments and clients"),
        subtitle: "New clients had their first visit with these barbers, at these shops, in the range. Retention: clients from the window before who came back to the same barber and shop.",
        metrics: visits,
      }),
      metricTable(loc, {
        id: "time",
        title: titled(loc, "Time and ratings"),
        subtitle: "Hours available come from weekly schedules, less shop closures and time off. Ratings are the client ratings the barber gave.",
        metrics: timeAndRatings,
      }),
      ...(split ? [split] : []),
    ],
  };
}

const hours = (minutes: number) => (minutes / 60).toFixed(1);

/** Ratings barbers gave clients, for the ratings report. */
export async function ratingsGivenTable(scope: ReportScope, loc: ViewCtx): Promise<ReportTable> {
  const r = await ratingsGivenAt(scope, grainsFor(loc));
  return metricTable(loc, {
    id: "given",
    title: titled(loc, "Ratings given"),
    metrics: [m("Ratings given", "int", r, (v) => v.n), m("Avg stars", "decimal", r, (v) => (v.n ? v.stars / v.n : null))],
  });
}

export const REPORT_LOADERS: Record<ReportKey, (i: ReportInput) => Promise<ReportData>> = {
  async my_sales({ scope, loc }) {
    return salesData(scope, loc);
  },

  async sales_summary({ scope, loc }) {
    return salesData(scope, loc);
  },

  async sales_by_barber({ scope, loc }) {
    return barberPerformance(scope, loc);
  },

  async services_vs_products({ scope, loc }) {
    const [x, mix] = await Promise.all([salesTotalsAt(scope, grainsFor(loc)), itemMix(scope, listGrain(loc))]);
    const s = x[TOTAL] ?? ZERO_SALES();
    const total = s.netServicesCents + s.netProductsCents;
    const cols = [text("Item"), int("Qty"), int("Tickets"), money("Gross"), money("Discounts"), money("Net")];
    const items = (f: (k: string) => boolean): ListRow[] =>
      mix
        .filter((i) => f(i.kind))
        .map((i) => ({ shopId: i.shopId!, staffId: i.staffId, key: `${i.kind}|${i.name}`, cells: [i.name, i.qty, i.tickets, i.grossCents, i.discountCents, i.netCents] }));
    const byNet = (a: Cell[], b: Cell[]) => Number(b[5]) - Number(a[5]) || String(a[0]).localeCompare(String(b[0]));
    return {
      stats: [
        { label: "Net services", value: formatCents(s.netServicesCents), hint: total ? `${Math.round((s.netServicesCents / total) * 100)}% of sales` : undefined },
        { label: "Net products", value: formatCents(s.netProductsCents), hint: total ? `${Math.round((s.netProductsCents / total) * 100)}% of sales` : undefined },
        { label: "Retail attach rate", value: pct(ratio(s.productTickets, s.tickets)), hint: `${s.productTickets} of ${s.tickets} tickets` },
        { label: "Avg ticket", value: formatCents(s.avgTicketCents) },
      ],
      tables: [
        metricTable(loc, {
          id: "mix",
          title: titled(loc, "Services and products"),
          exportOnly: tilesOnly(loc),
          metrics: [
            m("Net services", "money", x, (v) => v.netServicesCents),
            m("Net products", "money", x, (v) => v.netProductsCents),
            m("Services share", "pct", x, (v) => ratio(v.netServicesCents, v.netServicesCents + v.netProductsCents)),
            m("Tickets", "int", x, (v) => v.tickets),
            m("Tickets with retail", "int", x, (v) => v.productTickets),
            m("Retail attach rate", "pct", x, (v) => ratio(v.productTickets, v.tickets)),
            m("Avg ticket", "money", x, (v) => v.avgTicketCents, false),
          ],
        }),
        listTable(loc, { id: "services", title: "Services and add-ons", columns: cols, rows: items((k) => k !== "product"), merge: true, sort: byNet }),
        listTable(loc, { id: "products", title: "Retail products", columns: cols, rows: items((k) => k === "product"), merge: true, sort: byNet }),
      ],
      notes: ["Item lines come from paid tickets in the range; refunds are on the Discounts & refunds report."],
    };
  },

  async tips_payroll({ scope, loc }) {
    const r = await payrollTips(scope);
    // By barber, the barber is the row group, so the Barber column would repeat it.
    const named = !loc.byBarber;
    const columns = [
      text("Period start"),
      text("Period end"),
      text("Staff ID"),
      ...(named ? [text("Barber")] : []),
      int("Tickets"),
      money("Service sales"),
      money("Product sales"),
      money("Card tips"),
      money("Cash tips"),
      money("Gift card tips"),
      money("Tip refunds (already subtracted)"),
      money("Total tips"),
    ];
    const rows: ListRow[] = r.rows.map((x) => ({
      shopId: x.shopId,
      staffId: x.staffId,
      key: `${x.periodStart}|${x.staffId}`,
      cells: [
        x.periodStart,
        x.periodEnd,
        x.staffCode,
        ...(named ? [x.label] : []),
        x.tickets,
        x.serviceSalesCents,
        x.productSalesCents,
        x.cardTipsCents,
        x.cashTipsCents,
        x.giftCardTipsCents,
        x.tipRefundsCents,
        x.totalTipsCents,
      ],
    }));
    const who = named ? 3 : 2;
    const order = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0])) || String(a[who]).localeCompare(String(b[who]));
    const at = named ? 4 : 3;
    const split = splitTable(loc, {
      id: "split",
      title: "Barbers at more than one shop",
      subtitle: "Tips and sales are paid out from the shop where each ticket was rung up; the total is what the barber made across shops.",
      columns,
      rows,
      sort: order,
      shopAt: at,
    });
    return {
      stats: [],
      tables: [
        listTable(loc, {
          id: "payroll",
          title: titled(loc, "Tips by pay period"),
          columns,
          rows,
          merge: true,
          shopsColumnAt: loc.shops.length > 1 ? at : undefined,
          labelAt: named ? 3 : 0,
          sort: order,
        }),
        ...(split ? [split] : []),
      ],
    };
  },

  async card_vs_cash({ scope, loc }) {
    const [tender, daily] = await Promise.all([tenderAt(scope, grainsFor(loc)), dailyTotals(scope, listGrain(loc))]);
    const t = tender[TOTAL] ?? ZERO_TENDER();
    const all = t.cardCents + t.cashCents + t.giftCardCents;
    return {
      stats: [
        { label: "Card", value: formatCents(t.cardCents), hint: all ? `${Math.round((t.cardCents / all) * 100)}% of takings` : undefined },
        { label: "Credit / debit", value: `${formatCents(t.cardCreditCents)} / ${formatCents(t.cardDebitCents)}`, hint: "credit pays the surcharge" },
        { label: "Cash", value: formatCents(t.cashCents), hint: all ? `${Math.round((t.cashCents / all) * 100)}% of takings` : undefined },
        { label: "Gift card redemptions", value: formatCents(t.giftCardCents) },
      ],
      tables: [
        metricTable(loc, {
          id: "tender",
          title: titled(loc, "Tender totals"),
          subtitle: "Takings by tender after refunds, including tips and surcharges.",
          label: "Tender",
          metrics: [
            m("Card (credit)", "money", tender, (v) => v.cardCreditCents),
            m("Card (debit / prepaid)", "money", tender, (v) => v.cardDebitCents),
            m("Card (all)", "money", tender, (v) => v.cardCents),
            m("Card tips", "money", tender, (v) => v.cardTipsCents),
            m("Cash", "money", tender, (v) => v.cashCents),
            m("Cash tips", "money", tender, (v) => v.cashTipsCents),
            m("Gift card", "money", tender, (v) => v.giftCardCents),
          ],
        }),
        listTable(loc, {
          id: "daily",
          title: "Card and cash by day",
          columns: [text("Date"), int("Tickets"), money("Card"), money("Cash")],
          rows: daily.map((d) => ({ shopId: d.shopId!, staffId: d.staffId, key: d.day, cells: [d.day, d.tickets, d.cardCents, d.cashCents] })),
          merge: true,
          sort: byDay,
        }),
      ],
    };
  },

  async discounts_refunds({ scope, loc }) {
    const g = grainsFor(loc);
    const [x, d, totals, log] = await Promise.all([
      salesTotalsAt(scope, g),
      discountBreakdown(scope, listGrain(loc)),
      Promise.all(g.map((gr) => refundTotals(scope, gr))).then((xs) => xs.flat()),
      refundLog(scope),
    ]);
    const s = x[TOTAL] ?? ZERO_SALES();
    const per = (k: string, f: (t: (typeof totals)[number]) => number) => keyedSum(totals.filter((t) => t.kind === k), f);
    const refundN = per("refund", (t) => t.n);
    const refunded = per("refund", (t) => t.amountCents);
    const voidN = per("void", (t) => t.n);
    const voided = per("void", (t) => t.amountCents);
    return {
      stats: [
        { label: "Discounts", value: formatCents(s.discountCents), hint: `${d.reduce((a, r) => a + r.tickets, 0)} discounted lines` },
        { label: "Refunds", value: formatCents(refunded[TOTAL] ?? 0), hint: `${refundN[TOTAL] ?? 0} refunds` },
        { label: "Voids", value: formatCents(voided[TOTAL] ?? 0), hint: `${voidN[TOTAL] ?? 0} voided tickets` },
        { label: "Gross sales", value: formatCents(s.grossSalesCents) },
      ],
      tables: [
        metricTable(loc, {
          id: "totals",
          title: titled(loc, "Discounts and refunds"),
          exportOnly: tilesOnly(loc),
          metrics: [
            m("Gross sales", "money", x, (v) => v.grossSalesCents),
            m("Discounts", "money", x, (v) => v.discountCents),
            { label: "Refunds", kind: "int", at: refundN },
            { label: "Refunded", kind: "money", at: refunded },
            { label: "Voids", kind: "int", at: voidN },
            { label: "Voided", kind: "money", at: voided },
          ],
        }),
        listTable(loc, {
          id: "discounts",
          title: "Discounts by type",
          columns: [text("Type"), text("Label"), int("Tickets"), money("Amount")],
          rows: d.map((r) => ({ shopId: r.shopId!, staffId: r.staffId, key: `${r.source}|${r.label}`, cells: [r.source, r.label, r.tickets, r.cents] })),
          merge: true,
          sort: (a, b) => Number(b[3]) - Number(a[3]),
        }),
        listTable(loc, {
          id: "refunds",
          title: "Refunds and voids",
          subtitle: log.length >= 2000 ? "Showing the latest 2,000." : undefined,
          columns: [text("Date"), id("Ticket"), text("Barber"), text("Kind"), text("Tender"), money("Amount"), money("Tip"), text("Reason"), text("Issued by")],
          rows: log.map((r) => ({
            shopId: r.shopId,
            staffId: r.staffId,
            cells: [r.day, r.number, r.barber, r.kind, r.method, r.amountCents, r.tipCents, r.reason, r.by ?? (r.source === "stripe_dashboard" ? "Stripe dashboard" : null)],
          })),
          keepShop: loc.shops.length > 1,
          sort: byDayDesc,
        }),
      ],
    };
  },

  async inventory({ scope, loc }) {
    const r = await inventoryStatus(scope);
    const low = r.filter((x) => x.low);
    return {
      stats: [
        { label: "Products carried", value: String(new Set(r.map((x) => x.productId)).size), hint: loc.shops.length > 1 ? `${r.length} shop listings` : undefined },
        {
          label: "Low stock",
          value: String(low.length),
          tone: low.length ? "down" : undefined,
          hint: loc.shops.length > 1 ? "shop listings at or under reorder level" : undefined,
        },
        { label: "Stock at cost", value: formatCents(r.reduce((a, x) => a + x.valueCents, 0)) },
        { label: "Sold in range", value: String(r.reduce((a, x) => a + x.sold, 0)), hint: `${r.reduce((a, x) => a + x.received, 0)} received` },
      ],
      tables: [
        listTable(loc, {
          id: "stock",
          title: loc.view === "shops" || loc.shops.length === 1 ? "Stock by location" : "Stock across locations",
          subtitle: "On hand now. Received, sold, damaged and count changes are for the selected dates.",
          columns: [
            text("SKU"),
            text("Product"),
            int("On hand"),
            id("Reorder at"),
            { label: "Low", kind: "bool" },
            id("Cost", "money"),
            id("Price", "money"),
            money("Value at cost"),
            int("Received"),
            int("Sold"),
            int("Damaged"),
            int("Count changes"),
          ],
          rows: r.map((x) => ({
            shopId: x.shopId,
            key: x.productId,
            cells: [x.sku, x.product, x.stock, x.threshold, x.low, x.costCents, x.priceCents, x.valueCents, x.received, x.sold, x.damaged, x.counted],
          })),
          merge: true,
          shopsColumnAt: loc.shops.length > 1 ? 2 : undefined,
          sort: (a, b) => Number(b[4] === true) - Number(a[4] === true) || String(a[1]).localeCompare(String(b[1])),
        }),
      ],
      notes:
        loc.view === "combined" && loc.shops.length > 1
          ? ["Combined rows add up stock across shops. Low is shown only when every shop agrees; switch to By location for each shop's level."]
          : undefined,
    };
  },

  async gift_cards({ scope, loc }) {
    const [perShop, issued] = await Promise.all([giftCardTotalsByShop(scope), giftCardsIssued(scope)]);
    const total = {
      issuedN: sum(perShop, (v) => v.issuedN),
      issuedCents: sum(perShop, (v) => v.issuedCents),
      redeemedCents: sum(perShop, (v) => v.redeemedCents),
      outstandingN: sum(perShop, (v) => v.outstandingN),
      outstandingCents: sum(perShop, (v) => v.outstandingCents),
    };
    const x = shopKeyed(perShop, total);
    return {
      stats: [
        { label: "Issued", value: formatCents(total.issuedCents), hint: `${total.issuedN} cards` },
        { label: "Redeemed here", value: formatCents(total.redeemedCents) },
        { label: "Outstanding", value: formatCents(total.outstandingCents), hint: `${total.outstandingN} cards issued at these shops` },
      ],
      tables: [
        metricTable(loc, {
          id: "totals",
          title: "Gift cards by location",
          exportOnly: loc.view !== "shops",
          metrics: [
            m("Cards issued", "int", x, (v) => v.issuedN),
            m("Issued", "money", x, (v) => v.issuedCents),
            m("Redeemed here", "money", x, (v) => v.redeemedCents),
            m("Cards with a balance", "int", x, (v) => v.outstandingN),
            m("Outstanding", "money", x, (v) => v.outstandingCents),
          ],
        }),
        listTable(loc, {
          id: "issued",
          title: "Cards issued",
          columns: [text("Code"), text("Source"), money("Initial"), money("Balance"), text("Status"), text("Issued")],
          rows: issued.map((g) => ({ shopId: g.shopId, cells: [g.code, g.source, g.initialCents, g.balanceCents, g.status, g.created] })),
          keepShop: loc.shops.length > 1,
        }),
      ],
      notes: ["Balances work at every shop, so a card issued here can be redeemed elsewhere."],
    };
  },

  async loyalty({ scope, loc, viewer }) {
    const includeBrand = viewer.brandWide && scope.shopIds.length === viewer.shopIds.length;
    const [combined, split] = await Promise.all([loyaltyActivity(scope, includeBrand), loc.view === "shops" ? loyaltyByShop(scope, includeBrand) : null]);
    const t = combined;
    const BRAND = "brand";
    const perShop: Record<string, typeof t> = split ? { ...split.shops, ...(split.brand ? { [BRAND]: split.brand } : {}) } : {};
    const x = shopKeyed(perShop, t);
    const v: ViewCtx = split?.brand ? { ...loc, shops: [...loc.shops, { id: BRAND, name: "Brand (no ticket)" }] } : loc;
    return {
      stats: [
        { label: "Progress earned", value: formatCents(t.earnedCents), hint: `${t.members} clients earned` },
        { label: "Rewards issued", value: formatCents(t.rewardsIssuedCents), hint: `${t.rewardsIssued} rewards${t.manualRewards ? ` · ${t.manualRewards} manual` : ""}` },
        { label: "Rewards redeemed", value: formatCents(t.rewardsRedeemedCents), hint: `${t.rewardsRedeemed} rewards` },
        { label: "Reversed by refunds", value: formatCents(t.reversedCents) },
      ],
      tables: [
        metricTable(v, {
          id: "loyalty",
          title: "Loyalty activity",
          subtitle: loc.view === "shops" ? "Clients who earned at more than one shop count once in the total." : undefined,
          metrics: [
            m("Clients who earned", "int", x, (y) => y.members, false),
            m("Progress earned", "money", x, (y) => y.earnedCents),
            m("Progress reversed by refunds", "money", x, (y) => y.reversedCents),
            m("Rewards issued", "int", x, (y) => y.rewardsIssued),
            m("Rewards issued ($)", "money", x, (y) => y.rewardsIssuedCents),
            m("Rewards redeemed", "int", x, (y) => y.rewardsRedeemed),
            m("Rewards redeemed ($)", "money", x, (y) => y.rewardsRedeemedCents),
            ...(includeBrand ? [m("Manual rewards", "int", x, (y) => y.manualRewards)] : []),
          ],
        }),
      ],
      notes: includeBrand ? undefined : ["Manual rewards have no ticket or shop, so they're counted only when every shop is selected."],
    };
  },

  async client_ratings({ scope, loc }) {
    return { stats: [], tables: [await ratingsGivenTable(scope, loc)] };
  },

  async kpis({ scope, loc }) {
    const at = await kpisAt(scope, grainsFor(loc));
    const k = at[TOTAL] ?? emptyKpis(scope);
    const km = (label: string, kind: ColumnKind, f: (x: typeof k) => number | null, additive?: boolean) => m(label, kind, at, f, additive);
    return {
      stats: [
        {
          label: "Rebook rate",
          value: pct(k.rebookRate),
          hint: `${k.rebooked} of ${k.visits} visits rebooked within 24h${k.visitsWithoutBookingTime ? ` · ${k.visitsWithoutBookingTime} Squire visits without booking times left out` : ""}`,
        },
        { label: "Retention", value: pct(k.retentionRate), hint: `${k.retainedClients} of ${k.priorClients} clients from ${k.priorWindow.from} – ${k.priorWindow.to} came back` },
        {
          label: "New vs returning",
          value: `${k.newClients} / ${k.returningClients}`,
          hint: k.newClients + k.returningClients ? `${Math.round((k.newClients / (k.newClients + k.returningClients)) * 100)}% new · ${k.newToBrand} new to Ray'z` : undefined,
        },
        {
          label: "No-shows",
          value: String(k.noShows.n),
          hint: `${formatCents(k.noShows.cents)} lost · ${k.cancellations.n} cancellations`,
          tone: k.noShows.n ? "down" : undefined,
        },
      ],
      tables: [
        metricTable(loc, {
          id: "kpis",
          title: titled(loc, "Client KPIs"),
          subtitle:
            loc.view === "shops" || loc.byBarber
              ? "Visit and appointment counts add up. Client counts don't: a client seen at two shops or by two barbers counts in each row, and once in the total."
              : undefined,
          metrics: [
            km("Rebook rate", "pct", (x) => x.rebookRate),
            km("Visits rebooked within 24h", "int", (x) => x.rebooked),
            km("Visits with booking times", "int", (x) => x.visits),
            km("Retention", "pct", (x) => x.retentionRate),
            km("Clients retained", "int", (x) => x.retainedClients, false),
            km("Clients in the prior window", "int", (x) => x.priorClients, false),
            km("New clients", "int", (x) => x.newClients, false),
            km("New to Ray'z", "int", (x) => x.newToBrand, false),
            km("Returning clients", "int", (x) => x.returningClients, false),
            km("Appointments", "int", (x) => x.appointments),
            km("Walk-ins", "int", (x) => x.walkIns),
            km("No-shows", "int", (x) => x.noShows.n),
            km("No-show value", "money", (x) => x.noShows.cents),
            km("Cancellations", "int", (x) => x.cancellations.n),
          ],
        }),
      ],
    };
  },

  async heatmap({ scope, loc }) {
    const h = await appointmentHeatmap(scope, listGrain(loc));
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const combine = (cells: typeof h) => {
      const out = new Map<string, { dow: number; hour: number; n: number }>();
      for (const c of cells) {
        const k = `${c.dow}|${c.hour}`;
        const cur = out.get(k) ?? { dow: c.dow, hour: c.hour, n: 0 };
        cur.n += c.n;
        out.set(k, cur);
      }
      return [...out.values()];
    };
    const segs = segments(
      loc,
      h.map((c) => segKey(loc.view === "shops" ? c.shopId : null, loc.byBarber ? c.staffId : null)),
    );
    const inSeg = (c: (typeof h)[number], s: (typeof segs)[number]) => (s.shopId === null || c.shopId === s.shopId) && (s.staffId === null || c.staffId === s.staffId);
    const heatmaps: Heatmap[] =
      segs.length > 1
        ? [...segs.map((s) => ({ title: s.labels.join(" · "), cells: combine(h.filter((c) => inSeg(c, s))) })), { title: loc.totalLabel, cells: combine(h) }]
        : [{ title: segs[0]?.labels.join(" · ") ?? (loc.shops.length === 1 ? loc.shops[0].name : loc.totalLabel), cells: combine(h) }];
    return {
      stats: [{ label: "Appointments", value: String(h.reduce((a, x) => a + x.n, 0)) }],
      heatmaps,
      tables: [
        listTable(loc, {
          id: "heatmap",
          title: "Appointments by day and hour",
          exportOnly: true,
          columns: [text("Weekday"), id("Hour"), int("Appointments")],
          rows: [...h]
            .sort((a, b) => a.dow - b.dow || a.hour - b.hour)
            .map((x) => ({ shopId: x.shopId!, staffId: x.staffId, key: `${x.dow}|${x.hour}`, cells: [days[x.dow], x.hour, x.n] })),
          merge: true,
        }),
      ],
    };
  },

  async cash_drawer({ scope, loc }) {
    const r = await drawerHistory(scope);
    const closed = r.filter((x) => x.countedCents !== null);
    return {
      stats: [
        { label: "Drawers closed", value: String(closed.length), hint: `${r.length - closed.length} not closed` },
        { label: "Cash sales", value: formatCents(r.reduce((a, x) => a + x.cashSalesCents, 0)) },
        {
          label: "Net over / short",
          value: formatCents(closed.reduce((a, x) => a + (x.varianceCents ?? 0), 0)),
          tone: closed.some((x) => (x.varianceCents ?? 0) < 0) ? "down" : undefined,
        },
        { label: "Payouts", value: formatCents(r.reduce((a, x) => a + x.payoutsCents, 0)) },
      ],
      tables: [
        listTable(loc, {
          id: "drawers",
          title: "Drawer closes",
          columns: [
            text("Date"),
            money("Opening float"),
            money("Cash sales"),
            money("Cash refunds"),
            money("Payouts"),
            money("Expected"),
            money("Counted"),
            money("Over / short"),
            text("Closed by"),
            text("Notes"),
          ],
          rows: r.map((x) => ({
            shopId: x.shopId,
            cells: [x.day, x.openingCents, x.cashSalesCents, x.cashRefundsCents, x.payoutsCents, x.expectedCents, x.countedCents, x.varianceCents, x.closedBy, x.notes],
          })),
          keepShop: loc.shops.length > 1,
          sort: byDayDesc,
        }),
      ],
    };
  },

  async audit_log({ viewer, loc, params }) {
    const r = await auditRows({ viewer, loc, q: params.q, entity: params.entity, limit: 10000, offset: 0 });
    const v = auditView(viewer, loc);
    return {
      stats: [],
      tables: [
        listTable(v, {
          id: "audit",
          title: "Audit log",
          columns: [text("When"), text("Who"), text("Action"), text("Area"), text("Record"), text("Details")],
          rows: r.map(({ a }) => ({ shopId: a.shopId ?? BRAND_ROW, cells: [a.at.toISOString(), a.actorLabel, a.action, a.entity, a.entityId, JSON.stringify(a.details ?? {})] })),
          keepShop: true,
          totals: false,
        }),
      ],
    };
  },
};

const BRAND_ROW = "brand";

/** Brand-level entries (no shop: roles, groups, brand settings) are for people with every shop, whichever shops are picked. */
const auditIncludesBrand = (viewer: ReportInput["viewer"]) => viewer.brandWide;

export function auditView(viewer: ReportInput["viewer"], loc: ViewCtx): ViewCtx {
  return auditIncludesBrand(viewer) ? { ...loc, shops: [...loc.shops, { id: BRAND_ROW, name: "Brand" }] } : loc;
}

/** Audit entries at the selected shops, newest first, or grouped by shop for the by-location view. */
export async function auditRows(o: { viewer: ReportInput["viewer"]; loc: ViewCtx; q?: string; entity?: string; limit: number; offset: number }) {
  const q = o.q?.trim();
  const ids = o.loc.shops.map((s) => s.id);
  const where = and(
    or(ids.length ? inArray(auditLog.shopId, ids) : sql`false`, auditIncludesBrand(o.viewer) ? isNull(auditLog.shopId) : undefined),
    o.entity ? eq(auditLog.entity, o.entity) : undefined,
    q
      ? or(ilike(auditLog.action, `%${q}%`), ilike(auditLog.actorLabel, `%${q}%`), ilike(auditLog.entityId, `%${q}%`), sql`${auditLog.details}::text ilike ${`%${q}%`}`)
      : undefined,
  );
  const order = o.loc.view === "shops" ? [sql`${auditLog.shopId} is null`, asc(shops.name), desc(auditLog.at)] : [desc(auditLog.at)];
  return db
    .select({ a: auditLog, shop: shops.name })
    .from(auditLog)
    .leftJoin(shops, eq(shops.id, auditLog.shopId))
    .where(where)
    .orderBy(...order)
    .limit(o.limit)
    .offset(o.offset);
}

export function tableCsv(t: ReportTable): string {
  const c = csvTable(t);
  return toCsv(c.headers, c.rows);
}
