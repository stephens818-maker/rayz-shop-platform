/**
 * What a client buys off the shelf, and when they'll want it again. A purchase is a product line on
 * a paid ticket, less what was refunded, on the ticket's business day; the client is whoever the
 * ticket is for. Buying the same product on two days gives a gap, and the gap is read per unit
 * (two bottles last twice as long), so the refill interval is the median days one unit lasts them
 * over their last REFILL_GAPS gaps. Clients who bought it once borrow the product's typical
 * interval, the median of every client's recent gaps, once there are REFILL_MIN_SAMPLE of them.
 * The SQL twin is `refillCtes` in server/product-history.ts; both must agree.
 */
import { addDays, diffDays, type LocalDate } from "@/lib/time";
import { median } from "./visit-cadence";

/** The most recent gaps per client and product the median reads. */
export const REFILL_GAPS = 6;
/** Gaps from all clients a product needs before its typical interval stands in for a client's own. */
export const REFILL_MIN_SAMPLE = 3;
/** A product is likely running out from this many days before what they bought should be used up. */
export const REFILL_LEAD_DAYS = 7;
/** Past that, by more than two weeks or half the supply, they've likely run out (and maybe bought elsewhere). */
export const refillGraceDays = (supplyDays: number) => Math.max(14, supplyDays * 0.5);
/** Purchases the recent history shows. */
export const HISTORY_ROWS = 5;

export const REFILL_STATUSES = ["stocked", "running_out", "ran_out"] as const;
export type RefillStatus = (typeof REFILL_STATUSES)[number];
export const REFILL_STATUS_LABEL: Record<RefillStatus, string> = { stocked: "Has some left", running_out: "Likely running out", ran_out: "Likely ran out" };
export const REFILL_STATUS_TONE: Record<RefillStatus, "green" | "amber" | "red"> = { stocked: "green", running_out: "amber", ran_out: "red" };
export const REFILL_SOURCES = ["client", "product"] as const;
export type RefillSource = (typeof REFILL_SOURCES)[number];
export const REFILL_SOURCE_LABEL: Record<RefillSource, string> = { client: "from their purchases", product: "typical for this product" };

/** One product line they paid for. */
export interface ProductBuy {
  saleId: string;
  /** Null for a line with no catalog product (an imported ticket's), which shows but can't be bought again. */
  productId: string | null;
  name: string;
  date: LocalDate;
  /** When the ticket was paid, to order lines on the same day. */
  at: string;
  shopId: string;
  shop: string;
  /** Net of refunds. */
  qty: number;
}

/** The last REFILL_GAPS gaps between one client's purchase days of a product, each divided by what was bought at the start of it. */
export function unitGaps(days: readonly { date: LocalDate; qty: number }[]): number[] {
  const by = new Map<LocalDate, number>();
  for (const d of days) if (d.qty > 0) by.set(d.date, (by.get(d.date) ?? 0) + d.qty);
  const d = [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return d
    .slice(1)
    .map(([date], i) => diffDays(date, d[i][0]) / d[i][1])
    .slice(-REFILL_GAPS);
}

/** Days one unit lasts them: the median of unitGaps, or null under two purchase days. */
export function daysPerUnit(days: readonly { date: LocalDate; qty: number }[]): number | null {
  const g = unitGaps(days);
  return g.length ? median(g) : null;
}

/** Stocked until REFILL_LEAD_DAYS before the supply's used up, then running out until the grace has passed, then ran out. */
export function refillStatus(supplyDays: number, sinceDays: number): RefillStatus {
  if (sinceDays < supplyDays - REFILL_LEAD_DAYS) return "stocked";
  return sinceDays <= supplyDays + refillGraceDays(supplyDays) ? "running_out" : "ran_out";
}

export interface ProductRefill {
  productId: string;
  name: string;
  /** Purchase days. */
  times: number;
  lastDate: LocalDate;
  lastQty: number;
  lastShop: string;
  /** Days one unit lasts them, or null with no interval of their own or the product's. */
  daysPerUnit: number | null;
  source: RefillSource | null;
  /** When the last purchase should be used up: the last day plus days per unit times what they bought. */
  due: LocalDate | null;
  sinceDays: number;
  status: RefillStatus | null;
}

/** Each catalog product they've bought, with its refill interval: running out first, then ran out, then by when it's due, then most recent. */
export function refills(buys: readonly ProductBuy[], typical: ReadonlyMap<string, number>, today: LocalDate): ProductRefill[] {
  const by = new Map<string, ProductBuy[]>();
  for (const b of buys) if (b.productId && b.qty > 0) by.set(b.productId, [...(by.get(b.productId) ?? []), b]);
  const out: ProductRefill[] = [];
  for (const [productId, list] of by) {
    const sorted = [...list].sort(newestFirst);
    const last = sorted[0];
    const lastQty = list.filter((b) => b.date === last.date).reduce((a, b) => a + b.qty, 0);
    const own = daysPerUnit(list);
    const per = own ?? typical.get(productId) ?? null;
    const sinceDays = diffDays(today, last.date);
    const supply = per === null ? null : per * lastQty;
    out.push({
      productId,
      name: last.name,
      times: new Set(list.map((b) => b.date)).size,
      lastDate: last.date,
      lastQty,
      lastShop: last.shop,
      daysPerUnit: per,
      source: own !== null ? "client" : per !== null ? "product" : null,
      due: supply === null ? null : addDays(last.date, Math.round(supply)),
      sinceDays,
      status: supply === null ? null : refillStatus(supply, sinceDays),
    });
  }
  const rank = (s: RefillStatus | null) => (s === "running_out" ? 0 : s === "ran_out" ? 1 : s === "stocked" ? 2 : 3);
  return out.sort((a, b) => rank(a.status) - rank(b.status) || (a.due && b.due ? a.due.localeCompare(b.due) : 0) || b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
}

/** Newest first: by day, then the time the ticket was paid, then name. The report's last product reads the same order. */
export function newestFirst(a: ProductBuy, b: ProductBuy): number {
  return b.date.localeCompare(a.date) || b.at.localeCompare(a.at) || a.name.localeCompare(b.name);
}

export interface ProductHistory {
  last: ProductBuy | null;
  /** The last HISTORY_ROWS purchases, newest first (the first is `last`). */
  recent: ProductBuy[];
  /** Purchases on file. */
  total: number;
  refills: ProductRefill[];
}

export function productHistory(buys: readonly ProductBuy[], typical: ReadonlyMap<string, number>, today: LocalDate): ProductHistory {
  const kept = buys.filter((b) => b.qty > 0).sort(newestFirst);
  return { last: kept[0] ?? null, recent: kept.slice(0, HISTORY_ROWS), total: kept.length, refills: refills(kept, typical, today) };
}

/** How long one lasts them: "About 5 weeks"; under two weeks in days. */
export function lastsLabel(days: number): string {
  if (days < 13.5) {
    const n = Math.max(1, Math.round(days));
    return `About ${n} day${n === 1 ? "" : "s"}`;
  }
  return `About ${Math.round((days / 7) * 2) / 2} weeks`;
}

/** The hint by a product: "Likely running out (due Mar 3)". */
export function refillHint(r: Pick<ProductRefill, "status" | "due">, fmt: (d: LocalDate) => string): string | null {
  if (!r.status || !r.due) return null;
  if (r.status === "stocked") return `${REFILL_STATUS_LABEL.stocked} until about ${fmt(r.due)}`;
  return `${REFILL_STATUS_LABEL[r.status]} (due ${fmt(r.due)})`;
}
