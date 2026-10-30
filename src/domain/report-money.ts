import type { Cell, ReportTable } from "./report-views";

/** "$1,234.56", "-$5", "+$2.00", "$12k": a dollar amount written into text. */
const DOLLARS = /[-−+]?\$\s?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[kKmM]\b)?/g;
export const HIDDEN_DOLLARS = "$—";
export const MONEY_HIDDEN_NOTE = "Dollar amounts are hidden: your role shows counts, rates and hours but not dollar amounts.";

export const scrubDollars = (s: string) => s.replace(DOLLARS, HIDDEN_DOLLARS);
const scrubCell = (v: Cell): Cell => (typeof v === "string" ? scrubDollars(v) : v);

/** A table with every dollar amount gone: money columns and money rows emptied, amounts in text replaced. */
export function tableWithoutMoney(t: ReportTable): ReportTable {
  const moneyCol = t.columns.map((c) => c.kind === "money");
  return {
    ...t,
    title: scrubDollars(t.title),
    ...(t.subtitle ? { subtitle: scrubDollars(t.subtitle) } : {}),
    rows: t.rows.map((r, i) => {
      const moneyRow = t.rowKinds?.[i] === "money";
      return r.map((v, j) => (moneyCol[j] || (moneyRow && typeof v === "number") ? null : scrubCell(v)));
    }),
  };
}

interface MoneyBearing {
  stats: { label: string; value: string; hint?: string }[];
  tables: ReportTable[];
  notes?: string[];
  bars?: { kind: string }[];
  charts?: { kind?: string }[];
}

/** What a report shows someone who may not see dollar amounts. Rate and count charts stay; dollar charts go. */
export function withoutMoney<D extends MoneyBearing>(d: D): D {
  return {
    ...d,
    ...(d.bars ? { bars: d.bars.filter((b) => b.kind !== "money") } : {}),
    ...(d.charts ? { charts: d.charts.filter((c) => c.kind !== "money") } : {}),
    stats: d.stats.map((s) => ({ ...s, value: scrubDollars(s.value), ...(s.hint ? { hint: scrubDollars(s.hint) } : {}) })),
    tables: d.tables.map(tableWithoutMoney),
    notes: [MONEY_HIDDEN_NOTE, ...(d.notes ?? []).map(scrubDollars)],
  };
}
