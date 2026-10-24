import { LocalDate, addDays, diffDays, endOfLocalDay, startOfLocalDay, weekdayOf } from "@/lib/time";

/** Bi-weekly pay periods end on Saturdays. This Saturday is the end of a known period. */
export const PAYROLL_ANCHOR_END: LocalDate = "2026-10-03";
export const PAYROLL_PERIOD_DAYS = 14;

export interface PayPeriod {
  /** Sunday (inclusive). */
  start: LocalDate;
  /** Saturday (inclusive). */
  end: LocalDate;
  /** 0 = the period ending on the anchor; negative = earlier. */
  index: number;
  startsAt: Date;
  /** Exclusive instant: local midnight after `end` (DST-safe). */
  endsAt: Date;
}

function build(index: number, anchorEnd: LocalDate): PayPeriod {
  const end = addDays(anchorEnd, index * PAYROLL_PERIOD_DAYS);
  const start = addDays(end, -(PAYROLL_PERIOD_DAYS - 1));
  return { start, end, index, startsAt: startOfLocalDay(start), endsAt: endOfLocalDay(end) };
}

export function payPeriodFor(date: LocalDate, anchorEnd: LocalDate = PAYROLL_ANCHOR_END): PayPeriod {
  if (weekdayOf(anchorEnd) !== 6) throw new Error("Payroll anchor must be a Saturday");
  const offset = diffDays(date, anchorEnd); // days after the anchor end
  const index = Math.ceil(offset / PAYROLL_PERIOD_DAYS) || 0;
  return build(index, anchorEnd);
}

export function payPeriodByIndex(index: number, anchorEnd: LocalDate = PAYROLL_ANCHOR_END): PayPeriod {
  return build(index, anchorEnd);
}

/** Periods overlapping [from, to], oldest first. */
export function payPeriodsBetween(from: LocalDate, to: LocalDate, anchorEnd: LocalDate = PAYROLL_ANCHOR_END): PayPeriod[] {
  const first = payPeriodFor(from, anchorEnd).index;
  const last = payPeriodFor(to, anchorEnd).index;
  const out: PayPeriod[] = [];
  for (let i = first; i <= last; i++) out.push(build(i, anchorEnd));
  return out;
}
