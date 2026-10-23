import { DateTime } from "luxon";
import { SHOP_TZ } from "@/lib/time";

/**
 * Cross-shop overtime. Hours are whole hundredths of an hour ("centi-hours"), the precision
 * Squire and iSolved use, so every split adds back up exactly.
 *
 * The rule (spec §3.2): for each Sun–Sat workweek in America/Chicago, an employee's hours at every
 * shop of the same legal entity (one FEIN) are added up; everything over 40 is overtime. That OT is
 * shared out to each slice of the week, a slice being one shop and the pay period that shop's
 * calendar puts those days in, in proportion to the slice's share of the week's hours. Shares are
 * rounded to hundredths by largest remainder (ties to the earlier slice), so the slices always add up
 * to the week's OT. A slice in a pay period that's already locked keeps the OT it was locked with;
 * the rest of the week's OT goes to the open slices.
 */

export type EntryKind = "worked" | "training" | "pto";

export interface TimeEntry {
  staffId: string;
  shopId: string;
  kind: EntryKind;
  startsAt: Date;
  endsAt: Date;
}

/** Minutes of one entry on each local date it touches, from real elapsed time (a DST night is 23 or 25 hours long). */
export function splitByLocalDay(e: Pick<TimeEntry, "startsAt" | "endsAt">): { date: string; minutes: number }[] {
  const out: { date: string; minutes: number }[] = [];
  let cur = DateTime.fromJSDate(e.startsAt, { zone: SHOP_TZ });
  const end = DateTime.fromJSDate(e.endsAt, { zone: SHOP_TZ });
  while (cur < end) {
    const nextMidnight = cur.startOf("day").plus({ days: 1 });
    const stop = nextMidnight < end ? nextMidnight : end;
    out.push({ date: cur.toISODate()!, minutes: stop.diff(cur, "minutes").minutes });
    cur = stop;
  }
  return out;
}

/** The Sunday that starts the workweek of a local date. */
export function weekStartOf(date: string): string {
  const d = DateTime.fromISO(date, { zone: SHOP_TZ });
  return d.minus({ days: d.weekday % 7 }).toISODate()!;
}

/** Half-up from minutes to hundredths of an hour. */
export const minutesToCenti = (minutes: number) => Math.floor((minutes * 100) / 60 + 0.5 + 1e-9);

export interface DayHours {
  staffId: string;
  shopId: string;
  date: string;
  /** Centi-hours by kind. */
  worked: number;
  training: number;
  pto: number;
}

/** Hours per employee, shop and local date. Minutes are added up per day first, then turned into hundredths once. */
export function dailyHours(entries: readonly TimeEntry[]): DayHours[] {
  const minutes = new Map<string, { staffId: string; shopId: string; date: string; worked: number; training: number; pto: number }>();
  for (const e of entries) {
    for (const part of splitByLocalDay(e)) {
      const k = `${e.staffId}|${e.shopId}|${part.date}`;
      const v = minutes.get(k) ?? { staffId: e.staffId, shopId: e.shopId, date: part.date, worked: 0, training: 0, pto: 0 };
      v[e.kind] += part.minutes;
      minutes.set(k, v);
    }
  }
  return [...minutes.values()].map((v) => ({ ...v, worked: minutesToCenti(v.worked), training: minutesToCenti(v.training), pto: minutesToCenti(v.pto) }));
}

export interface OtOptions {
  /** Weekly threshold in centi-hours. 4000 = 40 hours. */
  thresholdCenti: number;
  /** C2: training hours count toward the weekly 40 (and carry OT share). Off until Charles answers Q11. */
  trainingCountsTowardOt: boolean;
  /** Which legal entity (FEIN) a shop belongs to; hours only add up within one. */
  entityOf: (shopId: string) => string;
  /** The pay period (its start date) a shop's calendar puts a local date in. */
  periodOf: (shopId: string, date: string) => string;
  /** OT already locked into a slice: `${staffId}|${shopId}|${periodStart}|${weekStart}` → centi-hours. */
  locked?: ReadonlyMap<string, number>;
}

export interface Slice {
  staffId: string;
  shopId: string;
  periodStart: string;
  weekStart: string;
  entity: string;
  /** Hours that count toward the 40 in this slice. */
  basis: number;
  worked: number;
  training: number;
  pto: number;
  ot: number;
  locked: boolean;
}

export const sliceKey = (s: Pick<Slice, "staffId" | "shopId" | "periodStart" | "weekStart">) => `${s.staffId}|${s.shopId}|${s.periodStart}|${s.weekStart}`;

/** Shares `total` out by `weights` in whole units, largest remainder first, ties to the earlier one. */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map((x) => Math.floor(x + 1e-9));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - base[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left -= 1;
  }
  return base;
}

/** Every slice of every workweek touched by these days, with its share of that week's OT. */
export function overtimeSlices(days: readonly DayHours[], o: OtOptions): Slice[] {
  const slices = new Map<string, Slice>();
  for (const d of days) {
    const weekStart = weekStartOf(d.date);
    const s0 = { staffId: d.staffId, shopId: d.shopId, periodStart: o.periodOf(d.shopId, d.date), weekStart };
    const k = sliceKey(s0);
    const s = slices.get(k) ?? { ...s0, entity: o.entityOf(d.shopId), basis: 0, worked: 0, training: 0, pto: 0, ot: 0, locked: false };
    s.worked += d.worked;
    s.training += d.training;
    s.pto += d.pto;
    s.basis += d.worked + (o.trainingCountsTowardOt ? d.training : 0);
    slices.set(k, s);
  }
  const weeks = new Map<string, Slice[]>();
  for (const s of slices.values()) {
    const k = `${s.staffId}|${s.entity}|${s.weekStart}`;
    weeks.set(k, [...(weeks.get(k) ?? []), s]);
  }
  for (const list of weeks.values()) {
    list.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.shopId.localeCompare(b.shopId));
    const basis = list.reduce((a, s) => a + s.basis, 0);
    const ot = Math.max(0, basis - o.thresholdCenti);
    let open = list;
    let left = ot;
    if (o.locked) {
      for (const s of list) {
        const l = o.locked.get(sliceKey(s));
        if (l === undefined) continue;
        s.ot = l;
        s.locked = true;
        left -= l;
      }
      open = list.filter((s) => !s.locked);
    }
    largestRemainder(Math.max(0, left), open.map((s) => s.basis)).forEach((x, i) => (open[i].ot = Math.min(x, open[i].basis)));
  }
  return [...slices.values()];
}
