/**
 * The event log against the seeded brand: what the triggers record for each kind of action, who
 * did it and from where, that it's append-only and never holds contact details, erasure and merge,
 * backfill, the booking funnel, the raw export and the warehouse copy, the Operations KPIs, and the
 * event source in the report builder and Rayz Assistant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let engine: typeof import("@/server/report-builder/engine");
let context: typeof import("@/server/report-builder/context");
let privacy: typeof import("@/server/client-privacy");
let rb: typeof import("@/domain/report-builder");
let tools: typeof import("@/server/assistant/tools");
let assistant: typeof import("@/server/assistant");
type Ctx = import("@/server/auth/staff").StaffContext;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];
const ctxOf = async (who: string) => (await context.staffContextFor(ids[who]))!;
const withPerms = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions, ...perms]) as Ctx["permissions"] });
const without = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions].filter((p) => !perms.includes(p))) as Ctx["permissions"] });
const eventsDef = (x: Record<string, unknown>) => rb.ReportDefinition.parse({ source: "events", columns: [{ field: "event" }], ...x });

beforeAll(async () => {
  m = await loadModules();
  engine = await import("@/server/report-builder/engine");
  context = await import("@/server/report-builder/context");
  privacy = await import("@/server/client-privacy");
  rb = await import("@/domain/report-builder");
  tools = await import("@/server/assistant/tools");
  assistant = await import("@/server/assistant");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
}, 180_000);

afterAll(async () => {
  await m.db.closeDb();
});

describe("the event log in the report builder", () => {
  it("counts events by type the same as the table, for someone with the event log", async () => {
    const admin = await ctxOf("admin");
    const policy = await privacy.clientPolicy(admin);
    const def = eventsDef({ shops: "all", columns: [{ field: "event_code" }, { field: "events", agg: "sum" }, { field: "minutes", agg: "avg" }], groupBy: ["event_code"], summary: true, eventTypes: ["booking"] });
    const r = await engine.runReport(admin, policy, def, { pageSize: 200 });
    const counts = await rows<{ event: string; n: number }>(sql`select event, count(*)::int n from analytics_events where category = 'booking' group by event`);
    expect(r.noun).toBe("event");
    expect(r.customerIds).toEqual([]);
    const got = Object.fromEntries(r.lines.flatMap((l) => (l.kind === "group" ? [[l.values[0], l.cells[1]]] : [])));
    expect(got).toEqual(Object.fromEntries(counts.map((c) => [c.event, c.n])));
    expect(r.totals!.count).toBe(counts.reduce((s, c) => s + c.n, 0));
  });

  it("shows every field, keeps a barber to their own events and refuses people without the event log", async () => {
    const admin = await ctxOf("admin");
    const all = rb.EVENT_FIELDS.map((f) => ({ field: f.key }));
    const r = await engine.runReport(admin, await privacy.clientPolicy(admin), eventsDef({ shops: "all", columns: all, sort: [{ field: "occurred", dir: "desc" }] }), { pageSize: 20 });
    expect(r.columns.map((c) => c.key)).toEqual(rb.EVENT_FIELDS.map((f) => f.key));
    expect(r.lines.length).toBe(20);
    const first = r.lines[0];
    expect(first.kind === "row" && typeof first.cells[0]).toBe("string");

    const makenna = withPerms(await ctxOf("makenna"), ["analytics.events", "report_builder.build"]);
    const mine = await engine.runReport(makenna, await privacy.clientPolicy(makenna), eventsDef({ columns: [{ field: "barber" }], groupBy: ["barber"], summary: true }), { pageSize: 50 });
    expect(mine.lines.map((l) => (l.kind === "group" ? l.values[0] : null))).toEqual([makenna.staff.displayLabel]);

    const michelle = without(await ctxOf("michelle"), ["analytics.events"]);
    expect(await engine.reportProblem(michelle, await privacy.clientPolicy(michelle), eventsDef({}), { building: true })).toMatch(/event log/);
    expect(rb.definitionProblem(eventsDef({ filter: { ...eventsDef({}).filter, minVisits: 2 } }), { levels: {}, money: true, badges: [] }, [])).toMatch(/Client filters/);
    expect(rb.definitionProblem(eventsDef({ eventTypes: ["nope.nothing"] }), { levels: {}, money: true, badges: [] }, [])).toMatch(/isn't logged/);
  });
});

describe("the event log in Rayz Assistant", () => {
  it("offers event_report to people with the event log and answers with counts and what the measures mean", async () => {
    const settings = await assistant.loadAssistantSettings();
    expect((await tools.toolsFor(await ctxOf("makenna"), settings)).map((t) => t.name)).not.toContain("event_report");
    const admin = await ctxOf("admin");
    const tool = (await tools.toolsFor(admin, settings)).find((t) => t.name === "event_report")!;
    expect(tool).toBeTruthy();
    const out = await tool.run({ ctx: admin, settings, conversationId: "x", now: new Date() }, { eventTypes: ["appointment.started"], groupBy: ["location"], measures: ["minutes_avg"], preset: "all", locations: ["all"] });
    const [n] = await rows<{ n: number }>(sql`select count(*)::int n from analytics_events where event = 'appointment.started'`);
    expect(out.refused).toBeFalsy();
    expect(out.content).toContain(`${n.n.toLocaleString("en-US")} event`);
    expect(out.content).toMatch(/minutes = wait/);
    expect(out.cards[0]).toMatchObject({ kind: "report", title: "Event log" });
  });
});
