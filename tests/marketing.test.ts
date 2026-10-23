import { describe, expect, it } from "vitest";
import { formatCents } from "@/lib/money";
import {
  EMPTY_SEGMENT,
  MARKETING_DEFAULTS,
  SAMPLE_VALUES,
  STOP_LINE,
  TRIGGERS,
  TRIGGER_KEYS,
  capProblem,
  daysToBirthday,
  dedupeKey,
  defaultTemplates,
  fill,
  inQuiet,
  marketingSettings,
  milesBetween,
  nextSendAt,
  pickChannel,
  rebookReminderDue,
  render,
  roi,
  segmentProblem,
  templatesProblem,
  triggerSettings,
} from "@/domain/marketing";

const t = (sms: string, extra: Partial<Record<"emailSubject" | "emailBody" | "pushTitle" | "pushBody", string>> = {}) => ({ sms, emailSubject: "", emailBody: "", pushTitle: "", pushBody: "", ...extra });

describe("templates and merge fields", () => {
  it("fills merge fields and tidies the gaps", () => {
    expect(fill("{shop}: Hi {first_name}, use {coupon_code} by {expiry}.", SAMPLE_VALUES)).toBe("Ray'z Coralville: Hi Jordan, use MISSYOU-7K2Q9D by Nov 30.");
    expect(fill("Hi {first_name} !", { first_name: "" })).toBe("Hi!");
  });

  it("texts must carry the opt-out line, stay short, and use real merge fields", () => {
    expect(templatesProblem(t("{shop}: hi"), ["sms"], { hasCoupon: false })).toMatch(/opt out/);
    expect(templatesProblem(t(`{shop}: hi {nickname}. ${STOP_LINE}`), ["sms"], { hasCoupon: false })).toMatch(/\{nickname\} isn't a merge field/);
    expect(templatesProblem(t(`{coupon_code} ${STOP_LINE}`), ["sms"], { hasCoupon: false })).toMatch(/pick a coupon/);
    expect(templatesProblem(t(`${"x".repeat(330)} ${STOP_LINE}`), ["sms"], { hasCoupon: false })).toMatch(/under 320/);
    expect(templatesProblem(t(`{shop ${STOP_LINE}`), ["sms"], { hasCoupon: false })).toMatch(/isn't closed/);
    expect(templatesProblem(t(`ok ${STOP_LINE}`), ["sms", "email"], { hasCoupon: false })).toMatch(/Email subject can't be empty/);
    expect(templatesProblem(t(`ok ${STOP_LINE}`, { emailSubject: "s", emailBody: "b" }), ["sms", "email"], { hasCoupon: false })).toBeNull();
  });

  it("every default template passes its own checks", () => {
    for (const k of TRIGGER_KEYS) {
      expect(templatesProblem(defaultTemplates(k, false), ["sms", "email", "push"], { hasCoupon: false }), k).toBeNull();
      expect(templatesProblem(TRIGGERS[k].templates, ["sms", "email", "push"], { hasCoupon: true }), k).toBeNull();
    }
  });

  it("rendered texts end with STOP; emails end with the postal address and unsubscribe link", () => {
    const r = render(t("{shop}: hi {first_name}", { emailSubject: "Hi {first_name}", emailBody: "Book: {book_link}" }), SAMPLE_VALUES, { brand: "Ray'z Barber Shop", address: "1 Main St", unsubscribeUrl: "https://x/m/T/unsubscribe" });
    expect(r.sms).toBe(`Ray'z Coralville: hi Jordan ${STOP_LINE}`);
    expect(r.email.subject).toBe("Hi Jordan");
    expect(r.email.body).toMatch(/Book: https:\/\/rayz\.example\/m\/Xy12abCD[\s\S]*1 Main St[\s\S]*Unsubscribe: https:\/\/x\/m\/T\/unsubscribe$/);
  });
});

describe("automated campaigns", () => {
  it("settings default and clamp to their ranges", () => {
    expect(triggerSettings("lapsed", {})).toEqual({ days: 42 });
    expect(triggerSettings("win_back", {})).toEqual({ days: 90 });
    expect(triggerSettings("lapsed", { days: 5 })).toEqual({ days: 14 });
    expect(triggerSettings("fill_slow_day", { utilizationPct: "30" })).toEqual({ utilizationPct: 30, maxPerBarber: 20 });
    expect(triggerSettings("birthday", { daysBefore: 3.6, other: 1 })).toEqual({ daysBefore: 4 });
  });

  it("days to the next birthday, including Feb 29 in other years", () => {
    expect(daysToBirthday("1990-02-20", "2028-02-16")).toEqual({ days: 4, year: 2028 });
    expect(daysToBirthday("1990-02-10", "2028-02-16")).toEqual({ days: 360, year: 2029 });
    expect(daysToBirthday("2000-02-29", "2027-02-27")).toEqual({ days: 1, year: 2027 });
  });

  it("rebook reminders for regulars a few days before their usual gap, for two weeks", () => {
    expect(rebookReminderDue({ visits: 3, usualDays: 21, sinceDays: 18 }, 3)).toBe(true);
    expect(rebookReminderDue({ visits: 3, usualDays: 21, sinceDays: 17 }, 3)).toBe(false);
    expect(rebookReminderDue({ visits: 3, usualDays: 21, sinceDays: 32 }, 3)).toBe(false);
    expect(rebookReminderDue({ visits: 2, usualDays: 21, sinceDays: 20 }, 3)).toBe(false);
    expect(rebookReminderDue({ visits: 5, usualDays: 200, sinceDays: 200 }, 3)).toBe(false);
  });

  it("miles between two locations", () => {
    expect(milesBetween({ lat: 41.572, lng: -90.518 }, { lat: 41.56, lng: -90.56 })).toBeCloseTo(2.3, 1);
  });

  it("one send per campaign, client and occasion", () => {
    expect(dedupeKey("c", "u", "birthday:2028")).toBe("c:u:birthday:2028");
  });
});

describe("sending rules", () => {
  const s = MARKETING_DEFAULTS;
  it("quiet hours 9 PM to 9 AM, wrapping midnight", () => {
    expect(inQuiet(20 * 60 + 59, s)).toBe(false);
    expect(inQuiet(21 * 60, s)).toBe(true);
    expect(inQuiet(3 * 60, s)).toBe(true);
    expect(inQuiet(9 * 60, s)).toBe(false);
    expect(inQuiet(13 * 60, { quietStart: "12:00", quietEnd: "14:00" })).toBe(true);
  });

  it("a message due in quiet hours waits until they end in the location's time zone", () => {
    const late = new Date("2028-02-17T04:30:00Z"); // 10:30 PM in Chicago, 11:30 PM in New York
    expect(nextSendAt(late, "America/Chicago", s).toISOString()).toBe("2028-02-17T15:00:00.000Z");
    expect(nextSendAt(late, "America/New_York", s).toISOString()).toBe("2028-02-17T14:00:00.000Z");
    const early = new Date("2028-02-17T13:00:00Z"); // 7 AM Chicago
    expect(nextSendAt(early, "America/Chicago", s).toISOString()).toBe("2028-02-17T15:00:00.000Z");
    const noon = new Date("2028-02-17T18:00:00Z");
    expect(nextSendAt(noon, "America/Chicago", s)).toBe(noon);
  });

  it("frequency caps per week and month", () => {
    const now = new Date("2028-02-16T12:00:00Z");
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    expect(capProblem([ago(1)], now, s)).toBeNull();
    expect(capProblem([ago(1), ago(6)], now, s)).toBe("cap_week");
    expect(capProblem([ago(8), ago(10), ago(12), ago(15), ago(20), ago(29)], now, s)).toBe("cap_month");
    expect(capProblem([ago(8), ago(10), ago(12), ago(15), ago(20), ago(31)], now, s)).toBeNull();
  });

  it("each client gets one message, on the first channel in the campaign's order they agreed to", () => {
    expect(pickChannel(["sms", "email", "push"], { sms: false, email: true, push: true })).toBe("email");
    expect(pickChannel(["push", "sms"], { sms: true, email: false, push: true })).toBe("push");
    expect(pickChannel(["sms"], { sms: false, email: true, push: true })).toBeNull();
  });

  it("ROI is revenue less cost over cost", () => {
    expect(roi(10_000, 2_000)).toBe(4);
    expect(roi(500, 0)).toBeNull();
    expect(formatCents(97.29999999999993)).toBe("$0.97");
    expect(formatCents(-0.3)).toBe("$0.00");
    expect(formatCents(150.5, { sign: true })).toBe("+$1.51");
  });

  it("bad settings fall back field by field", () => {
    const m = marketingSettings({ quietStart: "25:00", capPerWeek: 3, address: "1 Main" });
    expect(m).toMatchObject({ quietStart: "21:00", capPerWeek: 3, address: "1 Main", capPerMonth: 6 });
  });
});

describe("segments", () => {
  it("refuses filters on client details the person can't see, and impossible ranges", () => {
    const all = { birthday: true, ratings: true };
    expect(segmentProblem({ ...EMPTY_SEGMENT, birthdayMonths: [2] }, { birthday: false, ratings: true })).toMatch(/birthday/);
    expect(segmentProblem({ ...EMPTY_SEGMENT, minRating: 4 }, { birthday: true, ratings: false })).toMatch(/rating/);
    expect(segmentProblem({ ...EMPTY_SEGMENT, minVisits: 5, maxVisits: 2 }, all)).toMatch(/fewest visits/);
    expect(segmentProblem({ ...EMPTY_SEGMENT, minSpendCents: 500, maxSpendCents: 100 }, all)).toMatch(/lowest spend/);
    expect(segmentProblem({ ...EMPTY_SEGMENT, birthdayMonths: [2], minRating: 4 }, all)).toBeNull();
  });
});
