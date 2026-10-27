import { DEFAULT_BRAND_CALENDAR, payPeriodFor, type BrandCalendar } from "./payroll";
import { LocalDate, addDays, todayLocal, weekdayOf } from "@/lib/time";

export const PRESETS: { id: string; label: string }[] = [
  { id: "lastday", label: "Last business day" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
  { id: "4w", label: "Last 4 weeks" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "payperiod", label: "This pay period" },
  { id: "lastpayperiod", label: "Last pay period" },
  { id: "30d", label: "Last 30 days" },
  { id: "quarter", label: "This quarter" },
  { id: "lastquarter", label: "Last quarter" },
  { id: "ytd", label: "Year to date" },
];

/** The first day of the calendar quarter `date` falls in. */
export function quarterStart(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number);
  return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
}

const monthStart = (date: LocalDate) => `${date.slice(0, 7)}-01`;
const quarterEnd = (date: LocalDate) => addDays(quarterStart(addDays(quarterStart(date), 95)), -1);
const monthEnd = (date: LocalDate) => addDays(monthStart(addDays(monthStart(date), 32)), -1);

/**
 * The period a range is compared against: the whole quarter or month before for the quarter and
 * month presets or an exact calendar quarter or month, otherwise the same number of days just before.
 */
export function priorPeriod(from: LocalDate, to: LocalDate, preset?: string | null): { from: LocalDate; to: LocalDate } {
  const unit =
    preset === "quarter" || preset === "lastquarter"
      ? "quarter"
      : preset === "month" || preset === "lastmonth"
        ? "month"
        : from === quarterStart(from) && to === quarterEnd(from)
          ? "quarter"
          : from === monthStart(from) && to === monthEnd(from)
            ? "month"
            : null;
  const end = addDays(from, -1);
  if (unit === "quarter") return { from: quarterStart(end), to: end };
  if (unit === "month") return { from: monthStart(end), to: end };
  const len = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { from: addDays(from, -len), to: end };
}

/**
 * The last day the shops were open before `today`: yesterday, or Saturday on a Monday. Sundays are
 * always skipped, so a report opened on Monday morning shows Saturday's close, not an empty $0 day.
 */
export function lastBusinessDay(today: LocalDate = todayLocal(), closedWeekdays: readonly number[] = [0]): LocalDate {
  let d = addDays(today, -1);
  for (let i = 0; i < 7 && (weekdayOf(d) === 0 || closedWeekdays.includes(weekdayOf(d))); i++) d = addDays(d, -1);
  return d;
}

/** `cal` is the brand's pay calendar (Payroll setup), for the pay period presets. */
export function presetRange(id: string, today: LocalDate = todayLocal(), cal: BrandCalendar = DEFAULT_BRAND_CALENDAR): { from: LocalDate; to: LocalDate } {
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (id) {
    case "lastday": {
      const d = lastBusinessDay(today);
      return { from: d, to: d };
    }
    case "4w":
      return { from: addDays(today, -27), to: today };
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: addDays(today, -weekdayOf(today)), to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: monthStart, to: today };
    case "lastmonth": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case "payperiod": {
      const p = payPeriodFor(today, cal);
      return { from: p.start, to: today < p.end ? today : p.end };
    }
    case "lastpayperiod": {
      const p = payPeriodFor(addDays(payPeriodFor(today, cal).start, -1), cal);
      return { from: p.start, to: p.end };
    }
    case "quarter":
      return { from: quarterStart(today), to: today };
    case "lastquarter": {
      const end = addDays(quarterStart(today), -1);
      return { from: quarterStart(end), to: end };
    }
    case "ytd":
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: addDays(today, -6), to: today };
  }
}
