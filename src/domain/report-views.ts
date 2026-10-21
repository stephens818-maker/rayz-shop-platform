/**
 * Report tables in two views: combined across the selected shops, or broken out per shop with a
 * subtotal for each and a total. Loaders hand over rows tagged with their shop; these builders do
 * the rest, so every report adds up the same way on screen and in CSV.
 */

export type Cell = string | number | boolean | null;
export type ColumnKind = "text" | "int" | "money" | "pct" | "bool";
export interface Column {
  label: string;
  kind?: ColumnKind;
  /** Added up in subtotal and total rows. Defaults to true for money and int columns. */
  sum?: boolean;
}
export type RowStyle = "subtotal" | "total";
export interface ReportTable {
  id: string;
  title: string;
  subtitle?: string;
  columns: Column[];
  rows: Cell[][];
  /** Number format per row, for tables whose rows are metrics and whose columns are shops. */
  rowKinds?: (ColumnKind | undefined)[];
  rowStyles?: (RowStyle | undefined)[];
  /** The last column is a total. */
  totalColumn?: boolean;
  /** Shown as stat tiles on the page; still downloadable. */
  exportOnly?: boolean;
}

export type LocationView = "combined" | "shops";
export const LOCATION_VIEWS: Record<LocationView, string> = { combined: "Combined", shops: "By location" };
export const parseView = (v: unknown): LocationView => (v === "shops" ? "shops" : "combined");

export interface ShopRef {
  id: string;
  name: string;
}
export interface ViewCtx {
  view: LocationView;
  /** The selected shops, in display order. */
  shops: ShopRef[];
  /** "Brand total" when every shop is selected, otherwise "Total" or "Total (3 shops)". */
  totalLabel: string;
}

export function totalLabel(selected: number, brandAll: boolean): string {
  if (brandAll && selected > 1) return "Brand total";
  return selected > 1 ? `Total (${selected} shops)` : "Total";
}

export const LOCATION = "Location";

export const summable = (c: Column) => c.sum ?? (c.kind === "money" || c.kind === "int");

/** Sums the summable columns; other columns keep their value only when every row agrees. */
export function combineCells(columns: Column[], rows: Cell[][]): Cell[] {
  return columns.map((c, i) => {
    if (summable(c)) return rows.reduce<number>((a, r) => a + (typeof r[i] === "number" ? (r[i] as number) : 0), 0);
    if (!rows.length) return null;
    const first = rows[0][i];
    return rows.every((r) => r[i] === first) ? first : null;
  });
}

// ───────────────────────────── Metric tables: one row per metric ─────────────────────────────

export interface Metric {
  label: string;
  kind: ColumnKind;
  byShop: Record<string, number | null | undefined>;
  /** For metrics that don't add up across shops (rates, distinct clients). Defaults to the sum. */
  total?: number | null;
}

export function metricTotal(m: Metric, shops: ShopRef[]): number | null {
  if (m.total !== undefined) return m.total;
  if (m.kind === "pct") return null;
  return shops.reduce((a, s) => a + (m.byShop[s.id] ?? 0), 0);
}

/** Combined: one value column. By location: a column per shop plus the total. */
export function metricTable(v: ViewCtx, t: { id: string; title: string; subtitle?: string; label?: string; exportOnly?: boolean; metrics: Metric[] }): ReportTable {
  const label = { label: t.label ?? "Metric" };
  const valueLabel = v.shops.length === 1 ? v.shops[0].name : v.totalLabel;
  const perShop = v.view === "shops";
  return {
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    exportOnly: t.exportOnly,
    columns: perShop ? [label, ...v.shops.map((s) => ({ label: s.name })), { label: v.totalLabel }] : [label, { label: valueLabel }],
    rows: t.metrics.map((m) => [m.label, ...(perShop ? v.shops.map((s) => m.byShop[s.id] ?? (m.kind === "pct" ? null : 0)) : []), metricTotal(m, v.shops)]),
    rowKinds: t.metrics.map((m) => m.kind),
    totalColumn: perShop,
  };
}

// ───────────────────────────── List tables: one row per thing ─────────────────────────────

export interface ListRow {
  shopId: string;
  /** Rows with the same key are the same thing at different shops (a day, a barber, an item). */
  key?: string;
  cells: Cell[];
}

export interface ListSpec {
  id: string;
  title: string;
  subtitle?: string;
  columns: Column[];
  rows: ListRow[];
  /** Combined view: rows with the same key merge into one, summing the summable columns. */
  merge?: boolean;
  /** Combined view, merged rows: a "Locations" column listing where the row came from, at this index. */
  shopsColumnAt?: number;
  /** Combined view without merging (logs): keep a Location column in front. */
  keepShop?: boolean;
  /** Recomputes derived cells (averages, shares) of merged, subtotal and total rows. */
  derive?: (cells: Cell[]) => Cell[];
  sort?: (a: Cell[], b: Cell[]) => number;
  /** Subtotal and total rows. Default on. */
  totals?: boolean;
  /** Column that carries the "Subtotal" / total label. Default the first column, if it is text. */
  labelAt?: number;
  exportOnly?: boolean;
}

const insertAt = <T>(xs: T[], at: number, x: T) => [...xs.slice(0, at), x, ...xs.slice(at)];

export function listTable(v: ViewCtx, t: ListSpec): ReportTable {
  const derive = t.derive ?? ((c: Cell[]) => c);
  const totals = t.totals ?? true;
  const shopName = new Map(v.shops.map((s) => [s.id, s.name]));
  const order = new Map(v.shops.map((s, i) => [s.id, i]));
  const sorted = (rows: Cell[][]) => (t.sort ? [...rows].sort(t.sort) : rows);
  const labelAt = t.labelAt ?? 0;
  const label0 = (cells: Cell[], label: string | null) => (t.columns[labelAt] && !summable(t.columns[labelAt]) ? cells.map((c, i) => (i === labelAt ? label : c)) : cells);
  const rows: Cell[][] = [];
  const styles: (RowStyle | undefined)[] = [];
  const push = (cells: Cell[], style?: RowStyle) => {
    rows.push(cells);
    styles.push(style);
  };

  if (v.view === "shops") {
    for (const shop of v.shops) {
      const mine = t.rows.filter((r) => r.shopId === shop.id).map((r) => r.cells);
      for (const cells of sorted(mine)) push([shop.name, ...cells]);
      if (totals) push([shop.name, ...derive(label0(combineCells(t.columns, mine), "Subtotal"))], "subtotal");
    }
    if (totals)
      push(
        [
          v.totalLabel,
          ...derive(
            label0(
              combineCells(
                t.columns,
                t.rows.map((r) => r.cells),
              ),
              null,
            ),
          ),
        ],
        "total",
      );
    return { id: t.id, title: t.title, subtitle: t.subtitle, exportOnly: t.exportOnly, columns: [{ label: LOCATION }, ...t.columns], rows, rowStyles: styles };
  }

  let columns = t.columns;
  if (t.merge) {
    const groups = new Map<string, ListRow[]>();
    t.rows.forEach((r, i) => {
      const k = r.key ?? `#${i}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    });
    const merged = [...groups.values()].map((g) => {
      const cells =
        g.length === 1
          ? g[0].cells
          : derive(
              combineCells(
                t.columns,
                g.map((r) => r.cells),
              ),
            );
      const names = [...new Set(g.map((r) => r.shopId))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((id) => shopName.get(id) ?? "");
      return { cells, names };
    });
    const at = t.shopsColumnAt;
    if (at !== undefined) columns = insertAt(columns, at, { label: "Locations" });
    const bySort = t.sort ? [...merged].sort((a, b) => t.sort!(a.cells, b.cells)) : merged;
    for (const m of bySort) push(at !== undefined ? insertAt(m.cells, at, m.names.join(", ")) : m.cells);
    if (totals) {
      const total = derive(
        label0(
          combineCells(
            t.columns,
            t.rows.map((r) => r.cells),
          ),
          v.totalLabel,
        ),
      );
      push(at !== undefined ? insertAt(total, at, null) : total, "total");
    }
  } else {
    if (t.keepShop) columns = [{ label: LOCATION }, ...columns];
    const list = t.rows.map((r) => ({ cells: r.cells, shop: shopName.get(r.shopId) ?? "" }));
    const bySort = t.sort ? [...list].sort((a, b) => t.sort!(a.cells, b.cells)) : list;
    for (const r of bySort) push(t.keepShop ? [r.shop, ...r.cells] : r.cells);
    if (totals) {
      const total = derive(
        combineCells(
          t.columns,
          t.rows.map((r) => r.cells),
        ),
      );
      push(t.keepShop ? [v.totalLabel, ...label0(total, null)] : label0(total, v.totalLabel), "total");
    }
  }
  return { id: t.id, title: t.title, subtitle: t.subtitle, exportOnly: t.exportOnly, columns, rows, rowStyles: styles };
}

/**
 * Things that happened at more than one of the selected shops (a floater barber): a row per shop
 * and the combined total underneath, shown in both views.
 */
export function splitTable(v: ViewCtx, t: Omit<ListSpec, "merge" | "keepShop" | "shopsColumnAt" | "totals"> & { shopAt?: number }): ReportTable | null {
  const at = t.shopAt ?? 1;
  const derive = t.derive ?? ((c: Cell[]) => c);
  const order = new Map(v.shops.map((s, i) => [s.id, i]));
  const shopName = new Map(v.shops.map((s) => [s.id, s.name]));
  const groups = new Map<string, ListRow[]>();
  for (const r of t.rows) if (r.key) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  const multi = [...groups.values()].filter((g) => new Set(g.map((r) => r.shopId)).size > 1);
  if (!multi.length) return null;
  const combinedRows = multi.map((g) => ({
    g,
    total: derive(
      combineCells(
        t.columns,
        g.map((r) => r.cells),
      ),
    ),
  }));
  if (t.sort) combinedRows.sort((a, b) => t.sort!(a.total, b.total));
  const rows: Cell[][] = [];
  const styles: (RowStyle | undefined)[] = [];
  for (const { g, total } of combinedRows) {
    for (const r of [...g].sort((a, b) => (order.get(a.shopId) ?? 0) - (order.get(b.shopId) ?? 0))) {
      rows.push(insertAt(r.cells, at, shopName.get(r.shopId) ?? ""));
      styles.push(undefined);
    }
    const n = new Set(g.map((r) => r.shopId)).size;
    rows.push(insertAt(total, at, `All ${n} shops`));
    styles.push("subtotal");
  }
  return { id: t.id, title: t.title, subtitle: t.subtitle, exportOnly: t.exportOnly, columns: insertAt(t.columns, at, { label: LOCATION }), rows, rowStyles: styles };
}

// ───────────────────────────── CSV ─────────────────────────────

const pctText = (v: number) => `${(v * 100).toFixed(1)}%`;

function csvCell(v: Cell, kind: ColumnKind | undefined): string | number | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v !== "number") return v;
  if (kind === "money") return (v / 100).toFixed(2);
  if (kind === "pct") return pctText(v);
  return v;
}

/**
 * The table as it downloads. Lists keep their shape, Location column and subtotal rows included.
 * A by-location metric table (a column per shop) turns on its side so it has a Location column too:
 * a row per shop, then the total row.
 */
export function csvTable(t: ReportTable): { headers: string[]; rows: (string | number | null)[][] } {
  if (t.rowKinds && t.totalColumn) {
    const shops = t.columns.slice(1);
    return { headers: [LOCATION, ...t.rows.map((r) => String(r[0]))], rows: shops.map((c, j) => [c.label, ...t.rows.map((r, i) => csvCell(r[j + 1], t.rowKinds![i]))]) };
  }
  return { headers: t.columns.map((c) => c.label), rows: t.rows.map((r, i) => r.map((v, j) => csvCell(v, t.rowKinds?.[i] && j > 0 ? t.rowKinds[i] : t.columns[j]?.kind))) };
}
