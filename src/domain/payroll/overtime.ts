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
  /** Of the training, what falls inside the same person's worked time at any shop: already in their clocked hours. */
  trainingOverlap?: number;
}

/** The parts of one interval inside a sorted list of non-overlapping ones. */
function within(e: Pick<TimeEntry, "startsAt" | "endsAt">, merged: readonly [number, number][]): { startsAt: Date; endsAt: Date }[] {
  const a = e.startsAt.getTime();
  const b = e.endsAt.getTime();
  return merged.flatMap(([s, t]) => (Math.max(a, s) < Math.min(b, t) ? [{ startsAt: new Date(Math.max(a, s)), endsAt: new Date(Math.min(b, t)) }] : []));
}

function mergedWorked(entries: readonly TimeEntry[]): Map<string, [number, number][]> {
  const by = new Map<string, [number, number][]>();
  for (const e of entries) if (e.kind === "worked") by.set(e.staffId, [...(by.get(e.staffId) ?? []), [e.startsAt.getTime(), e.endsAt.getTime()]]);
  for (const [k, list] of by) {
    list.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [s, t] of list) {
      const last = out[out.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], t);
      else out.push([s, t]);
    }
    by.set(k, out);
  }
  return by;
}

/** Hours per employee, shop and local date. Minutes are added up per day first, then turned into hundredths once. */
export function dailyHours(entries: readonly TimeEntry[]): DayHours[] {
  const minutes = new Map<string, { staffId: string; shopId: string; date: string; worked: number; training: number; pto: number; trainingOverlap: number }>();
  const add = (e: TimeEntry, parts: { date: string; minutes: number }[], kind: EntryKind | "trainingOverlap") => {
    for (const part of parts) {
      const k = `${e.staffId}|${e.shopId}|${part.date}`;
      const v = minutes.get(k) ?? { staffId: e.staffId, shopId: e.shopId, date: part.date, worked: 0, training: 0, pto: 0, trainingOverlap: 0 };
      v[kind] += part.minutes;
      minutes.set(k, v);
    }
  };
  const worked = mergedWorked(entries);
  for (const e of entries) {
    add(e, splitByLocalDay(e), e.kind);
    if (e.kind === "training") for (const piece of within(e, worked.get(e.staffId) ?? [])) add(e, splitByLocalDay(piece), "trainingOverlap");
  }
  return [...minutes.values()].map(({ trainingOverlap: overlap, ...v }) => {
    const training = minutesToCenti(v.training);
    const trainingOverlap = Math.min(training, minutesToCenti(overlap));
    return { ...v, worked: minutesToCenti(v.worked), training, pto: minutesToCenti(v.pto), ...(trainingOverlap ? { trainingOverlap } : {}) };
  });
}

/** C2: training counts toward the 40 only where it's on top of clocked hours, so no hour is counted twice. */
const trainingBasis = (d: Pick<DayHours, "training" | "trainingOverlap">, o: Pick<OtOptions, "trainingCountsTowardOt">) => (o.trainingCountsTowardOt ? d.training - (d.trainingOverlap ?? 0) : 0);

export interface OtOptions {
  /** Weekly threshold in centi-hours. 4000 = 40 hours. */
  thresholdCenti: number;
  /** C2: training hours on top of clocked hours count toward the weekly 40 (and carry OT share). Configurable until Charles answers Q11. */
  trainingCountsTowardOt: boolean;
  /** Which legal entity (FEIN) a shop belongs to; hours only add up within one. */
  entityOf: (shopId: string) => string;
  /** The pay period (its start date) a shop's calendar puts a local date in. */
  periodOf: (shopId: string, date: string) => string;
  /** OT already locked into a slice: `${staffId}|${shopId}|${periodStart}|${weekStart}` → centi-hours. */
  locked?: ReadonlyMap<string, number>;
  /**
   * Optional daily overtime: hours over this in one local day (across the entity's shops) are OT on
   * that day, and the weekly threshold then applies to the rest, so no hour is counted twice. Null or
   * unset: weekly only, the federal FLSA rule.
   */
  dailyThresholdCenti?: number | null;
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
  /** Of the training, the part inside clocked worked time. */
  trainingOverlap: number;
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
    const s = slices.get(k) ?? { ...s0, entity: o.entityOf(d.shopId), basis: 0, worked: 0, training: 0, trainingOverlap: 0, pto: 0, ot: 0, locked: false };
    s.worked += d.worked;
    s.training += d.training;
    s.trainingOverlap += d.trainingOverlap ?? 0;
    s.pto += d.pto;
    s.basis += d.worked + trainingBasis(d, o);
    slices.set(k, s);
  }
  const weeks = new Map<string, Slice[]>();
  for (const s of slices.values()) {
    const k = `${s.staffId}|${s.entity}|${s.weekStart}`;
    weeks.set(k, [...(weeks.get(k) ?? []), s]);
  }
  const daily = o.dailyThresholdCenti ? dailyOvertime(days, o, o.dailyThresholdCenti) : null;
  for (const list of weeks.values()) {
    list.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.shopId.localeCompare(b.shopId));
    if (daily) {
      shareWeekWithDaily(list, daily, o);
      continue;
    }
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

/** Each slice's daily OT: per person, entity and local day, the hours over the threshold, shared out to that day's shops. */
function dailyOvertime(days: readonly DayHours[], o: OtOptions, threshold: number): Map<string, number> {
  const byDay = new Map<string, DayHours[]>();
  for (const d of days) {
    const k = `${d.staffId}|${o.entityOf(d.shopId)}|${d.date}`;
    byDay.set(k, [...(byDay.get(k) ?? []), d]);
  }
  const out = new Map<string, number>();
  const basisOf = (d: DayHours) => d.worked + trainingBasis(d, o);
  for (const list of byDay.values()) {
    list.sort((a, b) => a.shopId.localeCompare(b.shopId));
    const excess = list.reduce((a, d) => a + basisOf(d), 0) - threshold;
    if (excess <= 0) continue;
    largestRemainder(excess, list.map(basisOf)).forEach((x, i) => {
      const d = list[i];
      const k = sliceKey({ staffId: d.staffId, shopId: d.shopId, periodStart: o.periodOf(d.shopId, d.date), weekStart: weekStartOf(d.date) });
      out.set(k, (out.get(k) ?? 0) + x);
    });
  }
  return out;
}

/** A week's OT with daily OT on: each slice keeps its own days' OT, and the weekly excess of the remaining hours is shared by those hours. */
function shareWeekWithDaily(list: Slice[], daily: ReadonlyMap<string, number>, o: OtOptions) {
  const dayOt = (s: Slice) => Math.min(daily.get(sliceKey(s)) ?? 0, s.basis);
  const basis = list.reduce((a, s) => a + s.basis, 0);
  const dailyTotal = list.reduce((a, s) => a + dayOt(s), 0);
  let left = dailyTotal + Math.max(0, basis - dailyTotal - o.thresholdCenti);
  let open = list;
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
  left = Math.max(0, left);
  for (const s of open) {
    s.ot = Math.min(dayOt(s), left);
    left -= s.ot;
  }
  largestRemainder(left, open.map((s) => s.basis - s.ot)).forEach((x, i) => (open[i].ot = Math.min(open[i].ot + x, open[i].basis)));
}
