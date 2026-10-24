import { describe, expect, it } from "vitest";
import type { PanelSees } from "@/domain/client-filters";
import { EMPTY_SEGMENT } from "@/domain/marketing";
import {
  CUSTOMER_FIELDS,
  DEFAULT_CUSTOMER_REPORT,
  ReportDefinition,
  ReportSchedule,
  SavedReportInput,
  aggsFor,
  cellText,
  cellValue,
  definitionProblem,
  duePeriod,
  fieldDef,
  fieldUse,
  flatTable,
  nextSend,
  rangeLabel,
  reportRange,
  scheduleLabel,
  segmentFromReport,
  sendsOn,
  type ReportResult,
} from "@/domain/report-builder";

const CUSTOM = [{ id: "11111111-2222-4333-8444-555555555555", label: "Beard style" }];
const ALL: PanelSees = { levels: { phone: "full", email: "full", address: "full", birthday: "full", preferred_barber: "full", ratings: "full", [`custom:${CUSTOM[0].id}`]: "full" }, money: true };
const MASKED: PanelSees = { levels: { phone: "masked", email: "masked", address: "masked", birthday: "masked", preferred_barber: "masked", ratings: "masked", [`custom:${CUSTOM[0].id}`]: "masked" }, money: false };
const HIDDEN: PanelSees = { levels: { phone: "hidden", email: "hidden", address: "hidden", birthday: "hidden", preferred_barber: "hidden", ratings: "hidden", [`custom:${CUSTOM[0].id}`]: "hidden" }, money: false };
const f = (key: string) => fieldDef(key, CUSTOM)!;
const def = (x: Record<string, unknown>) => ReportDefinition.parse({ columns: [{ field: "name" }], ...x });

describe("fields", () => {
  it("covers every customer field the brand asked for, each with a unique key", () => {
    const keys = CUSTOMER_FIELDS.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ["name", "phone", "email", "birthday", "address", "city", "zip", "tags", "rating", "home_location", "primary_barber", "first_visit", "last_visit", "visits", "avg_gap_days", "total_spend", "avg_spend", "services_bought", "products_bought", "tips", "no_shows", "cancellations", "loyalty_balance", "gift_cards", "coupons_redeemed", "sms_opt_in", "email_marketing", "campaigns_received", "campaigns_clicked", "review_clicks", "source", "created"])
      expect(keys).toContain(k);
    expect(fieldDef(`custom:${CUSTOM[0].id}`, CUSTOM)?.label).toBe("Beard style");
    expect(fieldDef("custom:99999999-2222-4333-8444-555555555555", CUSTOM)).toBeNull();
    expect(fieldDef("password_hash", CUSTOM)).toBeNull();
  });

  it("follows Client data: hidden details can't be used, masked ones are masked, town, zip and the average rating still show", () => {
    expect(fieldUse(f("phone"), ALL).use).toBe("full");
    expect(fieldUse(f("phone"), MASKED).use).toBe("masked");
    expect(fieldUse(f("phone"), HIDDEN)).toEqual({ use: "none", why: "Phone is hidden from you under Client data" });
    expect(fieldUse(f("city"), MASKED).use).toBe("full");
    expect(fieldUse(f("zip"), HIDDEN).use).toBe("none");
    expect(fieldUse(f("rating"), MASKED).use).toBe("full");
    expect(fieldUse(f("rating"), HIDDEN).use).toBe("none");
    expect(fieldUse(f(`custom:${CUSTOM[0].id}`), HIDDEN)).toEqual({ use: "none", why: "Beard style is hidden from you under Client data" });
    expect(fieldUse(f("visits"), HIDDEN).use).toBe("full");
  });

  it("keeps spend, tips and gift cards for people who see every client", () => {
    for (const k of ["total_spend", "avg_spend", "tips", "tickets", "gift_cards", "gift_card_balance"]) expect(fieldUse(f(k), { ...ALL, money: false }).use).toBe("none");
    expect(fieldUse(f("loyalty_balance"), { ...ALL, money: false }).use).toBe("full");
  });

  it("offers totals that make sense for the type", () => {
    expect(aggsFor("money")).toEqual(["none", "sum", "avg", "count", "min", "max"]);
    expect(aggsFor("stars")).toEqual(["none", "avg", "count", "min", "max"]);
    expect(aggsFor("date")).toEqual(["none", "count", "min", "max"]);
    expect(aggsFor("text")).toEqual(["none", "count"]);
    expect(aggsFor("list")).toEqual(["none", "count"]);
  });
});

describe("definitions", () => {
  it("parses with defaults and limits", () => {
    const d = ReportDefinition.parse({ columns: [{ field: "name" }] });
    expect(d).toMatchObject({ source: "customers", sort: [], groupBy: [], summary: false, totals: true, rows: "all", shops: null, staff: null, range: { preset: "all", from: null, to: null } });
    expect(d.filter).toEqual(EMPTY_SEGMENT);
    expect(ReportDefinition.safeParse({ columns: [] }).success).toBe(false);
    expect(ReportDefinition.safeParse({ columns: Array.from({ length: 41 }, () => ({ field: "name" })) }).success).toBe(false);
    expect(ReportDefinition.safeParse({ columns: [{ field: "name", label: "x".repeat(61) }] }).success).toBe(false);
    expect(ReportDefinition.safeParse({ columns: [{ field: "name", agg: "median" }] }).success).toBe(false);
    expect(ReportDefinition.safeParse({ columns: [{ field: "name" }], groupBy: ["a", "b", "c"] }).success).toBe(false);
    expect(definitionProblem(DEFAULT_CUSTOMER_REPORT, ALL, CUSTOM)).toBeNull();
  });

  it("refuses sources that aren't ready and fields that don't exist", () => {
    expect(definitionProblem(def({ source: "sales" }), ALL, CUSTOM)).toMatch(/Sales reports are coming next/);
    expect(definitionProblem(def({ columns: [{ field: "c.password_hash" }] }), ALL, CUSTOM)).toMatch(/isn't a field/);
    expect(definitionProblem(def({ sort: [{ field: "1; drop table customers" }] }), ALL, CUSTOM)).toMatch(/sort fields isn't available/);
    expect(definitionProblem(def({ groupBy: ["nope"] }), ALL, CUSTOM)).toMatch(/grouping fields isn't available/);
  });

  it("refuses hidden details, money without every client, and anything that would give away a masked value", () => {
    expect(definitionProblem(def({ columns: [{ field: "phone" }] }), HIDDEN, CUSTOM)).toMatch(/can't add "Phone": phone is hidden/);
    expect(definitionProblem(def({ columns: [{ field: "total_spend", agg: "sum" }] }), MASKED, CUSTOM)).toMatch(/every client/);
    expect(definitionProblem(def({ columns: [{ field: "birthday", agg: "min" }] }), MASKED, CUSTOM)).toMatch(/masked for you, so it can only be counted/);
    expect(definitionProblem(def({ columns: [{ field: "birthday", agg: "count" }] }), MASKED, CUSTOM)).toBeNull();
    expect(definitionProblem(def({ sort: [{ field: "email", dir: "asc" }] }), MASKED, CUSTOM)).toMatch(/don't see it in full/);
    expect(definitionProblem(def({ groupBy: ["primary_barber"] }), MASKED, CUSTOM)).toMatch(/don't see it in full/);
    expect(definitionProblem(def({ groupBy: ["city"] }), MASKED, CUSTOM)).toBeNull();
    expect(definitionProblem(def({ columns: [{ field: "name", agg: "sum" }] }), ALL, CUSTOM)).toMatch(/can't be totalled as sum/);
  });

  it("checks sorting, grouping, summaries and dates", () => {
    expect(definitionProblem(def({ groupBy: ["tags"] }), ALL, CUSTOM)).toMatch(/Lists like "Tags" can't be grouped/);
    expect(definitionProblem(def({ sort: [{ field: "services_bought" }] }), ALL, CUSTOM)).toMatch(/can't be sorted/);
    expect(definitionProblem(def({ groupBy: ["source", "source"] }), ALL, CUSTOM)).toMatch(/two different fields/);
    expect(definitionProblem(def({ summary: true }), ALL, CUSTOM)).toMatch(/group by for a summary/);
    expect(definitionProblem(def({ range: { preset: "custom", from: "2026-01-01" } }), ALL, CUSTOM)).toMatch(/both dates/);
    expect(definitionProblem(def({ range: { preset: "forever" } }), ALL, CUSTOM)).toMatch(/Pick a date range/);
  });

  it("uses the segment builder's rules for filters, and needs the filter permission to add them", () => {
    expect(definitionProblem(def({ filter: { ...EMPTY_SEGMENT, minRating: 4 } }), HIDDEN, CUSTOM)).toMatch(/ratings are hidden/);
    expect(definitionProblem(def({ filter: { ...EMPTY_SEGMENT, minSpendCents: 100 } }), MASKED, CUSTOM)).toMatch(/every client/);
    expect(definitionProblem(def({ filter: { ...EMPTY_SEGMENT, minVisits: 3 } }), ALL, CUSTOM, { filters: false })).toMatch(/advanced client filters/);
    expect(definitionProblem(def({ filter: { ...EMPTY_SEGMENT, minVisits: 3 } }), ALL, CUSTOM)).toBeNull();
  });

  it("turns presets into dates", () => {
    expect(reportRange({ preset: "all", from: null, to: null }, "2026-10-24")).toBeNull();
    expect(reportRange({ preset: "30d", from: null, to: null }, "2026-10-24")).toEqual({ from: "2026-09-25", to: "2026-10-24" });
    expect(reportRange({ preset: "custom", from: "2026-10-10", to: "2026-10-01" }, "2026-10-24")).toEqual({ from: "2026-10-01", to: "2026-10-10" });
    expect(rangeLabel({ preset: "month", from: null, to: null }, "2026-10-24")).toBe("This month (Oct 1 – Oct 24, 2026)");
    expect(rangeLabel({ preset: "all", from: null, to: null }, "2026-10-24")).toBe("All time");
  });
});

describe("cells", () => {
  it("formats for the page and for files", () => {
    expect(cellText("money", 123456)).toBe("$1,234.56");
    expect(cellValue("money", 123456)).toBe(1234.56);
    expect(cellText("date", "2026-03-05")).toBe("Mar 5, 2026");
    expect(cellValue("date", "2026-03-05")).toBe("2026-03-05");
    expect(cellText("list", ["Fade", "Beard trim"])).toBe("Fade, Beard trim");
    expect(cellValue("list", ["Fade", "Beard trim"])).toBe("Fade; Beard trim");
    expect(cellText("bool", true)).toBe("Yes");
    expect(cellValue("bool", false)).toBe("no");
    expect(cellText("number", 21.456)).toBe("21.5");
    expect(cellText("stars", 4)).toBe("4.0");
    expect(cellText("int", null)).toBe("");
    expect(cellText("text", "***-***-4321", true)).toBe("***-***-4321");
    expect(cellValue("int", "***", true)).toBe("***");
  });
});

describe("flat tables for exports", () => {
  const columns: ReportResult["columns"] = [
    { key: "name", label: "Name", type: "text", agg: "none", masked: false },
    { key: "total_spend", label: "Total spend", type: "money", agg: "sum", masked: false },
  ];
  const groupBy: ReportResult["groupBy"] = [{ key: "home_location", label: "Home location", type: "text" }];

  it("repeats each group on its clients' rows, with a subtotal line per group and the total last", () => {
    const t = flatTable(
      {
        columns,
        groupBy,
        lines: [
          { kind: "group", level: 0, values: ["Moline"], count: 2, cells: [null, 5000] },
          { kind: "row", id: "a", cells: ["Ann", 2000] },
          { kind: "row", id: "b", cells: ["Bo", 3000] },
          { kind: "group", level: 0, values: ["Kimberly"], count: 1, cells: [null, 100] },
          { kind: "row", id: "c", cells: ["Cy", 100] },
        ],
        totals: { count: 3, cells: [null, 5100] },
      },
      false,
    );
    expect(t.headers).toEqual(["Home location", "Name", "Total spend"]);
    expect(t.rows.map((r) => [r.kind, ...r.cells])).toEqual([
      ["group", "Moline (subtotal, 2 clients)", null, 5000],
      ["row", "Moline", "Ann", 2000],
      ["row", "Moline", "Bo", 3000],
      ["group", "Kimberly (subtotal, 1 client)", null, 100],
      ["row", "Kimberly", "Cy", 100],
      ["total", "Total (3 clients)", null, 5100],
    ]);
  });

  it("is one line per group in a summary, and adds a label column for an ungrouped total", () => {
    const s = flatTable({ columns, groupBy, lines: [{ kind: "group", level: 0, values: ["Moline"], count: 2, cells: [null, 5000] }], totals: { count: 2, cells: [null, 5000] } }, true);
    expect(s.headers).toEqual(["Home location", "Clients", "Sum of Total spend"]);
    expect(s.rows.map((r) => r.cells)).toEqual([
      ["Moline", 2, 5000],
      ["Total (2 clients)", 2, 5000],
    ]);
    const u = flatTable({ columns, groupBy: [], lines: [{ kind: "row", id: "a", cells: ["Ann", 2000] }], totals: { count: 1, cells: [null, 2000] } }, false);
    expect(u.headers).toEqual(["", "Name", "Total spend"]);
    expect(u.rows.map((r) => r.cells)).toEqual([
      [null, "Ann", 2000],
      ["Total (1 client)", null, 2000],
    ]);
  });
});

describe("schedules", () => {
  const weekly = ReportSchedule.parse({ frequency: "weekly", weekday: 1, timeMin: 7 * 60 + 30, format: "xlsx" });
  const monthly = ReportSchedule.parse({ frequency: "monthly", monthDay: 3, format: "none" });

  it("sends on its day once it's past its time", () => {
    expect(sendsOn(weekly, "2026-10-26")).toBe(true);
    expect(sendsOn(weekly, "2026-10-27")).toBe(false);
    expect(sendsOn(monthly, "2026-11-03")).toBe(true);
    expect(duePeriod(weekly, "2026-10-26", 7 * 60)).toBeNull();
    expect(duePeriod(weekly, "2026-10-26", 7 * 60 + 30)).toBe("2026-10-26");
    expect(duePeriod(weekly, "2026-10-26", 23 * 60)).toBe("2026-10-26");
    expect(nextSend(weekly, "2026-10-24", 0)).toBe("2026-10-26");
    expect(nextSend(weekly, "2026-10-26", 8 * 60)).toBe("2026-11-02");
    expect(nextSend(monthly, "2026-10-24", 0)).toBe("2026-11-03");
  });

  it("describes itself", () => {
    expect(scheduleLabel(weekly)).toBe("Every Monday at 7:30 AM, with Excel");
    expect(scheduleLabel(monthly)).toBe("The 3rd of every month at 7:00 AM");
    expect(scheduleLabel(ReportSchedule.parse({ frequency: "daily", timeMin: 18 * 60 }))).toBe("Every day at 6:00 PM, with CSV");
  });

  it("validates what's saved", () => {
    expect(ReportSchedule.safeParse({ frequency: "monthly", monthDay: 31 }).success).toBe(false);
    expect(ReportSchedule.safeParse({ frequency: "hourly" }).success).toBe(false);
    expect(ReportSchedule.safeParse({ frequency: "daily", recipients: ["not-an-id"] }).success).toBe(false);
    expect(SavedReportInput.safeParse({ name: " ", definition: DEFAULT_CUSTOMER_REPORT }).success).toBe(false);
    expect(SavedReportInput.safeParse({ name: "Mine", visibility: "everyone", definition: DEFAULT_CUSTOMER_REPORT }).success).toBe(false);
  });
});

describe("Message these clients", () => {
  it("keeps the filters, adds the barbers and a last visit since the range's start, and hands over the locations", () => {
    const d = def({ filter: { ...EMPTY_SEGMENT, minVisits: 3 }, range: { preset: "30d" }, rows: "visited" });
    const r = segmentFromReport(d, { shopIds: ["s1"], staffIds: ["b1"] }, "2026-10-24");
    expect(r.segment).toMatchObject({ minVisits: 3, staffIds: ["b1"], barberMatch: "any", lastVisitFrom: "2026-09-25", shopIds: [] });
    expect(r.shopIds).toEqual(["s1"]);
    expect(r.notes.join(" ")).toMatch(/agreed to marketing/);
  });

  it("can't carry a range that ended before today, and says so", () => {
    const r = segmentFromReport(def({ range: { preset: "lastmonth" }, rows: "visited" }), { shopIds: null, staffIds: null }, "2026-10-24");
    expect(r.segment.lastVisitFrom).toBeNull();
    expect(r.shopIds).toEqual([]);
    expect(r.notes[0]).toMatch(/dates end before today/);
  });

  it("leaves every client of the locations alone when the report doesn't need a visit", () => {
    const r = segmentFromReport(def({ range: { preset: "30d" } }), { shopIds: null, staffIds: null }, "2026-10-24");
    expect(r.segment).toEqual(EMPTY_SEGMENT);
  });
});
