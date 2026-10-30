import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BACKFILL_TABLES, CATEGORIES, EVENTS, EVENT_COLUMNS, FUNNEL_STEPS, analyticsSettings, deviceClass, eventCategory, funnelBeacon } from "@/domain/analytics";
import { stubPlan } from "@/domain/assistant";
import { EVENT_FIELDS, EVENT_TYPES, REPORT_SOURCES, ReportDefinition, defaultReport, definitionProblem, fieldDef, flatTable, isEventType } from "@/domain/report-builder";

vi.mock("server-only", () => ({}));

const migration = readFileSync("drizzle/core_0059_analytics.sql", "utf8");
const readme = readFileSync("README.md", "utf8");
const SEES = { levels: {}, money: true, badges: [] };

describe("the event catalog", () => {
  it("names every event category.action, in a known category", () => {
    for (const k of Object.keys(EVENTS)) {
      expect(k).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(Object.keys(CATEGORIES)).toContain(eventCategory(k));
    }
    for (const s of FUNNEL_STEPS) expect(EVENTS).toHaveProperty(`funnel.${s}`);
    expect(EVENTS).toHaveProperty("funnel.abandoned");
  });

  it("lists every event the migration's triggers write, and every status they build a name from", () => {
    const cats = Object.keys(CATEGORIES).join("|");
    const literals = [...migration.matchAll(new RegExp(`'((?:${cats})\\.[a-z_]+)'`, "g"))].map((x) => x[1]);
    expect(literals.length).toBeGreaterThan(50);
    expect(literals.filter((e) => !(e in EVENTS))).toEqual([]);
    // Built from a status: clock.<type>, message.<status>, time_off.<status>, walkin.<status>.
    for (const e of ["clock.in", "clock.out", "clock.break_start", "clock.break_end", "message.sent", "message.failed", "message.suppressed", "message.cancelled", "time_off.approved", "time_off.denied", "time_off.cancelled", "walkin.notified", "walkin.serving", "walkin.done", "walkin.left"])
      expect(EVENTS).toHaveProperty(e);
    for (const t of BACKFILL_TABLES) expect(migration).toContain(`"analytics_${t}"`);
  });

  it("is the README's event schema: every column and every event with its code", () => {
    const section = readme.slice(readme.indexOf("## Event log"));
    expect(section.length).toBeGreaterThan(1000);
    for (const c of EVENT_COLUMNS) expect(section).toContain(`\`${c.key}\``);
    for (const k of Object.keys(EVENTS)) expect(section).toContain(`\`${k}\``);
    for (const k of Object.keys(CATEGORIES)) expect(section).toContain(`\`${k}\``);
  });

  it("never names a contact detail, card or bank field as a column", () => {
    for (const c of EVENT_COLUMNS) expect(c.key).not.toMatch(/phone|email|address|name|card|last4|bank|routing|account|ssn|ip/);
  });
});

describe("device, beacon and settings", () => {
  it("tells phones, tablets and computers apart", () => {
    expect(deviceClass("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe("phone");
    expect(deviceClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36")).toBe("phone");
    expect(deviceClass("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceClass("Mozilla/5.0 (Linux; Android 13; SM-X200) Safari/537.36")).toBe("tablet");
    expect(deviceClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15")).toBe("desktop");
    expect(deviceClass(null)).toBeNull();
  });

  it("takes ids, slugs and codes in a beacon but nothing that could be a person", () => {
    expect(funnelBeacon.safeParse({ funnel: "w0123456789abcdef", step: "viewed", shop: "coralville" }).success).toBe(true);
    expect(funnelBeacon.safeParse({ funnel: "short", step: "viewed", shop: "coralville" }).success).toBe(false);
    expect(funnelBeacon.safeParse({ funnel: "w0123456789abcdef", step: "viewed", shop: "jane@example.com" }).success).toBe(false);
    expect(funnelBeacon.safeParse({ funnel: "w0123456789abcdef", step: "paid", shop: "coralville" }).success).toBe(false);
  });

  it("reads settings defensively", () => {
    expect(analyticsSettings(null)).toEqual({ satisfaction: false, warehouse: false, backfilled: [] });
    expect(analyticsSettings({ satisfaction: true, warehouse: "yes", backfilled: ["sales", "nope", 3] })).toEqual({ satisfaction: true, warehouse: false, backfilled: ["sales"] });
  });

  it("only counts a retention window once it has closed", async () => {
    const { cohortWindowClosed } = await import("@/server/operations-report");
    expect(cohortWindowClosed("2026-01", 1, "2026-02-28")).toBe(false);
    expect(cohortWindowClosed("2026-01", 1, "2026-03-01")).toBe(true);
    expect(cohortWindowClosed("2025-12", 3, "2026-03-31")).toBe(false);
    expect(cohortWindowClosed("2025-12", 3, "2026-04-01")).toBe(true);
  });
});

describe("the event log in the report builder", () => {
  it("is a ready source with its own fields and event types", () => {
    expect(REPORT_SOURCES.find((s) => s.key === "events")?.ready).toBe(true);
    expect(new Set(EVENT_FIELDS.map((f) => f.key)).size).toBe(EVENT_FIELDS.length);
    expect(fieldDef("event", [], "events")?.label).toBe("Event");
    expect(fieldDef("name", [], "events")).toBeNull();
    expect(fieldDef("event", [], "customers")).toBeNull();
    expect(EVENT_TYPES.every((t) => isEventType(t.key))).toBe(true);
    expect(EVENT_FIELDS.some((f) => f.reads)).toBe(false);
    expect(EVENT_FIELDS.find((f) => f.key === "amount")?.money).toBe(true);
  });

  it("checks an event report's types and refuses client filters on it", () => {
    expect(definitionProblem(defaultReport("events"), SEES, [])).toBeNull();
    expect(definitionProblem(ReportDefinition.parse({ ...defaultReport("events"), eventTypes: ["booking", "ticket.paid"] }), SEES, [])).toBeNull();
    expect(definitionProblem(ReportDefinition.parse({ ...defaultReport("events"), eventTypes: ["booking.vanished"] }), SEES, [])).toMatch(/isn't logged/);
    expect(definitionProblem(ReportDefinition.parse({ ...defaultReport("events"), filter: { ...defaultReport("events").filter, minVisits: 3 } }), SEES, [])).toMatch(/Client filters/);
    expect(definitionProblem(ReportDefinition.parse({ ...defaultReport("events"), columns: [{ field: "amount", agg: "sum" }] }), { ...SEES, money: false }, [])).toMatch(/can't add "Amount"/);
    expect(definitionProblem(ReportDefinition.parse({ ...defaultReport("customers"), eventTypes: ["booking"] }), SEES, [])).toMatch(/event log reports/);
  });

  it("counts events, not clients, in files", () => {
    const t = flatTable({ columns: [{ key: "events", label: "Events", type: "int", agg: "sum", masked: false }], groupBy: [{ key: "event", label: "Event", type: "text" }], lines: [{ kind: "group", level: 0, values: ["Booking made"], count: 3, cells: [3] }], totals: { count: 3, cells: [3] }, noun: "event" }, true);
    expect(t.headers).toEqual(["Event", "Events", "Sum of Events"]);
    expect(t.rows.at(-1)?.cells[0]).toBe("Total (3 events)");
  });
});

describe("the assistant's demo router", () => {
  const o = { tools: ["run_report", "customer_report", "event_report", "help"], reports: ["sales_summary", "operations"], shops: ["Ray'z Coralville"], barbers: [] };
  it("sends questions about single actions to the event log, when it's offered", () => {
    expect(stubPlan("How many late cancellations last month?", o)).toEqual({ name: "event_report", args: { eventTypes: ["booking.cancelled"], groupBy: ["subtype"], preset: "lastmonth" } });
    expect(stubPlan("How many people dropped off in the booking funnel this week?", o)).toMatchObject({ name: "event_report", args: { eventTypes: ["funnel"] } });
    expect(stubPlan("How many late cancellations last month?", { ...o, tools: ["run_report", "help"] })?.name).toBe("run_report");
    expect(stubPlan("What's our average ticket and utilization?", o)).toMatchObject({ name: "run_report", args: { report: "operations" } });
  });
});
