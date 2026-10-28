/**
 * Production per hour (PPH, Charles): what someone brings in for each hour on the clock, worked out
 * the same way everywhere it shows (the PPH report, the Payroll Report's review columns, the Morning
 * Dashboard and My Earnings):
 *
 * - Service PPH: service sales before tax and tips, net of discounts and refunds, over clocked worked
 *   hours. Worked hours are regular plus overtime from the time clock; training and PTO aren't
 *   production time, so they're left out.
 * - Product PPH: product sales the same way, over the same hours.
 * - Total PPH: service and product sales together, over the same hours.
 *
 * With no worked hours it's N/A (null), never $0 or infinite. A total over several people, shops or
 * days is their sales added up over their hours added up, never an average of their PPHs.
 * Pure: no database, no clock.
 */
import { LocalDate, addDays, diffDays, formatDate } from "@/lib/time";

export const PPH_MEASURES = ["service", "product", "total"] as const;
export type PphMeasure = (typeof PPH_MEASURES)[number];
export const PPH_LABEL: Record<PphMeasure, string> = { service: "Service PPH", product: "Product PPH", total: "Total PPH" };
export const parsePphMeasure = (v: unknown): PphMeasure => (v === "product" || v === "total" ? v : "service");

/** What the PPH shows when there are no worked hours. */
export const NA = "N/A";

/** Sales (in any one unit: cents or dollars) and worked hours. */
export interface PphInput {
  service: number;
  product: number;
  hours: number;
}

export interface Pph extends PphInput {
  /** Sales per worked hour, in the unit of the sales; null without worked hours. */
  servicePph: number | null;
  productPph: number | null;
  totalPph: number | null;
}

export const perHour = (amount: number, hours: number): number | null => (hours > 0 ? amount / hours : null);

export function pph(x: PphInput): Pph {
  return { ...x, servicePph: perHour(x.service, x.hours), productPph: perHour(x.product, x.hours), totalPph: perHour(x.service + x.product, x.hours) };
}

/** From cents and centi-hours (the time clock's hundredths of an hour), each PPH to the whole cent. */
export function pphCents(serviceCents: number, productCents: number, centiHours: number): Pph {
  const p = pph({ service: serviceCents, product: productCents, hours: centiHours / 100 });
  const c = (v: number | null) => (v === null ? null : Math.round(v));
  return { ...p, servicePph: c(p.servicePph), productPph: c(p.productPph), totalPph: c(p.totalPph) };
}

/** Sales and hours added up, then divided: the PPH of a shop, a brand or a range. */
export const addUp = (xs: readonly PphInput[]): PphInput => ({
  service: xs.reduce((a, x) => a + x.service, 0),
  product: xs.reduce((a, x) => a + x.product, 0),
  hours: xs.reduce((a, x) => a + x.hours, 0),
});

export const pphOf = (p: Pick<Pph, "servicePph" | "productPph" | "totalPph">, m: PphMeasure) => (m === "service" ? p.servicePph : m === "product" ? p.productPph : p.totalPph);

/** "$84.20" or N/A. */
export const pphText = (v: number | null, money: (x: number) => string) => (v === null ? NA : money(v));

/**
 * Worked hours on a Payroll Report line: regular plus overtime, less the overtime that came from
 * training on top of clocked hours (C2). Typed-over hours count, as the report pays them.
 */
export const workedHoursOf = (l: { hours: number; otHours: number; otFromTraining?: number }) => l.hours + l.otHours - (l.otFromTraining ?? 0);

/** A Payroll Report line's PPH, in dollars: Service$ (E) and Product$ (J) over its worked hours. */
type PayLine = { service: number; product: number; hours: number; otHours: number; otFromTraining?: number };
export const linePph = (l: PayLine) => pph({ service: l.service, product: l.product, hours: workedHoursOf(l) });
/** Several lines (a shop's block, every shop): their sales over their worked hours. */
export const linesPph = (ls: readonly PayLine[]) => pph(addUp(ls.map((l) => ({ service: l.service, product: l.product, hours: workedHoursOf(l) }))));

// ───────────────────────────── Ranking ─────────────────────────────

export type PphOrder = "high" | "low";
export const parsePphOrder = (v: unknown): PphOrder => (v === "low" ? "low" : "high");

export interface Ranked<T> {
  item: T;
  /** 1 is the best; equal PPHs share a rank and the next one skips (1, 2, 2, 4). Null for N/A. */
  rank: number | null;
  value: number | null;
}

/**
 * Highest first (or lowest first), equal values sharing a rank, then by name. N/A (no worked hours)
 * is never ranked: those come last, by name, whichever way it's sorted.
 */
export function rankPph<T>(items: readonly T[], value: (x: T) => number | null, name: (x: T) => string, order: PphOrder = "high"): Ranked<T>[] {
  const scored = items.map((item) => ({ item, value: value(item) }));
  const byName = (a: { item: T }, b: { item: T }) => name(a.item).localeCompare(name(b.item));
  const ok = scored.filter((x) => x.value !== null).sort((a, b) => (same(a.value!, b.value!) ? byName(a, b) : order === "high" ? b.value! - a.value! : a.value! - b.value!));
  const na = scored.filter((x) => x.value === null).sort(byName);
  const out: Ranked<T>[] = [];
  ok.forEach((x, i) => out.push({ ...x, rank: i > 0 && same(ok[i - 1].value!, x.value!) ? out[i - 1].rank : i + 1 }));
  return [...out, ...na.map((x) => ({ ...x, rank: null }))];
}

/** PPHs equal to the cent (or to a hundredth of a dollar) tie. */
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Sortable headings for a PPH table whose figures (worked hours, service and product sales, then the
 * three PPHs) follow `before` other columns: clicking a PPH heading ranks by it, highest first, and
 * clicking the one ranked by flips the order.
 */
export function pphSort(before: number, measure: PphMeasure, order: PphOrder) {
  const at = (k: PphMeasure) => before + 3 + PPH_MEASURES.indexOf(k);
  return {
    sortBy: Array.from({ length: before + 6 }, (_, j) => {
      const k = PPH_MEASURES.find((x) => at(x) === j);
      return k ? { rank: k, order: k === measure && order === "high" ? "low" : "high" } : null;
    }),
    sorted: { column: at(measure), dir: order === "high" ? ("desc" as const) : ("asc" as const) },
  };
}

// ───────────────────────────── Trend ─────────────────────────────

export const PPH_TRENDS = ["day", "week", "month", "period"] as const;
export type PphTrend = (typeof PPH_TRENDS)[number];
export const PPH_TREND_LABEL: Record<PphTrend, string> = { day: "Daily", week: "Weekly", month: "Monthly", period: "By pay period" };
/** Daily up to this many days, then weekly; weekly up to this many weeks, then monthly. */
export const MAX_TREND_DAYS = 62;
export const MAX_TREND_WEEKS = 104;

/**
 * The grain asked for, or one that fits the range: daily up to a month, weekly up to half a year,
 * monthly beyond. Too fine a grain for the range moves up one (coarsened).
 */
export function parsePphTrend(v: unknown, from: LocalDate, to: LocalDate): { grain: PphTrend; coarsened: boolean } {
  const days = diffDays(to, from) + 1;
  const asked = PPH_TRENDS.includes(v as PphTrend) ? (v as PphTrend) : null;
  const auto: PphTrend = days <= 31 ? "day" : days <= 182 ? "week" : "month";
  let g = asked ?? auto;
  if (g === "day" && days > MAX_TREND_DAYS) g = "week";
  if (g === "week" && days > MAX_TREND_WEEKS * 7) g = "month";
  return { grain: g, coarsened: !!asked && g !== asked };
}

export interface Bucket {
  start: LocalDate;
  end: LocalDate;
  label: string;
}

const nextMonth = (d: LocalDate) => {
  const [y, m] = d.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

/**
 * The trend's periods over [from, to], oldest first, each cut to the range: days, Sunday-to-Saturday
 * weeks, calendar months, or the pay periods given (for "period").
 */
export function trendBuckets(from: LocalDate, to: LocalDate, g: PphTrend, periods: readonly { start: LocalDate; end: LocalDate }[] = []): Bucket[] {
  const clip = (start: LocalDate, end: LocalDate) => ({ start: start < from ? from : start, end: end > to ? to : end });
  const out: Bucket[] = [];
  if (g === "period") {
    for (const p of [...periods].sort((a, b) => a.start.localeCompare(b.start)))
      if (p.end >= from && p.start <= to) out.push({ ...clip(p.start, p.end), label: `${formatDate(p.start, "MMM d")} – ${formatDate(p.end, p.start.slice(5, 7) === p.end.slice(5, 7) ? "d" : "MMM d")}` });
    return out;
  }
  let d = g === "week" ? addDays(from, -new Date(`${from}T12:00:00Z`).getUTCDay()) : g === "month" ? `${from.slice(0, 7)}-01` : from;
  while (d <= to && out.length < 400) {
    const next = g === "day" ? addDays(d, 1) : g === "week" ? addDays(d, 7) : nextMonth(d);
    out.push({ ...clip(d, addDays(next, -1)), label: g === "day" ? formatDate(d, "EEE MMM d") : g === "week" ? `Week of ${formatDate(d, "MMM d")}` : formatDate(d, "MMM yyyy") });
    d = next;
  }
  return out;
}
