/**
 * How often a client comes in. Visits are the distinct local days with a completed appointment;
 * the cadence is the median of the gaps between the last CADENCE_GAPS + 1 of them, so one long
 * break (a summer away) or a quick touch-up doesn't move it. Two visit days give a cadence.
 * The SQL twin is `cadenceCtes` in server/visit-cadence.ts; both must agree.
 */
import { addDays, diffDays, localDateOf, type LocalDate } from "@/lib/time";

/** The most recent gaps the median reads. */
export const CADENCE_GAPS = 10;
/** A client becomes due this many days before their usual gap is up, when the rebook reminder goes out by default. */
export const DUE_LEAD_DAYS = 3;
/** Past the usual gap by more than this, a client is overdue: a week, or a quarter of the gap for long ones. */
export const overdueGraceDays = (cadence: number) => Math.max(7, cadence * 0.25);

export const VISIT_STATUSES = ["on_track", "due", "overdue"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = { on_track: "On track", due: "Due", overdue: "Overdue" };
export const VISIT_STATUS_TONE: Record<VisitStatus, "green" | "amber" | "red"> = { on_track: "green", due: "amber", overdue: "red" };

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Distinct local visit days, oldest first. */
export function visitDays(visits: readonly (Date | string | number)[]): LocalDate[] {
  return [...new Set(visits.map((v) => localDateOf(v)))].sort();
}

/** Median days between the recent visit days; null under two. */
export function cadenceDays(days: readonly LocalDate[]): number | null {
  const d = [...new Set(days)].sort().slice(-(CADENCE_GAPS + 1));
  if (d.length < 2) return null;
  return median(d.slice(1).map((x, i) => diffDays(x, d[i])));
}

/** "Every 3.5 weeks"; under two weeks in days. */
export function cadenceLabel(days: number): string {
  if (days < 13.5) {
    const n = Math.max(1, Math.round(days));
    return n === 1 ? "Every day" : `Every ${n} days`;
  }
  const weeks = Math.round((days / 7) * 2) / 2;
  return `Every ${weeks} weeks`;
}

/** Booked clients are on track; otherwise due from DUE_LEAD_DAYS before the usual gap, overdue past the grace. */
export function visitStatus(cadence: number | null, sinceDays: number | null, booked: boolean): VisitStatus | null {
  if (cadence === null || sinceDays === null) return null;
  if (booked || sinceDays < cadence - DUE_LEAD_DAYS) return "on_track";
  return sinceDays <= cadence + overdueGraceDays(cadence) ? "due" : "overdue";
}

export interface Cadence {
  visitDays: number;
  /** Median days between visits, or null under two visit days. */
  cadenceDays: number | null;
  label: string | null;
  lastVisit: LocalDate | null;
  sinceDays: number | null;
  /** Last visit plus the cadence. */
  nextExpected: LocalDate | null;
  booked: boolean;
  status: VisitStatus | null;
}

export function cadenceFromDays(days: readonly LocalDate[], today: LocalDate, booked: boolean): Cadence {
  const d = [...new Set(days)].sort();
  const last = d.at(-1) ?? null;
  const cadence = cadenceDays(d);
  const sinceDays = last ? diffDays(today, last) : null;
  return {
    visitDays: d.length,
    cadenceDays: cadence,
    label: cadence === null ? null : cadenceLabel(cadence),
    lastVisit: last,
    sinceDays,
    nextExpected: last && cadence !== null ? addDays(last, Math.round(cadence)) : null,
    booked,
    status: visitStatus(cadence, sinceDays, booked),
  };
}

/** From completed visits' start times. */
export const cadenceOf = (visits: readonly (Date | string | number)[], today: LocalDate, booked: boolean): Cadence => cadenceFromDays(visitDays(visits), today, booked);

export interface BarberCadence {
  staffId: string;
  name: string;
  visitDays: number;
  cadenceDays: number | null;
  label: string | null;
  lastVisit: LocalDate;
}

/** The cadence with each barber, most visits first; empty unless the client has seen two or more. */
export function cadenceByBarber(visits: readonly { at: Date | string | number; staffId: string; name: string }[]): BarberCadence[] {
  const by = new Map<string, { name: string; at: (Date | string | number)[] }>();
  for (const v of visits) {
    const b = by.get(v.staffId) ?? { name: v.name, at: [] };
    b.at.push(v.at);
    by.set(v.staffId, b);
  }
  if (by.size < 2) return [];
  return [...by.entries()]
    .map(([staffId, b]) => {
      const days = visitDays(b.at);
      const c = cadenceDays(days);
      return { staffId, name: b.name, visitDays: days.length, cadenceDays: c, label: c === null ? null : cadenceLabel(c), lastVisit: days.at(-1)! };
    })
    .sort((a, b) => b.visitDays - a.visitDays || b.lastVisit.localeCompare(a.lastVisit));
}
