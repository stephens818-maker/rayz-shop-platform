import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, shops } from "@/db/schema";
import { ReportKey } from "@/domain/permissions";
import { Cell, Column, ColumnKind, ListRow, Metric, ReportTable, ViewCtx, csvTable, listTable, metricTable, splitTable } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import {
  ReportScope,
  TenderTotals,
  appointmentHeatmap,
  byBarber,
  dailyTotals,
  discountBreakdown,
  drawerHistory,
  giftCardTotalsByShop,
  giftCardsIssued,
  inventoryStatus,
  itemMix,
  kpis,
  kpisByShop,
  loyaltyActivity,
  loyaltyByShop,
  monthlyTotals,
  payrollTips,
  refundLog,
  refundTotals,
  salesSummaryByShop,
  sumSalesTotals,
  tenderByShop,
  toCsv,
} from "./reports";

/**
 * Every a la carte report is one loader returning stats and tables. The report page renders them
 * and the export route turns the same tables into CSV, so what you see is what you download.
 *
 * Loaders fetch rows per shop and the table builders add them up, so the combined view, the
 * per-location columns and their totals all come from the same numbers.
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
  /** Combined or by location, over the selected shops. */
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

/** One value per shop, for a metric that adds up across shops. */
const m = <T>(label: string, kind: ColumnKind, xs: Record<string, T>, f: (x: T) => number): Metric => ({ label, kind, byShop: each(xs, f) });

function tenderTotal(t: Record<string, TenderTotals>): TenderTotals {
  return {
    cardCents: sum(t, (x) => x.cardCents),
    cardCreditCents: sum(t, (x) => x.cardCreditCents),
    cardDebitCents: sum(t, (x) => x.cardDebitCents),
    cashCents: sum(t, (x) => x.cashCents),
    giftCardCents: sum(t, (x) => x.giftCardCents),
    cardTipsCents: sum(t, (x) => x.cardTipsCents),
    cashTipsCents: sum(t, (x) => x.cashTipsCents),
  };
}

async function salesData(scope: ReportScope, loc: ViewCtx): Promise<ReportData> {
  const [byShopTotals, tender, daily, monthly] = await Promise.all([
    salesSummaryByShop(scope),
    tenderByShop(scope),
    dailyTotals(scope, { byShop: true }),
    monthlyTotals(scope, { byShop: true }),
  ]);
  const s = sumSalesTotals(Object.values(byShopTotals));
  const t = tenderTotal(tender);
  const x = byShopTotals;
  const summary = metricTable(loc, {
    id: "summary",
    title: loc.view === "shops" ? "Summary by location" : "Summary",
    exportOnly: loc.view !== "shops",
    metrics: [
      m("Tickets", "int", x, (v) => v.tickets),
      m("Gross sales", "money", x, (v) => v.grossSalesCents),
      m("Discounts", "money", x, (v) => v.discountCents),
      m("Refunds", "money", x, (v) => v.refundCents),
      m("Net services", "money", x, (v) => v.netServicesCents),
      m("Net products", "money", x, (v) => v.netProductsCents),
      m("Net sales", "money", x, (v) => v.netSalesCents),
      { label: "Avg ticket", kind: "money", byShop: each(x, (v) => v.avgTicketCents), total: s.avgTicketCents },
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
    rows: daily.map((d) => ({ shopId: d.shopId!, key: d.day, cells: [d.day, d.tickets, d.grossCents, d.refundCents, d.netCents, d.tipsCents, d.cardCents, d.cashCents] })),
    merge: true,
    sort: byDay,
  });
  const monthlyTable = listTable(loc, {
    id: "monthly",
    title: "Monthly totals",
    columns: [text("Month"), int("Tickets"), money("Gross"), money("Refunds"), money("Net services"), money("Net products"), money("Tips")],
    rows: monthly.map((d) => ({ shopId: d.shopId!, key: d.month, cells: [d.month, d.tickets, d.grossCents, d.refundCents, d.netServicesCents, d.netProductsCents, d.tipsCents] })),
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

/** Net services, net products, refunds and tips per barber; the average ticket is before refunds. */
const BARBER_COLUMNS = [text("Barber"), int("Tickets"), int("Services"), money("Net services"), money("Net products"), money("Refunds"), money("Tips"), id("Avg ticket", "money")];
const barberDerive = (c: Cell[]): Cell[] => {
  const n = Number(c[1]) || 0;
  const out = [...c];
  out[7] = n ? Math.round((Number(c[3]) + Number(c[4]) + Number(c[5])) / n) : 0;
  return out;
};
const byNetServices = (a: Cell[], b: Cell[]) => Number(b[3]) - Number(a[3]) || String(a[0]).localeCompare(String(b[0]));

export const REPORT_LOADERS: Record<ReportKey, (i: ReportInput) => Promise<ReportData>> = {
  async my_sales({ scope, loc }) {
    return salesData(scope, loc);
  },

  async sales_summary({ scope, loc }) {
    return salesData(scope, loc);
  },

  async sales_by_barber({ scope, loc }) {
    const r = await byBarber(scope, { byShop: true });
    const rows: ListRow[] = r.map((x) => ({
      shopId: x.shopId!,
      key: x.staffId,
      cells: [x.label, x.tickets, x.services, x.netServicesCents, x.netProductsCents, x.refundCents, x.tipsCents, x.avgTicketCents],
    }));
    const spec = { columns: BARBER_COLUMNS, rows, derive: barberDerive, sort: byNetServices };
    const split = splitTable(loc, { id: "split", title: "Barbers at more than one shop", subtitle: "Each ticket counts at the shop where it was rung up.", ...spec });
    return {
      stats: [],
      tables: [
        listTable(loc, {
          id: "barbers",
          title: loc.view === "shops" ? "By barber, by location" : "By barber",
          subtitle: "Service credit and tips go to the barber on the ticket, at the shop where the ticket was rung up.",
          ...spec,
          merge: true,
          shopsColumnAt: loc.shops.length > 1 ? 1 : undefined,
        }),
        ...(split ? [split] : []),
      ],
    };
  },

  async services_vs_products({ scope, loc }) {
    const [x, mix] = await Promise.all([salesSummaryByShop(scope), itemMix(scope, { byShop: true })]);
    const s = sumSalesTotals(Object.values(x));
    const total = s.netServicesCents + s.netProductsCents;
    const cols = [text("Item"), int("Qty"), int("Tickets"), money("Gross"), money("Discounts"), money("Net")];
    const items = (f: (k: string) => boolean): ListRow[] =>
      mix.filter((i) => f(i.kind)).map((i) => ({ shopId: i.shopId!, key: `${i.kind}|${i.name}`, cells: [i.name, i.qty, i.tickets, i.grossCents, i.discountCents, i.netCents] }));
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
          title: "Services and products by location",
          exportOnly: loc.view !== "shops",
          metrics: [
            m("Net services", "money", x, (v) => v.netServicesCents),
            m("Net products", "money", x, (v) => v.netProductsCents),
            {
              label: "Services share",
              kind: "pct",
              byShop: each(x, (v) => ratio(v.netServicesCents, v.netServicesCents + v.netProductsCents)),
              total: ratio(s.netServicesCents, total),
            },
            m("Tickets", "int", x, (v) => v.tickets),
            m("Tickets with retail", "int", x, (v) => v.productTickets),
            { label: "Retail attach rate", kind: "pct", byShop: each(x, (v) => ratio(v.productTickets, v.tickets)), total: ratio(s.productTickets, s.tickets) },
            { label: "Avg ticket", kind: "money", byShop: each(x, (v) => v.avgTicketCents), total: s.avgTicketCents },
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
    const columns = [
      text("Period start"),
      text("Period end"),
      text("Staff ID"),
      text("Barber"),
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
      key: `${x.periodStart}|${x.staffId}`,
      cells: [
        x.periodStart,
        x.periodEnd,
        x.staffCode,
        x.label,
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
    const order = (a: Cell[], b: Cell[]) => String(a[0]).localeCompare(String(b[0])) || String(a[3]).localeCompare(String(b[3]));
    const split = splitTable(loc, {
      id: "split",
      title: "Barbers at more than one shop",
      subtitle: "Tips and sales are paid out from the shop where each ticket was rung up; the total is what the barber made across shops.",
      columns,
      rows,
      sort: order,
      shopAt: 4,
    });
    return {
      stats: [],
      tables: [
        listTable(loc, {
          id: "payroll",
          title: loc.view === "shops" ? "Tips by pay period, by location" : "Tips by pay period",
          columns,
          rows,
          merge: true,
          shopsColumnAt: loc.shops.length > 1 ? 4 : undefined,
          labelAt: 3,
          sort: order,
        }),
        ...(split ? [split] : []),
      ],
    };
  },

  async card_vs_cash({ scope, loc }) {
    const [tender, daily] = await Promise.all([tenderByShop(scope), dailyTotals(scope, { byShop: true })]);
    const t = tenderTotal(tender);
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
          title: "Tender totals",
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
          rows: daily.map((d) => ({ shopId: d.shopId!, key: d.day, cells: [d.day, d.tickets, d.cardCents, d.cashCents] })),
          merge: true,
          sort: byDay,
        }),
      ],
    };
  },

  async discounts_refunds({ scope, loc }) {
    const [x, d, totals, log] = await Promise.all([salesSummaryByShop(scope), discountBreakdown(scope, { byShop: true }), refundTotals(scope, { byShop: true }), refundLog(scope)]);
    const s = sumSalesTotals(Object.values(x));
    const kind = (k: string) => totals.filter((t) => t.kind === k);
    const per = (k: string, f: (t: (typeof totals)[number]) => number) =>
      Object.fromEntries(
        loc.shops.map((sh) => [
          sh.id,
          kind(k)
            .filter((t) => t.shopId === sh.id)
            .reduce((a, t) => a + f(t), 0),
        ]),
      );
    const refunds = { n: kind("refund").reduce((a, t) => a + t.n, 0), cents: kind("refund").reduce((a, t) => a + t.amountCents, 0) };
    const voids = { n: kind("void").reduce((a, t) => a + t.n, 0), cents: kind("void").reduce((a, t) => a + t.amountCents, 0) };
    return {
      stats: [
        { label: "Discounts", value: formatCents(s.discountCents), hint: `${d.reduce((a, r) => a + r.tickets, 0)} discounted lines` },
        { label: "Refunds", value: formatCents(refunds.cents), hint: `${refunds.n} refunds` },
        { label: "Voids", value: formatCents(voids.cents), hint: `${voids.n} voided tickets` },
        { label: "Gross sales", value: formatCents(s.grossSalesCents) },
      ],
      tables: [
        metricTable(loc, {
          id: "totals",
          title: "Discounts and refunds by location",
          exportOnly: loc.view !== "shops",
          metrics: [
            m("Gross sales", "money", x, (v) => v.grossSalesCents),
            m("Discounts", "money", x, (v) => v.discountCents),
            { label: "Refunds", kind: "int", byShop: per("refund", (t) => t.n) },
            { label: "Refunded", kind: "money", byShop: per("refund", (t) => t.amountCents) },
            { label: "Voids", kind: "int", byShop: per("void", (t) => t.n) },
            { label: "Voided", kind: "money", byShop: per("void", (t) => t.amountCents) },
          ],
        }),
        listTable(loc, {
          id: "discounts",
          title: "Discounts by type",
          columns: [text("Type"), text("Label"), int("Tickets"), money("Amount")],
          rows: d.map((r) => ({ shopId: r.shopId!, key: `${r.source}|${r.label}`, cells: [r.source, r.label, r.tickets, r.cents] })),
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
    const [x, issued] = await Promise.all([giftCardTotalsByShop(scope), giftCardsIssued(scope)]);
    return {
      stats: [
        { label: "Issued", value: formatCents(sum(x, (v) => v.issuedCents)), hint: `${sum(x, (v) => v.issuedN)} cards` },
        { label: "Redeemed here", value: formatCents(sum(x, (v) => v.redeemedCents)) },
        { label: "Outstanding", value: formatCents(sum(x, (v) => v.outstandingCents)), hint: `${sum(x, (v) => v.outstandingN)} cards issued at these shops` },
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
    const cols: Record<string, typeof t> = split ? { ...split.shops, ...(split.brand ? { [BRAND]: split.brand } : {}) } : Object.fromEntries(loc.shops.map((s) => [s.id, t]));
    const v: ViewCtx = split?.brand ? { ...loc, shops: [...loc.shops, { id: BRAND, name: "Brand (no ticket)" }] } : loc;
    const lm = (label: string, kind: ColumnKind, f: (x: typeof t) => number, total?: number): Metric => ({ label, kind, byShop: each(cols, f), total: total ?? f(t) });
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
            lm("Clients who earned", "int", (x) => x.members),
            lm("Progress earned", "money", (x) => x.earnedCents),
            lm("Progress reversed by refunds", "money", (x) => x.reversedCents),
            lm("Rewards issued", "int", (x) => x.rewardsIssued),
            lm("Rewards issued ($)", "money", (x) => x.rewardsIssuedCents),
            lm("Rewards redeemed", "int", (x) => x.rewardsRedeemed),
            lm("Rewards redeemed ($)", "money", (x) => x.rewardsRedeemedCents),
            ...(includeBrand ? [lm("Manual rewards", "int", (x) => x.manualRewards)] : []),
          ],
        }),
      ],
      notes: includeBrand ? undefined : ["Manual rewards have no ticket or shop, so they're counted only when every shop is selected."],
    };
  },

  async client_ratings() {
    return { stats: [], tables: [] };
  },

  async kpis({ scope, loc }) {
    const [k, per] = await Promise.all([kpis(scope), loc.view === "shops" ? kpisByShop(scope) : null]);
    const src = per ?? Object.fromEntries(loc.shops.map((s) => [s.id, k]));
    const km = (label: string, kind: ColumnKind, f: (x: typeof k) => number | null, additive: boolean): Metric => ({
      label,
      kind,
      byShop: each(src, f),
      total: additive && per ? undefined : f(k),
    });
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
          title: "Client KPIs",
          subtitle:
            loc.view === "shops"
              ? "Visit and appointment counts add up across shops. Client counts don't: a client seen at two shops counts at each, and once in the total."
              : undefined,
          metrics: [
            km("Rebook rate", "pct", (x) => x.rebookRate, false),
            km("Visits rebooked within 24h", "int", (x) => x.rebooked, true),
            km("Visits with booking times", "int", (x) => x.visits, true),
            km("Retention", "pct", (x) => x.retentionRate, false),
            km("Clients retained", "int", (x) => x.retainedClients, false),
            km("Clients in the prior window", "int", (x) => x.priorClients, false),
            km("New clients", "int", (x) => x.newClients, false),
            km("New to Ray'z", "int", (x) => x.newToBrand, false),
            km("Returning clients", "int", (x) => x.returningClients, false),
            km("Appointments", "int", (x) => x.appointments, true),
            km("No-shows", "int", (x) => x.noShows.n, true),
            km("No-show value", "money", (x) => x.noShows.cents, true),
            km("Cancellations", "int", (x) => x.cancellations.n, true),
          ],
        }),
      ],
    };
  },

  async heatmap({ scope, loc }) {
    const h = await appointmentHeatmap(scope, { byShop: true });
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
    const heatmaps: Heatmap[] =
      loc.view === "shops" && loc.shops.length > 1
        ? [...loc.shops.map((s) => ({ title: s.name, cells: h.filter((c) => c.shopId === s.id) })), { title: loc.totalLabel, cells: combine(h) }]
        : [{ title: loc.shops.length === 1 ? loc.shops[0].name : loc.totalLabel, cells: combine(h) }];
    return {
      stats: [{ label: "Appointments", value: String(h.reduce((a, x) => a + x.n, 0)) }],
      heatmaps,
      tables: [
        listTable(loc, {
          id: "heatmap",
          title: "Appointments by day and hour",
          exportOnly: true,
          columns: [text("Weekday"), id("Hour"), int("Appointments")],
          rows: [...h].sort((a, b) => a.dow - b.dow || a.hour - b.hour).map((x) => ({ shopId: x.shopId!, key: `${x.dow}|${x.hour}`, cells: [days[x.dow], x.hour, x.n] })),
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
