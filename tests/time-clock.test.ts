import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import { dailyHours, overtimeSlices, splitByLocalDay, type OtOptions, type TimeEntry } from "@/domain/payroll/overtime";
import { payrollSettings } from "@/domain/payroll/calc";
import {
  DEFAULT_CLOCK_RULES,
  DEFAULT_ISOLVED_COLUMNS,
  allowedNext,
  clockRules,
  clockStatus,
  exportLines,
  exportTotals,
  forgottenAfter,
  ftCrossings,
  genericCsv,
  haversineMeters,
  ipInList,
  mappedCsv,
  offSchedule,
  pairPunches,
  parseColumnMapping,
  parseIp,
  pinProblem,
  rollingFt,
  scheduledOn,
  shiftWork,
  shopClockSettings,
  verifyPunch,
  KIOSK_REQUIRED,
  punchDistanceM,
  clockRuleText,
  pinLocked,
  PIN_LOCKED_UNTIL_UNLOCKED,
  isRepeatedWallTime,
  wallInstant,
  wallStamp,
  type PunchLike,
  type PunchType,
} from "@/domain/time-clock";

const at = (local: string) => DateTime.fromISO(local, { zone: "America/Chicago" }).toJSDate();
let n = 0;
const p = (type: PunchType, local: string, staffId = "b1", shopId = "s1"): PunchLike => ({ id: `p${++n}`, staffId, shopId, type, at: at(local) });
const RULES = DEFAULT_CLOCK_RULES;
const minutes = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

describe("punch pairing", () => {
  it("pairs in and out into a shift, per person", () => {
    const { shifts, problems } = pairPunches([p("out", "2026-11-02T17:00"), p("in", "2026-11-02T09:00"), p("in", "2026-11-02T10:00", "b2"), p("out", "2026-11-02T18:30", "b2")]);
    expect(problems).toEqual([]);
    expect(shifts.map((s) => [s.staffId, minutes(s.start, s.end!)])).toEqual([
      ["b1", 480],
      ["b2", 510],
    ]);
  });

  it("flags a second clock-in, a clock-out with no clock-in and a shift left open", () => {
    const a = p("in", "2026-11-02T09:00");
    const b = p("in", "2026-11-02T13:00");
    const c = p("out", "2026-11-02T17:00");
    const d = p("out", "2026-11-02T17:05");
    const e = p("in", "2026-11-03T09:00");
    const { shifts, problems } = pairPunches([a, b, c, d, e]);
    expect(problems.map((x) => [x.kind, x.punchId])).toEqual([
      ["open_shift", a.id],
      ["double_in", b.id],
      ["out_without_in", d.id],
      ["open_shift", e.id],
    ]);
    expect(shifts.map((s) => [s.inId, s.outId])).toEqual([
      [a.id, null],
      [b.id, c.id],
      [e.id, null],
    ]);
  });

  it("knows where someone stands and what they can punch next", () => {
    expect(clockStatus([]).state).toBe("off");
    expect(clockStatus([p("in", "2026-11-02T09:00")]).state).toBe("working");
    expect(clockStatus([p("in", "2026-11-02T09:00"), p("break_start", "2026-11-02T12:00")]).state).toBe("on_break");
    expect(allowedNext("off")).toEqual(["in"]);
    expect(allowedNext("working")).toEqual(["break_start", "out"]);
    expect(allowedNext("on_break")).toEqual(["break_end", "out"]);
  });
});

describe("breaks", () => {
  it("short breaks are paid and meal breaks are not", () => {
    const { shifts } = pairPunches([
      p("in", "2026-11-02T09:00"),
      p("break_start", "2026-11-02T10:30"),
      p("break_end", "2026-11-02T10:45"),
      p("break_start", "2026-11-02T12:00"),
      p("break_end", "2026-11-02T12:30"),
      p("out", "2026-11-02T17:00"),
    ]);
    const w = shiftWork(shifts[0], RULES);
    expect(w).toMatchObject({ workedMin: 450, breakMin: 45, paidBreakMin: 15, unpaidBreakMin: 30, autoMealMin: 0 });
    expect(w.segments.map((s) => minutes(s.start, s.end))).toEqual([180, 270]);
    expect(shiftWork(shifts[0], { ...RULES, unpaidBreakFromMinutes: 0 }).workedMin).toBe(435);
    expect(shiftWork(shifts[0], { ...RULES, unpaidBreakFromMinutes: 60 }).workedMin).toBe(480);
  });

  it("an unended break closes at the clock-out and is flagged", () => {
    const { shifts, problems } = pairPunches([p("in", "2026-11-02T09:00"), p("break_start", "2026-11-02T16:00"), p("out", "2026-11-02T17:00")]);
    expect(problems.map((x) => x.kind)).toEqual(["break_not_ended"]);
    expect(shiftWork(shifts[0], RULES).workedMin).toBe(420);
  });

  it("break problems are reported, not guessed", () => {
    const { problems } = pairPunches([p("break_start", "2026-11-02T08:00"), p("in", "2026-11-02T09:00"), p("break_end", "2026-11-02T10:00"), p("out", "2026-11-02T17:00")]);
    expect(problems.map((x) => x.kind)).toEqual(["break_outside_shift", "break_end_without_start"]);
  });

  it("takes an automatic meal off a long shift with no unpaid break, when turned on", () => {
    const { shifts } = pairPunches([p("in", "2026-11-02T09:00"), p("out", "2026-11-02T17:00")]);
    expect(shiftWork(shifts[0], RULES).workedMin).toBe(480);
    const w = shiftWork(shifts[0], { ...RULES, autoMealMinutes: 30, autoMealAfterHours: 6 });
    expect(w).toMatchObject({ workedMin: 450, autoMealMin: 30 });
    expect(w.segments.at(-1)!.end).toEqual(at("2026-11-02T16:30"));
    const short = pairPunches([p("in", "2026-11-02T09:00"), p("out", "2026-11-02T14:00")]).shifts[0];
    expect(shiftWork(short, { ...RULES, autoMealMinutes: 30 }).workedMin).toBe(300);
  });
});

describe("overnight and DST shifts", () => {
  it("an overnight shift splits at local midnight", () => {
    const { shifts } = pairPunches([p("in", "2026-11-06T22:00"), p("out", "2026-11-07T02:30")]);
    const w = shiftWork(shifts[0], RULES);
    const parts = w.segments.flatMap((s) => splitByLocalDay({ startsAt: s.start, endsAt: s.end }));
    expect(parts).toEqual([
      { date: "2026-11-06", minutes: 120 },
      { date: "2026-11-07", minutes: 150 },
    ]);
  });

  it("the night clocks fall back is an hour longer than the wall clock says", () => {
    // 2026-11-01 02:00 CDT → 01:00 CST.
    const { shifts } = pairPunches([p("in", "2026-10-31T22:00"), p("out", "2026-11-01T06:00")]);
    expect(shiftWork(shifts[0], RULES).workedMin).toBe(9 * 60);
    expect(dailyHours([{ staffId: "b1", shopId: "s1", kind: "worked", startsAt: shifts[0].start, endsAt: shifts[0].end! }])).toEqual([
      { staffId: "b1", shopId: "s1", date: "2026-10-31", worked: 200, training: 0, pto: 0 },
      { staffId: "b1", shopId: "s1", date: "2026-11-01", worked: 700, training: 0, pto: 0 },
    ]);
  });

  it("the night clocks spring forward is an hour shorter", () => {
    // 2027-03-14 02:00 CST → 03:00 CDT.
    const { shifts } = pairPunches([p("in", "2027-03-13T22:00"), p("out", "2027-03-14T06:00")]);
    expect(shiftWork(shifts[0], RULES).workedMin).toBe(7 * 60);
  });

  it("a break over the fall-back hour is its real length", () => {
    const { shifts } = pairPunches([p("in", "2026-10-31T20:00"), p("break_start", "2026-11-01T01:30"), p("break_end", "2026-11-01T02:00"), p("out", "2026-11-01T04:00")]);
    // 01:30 CDT to 02:00 CST is 90 real minutes; luxon reads the ambiguous 01:30 as the first (CDT) one.
    const w = shiftWork(shifts[0], RULES);
    expect(w.unpaidBreakMin).toBe(90);
    expect(w.workedMin).toBe(9 * 60 - 90);
  });

  it("a manager's edit picks either 1:30 on the fall-back night, and refuses the skipped hour", () => {
    const first = wallInstant("2026-11-01T01:30")!;
    const second = wallInstant("2026-11-01T01:30", true)!;
    expect(minutes(first, second)).toBe(60);
    expect(isRepeatedWallTime("2026-11-01T01:30")).toBe(true);
    expect(isRepeatedWallTime("2026-11-01T02:30")).toBe(false);
    expect(wallStamp(first)).toEqual({ local: "2026-11-01T01:30", later: false });
    expect(wallStamp(second)).toEqual({ local: "2026-11-01T01:30", later: true });
    expect(wallInstant("2027-03-14T02:30")).toBeNull();
    expect(wallInstant("2027-03-14T03:30")).toEqual(at("2027-03-14T03:30"));
    expect(wallInstant("2026-11-02T09:00", true)).toEqual(at("2026-11-02T09:00"));
    expect(wallInstant("nonsense")).toBeNull();
  });
});

const MAIN: PayCalendar = { anchorStart: "2026-10-18", anchorNumber: 23, periodDays: 14, checkOffsetDays: 6, submitOffsetDays: 4, numberResetsYearly: true };
const opts = (over: Partial<OtOptions> = {}): OtOptions => ({
  thresholdCenti: 4000,
  trainingCountsTowardOt: false,
  entityOf: () => "Ray'z Inc.",
  periodOf: (_shop, date) => periodOf(MAIN, date).start,
  ...over,
});
const days = (shopId: string, from: string, count: number, hours: number): TimeEntry[] =>
  Array.from({ length: count }, (_, i) => {
    const d = DateTime.fromISO(from, { zone: "America/Chicago" }).plus({ days: i }).set({ hour: 8 });
    return { staffId: "b1", shopId, kind: "worked" as const, startsAt: d.toJSDate(), endsAt: d.plus({ minutes: hours * 60 }).toJSDate() };
  });
const totalOt = (entries: TimeEntry[], o: OtOptions) => overtimeSlices(dailyHours(entries), o).reduce((a, s) => a + s.ot, 0);

describe("overtime math", () => {
  it("weekly over 40 (FLSA) by default, with no daily overtime", () => {
    expect(payrollSettings({}).dailyOtHours).toBeNull();
    expect(totalOt(days("s1", "2026-11-01", 5, 9), opts())).toBe(500);
    expect(totalOt(days("s1", "2026-11-01", 4, 10), opts())).toBe(0);
  });

  it("no daily threshold gives exactly the weekly-only slices", () => {
    const e = [...days("s1", "2026-10-25", 4, 9), ...days("s2", "2026-10-29", 3, 7)];
    expect(overtimeSlices(dailyHours(e), opts({ dailyThresholdCenti: null }))).toEqual(overtimeSlices(dailyHours(e), opts()));
  });

  it("a daily threshold counts the day's excess, then the week's on what's left, never twice", () => {
    const daily = opts({ dailyThresholdCenti: 800 });
    // Four 10-hour days: 8 daily OT hours, 32 left is under 40.
    expect(totalOt(days("s1", "2026-11-01", 4, 10), daily)).toBe(800);
    // Five 10-hour days: 10 daily, 40 left, no weekly on top.
    expect(totalOt(days("s1", "2026-11-01", 5, 10), daily)).toBe(1000);
    // Six 8-hour days: no daily, 8 weekly.
    expect(totalOt(days("s1", "2026-11-01", 6, 8), daily)).toBe(800);
    // Six 9-hour days: 6 daily, 48 left → 8 weekly: 14.
    expect(totalOt(days("s1", "2026-11-01", 6, 9), daily)).toBe(1400);
  });

  it("daily overtime across two shops in one day is shared by their hours", () => {
    const e: TimeEntry[] = [
      { staffId: "b1", shopId: "s1", kind: "worked", startsAt: at("2026-11-02T07:00"), endsAt: at("2026-11-02T13:00") },
      { staffId: "b1", shopId: "s2", kind: "worked", startsAt: at("2026-11-02T14:00"), endsAt: at("2026-11-02T18:00") },
    ];
    const slices = overtimeSlices(dailyHours(e), opts({ dailyThresholdCenti: 800 }));
    expect(Object.fromEntries(slices.map((s) => [s.shopId, s.ot]))).toEqual({ s1: 120, s2: 80 });
  });

  it("locked slices keep their OT with daily overtime on", () => {
    const e = [...days("s1", "2026-11-01", 3, 9), ...days("s2", "2026-11-04", 3, 9)];
    const all = overtimeSlices(dailyHours(e), opts({ dailyThresholdCenti: 800 }));
    expect(Object.fromEntries(all.map((s) => [s.shopId, s.ot]))).toEqual({ s1: 700, s2: 700 });
    const s1 = all.find((s) => s.shopId === "s1")!;
    const locked = new Map([[`b1|s1|${s1.periodStart}|${s1.weekStart}`, 300]]);
    const again = overtimeSlices(dailyHours(e), opts({ dailyThresholdCenti: 800, locked }));
    expect(Object.fromEntries(again.map((s) => [s.shopId, s.ot]))).toEqual({ s1: 300, s2: 1100 });
  });
});

describe("rolling 32-hour full-time / part-time", () => {
  const weeks = (hours: number[]) => hours.map((h, i) => ({ weekStart: DateTime.fromISO("2026-09-06").plus({ weeks: i }).toISODate()!, hours: h }));

  it("full time is strictly more than 32 on average; exactly 32 is part time", () => {
    expect(rollingFt(weeks([40, 40, 24, 24]), 4, 32).map((w) => [w.average, w.status])).toEqual([[32, "part_time"]]);
    expect(rollingFt(weeks([40, 40, 24, 24.04]), 4, 32)[0].status).toBe("full_time");
  });

  it("averages over the chosen look-back, 4 to 13 weeks", () => {
    const w = weeks([20, 20, 20, 20, 20, 20, 20, 20, 40, 40, 40, 40, 40]);
    expect(rollingFt(w, 4, 32).at(-1)).toMatchObject({ average: 40, status: "full_time" });
    expect(rollingFt(w, 8, 32).at(-1)).toMatchObject({ average: 32.5, status: "full_time" });
    expect(rollingFt(w, 12, 32).at(-1)).toMatchObject({ average: 28.33, status: "part_time" });
    expect(rollingFt(w, 13, 32)).toEqual([expect.objectContaining({ average: 27.69, status: "part_time" })]);
  });

  it("reports the week someone crosses the threshold, each way", () => {
    const w = weeks([30, 30, 30, 30, 40, 40, 40, 40, 20, 20]);
    expect(ftCrossings(w, 4, 32)).toEqual([
      { weekStart: w[4].weekStart, from: "part_time", to: "full_time", average: 32.5 },
      { weekStart: w[9].weekStart, from: "full_time", to: "part_time", average: 30 },
    ]);
  });
});

describe("schedule and forgotten clock-outs", () => {
  const sched = scheduledOn("2026-11-02", 1, [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }]);

  it("late and early against the schedule, with grace", () => {
    expect(offSchedule("in", at("2026-11-02T09:04"), sched, 5)).toEqual({ flag: null, minutes: 4 });
    expect(offSchedule("in", at("2026-11-02T09:12"), sched, 5)).toEqual({ flag: "late", minutes: 12 });
    expect(offSchedule("in", at("2026-11-02T08:40"), sched, 5)).toEqual({ flag: "early_in", minutes: -20 });
    expect(offSchedule("out", at("2026-11-02T16:30"), sched, 5)).toEqual({ flag: "early_out", minutes: -30 });
    expect(offSchedule("out", at("2026-11-02T17:20"), sched, 5)).toEqual({ flag: "late_out", minutes: 20 });
    expect(offSchedule("in", at("2026-11-02T09:12"), [], 5)).toEqual({ flag: null, minutes: null });
  });

  it("a shift is forgotten an hour past its scheduled end, or after the longest shift", () => {
    expect(forgottenAfter(at("2026-11-02T09:00"), sched, RULES)).toEqual(at("2026-11-02T18:00"));
    expect(forgottenAfter(at("2026-11-02T09:00"), [], RULES)).toEqual(at("2026-11-02T21:00"));
  });
});

describe("verifying a punch: the shop's front-desk clock only", () => {
  const shop = { name: "Ray'z Test", latitude: 41.5236, longitude: -90.5776 };
  const evidence = { deviceShopId: null, ip: null, gps: null };
  const near = { lat: 41.5242, lng: -90.5776 };

  it("a phone on its own never punches: not by location, Wi-Fi or nothing at all", () => {
    expect(verifyPunch("s1", shop, evidence)).toMatchObject({ ok: false, problem: KIOSK_REQUIRED("Ray'z Test") });
    expect(verifyPunch("s1", shop, { ...evidence, gps: { ...near, accuracyM: 5 } })).toEqual({ ok: false, problem: KIOSK_REQUIRED("Ray'z Test"), distanceM: 67 });
    expect(verifyPunch("s1", shop, { ...evidence, ip: "203.0.113.5" }).ok).toBe(false);
    expect(verifyPunch("s1", shop, { ...evidence, nfcShopId: "s1" }).ok).toBe(false);
  });

  it("the shop's own paired clock, or a QR code it issued, and only at that shop", () => {
    expect(verifyPunch("s1", shop, { ...evidence, deviceShopId: "s1" })).toMatchObject({ ok: true, method: "device" });
    expect(verifyPunch("s1", shop, { ...evidence, deviceShopId: "s2" }).ok).toBe(false);
    expect(verifyPunch("s1", shop, { ...evidence, qrShopId: "s1", gps: { ...near, accuracyM: 20 } })).toEqual({ ok: true, method: "qr", distanceM: 67 });
    expect(verifyPunch("s1", shop, { ...evidence, qrShopId: "s2" }).ok).toBe(false);
  });

  it("the distance is still worked out for the off-site flag", () => {
    expect(Math.round(haversineMeters({ lat: shop.latitude, lng: shop.longitude }, near))).toBe(67);
    expect(punchDistanceM(shop, { lat: 41.5336, lng: -90.5776, accuracyM: 20 })).toBe(1112);
    expect(punchDistanceM({ latitude: null, longitude: null }, { ...near, accuracyM: 5 })).toBeNull();
    expect(clockRuleText()).toMatch(/front-desk clock/);
  });

  it("the shop's network list still parses, IPv4 and IPv6", () => {
    expect(ipInList("203.0.113.77", ["203.0.113.0/24"])).toBe(true);
    expect(ipInList("203.0.114.1", ["203.0.113.0/24"])).toBe(false);
    expect(ipInList("::ffff:203.0.113.9", ["203.0.113.9"])).toBe(true);
    expect(ipInList("2001:db8:abcd:12::1", ["2001:db8:abcd::/48"])).toBe(true);
    expect(ipInList("2001:db9::1", ["2001:db8:abcd::/48"])).toBe(false);
    expect(parseIp("::1")).toEqual({ v: 6, n: BigInt(1) });
    expect(parseIp("64:ff9b::192.0.2.33")?.n).toBe(BigInt("0x0064ff9b0000000000000000c0000221"));
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
    expect(shopClockSettings({ methods: ["network", "gps"], networks: ["203.0.113.0/24", "not an ip"] }).networks).toEqual(["203.0.113.0/24"]);
  });
});

describe("PINs", () => {
  it("4 to 6 digits, not repeated or a run", () => {
    expect(pinProblem("123")).not.toBeNull();
    expect(pinProblem("12a4")).not.toBeNull();
    expect(pinProblem("1111")).not.toBeNull();
    expect(pinProblem("1234")).not.toBeNull();
    expect(pinProblem("6543")).not.toBeNull();
    expect(pinProblem("2580")).toBeNull();
    expect(pinProblem("918273")).toBeNull();
  });

  it("five wrong in a row lock it until a manager unlocks it, not for a few minutes", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(pinLocked({ pinFailures: 4, pinLockedUntil: null }, now)).toBe(false);
    expect(pinLocked({ pinFailures: 5, pinLockedUntil: null }, now)).toBe(true);
    expect(pinLocked({ pinFailures: 5, pinLockedUntil: PIN_LOCKED_UNTIL_UNLOCKED }, new Date("2099-01-01T00:00:00Z"))).toBe(true);
    expect(pinLocked({ pinFailures: 0, pinLockedUntil: new Date("2026-11-02T14:00:00Z") }, now)).toBe(false);
  });
});

describe("payroll export", () => {
  const who = (id: string) => ({ name: id === "b1" ? "Jordan" : "Avery, Jr.", isolvedName: id.toUpperCase(), employeeNumber: id === "b1" ? "000123" : null });
  const shop = (id: string) => ({ name: id === "s1" ? "Moline" : "Davenport", payGroup: id === "s1" ? "Moline" : "Davenport" });
  const lines = exportLines(
    [
      { staffId: "b1", shopId: "s1", workedCenti: 4433, otCenti: 433, ptoCenti: 0, trainingCenti: 0, breakMin: 45, unpaidBreakMin: 30 },
      { staffId: "b1", shopId: "s2", workedCenti: 1067, otCenti: 67, ptoCenti: 800, trainingCenti: 0, breakMin: 10, unpaidBreakMin: 0 },
      { staffId: "b2", shopId: "s2", workedCenti: 3000, otCenti: 0, ptoCenti: 0, trainingCenti: 200, breakMin: 0, unpaidBreakMin: 0 },
    ],
    [
      { staffId: "b1", shopId: "s1", cardTipsCents: 12345, cashTipsCents: 2000, serviceSalesCents: 150000, productSalesCents: 4599 },
      { staffId: "b3", shopId: "s1", cardTipsCents: 0, cashTipsCents: 0, serviceSalesCents: 0, productSalesCents: 0 },
      { staffId: "b2", shopId: "s2", cardTipsCents: 1, cashTipsCents: 0, serviceSalesCents: 999, productSalesCents: 0 },
    ],
    who,
    shop,
    { start: "2026-10-18", end: "2026-10-31" },
  );

  it("one line per employee and shop, regular = worked − OT, breaks in hundredths", () => {
    expect(lines.map((l) => [l.shop, l.name, l.regularCenti, l.otCenti, l.breakCenti, l.unpaidBreakCenti])).toEqual([
      ["Davenport", "Avery, Jr.", 3000, 0, 0, 0],
      ["Davenport", "Jordan", 1000, 67, 17, 0],
      ["Moline", "Jordan", 4000, 433, 75, 50],
    ]);
  });

  it("the totals row is the sum of the rows, column by column", () => {
    const text = genericCsv(lines);
    const rows = text.trim().split("\r\n").map((r) => r.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, 15));
    const [head, ...body] = rows;
    const total = body.pop()!;
    expect(head.slice(0, 3)).toEqual(["Employee Number", "Display name", "Shop"]);
    expect(total[0]).toBe("TOTAL");
    for (let c = 5; c < head.length; c++) {
      const sum = body.reduce((a, r) => a + Math.round(Number(r[c]) * 100), 0);
      expect(Math.round(Number(total[c]) * 100), head[c]).toBe(sum);
    }
    const t = exportTotals(lines);
    expect(t).toMatchObject({ regularCenti: 8000, otCenti: 500, cardTipsCents: 12346, cashTipsCents: 2000, serviceSalesCents: 150999, productSalesCents: 4599, ptoCenti: 800, trainingCenti: 200 });
    expect(text).toContain('"Avery, Jr."');
    expect(text).toContain("000123");
  });

  it("the iSolved layout follows the configured columns and has no totals row", () => {
    const text = mappedCsv(lines, DEFAULT_ISOLVED_COLUMNS);
    const rows = text.trim().split("\r\n");
    expect(rows[0]).toBe("Key,Name,Location,E_Regular_Hours,E_Overtime 1.5_Hours,E_Cash Tips Recd_Dollars,E_Charge Tips_Dollars,E_Service Sales_Dollars,E_Product Sales_Dollars");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toBe("000123,B1,Moline,40.00,4.33,20.00,123.45,1500.00,45.99");
    const custom = parseColumnMapping("Emp = employeeNumber\nREG = regularHours\n\nOT = otHours");
    expect(custom.problems).toEqual([]);
    expect(mappedCsv(lines, custom.columns).split("\r\n")[0]).toBe("Emp,REG,OT");
    expect(parseColumnMapping("Bad line\nX = nope").problems).toHaveLength(2);
  });

  it("bad saved columns fall back to the defaults", () => {
    expect(clockRules({ isolvedColumns: [{ header: "", field: "otHours" }, { header: "X", field: "nope" }] }).isolvedColumns).toEqual(DEFAULT_ISOLVED_COLUMNS);
    expect(clockRules({ isolvedColumns: [{ header: "OT", field: "otHours" }] }).isolvedColumns).toEqual([{ header: "OT", field: "otHours" }]);
  });
});
