import type { DayHours } from "./overtime";

/**
 * ACA hours of service (IRS look-back measurement method). Separate from the brand's own
 * full-time line in Payroll setup (32 hours a week by default): the ACA counts every paid hour,
 * worked, training and paid time off, and treats 130 hours in a calendar month as full time. The
 * CPA and iSolved decide coverage and the 1095-C; this only counts the hours.
 */
export const ACA_MONTHLY_HOURS = 130;
/** A part-time employee's hours count toward full-time equivalents up to this many a month. */
export const ACA_FTE_MONTHLY_CAP = 120;
export const ACA_MEASUREMENT_MONTHS = [3, 6, 12] as const;
export type AcaMeasurement = (typeof ACA_MEASUREMENT_MONTHS)[number];
export const ACA_DEFAULT_MONTHS: AcaMeasurement = 12;

export type AcaStatus = "full_time" | "part_time";
export const ACA_STATUS_LABEL: Record<AcaStatus, string> = { full_time: "Full time (ACA)", part_time: "Under 130 a month" };

export function acaMonths(v: string | undefined): AcaMeasurement {
  const n = Number(v);
  return (ACA_MEASUREMENT_MONTHS as readonly number[]).includes(n) ? (n as AcaMeasurement) : ACA_DEFAULT_MONTHS;
}

/** Centi-hours of service in one day row: training inside clocked time is already in the worked hours. */
export function serviceCenti(d: Pick<DayHours, "worked" | "training" | "pto" | "trainingOverlap">): number {
  return d.worked + d.pto + Math.max(0, d.training - (d.trainingOverlap ?? 0));
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "YYYY-MM" of each of the `count` calendar months ending with the last full month on or before `to`. */
export function measurementMonths(to: string, count: number): string[] {
  let y = Number(to.slice(0, 4));
  let m = Number(to.slice(5, 7));
  if (Number(to.slice(8, 10)) < lastDayOf(y, m)) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    out.unshift(`${y}-${pad(m)}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export const monthFirstDay = (month: string) => `${month}-01`;
export const monthLastDay = (month: string) => `${month}-${pad(lastDayOf(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`;

export interface AcaRow {
  staffId: string;
  /** Hours of service per month, in the order of `months`; null before the month they were hired. */
  monthly: (number | null)[];
  /** Months counted: from the hire month (or the first month) to the end. */
  counted: number;
  average: number;
  monthsAt130: number;
  status: AcaStatus;
}

/**
 * Each person's hours of service per month, at every shop, and whether they average 130 or more
 * over the months counted. Someone hired during the window is measured from their hire month.
 */
export function acaRows(days: readonly DayHours[], staffIds: readonly string[], months: readonly string[], hireMonth: ReadonlyMap<string, string | null> = new Map()): AcaRow[] {
  const index = new Map(months.map((m, i) => [m, i]));
  const centi = new Map<string, number[]>(staffIds.map((id) => [id, months.map(() => 0)]));
  for (const d of days) {
    const row = centi.get(d.staffId);
    const i = index.get(d.date.slice(0, 7));
    if (row && i !== undefined) row[i] += serviceCenti(d);
  }
  return staffIds.map((staffId) => {
    const hired = hireMonth.get(staffId) ?? null;
    const cents = centi.get(staffId)!.map((c, i) => (hired && months[i] < hired ? null : Math.round(c)));
    const counted = cents.filter((c): c is number => c !== null);
    const total = counted.reduce((a, c) => a + c, 0);
    return {
      staffId,
      monthly: cents.map((c) => (c === null ? null : c / 100)),
      counted: counted.length,
      // Floored, so an average just under the line never shows as 130.
      average: counted.length ? Math.floor(total / counted.length) / 100 : 0,
      monthsAt130: counted.filter((c) => c >= ACA_MONTHLY_HOURS * 100).length,
      status: counted.length && total >= ACA_MONTHLY_HOURS * 100 * counted.length ? "full_time" : "part_time",
    };
  });
}

/** Per month: full-time employees plus full-time equivalents (part-time hours, each capped at 120, over 120). */
export function fteByMonth(rows: readonly AcaRow[], months: readonly string[]): { month: string; fullTime: number; fte: number; total: number }[] {
  return months.map((month, i) => {
    const hours = rows.map((r) => r.monthly[i]).filter((h): h is number => h !== null && h > 0);
    const fullTime = hours.filter((h) => h >= ACA_MONTHLY_HOURS).length;
    const fte = Math.round((hours.filter((h) => h < ACA_MONTHLY_HOURS).reduce((a, h) => a + Math.min(h, ACA_FTE_MONTHLY_CAP), 0) / ACA_FTE_MONTHLY_CAP) * 100) / 100;
    return { month, fullTime, fte, total: Math.round((fullTime + fte) * 100) / 100 };
  });
}
