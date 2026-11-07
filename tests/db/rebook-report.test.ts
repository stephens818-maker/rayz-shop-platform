/**
 * The Rebook Rate report against a real database, on fixture visits about five months back where
 * the seed never reaches: rebooked at checkout (that day, already booked, or cancelled the same
 * day), imported visits without a booking time, return windows and the client's own gap, new
 * clients and 2nd visits, future appointments, the service and client-type filters, the brand
 * average and leaderboard, a barber seeing only their own numbers, the Morning Dashboard section,
 * the card on Today, custom report fields and the migration's grants.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ReportTable, TOTAL, segKey } from "@/domain/report-views";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let R: typeof import("@/server/rebook-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const c: Record<"ann" | "bo" | "cy" | "dee" | "eve" | "fay", string> = { ann: "", bo: "", cy: "", dee: "", eve: "", fay: "" };
let barberB: string;
let barberC: string;
let serviceId: string;
let today: string;
/** The fixture's visit day: a Wednesday about five months back. */
let base: string;
let futureAt: Date;
const day = (n: number) => m.time.addDays(base, n);
const at = (n: number, hhmm: string) => {
  const [h, mi] = hhmm.split(":").map(Number);
  return m.time.zonedWallTime(day(n), h * 60 + mi).toJSDate();
};
const FROM = () => day(-5);
const TO = () => day(50);
const NOW = new Date();
const filters = (o: Partial<import("@/server/rebook-report").RebookFilters> = {}) => ({ serviceId: null, clients: "all" as const, window: 45 as const, now: NOW, ...o });

let codes = 0;
async function appt(o: { shop: string; staff: string; customer: string; startsAt: Date; status: "completed" | "booked" | "cancelled"; createdAt: Date; cancelledAt?: Date; bookedAtKnown?: boolean }) {
  const [row] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `rebook-test-${++codes}-${crypto.randomUUID().slice(0, 6)}`,
      shopId: o.shop,
      staffId: o.staff,
      customerId: o.customer,
      startsAt: o.startsAt,
      endsAt: new Date(o.startsAt.getTime() + 30 * 60_000),
      status: o.status,
      source: "staff",
      estimateCents: 2300,
      completedAt: o.status === "completed" ? new Date(o.startsAt.getTime() + 30 * 60_000) : null,
      createdAt: o.createdAt,
      cancelledAt: o.cancelledAt ?? null,
      bookedAtKnown: o.bookedAtKnown ?? true,
    })
    .returning({ id: m.schema.appointments.id });
  return row.id;
}
async function bookable(shopId: string, except: string[]) {
  const links = await m.db.db
    .select({ id: m.schema.staffShops.staffId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, shopId), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  return links.map((l) => l.id).find((id) => !except.includes(id))!;
}

beforeAll(async () => {
  m = await loadModules();
  R = await import("@/server/rebook-report");
  for (const k of ["owner", "makenna", "frontdesk"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  today = m.time.todayLocal();
  base = m.time.addDays(today, -150);
  while (m.time.weekdayOf(base) !== 3) base = m.time.addDays(base, -1);
  barberB = await bookable(shop.coralville, [ids.makenna]);
  barberC = await bookable(shop.moline, [ids.makenna, barberB]);
  serviceId = ((await m.db.db.execute(m.drizzle.sql`select id from services where active and kind = 'service' order by sort_order, name limit 1`)) as unknown as { id: string }[])[0].id;

  const people = await m.db.db
    .insert(m.schema.customers)
    .values(["Ann", "Bo", "Cy", "Dee", "Eve", "Fay"].map((firstName) => ({ firstName, lastName: "Rebooktest", homeShopId: shop.coralville })))
    .returning({ id: m.schema.customers.id });
  [c.ann, c.bo, c.cy, c.dee, c.eve, c.fay] = people.map((p) => p.id);
  const mk = { shop: shop.coralville, staff: ids.makenna };

  // Ann, new: rebooked at checkout for 30 days out, and came.
  const annFirst = await appt({ ...mk, customer: c.ann, startsAt: at(0, "10:00"), status: "completed", createdAt: at(-1, "09:00") });
  await m.db.db.insert(m.schema.appointmentItems).values({ appointmentId: annFirst, serviceId, kind: "service", name: "Fixture cut", priceCents: 2300, durationMin: 30 });
  await appt({ ...mk, customer: c.ann, startsAt: at(30, "10:00"), status: "completed", createdAt: at(0, "10:40") });
  // Bo, new: his next visit was booked before this one, 45 days out.
  await appt({ ...mk, customer: c.bo, startsAt: at(0, "11:00"), status: "completed", createdAt: at(-10, "09:00") });
  await appt({ ...mk, customer: c.bo, startsAt: at(45, "11:00"), status: "completed", createdAt: at(-5, "09:00") });
  // Cy, new: rebooked at checkout but cancelled that afternoon; booked again later and back in 55 days.
  await appt({ ...mk, customer: c.cy, startsAt: at(0, "12:00"), status: "completed", createdAt: at(-1, "09:00") });
  await appt({ ...mk, customer: c.cy, startsAt: at(20, "12:00"), status: "cancelled", createdAt: at(0, "12:40"), cancelledAt: at(0, "15:00") });
  await appt({ ...mk, customer: c.cy, startsAt: at(55, "12:00"), status: "completed", createdAt: at(10, "09:00") });
  // Dee, new, at Moline: not rebooked, never back.
  await appt({ shop: shop.moline, staff: barberC, customer: c.dee, startsAt: at(0, "10:00"), status: "completed", createdAt: at(-1, "09:00") });
  // Eve, returning (last seen 50 days before): rebooked at checkout for a visit still to come.
  await appt({ shop: shop.coralville, staff: barberB, customer: c.eve, startsAt: at(-50, "10:00"), status: "completed", createdAt: at(-51, "09:00") });
  await appt({ shop: shop.coralville, staff: barberB, customer: c.eve, startsAt: at(0, "10:00"), status: "completed", createdAt: at(-1, "09:00") });
  for (let min = 21 * 60; ; min += 15) {
    try {
      futureAt = m.time.zonedWallTime(m.time.addDays(today, 10), min).toJSDate();
      await appt({ shop: shop.coralville, staff: barberB, customer: c.eve, startsAt: futureAt, status: "booked", createdAt: at(0, "10:40") });
      break;
    } catch (e) {
      if (min > 23 * 60) throw e;
    }
  }
  // Fay, new: an imported visit with no booking time.
  await appt({ ...mk, customer: c.fay, startsAt: at(0, "13:00"), status: "completed", createdAt: at(0, "13:00"), bookedAtKnown: false });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const QC = () => [shop.coralville, shop.moline];

describe("the counts", () => {
  it("counts rebooked at checkout: that day or already booked, not cancelled that day, not imported", async () => {
    const r = await R.rebookAt({ shopIds: QC(), from: FROM(), to: TO() }, filters(), [{}, { byStaff: true }, { byShop: true }]);
    expect(r[TOTAL]).toMatchObject({ visits: 8, known: 7, rebooked: 3, sameDay: 2, newVisits: 5, newKnown: 4, newRebooked: 2 });
    expect(r[segKey(null, ids.makenna)]).toMatchObject({ visits: 6, known: 5, rebooked: 2, sameDay: 1 });
    expect(r[segKey(null, barberB)]).toMatchObject({ visits: 1, known: 1, rebooked: 1, sameDay: 1, newVisits: 0 });
    expect(r[segKey(shop.moline, null)]).toMatchObject({ visits: 1, known: 1, rebooked: 0 });
  });

  it("judges returns from each client's first visit, within 30/45/60 days or their own gap", async () => {
    const t = (await R.rebookAt({ shopIds: QC(), from: FROM(), to: TO() }, filters(), [{}]))[TOTAL];
    expect(t.clients).toBe(6);
    expect(t.judged).toEqual({ 30: 6, 45: 6, 60: 6, own: 1 });
    expect(t.back).toEqual({ 30: 1, 45: 2, 60: 3, own: 0 });
    expect(t).toMatchObject({ newClients: 5, newJudged: 5, newBack: 2, prebookedClients: 1 });
    const own = (await R.rebookAt({ shopIds: QC(), from: FROM(), to: TO() }, filters({ window: "own" }), [{}]))[TOTAL];
    expect(own).toMatchObject({ newJudged: 5, newBack: 3 });
  });

  it("doesn't judge a window that hasn't closed", async () => {
    const early = new Date(at(20, "12:00"));
    const t = (await R.rebookAt({ shopIds: QC(), from: FROM(), to: TO() }, filters({ now: early }), [{}]))[TOTAL];
    expect(t.judged).toEqual({ 30: 0, 45: 0, 60: 0, own: 0 });
  });

  it("counts future appointments as of now, at the scope's shops and barbers", async () => {
    const r = await R.rebookAt({ shopIds: [shop.coralville], from: FROM(), to: TO(), staffIds: [barberB] }, filters(), [{}]);
    const [n] = (await m.db.db.execute(
      m.drizzle.sql`select count(*)::int n from appointments where shop_id = ${shop.coralville} and staff_id = ${barberB} and status in ('booked', 'confirmed') and customer_id is not null and starts_at > ${NOW.toISOString()}::timestamptz`,
    )) as unknown as { n: number }[];
    expect(n.n).toBeGreaterThanOrEqual(1);
    expect(r[TOTAL].future).toBe(n.n);
  });

  it("filters by service and by new or returning client", async () => {
    const s = { shopIds: QC(), from: FROM(), to: TO() };
    expect((await R.rebookAt(s, filters({ serviceId }), [{}], { future: false }))[TOTAL]).toMatchObject({ visits: 1, rebooked: 1, clients: 1 });
    expect((await R.rebookAt(s, filters({ clients: "new" }), [{}], { future: false }))[TOTAL]).toMatchObject({ visits: 5, known: 4, rebooked: 2, clients: 5 });
    expect((await R.rebookAt(s, filters({ clients: "returning" }), [{}], { future: false }))[TOTAL]).toMatchObject({ visits: 3, known: 3, rebooked: 1, clients: 3 });
  });

  it("splits the trend by week, adding up to the total", async () => {
    const t = await R.rebookTrend({ shopIds: QC(), from: FROM(), to: TO() }, filters(), "week");
    expect([...t.keys()].every((k) => m.time.weekdayOf(k) === 0)).toBe(true);
    expect([...t.values()].reduce((s, x) => s + x.visits, 0)).toBe(8);
    expect(t.get(m.time.addDays(base, -3))).toMatchObject({ visits: 6, rebooked: 3 });
  });
});

async function load(who: string, p: Record<string, string | string[]>) {
  await signInAs(ids[who]);
  const S = await import("@/app/admin/reports/scope");
  const L = await import("@/server/report-data");
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const q = { from: FROM(), to: TO(), ...p };
  const scope = await S.resolveScope(ctx, q, "rebook_rate");
  const params = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return { ...(await L.REPORT_LOADERS.rebook_rate({ scope, loc: scope.loc, viewer: ctx, params })), scope };
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id);
const metric = (t: ReportTable, label: string) => t.rows.find((r) => r[0] === label)!.at(-1);

describe("the report", () => {
  it("compares one location with the brand average, with leaderboards and the trend", async () => {
    const d = await load("owner", { shop: shop.coralville });
    expect(metric(table(d, "rebook")!, "Rebook rate")).toBe(0.5);
    const brand = table(d, "brand")!;
    expect(brand.rows[0]).toEqual(["Rebook rate", 0.5, 3 / 7, "+7 pts"]);
    expect(d.stats[0]).toMatchObject({ label: "Rebook rate", value: "50%", tone: "up" });
    expect(d.stats[0].hint).toContain("brand 43%");
    const board = table(d, "barbers")!;
    expect(board.rows.map((r) => [r[0], r[2], r[3]])).toEqual([
      [null, 1, 1],
      [null, 6, 0.4],
      [null, 8, 3 / 7],
    ]);
    expect(board.rows.at(-1)![1]).toBe("Brand average");
    expect(table(d, "locations")).toBeUndefined();
    expect(d.charts?.map((c) => [c.id, c.series.length])).toEqual([
      ["trend_rebook", 2],
      ["trend_new", 2],
    ]);
    expect(d.notes?.join(" ")).toContain("leaves out 1 imported visits");
  });

  it("is the brand average itself across every location, with a location leaderboard", async () => {
    const all = Object.values(shop);
    const d = await load("owner", { shop: all });
    expect(table(d, "brand")).toBeUndefined();
    expect(d.charts?.[0].series).toHaveLength(1);
    expect(d.notes?.[0]).toContain("total is the brand average");
    const locs = table(d, "locations")!;
    expect(locs.rows.filter((r) => r[1] !== "Brand average").map((r) => r[2])).toEqual([7, 1]);
  });

  it("applies the options from the filters", async () => {
    const d = await load("owner", { shop: QC(), clients: "new", window: "60", rank: "new_rebook", service: "not-a-service" });
    expect(d.options?.find((o) => o.param === "service")).toMatchObject({ value: "", select: true });
    expect(metric(table(d, "rebook")!, "Completed visits")).toBe(5);
    expect(metric(table(d, "rebook")!, "Back within 60 days")).toBe(3 / 5);
    expect(table(d, "barbers")!.title).toContain("new-client rebook rate");
  });

  it("shows a barber only their own numbers, against the whole brand", async () => {
    const d = await load("makenna", {});
    expect(d.scope.staffIds).toEqual([ids.makenna]);
    expect(metric(table(d, "rebook")!, "Completed visits")).toBe(6);
    const board = table(d, "barbers")!;
    expect(board.rows).toHaveLength(2);
    expect(board.rows[1]).toEqual(expect.arrayContaining(["Brand average", 8]));
    expect(table(d, "brand")!.rows[0]).toEqual(["Rebook rate", 0.4, 3 / 7, "−3 pts"]);
  });
});

describe("other places", () => {
  it("the Morning Dashboard shows the report day's rebook rate by barber, against the brand", async () => {
    const md = await import("@/server/morning-dashboard");
    const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids.owner))!;
    const d = await md.buildMorningDashboard({ access, firstName: "Owner", shopIds: [shop.coralville], today: day(1), now: at(1, "07:00"), allSections: true });
    expect(d!.periods.reportDay).toBe(base);
    const b = d!.rebook!;
    expect(b.visits.day).toBe(4);
    expect(b.rebooked.day).toBe(3);
    expect(b.rebook.day).toBe(0.75);
    expect(b.brand?.day).toBe(0.6);
    expect(b.byBarber?.map((x) => [x.staffId, x.rate])).toEqual([
      [barberB, 1],
      [ids.makenna, 2 / 3],
    ]);
    expect(b.ownOnly).toBe(false);
    const later = await md.buildMorningDashboard({ access, firstName: "Owner", shopIds: [shop.coralville], today: day(64), now: at(64, "07:00"), allSections: true });
    expect(later!.rebook!.secondVisit).toMatchObject({ judged: 4, back: 3 });
  });

  it("a barber's card on Today: their rebooks over 30 days and the 2nd visits of the clients they first saw 60 to 89 days ago", async () => {
    const r = await R.myRebook(ids.makenna, [shop.coralville], day(60), NOW);
    expect(r.counts).toMatchObject({ visits: 2, known: 2, rebooked: 0 });
    expect(r.newJudged).toBe(4);
    expect(r.second).toBe(3 / 4);
    expect(r.brandSecond).toBe(3 / 5);
  });

  it("custom reports: rebooks, 2nd visit, days to it, the next booking and future appointments", async () => {
    const engine = await import("@/server/report-builder/engine");
    const rb = await import("@/domain/report-builder");
    const ctx = (await (await import("@/server/report-builder/context")).staffContextFor(ids.owner))!;
    const policy = await (await import("@/server/client-privacy")).clientPolicy(ctx);
    const fields = ["visits_rebooked", "rebook_rate", "first_visit_rebooked", "second_visit", "days_to_second_visit", "next_booked", "future_appointments"];
    const def = rb.ReportDefinition.parse({ shops: "all", range: { preset: "all" }, columns: [{ field: "name" }, ...fields.map((field) => ({ field }))] });
    const r = await engine.runReport(ctx, policy, def, { all: true });
    const row = (id: string) => Object.fromEntries(fields.map((f, i) => [f, r.lines.find((l) => l.kind === "row" && l.id === id)!.cells[i + 1]]));
    expect(row(c.ann)).toMatchObject({ visits_rebooked: 1, rebook_rate: 0.5, first_visit_rebooked: true, second_visit: true, days_to_second_visit: 30, future_appointments: 0 });
    expect(row(c.cy)).toMatchObject({ visits_rebooked: 0, first_visit_rebooked: false, days_to_second_visit: 55 });
    expect(row(c.dee)).toMatchObject({ second_visit: false, days_to_second_visit: null });
    expect(row(c.eve)).toMatchObject({ visits_rebooked: 1, rebook_rate: 0.5, future_appointments: 1, next_booked: m.time.addDays(today, 10) });
    expect(row(c.fay).rebook_rate).toBeNull();
  });

  it("the migration grants the report to managers and barbers, not the front desk", async () => {
    const roles = await m.db.db.select().from(m.schema.roles);
    const perms = (key: string) => (roles.find((r) => r.key === key)!.permissions as string[]) ?? [];
    expect(perms("barber")).toContain("report.rebook_rate.view");
    expect(perms("barber")).not.toContain("report.rebook_rate.export");
    expect(perms("shop_manager")).toEqual(expect.arrayContaining(["report.rebook_rate.view", "report.rebook_rate.export"]));
    expect(perms("front_desk")).not.toContain("report.rebook_rate.view");
  });
});
