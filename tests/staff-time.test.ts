/**
 * Staff self-service time, the pure parts: recurring lunch occurrences (wall-clock across DST),
 * time off spans for whole and part days, the shop rules and their limits, who is working, off or
 * blocked on a day, and who may change blocks or decide time off.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAFF_TIME_RULES,
  cleanRules,
  noticeProblem,
  rulesProblem,
  selfBlockProblem,
  seriesOccurrences,
  seriesProblem,
  shopRules,
  staffDay,
  strictestRules,
  timeOffSpan,
  weekdaysLabel,
} from "@/domain/staff-time";
import { blockChangeDenied, timeOffDecisionDenied } from "@/server/auth/policy";
import { endOfLocalDay, localMinutesOf, startOfLocalDay, weekdayOf, zonedWallTime } from "@/lib/time";

const at = (date: string, min: number) => zonedWallTime(date, min).toJSDate();
const weekdayLunch = { weekdays: [1, 2, 3, 4, 5], startMin: 12 * 60, endMin: 12 * 60 + 30, startsOn: "2026-10-26", endsOn: null };

describe("recurring blocks", () => {
  it("every weekday 12:00–12:30 lands on Monday to Friday only", () => {
    const occ = seriesOccurrences(weekdayLunch, "2026-10-26", "2026-11-08");
    expect(occ.map((o) => o.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    for (const o of occ) {
      expect([1, 2, 3, 4, 5]).toContain(weekdayOf(o.date));
      expect([localMinutesOf(o.startsAt), localMinutesOf(o.endsAt)]).toEqual([720, 750]);
      expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(30 * 60_000);
    }
  });

  it("stays at 12:00 local across the fall-back and spring-forward changes", () => {
    const fall = seriesOccurrences(weekdayLunch, "2026-10-30", "2026-11-02");
    expect(fall.map((o) => o.startsAt.toISOString())).toEqual(["2026-10-30T17:00:00.000Z", "2026-11-02T18:00:00.000Z"]);
    const spring = seriesOccurrences({ ...weekdayLunch, startsOn: "2026-03-01" }, "2026-03-06", "2026-03-09");
    expect(spring.map((o) => o.startsAt.toISOString())).toEqual(["2026-03-06T18:00:00.000Z", "2026-03-09T17:00:00.000Z"]);
  });

  it("starts no earlier than its first day and stops at its last", () => {
    const occ = seriesOccurrences({ ...weekdayLunch, startsOn: "2026-10-28", endsOn: "2026-11-03" }, "2026-10-20", "2026-12-31");
    expect(occ[0].date).toBe("2026-10-28");
    expect(occ.at(-1)!.date).toBe("2026-11-03");
    expect(occ).toHaveLength(5);
  });

  it("checks the pattern and labels the days", () => {
    expect(seriesProblem(weekdayLunch)).toBeNull();
    expect(seriesProblem({ ...weekdayLunch, weekdays: [] })).toMatch(/at least one day/);
    expect(seriesProblem({ ...weekdayLunch, weekdays: [7] })).toMatch(/Sunday to Saturday/);
    expect(seriesProblem({ ...weekdayLunch, endMin: 12 * 60 })).toMatch(/after start/);
    expect(seriesProblem({ ...weekdayLunch, endsOn: "2026-10-01" })).toMatch(/before the first/);
    expect(weekdaysLabel([5, 4, 3, 2, 1])).toBe("Weekdays");
    expect(weekdaysLabel([0, 6])).toBe("Weekends");
    expect(weekdaysLabel([2, 4])).toBe("Tue, Thu");
  });
});

describe("time off spans", () => {
  it("a single day and a range run midnight to midnight, local time", () => {
    expect(timeOffSpan({ fromDate: "2026-11-10", toDate: "2026-11-10", startMin: null, endMin: null })).toEqual({ startsAt: startOfLocalDay("2026-11-10"), endsAt: endOfLocalDay("2026-11-10"), allDay: true });
    const range = timeOffSpan({ fromDate: "2026-10-30", toDate: "2026-11-02", startMin: null, endMin: null });
    expect(range).toEqual({ startsAt: startOfLocalDay("2026-10-30"), endsAt: endOfLocalDay("2026-11-02"), allDay: true });
    // Four days with the fall-back hour in the middle.
    if ("startsAt" in range) expect((range.endsAt.getTime() - range.startsAt.getTime()) / 3_600_000).toBe(97);
  });

  it("part of a day covers only those hours", () => {
    expect(timeOffSpan({ fromDate: "2026-11-10", toDate: "2026-11-10", startMin: 14 * 60, endMin: 17 * 60 })).toEqual({ startsAt: at("2026-11-10", 840), endsAt: at("2026-11-10", 1020), allDay: false });
  });

  it("refuses part-day ranges, half-given times, backwards and over-long requests", () => {
    const problem = (r: Parameters<typeof timeOffSpan>[0]) => ("problem" in timeOffSpan(r) ? (timeOffSpan(r) as { problem: string }).problem : null);
    expect(problem({ fromDate: "2026-11-10", toDate: "2026-11-11", startMin: 600, endMin: 700 })).toMatch(/Part of a day is one day/);
    expect(problem({ fromDate: "2026-11-10", toDate: "2026-11-10", startMin: 600, endMin: null })).toMatch(/start and an end/);
    expect(problem({ fromDate: "2026-11-10", toDate: "2026-11-10", startMin: 700, endMin: 600 })).toMatch(/after start/);
    expect(problem({ fromDate: "2026-11-10", toDate: "2026-11-09", startMin: null, endMin: null })).toMatch(/before the first/);
    expect(problem({ fromDate: "2026-11-01", toDate: "2027-01-15", startMin: null, endMin: null })).toMatch(/at most 60 days/);
  });
});

describe("rules and limits", () => {
  it("shop rules sit on the brand's, and junk is dropped", () => {
    expect(shopRules({ maxLunchMin: 45 }, { timeOffApproval: "auto", minNoticeDays: "3" })).toEqual({ ...DEFAULT_STAFF_TIME_RULES, maxLunchMin: 45, timeOffApproval: "auto" });
    expect(cleanRules({ maxLunchMin: 1000, maxBlockMin: 60, other: 1 })).toEqual({ maxBlockMin: 60 });
    expect(rulesProblem({ maxLunchMin: 2 })).toMatch(/5 to 240/);
    expect(rulesProblem({ timeOffApproval: "sometimes" })).toMatch(/automatic or manager/);
    expect(rulesProblem({ minNoticeDays: 14 })).toBeNull();
  });

  it("time across several shops follows the strictest shop", () => {
    const loose = { timeOffApproval: "auto", maxLunchMin: 60, maxBlockMin: 120, minNoticeDays: 3 } as const;
    const strict = { timeOffApproval: "manager", maxLunchMin: 30, maxBlockMin: 90, minNoticeDays: 14 } as const;
    expect(strictestRules([loose, strict])).toEqual(strict);
    expect(strictestRules([loose]).timeOffApproval).toBe("auto");
    expect(strictestRules([])).toEqual(DEFAULT_STAFF_TIME_RULES);
  });

  it("caps a barber's own lunch and other blocks", () => {
    const r = { ...DEFAULT_STAFF_TIME_RULES, maxLunchMin: 45, maxBlockMin: 90 };
    expect(selfBlockProblem(r, "lunch", 45)).toBeNull();
    expect(selfBlockProblem(r, "lunch", 60)).toMatch(/at most 45 minutes/);
    expect(selfBlockProblem(r, "break", 90)).toBeNull();
    expect(selfBlockProblem(r, "personal", 120)).toMatch(/at most 90 minutes/);
    expect(selfBlockProblem(r, "lunch", 0)).toMatch(/after start/);
  });

  it("needs the minimum notice, except for sick time", () => {
    const r = { ...DEFAULT_STAFF_TIME_RULES, minNoticeDays: 7 };
    expect(noticeProblem(r, "vacation", "2026-10-30", "2026-10-23")).toBeNull();
    expect(noticeProblem(r, "vacation", "2026-10-29", "2026-10-23")).toMatch(/7 days' notice.*2026-10-30/);
    expect(noticeProblem(r, "sick", "2026-10-23", "2026-10-23")).toBeNull();
    expect(noticeProblem(r, "sick", "2026-10-22", "2026-10-23")).toMatch(/past/);
    expect(noticeProblem({ ...r, minNoticeDays: 0 }, "personal", "2026-10-23", "2026-10-23")).toBeNull();
  });
});

describe("who is working, off and blocked", () => {
  const date = "2026-11-10";
  const hours = [{ startMin: 9 * 60, endMin: 17 * 60 }];
  const lunch = { startsAt: at(date, 720), endsAt: at(date, 750), category: "lunch", kind: "block", reason: "Lunch" };

  it("working with a lunch: blocked minutes, no time off", () => {
    const d = staffDay({ date, spans: hours, blocks: [lunch], pending: [] });
    expect(d).toMatchObject({ status: "working", scheduledMin: 480, offMin: 0, blockedMin: 30, pending: false, hasTimeOff: false });
    expect(d.blocks).toEqual([{ category: "lunch", reason: "Lunch", startMin: 720, endMin: 750 }]);
  });

  it("part of the day off is partly off; the lunch inside it isn't counted twice", () => {
    const afternoon = { startsAt: at(date, 12 * 60), endsAt: at(date, 17 * 60), category: "time_off", kind: "block", reason: "Personal" };
    expect(staffDay({ date, spans: hours, blocks: [lunch, afternoon], pending: [] })).toMatchObject({ status: "partly_off", offMin: 300, blockedMin: 0, hasTimeOff: true });
  });

  it("a whole day off, and a day off with no hours there, are off; a pending request shows", () => {
    const day = { startsAt: startOfLocalDay(date), endsAt: endOfLocalDay(date), category: "time_off", kind: "day_off", reason: "Vacation" };
    expect(staffDay({ date, spans: hours, blocks: [day], pending: [] })).toMatchObject({ status: "off", offMin: 480 });
    expect(staffDay({ date, spans: [], blocks: [day], pending: [] })).toMatchObject({ status: "off", offMin: 24 * 60 });
    expect(staffDay({ date, spans: [], blocks: [], pending: [] }).status).toBe("not_scheduled");
    expect(staffDay({ date, spans: hours, blocks: [], pending: [day] })).toMatchObject({ status: "working", pending: true });
  });
});

describe("who may block time and decide time off", () => {
  const coralville = "shop-cv";
  const moline = "shop-mo";
  const barber = { staffId: "barber", brandWide: false, shopIds: [coralville], blocksOwn: true, blocksOthers: false };
  const manager = { staffId: "manager", brandWide: false, shopIds: [coralville], blocksOwn: true, blocksOthers: true };

  it("barbers block their own time only; managers block anyone's at their shops", () => {
    expect(blockChangeDenied(barber, { staffId: "barber", shopId: null }, [coralville])).toBeNull();
    expect(blockChangeDenied(barber, { staffId: "other", shopId: coralville }, [coralville])).toMatch(/only block out your own/);
    expect(blockChangeDenied({ ...barber, blocksOwn: false }, { staffId: "barber", shopId: null }, [coralville])).toMatch(/can't block out your own/);
    expect(blockChangeDenied(manager, { staffId: "other", shopId: coralville }, [coralville])).toBeNull();
    expect(blockChangeDenied(manager, { staffId: "other", shopId: moline }, [coralville, moline])).toMatch(/outside your access/);
    expect(blockChangeDenied(manager, { staffId: "other", shopId: null }, [coralville, moline])).toMatch(/shops you don't manage/);
  });

  it("requesting is separate from approving: no approval permission, no decision", () => {
    const approver = { staffId: "manager", brandWide: false, shopIds: [coralville], canApprove: true, isOwner: false };
    expect(timeOffDecisionDenied({ ...approver, staffId: "barber", canApprove: false }, { staffId: "other", shopId: coralville }, [coralville])).toMatch(/can't approve/);
    expect(timeOffDecisionDenied(approver, { staffId: "barber", shopId: coralville }, [coralville])).toBeNull();
    expect(timeOffDecisionDenied(approver, { staffId: "manager", shopId: coralville }, [coralville])).toMatch(/your own time off/);
    expect(timeOffDecisionDenied({ ...approver, isOwner: true, brandWide: true }, { staffId: "manager", shopId: null }, [coralville])).toBeNull();
    expect(timeOffDecisionDenied(approver, { staffId: "kat", shopId: moline }, [moline])).toMatch(/outside your access/);
    expect(timeOffDecisionDenied(approver, { staffId: "kat", shopId: null }, [coralville, moline])).toMatch(/shops you don't manage/);
    expect(timeOffDecisionDenied({ ...approver, brandWide: true }, { staffId: "kat", shopId: null }, [coralville, moline])).toBeNull();
  });
});
