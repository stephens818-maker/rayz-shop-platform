import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { dailyHours, minutesToCenti, overtimeSlices, payHours, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import { formatPayHours } from "@/lib/hours";

const at = (local: string) => DateTime.fromISO(local, { zone: "America/Chicago" }).toJSDate();
const opts = (): OtOptions => ({
  thresholdCenti: 4000,
  trainingCountsTowardOt: true,
  entityOf: () => "Rayz",
  periodOf: () => "2026-10-04",
});

/** Weekdays from `from` through `to`, inclusive, as 9:00–5:00 worked entries. No punches. */
function ownerDays(from: string, to: string): TimeEntry[] {
  const out: TimeEntry[] = [];
  let d = DateTime.fromISO(from, { zone: "America/Chicago" });
  const end = DateTime.fromISO(to, { zone: "America/Chicago" });
  for (; d <= end; d = d.plus({ days: 1 })) {
    if (d.weekday >= 6) continue;
    const start = d.set({ hour: 9, minute: 0 });
    out.push({ staffId: "owner", shopId: "rock-island", kind: "worked", startsAt: start.toJSDate(), endsAt: start.plus({ hours: 8 }).toJSDate() });
  }
  return out;
}

describe("pay hours", () => {
  it("rounds a day's minutes once, half-up, to a hundredth of an hour", () => {
    // 3.7 minutes. The old day cell rounded to 4 minutes first, and 4/60 prints as 0.07.
    expect(payHours(3.7)).toBe(0.06);
    expect(minutesToCenti(3.7)).toBe(6);
    expect(formatPayHours(payHours(3.7))).toBe("0.06");
    expect(formatPayHours(Math.round(3.7) / 60)).toBe("0.07");
  });

  it("a timesheet day and its period are the same hundredths", () => {
    const e: TimeEntry = { staffId: "b", shopId: "s", kind: "worked", startsAt: at("2026-10-07T09:00"), endsAt: at("2026-10-07T09:03:42") };
    const [day] = dailyHours([e]);
    const [slice] = overtimeSlices([day], opts());
    expect(day.worked).toBe(minutesToCenti(3.7));
    expect(slice.worked).toBe(day.worked);
    expect(formatPayHours(day.worked / 100)).toBe(formatPayHours(slice.worked / 100));
    expect(formatPayHours(day.worked / 100)).toBe("0.06");
  });

  it("the 40h and 80h gap is imported weekday hours, not overtime or a midnight split", () => {
    // P22 is Sun Oct 4 – Sat Oct 17: ten weekdays, 8h each, two weeks of exactly 40. Overtime is 0.
    const p22 = ownerDays("2026-10-04", "2026-10-17");
    const days22 = dailyHours(p22);
    const worked22 = days22.reduce((a, d) => a + d.worked, 0);
    const ot22 = overtimeSlices(days22, opts()).reduce((a, s) => a + s.ot, 0);
    expect(p22).toHaveLength(10);
    expect(worked22 / 100).toBe(80);
    expect(ot22).toBe(0);
    // The first week of P23 (Sun Oct 18 – Sat Oct 24) is five weekdays: 40h, still no overtime.
    const p23week = ownerDays("2026-10-18", "2026-10-24");
    const days23 = dailyHours(p23week);
    const worked23 = days23.reduce((a, d) => a + d.worked, 0);
    const ot23 = overtimeSlices(days23, opts()).reduce((a, s) => a + s.ot, 0);
    expect(p23week).toHaveLength(5);
    expect(worked23 / 100).toBe(40);
    expect(ot23).toBe(0);
    // A total built only from punches misses every one of these hours. Payroll counts the entries.
    const punchesOnly = 0;
    expect(worked22 / 100 - punchesOnly).toBe(80);
    expect(worked23 / 100 - punchesOnly).toBe(40);
  });
});
