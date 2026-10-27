import { periodOf, periodByIndex, type CalendarPeriod } from "@/domain/payroll/calendar";
import { addDays, formatDate, isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { ensurePayGroups } from "./groups";

/** A pay period on one or more pay groups' calendars (shops on the same calendar share one). */
export interface PayPeriodRef {
  start: LocalDate;
  end: LocalDate;
  /** iSolved's period number on each calendar that has it, and its check date. */
  groups: { shopId: string; number: number; checkDate: LocalDate }[];
}

export const PAY_PERIOD_PRESET = "pp:";
/** The most periods a payroll report covers at once: a year of bi-weekly periods. */
export const MAX_REPORT_PERIODS = 27;

const presetId = (p: Pick<PayPeriodRef, "start" | "end">) => `${PAY_PERIOD_PRESET}${p.start}_${p.end}`;

/** "Oct 18 – 31", "Dec 27 – Jan 9". */
export const periodLabel = (p: Pick<PayPeriodRef, "start" | "end">) => `${formatDate(p.start, "MMM d")} – ${formatDate(p.end, p.start.slice(5, 7) === p.end.slice(5, 7) ? "d" : "MMM d")}`;

function merge(list: { shopId: string; p: CalendarPeriod }[]): PayPeriodRef[] {
  const map = new Map<string, PayPeriodRef>();
  for (const { shopId, p } of list) {
    if (p.number < 1) continue;
    const k = `${p.start}_${p.end}`;
    const r = map.get(k) ?? { start: p.start, end: p.end, groups: [] };
    r.groups.push({ shopId, number: p.number, checkDate: p.checkDate });
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start));
}

/** Every pay period, on any pay group's calendar, that ends in [from, to], oldest first. Capped at the last `MAX_REPORT_PERIODS`. */
export async function periodsEnding(from: LocalDate, to: LocalDate, shopIds?: readonly string[]): Promise<{ periods: PayPeriodRef[]; capped: boolean }> {
  const groups = (await ensurePayGroups()).filter((g) => !shopIds || shopIds.includes(g.shopId));
  const list: { shopId: string; p: CalendarPeriod }[] = [];
  for (const g of groups) {
    const first = periodOf(g.calendar, from);
    for (let i = first.index; ; i++) {
      const p = periodByIndex(g.calendar, i);
      if (p.end > to) break;
      if (p.end >= from) list.push({ shopId: g.shopId, p });
    }
  }
  const all = merge(list);
  return { periods: all.slice(-MAX_REPORT_PERIODS), capped: all.length > MAX_REPORT_PERIODS };
}

/** The pay periods around today, newest first: `back` ended ones and the one running now. */
export async function recentPayPeriods(today: LocalDate = todayLocal(), back = 6, shopIds?: readonly string[]): Promise<(PayPeriodRef & { current: boolean })[]> {
  const groups = (await ensurePayGroups()).filter((g) => !shopIds || shopIds.includes(g.shopId));
  const list: { shopId: string; p: CalendarPeriod }[] = [];
  for (const g of groups) {
    const cur = periodOf(g.calendar, today).index;
    for (let i = cur - back; i <= cur; i++) list.push({ shopId: g.shopId, p: periodByIndex(g.calendar, i) });
  }
  return merge(list)
    .filter((p) => p.start <= today)
    .reverse()
    .slice(0, back + 1)
    .map((p) => ({ ...p, current: p.start <= today && today <= p.end }));
}

/** Date chips for the payroll reports: the period running now, the recent ended ones, then the quarter and the year. */
export async function payPeriodPresets(today: LocalDate = todayLocal(), shopIds?: readonly string[]): Promise<{ id: string; label: string }[]> {
  const recent = await recentPayPeriods(today, 6, shopIds);
  return [
    ...recent.map((p) => ({ id: presetId(p), label: p.current ? `This period · ${periodLabel(p)}` : periodLabel(p) })),
    { id: "lastquarter", label: "Last quarter" },
    { id: "ytd", label: "Year to date" },
  ];
}

/**
 * The range a pay period chip stands for: `pp:<start>_<end>`, `pp:last` (the last period that has
 * ended) or `pp:current`. Null when it isn't one.
 */
export async function payPeriodRange(preset: string, today: LocalDate = todayLocal()): Promise<{ id: string; from: LocalDate; to: LocalDate } | null> {
  if (!preset.startsWith(PAY_PERIOD_PRESET)) return null;
  const rest = preset.slice(PAY_PERIOD_PRESET.length);
  if (rest === "last" || rest === "current") {
    const recent = await recentPayPeriods(today, 2);
    const p = rest === "current" ? (recent.find((x) => x.current) ?? recent[0]) : recent.find((x) => x.end < today);
    if (!p) return { id: preset, from: addDays(today, -13), to: today };
    return { id: presetId(p), from: p.start, to: p.end };
  }
  const [from, to] = rest.split("_");
  if (!from || !to || !isValidLocalDate(from) || !isValidLocalDate(to) || from > to) return null;
  return { id: preset, from, to };
}
