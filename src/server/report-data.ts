import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, shops } from "@/db/schema";
import { NO_PRIVATE, ReasonViewer, redactReasonDetails } from "@/domain/block-reasons";
import { ClientPolicy, LOCKED_POLICY, redactAuditDetails, searchesClientDetails } from "./client-privacy";
import { Permission, ReportKey } from "@/domain/permissions";
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
  itemMix,
  kpisAt,
  loyaltyActivity,
  loyaltyByShop,
  monthlyTotals,
  payrollTips,
  refundLog,
  refundTotals,
  salesTotalsAt,
  tenderAt,
  toCsv,
} from "./reports";
import { ledgerEntries, movement, poHistory, sellThrough, valuation, vendorSpend, isCurrent } from "./inventory/reports";
import { stockLevels } from "./inventory/stock";
import { suggestionsFor } from "./inventory/purchasing";
import { ADJUST_REASON_LABEL, LEDGER_KIND_LABEL, PO_STATUS_LABEL, poNumber } from "@/domain/inventory";
import { addDays, diffDays, formatDate, formatDateTime } from "@/lib/time";
import { EXCEPTION_LABEL } from "@/domain/morning-dashboard";
import { morningDoc } from "@/domain/morning-render";
import { ACCOUNT_STATE_LABEL, PAYMENTS_MODE_LABEL } from "@/domain/connect";
import { ShopAccountRow, coveredOwners, payoutRows, shopAccountRows } from "./payments/account-report";
import { rollupData } from "./rollup-report";
import { serviceTimesData } from "./service-times-report";
import { staffingData } from "./staffing-report";
import { callInReportData } from "./call-in-report";
import { operationsData } from "./operations-report";
import { checkoutPromptsData } from "./checkout-prompts-report";
import { reviewReportData } from "./review-report";
import { marketingReportData } from "./marketing/report";
import { lapsedReportData } from "./marketing/lapsed-report";
import { openingsReportData } from "./marketing/openings-report";
import { attendanceData, laborData } from "./labor-report";
import { tipPayoutsData } from "./tips/report";
import { commissionPayoutData } from "./commission-report";
import { acquisitionData, endOfDayData, leaderboardData, phoneOperatorData, retentionData, salesTaxData } from "./shop-reports";
import { morningDashboardFor } from "./morning-dashboard";
import { ratingsGivenAt } from "./ratings-report";
import { grainsFor } from "./report-sql";
import type { StaffAccess } from "./auth/access";

/**
 * Every a la carte report is one loader returning stats and tables. The report page renders them
 * and the export route turns the same tables into CSV, so what you see is what you download.
 *
 * Loaders fetch each grain a view shows (per shop, per barber, per barber per shop) and the total
 * from the same SQL, and the table builders lay them out. Lists are fetched at the finest grain and
 * added up by the builders. Tests check that every grain adds up to the next.
 */

export type { Cell, ColumnKind, ReportTable } from "@/domain/report-views";
export { grainsFor } from "./report-sql";

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
/** A report's own filter, shown as a row of choices next to the dates: "Visits to qualify: 1+ 2+ 3+". */
export interface ReportOption {
  param: string;
  label: string;
  value: string;
  choices: { value: string; label: string }[];
}
export interface ReportData {
  stats: ReportStat[];
  tables: ReportTable[];
  heatmaps?: Heatmap[];
  notes?: string[];
  options?: ReportOption[];
}

export interface ReportInput {
  scope: ReportScope;
  /** Combined, by location, by barber or by location and barber, over the selected shops and barbers. */
  loc: ViewCtx;
  /** The viewer's access: brand-level rows (no shop) are only for people with every shop. */
  viewer: { brandWide: boolean; currentShopId: string | null; shopIds: string[]; permissions?: ReadonlySet<Permission>; access?: StaffAccess };
  /** What the viewer may see of client records; without it, client details in the audit log are hidden. */
  client?: ClientPolicy;
  /** Who is looking at block and time off reasons; without it, private reasons are hidden. */
  reasons?: ReasonViewer;
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
    m("Kids' cuts", "int", k, (v) => v.kidsCuts),
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

// ───────────────────────────── Inventory and purchasing ─────────────────────────────

const days = (scope: ReportScope) => diffDays(scope.to, scope.from) + 1;
const multi = (loc: ViewCtx) => loc.shops.length > 1;
/** Merged rows list the shops they came from, after the product name. */
const shopsAt = (loc: ViewCtx, at: number) => (multi(loc) && loc.view === "combined" ? at : undefined);
const byProduct = (at: number) => (a: Cell[], b: Cell[]) => String(a[at]).localeCompare(String(b[at]));

async function inventoryValuation(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const r = await valuation(scope);
  const units = r.reduce((a, x) => a + Math.max(0, x.onHand), 0);
  const value = r.reduce((a, x) => a + x.valueCents, 0);
  const retail = r.reduce((a, x) => a + x.retailCents, 0);
  const onOrder = r.reduce((a, x) => a + x.onOrderCents, 0);
  const negative = r.filter((x) => x.onHand < 0);
  const margin = (c: Cell[], v: number, rt: number) => {
    const out = [...c];
    out[rt + 1] = typeof c[rt] === "number" && (c[rt] as number) > 0 ? ((c[rt] as number) - (c[v] as number)) / (c[rt] as number) : null;
    return out;
  };
  return {
    stats: [
      { label: "Stock at cost", value: formatCents(value), hint: `${units} units on hand` },
      { label: "Stock at retail", value: formatCents(retail), hint: retail ? `${pct((retail - value) / retail)} margin` : undefined },
      { label: "On order at cost", value: formatCents(onOrder), hint: "approved and sent orders, not yet received" },
      { label: "Products carried", value: String(new Set(r.map((x) => x.productId)).size), hint: multi(loc) ? `${r.length} shop listings` : undefined },
    ],
    tables: [
      listTable(loc, {
        id: "categories",
        title: "By category",
        columns: [text("Category"), int("Units"), money("Value at cost"), money("Value at retail"), { label: "Margin", kind: "pct" }],
        rows: r.map((x) => ({ shopId: x.shopId, key: x.category, cells: [x.category, Math.max(0, x.onHand), x.valueCents, x.retailCents, null] })),
        merge: true,
        derive: (c) => margin(c, 2, 3),
        sort: byProduct(0),
      }),
      listTable(loc, {
        id: "stock",
        title: "Stock value",
        subtitle: isCurrent(scope)
          ? "On hand now, at each shop's average shelf cost and its price."
          : `On hand at the end of ${formatDate(scope.to, "MMM d, yyyy")} (today's stock less everything posted since), at today's shelf cost.`,
        columns: [text("SKU"), text("Product"), text("Category"), int("On hand"), id("Cost", "money"), money("Value at cost"), id("Price", "money"), money("Value at retail"), int("On order"), money("On order at cost")],
        rows: r.map((x) => ({ shopId: x.shopId, key: x.productId, cells: [x.sku, x.product, x.category, x.onHand, x.costCents, x.valueCents, x.priceCents, x.retailCents, x.onOrder, x.onOrderCents] })),
        merge: true,
        shopsColumnAt: shopsAt(loc, 2),
        sort: byProduct(1),
      }),
    ],
    notes: negative.length ? [`${negative.length} ${negative.length === 1 ? "listing is" : "listings are"} below zero on hand and counted as zero in the value. Count them to correct the shelf.`] : undefined,
  };
}

async function inventoryMovement(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const [r, log] = await Promise.all([movement(scope), ledgerEntries(scope)]);
  const t = (f: (x: (typeof r)[number]) => number) => r.reduce((a, x) => a + f(x), 0);
  const shrinkUnits = (x: (typeof r)[number]) => x.damaged + x.theft + x.lostInTransit - x.countVariance - x.found;
  return {
    stats: [
      { label: "Sold", value: String(t((x) => x.sold - x.returned)), hint: `${t((x) => x.sold)} sold · ${t((x) => x.returned)} returned` },
      { label: "Received", value: String(t((x) => x.received)), hint: `${t((x) => x.transferIn)} transferred in · ${t((x) => x.transferOut)} out` },
      { label: "Shrink", value: formatCents(t((x) => x.shrinkCents)), hint: `${t(shrinkUnits)} units: damage, theft, count losses, lost in transit`, tone: t((x) => x.shrinkCents) > 0 ? "down" : undefined },
      { label: "Back bar", value: formatCents(t((x) => x.backBarCents)), hint: `${t((x) => x.backBar)} units used in services` },
    ],
    tables: [
      listTable(loc, {
        id: "movement",
        title: "Stock movement",
        subtitle: "Opening + received + returned + transfers in − sold − transfers out − damaged − theft − back bar + found + count variance + other = closing. Lost in transit already left with the transfer out.",
        columns: [
          text("SKU"),
          text("Product"),
          int("Opening"),
          int("Received"),
          int("Sold"),
          int("Returned"),
          int("Transfer in"),
          int("Transfer out"),
          int("Damaged"),
          int("Theft"),
          int("Back bar"),
          int("Found"),
          int("Count variance"),
          int("Other"),
          int("Closing"),
          int("Lost in transit"),
          int("Shrink units"),
          money("Shrink at cost"),
        ],
        rows: r.map((x) => ({
          shopId: x.shopId,
          key: x.productId,
          cells: [x.sku, x.product, x.opening, x.received, x.sold, x.returned, x.transferIn, x.transferOut, x.damaged, x.theft, x.backBar, x.found, x.countVariance, x.other, x.closing, x.lostInTransit, shrinkUnits(x), x.shrinkCents],
        })),
        merge: true,
        shopsColumnAt: shopsAt(loc, 2),
        sort: byProduct(1),
      }),
      listTable(loc, {
        id: "ledger",
        title: "Ledger entries",
        subtitle: log.length >= 2000 ? "Showing the latest 2,000." : "Every stock change in the range, newest first.",
        columns: [text("When"), text("SKU"), text("Product"), text("Kind"), text("Reason"), int("Change"), id("On hand after"), id("Unit cost", "money"), text("Reference"), text("Note"), text("By")],
        rows: log.map((e) => ({
          shopId: e.shopId,
          cells: [
            formatDateTime(e.at),
            e.sku,
            e.product,
            LEDGER_KIND_LABEL[e.kind] ?? e.kind,
            e.reason ? (ADJUST_REASON_LABEL[e.reason as keyof typeof ADJUST_REASON_LABEL] ?? e.reason) : null,
            e.delta,
            e.balanceAfter,
            e.unitCostCents,
            e.ref,
            e.note,
            e.by,
          ],
        })),
        keepShop: multi(loc),
        totals: false,
      }),
    ],
  };
}

async function sellThroughData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const r = await sellThrough(scope);
  const n = days(scope);
  // SKU, Product, Opening, Received, Sold, Closing, Sell-through, Per day, Days of cover, Net sales, Cost of goods, Margin
  const derive = (c: Cell[]) => {
    const out = [...c];
    const num = (i: number) => (typeof c[i] === "number" ? (c[i] as number) : 0);
    const available = num(2) + num(3);
    const perDay = num(4) / n;
    out[6] = available > 0 ? num(4) / available : null;
    out[7] = perDay;
    out[8] = perDay > 0 ? Math.max(0, num(5)) / perDay : null;
    out[11] = num(9) > 0 ? (num(9) - num(10)) / num(9) : null;
    return out;
  };
  const sold = r.reduce((a, x) => a + x.soldNet, 0);
  const available = r.reduce((a, x) => a + x.opening + x.receivedIn, 0);
  const sales = r.reduce((a, x) => a + x.netSalesCents, 0);
  const cogs = r.reduce((a, x) => a + x.cogsCents, 0);
  const dead = r.filter((x) => x.soldNet <= 0 && x.closing > 0);
  return {
    stats: [
      { label: "Sell-through", value: pct(ratio(sold, available)), hint: `${sold} sold of ${available} available` },
      { label: "Net retail sales", value: formatCents(sales), hint: sales ? `${pct((sales - cogs) / sales)} margin at cost` : undefined },
      { label: "Units per day", value: (sold / n).toFixed(1), hint: `over ${n} ${n === 1 ? "day" : "days"}` },
      { label: "Not selling", value: String(dead.length), hint: "listings with stock and no sales in the range", tone: dead.length ? "down" : undefined },
    ],
    tables: [
      listTable(loc, {
        id: "sell_through",
        title: "Sell-through by product",
        subtitle: "Sold (less returns) out of opening stock plus what was received or transferred in. Days of cover: closing stock at the range's selling rate.",
        columns: [
          text("SKU"),
          text("Product"),
          int("Opening"),
          int("Received"),
          int("Sold"),
          int("Closing"),
          { label: "Sell-through", kind: "pct" },
          { label: "Per day", kind: "decimal" },
          { label: "Days of cover", kind: "decimal" },
          money("Net sales"),
          money("Cost of goods"),
          { label: "Margin", kind: "pct" },
        ],
        rows: r.map((x) => ({ shopId: x.shopId, key: x.productId, cells: derive([x.sku, x.product, x.opening, x.receivedIn, x.soldNet, x.closing, null, null, null, x.netSalesCents, x.cogsCents, null]) })),
        merge: true,
        derive,
        shopsColumnAt: shopsAt(loc, 2),
        sort: (a, b) => Number(b[6] ?? -1) - Number(a[6] ?? -1) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
  };
}

async function lowStockData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const [levels, suggestions] = await Promise.all([stockLevels(scope.shopIds), suggestionsFor(scope.shopIds)]);
  const suggested = new Map<string, { qty: number; cents: number; vendor: string | null }>();
  for (const s of suggestions) {
    for (const o of s.orders) for (const l of o.lines) suggested.set(`${s.shopId}|${l.productId}`, { qty: l.qty, cents: l.qty * l.unitCostCents, vendor: o.vendorName });
    for (const l of s.noVendor) suggested.set(`${s.shopId}|${l.productId}`, { qty: l.qty, cents: 0, vendor: null });
  }
  const low = levels.filter((x) => x.low);
  const cents = low.reduce((a, x) => a + (suggested.get(`${x.shopId}|${x.productId}`)?.cents ?? 0), 0);
  const out = low.filter((x) => x.available <= 0);
  return {
    stats: [
      { label: "Low stock", value: String(low.length), hint: multi(loc) ? "shop listings at or below the reorder point" : "products at or below the reorder point", tone: low.length ? "down" : undefined },
      { label: "Out of stock", value: String(out.length), hint: "nothing available to sell", tone: out.length ? "down" : undefined },
      { label: "Suggested orders", value: formatCents(cents), hint: "to bring them to par, at vendor cost" },
      { label: "Already coming", value: String(low.reduce((a, x) => a + x.onOrder + x.inTransit, 0)), hint: "units on order or in transit" },
    ],
    tables: [
      listTable(loc, {
        id: "low_stock",
        title: "At or below the reorder point",
        subtitle: "Now, whatever the dates. Available is on hand less what's on open tickets and transfers being picked. Suggested fills to par after what's coming, in whole cases.",
        columns: [
          text("SKU"),
          text("Product"),
          int("Available"),
          int("On hand"),
          int("Committed"),
          int("On order"),
          int("In transit"),
          id("Reorder at"),
          id("Par"),
          int("Suggested"),
          text("Vendor"),
          money("Suggested at cost"),
        ],
        rows: low.map((x) => {
          const sg = suggested.get(`${x.shopId}|${x.productId}`);
          return {
            shopId: x.shopId,
            cells: [x.sku, `${x.brand} ${x.name}`, x.available, x.onHand, x.committed, x.onOrder, x.inTransit, x.levels.reorderPoint, x.levels.par, sg?.qty ?? 0, sg?.vendor ?? x.preferredVendor?.name ?? null, sg?.cents ?? 0],
          };
        }),
        keepShop: multi(loc),
        sort: (a, b) => Number(a[2]) - Number(b[2]) || String(a[1]).localeCompare(String(b[1])),
      }),
    ],
  };
}

async function purchasingData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const [spend, pos] = await Promise.all([vendorSpend(scope), poHistory(scope)]);
  const t = (f: (x: (typeof spend)[number]) => number, xs = spend) => xs.reduce((a, x) => a + f(x), 0);
  // Lead time and fill rate don't add up; they're worked out per vendor over the selected shops, and overall.
  const perVendor = new Map<string, { lead: number | null; fill: number | null }>();
  const rate = (xs: typeof spend) => ({ lead: t((x) => x.leadOrders, xs) ? t((x) => x.leadDaysTotal, xs) / t((x) => x.leadOrders, xs) : null, fill: ratio(t((x) => x.unitsReceivedClosed, xs), t((x) => x.unitsOrderedClosed, xs)) });
  for (const v of new Set(spend.map((x) => x.vendor))) perVendor.set(v, rate(spend.filter((x) => x.vendor === v)));
  const overall = rate(spend);
  const derive = (c: Cell[]) => {
    const out = [...c];
    const r = typeof c[0] === "string" && perVendor.has(c[0]) ? perVendor.get(c[0])! : c[0] === loc.totalLabel ? overall : null;
    out[8] = r?.lead ?? null;
    out[9] = r?.fill ?? null;
    return out;
  };
  const shopRate = (x: (typeof spend)[number]) => [x.leadOrders ? x.leadDaysTotal / x.leadOrders : null, ratio(x.unitsReceivedClosed, x.unitsOrderedClosed)];
  return {
    stats: [
      { label: "Ordered", value: formatCents(t((x) => x.orderedCents)), hint: `${t((x) => x.ordersSent)} orders sent` },
      { label: "Received at cost", value: formatCents(t((x) => x.receivedCents)), hint: `${t((x) => x.unitsReceived)} units in ${t((x) => x.receipts)} deliveries` },
      { label: "On order now", value: formatCents(t((x) => x.onOrderCents)) },
      {
        label: "Cost changes",
        value: formatCents(t((x) => x.costVarianceCents), { sign: true }),
        hint: "received at a different price than ordered",
        tone: t((x) => x.costVarianceCents) > 0 ? "down" : undefined,
      },
    ],
    tables: [
      listTable(loc, {
        id: "vendors",
        title: "Vendor spend",
        subtitle: "Ordered: orders sent in the range, at the order price. Received: deliveries in the range, at what the vendor charged. Fill rate: units received on orders completed in the range.",
        columns: [
          text("Vendor"),
          int("Orders sent"),
          money("Ordered"),
          int("Deliveries"),
          int("Units received"),
          money("Received at cost"),
          money("Cost changes"),
          money("On order now"),
          { label: "Days to deliver", kind: "decimal" },
          { label: "Fill rate", kind: "pct" },
        ],
        rows: spend.map((x) => ({
          shopId: x.shopId,
          key: x.vendorId,
          cells: [x.vendor, x.ordersSent, x.orderedCents, x.receipts, x.unitsReceived, x.receivedCents, x.costVarianceCents, x.onOrderCents, ...shopRate(x)],
        })),
        merge: true,
        derive,
        shopsColumnAt: shopsAt(loc, 1),
        sort: byProduct(0),
      }),
      listTable(loc, {
        id: "orders",
        title: "Purchase orders",
        subtitle: pos.length >= 2000 ? "Showing the latest 2,000." : "Created, sent or received in the range.",
        columns: [
          text("PO"),
          text("Vendor"),
          text("Status"),
          text("Created"),
          text("Sent"),
          text("Expected"),
          text("Received"),
          id("Lines"),
          int("Units"),
          int("Units received"),
          money("Ordered"),
          money("Received at cost"),
        ],
        rows: pos.map((p) => ({
          shopId: p.shopId,
          cells: [
            poNumber(p.number),
            p.vendor,
            `${PO_STATUS_LABEL[p.status as keyof typeof PO_STATUS_LABEL] ?? p.status}${p.closedShort ? " (closed short)" : ""}`,
            p.createdOn,
            p.sentOn,
            p.expectedOn,
            p.receivedOn,
            p.lines,
            p.units,
            p.unitsReceived,
            p.orderedCents,
            p.receivedCents,
          ],
        })),
        keepShop: multi(loc),
      }),
    ],
  };
}

/**
 * The dashboard as report tables, for CSV: every metric for the morning after the range's last
 * day, and the exceptions. Numbers come formatted, as on the page.
 */
async function morningReportData(access: StaffAccess, scope: ReportScope): Promise<ReportData> {
  const d = await morningDashboardFor(access, "", scope.shopIds, addDays(scope.to, 1));
  if (!d) return { stats: [], tables: [] };
  const doc = morningDoc(d);
  const text = (label: string) => ({ label });
  const metrics = doc.sections.flatMap((s) =>
    s.blocks.flatMap((b) => (b.kind === "metrics" ? b.rows.map((r) => [s.title, r.label.trim(), r.day, r.dayChange, r.wtd, r.wtdChange]) : [])),
  );
  const items = (d.exceptions?.items ?? []).map((i) => [EXCEPTION_LABEL[i.category], i.severity, i.shop, i.title, i.detail ?? null]);
  return {
    stats: doc.tiles.map((t) => ({ label: t.label, value: t.value, hint: t.sub })),
    tables: [
      {
        id: "metrics",
        title: `Morning Dashboard: ${doc.coverage}`,
        columns: [text("Section"), text("Metric"), text(formatDate(d.periods.reportDay, "EEE MMM d")), text(`vs ${formatDate(d.periods.compareDay, "EEE MMM d")}`), text("Week to date"), text("vs the same days last week")],
        rows: metrics,
      },
      { id: "exceptions", title: "Needs attention", columns: [text("Kind"), text("Severity"), text("Location"), text("Item"), text("Detail")], rows: items },
    ],
  };
}

export const REPORT_LOADERS: Record<ReportKey, (i: ReportInput) => Promise<ReportData>> = {
  async my_sales({ scope, loc }) {
    return salesData(scope, loc);
  },

  async sales_summary({ scope, loc }) {
    return salesData(scope, loc);
  },

  async end_of_day({ scope, loc }) {
    return endOfDayData(scope, loc);
  },

  async sales_by_barber({ scope, loc }) {
    return barberPerformance(scope, loc);
  },

  async leaderboard({ scope, loc, params }) {
    return leaderboardData(scope, loc, params);
  },

  async sales_tax({ scope, loc, params }) {
    return salesTaxData(scope, loc, params);
  },

  async retention({ scope, loc, params }) {
    return retentionData(scope, loc, params);
  },

  async acquisition({ scope, loc }) {
    return acquisitionData(scope, loc);
  },

  async phone_operator({ scope, loc }) {
    return phoneOperatorData(scope, loc);
  },

  async service_times({ scope, loc }) {
    return serviceTimesData(scope, loc);
  },

  async labor({ scope, loc, viewer }) {
    return laborData(scope, loc, viewer.permissions);
  },

  async commission_payout({ scope, loc }) {
    return commissionPayoutData(scope, loc);
  },

  async attendance({ scope, loc }) {
    return attendanceData(scope, loc);
  },

  async tip_payouts({ scope, loc }) {
    return tipPayoutsData(scope, loc);
  },

  async staffing({ scope, loc, reasons }) {
    return staffingData(scope, loc, reasons ?? NO_PRIVATE);
  },

  async call_ins({ scope, loc, reasons }) {
    return callInReportData(scope, loc, reasons ?? NO_PRIVATE);
  },

  async google_reviews({ scope, loc }) {
    return reviewReportData(scope, loc);
  },

  async campaign_center({ scope, loc }) {
    return marketingReportData(scope, loc);
  },

  async lapsed_clients({ scope, loc }) {
    return lapsedReportData(scope, loc);
  },

  async openings({ scope, loc }) {
    return openingsReportData(scope, loc);
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

  async shop_accounts({ scope, viewer }) {
    const brandPayouts = viewer.brandWide && scope.shopIds.length === viewer.shopIds.length;
    const owned = await coveredOwners(scope.shopIds);
    const [accounts, payouts] = await Promise.all([shopAccountRows(scope), payoutRows(scope, { brand: brandPayouts, owners: owned })]);
    const cols: Column[] = [
      text("Owner"),
      text("Shop"),
      text("Stripe account"),
      text("Status"),
      int("Card charges"),
      money("Card takings"),
      money("Card tips"),
      money("Surcharges"),
      money("Card refunds"),
      money("Processing fees"),
      money("To Stripe accounts"),
      money("Payouts paid"),
      money("Payouts in transit"),
      money("Cash"),
      money("Gift card redemptions"),
    ];
    const nums = (r: ShopAccountRow) => [
      r.cardCharges,
      r.cardNetCents,
      r.cardTipsCents,
      r.surchargeCents,
      r.cardRefundsCents,
      r.processingFeesCents,
      r.toAccountCents,
      r.payoutsPaidCents,
      r.payoutsPendingCents,
      r.cashCents,
      r.giftCardCents,
    ];
    const add = (xs: ShopAccountRow[]) => Array.from({ length: 11 }, (_, i) => xs.reduce((a, r) => a + nums(r)[i], 0));
    const rowsOut: Cell[][] = [];
    const styles: ("subtotal" | "total" | undefined)[] = [];
    const owners = [...new Map(accounts.map((r) => [r.ownerId ?? "none", r.ownerName])).entries()];
    for (const [ownerId, ownerName] of owners) {
      const mine = accounts.filter((r) => (r.ownerId ?? "none") === ownerId);
      for (const r of mine) {
        rowsOut.push([
          r.ownerName,
          r.shopName,
          r.paymentsMode === "brand" ? "Brand account" : r.paymentsMode === "entity" ? `Owner's: ${r.ownerAccountId ?? "—"}` : (r.stripeAccountId ?? "—"),
          r.paymentsMode === "connected" || r.paymentsMode === "entity" ? ACCOUNT_STATE_LABEL[r.state] : PAYMENTS_MODE_LABEL[r.paymentsMode],
          ...nums(r),
        ]);
        styles.push(undefined);
      }
      if (owners.length > 1 || mine.length > 1) {
        rowsOut.push([`${ownerName} total`, `${mine.length} shop${mine.length === 1 ? "" : "s"}`, null, null, ...add(mine)]);
        styles.push("subtotal");
      }
    }
    if (owners.length > 1) {
      rowsOut.push(["All owners", `${accounts.length} shops`, null, null, ...add(accounts)]);
      styles.push("total");
    }
    const total = add(accounts);
    const unrouted = accounts.reduce((a, r) => a + r.unroutedCardCents, 0);
    const notReady = accounts.filter((r) => (r.paymentsMode === "connected" || r.paymentsMode === "entity") && !r.canCharge);
    const cashOnly = accounts.filter((r) => r.paymentsMode === "cash_only");
    const restricted = accounts.filter((r) => (r.paymentsMode === "connected" || r.paymentsMode === "entity") && r.canCharge && r.state !== "enabled");
    const brandSettled = accounts.reduce((a, r) => a + r.brandSettledCents, 0);
    return {
      stats: [
        { label: "Card takings", value: formatCents(total[1]), hint: `${total[0]} charges, after ${formatCents(total[4])} refunds` },
        { label: "Processing fees", value: formatCents(total[5]), hint: total[1] ? `${((total[5] / total[1]) * 100).toFixed(2)}% of card takings` : undefined },
        { label: "To Stripe accounts", value: formatCents(total[6]), hint: brandSettled ? `card takings less fees; ${formatCents(brandSettled)} in the brand's account` : "card takings less fees" },
        { label: "Paid out to banks", value: formatCents(total[7]), hint: total[8] ? `${formatCents(total[8])} in transit` : undefined },
      ],
      tables: [
        {
          id: "accounts",
          title: "P&L by shop account",
          subtitle:
            "Card charges settle in the shop's own Stripe connected account, its owner's account, or the brand's account, as each shop is set. Card takings include tips and surcharges, after refunds. Cash and gift cards never touch Stripe.",
          columns: cols,
          rows: rowsOut,
          rowStyles: styles,
        },
        {
          id: "payouts",
          title: "Payouts",
          subtitle: `Deposits from each shop's connected account to its bank, by arrival date${owned.length ? ", owners' pooled deposits for owners whose every shop is shown" : ""}${brandPayouts ? ", and the brand account's pooled deposits to the brand's bank" : ""}. The Payouts page itemizes each one.`,
          columns: [text("Arrives"), text("Account"), text("Payout"), text("Status"), money("Gross"), money("Fees"), money("Refunds"), money("Net deposit"), text("Problem")],
          rows: payouts.map((p) => [p.arrivalDate, p.shopName, p.stripePayoutId, p.status.replace("_", " "), p.grossCents, p.feeCents, p.refundCents, p.amountCents, p.failureMessage]),
        },
      ],
      notes: [
        ...(notReady.length ? [`Not taking cards yet: ${notReady.map((r) => `${r.shopName} (${ACCOUNT_STATE_LABEL[r.state].toLowerCase()})`).join(", ")}. Finish Payments in Location setup.`] : []),
        ...(restricted.length ? [`Stripe needs more details before paying out: ${restricted.map((r) => r.shopName).join(", ")}. See Payments in Location setup.`] : []),
        ...(cashOnly.length ? [`Cash and gift cards only: ${cashOnly.map((r) => r.shopName).join(", ")}.`] : []),
        ...(accounts.some((r) => r.entitySettledCents)
          ? [`Shops on their owner's account are paid out together to the owner's bank, so their payout columns stay empty; the owner account's deposits are listed under Payouts.`]
          : []),
        ...(brandSettled ? [`Shops on the brand's account are paid out together to the brand's bank, so their payout columns stay empty; the brand account's deposits are on the Payouts page.`] : []),
        ...(unrouted ? [`${formatCents(unrouted)} of card takings in this range settled before shops had their own accounts, so it isn't in "To Stripe accounts".`] : []),
        "Processing fees are kept on refunded and voided charges, the same as Stripe's own fee.",
      ],
    };
  },

  async rollup(i) {
    return rollupData(i);
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
          columns: [text("Date"), id("Ticket"), text("Barber"), text("Kind"), text("Tender"), money("Amount"), money("Tip"), text("Reason"), text("Issued by"), text("Manager approval")],
          rows: log.map((r) => ({
            shopId: r.shopId,
            staffId: r.staffId,
            cells: [r.day, r.number, r.barber, r.kind, r.method, r.amountCents, r.tipCents, r.reason, r.by ?? (r.source === "stripe_dashboard" ? "Stripe dashboard" : null), r.approvedBy],
          })),
          keepShop: loc.shops.length > 1,
          sort: byDayDesc,
        }),
      ],
    };
  },

  async inventory({ scope, loc }) {
    return inventoryValuation(scope, loc);
  },

  async inventory_movement({ scope, loc }) {
    return inventoryMovement(scope, loc);
  },

  async sell_through({ scope, loc }) {
    return sellThroughData(scope, loc);
  },

  async low_stock({ scope, loc }) {
    return lowStockData(scope, loc);
  },

  async purchasing({ scope, loc }) {
    return purchasingData(scope, loc);
  },

  async gift_cards({ scope, loc }) {
    const bv: ViewCtx = { ...loc, byBarber: true };
    const sv: ViewCtx = { ...loc, byBarber: false };
    const [perShop, issued, bx, btender] = await Promise.all([giftCardTotalsByShop(scope), giftCardsIssued(scope), salesTotalsAt(scope, grainsFor(bv)), tenderAt(scope, grainsFor(bv))]);
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
        metricTable(sv, {
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
        listTable(sv, {
          id: "issued",
          title: "Cards issued",
          columns: [text("Code"), text("Source"), money("Initial"), money("Balance"), text("Status"), text("Issued")],
          rows: issued.map((g) => ({ shopId: g.shopId, cells: [g.code, g.source, g.initialCents, g.balanceCents, g.status, g.created] })),
          keepShop: loc.shops.length > 1,
        }),
        metricTable(bv, {
          id: "barbers",
          title: loc.view === "shops" ? "Sold and redeemed on tickets, by location and barber" : "Sold and redeemed on tickets, by barber",
          subtitle: "Gift cards sold on a ticket, after refunds, and gift card payments, credited to the barber on the ticket.",
          metrics: [m("Gift cards sold", "money", bx, (v) => v.giftCardsSoldCents), m("Paid with gift cards", "money", btender, (v) => v.giftCardCents)],
        }),
      ],
      notes: [
        "Balances work at every shop, so a card issued here can be redeemed elsewhere.",
        ...(scope.staffIds?.length ? ["Cards issued and outstanding are the shop's, whichever barbers are picked; the barber table follows the pick."] : []),
      ],
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
        {
          label: "Kids' cuts",
          value: String(k.kidsCuts),
          hint: k.visits || k.kidsCuts ? `${k.kidsClients} kids on family accounts` : undefined,
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
            km("Kids' cuts", "int", (x) => x.kidsCuts),
            km("Kids seen", "int", (x) => x.kidsClients, false),
            km("No-shows", "int", (x) => x.noShows.n),
            km("No-show value", "money", (x) => x.noShows.cents),
            km("Cancellations", "int", (x) => x.cancellations.n),
          ],
        }),
      ],
    };
  },

  async operations({ scope, loc }) {
    return operationsData(scope, loc);
  },

  async checkout_prompts({ scope, loc }) {
    return checkoutPromptsData(scope, loc);
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
    const bv: ViewCtx = { ...loc, byBarber: true };
    const [r, btender] = await Promise.all([drawerHistory(scope), tenderAt(scope, grainsFor(bv))]);
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
            money("Opening balance"),
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
        metricTable(bv, {
          id: "barbers",
          title: loc.view === "shops" ? "Cash taken by location and barber" : "Cash taken by barber",
          subtitle: "Cash payments after cash refunds, credited to the barber on the ticket. The drawer itself is the shop's, whichever barbers are picked.",
          metrics: [m("Cash", "money", btender, (v) => v.cashCents), m("Cash tips", "money", btender, (v) => v.cashTipsCents)],
        }),
      ],
    };
  },

  async morning_dashboard({ scope, viewer }) {
    return viewer.access ? morningReportData(viewer.access, scope) : { stats: [], tables: [] };
  },

  async audit_log({ viewer, loc, params, client, reasons }) {
    const r = await auditRows({ viewer, client: client ?? LOCKED_POLICY, reasons, loc, q: params.q, entity: params.entity, limit: 10000, offset: 0 });
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

/**
 * Audit entries at the selected shops, newest first, or grouped by shop for the by-location view.
 * Client details in an entry (a profile edit's before and after, a merged record) come back as the
 * viewer may see them, and searching inside client entries is only for people who see them in full.
 */
export async function auditRows(o: {
  viewer: ReportInput["viewer"];
  client: ClientPolicy;
  /** Private block and time off reasons show as "Blocked" or "Time off", and aren't searched, unless they may see them. */
  reasons?: ReasonViewer;
  loc: ViewCtx;
  q?: string;
  entity?: string;
  limit: number;
  offset: number;
}) {
  const q = o.q?.trim();
  const reasons = o.reasons ?? NO_PRIVATE;
  const clientOk = searchesClientDetails(o.client) ? undefined : sql`${auditLog.entity} not in ('customer', 'client_rating')`;
  const reasonOk = reasons.seesPrivate
    ? undefined
    : reasons.staffId
      ? sql`(coalesce(${auditLog.details}->>'private', 'false') <> 'true' or ${auditLog.details}->>'staffId' = ${reasons.staffId})`
      : sql`coalesce(${auditLog.details}->>'private', 'false') <> 'true'`;
  const inDetails = q ? and(clientOk, reasonOk, sql`${auditLog.details}::text ilike ${`%${q}%`}`) : undefined;
  const ids = o.loc.shops.map((s) => s.id);
  const where = and(
    or(ids.length ? inArray(auditLog.shopId, ids) : sql`false`, auditIncludesBrand(o.viewer) ? isNull(auditLog.shopId) : undefined),
    o.entity ? eq(auditLog.entity, o.entity) : undefined,
    q
      ? or(ilike(auditLog.action, `%${q}%`), ilike(auditLog.actorLabel, `%${q}%`), ilike(auditLog.entityId, `%${q}%`), inDetails)
      : undefined,
  );
  const order = o.loc.view === "shops" ? [sql`${auditLog.shopId} is null`, asc(shops.name), desc(auditLog.at)] : [desc(auditLog.at)];
  const rows = await db
    .select({ a: auditLog, shop: shops.name })
    .from(auditLog)
    .leftJoin(shops, eq(shops.id, auditLog.shopId))
    .where(where)
    .orderBy(...order)
    .limit(o.limit)
    .offset(o.offset);
  return rows.map((r) => ({ ...r, a: { ...r.a, details: redactReasonDetails(r.a.entity, redactAuditDetails(o.client, r.a.entity, r.a.details), reasons) } }));
}

export function tableCsv(t: ReportTable): string {
  const c = csvTable(t);
  return toCsv(c.headers, c.rows);
}
