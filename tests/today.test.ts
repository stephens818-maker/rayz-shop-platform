import { describe, expect, it } from "vitest";
import { type Alert, dueForCut, durationLabel, freeIntervals, minutesIn, noShowRisk, paceChange, rebookDue, sortAlerts } from "@/domain/today";

const H = 3_600_000;
const M = 60_000;
const DAY = 86_400_000;

describe("open chair time", () => {
  const work = [{ start: 9 * H, end: 17 * H }];
  it("is the working window minus bookings and blocks, from now on, ignoring gaps too short for a cut", () => {
    const busy = [
      { start: 10 * H, end: 11 * H },
      { start: 11 * H + 20 * M, end: 12 * H },
      { start: 15 * H, end: 18 * H },
    ];
    expect(freeIntervals(work, busy, 9 * H + 30 * M)).toEqual([
      { start: 9 * H + 30 * M, end: 10 * H },
      { start: 12 * H, end: 15 * H },
    ]);
    expect(minutesIn(freeIntervals(work, busy, 9 * H + 30 * M))).toBe(210);
  });
  it("is nothing after the day ends, and overlapping bookings count once", () => {
    expect(freeIntervals(work, [], 17 * H)).toEqual([]);
    expect(freeIntervals(work, [{ start: 9 * H, end: 13 * H }, { start: 10 * H, end: 12 * H }], 0)).toEqual([{ start: 13 * H, end: 17 * H }]);
  });
  it("reads as hours and minutes", () => {
    expect([durationLabel(45), durationLabel(60), durationLabel(135)]).toEqual(["45m", "1h", "2h 15m"]);
  });
});

describe("client history", () => {
  it("flags a no-show habit high and a couple of slips medium", () => {
    expect(noShowRisk({ noShows: 2, lateCancels: 0, total: 20 })).toBe("high");
    expect(noShowRisk({ noShows: 1, lateCancels: 0, total: 2 })).toBe("high");
    expect(noShowRisk({ noShows: 1, lateCancels: 1, total: 12 })).toBe("medium");
    expect(noShowRisk({ noShows: 1, lateCancels: 0, total: 12 })).toBeNull();
  });
  it("calls a regular overdue well past their usual gap, but not once they've likely moved on", () => {
    const now = 400 * DAY;
    const monthly = (lastAgo: number) => ({ visits: 4, firstVisit: now - lastAgo * DAY - 90 * DAY, lastVisit: now - lastAgo * DAY });
    expect(rebookDue(monthly(30), now)).toEqual({ due: false, usualDays: 30, sinceDays: 30 });
    expect(rebookDue(monthly(50), now).due).toBe(true);
    expect(rebookDue(monthly(200), now).due).toBe(false);
    expect(rebookDue({ visits: 2, firstVisit: now - 100 * DAY, lastVisit: now - 60 * DAY }, now).due).toBe(false);
  });
  it("is due for a cut at about their usual gap, or three weeks without one", () => {
    const now = 400 * DAY;
    expect(dueForCut({ visits: 3, firstVisit: now - 84 * DAY, lastVisit: now - 26 * DAY }, now)).toBe(true);
    expect(dueForCut({ visits: 3, firstVisit: now - 84 * DAY, lastVisit: now - 20 * DAY }, now)).toBe(false);
    expect(dueForCut({ visits: 1, firstVisit: now - 22 * DAY, lastVisit: now - 22 * DAY }, now)).toBe(true);
    expect(dueForCut({ visits: 5, firstVisit: now - 300 * DAY, lastVisit: now - 130 * DAY }, now)).toBe(false);
  });
  it("compares sales to last week only when there was something last week", () => {
    expect(paceChange(750, 1000)).toBe(-0.25);
    expect(paceChange(500, 0)).toBeNull();
  });
});

const alert = (o: Partial<Alert>): Alert => ({ key: o.title ?? "k", type: "low_stock", severity: "low", shopId: null, shop: null, title: "t", detail: "", ...o });

describe("alerts", () => {
  it("sort urgent first, then by shop", () => {
    const sorted = sortAlerts([alert({ title: "b", shop: "Moline" }), alert({ title: "a", severity: "high", shop: "Silvis" }), alert({ title: "c", shop: "Coralville", severity: "medium" })]);
    expect(sorted.map((a) => a.title)).toEqual(["a", "c", "b"]);
  });
});
