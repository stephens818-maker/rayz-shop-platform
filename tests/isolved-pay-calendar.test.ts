import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND_CALENDAR, periodOf, periodStarting, type PayCalendar } from "@/domain/payroll/calendar";
import {
  MAX_EXTENSION_PERIODS,
  SCHEDULE_PERIOD_DAYS,
  extendSchedule,
  parseScheduleCsv,
  scheduleCode,
  scheduleKey,
  scheduleProblems,
  type ScheduleRow,
} from "@/domain/payroll/pay-schedule";
import { addDays, diffDays, weekdayOf } from "@/lib/time";

const root = join(__dirname, "..");
const csv = readFileSync(join(root, "drizzle/seed/isolved-pay-calendar.csv"), "utf8");
const rows = parseScheduleCsv(csv);
const byGroup = (g: string) => rows.filter((r) => r.group === g).sort((a, b) => a.start.localeCompare(b.start));
const SHARED = ["B - Rock Island", "C - Moline", "D - Utica", "E - Kimberly", "F - Silvis", "G - Coralville", "LeClaire"];
const DUBUQUE: PayCalendar = { anchorStart: "2026-10-04", anchorNumber: 1, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };
const withDates = (c: PayCalendar, list: readonly ScheduleRow[]): PayCalendar => ({ ...c, dates: Object.fromEntries(list.map((r) => [r.start, { checkDate: r.checkDate, submitBy: r.runDate }])) });

describe("iSolved's Payroll Run Schedule (drizzle/seed/isolved-pay-calendar.csv)", () => {
  it("reads all 243 periods of the eight pay groups", () => {
    expect(rows).toHaveLength(243);
    expect([...new Set(rows.map((r) => r.group))].sort()).toEqual([...SHARED, "Dubuque"].sort());
    for (const g of SHARED) expect(byGroup(g)).toHaveLength(31);
    expect(byGroup("Dubuque")).toHaveLength(26);
  });

  it("every period is 14 days, Sunday to Saturday, with no gaps or overlaps in any pay group", () => {
    expect(scheduleProblems(rows)).toEqual([]);
    for (const g of [...SHARED, "Dubuque"]) {
      const list = byGroup(g);
      list.forEach((r, i) => {
        expect(diffDays(r.end, r.start) + 1, `${g} ${r.start}`).toBe(SCHEDULE_PERIOD_DAYS);
        expect(weekdayOf(r.start), `${g} ${r.start}`).toBe(0);
        expect(weekdayOf(r.end), `${g} ${r.end}`).toBe(6);
        if (i > 0) expect(r.start, `${g} after ${list[i - 1].end}`).toBe(addDays(list[i - 1].end, 1));
      });
    }
  });

  it("the shared calendar runs from 2026 period 23 (10/18–10/31, check 11/6) through 2027 period 26, run Wednesday and paid Friday", () => {
    const ri = byGroup("B - Rock Island");
    expect(ri[0]).toMatchObject({ number: 23, start: "2026-10-18", end: "2026-10-31", runDate: "2026-11-04", checkDate: "2026-11-06" });
    expect(ri.at(-1)).toMatchObject({ number: 26, checkDate: "2027-12-31" });
    for (const r of ri.filter((x) => !x.note)) {
      expect(weekdayOf(r.runDate), r.start).toBe(3);
      expect(weekdayOf(r.checkDate), r.start).toBe(5);
    }
    const shape = (g: string) => byGroup(g).map(({ group: _g, ...r }) => r);
    for (const g of SHARED) expect(shape(g), g).toEqual(shape("B - Rock Island"));
  });

  it("Dubuque has the same dates numbered its own way, scheduled through the period ending 10/2/2027", () => {
    const dbq = byGroup("Dubuque");
    const ri = new Map(byGroup("B - Rock Island").map((r) => [r.start, r]));
    expect(dbq[0]).toMatchObject({ number: 1, start: "2026-10-04", checkDate: "2026-10-23" });
    expect(dbq.at(-1)).toMatchObject({ number: 20, end: "2027-10-02" });
    for (const r of dbq.filter((x) => ri.has(x.start))) expect({ ...r, group: "", number: 0 }).toEqual({ ...ri.get(r.start)!, group: "", number: 0 });
    expect(dbq.find((r) => r.start === "2026-10-18")!.number).not.toBe(ri.get("2026-10-18")!.number);
  });

  it("one holiday shift: 2026 period 27 runs Tuesday 12/29 and pays Thursday 12/31", () => {
    const moved = rows.filter((r) => r.note);
    expect(new Set(moved.map((r) => r.start))).toEqual(new Set(["2026-12-13"]));
    for (const r of moved) {
      expect(r).toMatchObject({ start: "2026-12-13", end: "2026-12-26", runDate: "2026-12-29", checkDate: "2026-12-31" });
      expect([weekdayOf(r.runDate), weekdayOf(r.checkDate)]).toEqual([2, 4]);
    }
    expect(byGroup("B - Rock Island").find((r) => r.start === "2026-12-13")!.number).toBe(27);
    expect(byGroup("Dubuque").find((r) => r.start === "2026-12-13")!.number).toBe(6);
  });

  it("the pay calendars, with the holiday's dates stored, give every period iSolved's number, run date and check date", () => {
    const check = (c: PayCalendar, list: readonly ScheduleRow[]) => {
      const cal = withDates(c, list.filter((r) => r.note));
      for (const r of list) expect(periodStarting(cal, r.start), `${r.group} ${r.start}`).toMatchObject({ end: r.end, number: r.number, checkDate: r.checkDate, submitBy: r.runDate });
    };
    for (const g of SHARED) check(DEFAULT_BRAND_CALENDAR, byGroup(g));
    check(DUBUQUE, byGroup("Dubuque"));
    // Without the stored holiday, 12/13's Friday check (1/1/2027) would make it 2027 period 1 and shift every 2027 number.
    expect(periodOf(DEFAULT_BRAND_CALENDAR, "2026-12-13").number).toBe(1);
  });

  it("the migration seeds exactly the file's rows", () => {
    const sql = readFileSync(join(root, "drizzle/core_0149_pay_schedule.sql"), "utf8");
    const values = [...sql.matchAll(/^\t\('([^']+)', (\d+), '([\d-]+)', '([\d-]+)', '([\d-]+)', '([\d-]+)', (NULL|'(?:[^']|'')*')\)[,;]?$/gm)].map((m) => ({
      group: m[1],
      number: Number(m[2]),
      start: m[3],
      end: m[4],
      runDate: m[5],
      checkDate: m[6],
      note: m[7] === "NULL" ? null : m[7].slice(1, -1).replace(/''/g, "'"),
    }));
    expect(values).toEqual(rows);
    const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("core_0149_pay_schedule");
  });

  it("codes and keys: B - Rock Island is code B, the shop Rock Island; LeClaire is Le Claire; Dubuque has no code", () => {
    expect([scheduleCode("B - Rock Island"), scheduleKey("B - Rock Island"), scheduleKey("Rock Island")]).toEqual(["B", "rockisland", "rockisland"]);
    expect([scheduleCode("LeClaire"), scheduleKey("LeClaire"), scheduleKey("Le Claire")]).toEqual([null, "leclaire", "leclaire"]);
    expect([scheduleCode("Dubuque"), scheduleKey("Dubuque")]).toEqual([null, "dubuque"]);
    expect([...new Set(rows.map((r) => scheduleCode(r.group)).filter(Boolean))].sort()).toEqual(["B", "C", "D", "E", "F", "G"]);
  });

  it("the validator catches a gap, an overlap, a period not Sunday to Saturday, a wrong length and a numbering slip", () => {
    const ri = byGroup("B - Rock Island");
    const gap = ri.filter((_, i) => i !== 3);
    expect(scheduleProblems(gap).join(" ")).toMatch(/a gap after period 25/);
    const overlap = ri.map((r, i) => (i === 4 ? { ...r, start: addDays(r.start, -7), end: addDays(r.end, -7) } : r));
    expect(scheduleProblems(overlap).join(" ")).toMatch(/overlaps period 26/);
    const monday = ri.map((r, i) => (i === 0 ? { ...r, start: addDays(r.start, 1), end: addDays(r.end, 1) } : r));
    expect(scheduleProblems(monday).join(" ")).toMatch(/doesn't start on a Sunday/);
    const long = ri.map((r, i) => (i === ri.length - 1 ? { ...r, end: addDays(r.end, 7) } : r));
    expect(scheduleProblems(long).join(" ")).toMatch(/21 days, not 14/);
    const slip = ri.map((r, i) => (i === 10 ? { ...r, number: r.number + 1 } : r));
    expect(scheduleProblems(slip).join(" ")).toMatch(/numbered \d+, expected \d+/);
    expect(scheduleProblems(rows.map((r) => (r.group === "Dubuque" && r.number === 20 ? { ...r, runDate: addDays(r.end, -1) } : r))).join(" ")).toMatch(/runs before the period ends/);
  });

  it("extending past the file's end carries the pattern on: Dubuque from 10/3/2027, numbered on and reset in January", () => {
    const dbq = byGroup("Dubuque");
    const add = extendSchedule(dbq.at(-1)!, "2028-01-31", { runOffsetDays: 4, checkOffsetDays: 6 });
    expect(add[0]).toMatchObject({ group: "Dubuque", number: 21, start: "2027-10-03", end: "2027-10-16", runDate: "2027-10-20", checkDate: "2027-10-22", note: null });
    expect(add.map((r) => r.number)).toEqual([21, 22, 23, 24, 25, 26, 1, 2, 3]);
    expect(add.at(-1)!.start <= "2028-01-31").toBe(true);
    expect(scheduleProblems([...dbq, ...add])).toEqual([]);
    const cal = withDates(DUBUQUE, dbq.filter((r) => r.note));
    for (const r of add) expect(periodStarting(cal, r.start), r.start).toMatchObject({ number: r.number, checkDate: r.checkDate, submitBy: r.runDate });
    expect(extendSchedule(dbq.at(-1)!, "2027-10-02", { runOffsetDays: 4, checkOffsetDays: 6 })).toEqual([]);
    expect(extendSchedule(dbq.at(-1)!, "2031-01-01", { runOffsetDays: 4, checkOffsetDays: 6 })).toHaveLength(MAX_EXTENSION_PERIODS);
  });

  it("a period past the schedule's end is marked, and one inside it isn't", () => {
    const cal: PayCalendar = { ...withDates(DUBUQUE, byGroup("Dubuque").filter((r) => r.note)), scheduledThrough: "2027-10-02" };
    expect(periodOf(cal, "2027-10-01").beyondSchedule).toBe(false);
    expect(periodOf(cal, "2027-10-05")).toMatchObject({ start: "2027-10-03", number: 21, beyondSchedule: true });
    expect(periodOf(DUBUQUE, "2027-10-05").beyondSchedule).toBe(false);
  });

  it("reading refuses a file that isn't iSolved's schedule", () => {
    expect(() => parseScheduleCsv("group,number\nB,1")).toThrow(/Expected the columns/);
    expect(() => parseScheduleCsv(`${csv.split("\n")[0]}\nB - Rock Island,23,2026-10-18,2026-10-31,2026-11-04`)).toThrow(/expected 7 columns/);
    expect(() => parseScheduleCsv(`${csv.split("\n")[0]}\nB - Rock Island,x,2026-10-18,2026-10-31,2026-11-04,2026-11-06,`)).toThrow(/whole period number/);
  });
});
