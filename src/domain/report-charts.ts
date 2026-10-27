import type { ColumnKind, ReportTable } from "./report-views";

export interface BarChart {
  id: string;
  title: string;
  subtitle?: string;
  kind: ColumnKind;
  /** "time": rows are dates or periods, drawn in order as columns; "rank": largest first, as bars. */
  shape: "time" | "rank";
  /** `parts` stack the bar (they add up to `value`), named by `legend`; `warn` draws it in the warning color. */
  bars: { label: string; value: number; parts?: number[]; warn?: boolean }[];
  legend?: string[];
  /** A threshold drawn across the bars, like 32 hours for full time or 40 for overtime. */
  reference?: { value: number; label: string };
}

const CHARTABLE: ColumnKind[] = ["money", "int", "hours"];
const TOP = 12;
const MAX_PERIODS = 62;
const PERIOD = /^(\d{4}-\d{2}(-\d{2})?|week of |(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(, \d{4})?$|(mon|tue|wed|thu|fri|sat|sun)[a-z]*,? )/i;
const TOTAL = /^(total|all shops|all locations|grand total)$/i;

const isText = (k: ColumnKind | undefined) => !k || k === "text";

/**
 * The bar chart for one report table, or null when it doesn't chart well: metric and pivot tables
 * (rows are measures, or columns are shops with a total), fewer than two rows, or no money, count or hours column. The label is the leading text
 * columns ("Moline · Kat"), the value the first money column, else the first count, else hours.
 * Subtotal and total rows are left out; the table below still has every row.
 */
export function barChartOf(t: ReportTable): BarChart | null {
  if (t.exportOnly || t.rowKinds || t.totalColumn || t.columns.length < 2) return null;
  let labels = 0;
  while (labels < t.columns.length && isText(t.columns[labels].kind)) labels++;
  if (labels === 0 || labels === t.columns.length) return null;
  const pick = (kind: ColumnKind) => t.columns.findIndex((c, j) => j >= labels && c.kind === kind);
  const valueAt = CHARTABLE.map(pick).find((j) => j >= 0) ?? -1;
  if (valueAt < 0) return null;
  const rows = t.rows
    .map((r, i) => ({ r, style: t.rowStyles?.[i] }))
    .filter(({ r, style }) => !style && !TOTAL.test(String(r[0] ?? "")))
    .map(({ r }) => ({
      label: r
        .slice(0, labels)
        .filter((x) => x !== null && x !== "")
        .join(" · "),
      value: typeof r[valueAt] === "number" ? (r[valueAt] as number) : 0,
    }))
    .filter((b) => b.label);
  if (rows.length < 2 || rows.every((b) => b.value <= 0)) return null;
  const kind = t.columns[valueAt].kind!;
  const title = `${t.columns[valueAt].label} by ${t.columns
    .slice(0, labels)
    .map((c) => c.label.toLowerCase())
    .join(" and ")}`;
  if (rows.every((b) => PERIOD.test(b.label))) {
    const bars = rows.slice(-MAX_PERIODS);
    return { id: t.id, title, kind, shape: "time", bars, subtitle: bars.length < rows.length ? `The last ${bars.length} of ${rows.length}` : undefined };
  }
  const bars = [...rows].sort((a, b) => b.value - a.value).slice(0, TOP);
  return { id: t.id, title, kind, shape: "rank", bars, subtitle: rows.length > TOP ? `Top ${TOP} of ${rows.length}` : undefined };
}

/** The first table on a report that charts. */
export function reportBarChart(tables: ReportTable[]): BarChart | null {
  for (const t of tables) {
    const c = barChartOf(t);
    if (c) return c;
  }
  return null;
}
