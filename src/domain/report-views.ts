/**
 * Report tables in four views: combined across the selected shops and barbers, broken out by
 * location, by barber, or by location and barber. Loaders hand over values and rows tagged with
 * their shop and barber; these builders lay them out with a subtotal per shop or barber and a
 * total, so every report adds up the same way on screen and in CSV.
 */
import { NO_BARBER, NO_BARBER_LABEL } from "./barbers";

export type Cell = string | number | boolean | null;
/** `hours` values are minutes, shown as hours; `decimal` is an average like 4.25 stars. */
export type ColumnKind = "text" | "int" | "money" | "pct" | "bool" | "hours" | "decimal";
export interface Column {
  label: string;
  kind?: ColumnKind;
  /** Added up in subtotal and total rows. Defaults to true for money, int and hours columns. */
  sum?: boolean;
}

/** Rates and averages don't add up across shops or barbers. */
export const additiveKind = (k: ColumnKind | undefined) => k === "money" || k === "int" || k === "hours";
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
export type ReportView = "combined" | "shops" | "barbers" | "shops_barbers";
export const REPORT_VIEWS: Record<ReportView, string> = { combined: "Combined", shops: "By location", barbers: "By barber", shops_barbers: "By location and barber" };
export const LOCATION_VIEWS: Record<LocationView, string> = { combined: REPORT_VIEWS.combined, shops: REPORT_VIEWS.shops };
export const parseReportView = (v: unknown): ReportView | null => (typeof v === "string" && v in REPORT_VIEWS ? (v as ReportView) : null);
export const parseView = (v: unknown): LocationView => (v === "shops" || v === "shops_barbers" ? "shops" : "combined");

export interface ShopRef {
  id: string;
  name: string;
}
export interface StaffRef {
  id: string;
  name: string;
}
export interface ViewCtx {
  view: LocationView;
  /** Break out by barber too. */
  byBarber?: boolean;
  /** The selected shops, in display order. */
  shops: ShopRef[];
  /** The selected barbers, in display order. By-barber views also show anyone else found in the data. */
  barbers?: StaffRef[];
  /** Display labels for anyone who can turn up in the data. */
  staffNames?: Record<string, string>;
  /** "Brand total" when every shop and barber is selected, otherwise "Total (3 shops)" and the like. */
  totalLabel: string;
}

export const viewOf = (v: Pick<ViewCtx, "view" | "byBarber">): ReportView => (v.byBarber ? (v.view === "shops" ? "shops_barbers" : "barbers") : v.view);

export function totalLabel(selected: number, brandAll: boolean, barbers: number | null = null): string {
  if (barbers !== null && barbers > 1) return selected > 1 ? `Total (${barbers} barbers, ${selected} shops)` : `Total (${barbers} barbers)`;
  if (brandAll && selected > 1 && barbers === null) return "Brand total";
  return selected > 1 ? `Total (${selected} shops)` : "Total";
}

export const LOCATION = "Location";
export const BARBER = "Barber";

export const summable = (c: Column) => c.sum ?? additiveKind(c.kind);

/** Sums the summable columns; other columns keep their value only when every row agrees. */
export function combineCells(columns: Column[], rows: Cell[][]): Cell[] {
  return columns.map((c, i) => {
    if (summable(c)) return rows.reduce<number>((a, r) => a + (typeof r[i] === "number" ? (r[i] as number) : 0), 0);
    if (!rows.length) return null;
    const first = rows[0][i];
    return rows.every((r) => r[i] === first) ? first : null;
  });
}

// ───────────────────────────── Segments: who a row or value belongs to ─────────────────────────────

/** Key of a value by shop and barber; "*" folds that dimension. `segKey(null, null)` is the total. */
export const segKey = (shopId: string | null, staffId: string | null) => `${shopId ?? "*"}|${staffId ?? "*"}`;
export const TOTAL = segKey(null, null);
export function parseSegKey(k: string): { shopId: string | null; staffId: string | null } {
  const [a, b] = k.split("|");
  return { shopId: a === "*" ? null : a, staffId: b === "*" ? null : b };
}

export interface Segment {
  key: string;
  shopId: string | null;
  staffId: string | null;
  /** The label cells in front of the row: [shop], [barber] or [shop, barber]. */
  labels: string[];
}

export const staffName = (v: ViewCtx, id: string) => (id === NO_BARBER ? NO_BARBER_LABEL : (v.barbers?.find((b) => b.id === id)?.name ?? v.staffNames?.[id] ?? "Unknown"));
export const labelColumns = (v: ViewCtx): Column[] => [...(v.view === "shops" ? [{ label: LOCATION }] : []), ...(v.byBarber ? [{ label: BARBER }] : [])];

/** Barbers in display order: the selection first, then anyone else in the data by name, "No barber" last. */
function orderBarbers(v: ViewCtx, ids: Iterable<string>): string[] {
  const selected = (v.barbers ?? []).map((b) => b.id);
  const extra = [...new Set(ids)].filter((id) => !selected.includes(id) && id !== NO_BARBER).sort((a, b) => staffName(v, a).localeCompare(staffName(v, b)));
  const all = [...new Set(ids)];
  return [...selected, ...extra, ...(all.includes(NO_BARBER) ? [NO_BARBER] : [])];
}

/**
 * The segments a view shows, given the keys found in the data at its grain. Selected shops always
 * show; by barber, every selected barber shows; by location and barber, the pairs found in the data.
 */
export function segments(v: ViewCtx, present: Iterable<string>): Segment[] {
  const found = [...present].map(parseSegKey);
  if (!v.byBarber) return v.view === "shops" ? v.shops.map((s) => ({ key: segKey(s.id, null), shopId: s.id, staffId: null, labels: [s.name] })) : [];
  if (v.view !== "shops")
    return orderBarbers(v, found.map((f) => f.staffId!).filter(Boolean)).map((id) => ({ key: segKey(null, id), shopId: null, staffId: id, labels: [staffName(v, id)] }));
  return v.shops.flatMap((s) => {
    const here = found.filter((f) => f.shopId === s.id && f.staffId).map((f) => f.staffId!);
    const ids = orderBarbers({ ...v, barbers: [] }, here).sort((a, b) => order(v, a) - order(v, b));
    return ids.map((id) => ({ key: segKey(s.id, id), shopId: s.id, staffId: id, labels: [s.name, staffName(v, id)] }));
  });
}
function order(v: ViewCtx, id: string) {
  if (id === NO_BARBER) return Number.MAX_SAFE_INTEGER;
  const i = (v.barbers ?? []).findIndex((b) => b.id === id);
  return i >= 0 ? i : 1e6;
}

/** The key a row lands in at the view's grain. */
export const rowKey = (v: ViewCtx, r: { shopId: string | null; staffId?: string | null }) => segKey(v.view === "shops" ? r.shopId : null, v.byBarber ? (r.staffId ?? NO_BARBER) : null);

// ───────────────────────────── Metric tables: one row per metric ─────────────────────────────

export interface Metric {
  label: string;
  kind: ColumnKind;
  /** Value per segment key; subtotal and total keys too when they don't add up from the segments. */
  at: Record<string, number | null | undefined>;
  /** Adds up across segments. Defaults to true for money, int and hours. */
  additive?: boolean;
}

const additive = (m: Metric) => m.additive ?? additiveKind(m.kind);
/** What an empty segment shows: zero for counts and amounts, a dash for rates and averages. */
const empty = (m: Metric) => (additive(m) ? 0 : null);

/** The metric at a key, or the sum of its parts when it adds up and isn't given. */
export function metricAt(m: Metric, key: string, parts: string[]): number | null {
  const x = m.at[key];
  if (x !== undefined) return x;
  if (!additive(m)) return null;
  return parts.reduce((a, k) => a + (m.at[k] ?? 0), 0);
}

/** Keys of everything a metric set knows about, at the view's finest grain. */
const presentKeys = (v: ViewCtx, metrics: Metric[]) => {
  const want = (k: string) => {
    const p = parseSegKey(k);
    return (p.shopId !== null) === (v.view === "shops") && (p.staffId !== null) === !!v.byBarber;
  };
  return [...new Set(metrics.flatMap((m) => Object.keys(m.at)))].filter(want);
};

/**
 * Combined: one value column. By location: a column per shop plus the total. With barbers broken
 * out there can be dozens, so it turns into a segment table: a row per barber, a column per metric.
 */
export function metricTable(v: ViewCtx, t: { id: string; title: string; subtitle?: string; label?: string; exportOnly?: boolean; metrics: Metric[] }): ReportTable {
  if (v.byBarber) return segmentTable(v, t);
  const label = { label: t.label ?? "Metric" };
  const valueLabel = v.shops.length === 1 ? v.shops[0].name : v.totalLabel;
  const perShop = v.view === "shops";
  const keys = v.shops.map((s) => segKey(s.id, null));
  return {
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    exportOnly: t.exportOnly,
    columns: perShop ? [label, ...v.shops.map((s) => ({ label: s.name })), { label: v.totalLabel }] : [label, { label: valueLabel }],
    rows: t.metrics.map((m) => [m.label, ...(perShop ? keys.map((k) => m.at[k] ?? empty(m)) : []), metricAt(m, TOTAL, keys)]),
    rowKinds: t.metrics.map((m) => m.kind),
    totalColumn: perShop,
  };
}

/** A row per segment and a column per metric, with a subtotal per shop (by location and barber) and the total. */
export function segmentTable(v: ViewCtx, t: { id: string; title: string; subtitle?: string; exportOnly?: boolean; metrics: Metric[] }): ReportTable {
  const segs = segments(v, presentKeys(v, t.metrics));
  const columns: Column[] = [...(segs.length ? labelColumns(v) : [{ label: LOCATION }]), ...t.metrics.map((m) => ({ label: m.label, kind: m.kind, sum: additive(m) }))];
  const rows: Cell[][] = [];
  const styles: (RowStyle | undefined)[] = [];
  const at = (key: string, parts: string[]) => t.metrics.map((m) => (parts.length || m.at[key] !== undefined ? metricAt(m, key, parts) : empty(m)));
  const pushSeg = (s: Segment) => {
    rows.push([...s.labels, ...t.metrics.map((m) => m.at[s.key] ?? empty(m))]);
    styles.push(undefined);
  };
  if (v.view === "shops" && v.byBarber)
    for (const shop of v.shops) {
      const mine = segs.filter((x) => x.shopId === shop.id);
      mine.forEach(pushSeg);
      rows.push([shop.name, "Subtotal", ...at(segKey(shop.id, null), mine.map((x) => x.key))]);
      styles.push("subtotal");
    }
  else segs.forEach(pushSeg);
  const label = segs.length || v.view === "shops" ? v.totalLabel : v.shops.length === 1 ? v.shops[0].name : v.totalLabel;
  rows.push([label, ...(v.view === "shops" && v.byBarber ? [null] : []), ...at(TOTAL, segs.map((s) => s.key))]);
  styles.push("total");
  return { id: t.id, title: t.title, subtitle: t.subtitle, exportOnly: t.exportOnly, columns, rows, rowStyles: styles };
}

/**
 * Barbers who worked at more than one of the selected shops: their row at each shop and their
 * combined total underneath. `metrics` need values at each (shop, barber) and per barber.
 */
export function metricSplitTable(v: ViewCtx, t: { id: string; title: string; subtitle?: string; metrics: Metric[] }): ReportTable | null {
  if (v.shops.length < 2) return null;
  const pairs = [...new Set(t.metrics.flatMap((m) => Object.keys(m.at)))].map(parseSegKey).filter((p) => p.shopId && p.staffId);
  const byStaff = new Map<string, string[]>();
  for (const p of pairs) if (v.shops.some((s) => s.id === p.shopId)) byStaff.set(p.staffId!, [...new Set([...(byStaff.get(p.staffId!) ?? []), p.shopId!])]);
  const multi = orderBarbers(v, [...byStaff.keys()]).filter((id) => byStaff.get(id)!.length > 1 && id !== NO_BARBER);
  if (!multi.length) return null;
  const rows: Cell[][] = [];
  const styles: (RowStyle | undefined)[] = [];
  for (const id of multi) {
    const shops = v.shops.filter((s) => byStaff.get(id)!.includes(s.id));
    for (const s of shops) {
      rows.push([staffName(v, id), s.name, ...t.metrics.map((m) => m.at[segKey(s.id, id)] ?? empty(m))]);
      styles.push(undefined);
    }
    rows.push([
      staffName(v, id),
      `All ${shops.length} shops`,
      ...t.metrics.map((m) =>
        metricAt(
          m,
          segKey(null, id),
          shops.map((s) => segKey(s.id, id)),
        ),
      ),
    ]);
    styles.push("subtotal");
  }
  return {
    id: t.id,
    title: t.title,
    subtitle: t.subtitle,
    columns: [{ label: BARBER }, { label: LOCATION }, ...t.metrics.map((m) => ({ label: m.label, kind: m.kind, sum: additive(m) }))],
    rows,
    rowStyles: styles,
  };
}

// ───────────────────────────── List tables: one row per thing ─────────────────────────────

export interface ListRow {
  shopId: string;
  /** The barber, for reports that break out by barber. Null is a ticket with no barber. */
  staffId?: string | null;
  /** Rows with the same key are the same thing at different shops or barbers (a day, an item). */
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

function mergeByKey(t: ListSpec, rows: ListRow[], derive: (c: Cell[]) => Cell[]): { cells: Cell[]; shopIds: string[] }[] {
  const groups = new Map<string, ListRow[]>();
  rows.forEach((r, i) => {
    const k = r.key ?? `#${i}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  });
  return [...groups.values()].map((g) => ({
    cells:
      g.length === 1
        ? g[0].cells
        : derive(
            combineCells(
              t.columns,
              g.map((r) => r.cells),
            ),
          ),
    shopIds: [...new Set(g.map((r) => r.shopId))],
  }));
}

export function listTable(v: ViewCtx, t: ListSpec): ReportTable {
  const derive = t.derive ?? ((c: Cell[]) => c);
  const totals = t.totals ?? true;
  const shopName = new Map(v.shops.map((s) => [s.id, s.name]));
  const order = new Map(v.shops.map((s, i) => [s.id, i]));
  const sorted = (rows: Cell[][]) => (t.sort ? [...rows].sort(t.sort) : rows);
  const labelAt = t.labelAt ?? 0;
  const label0 = (cells: Cell[], label: string | null) => (t.columns[labelAt] && !summable(t.columns[labelAt]) ? cells.map((c, i) => (i === labelAt ? label : c)) : cells);
  const sumUp = (rows: ListRow[], label: string | null) =>
    derive(
      label0(
        combineCells(
          t.columns,
          rows.map((r) => r.cells),
        ),
        label,
      ),
    );
  const rows: Cell[][] = [];
  const styles: (RowStyle | undefined)[] = [];
  const push = (cells: Cell[], style?: RowStyle) => {
    rows.push(cells);
    styles.push(style);
  };
  const done = (columns: Column[]): ReportTable => ({ id: t.id, title: t.title, subtitle: t.subtitle, exportOnly: t.exportOnly, columns, rows, rowStyles: styles });

  if (v.byBarber) {
    const segs = segments(v, new Set(t.rows.map((r) => rowKey(v, r))));
    const logShop = t.keepShop && v.view !== "shops" && v.shops.length > 1;
    const mineOf = (s: Segment) => t.rows.filter((r) => rowKey(v, r) === s.key);
    const body = (s: Segment) =>
      t.merge ? mergeByKey(t, mineOf(s), derive).map((x) => x.cells) : mineOf(s).map((r) => (logShop ? [shopName.get(r.shopId) ?? "", ...r.cells] : r.cells));
    const sub = (rs: ListRow[], label: string | null) => (logShop ? [null, ...sumUp(rs, label)] : sumUp(rs, label));
    const pushSeg = (s: Segment) => {
      for (const cells of logShop ? body(s).sort((a, b) => (t.sort ? t.sort(a.slice(1), b.slice(1)) : 0)) : sorted(body(s))) push([...s.labels, ...cells]);
      if (totals) push([...s.labels, ...sub(mineOf(s), "Subtotal")], "subtotal");
    };
    if (v.view === "shops")
      for (const shop of v.shops) {
        segs.filter((s) => s.shopId === shop.id).forEach(pushSeg);
        if (totals)
          push(
            [
              shop.name,
              "All barbers",
              ...sumUp(
                t.rows.filter((r) => r.shopId === shop.id),
                "Subtotal",
              ),
            ],
            "subtotal",
          );
      }
    else segs.forEach(pushSeg);
    if (totals) push([v.totalLabel, ...(v.view === "shops" ? [null] : []), ...sub(t.rows, null)], "total");
    return done([...labelColumns(v), ...(logShop ? [{ label: LOCATION }] : []), ...t.columns]);
  }

  if (v.view === "shops") {
    for (const shop of v.shops) {
      const mine = t.rows.filter((r) => r.shopId === shop.id);
      const cells = t.merge ? mergeByKey(t, mine, derive).map((x) => x.cells) : mine.map((r) => r.cells);
      for (const c of sorted(cells)) push([shop.name, ...c]);
      if (totals) push([shop.name, ...sumUp(mine, "Subtotal")], "subtotal");
    }
    if (totals) push([v.totalLabel, ...sumUp(t.rows, null)], "total");
    return done([{ label: LOCATION }, ...t.columns]);
  }

  let columns = t.columns;
  if (t.merge) {
    const merged = mergeByKey(t, t.rows, derive).map((m) => ({ cells: m.cells, names: m.shopIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((id) => shopName.get(id) ?? "") }));
    const at = t.shopsColumnAt;
    if (at !== undefined) columns = insertAt(columns, at, { label: "Locations" });
    const bySort = t.sort ? [...merged].sort((a, b) => t.sort!(a.cells, b.cells)) : merged;
    for (const m of bySort) push(at !== undefined ? insertAt(m.cells, at, m.names.join(", ")) : m.cells);
    if (totals) {
      const total = sumUp(t.rows, v.totalLabel);
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
  return done(columns);
}

/**
 * Things that happened at more than one of the selected shops (a floater barber): a row per shop
 * and the combined total underneath, shown in every view.
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
  if (kind === "hours") return (v / 60).toFixed(2);
  if (kind === "decimal") return v.toFixed(2);
  return v;
}

/**
 * The table as it downloads. Lists keep their shape, Location and Barber columns and subtotal rows
 * included. A by-location metric table (a column per shop) turns on its side so it has a Location
 * column too: a row per shop, then the total row.
 */
export function csvTable(t: ReportTable): { headers: string[]; rows: (string | number | null)[][] } {
  if (t.rowKinds && t.totalColumn) {
    const shops = t.columns.slice(1);
    return { headers: [LOCATION, ...t.rows.map((r) => String(r[0]))], rows: shops.map((c, j) => [c.label, ...t.rows.map((r, i) => csvCell(r[j + 1], t.rowKinds![i]))]) };
  }
  return { headers: t.columns.map((c) => c.label), rows: t.rows.map((r, i) => r.map((v, j) => csvCell(v, t.rowKinds?.[i] && j > 0 ? t.rowKinds[i] : t.columns[j]?.kind))) };
}
