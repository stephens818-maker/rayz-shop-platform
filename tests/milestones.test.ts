import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RULES,
  BirthdayInput,
  MilestoneSettings,
  RuleInput,
  anniversaryDate,
  bestIsNews,
  bestRecord,
  birthdayIn,
  SHOP_SHOWN,
  clientPhrase,
  congratsLine,
  dayLine,
  eventIndexFor,
  milestoneSentence,
  milestoneSettings,
  milestoneTitle,
  ordinal,
  paceDate,
  parseThresholds,
  recordedSentence,
  ruleProblem,
  seesMilestonesOf,
  streakHits,
  tenureLabel,
  thresholdProgress,
  upcomingSentence,
  welcomeLine,
  whenLabel,
} from "@/domain/milestones";

const SUNDAY = "2026-10-25";

describe("milestone settings", () => {
  it("defaults to on, alerts to the brand and managers, congratulations, client celebrations, no birthdays and no team feed", () => {
    expect(milestoneSettings(undefined)).toEqual({
      enabled: true,
      birthdays: false,
      alertBrand: true,
      alertManagers: true,
      congratulate: true,
      teamFeed: false,
      celebrate: true,
      upcomingDays: 7,
      calendarBanner: true,
      posBanner: true,
      columnBadge: true,
      welcomeModal: true,
      liveToast: true,
      allLocations: false,
    });
  });

  it("keeps the good fields of a damaged value", () => {
    expect(
      milestoneSettings({ teamFeed: true, upcomingDays: 99 }),
    ).toMatchObject({ teamFeed: true, upcomingDays: 7 });
    expect(MilestoneSettings.safeParse({ upcomingDays: 0 }).success).toBe(
      false,
    );
  });
});

describe("milestone rules", () => {
  it("ships the built-ins the request names", () => {
    const by = Object.fromEntries(BUILT_IN_RULES.map((r) => [r.key, r]));
    expect(by.services.thresholds).toEqual([100, 500, 1000, 5000, 10000]);
    expect(by.anniversary.thresholds).toEqual([1, 5, 10]);
    expect(BUILT_IN_RULES.map((r) => r.metric)).toEqual(
      expect.arrayContaining([
        "clients",
        "new_clients",
        "rebooks",
        "products",
        "birthday",
        "sales_day",
        "sales_week",
        "sales_month",
        "cuts_day",
        "rebook_month",
        "five_star",
        "on_time",
      ]),
    );
  });

  it("reads numbers typed with commas or spaces, and refuses anything else", () => {
    expect(parseThresholds("1000, 100  500,500")).toEqual([100, 500, 1000]);
    expect(parseThresholds("100, 1.5")).toBeNull();
    expect(parseThresholds("")).toEqual([]);
  });

  it("checks what a rule counts against its kind", () => {
    const r = (x: Partial<RuleInput>) =>
      RuleInput.parse({
        kind: "count",
        metric: "services",
        name: "Fades",
        thresholds: [50],
        ...x,
      });
    expect(ruleProblem(r({}))).toBeNull();
    expect(ruleProblem(r({ metric: "sales_day" }))).toBe("Pick what it counts");
    expect(ruleProblem(r({ thresholds: [] }))).toBe(
      "Add at least one number to reach",
    );
    expect(
      ruleProblem(
        r({ kind: "anniversary", metric: "hire_date", thresholds: [] }),
      ),
    ).toBe("Add at least one year");
    expect(
      ruleProblem(
        r({ kind: "anniversary", metric: "hire_date", thresholds: [75] }),
      ),
    ).toBe("Anniversaries go up to 60 years");
    expect(
      ruleProblem(
        r({
          metric: "clients",
          serviceIds: ["11111111-1111-4111-8111-111111111111"],
        }),
      ),
    ).toBe("Only cuts and services can be limited to some services");
    expect(
      ruleProblem(r({ kind: "best", metric: "sales_day", thresholds: [] })),
    ).toBeNull();
    expect(
      ruleProblem(r({ kind: "best", metric: "sales_day", thresholds: [5] })),
    ).toBe("This one has no numbers to reach");
  });
});

describe("milestone wording", () => {
  it("says what was reached, leaving sales amounts out when asked", () => {
    expect(
      milestoneTitle({
        kind: "count",
        metric: "services",
        threshold: 1000,
        value: 1000,
        unit: "cuts",
      }),
    ).toBe("1,000 cuts");
    expect(
      milestoneTitle({
        kind: "count",
        metric: "services",
        threshold: 50,
        value: 50,
        unit: "beard trims",
      }),
    ).toBe("50 beard trims");
    expect(
      milestoneTitle({
        kind: "anniversary",
        metric: "hire_date",
        threshold: 5,
        value: 5,
      }),
    ).toBe("5-year work anniversary");
    expect(
      milestoneTitle({
        kind: "best",
        metric: "sales_week",
        threshold: null,
        value: 321_000,
      }),
    ).toBe("Best sales week: $3,210");
    expect(
      milestoneTitle(
        { kind: "best", metric: "sales_week", threshold: null, value: 321_000 },
        { money: false },
      ),
    ).toBe("New best sales week");
    expect(
      milestoneTitle({
        kind: "best",
        metric: "rebook_month",
        threshold: null,
        value: 625,
      }),
    ).toBe("Highest rebook rate: 63%");
    expect(
      milestoneSentence("Jamie", {
        kind: "best",
        metric: "cuts_day",
        threshold: null,
        value: 18,
      }),
    ).toBe("Jamie set a new record for cuts in a day: 18 cuts");
    expect(
      milestoneSentence(
        "Jamie",
        { kind: "best", metric: "sales_day", threshold: null, value: 123_400 },
        { money: false },
      ),
    ).toBe("Jamie set a new best sales day");
  });

  it("uses the title as recorded, and says it to the person", () => {
    const cuts = {
      kind: "count" as const,
      metric: "services",
      threshold: 1000,
      value: 1000,
      title: "1,000 cuts",
    };
    const years = {
      kind: "anniversary" as const,
      metric: "hire_date",
      threshold: 5,
      value: 5,
      title: "5-year work anniversary",
    };
    expect(recordedSentence("Jamie", cuts)).toBe("Jamie hit 1,000 cuts");
    expect(recordedSentence("Casey", years)).toBe(
      "Casey's 5-year work anniversary",
    );
    expect(congratsLine(cuts)).toBe("You hit 1,000 cuts");
    expect(congratsLine(years)).toBe("Your 5-year work anniversary");
    expect(
      congratsLine({
        kind: "birthday",
        metric: "birthday",
        threshold: null,
        value: null,
        title: "Birthday",
      }),
    ).toBe("Happy birthday");
  });

  it("only offers clients milestones about the work, never money, rates or ratings", () => {
    expect(
      clientPhrase({
        kind: "count",
        metric: "services",
        threshold: 1000,
        value: 1000,
        title: "1,000 cuts",
      }),
    ).toBe("1,000 cuts");
    expect(
      clientPhrase({
        kind: "anniversary",
        metric: "hire_date",
        threshold: 1,
        value: 1,
        title: "1-year work anniversary",
      }),
    ).toBe("1 year at Ray'z");
    expect(
      clientPhrase({
        kind: "anniversary",
        metric: "hire_date",
        threshold: 5,
        value: 5,
        title: "5-year work anniversary",
      }),
    ).toBe("5 years at Ray'z");
    expect(
      clientPhrase({
        kind: "count",
        metric: "products",
        threshold: 100,
        value: 100,
        title: "100 products sold",
      }),
    ).toBeNull();
    expect(
      clientPhrase({
        kind: "best",
        metric: "sales_day",
        threshold: null,
        value: 9,
        title: "Best sales day",
      }),
    ).toBeNull();
    expect(
      clientPhrase({
        kind: "streak",
        metric: "five_star",
        threshold: 10,
        value: 10,
        title: "10 5-star ratings in a row",
      }),
    ).toBeNull();
  });

  it("says when, the way the Morning Dashboard does", () => {
    expect(whenLabel(SUNDAY, SUNDAY)).toBe("today");
    expect(whenLabel("2026-10-26", SUNDAY)).toBe("tomorrow");
    expect(whenLabel("2026-10-30", SUNDAY)).toBe("Friday");
    expect(whenLabel("2026-11-03", SUNDAY)).toBe("Nov 3");
    expect(
      upcomingSentence(
        "Jamie",
        {
          kind: "count",
          metric: "services",
          unit: "cuts",
          threshold: 1000,
          value: null,
          staffId: "x",
          on: SUNDAY,
          sure: true,
          left: 2,
        },
        SUNDAY,
      ),
    ).toBe("Jamie hits 1,000 cuts today");
    expect(
      upcomingSentence(
        "Casey",
        {
          kind: "anniversary",
          metric: "hire_date",
          threshold: 5,
          value: null,
          staffId: "x",
          on: "2026-10-30",
          sure: true,
          left: null,
        },
        SUNDAY,
      ),
    ).toBe("Casey's 5-year work anniversary Friday");
    expect(
      upcomingSentence(
        "Kate",
        {
          kind: "count",
          metric: "clients",
          unit: "clients served",
          threshold: 500,
          value: null,
          staffId: "x",
          on: "2026-11-03",
          sure: false,
          left: 12,
        },
        SUNDAY,
      ),
    ).toBe("Kate should hit 500 clients served around Nov 3 (12 to go)");
  });
});

describe("milestone counts and dates", () => {
  it("counts a Squire total first, then the visits since", () => {
    expect(eventIndexFor(1000, { count: 990, asOf: "2026-01-01" })).toBe(10);
    expect(
      eventIndexFor(500, { count: 990, asOf: "2026-01-01" }),
    ).toBeLessThanOrEqual(0);
    expect(eventIndexFor(100, null)).toBe(100);
  });

  it("shows progress to the next number", () => {
    expect(thresholdProgress([100, 500, 1000], 750)).toEqual({
      reached: [100, 500],
      next: 1000,
      prev: 500,
      pct: 0.5,
    });
    expect(thresholdProgress([100], 150)).toMatchObject({ next: null, pct: 1 });
  });

  it("estimates the day from their pace, within the horizon only", () => {
    expect(paceDate(990, 1000, 5, SUNDAY, 7)).toBe("2026-10-27");
    expect(paceDate(900, 1000, 5, SUNDAY, 7)).toBeNull();
    expect(paceDate(990, 1000, 0, SUNDAY, 7)).toBeNull();
  });

  it("dates anniversaries and birthdays, Feb 29 on Feb 28 in other years", () => {
    expect(anniversaryDate("2021-10-30", 5)).toBe("2026-10-30");
    expect(anniversaryDate("2024-02-29", 1)).toBe("2025-02-28");
    expect(birthdayIn(2027, 2, 29)).toBe("2027-02-28");
    expect(birthdayIn(2028, 2, 29)).toBe("2028-02-29");
    expect(BirthdayInput.safeParse({ month: 4, day: 31 }).success).toBe(false);
    expect(BirthdayInput.safeParse(null).success).toBe(true);
    expect(tenureLabel("2021-10-30", SUNDAY)).toBe("4 years, 11 months");
  });
});

describe("personal bests and streaks", () => {
  const day = (period: string, value: number) => ({
    period,
    end: period,
    value,
    shopId: null,
  });

  it("keeps the first period with the highest value and the record it beat", () => {
    const r = bestRecord([
      day("2026-10-02", 300),
      day("2026-10-01", 200),
      day("2026-10-03", 500),
      day("2026-10-04", 500),
    ]);
    expect(r).toMatchObject({
      period: "2026-10-03",
      value: 500,
      previous: 300,
      history: 2,
    });
    expect(bestRecord([])).toBeNull();
  });

  it("announces a record only after enough history and soon after its period closed", () => {
    const before = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        period: `2026-08-${String(i + 1).padStart(2, "0")}`,
        end: "2026-09-01",
        value: 100,
        shopId: null,
      }));
    const record = day("2026-10-24", 900);
    const r = bestRecord([...before(31), record])!;
    expect(r).toMatchObject({ value: 900, previous: 100, history: 31 });
    expect(bestIsNews(r, "sales_day", SUNDAY)).toBe(true);
    expect(bestIsNews(r, "sales_day", "2026-11-10")).toBe(false);
    expect(
      bestIsNews(bestRecord([...before(5), record])!, "sales_day", SUNDAY),
    ).toBe(false);
    expect(bestIsNews(bestRecord([record])!, "sales_day", SUNDAY)).toBe(false);
  });

  it("counts each streak number once, the first time it's reached", () => {
    const ev = (ok: boolean, i: number) => ({
      id: String(i),
      day: `2026-10-${String(i + 1).padStart(2, "0")}`,
      shopId: null,
      ok,
    });
    const events = [true, true, true, false, true, true, true, true].map(ev);
    const s = streakHits(events, [3, 4]);
    expect(s.hits).toEqual([
      { threshold: 3, day: "2026-10-03", shopId: null, startId: "0" },
      { threshold: 4, day: "2026-10-08", shopId: null, startId: "4" },
    ]);
    expect(s).toMatchObject({ current: 4, longest: 4 });
  });
});

describe("who sees whose milestones", () => {
  const A = "shop-a";
  const B = "shop-b";
  const barber = { staffId: "me", brand: false, viewShops: [], workShops: [A] };
  const teammate = { staffId: "them", workShops: [A], shared: true };

  it("lets staff see only their own unless the team feed is on", () => {
    expect(
      seesMilestonesOf(barber, { ...teammate, staffId: "me" }, false),
    ).toBe("own");
    expect(seesMilestonesOf(barber, teammate, false)).toBeNull();
    expect(seesMilestonesOf(barber, teammate, true)).toBe("team");
    expect(
      seesMilestonesOf(barber, { ...teammate, shared: false }, true),
    ).toBeNull();
    expect(
      seesMilestonesOf(barber, { ...teammate, workShops: [B] }, true),
    ).toBeNull();
  });

  it("lets managers see everyone at their shops and the brand everyone", () => {
    expect(
      seesMilestonesOf(
        { ...barber, viewShops: [A] },
        { ...teammate, shared: false },
        false,
      ),
    ).toBe("manage");
    expect(
      seesMilestonesOf(
        { ...barber, viewShops: [A] },
        { ...teammate, workShops: [B] },
        false,
      ),
    ).toBeNull();
    expect(
      seesMilestonesOf(
        { ...barber, brand: true },
        { ...teammate, workShops: [B], shared: false },
        false,
      ),
    ).toBe("manage");
  });
});

describe("on the day", () => {
  const cut = (
    threshold: number,
    title = `${threshold.toLocaleString("en-US")} cuts`,
  ) => ({
    kind: "count" as const,
    metric: "services",
    threshold,
    value: threshold,
    title,
    builtIn: true,
  });

  it("says ordinals the way people do", () => {
    expect(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111, 112, 1000, 2503].map(ordinal),
    ).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
      "111th",
      "112th",
      "1,000th",
      "2,503rd",
    ]);
  });

  it("celebrates by first name: the nth cut, client or product, anniversaries and birthdays", () => {
    expect(dayLine("Jamie", cut(1000))).toBe("Today is Jamie's 1,000th cut!");
    expect(
      dayLine("Casey", {
        kind: "anniversary",
        metric: "hire_date",
        threshold: 5,
        value: 5,
        title: "5-year work anniversary",
      }),
    ).toBe("Happy 5-year anniversary, Casey!");
    expect(
      dayLine("Kat", {
        kind: "birthday",
        metric: "birthday",
        threshold: null,
        value: null,
        title: "Birthday",
      }),
    ).toBe("Happy birthday, Kat!");
    expect(
      dayLine("Jamie", {
        kind: "count",
        metric: "clients",
        threshold: 250,
        value: 250,
        title: "250 clients served",
        builtIn: true,
      }),
    ).toBe("Jamie served their 250th client today!");
    expect(
      dayLine("Jamie", {
        kind: "count",
        metric: "new_clients",
        threshold: 100,
        value: 100,
        title: "100 new clients",
        builtIn: true,
      }),
    ).toBe("Jamie welcomed their 100th new client today!");
    expect(
      dayLine("Jamie", {
        kind: "count",
        metric: "rebooks",
        threshold: 100,
        value: 100,
        title: "100 rebooks",
        builtIn: true,
      }),
    ).toBe("Today is Jamie's 100th rebook!");
    expect(
      dayLine("Jamie", {
        kind: "count",
        metric: "products",
        threshold: 100,
        value: 100,
        title: "100 products sold",
        builtIn: true,
      }),
    ).toBe("Jamie sold their 100th product today!");
    expect(
      dayLine("Jamie", {
        kind: "streak",
        metric: "on_time",
        threshold: 25,
        value: 25,
        title: "25 on-time starts in a row",
      }),
    ).toBe("Jamie hit 25 on-time starts in a row today!");
  });

  it("uses the title for the brand's own counts and a renamed unit", () => {
    expect(
      dayLine("Jamie", { ...cut(100, "100 beard trims"), builtIn: false }),
    ).toBe("Jamie hit 100 beard trims today!");
    expect(dayLine("Jamie", cut(1000, "1,000 haircuts"))).toBe(
      "Jamie hit 1,000 haircuts today!",
    );
    expect(dayLine("Jamie", { ...cut(1000), builtIn: false })).toBe(
      "Jamie hit 1,000 cuts today!",
    );
  });

  it("never puts money or client ratings in front of the shop", () => {
    for (const m of [
      "sales_day",
      "sales_week",
      "sales_month",
      "cuts_day",
      "rebook_month",
      "five_star",
    ] as const)
      expect(SHOP_SHOWN.has(m)).toBe(false);
    for (const m of [
      "services",
      "clients",
      "new_clients",
      "rebooks",
      "products",
      "hire_date",
      "birthday",
      "on_time",
    ] as const)
      expect(SHOP_SHOWN.has(m)).toBe(true);
  });

  it("congratulates them in their own words, leaving the amount out on a shared screen", () => {
    expect(welcomeLine(cut(1000))).toBe("Your 1,000th cut");
    expect(
      welcomeLine({
        kind: "anniversary",
        metric: "hire_date",
        threshold: 5,
        value: 5,
        title: "5-year work anniversary",
      }),
    ).toBe("Your 5-year work anniversary");
    const best = {
      kind: "best" as const,
      metric: "sales_day",
      threshold: null,
      value: 123_456,
      title: "Best sales day: $1,235",
    };
    expect(welcomeLine(best)).toBe("You set a new best sales day: $1,235");
    expect(welcomeLine(best, { money: false })).toBe(
      "You set a new best sales day",
    );
  });

  it("turns every display on by default, at the person's own shops only", () => {
    expect(milestoneSettings({})).toMatchObject({
      calendarBanner: true,
      posBanner: true,
      columnBadge: true,
      welcomeModal: true,
      liveToast: true,
      allLocations: false,
    });
    expect(
      MilestoneSettings.parse({ liveToast: false, allLocations: true }),
    ).toMatchObject({
      liveToast: false,
      allLocations: true,
      calendarBanner: true,
    });
  });
});
