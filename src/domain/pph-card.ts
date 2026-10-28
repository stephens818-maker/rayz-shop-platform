/**
 * The dashboard's Productivity Per Hour card (Charles): service PPH (src/domain/pph.ts) for today so
 * far, yesterday and the pay period to date, with clients per hour and total PPH beside it, a barber
 * leaderboard, a location leaderboard on a dashboard with more than one shop, and a daily sparkline.
 * The total is the dashboard's shops: the brand on the brand dashboard, one shop on a shop's.
 * Without money it ranks and charts clients per hour instead. Pure: no database, no clock.
 */
import type { LocalDate } from "@/lib/time";
import { type Pph, type PphRank, type Ranked, pphCents, pphOf, rankPph } from "./pph";

export const CARD_PERIODS = ["today", "yesterday", "period"] as const;
export type CardPeriod = (typeof CARD_PERIODS)[number];
export const CARD_PERIOD_LABEL: Record<CardPeriod, string> = { today: "Today", yesterday: "Yesterday", period: "Period to date" };
/** The leaderboards rank the pay period to date unless another period is picked. */
export const parseCardPeriod = (v: unknown): CardPeriod => (CARD_PERIODS.includes(v as CardPeriod) ? (v as CardPeriod) : "period");

/** Days on the sparkline, today last. */
export const SPARK_DAYS = 14;
/** Rows on each leaderboard before it points to the PPH report. */
export const BOARD_ROWS = 10;

/** One person at one shop: worked centi-hours, sales in cents and completed service tickets (the PPH report's rows). */
export interface CardRow {
  staffId: string;
  shopId: string;
  centi: number;
  serviceCents: number;
  productCents: number;
  clients: number;
}

export interface CardInput {
  rows: Record<CardPeriod, readonly CardRow[]>;
  /** Each day on the sparkline, oldest first. */
  days: readonly { date: LocalDate; rows: readonly CardRow[] }[];
  shops: readonly { id: string; name: string }[];
  names: ReadonlyMap<string, string>;
  rankBy: CardPeriod;
  /** May see sales: ranked and charted by service PPH. Otherwise by clients per hour. */
  money: boolean;
}

export interface BoardEntry {
  id: string;
  name: string;
  /** A barber's locations, on a dashboard with more than one. */
  detail: string | null;
  p: Pph;
}

export interface PphCardData {
  total: Record<CardPeriod, Pph>;
  rank: PphRank;
  rankBy: CardPeriod;
  /** Barbers with hours, sales or tickets in the ranked period, best first, N/A (no hours) last. */
  barbers: Ranked<BoardEntry>[];
  /** Every location, best first; empty on a one-shop dashboard. */
  shops: Ranked<BoardEntry>[];
  spark: { date: LocalDate; value: number | null }[];
}

/** Sales and tickets added up over hours added up, never an average of PPHs. */
export const cardTotal = (rs: readonly CardRow[]): Pph =>
  pphCents(
    rs.reduce((a, r) => a + r.serviceCents, 0),
    rs.reduce((a, r) => a + r.productCents, 0),
    rs.reduce((a, r) => a + r.centi, 0),
    rs.reduce((a, r) => a + r.clients, 0),
  );

const active = (r: CardRow) => r.centi > 0 || r.serviceCents !== 0 || r.productCents !== 0 || r.clients > 0;

export function pphCard(x: CardInput): PphCardData {
  const rank: PphRank = x.money ? "service" : "clients";
  const value = (e: BoardEntry) => pphOf(e.p, rank);
  const name = (e: BoardEntry) => e.name;
  const ranked = x.rows[x.rankBy];
  const multi = x.shops.length > 1;
  const shopName = new Map(x.shops.map((s) => [s.id, s.name]));
  const byStaff = new Map<string, CardRow[]>();
  for (const r of ranked) if (active(r)) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
  const barbers = [...byStaff].map(([id, rs]) => ({
    id,
    name: x.names.get(id) ?? "Unknown",
    detail: multi ? [...new Set(rs.map((r) => shopName.get(r.shopId) ?? ""))].sort().join(", ") : null,
    p: cardTotal(rs),
  }));
  const shops = multi ? x.shops.map((s) => ({ id: s.id, name: s.name, detail: null, p: cardTotal(ranked.filter((r) => r.shopId === s.id)) })) : [];
  return {
    total: { today: cardTotal(x.rows.today), yesterday: cardTotal(x.rows.yesterday), period: cardTotal(x.rows.period) },
    rank,
    rankBy: x.rankBy,
    barbers: rankPph(barbers, value, name),
    shops: rankPph(shops, value, name),
    spark: x.days.map((d) => ({ date: d.date, value: pphOf(cardTotal(d.rows), rank) })),
  };
}

/** Where a sparkline's points sit in a `w` by `h` box: 0 at the bottom, the highest value at the top, null days left out. */
export function sparkPoints(values: readonly (number | null)[], w: number, h: number, pad = 2): { i: number; x: number; y: number }[] {
  const max = Math.max(0, ...values.filter((v): v is number => v !== null));
  const n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => (max > 0 ? h - pad - (v / max) * (h - 2 * pad) : h - pad);
  return values.flatMap((v, i) => (v === null ? [] : [{ i, x: x(i), y: y(v) }]));
}
