import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { periodOf } from "@/domain/payroll/calendar";
import { reportView, type Permission } from "@/domain/permissions";
import { type CardPeriod, type CardRow, type PerClientCardData, type PphCardData, RANGE_SPARK_DAYS, SPARK_DAYS, cardPeriods, perClientCard, pphCard } from "@/domain/pph-card";
import { type LocalDate, addDays, diffDays } from "@/lib/time";
import type { StaffAccess } from "./auth/access";
import { brandCalendar, ensurePayGroups } from "./payroll/groups";
import { periodLabel } from "./payroll/periods";
import { pphRowsFor } from "./pph-report";
import { openShiftWork } from "./time-clock";

/**
 * The dashboard's Productivity Per Hour card (src/domain/pph-card.ts) from the live data, worked out
 * as the PPH report works it out (src/server/pph-report.ts). Today counts shifts still on the clock
 * up to now, so a barber at work all day isn't N/A until they clock out. The period to date is each
 * shop's own pay period, from its first day to today. Product sales per client comes from the same
 * rows, so the two cards always cover the same shops, people and days.
 */

export interface PphDashboard extends PphCardData {
  /** The brand (the brand dashboard of someone with every shop), several shops, one shop, or only the viewer's own numbers. */
  scope: "brand" | "shops" | "shop" | "own";
  totalLabel: string;
  money: boolean;
  shopIds: string[];
  dates: { today: LocalDate; yesterday: LocalDate };
  /** The tiles shown, in order: the selected range last when there is one. */
  periods: CardPeriod[];
  /** The dashboard's selected range (other than today), its tile and what the leaderboards rank by default. */
  range: { from: LocalDate; to: LocalDate; label: string } | null;
  /** The pay period the period to date is in; null where the shops' calendars differ (each shop's own). */
  period: { start: LocalDate; end: LocalDate; label: string } | null;
  /** Product sales per client over the same shops and periods; null without money (it's a dollar figure). */
  perClient: PerClientCardData | null;
}

const canAt = (a: StaffAccess, shopId: string, p: Permission) => a.byShop.get(shopId)?.permissions.has(p) ?? false;

/** The pay period running on `today` at each shop: shops on the same calendar share one. */
async function currentPeriods(shopIds: readonly string[], today: LocalDate): Promise<{ start: LocalDate; end: LocalDate; shopIds: string[] }[]> {
  const groups = await ensurePayGroups();
  const fallback = shopIds.some((id) => !groups.some((g) => g.shopId === id)) ? periodOf(await brandCalendar(), today) : null;
  const out = new Map<string, { start: LocalDate; end: LocalDate; shopIds: string[] }>();
  for (const id of shopIds) {
    const g = groups.find((x) => x.shopId === id);
    const p = g ? periodOf(g.calendar, today) : fallback!;
    const k = `${p.start}_${p.end}`;
    out.set(k, { start: p.start, end: p.end, shopIds: [...(out.get(k)?.shopIds ?? []), id] });
  }
  return [...out.values()];
}

export interface PphDashboardInput {
  access: StaffAccess;
  /** The dashboard's shops: the selected one on a shop's dashboard, all theirs on the brand's. */
  shops: readonly { id: string; name: string }[];
  /** The brand dashboard of someone with every shop: the total is the brand's. */
  brand: boolean;
  today: LocalDate;
  now: Date;
  rankBy: CardPeriod;
  /** The period the product sales per client leaderboards rank; the PPH one's by default. */
  perClientBy?: CardPeriod;
  /** The dashboard's date range when it isn't today: a tile of its own, the leaderboards' default, and the sparkline's days. */
  range?: { from: LocalDate; to: LocalDate; label: string } | null;
}

/**
 * The card for the dashboard's shops where they may see the PPH report, or null with none. Without
 * "every barber's numbers" at one of them it's only their own, with no leaderboards to compare.
 */
export async function pphDashboard(o: PphDashboardInput): Promise<PphDashboard | null> {
  const shops = o.shops.filter((s) => canAt(o.access, s.id, reportView("pph")));
  if (!shops.length) return null;
  const shopIds = shops.map((s) => s.id);
  const ownOnly = shopIds.some((id) => !canAt(o.access, id, "reports.all_staff"));
  const money = shopIds.every((id) => canAt(o.access, id, "reports.money"));
  const sel = { shopIds, staffIds: ownOnly ? [o.access.staffId] : null };
  const days = Array.from({ length: SPARK_DAYS }, (_, i) => addDays(o.today, i - SPARK_DAYS + 1));
  const dayRanges = days.map((d) => ({ start: d, end: d }));
  const [periods, open] = await Promise.all([currentPeriods(shopIds, o.today), openShiftWork(shopIds, sel.staffIds, o.now)]);
  const toDate = (p: { start: LocalDate }) => ({ start: p.start > o.today ? o.today : p.start, end: o.today });
  // A range runs to today at the latest: nothing is worked or sold after it.
  const r = o.range ?? null;
  const rangeEnd = r ? (r.to > o.today ? o.today : r.to) : null;
  const rangeOn = !!r && r.from <= rangeEnd!;
  const rangeDays = rangeOn ? Array.from({ length: Math.min(RANGE_SPARK_DAYS, diffDays(rangeEnd!, r!.from) + 1) }, (_, i) => addDays(rangeEnd!, i - Math.min(RANGE_SPARK_DAYS, diffDays(rangeEnd!, r!.from) + 1) + 1)) : [];
  const extra = [...(rangeOn ? [{ start: r!.from, end: rangeEnd! }] : []), ...rangeDays.map((d) => ({ start: d, end: d }))];

  let daily: CardRow[][];
  let period: CardRow[];
  let rest: CardRow[][];
  if (periods.length === 1) {
    const all = await pphRowsFor(sel, [...dayRanges, toDate(periods[0]), ...extra], open);
    daily = all.slice(0, SPARK_DAYS);
    period = all[SPARK_DAYS];
    rest = all.slice(SPARK_DAYS + 1);
  } else {
    const [d, ...each] = await Promise.all([pphRowsFor(sel, [...dayRanges, ...extra], open), ...periods.map((p) => pphRowsFor({ ...sel, shopIds: p.shopIds }, [toDate(p)], open))]);
    daily = d.slice(0, SPARK_DAYS);
    rest = d.slice(SPARK_DAYS);
    period = each.flatMap((x) => x[0]);
  }
  const rangeRows = rangeOn ? rest[0] : [];
  const rangeDaily = rangeOn ? rest.slice(1) : [];

  const people = [...new Set([...daily.flat(), ...period, ...rangeRows].map((r) => r.staffId))];
  const names = new Map((people.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, people)) : []).map((s) => [s.id, s.label]));
  const input = {
    rows: { today: daily[SPARK_DAYS - 1], yesterday: daily[SPARK_DAYS - 2], period, ...(r ? { range: rangeRows } : {}) },
    days: r ? rangeDays.map((date, i) => ({ date, rows: rangeDaily[i] })) : days.map((date, i) => ({ date, rows: daily[i] })),
    shops: ownOnly ? [] : shops,
    names,
  };
  const card = pphCard({ ...input, rankBy: o.rankBy, money });
  const pc = money ? perClientCard({ ...input, rankBy: o.perClientBy ?? o.rankBy }) : null;
  const scope = ownOnly ? "own" : shops.length === 1 ? "shop" : o.brand && shops.length === o.shops.length ? "brand" : "shops";
  return {
    ...card,
    barbers: ownOnly ? [] : card.barbers,
    scope,
    totalLabel: scope === "own" ? "You" : scope === "shop" ? shops[0].name : scope === "brand" ? "Brand" : "All my shops",
    money,
    shopIds,
    dates: { today: o.today, yesterday: addDays(o.today, -1) },
    periods: cardPeriods(!!r),
    range: r,
    period: periods.length === 1 ? { start: periods[0].start, end: periods[0].end, label: periodLabel(periods[0]) } : null,
    perClient: pc && { ...pc, barbers: ownOnly ? [] : pc.barbers },
  };
}
