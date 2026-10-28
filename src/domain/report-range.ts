import { DEFAULT_BRAND_CALENDAR, payPeriodFor, type BrandCalendar } from "./payroll";
import { LocalDate, addDays, formatDate, todayLocal, weekdayOf } from "@/lib/time";

export const PRESETS: { id: string; label: string }[] = [
  { id: "lastday", label: "Last business day" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "lastweek", label: "Last week" },
  { id: "7d", label: "Last 7 days" },
  { id: "4w", label: "Last 4 weeks" },
  { id: "month", label: "Month to date" },
  { id: "lastmonth", label: "Last month" },
  { id: "payperiod", label: "This pay period" },
  { id: "lastpayperiod", label: "Last pay period" },
  { id: "30d", label: "Last 30 days" },
  { id: "quarter", label: "Quarter to date" },
  { id: "lastquarter", label: "Last quarter" },
  { id: "ytd", label: "Year to date" },
];

/** The ranges every report offers, in this order; a report may add its own after them. A specific pay period and custom dates are picked beside them. */
export const STANDARD_PRESET_IDS = ["today", "yesterday", "week", "lastweek", "payperiod", "lastpayperiod", "month", "lastmonth", "quarter", "ytd"] as const;
export const STANDARD_PRESETS: { id: string; label: string }[] = STANDARD_PRESET_IDS.map((id) => PRESETS.find((p) => p.id === id)!);

/** Report dates are calendar days in the shops' time zone. */
export const RANGE_TIME_ZONE = "America/Chicago";
export const RANGE_TIME_ZONE_LABEL = "Central time (America/Chicago)";

/** A specific pay period by its iSolved number on one pay group's calendar: `ppn:<pay group id>:<check year>:<number>`. */
export const PAY_PERIOD_NUMBER_PRESET = "ppn:";
export const payPeriodNumberPreset = (payGroupId: string, year: number, number: number) => `${PAY_PERIOD_NUMBER_PRESET}${payGroupId}:${year}:${number}`;
export function parsePayPeriodNumber(id: string | null | undefined): { payGroupId: string; year: number; number: number } | null {
  const m = id?.match(/^ppn:([0-9a-f-]{36}):(\d{4}):(\d{1,4})$/i);
  return m ? { payGroupId: m[1], year: Number(m[2]), number: Number(m[3]) } : null;
}

/** "Oct 4, 2026", "Oct 4 – 17, 2026", "Oct 26 – Nov 8, 2026", "Dec 27, 2026 – Jan 9, 2027". */
export function rangeText(from: LocalDate, to: LocalDate): string {
  if (from === to) return formatDate(from, "MMM d, yyyy");
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${formatDate(from, "MMM d, yyyy")} – ${formatDate(to, "MMM d, yyyy")}`;
  return `${formatDate(from, "MMM d")} – ${formatDate(to, from.slice(0, 7) === to.slice(0, 7) ? "d, yyyy" : "MMM d, yyyy")}`;
}

/** A range as headers, exports and emails show it: "Last pay period: Oct 4 – 17, 2026", or the dates alone for custom dates. */
export const rangeHeading = (r: { from: LocalDate; to: LocalDate; label?: string | null }) => (r.label ? `${r.label}: ${rangeText(r.from, r.to)}` : rangeText(r.from, r.to));

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
    case "lastweek": {
      const start = addDays(today, -weekdayOf(today) - 7);
      return { from: start, to: addDays(start, 6) };
    }
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
