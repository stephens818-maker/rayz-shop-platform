import { LocalDate, addDays, diffDays, endOfLocalDay, startOfLocalDay } from "@/lib/time";
import { DEFAULT_BRAND_CALENDAR, type PayCalendar } from "./payroll/calendar";

export { DEFAULT_BRAND_CALENDAR } from "./payroll/calendar";

/** What the brand-wide pay periods need of the brand's calendar (the payroll setting, edited in Payroll setup). */
export type BrandCalendar = Pick<PayCalendar, "anchorStart" | "periodDays">;

export interface PayPeriod {
  /** Sunday (inclusive). */
  start: LocalDate;
  /** Saturday (inclusive). */
  end: LocalDate;
  /** 0 = the period starting on the calendar's anchor; negative = earlier. */
  index: number;
  startsAt: Date;
  /** Exclusive instant: local midnight after `end` (DST-safe). */
  endsAt: Date;
}

function build(index: number, c: BrandCalendar): PayPeriod {
  const start = addDays(c.anchorStart, index * c.periodDays);
  const end = addDays(start, c.periodDays - 1);
  return { start, end, index, startsAt: startOfLocalDay(start), endsAt: endOfLocalDay(end) };
}

export function payPeriodFor(date: LocalDate, c: BrandCalendar = DEFAULT_BRAND_CALENDAR): PayPeriod {
  return build(Math.floor(diffDays(date, c.anchorStart) / c.periodDays), c);
}

export function payPeriodByIndex(index: number, c: BrandCalendar = DEFAULT_BRAND_CALENDAR): PayPeriod {
  return build(index, c);
}

/** Periods overlapping [from, to], oldest first. */
export function payPeriodsBetween(from: LocalDate, to: LocalDate, c: BrandCalendar = DEFAULT_BRAND_CALENDAR): PayPeriod[] {
  const first = payPeriodFor(from, c).index;
  const last = payPeriodFor(to, c).index;
  const out: PayPeriod[] = [];
  for (let i = first; i <= last; i++) out.push(build(i, c));
  return out;
}
