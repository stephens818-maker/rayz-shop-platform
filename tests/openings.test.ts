import { describe, expect, it } from "vitest";
import {
  OPENINGS_DEFAULTS,
  OPENINGS_TEMPLATES,
  OpeningsInputSchema,
  dayLabel,
  limitProblem,
  openingsDays,
  openingsSettings,
  openingsTemplatesProblem,
  rulesFor,
  windowProblem,
} from "@/domain/openings";

const TODAY = "2026-10-24";
const SHOP = "5b8f0c1e-7a2d-4c3b-9e1f-2a6d8c4b0e11";
const OTHER = "9d3e6a2f-1b4c-4f8e-a7d2-6c0b5e9f3a22";

describe("We have openings", () => {
  it("says the days the way a text would, as of the day it arrives", () => {
    expect(dayLabel([TODAY], TODAY)).toBe("today");
    expect(dayLabel(["2026-10-25"], TODAY)).toBe("tomorrow");
    expect(dayLabel(["2026-10-25", TODAY], TODAY)).toBe("today and tomorrow");
    expect(dayLabel(["2026-10-29"], TODAY)).toBe("on Thu, Oct 29");
    expect(dayLabel([TODAY, "2026-10-25", "2026-10-27"], TODAY)).toBe("today, tomorrow and Tue, Oct 27");
    expect(dayLabel(["2026-10-25", "2026-10-31"], TODAY)).toBe("tomorrow and Sat, Oct 31");
    // Sent at 10pm for today and tomorrow: it arrives tomorrow morning and only mentions tomorrow.
    expect(dayLabel([TODAY, "2026-10-25"], "2026-10-25")).toBe("today");
    expect(dayLabel(["2026-10-23"], TODAY)).toBe("");
  });

  it("covers today and the next six days, up to three at a time", () => {
    expect(openingsDays(TODAY)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(windowProblem([TODAY, "2026-10-25"], TODAY)).toBeNull();
    expect(windowProblem([], TODAY)).toBe("Pick a day");
    expect(windowProblem([TODAY, TODAY], TODAY)).toBe("Pick each day once");
    expect(windowProblem(["2026-10-23"], TODAY)).toBe("That day has passed");
    expect(windowProblem(["2026-10-31"], TODAY)).toMatch(/next 6 days/);
    expect(windowProblem([TODAY, "2026-10-25", "2026-10-26", "2026-10-27"], TODAY)).toMatch(/up to 3/);
  });

  it("holds a location to its daily and weekly limits, counting each barber as one blast", () => {
    const r = { perDay: 3, perWeek: 5 };
    expect(limitProblem({ today: 0, week: 0 }, 3, r)).toBeNull();
    expect(limitProblem({ today: 2, week: 2 }, 2, r)).toBe("This location can send 1 openings blast more today (each barber is one)");
    expect(limitProblem({ today: 3, week: 3 }, 1, r)).toBe("This location has sent its 3 openings blasts for today. Try again tomorrow.");
    expect(limitProblem({ today: 0, week: 4 }, 2, r)).toBe("This location can send 1 openings blast more this week (each barber is one)");
    expect(limitProblem({ today: 0, week: 5 }, 1, r)).toMatch(/sent its 5 openings blasts for the last 7 days/);
    expect(limitProblem({ today: 0, week: 0 }, 1, { perDay: 0, perWeek: 10 })).toMatch(/for today/);
  });

  it("a location's own limits and approval rule override the brand's, null follows it", () => {
    const s = openingsSettings({ perDay: 2, approval: true, shops: { [SHOP]: { perDay: 5, perWeek: null, approval: false } } });
    expect(rulesFor(s, SHOP)).toEqual({ perDay: 5, perWeek: 12, approval: false });
    expect(rulesFor(s, OTHER)).toEqual({ perDay: 2, perWeek: 12, approval: true });
  });

  it("defaults to a 7-day frequency cap, and a bad stored value falls back on its own", () => {
    expect(OPENINGS_DEFAULTS.capDays).toBe(7);
    expect(openingsSettings(null)).toEqual(OPENINGS_DEFAULTS);
    const s = openingsSettings({ capDays: "lots", perWeek: 20, templates: { sms: "" } });
    expect(s.capDays).toBe(7);
    expect(s.perWeek).toBe(20);
    expect(s.templates).toEqual(OPENINGS_TEMPLATES);
  });

  it("the standard wording works, and the brand's has to keep the link and only known fields", () => {
    expect(openingsTemplatesProblem(OPENINGS_TEMPLATES)).toBeNull();
    expect(OPENINGS_TEMPLATES.sms).toBe("Hi {first_name}, {barber} at {shop} has openings {day}. First come, first served: {book_link} Reply STOP to opt out.");
    expect(openingsTemplatesProblem({ ...OPENINGS_TEMPLATES, sms: "Hi {first_name}, {barber} has openings {day}. Reply STOP to opt out." })).toMatch(/text needs \{book_link\}/);
    expect(openingsTemplatesProblem({ ...OPENINGS_TEMPLATES, emailBody: "Openings {day}" })).toMatch(/email needs \{book_link\}/);
    expect(openingsTemplatesProblem({ ...OPENINGS_TEMPLATES, sms: `${OPENINGS_TEMPLATES.sms} {coupon}` })).not.toBeNull();
    expect(openingsTemplatesProblem({ ...OPENINGS_TEMPLATES, sms: "{barber} has openings {day}: {book_link}" })).toMatch(/STOP/i);
  });

  it("a send needs a barber, a day and a channel", () => {
    const ok = { shopId: SHOP, staffIds: [OTHER], dates: [TODAY], channels: ["sms"] };
    expect(OpeningsInputSchema.parse(ok).lastVisitOverWeeks).toBeNull();
    expect(OpeningsInputSchema.safeParse({ ...ok, staffIds: [] }).success).toBe(false);
    expect(OpeningsInputSchema.safeParse({ ...ok, channels: [] }).success).toBe(false);
    expect(OpeningsInputSchema.safeParse({ ...ok, channels: ["push"] }).success).toBe(false);
    expect(OpeningsInputSchema.safeParse({ ...ok, lastVisitOverWeeks: 0 }).success).toBe(false);
  });
});
