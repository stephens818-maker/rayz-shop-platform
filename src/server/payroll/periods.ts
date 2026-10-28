import { periodByNumber, periodOf, periodByIndex, sameCalendar, type CalendarPeriod, type PayCalendar } from "@/domain/payroll/calendar";
import { PAYROLL_PRESETS, parsePayGroupPeriod, parsePayPeriodNumber, payGroupPeriodPreset, payPeriodNumberPreset } from "@/domain/report-range";
import { addDays, formatDate, isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { brandCalendar, ensurePayGroups } from "./groups";

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
 * The pay calendar "This pay period" and "Last pay period" follow for a set of shops: theirs when
 * they all share one (Dubuque alone gets Dubuque's), otherwise the brand's.
 */
export async function calendarForShops(shopIds: readonly string[]): Promise<PayCalendar> {
  const groups = (await ensurePayGroups()).filter((g) => shopIds.includes(g.shopId));
  if (groups.length && groups.every((g) => sameCalendar(g.calendar, groups[0].calendar))) return groups[0].calendar;
  return brandCalendar();
}

export interface PayPeriodOption {
  id: string;
  number: number;
  start: LocalDate;
  end: LocalDate;
  checkDate: LocalDate;
  current: boolean;
}

/** The specific pay periods to pick from, per pay calendar: shops sharing one calendar are one group, labelled with their names. */
export interface PayPeriodPickerGroup {
  payGroupId: string;
  label: string;
  shopIds: string[];
  periods: PayPeriodOption[];
}

/**
 * Every numbered pay period whose check falls this year or last, up to the one running now, newest
 * first, for each pay calendar the shops are on (Dubuque runs on its own).
 */
export async function payPeriodPicker(shopIds: readonly string[], today: LocalDate = todayLocal()): Promise<PayPeriodPickerGroup[]> {
  const groups = (await ensurePayGroups()).filter((g) => shopIds.includes(g.shopId));
  const out: (PayPeriodPickerGroup & { cal: PayCalendar })[] = [];
  for (const g of groups) {
    const same = out.find((o) => sameCalendar(o.cal, g.calendar));
    if (same) {
      same.shopIds.push(g.shopId);
      same.label = `${same.label}, ${g.shop}`;
      continue;
    }
    const cur = periodOf(g.calendar, today);
    const year = Number(cur.checkDate.slice(0, 4));
    const periods: PayPeriodOption[] = [];
    for (let i = cur.index; periods.length < 60; i--) {
      const p = periodByIndex(g.calendar, i);
      if (Number(p.checkDate.slice(0, 4)) < year - 1) break;
      if (p.number < 1) continue;
      periods.push({ id: payPeriodNumberPreset(g.id, Number(p.checkDate.slice(0, 4)), p.number), number: p.number, start: p.start, end: p.end, checkDate: p.checkDate, current: i === cur.index });
    }
    out.push({ payGroupId: g.id, label: g.shop, shopIds: [g.shopId], periods, cal: g.calendar });
  }
  return out.map(({ cal: _, ...g }) => g);
}

/** A specific pay period picked by number (`ppn:<pay group>:<year>:<number>`): its dates on that pay group's calendar, or null. */
export async function payPeriodByNumber(preset: string): Promise<{ id: string; from: LocalDate; to: LocalDate; payGroupId: string; number: number; label: string } | null> {
  const n = parsePayPeriodNumber(preset);
  if (!n) return null;
  const groups = await ensurePayGroups();
  const g = groups.find((x) => x.id === n.payGroupId);
  const p = g ? periodByNumber(g.calendar, n.year, n.number) : null;
  if (!g || !p) return null;
  const on = groups.filter((x) => sameCalendar(x.calendar, g.calendar));
  const where = [...(on.length < groups.length ? [on.map((x) => x.shop).join(", ")] : []), ...(n.year !== Number(todayLocal().slice(0, 4)) ? [String(n.year)] : [])];
  return { id: preset, from: p.start, to: p.end, payGroupId: g.id, number: p.number, label: `Pay period ${String(p.number).padStart(2, "0")}${where.length ? ` (${where.join(", ")})` : ""}` };
}

/** One pay group's current (the whole period holding today) or last pay period, on its own calendar: `ppg:<pay group>:current|last`, or null. */
export async function payGroupPeriod(preset: string, today: LocalDate = todayLocal()): Promise<{ id: string; from: LocalDate; to: LocalDate; payGroupId: string; label: string } | null> {
  const n = parsePayGroupPeriod(preset);
  if (!n) return null;
  const groups = await ensurePayGroups();
  const g = groups.find((x) => x.id === n.payGroupId);
  if (!g) return null;
  const cur = periodOf(g.calendar, today);
  const p = n.which === "current" ? cur : periodOf(g.calendar, addDays(cur.start, -1));
  const on = groups.filter((x) => sameCalendar(x.calendar, g.calendar));
  return { id: preset, from: p.start, to: p.end, payGroupId: g.id, label: `${n.which === "current" ? "Current" : "Last"} pay period (${on.map((x) => x.shop).join(", ")})` };
}

/**
 * The Payroll Report's date chips for a set of shops: current and last pay period (on the calendar
 * the shops share, else the brand's), this and last week, month to date; then each other pay
 * calendar's own current and last pay period (Dubuque runs on its own).
 */
export async function payrollPresetChips(shopIds: readonly string[], today: LocalDate = todayLocal()): Promise<{ id: string; label: string }[]> {
  const main = await calendarForShops(shopIds);
  const groups = (await ensurePayGroups()).filter((g) => shopIds.includes(g.shopId) && !sameCalendar(g.calendar, main));
  const own: { id: string; label: string }[] = [];
  const seen: PayCalendar[] = [];
  for (const g of groups) {
    if (seen.some((c) => sameCalendar(c, g.calendar))) continue;
    seen.push(g.calendar);
    for (const which of ["current", "last"] as const) {
      const p = await payGroupPeriod(payGroupPeriodPreset(g.id, which), today);
      if (p) own.push({ id: p.id, label: p.label });
    }
  }
  return [...PAYROLL_PRESETS, ...own];
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
