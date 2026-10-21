import "server-only";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, shops } from "@/db/schema";
import { ReportKey } from "@/domain/permissions";
import { formatCents } from "@/lib/money";
import { auditScope } from "./audit";
import {
  ReportScope,
  appointmentHeatmap,
  byBarber,
  byShop,
  cents,
  dailyTotals,
  discountBreakdown,
  drawerHistory,
  giftCardActivity,
  inventoryStatus,
  itemMix,
  kpis,
  loyaltyActivity,
  monthlyTotals,
  payrollTips,
  refundLog,
  salesSummary,
  tenderBreakdown,
  toCsv,
} from "./reports";

/**
 * Every a la carte report is one loader returning stats and tables. The report page renders them
 * and the export route turns the same tables into CSV, so what you see is what you download.
 */

export type Cell = string | number | boolean | null;
export type ColumnKind = "text" | "int" | "money" | "pct" | "bool";
export interface ReportTable {
  id: string;
  title: string;
  subtitle?: string;
  columns: { label: string; kind?: ColumnKind }[];
  rows: Cell[][];
  /** Shown as stat tiles on the page; still downloadable. */
  exportOnly?: boolean;
}
export interface ReportStat {
  label: string;
  value: string;
  hint?: string;
  tone?: "up" | "down";
}
export interface ReportData {
  stats: ReportStat[];
  tables: ReportTable[];
  heatmap?: { dow: number; hour: number; n: number }[];
  notes?: string[];
}

export interface ReportInput {
  scope: ReportScope;
  /** The viewer's access: brand-level rows (no shop) are only for people with every shop. */
  viewer: { brandWide: boolean; currentShopId: string | null; shopIds: string[] };
  params: Record<string, string | undefined>;
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const money = (label: string): { label: string; kind: ColumnKind } => ({ label, kind: "money" });
const int = (label: string): { label: string; kind: ColumnKind } => ({ label, kind: "int" });
const text = (label: string): { label: string; kind?: ColumnKind } => ({ label });

async function salesTables(s: ReportScope, withShops: boolean): Promise<ReportTable[]> {
  const [shopRows, daily, monthly] = await Promise.all([withShops && s.shopIds.length > 1 ? byShop(s) : Promise.resolve([]), dailyTotals(s), monthlyTotals(s)]);
  const out: ReportTable[] = [];
  if (shopRows.length)
    out.push({
      id: "shops",
      title: "By shop",
      columns: [text("Shop"), int("Tickets"), money("Gross"), money("Refunds"), money("Net services"), money("Net products"), money("Tips")],
      rows: shopRows.map((x) => [x.name, x.tickets, x.grossCents, x.refundCents, x.netServicesCents, x.netProductsCents, x.tipsCents]),
    });
  out.push({
    id: "daily",
    title: "Daily totals",
    columns: [text("Date"), int("Tickets"), money("Gross"), money("Refunds"), money("Net"), money("Tips"), money("Card"), money("Cash")],
    rows: daily.map((x) => [x.day, x.tickets, x.grossCents, x.refundCents, x.netCents, x.tipsCents, x.cardCents, x.cashCents]),
  });
  out.push({
    id: "monthly",
    title: "Monthly totals",
    columns: [text("Month"), int("Tickets"), money("Gross"), money("Refunds"), money("Net services"), money("Net products"), money("Tips")],
    rows: monthly.map((x) => [x.month, x.tickets, x.grossCents, x.refundCents, x.netServicesCents, x.netProductsCents, x.tipsCents]),
  });
  return out;
}

async function summaryStats(s: ReportScope): Promise<ReportStat[]> {
  const [summary, tender] = await Promise.all([salesSummary(s), tenderBreakdown(s)]);
  return [
    { label: "Gross sales", value: formatCents(summary.grossSalesCents), hint: `${summary.tickets} tickets · avg ${formatCents(summary.avgTicketCents)}` },
    { label: "Net services", value: formatCents(summary.netServicesCents), hint: summary.discountCents ? `after ${formatCents(summary.discountCents)} discounts` : undefined },
    { label: "Net products", value: formatCents(summary.netProductsCents), hint: `${summary.productTickets} tickets with retail` },
    { label: "Tips", value: formatCents(summary.tipsCents), hint: `card ${formatCents(tender.cardTipsCents)} · cash ${formatCents(tender.cashTipsCents)}` },
    { label: "Tax collected", value: formatCents(summary.taxCents), hint: `gift cards sold ${formatCents(summary.giftCardsSoldCents)}` },
    { label: "Refunds", value: formatCents(summary.refundCents) },
    { label: "Card surcharges", value: formatCents(summary.cardFeeCents) },
    { label: "Card / cash", value: `${formatCents(tender.cardCents)} / ${formatCents(tender.cashCents)}` },
  ];
}

export const REPORT_LOADERS: Record<ReportKey, (i: ReportInput) => Promise<ReportData>> = {
  async my_sales({ scope }) {
    return { stats: await summaryStats(scope), tables: await salesTables(scope, false) };
  },

  async sales_summary({ scope }) {
    const [summary, t] = await Promise.all([salesSummary(scope), tenderBreakdown(scope)]);
    const totals: ReportTable = {
      id: "summary",
      title: "Summary",
      exportOnly: true,
      columns: [text("Metric"), money("Amount"), int("Count")],
      rows: [
        ["Tickets", null, summary.tickets],
        ["Gross sales", summary.grossSalesCents, null],
        ["Discounts", summary.discountCents, null],
        ["Refunds", summary.refundCents, null],
        ["Net services", summary.netServicesCents, null],
        ["Net products", summary.netProductsCents, summary.productTickets],
        ["Tax", summary.taxCents, null],
        ["Tips", summary.tipsCents, null],
        ["Card surcharges", summary.cardFeeCents, null],
        ["Gift cards sold", summary.giftCardsSoldCents, null],
        ["Card", t.cardCents, null],
        ["Card (credit)", t.cardCreditCents, null],
        ["Card (debit/prepaid)", t.cardDebitCents, null],
        ["Cash", t.cashCents, null],
        ["Gift card redemptions", t.giftCardCents, null],
      ],
    };
    return { stats: await summaryStats(scope), tables: [totals, ...(await salesTables(scope, true))] };
  },

  async sales_by_barber({ scope }) {
    const r = await byBarber(scope);
    return {
      stats: [],
      tables: [
        {
          id: "barbers",
          title: "By barber",
          subtitle: "Service credit and tips go to the barber on the ticket.",
          columns: [text("Barber"), int("Tickets"), int("Services"), money("Net services"), money("Net products"), money("Tips"), money("Avg ticket")],
          rows: r.map((x) => [x.label, x.tickets, x.services, x.netServicesCents, x.netProductsCents, x.tipsCents, x.avgTicketCents]),
        },
      ],
    };
  },

  async services_vs_products({ scope }) {
    const [summary, mix] = await Promise.all([salesSummary(scope), itemMix(scope)]);
    const total = summary.netServicesCents + summary.netProductsCents;
    const row = (x: (typeof mix)[number]): Cell[] => [x.name, x.qty, x.tickets, x.grossCents, x.discountCents, x.netCents];
    const cols = [text("Item"), int("Qty"), int("Tickets"), money("Gross"), money("Discounts"), money("Net")];
    return {
      stats: [
        { label: "Net services", value: formatCents(summary.netServicesCents), hint: total ? `${Math.round((summary.netServicesCents / total) * 100)}% of sales` : undefined },
        { label: "Net products", value: formatCents(summary.netProductsCents), hint: total ? `${Math.round((summary.netProductsCents / total) * 100)}% of sales` : undefined },
        { label: "Retail attach rate", value: pct(summary.tickets ? summary.productTickets / summary.tickets : null), hint: `${summary.productTickets} of ${summary.tickets} tickets` },
        { label: "Avg ticket", value: formatCents(summary.avgTicketCents) },
      ],
      tables: [
        { id: "services", title: "Services and add-ons", columns: cols, rows: mix.filter((x) => x.kind !== "product").map(row) },
        { id: "products", title: "Retail products", columns: cols, rows: mix.filter((x) => x.kind === "product").map(row) },
      ],
      notes: ["Item lines come from paid tickets in the range; refunds are on the Discounts & refunds report."],
    };
  },

  async tips_payroll({ scope }) {
    const r = await payrollTips(scope);
    return {
      stats: [],
      tables: [
        {
          id: "payroll",
          title: "Tips by pay period",
          columns: [
            text("Period start"),
            text("Period end"),
            text("Staff ID"),
            text("Barber"),
            text("Shop"),
            int("Tickets"),
            money("Service sales"),
            money("Product sales"),
            money("Card tips"),
            money("Cash tips"),
            money("Gift card tips"),
            money("Tip refunds (already subtracted)"),
            money("Total tips"),
          ],
          rows: r.rows.map((x) => [
            x.periodStart,
            x.periodEnd,
            x.staffCode,
            x.label,
            x.shop,
            x.tickets,
            x.serviceSalesCents,
            x.productSalesCents,
            x.cardTipsCents,
            x.cashTipsCents,
            x.giftCardTipsCents,
            x.tipRefundsCents,
            x.totalTipsCents,
          ]),
        },
      ],
    };
  },

  async card_vs_cash({ scope }) {
    const [t, daily] = await Promise.all([tenderBreakdown(scope), dailyTotals(scope)]);
    const all = t.cardCents + t.cashCents + t.giftCardCents;
    return {
      stats: [
        { label: "Card", value: formatCents(t.cardCents), hint: all ? `${Math.round((t.cardCents / all) * 100)}% of takings` : undefined },
        { label: "Credit / debit", value: `${formatCents(t.cardCreditCents)} / ${formatCents(t.cardDebitCents)}`, hint: "credit pays the surcharge" },
        { label: "Cash", value: formatCents(t.cashCents), hint: all ? `${Math.round((t.cashCents / all) * 100)}% of takings` : undefined },
        { label: "Gift card redemptions", value: formatCents(t.giftCardCents) },
      ],
      tables: [
        {
          id: "tender",
          title: "Tender totals",
          subtitle: "Takings by tender after refunds, including tips and surcharges.",
          columns: [text("Tender"), money("Amount"), money("Tips")],
          rows: [
            ["Card (credit)", t.cardCreditCents, null],
            ["Card (debit / prepaid)", t.cardDebitCents, null],
            ["Card (all)", t.cardCents, t.cardTipsCents],
            ["Cash", t.cashCents, t.cashTipsCents],
            ["Gift card", t.giftCardCents, null],
          ],
        },
        {
          id: "daily",
          title: "Card and cash by day",
          columns: [text("Date"), int("Tickets"), money("Card"), money("Cash")],
          rows: daily.map((x) => [x.day, x.tickets, x.cardCents, x.cashCents]),
        },
      ],
    };
  },

  async discounts_refunds({ scope }) {
    const [summary, d, r] = await Promise.all([salesSummary(scope), discountBreakdown(scope), refundLog(scope)]);
    const refunds = r.filter((x) => x.kind === "refund");
    const voids = r.filter((x) => x.kind === "void");
    return {
      stats: [
        { label: "Discounts", value: formatCents(summary.discountCents), hint: `${d.reduce((a, x) => a + x.tickets, 0)} discounted lines` },
        { label: "Refunds", value: formatCents(refunds.reduce((a, x) => a + x.amountCents, 0)), hint: `${refunds.length} refunds` },
        { label: "Voids", value: formatCents(voids.reduce((a, x) => a + x.amountCents, 0)), hint: `${voids.length} voided tickets` },
        { label: "Gross sales", value: formatCents(summary.grossSalesCents) },
      ],
      tables: [
        {
          id: "discounts",
          title: "Discounts by type",
          columns: [text("Type"), text("Label"), int("Tickets"), money("Amount")],
          rows: d.map((x) => [x.source, x.label, x.tickets, x.cents]),
        },
        {
          id: "refunds",
          title: "Refunds and voids",
          columns: [text("Date"), int("Ticket"), text("Shop"), text("Barber"), text("Kind"), text("Tender"), money("Amount"), money("Tip"), text("Reason"), text("Issued by")],
          rows: r.map((x) => [x.day, x.number, x.shop, x.barber, x.kind, x.method, x.amountCents, x.tipCents, x.reason, x.by ?? (x.source === "stripe_dashboard" ? "Stripe dashboard" : null)]),
        },
      ],
    };
  },

  async inventory({ scope }) {
    const r = await inventoryStatus(scope);
    const low = r.filter((x) => x.low);
    return {
      stats: [
        { label: "Products carried", value: String(r.length) },
        { label: "Low stock", value: String(low.length), tone: low.length ? "down" : undefined },
        { label: "Stock at cost", value: formatCents(r.reduce((a, x) => a + x.valueCents, 0)) },
        { label: "Sold in range", value: String(r.reduce((a, x) => a + x.sold, 0)), hint: `${r.reduce((a, x) => a + x.received, 0)} received` },
      ],
      tables: [
        {
          id: "stock",
          title: "Stock by shop",
          subtitle: "On hand now. Received, sold, damaged and count changes are for the selected dates.",
          columns: [text("Shop"), text("SKU"), text("Product"), int("On hand"), int("Reorder at"), { label: "Low", kind: "bool" }, money("Cost"), money("Price"), money("Value at cost"), int("Received"), int("Sold"), int("Damaged"), int("Count changes")],
          rows: r.map((x) => [x.shop, x.sku, x.product, x.stock, x.threshold, x.low, x.costCents, x.priceCents, x.valueCents, x.received, x.sold, x.damaged, x.counted]),
        },
      ],
    };
  },

  async gift_cards({ scope }) {
    const { totals, issued } = await giftCardActivity(scope);
    return {
      stats: [
        { label: "Issued", value: formatCents(totals.issuedCents), hint: `${totals.issuedN} cards` },
        { label: "Redeemed here", value: formatCents(totals.redeemedCents) },
        { label: "Outstanding", value: formatCents(totals.outstandingCents), hint: `${totals.outstandingN} cards issued at these shops` },
      ],
      tables: [
        {
          id: "issued",
          title: "Cards issued",
          columns: [text("Code"), text("Shop"), text("Source"), money("Initial"), money("Balance"), text("Status"), text("Issued")],
          rows: issued.map((x) => [x.code, x.shop, x.source, x.initialCents, x.balanceCents, x.status, x.created]),
        },
      ],
      notes: ["Balances work at every shop, so a card issued here can be redeemed elsewhere."],
    };
  },

  async loyalty({ scope, viewer }) {
    const t = await loyaltyActivity(scope, viewer.brandWide && scope.shopIds.length === viewer.shopIds.length);
    return {
      stats: [
        { label: "Progress earned", value: formatCents(t.earnedCents), hint: `${t.members} clients earned` },
        { label: "Rewards issued", value: formatCents(t.rewardsIssuedCents), hint: `${t.rewardsIssued} rewards${t.manualRewards ? ` · ${t.manualRewards} manual` : ""}` },
        { label: "Rewards redeemed", value: formatCents(t.rewardsRedeemedCents), hint: `${t.rewardsRedeemed} rewards` },
        { label: "Reversed by refunds", value: formatCents(t.reversedCents) },
      ],
      tables: [
        {
          id: "loyalty",
          title: "Loyalty activity",
          columns: [text("Metric"), int("Count"), money("Amount")],
          rows: [
            ["Progress earned", t.members, t.earnedCents],
            ["Progress reversed by refunds", null, t.reversedCents],
            ["Rewards issued", t.rewardsIssued, t.rewardsIssuedCents],
            ["Rewards redeemed", t.rewardsRedeemed, t.rewardsRedeemedCents],
          ],
        },
      ],
    };
  },

  async client_ratings() {
    return { stats: [], tables: [] };
  },

  async kpis({ scope }) {
    const k = await kpis(scope);
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
        { label: "No-shows", value: String(k.noShows.n), hint: `${formatCents(k.noShows.cents)} lost · ${k.cancellations.n} cancellations`, tone: k.noShows.n ? "down" : undefined },
      ],
      tables: [
        {
          id: "kpis",
          title: "Client KPIs",
          columns: [text("Metric"), text("Value"), int("Count"), int("Out of")],
          rows: [
            ["Rebook rate", pct(k.rebookRate), k.rebooked, k.visits],
            ["Retention", pct(k.retentionRate), k.retainedClients, k.priorClients],
            ["New clients", null, k.newClients, null],
            ["New to Ray'z", null, k.newToBrand, null],
            ["Returning clients", null, k.returningClients, null],
            ["No-shows", null, k.noShows.n, k.appointments],
            ["Cancellations", null, k.cancellations.n, k.appointments],
          ],
        },
      ],
    };
  },

  async heatmap({ scope }) {
    const h = await appointmentHeatmap(scope);
    return {
      stats: [{ label: "Appointments", value: String(h.reduce((a, x) => a + x.n, 0)) }],
      heatmap: h,
      tables: [
        {
          id: "heatmap",
          title: "Appointments by day and hour",
          columns: [text("Weekday"), int("Hour"), int("Appointments")],
          rows: [...h].sort((a, b) => a.dow - b.dow || a.hour - b.hour).map((x) => [["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][x.dow], x.hour, x.n]),
        },
      ],
    };
  },

  async cash_drawer({ scope }) {
    const r = await drawerHistory(scope);
    const closed = r.filter((x) => x.countedCents !== null);
    return {
      stats: [
        { label: "Drawers closed", value: String(closed.length), hint: `${r.length - closed.length} not closed` },
        { label: "Cash sales", value: formatCents(r.reduce((a, x) => a + x.cashSalesCents, 0)) },
        { label: "Net over / short", value: formatCents(closed.reduce((a, x) => a + (x.varianceCents ?? 0), 0)), tone: closed.some((x) => (x.varianceCents ?? 0) < 0) ? "down" : undefined },
        { label: "Payouts", value: formatCents(r.reduce((a, x) => a + x.payoutsCents, 0)) },
      ],
      tables: [
        {
          id: "drawers",
          title: "Drawer closes",
          columns: [text("Date"), text("Shop"), money("Opening float"), money("Cash sales"), money("Cash refunds"), money("Payouts"), money("Expected"), money("Counted"), money("Over / short"), text("Closed by"), text("Notes")],
          rows: r.map((x) => [x.day, x.shop, x.openingCents, x.cashSalesCents, x.cashRefundsCents, x.payoutsCents, x.expectedCents, x.countedCents, x.varianceCents, x.closedBy, x.notes]),
        },
      ],
    };
  },

  async audit_log({ viewer, params }) {
    const q = params.q?.trim();
    const where = and(
      auditScope(viewer),
      params.entity ? eq(auditLog.entity, params.entity) : undefined,
      q ? or(ilike(auditLog.action, `%${q}%`), ilike(auditLog.actorLabel, `%${q}%`), ilike(auditLog.entityId, `%${q}%`), sql`${auditLog.details}::text ilike ${`%${q}%`}`) : undefined,
    );
    const r = await db.select({ a: auditLog, shop: shops.name }).from(auditLog).leftJoin(shops, eq(shops.id, auditLog.shopId)).where(where).orderBy(desc(auditLog.at)).limit(10000);
    return {
      stats: [],
      tables: [
        {
          id: "audit",
          title: "Audit log",
          columns: [text("When"), text("Who"), text("Action"), text("Area"), text("Record"), text("Shop"), text("Details")],
          rows: r.map(({ a, shop }) => [a.at.toISOString(), a.actorLabel, a.action, a.entity, a.entityId, shop ?? "Brand", JSON.stringify(a.details ?? {})]),
        },
      ],
    };
  },
};

export function tableCsv(t: ReportTable): string {
  return toCsv(
    t.columns.map((c) => c.label),
    t.rows.map((r) => r.map((v, i) => (v === null ? null : t.columns[i]?.kind === "money" && typeof v === "number" ? cents(v) : typeof v === "boolean" ? (v ? "yes" : "no") : v))),
  );
}
