import { ANALYTICS_PERIODS, COMPARE_MODES, CompareMode, comparePeriod, periodChange } from "@/domain/period-compare";
import { Cell, ColumnKind, ReportTable, TOTAL, ViewCtx, segKey } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { formatDate, type LocalDate } from "@/lib/time";
import type { ReportData } from "./report-data";
import { Kpis, ReportScope, SalesTotals, ZERO_SALES, emptyKpis, kpisAt, salesTotalsAt } from "./reports";

type Pair = { s: SalesTotals; k: Kpis };
type Metric = { label: string; kind: ColumnKind; f: (p: Pair) => number | null; /** Lower is better. */ down?: boolean };

const ratio = (a: number, b: number) => (b ? a / b : null);

export const ANALYTICS_METRICS: Metric[] = [
  { label: "Net sales", kind: "money", f: (p) => p.s.netSalesCents },
  { label: "Gross sales", kind: "money", f: (p) => p.s.grossSalesCents },
  { label: "Net services", kind: "money", f: (p) => p.s.netServicesCents },
  { label: "Net products", kind: "money", f: (p) => p.s.netProductsCents },
  { label: "Tips", kind: "money", f: (p) => p.s.tipsCents },
  { label: "Discounts", kind: "money", f: (p) => p.s.discountCents, down: true },
  { label: "Refunds", kind: "money", f: (p) => p.s.refundCents, down: true },
  { label: "Gift cards sold", kind: "money", f: (p) => p.s.giftCardsSoldCents },
  { label: "Tickets", kind: "int", f: (p) => p.s.tickets },
  { label: "Average ticket", kind: "money", f: (p) => (p.s.tickets ? p.s.avgTicketCents : null) },
  { label: "Retail attach rate", kind: "pct", f: (p) => ratio(p.s.productTickets, p.s.tickets) },
  { label: "Appointments", kind: "int", f: (p) => p.k.appointments },
  { label: "Walk-ins", kind: "int", f: (p) => p.k.walkIns },
  { label: "New clients", kind: "int", f: (p) => p.k.newClients },
  { label: "Returning clients", kind: "int", f: (p) => p.k.returningClients },
  { label: "Rebook rate", kind: "pct", f: (p) => p.k.rebookRate },
  { label: "Retention", kind: "pct", f: (p) => p.k.retentionRate },
  { label: "No-shows", kind: "int", f: (p) => p.k.noShows.n, down: true },
  { label: "Cancellations", kind: "int", f: (p) => p.k.cancellations.n, down: true },
];

const signed = (n: number, kind: ColumnKind) =>
  kind === "money" ? formatCents(n, { sign: true }) : kind === "pct" ? `${n > 0 ? "+" : ""}${Math.round(n * 1000) / 10} pts` : `${n > 0 ? "+" : ""}${n}`;
const pctText = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : ""}${Math.round(x * 1000) / 10}%`);
const rangeText = (r: { from: LocalDate; to: LocalDate }) => (r.from === r.to ? formatDate(r.from, "MMM d, yyyy") : `${formatDate(r.from, "MMM d")} – ${formatDate(r.to, "MMM d, yyyy")}`);

/** Every metric now and in the period compared, with the change. */
export function compareRows(now: Pair, before: Pair, metrics: Metric[] = ANALYTICS_METRICS) {
  return metrics.map((x) => {
    const a = x.f(now);
    const b = x.f(before);
    const c = periodChange(a, b);
    // A rate's change reads in points; a percent change of a percent is noise.
    return { metric: x, now: a, before: b, diff: c.diff, pct: x.kind === "pct" ? null : c.pct };
  });
}

/**
 * Analytics, as in Squire: this period against the one before (or the same dates last year) for
 * sales, tickets and clients, overall and by location. Periods are 1W, 4W, MTD, QTD and YTD, or any range.
 */
export async function analyticsData(scope: ReportScope, loc: ViewCtx, params: Record<string, string | undefined>): Promise<ReportData> {
  const mode: CompareMode = params.compare === "year" ? "year" : "prior";
  const preset = params.preset ?? (params.from || params.to ? null : "4w");
  const prior = comparePeriod(scope.from, scope.to, preset, mode);
  const was: ReportScope = { ...scope, ...prior };
  const g = [{}, ...(loc.shops.length > 1 ? [{ byShop: true }] : [])];
  const [sNow, sWas, kNow, kWas] = await Promise.all([salesTotalsAt(scope, g), salesTotalsAt(was, g), kpisAt(scope, g), kpisAt(was, g)]);
  const pair = (key: string, s: Record<string, SalesTotals>, k: Record<string, Kpis>, sc: ReportScope): Pair => ({ s: s[key] ?? ZERO_SALES(), k: k[key] ?? emptyKpis(sc) });
  const rows = compareRows(pair(TOTAL, sNow, kNow, scope), pair(TOTAL, sWas, kWas, was));
  const nowLabel = rangeText(scope);
  const wasLabel = rangeText(prior);

  const main: ReportTable = {
    id: "compare",
    title: `${loc.totalLabel}: ${nowLabel} vs ${wasLabel}`,
    subtitle: mode === "year" ? "Against the same dates last year." : "Against the period before: the same days of last month for MTD, as many days into last quarter for QTD, the same days last year for YTD.",
    columns: [{ label: "Metric" }, { label: "Now" }, { label: mode === "year" ? "Last year" : "Before" }, { label: "Change" }, { label: "% change" }],
    rows: rows.map((r): Cell[] => [r.metric.label, r.now, r.before, r.diff === null ? null : signed(r.diff, r.metric.kind), pctText(r.pct)]),
    rowKinds: rows.map((r) => r.metric.kind),
  };

  const tables: ReportTable[] = [main];
  if (loc.shops.length > 1) {
    const by = loc.shops.map((shop) => {
      const k = segKey(shop.id, null);
      const now = pair(k, sNow, kNow, scope);
      const before = pair(k, sWas, kWas, was);
      return { shop, now, before };
    });
    tables.push({
      id: "locations",
      title: "By location",
      subtitle: `${nowLabel} vs ${wasLabel}`,
      columns: [
        { label: "Location" },
        { label: "Net sales", kind: "money" },
        { label: "Before", kind: "money" },
        { label: "% change" },
        { label: "Tickets", kind: "int" },
        { label: "Before", kind: "int" },
        { label: "% change" },
        { label: "New clients", kind: "int" },
        { label: "Before", kind: "int" },
        { label: "Rebook rate", kind: "pct", sum: false },
        { label: "Before", kind: "pct", sum: false },
      ],
      rows: by.map(({ shop, now, before }) => [
        shop.name,
        now.s.netSalesCents,
        before.s.netSalesCents,
        pctText(periodChange(now.s.netSalesCents, before.s.netSalesCents).pct),
        now.s.tickets,
        before.s.tickets,
        pctText(periodChange(now.s.tickets, before.s.tickets).pct),
        now.k.newClients,
        before.k.newClients,
        now.k.rebookRate,
        before.k.rebookRate,
      ]),
    });
  }

  const tile = (label: string) => {
    const r = rows.find((x) => x.metric.label === label)!;
    const value = r.now === null ? "—" : r.metric.kind === "money" ? formatCents(r.now) : r.metric.kind === "pct" ? `${Math.round(r.now * 100)}%` : String(r.now);
    const better = r.diff === null || r.diff === 0 ? undefined : (r.diff > 0) !== !!r.metric.down;
    const change = r.metric.kind === "pct" ? (r.diff === null ? "—" : signed(r.diff, "pct")) : pctText(r.pct);
    return { label, value, hint: `${change} vs ${wasLabel}`, tone: better === undefined ? undefined : better ? ("up" as const) : ("down" as const) };
  };

  return {
    stats: [tile("Net sales"), tile("Tickets"), tile("New clients"), tile("Rebook rate")],
    tables,
    options: [{ param: "compare", label: "Compare with", value: mode === "prior" ? "" : mode, choices: COMPARE_MODES.map((c) => ({ value: c.value === "prior" ? "" : c.value, label: c.label })) }],
    presets: ANALYTICS_PERIODS.map((p) => ({ id: p.id, label: p.label })),
    notes: ["Sales count on the day they were paid; refunds on the day they were given. Retention compares with the period before each range, as on Retention and rebook KPIs."],
  };
}
