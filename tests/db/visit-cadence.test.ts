/**
 * Time between visits against a real database: the SQL cadence agrees with the TypeScript one, the
 * client list's column and filters, the profile card with its per-barber breakdown, the report
 * builder's fields (scoped to a barber), rebook reminders timed from the cadence, and the
 * assistant's fields.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let vc: typeof import("@/server/visit-cadence");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const people: Record<string, string> = {};
let coralville: string;
const TAG = "fx-cadence";
const c = {} as Record<"ava" | "ben" | "cal" | "dee" | "eve" | "finn", { id: string; name: string }>;

const filterFor = async (f: object) => {
  const { encodeFilter } = await import("@/domain/client-filters");
  const { SegmentSchema } = await import("@/domain/marketing");
  return encodeFilter(SegmentSchema.parse({ tags: [TAG], ...f }));
};
async function listed(f: object) {
  await signInAs(people.owner);
  const r = await open("/admin/customers", {}, { f: await filterFor(f) });
  if (r.kind !== "ok") throw new Error(`client list: ${r.kind}`);
  return { text: r.text, names: (Object.keys(c) as (keyof typeof c)[]).filter((k) => r.text.includes(c[k].name)).sort() };
}

beforeAll(async () => {
  m = await loadModules();
  vc = await import("@/server/visit-cadence");
  for (const l of ["owner", "makenna", "michelle"]) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  const today = m.time.todayLocal();
  // 9:30 PM local is the next day in UTC: visit days must be the shop's calendar days.
  const at = (days: number, minutes = 1290) => m.time.zonedWallTime(m.time.addDays(today, days), minutes).toJSDate();
  const appt = (customerId: string, days: number, o: { staff?: string; status?: "completed" | "booked" | "cancelled"; minutes?: number } = {}) =>
    m.db.db.insert(m.schema.appointments).values({
      code: `V${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: coralville,
      staffId: o.staff ?? people.makenna,
      customerId,
      startsAt: at(days, o.minutes),
      endsAt: new Date(at(days, o.minutes).getTime() + 30 * 60_000),
      status: o.status ?? "completed",
      source: "staff",
      estimateCents: 2300,
      completedAt: (o.status ?? "completed") === "completed" ? new Date(at(days, o.minutes).getTime() + 30 * 60_000) : null,
    });
  const client = async (key: keyof typeof c, firstName: string) => {
    const [row] = await m.db.db.insert(m.schema.customers).values({ firstName, lastName: "Cadencetest", homeShopId: coralville, smsOptIn: true }).returning();
    await m.db.db.insert(m.schema.customerTags).values({ customerId: row.id, tag: TAG });
    c[key] = { id: row.id, name: `${firstName} Cadencetest` };
    return row.id;
  };
  // Every 3 weeks, the last with Michelle: due (19 days of 21).
  const ava = await client("ava", "Ava");
  for (const d of [-82, -61, -40]) await appt(ava, d);
  await appt(ava, -19, { staff: people.michelle });
  await appt(ava, -30, { status: "cancelled" });
  // Every 4 weeks, 44 days ago: overdue.
  const ben = await client("ben", "Ben");
  for (const d of [-100, -72, -44]) await appt(ben, d);
  // Two appointments on one day count as one visit: every 3 weeks, on track.
  const cal = await client("cal", "Cal");
  await appt(cal, -30);
  await appt(cal, -9, { minutes: 600 });
  await appt(cal, -9, { minutes: 1290 });
  // Past due but booked: on track.
  const dee = await client("dee", "Dee");
  for (const d of [-90, -60]) await appt(dee, d);
  await appt(dee, 3, { status: "booked" });
  // One visit: no cadence yet.
  await appt(await client("eve", "Eve"), -10);
  // A five-month break doesn't move it off 3 weeks (the plain average would be 47 days).
  const finn = await client("finn", "Finn");
  for (const d of [-239, -218, -197, -47, -26, -5]) await appt(finn, d);
});

afterAll(async () => {
  await signInAs(null);
});

describe("time between visits", () => {
  it("is the same in SQL as in TypeScript", async () => {
    const now = new Date();
    const sqlRows = await vc.cadenceFor(
      Object.values(c).map((x) => x.id),
      now,
    );
    for (const x of Object.values(c)) {
      const { cadence: ts } = await vc.clientCadence(x.id, now);
      const s = sqlRows.get(x.id)!;
      expect({ visitDays: s.visitDays, cadenceDays: s.cadenceDays, sinceDays: s.sinceDays, nextExpected: s.nextExpected, booked: s.booked, status: s.status }).toEqual({
        visitDays: ts.visitDays,
        cadenceDays: ts.cadenceDays,
        sinceDays: ts.sinceDays,
        nextExpected: ts.nextExpected,
        booked: ts.booked,
        status: ts.status,
      });
    }
    expect(Object.fromEntries((Object.keys(c) as (keyof typeof c)[]).map((k) => [k, [sqlRows.get(c[k].id)!.cadenceDays, sqlRows.get(c[k].id)!.status]]))).toEqual({
      ava: [21, "due"],
      ben: [28, "overdue"],
      cal: [21, "on_track"],
      dee: [30, "on_track"],
      eve: [null, null],
      finn: [21, "on_track"],
    });
  });

  it("shows on the client list, and filters it by status and by usual days between visits", async () => {
    const all = await listed({});
    expect(all.text).toMatch(/Comes in/);
    expect(all.text).toMatch(/Ava Cadencetest.{0,4000}Every 3 weeks.{0,200}Due/);
    expect(all.text).toMatch(/Ben Cadencetest.{0,4000}Every 4 weeks.{0,200}Overdue/);
    expect((await listed({ visitStatus: ["overdue"] })).names).toEqual(["ben"]);
    expect((await listed({ visitStatus: ["due", "overdue"] })).names).toEqual(["ava", "ben"]);
    expect((await listed({ visitStatus: ["on_track"] })).names).toEqual(["cal", "dee", "finn"]);
    expect((await listed({ minAvgGapDays: 25 })).names).toEqual(["ben", "dee"]);
    expect((await listed({ maxAvgGapDays: 21 })).names).toEqual(["ava", "cal", "finn"]);
  });

  it("shows on the profile, with each barber when they've seen more than one", async () => {
    await signInAs(people.owner);
    const r = await open("/admin/customers/[id]", { id: c.ava.id });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.text).toMatch(/Time between visits/);
    const card = r.text.slice(r.text.indexOf("Time between visits"), r.text.indexOf("Visit history"));
    for (const x of ["Due", "Every 3 weeks", "about 21 days", "19 days ago", "Next expected", "Visits counted"]) expect(card).toContain(x);
    expect(card).toMatch(/Makenna.{0,300}Every 3 weeks.{0,400}Michelle.{0,300}after a second visit/);
    const one = await open("/admin/customers/[id]", { id: c.eve.id });
    expect(one.kind === "ok" && one.text).toMatch(/Shows after their second visit/);
  });

  it("is a report builder field, scoped to the report's barbers", async () => {
    const { staffContextFor } = await import("@/server/report-builder/context");
    const { clientPolicy } = await import("@/server/client-privacy");
    const { runReport } = await import("@/server/report-builder/engine");
    const { ReportDefinition } = await import("@/domain/report-builder");
    const { SegmentSchema } = await import("@/domain/marketing");
    const ctx = (await staffContextFor(people.owner))!;
    const policy = await clientPolicy(ctx);
    const columns = ["name", "avg_gap_days", "cadence_label", "days_since_visit", "next_visit_due", "visit_status"].map((field) => ({ field }));
    const run = async (x: object) => {
      const r = await runReport(ctx, policy, ReportDefinition.parse({ shops: "all", filter: SegmentSchema.parse({ tags: [TAG] }), columns, ...x }), { pageSize: 50 });
      return Object.fromEntries(r.lines.flatMap((l) => (l.kind === "row" ? [[String(l.cells[0]).split(" ")[0], l.cells.slice(1)]] : [])));
    };
    const all = await run({});
    expect(all.Ava).toEqual([21, "Every 3 weeks", 19, m.time.addDays(m.time.todayLocal(), 2), "Due"]);
    expect(all.Finn).toEqual([21, "Every 3 weeks", 5, m.time.addDays(m.time.todayLocal(), 16), "On track"]);
    expect(all.Eve).toEqual([null, null, 10, null, null]);
    // With Makenna only, Ava's last visit was 40 days ago.
    const withMakenna = await run({ staff: people.makenna });
    expect(withMakenna.Ava).toEqual([21, "Every 3 weeks", 40, m.time.addDays(m.time.todayLocal(), -19), "Overdue"]);
    const overdue = await run({ filter: SegmentSchema.parse({ tags: [TAG], visitStatus: ["overdue"] }) });
    expect(Object.keys(overdue)).toEqual(["Ben"]);
  });

  it("times rebook reminders: their usual gap less the lead days", async () => {
    const { clientsOf, triggerTargets } = await import("@/server/marketing/audiences");
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, coralville) }))!;
    const now = new Date();
    const clients = (await clientsOf([coralville], now)).get(coralville)!;
    const ours = new Set(Object.values(c).map((x) => x.id));
    const targets = async (leadDays: number) =>
      (await triggerTargets({ key: "rebook", shop, settings: { leadDays }, clients, now }))
        .filter((t) => ours.has(t.customerId))
        .map((t) => (Object.keys(c) as (keyof typeof c)[]).find((k) => c[k].id === t.customerId))
        .sort();
    // Ava: 19 days into 21. Dee is booked; Ben is past the catch-up window from day 25.
    expect(await targets(3)).toEqual(["ava"]);
    expect(await targets(0)).toEqual([]);
    expect(await targets(14)).toEqual(["ava", "cal"]);
  });

  it("feeds Today's rebook and open-chair lists and the assistant's fields", async () => {
    const { rebookCandidates } = await import("@/server/outreach-campaigns");
    const ben = (await rebookCandidates(coralville)).find((x) => x.customerId === c.ben.id);
    expect(ben).toMatchObject({ usualDays: 28 });
    const { staffContextFor } = await import("@/server/report-builder/context");
    const { clientPolicy } = await import("@/server/client-privacy");
    const { panelSees } = await import("@/server/client-filters");
    const { assistantFields } = await import("@/server/assistant/tools");
    const ctx = (await staffContextFor(people.owner))!;
    const keys = assistantFields(panelSees(ctx, await clientPolicy(ctx))).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["avg_gap_days", "cadence_label", "days_since_visit", "next_visit_due", "visit_status"]));
  });
});
