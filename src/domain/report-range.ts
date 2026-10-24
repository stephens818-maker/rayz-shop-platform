import { payPeriodFor } from "./payroll";
import { LocalDate, addDays, todayLocal, weekdayOf } from "@/lib/time";

export const PRESETS: { id: string; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
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

export function presetRange(id: string, today: LocalDate = todayLocal()): { from: LocalDate; to: LocalDate } {
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (id) {
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
      const p = payPeriodFor(today);
      return { from: p.start, to: today < p.end ? today : p.end };
    }
    case "lastpayperiod": {
      const p = payPeriodFor(addDays(payPeriodFor(today).start, -1));
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
