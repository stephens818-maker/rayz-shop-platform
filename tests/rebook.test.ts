/**
 * The Rebook Rate report without a database: its options, trend periods, the rates from counts,
 * points against the brand, the leaderboard's ranking, the percent fields in custom reports, who
 * gets the report by default, and the assistant routing rebook questions to it.
 */
import { describe, expect, it } from "vitest";
import { stubPlan } from "@/domain/assistant";
import { ROLE_TEMPLATES, effectiveAccess, reportExport, reportView } from "@/domain/permissions";
import {
  type RebookCounts,
  parseClientType,
  parseRankBy,
  parseTrend,
  parseWindow,
  periodLabel,
  periodStarts,
  ptsLabel,
  rankBoard,
  rebookRates,
  windowDays,
  zeroCounts,
} from "@/domain/rebook";
import { CUSTOMER_FIELDS, aggsFor, cellText, cellValue } from "@/domain/report-builder";

const counts = (o: Partial<RebookCounts>): RebookCounts => ({ ...zeroCounts(), ...o });

describe("options", () => {
  it("falls back to 45 days, all clients and the rebook rate", () => {
    expect([parseWindow("30"), parseWindow("60"), parseWindow("own"), parseWindow("90"), parseWindow(undefined)]).toEqual([30, 60, "own", 45, 45]);
    expect(windowDays("own")).toBe(60);
    expect(windowDays(30)).toBe(30);
    expect([parseClientType("new"), parseClientType("returning"), parseClientType("x")]).toEqual(["new", "returning", "all"]);
    expect([parseRankBy("second_visit"), parseRankBy("toString"), parseRankBy(null)]).toEqual(["second_visit", "rebook", "rebook"]);
  });

  it("trends weekly up to about a quarter, monthly beyond, unless asked", () => {
    expect(parseTrend(undefined, "2026-08-01", "2026-10-25")).toBe("week");
    expect(parseTrend(undefined, "2026-01-01", "2026-10-25")).toBe("month");
    expect(parseTrend("month", "2026-10-01", "2026-10-25")).toBe("month");
  });

  it("lists every week from Sunday, and every month, even empty ones", () => {
    expect(periodStarts("2026-10-07", "2026-10-20", "week")).toEqual(["2026-10-04", "2026-10-11", "2026-10-18"]);
    expect(periodStarts("2026-10-04", "2026-10-04", "week")).toEqual(["2026-10-04"]);
    expect(periodStarts("2026-11-15", "2027-01-03", "month")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(periodLabel("2026-10-04", "week")).toBe("Week of Oct 4");
    expect(periodLabel("2026-11-01", "month")).toBe("Nov 2026");
  });
});

describe("rates", () => {
  it("divides by visits with a booking time, judged clients and judged new clients", () => {
    const c = counts({ visits: 12, known: 10, rebooked: 6, newKnown: 4, newRebooked: 1, clients: 8, judged: { 30: 8, 45: 6, 60: 4, own: 5 }, back: { 30: 4, 45: 3, 60: 3, own: 4 }, newJudged: 2, newBack: 1, prebookedClients: 2 });
    const r = rebookRates(c, 45);
    expect(r).toMatchObject({ rebook: 0.6, newRebook: 0.25, returned: 0.5, secondVisit: 0.5, prebooked: 0.25 });
    expect(r.back).toEqual({ 30: 0.5, 45: 0.5, 60: 0.75, own: 0.8 });
    expect(rebookRates(c, "own").returned).toBe(0.8);
  });

  it("has no rate rather than 0% when there's nothing to judge", () => {
    expect(rebookRates(zeroCounts(), 30)).toMatchObject({ rebook: null, newRebook: null, returned: null, secondVisit: null, prebooked: null });
  });

  it("compares with the brand in points", () => {
    expect(ptsLabel(0.54, 0.5)).toBe("+4 pts");
    expect(ptsLabel(0.47, 0.5)).toBe("−3 pts");
    expect(ptsLabel(0.502, 0.5)).toBe("even");
    expect(ptsLabel(null, 0.5)).toBeNull();
    expect(ptsLabel(0.5, null)).toBeNull();
  });
});

describe("leaderboard", () => {
  const item = (name: string, known: number, rebooked: number, o: Partial<RebookCounts> = {}) => ({ name, counts: counts({ visits: known, known, rebooked, ...o }) });

  it("ranks highest first, ties by name, and lists small samples last without a rank", () => {
    const board = rankBoard([item("Cy", 20, 10), item("Ana", 20, 15), item("Bo", 10, 5), item("Dee", 3, 3), item("Eli", 0, 0)], "rebook", 45);
    expect(board.map((x) => [x.item.name, x.rank, x.value])).toEqual([
      ["Ana", 1, 0.75],
      ["Bo", 2, 0.5],
      ["Cy", 3, 0.5],
      ["Dee", null, 1],
      ["Eli", null, null],
    ]);
  });

  it("ranks by the measure's own base", () => {
    const a = item("Ana", 30, 15, { newKnown: 4, newRebooked: 4 });
    const b = item("Bo", 30, 10, { newKnown: 12, newRebooked: 6 });
    expect(rankBoard([a, b], "new_rebook", 45).map((x) => [x.item.name, x.rank])).toEqual([
      ["Bo", 1],
      ["Ana", null],
    ]);
    const j = { 30: 0, 45: 10, 60: 0, own: 0 };
    const ret = rankBoard([item("Ana", 30, 15, { judged: j, back: { ...j, 45: 4 } }), item("Bo", 30, 10, { judged: j, back: { ...j, 45: 8 } })], "return", 45);
    expect(ret.map((x) => x.item.name)).toEqual(["Bo", "Ana"]);
    expect(rankBoard([a, b], "return", 30).every((x) => x.rank === null)).toBe(true);
  });
});

describe("custom report fields", () => {
  it("adds the rebooking fields, with percents shown and exported as percents", () => {
    const keys = CUSTOMER_FIELDS.filter((f) => f.group === "Rebooking").map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["visits_rebooked", "rebook_rate", "first_visit_rebooked", "second_visit", "days_to_second_visit", "next_booked", "future_appointments"]));
    expect(CUSTOMER_FIELDS.find((f) => f.key === "rebook_rate")?.type).toBe("pct");
    expect(cellText("pct", 0.456)).toBe("46%");
    expect(cellValue("pct", 0.456)).toBe("45.6%");
    expect(cellText("pct", null)).toBe("");
    expect(aggsFor("pct")).toEqual(["none", "avg", "count", "min", "max"]);
  });
});

describe("who gets it", () => {
  const perms = (key: string) => effectiveAccess(ROLE_TEMPLATES.find((t) => t.key === key)!, {}, null).permissions;

  it("lets barbers see their own rate, and managers and the shop login see and export it", () => {
    expect(perms("barber").has(reportView("rebook_rate"))).toBe(true);
    expect(perms("barber").has(reportExport("rebook_rate"))).toBe(false);
    expect(perms("shop_manager").has(reportView("rebook_rate"))).toBe(true);
    expect(perms("shop_manager").has(reportExport("rebook_rate"))).toBe(true);
    expect(perms("shop_login").has(reportView("rebook_rate"))).toBe(true);
  });
});

describe("the assistant", () => {
  const opts = { tools: ["run_report", "help"], reports: ["kpis", "rebook_rate", "sales_summary"], shops: ["Ray'z Coralville"], barbers: ["Makenna R."] };

  it("sends rebook, return and 2nd-visit questions to the Rebook Rate report", () => {
    for (const q of ["What's our rebook rate this month?", "How many new clients came back for a 2nd visit?", "Return rate at Coralville last quarter", "How many future appointments are booked?"])
      expect(stubPlan(q, opts)).toMatchObject({ name: "run_report", args: { report: "rebook_rate" } });
  });

  it("falls back to the KPIs without the report", () => {
    expect(stubPlan("What's our rebook rate?", { ...opts, reports: ["kpis"] })).toMatchObject({ args: { report: "kpis" } });
  });
});
