import { addDays, diffDays, isValidLocalDate, weekdayOf, type LocalDate } from "@/lib/time";

/**
 * iSolved's Payroll Run Schedule: each pay group's official pay periods, with iSolved's period
 * number, the run date (hours due in iSolved) and the check date. Loaded from iSolved's export
 * (`drizzle/seed/isolved-pay-calendar.csv`, migration `core_0149`) and extended by an admin past its
 * end. The pay calendar's rule fills in the rest of history and the dates between.
 */
export interface ScheduleRow {
  /** As iSolved shows it, e.g. "B - Rock Island" or "Dubuque". */
  group: string;
  number: number;
  start: LocalDate;
  end: LocalDate;
  runDate: LocalDate;
  checkDate: LocalDate;
  note: string | null;
}

export const SCHEDULE_HEADERS = ["pay_group", "period_number", "period_begin", "period_end", "run_date", "check_date", "holiday_note"] as const;
export const SCHEDULE_PERIOD_DAYS = 14;
/** An admin extends a schedule by at most a year of bi-weekly periods at a time. */
export const MAX_EXTENSION_PERIODS = 27;

/** iSolved's pay group code in front of the name ("B - Rock Island" is B), or null. */
export const scheduleCode = (group: string): string | null => /^([A-Z0-9]{1,4}) - /.exec(group)?.[1] ?? null;
/** The shop a schedule group is, as the letters of its name: "B - Rock Island" and "Rock Island" are both rockisland. */
export const scheduleKey = (group: string): string => group.replace(/^[A-Z0-9]{1,4} - /, "").toLowerCase().replace(/[^a-z]/g, "");

function csvCells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cell);
      cell = "";
    } else cell += c;
  }
  out.push(cell);
  return out;
}

/** Reads iSolved's schedule export. Throws on a wrong header, a short row or a bad number or date. */
export function parseScheduleCsv(text: string): ScheduleRow[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  const head = csvCells(lines[0] ?? "").map((h) => h.trim());
  if (head.join(",") !== SCHEDULE_HEADERS.join(",")) throw new Error(`Expected the columns ${SCHEDULE_HEADERS.join(", ")}.`);
  return lines.slice(1).map((line, i) => {
    const c = csvCells(line).map((x) => x.trim());
    if (c.length !== SCHEDULE_HEADERS.length) throw new Error(`Row ${i + 2}: expected ${SCHEDULE_HEADERS.length} columns, found ${c.length}.`);
    const [group, num, start, end, runDate, checkDate, note] = c;
    const number = Number(num);
    if (!group || !Number.isInteger(number) || ![start, end, runDate, checkDate].every(isValidLocalDate)) throw new Error(`Row ${i + 2}: a pay group, a whole period number and four dates are needed.`);
    return { group, number, start, end, runDate, checkDate, note: note || null };
  });
}

const year = (d: LocalDate) => d.slice(0, 4);

/**
 * What's wrong with a schedule, per pay group: every period 14 days, Sunday to Saturday, each one
 * starting the day after the last ended (no gaps or overlaps); run on or after the period's last day
 * and the check on or after the run, within 31 days; and numbered 1, 2, 3 … in each check-date year.
 */
export function scheduleProblems(rows: readonly ScheduleRow[]): string[] {
  const out: string[] = [];
  const byGroup = new Map<string, ScheduleRow[]>();
  for (const r of rows) byGroup.set(scheduleKey(r.group), [...(byGroup.get(scheduleKey(r.group)) ?? []), r]);
  for (const list of byGroup.values()) {
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    sorted.forEach((r, i) => {
      const at = `${r.group} period ${r.number} (${r.start})`;
      if (diffDays(r.end, r.start) !== SCHEDULE_PERIOD_DAYS - 1) out.push(`${at}: ${diffDays(r.end, r.start) + 1} days, not ${SCHEDULE_PERIOD_DAYS}.`);
      if (weekdayOf(r.start) !== 0) out.push(`${at}: doesn't start on a Sunday.`);
      if (weekdayOf(r.end) !== 6) out.push(`${at}: doesn't end on a Saturday.`);
      if (r.runDate < r.end) out.push(`${at}: runs before the period ends.`);
      if (r.checkDate < r.runDate) out.push(`${at}: the check is before the run.`);
      if (diffDays(r.checkDate, r.end) > 31) out.push(`${at}: the check is more than 31 days after the period ends.`);
      const prev = sorted[i - 1];
      if (!prev) {
        if (r.number < 1) out.push(`${at}: period numbers start at 1.`);
        return;
      }
      if (r.start <= prev.end) out.push(`${at}: overlaps period ${prev.number} (${prev.start} – ${prev.end}).`);
      else if (r.start !== addDays(prev.end, 1)) out.push(`${at}: a gap after period ${prev.number}, which ends ${prev.end}.`);
      const want = year(r.checkDate) === year(prev.checkDate) ? prev.number + 1 : 1;
      if (r.number !== want) out.push(`${at}: numbered ${r.number}, expected ${want}.`);
    });
  }
  return out;
}

/**
 * The next periods of a pay group's schedule on its repeating pattern (14 days, run and check a set
 * number of days after the period ends), starting the day after its last period, for each period
 * that starts on or before `through`. Numbers carry on from the last and restart at 1 when the
 * check falls in a new year. Holidays aren't known ahead: those dates are moved once iSolved posts them.
 */
export function extendSchedule(last: ScheduleRow, through: LocalDate, o: { runOffsetDays: number; checkOffsetDays: number }): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  let prev = last;
  for (let start = addDays(last.end, 1); start <= through && out.length < MAX_EXTENSION_PERIODS; start = addDays(start, SCHEDULE_PERIOD_DAYS)) {
    const end = addDays(start, SCHEDULE_PERIOD_DAYS - 1);
    const checkDate = addDays(end, o.checkOffsetDays);
    const r: ScheduleRow = { group: last.group, number: year(checkDate) === year(prev.checkDate) ? prev.number + 1 : 1, start, end, runDate: addDays(end, o.runOffsetDays), checkDate, note: null };
    out.push(r);
    prev = r;
  }
  return out;
}
