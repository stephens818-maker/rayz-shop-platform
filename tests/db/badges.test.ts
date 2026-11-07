/**
 * Client badges against a real database: the cache (fresh rows, unchanged rows left alone, the
 * nightly job's batches and budget), the refresh after checkout, who sees which badge under the
 * brand's settings, the badge filter on the client list and in the report builder, custom badges
 * from a segment filter, and every screen that shows them: profile, client list, search, the day
 * calendar, Today and the Morning Dashboard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { BadgeSettingsSchema } from "@/domain/badges";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const saveBadges = (ctx: import("@/server/auth/staff").StaffContext, raw: unknown) => brandSettings({ badges: BadgeSettingsSchema.parse(raw) }, { ctx });
let bd: typeof import("@/server/badges");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const people: Record<string, string> = {};
let coralville: string;
let today: string;
const TAG = "fx-badges";
const c = {} as Record<"ana" | "bo" | "cy" | "dan" | "eli", { id: string; name: string }>;
let danAppt: string;
let gone: string;

const ctxOf = async (who: string) => {
  const { staffContextFor } = await import("@/server/report-builder/context");
  return (await staffContextFor(people[who]))!;
};
const policyOf = async (who: string) => (await import("@/server/client-privacy")).clientPolicy(await ctxOf(who));
const keysOf = async (id: string) =>
  ((await m.db.db.execute(m.drizzle.sql`select keys from client_badges where customer_id = ${id}::uuid`)) as unknown as { keys: string[] }[])[0]?.keys ?? null;
const filterFor = async (f: object) => {
  const { encodeFilter } = await import("@/domain/client-filters");
  const { SegmentSchema } = await import("@/domain/marketing");
  return encodeFilter(SegmentSchema.parse({ tags: [TAG], ...f }));
};
async function listed(who: string, f: object) {
  await signInAs(people[who]);
  const r = await open("/admin/customers", {}, { f: await filterFor(f) });
  if (r.kind !== "ok") throw new Error(`client list: ${r.kind}`);
  return { text: r.text, names: (Object.keys(c) as (keyof typeof c)[]).filter((k) => r.text.includes(c[k].name)).sort() };
}

beforeAll(async () => {
  m = await loadModules();
  bd = await import("@/server/badges");
  bd.resetBadgeCaches();
  for (const l of ["owner", "admin", "makenna", "michelle", "frontdesk"]) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  today = m.time.todayLocal();
  const svc = (await m.db.db.query.services.findFirst())!;
  const at = (days: number, minutes = 1290) => m.time.zonedWallTime(m.time.addDays(today, days), minutes).toJSDate();
  const insertAppt = (customerId: string, startsAt: Date, o: { staff: string; status: "completed" | "booked" }) =>
    m.db.db
      .insert(m.schema.appointments)
      .values({
        code: `B${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
        shopId: coralville,
        staffId: o.staff,
        customerId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: o.status,
        source: "staff",
        estimateCents: 2300,
        completedAt: o.status === "completed" ? new Date(startsAt.getTime() + 30 * 60_000) : null,
      })
      .returning({ id: m.schema.appointments.id });
  const visit = (customerId: string, days: number, staff = people.makenna) => insertAppt(customerId, at(days), { staff, status: "completed" });
  // Later today, at the first half hour this barber is free (the busy-range trigger refuses overlaps).
  const laterToday = async (customerId: string, staff: string) => {
    const nowMin = Math.ceil(m.time.localMinutesOf(new Date()) / 30) * 30;
    for (let min = nowMin + 30; min <= 23 * 60 + 15; min += 15) {
      try {
        const [row] = await insertAppt(customerId, at(0, min), { staff, status: "booked" });
        return row.id;
      } catch {
        // Taken: try the next half hour.
      }
    }
    throw new Error("no free time later today");
  };
  const client = async (key: keyof typeof c, firstName: string, o: Partial<typeof m.schema.customers.$inferInsert> = {}) => {
    const [row] = await m.db.db
      .insert(m.schema.customers)
      .values({ firstName, lastName: "Badgetest", homeShopId: coralville, smsOptIn: true, phone: `+1319555${String(Math.floor(Math.random() * 9000) + 1000)}`, email: `${firstName.toLowerCase()}.badgetest@example.com`, ...o })
      .returning();
    await m.db.db.insert(m.schema.customerTags).values({ customerId: row.id, tag: TAG });
    c[key] = { id: row.id, name: `${firstName} Badgetest` };
    return row.id;
  };
  // Every 3 weeks, then 38 days: at risk. Birthday today, no email on file, booked today with Makenna.
  const ana = await client("ana", "Ana", { birthday: `1990-${today.slice(5)}`, email: null });
  for (const d of [-110, -89, -68, -30]) await visit(ana, d);
  await laterToday(ana, people.makenna);
  // One visit, booked today with Michelle: their 2nd visit.
  const bo = await client("bo", "Bo");
  await visit(bo, -10, people.michelle);
  await laterToday(bo, people.michelle);
  // Last in over a year ago, and the brand's biggest spender: lapsed and VIP.
  const cy = await client("cy", "Cy");
  await visit(cy, -400);
  await m.db.db.insert(m.schema.sales).values({ shopId: coralville, businessDate: m.time.addDays(today, -5), customerId: cy, status: "paid", serviceNetCents: 900_000 });
  // One visit and an appointment yesterday still to check out.
  const dan = await client("dan", "Dan");
  await visit(dan, -30);
  [{ id: danAppt }] = await insertAppt(dan, at(-1, 600), { staff: people.makenna, status: "booked" });
  await m.db.db.insert(m.schema.appointmentItems).values({ appointmentId: danAppt, serviceId: svc.id, kind: "service", name: svc.name, priceCents: 2300, durationMin: 30 });
  // Their barber has left.
  const barber = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.makenna) }))!;
  const tag = crypto.randomUUID().slice(0, 8);
  [{ id: gone }] = await m.db.db
    .insert(m.schema.staff)
    .values({ staffCode: `BG${tag}`, firstName: "Gone", displayLabel: "Gone G.", publicSlug: `gone-${tag}`, roleId: barber.roleId, active: false })
    .returning({ id: m.schema.staff.id });
  await client("eli", "Eli", { preferredStaffId: gone });
});

afterAll(async () => {
  await m.db.db.update(m.schema.brandSettings).set({ badges: {} });
  await m.db.db.delete(m.schema.customBadges);
  await signInAs(null);
});

describe("client badges", () => {
  it("caches each client's badges, and leaves unchanged rows alone on the next refresh", async () => {
    const ids = Object.values(c).map((x) => x.id);
    expect(await bd.refreshBadges(ids, new Date())).toBe(ids.length);
    expect(await keysOf(c.ana.id)).toEqual(expect.arrayContaining(["at_risk", "on_track", "birthday_week", "birthday_month", "missing_info"]));
    expect(await keysOf(c.bo.id)).toContain("second_visit");
    expect(await keysOf(c.cy.id)).toEqual(expect.arrayContaining(["lapsed", "vip"]));
    expect(await keysOf(c.dan.id)).toContain("second_visit");
    expect(await keysOf(c.eli.id)).toEqual(expect.arrayContaining(["barber_left", "new_client"]));
    expect(await bd.refreshBadges(ids, new Date())).toBe(0);
    const status = await bd.badgeCacheStatus();
    expect(status.fresh).toBeGreaterThanOrEqual(ids.length);
  });

  it("works through missing and stale rows in the nightly job, and stops when its time is up", async () => {
    await m.db.db.execute(m.drizzle.sql`update client_badges set computed_on = '2000-01-01' where customer_id = ${c.ana.id}::uuid`);
    await m.db.db.execute(m.drizzle.sql`delete from client_badges where customer_id = ${c.bo.id}::uuid`);
    const idle = await bd.runBadgeJob(new Date(), { budgetMs: 0 });
    expect(idle.scanned).toBe(0);
    expect(idle.remaining).toBeGreaterThanOrEqual(2);
    const run = await bd.runBadgeJob(new Date(), { batch: 200 });
    expect(run.remaining).toBe(0);
    expect(run.scanned).toBeGreaterThanOrEqual(2);
    expect(await keysOf(c.bo.id)).toContain("second_visit");
    const [{ fresh }] = (await m.db.db.execute(m.drizzle.sql`select computed_on >= ${today}::date fresh from client_badges where customer_id = ${c.ana.id}::uuid`)) as unknown as { fresh: boolean }[];
    expect(fresh).toBe(true);
    expect((await bd.runBadgeJob(new Date())).scanned).toBe(0);
  });

  it("recomputes the client's badges at checkout", async () => {
    expect(await keysOf(c.dan.id)).toContain("second_visit");
    const sale = await m.checkout.openSaleForAppointment(danAppt, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty })),
      tipCents: 0,
      tender: { method: "cash", cashTenderedCents: null },
      actor,
    });
    const keys = await keysOf(c.dan.id);
    expect(keys).not.toContain("second_visit");
    expect(keys).toEqual(expect.arrayContaining(["on_track"]));
  });

  it("shows each person only the badges their role and client data access allow", async () => {
    const barber = await policyOf("makenna");
    for (const k of ["at_risk", "birthday_month", "second_visit", "barber_left"]) expect(barber.badges.has(k)).toBe(true);
    for (const k of ["vip", "gift_card", "birthday_week", "missing_info"]) expect(barber.badges.has(k)).toBe(false);
    const ana = (await bd.shownBadges(barber, [c.ana.id])).get(c.ana.id)!.map((b) => b.key);
    expect(ana).toEqual(expect.arrayContaining(["at_risk", "birthday_month"]));
    expect(ana).not.toContain("birthday_week");
    expect(ana).not.toContain("missing_info");
    const owner = await policyOf("owner");
    expect(owner.badges.has("vip")).toBe(true);
    expect((await bd.shownBadges(owner, [c.cy.id])).get(c.cy.id)!.map((b) => b.key)).toContain("vip");
    // VIP starts brand-level only; the brand turns it on for the front desk.
    expect((await policyOf("frontdesk")).badges.has("vip")).toBe(false);
    const role = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.frontdesk) }))!.roleId;
    await saveBadges(await ctxOf("admin"), { roles: { vip: { [role]: true }, at_risk: { [role]: false } } });
    const desk = await policyOf("frontdesk");
    expect(desk.badges.has("vip")).toBe(true);
    expect(desk.badges.has("at_risk")).toBe(false);
    await saveBadges(await ctxOf("admin"), { enabled: false });
    expect((await policyOf("owner")).badges.size).toBe(0);
    await saveBadges(await ctxOf("admin"), {});
    await expect(saveBadges(await ctxOf("makenna"), {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("marks every row stale when a threshold changes, but not for who sees what", async () => {
    const stale = async () =>
      ((await m.db.db.execute(m.drizzle.sql`select count(*)::int n from client_badges where computed_on < ${today}::date`)) as unknown as { n: number }[])[0].n;
    await saveBadges(await ctxOf("admin"), { off: ["coupon"] });
    expect(await stale()).toBe(0);
    await saveBadges(await ctxOf("admin"), { thresholds: { lapsedWeeks: 60 } });
    expect(await stale()).toBeGreaterThan(0);
    // Read back lazily: Cy's last visit, 57 weeks ago, isn't lapsed at 60.
    expect((await bd.storedBadges([c.cy.id])).get(c.cy.id)!.map((b) => b.k)).not.toContain("lapsed");
    await saveBadges(await ctxOf("admin"), {});
    await bd.runBadgeJob(new Date());
    expect(await keysOf(c.cy.id)).toContain("lapsed");
  });

  it("filters the client list by badge, and refuses a badge the person can't see", async () => {
    expect((await listed("owner", { badges: ["at_risk"] })).names).toEqual(["ana"]);
    expect((await listed("owner", { badges: ["second_visit", "barber_left"] })).names).toEqual(["bo", "eli"]);
    expect((await listed("owner", { badges: ["vip"] })).names).toEqual(["cy"]);
    const { filterSees } = await import("@/domain/client-filters");
    const { SegmentSchema, segmentProblem } = await import("@/domain/marketing");
    const { panelSees } = await import("@/server/client-filters");
    const sees = filterSees(panelSees(await ctxOf("makenna"), await policyOf("makenna")));
    expect(segmentProblem(SegmentSchema.parse({ badges: ["vip"] }), sees)).toBeTruthy();
    expect(segmentProblem(SegmentSchema.parse({ badges: ["at_risk"] }), sees)).toBeNull();
    const all = await listed("owner", {});
    expect(all.text).toMatch(/Ana Badgetest.{0,800}data-badge.{0,40}at_risk|Ana Badgetest.{0,800}At risk/);
  });

  it("shows on the profile with a tooltip that says why", async () => {
    await signInAs(people.owner);
    const r = await open("/admin/customers/[id]", { id: c.ana.id });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.text).toContain("At risk: Visits are stretching: their last gap was 5.5 weeks against their usual 3 weeks.");
    await signInAs(people.makenna);
    const mine = await open("/admin/customers/[id]", { id: c.ana.id });
    if (mine.kind !== "ok") throw new Error(mine.kind);
    expect(mine.text).toContain("At risk:");
    expect(mine.text).not.toContain("Missing info:");
    expect(mine.text).not.toContain("Birthday this week:");
  });

  it("shows in search results and on the day calendar", async () => {
    const { searchClients } = await import("@/server/client-search");
    const hits = await searchClients(await ctxOf("owner"), "Badgetest", { via: "clients", record: false, limit: 20 });
    expect(hits.find((h) => h.id === c.cy.id)?.badges?.map((b) => b.key)).toEqual(expect.arrayContaining(["lapsed", "vip"]));
    const cal = await import("@/server/calendar");
    const day = await cal.loadDayCalendar(coralville, today, null, { shopIds: [coralville], brandWide: true }, await policyOf("owner"), { staffId: null, seesPrivate: true });
    const appt = day.columns.flatMap((col) => col.appts).find((a) => a.customerId === c.ana.id)!;
    expect(appt.badges.map((b) => b.key)).toContain("at_risk");
    const bare = await cal.loadDayCalendar(coralville, today, null, { shopIds: [coralville], brandWide: true }, { show: (_f, raw) => raw ?? null, stars: () => null }, { staffId: null, seesPrivate: true });
    expect(bare.columns.flatMap((col) => col.appts).find((a) => a.customerId === c.ana.id)!.badges).toEqual([]);
  });

  it("is a report builder column of the badges the person sees", async () => {
    const { runReport } = await import("@/server/report-builder/engine");
    const { ReportDefinition } = await import("@/domain/report-builder");
    const { SegmentSchema } = await import("@/domain/marketing");
    const run = async (who: string) => {
      const ctx = await ctxOf(who);
      const r = await runReport(ctx, await policyOf(who), ReportDefinition.parse({ shops: "all", filter: SegmentSchema.parse({ tags: [TAG] }), columns: [{ field: "name" }, { field: "badges" }] }), {
        pageSize: 50,
      });
      return Object.fromEntries(r.lines.flatMap((l) => (l.kind === "row" ? [[String(l.cells[0]).split(" ")[0], String(l.cells[1])]] : [])));
    };
    const owner = await run("owner");
    expect(owner.Cy).toMatch(/VIP/);
    expect(owner.Cy).toMatch(/Lapsed/);
    expect(owner.Ana).toMatch(/At risk/);
    const filtered = await runReport(
      await ctxOf("owner"),
      await policyOf("owner"),
      ReportDefinition.parse({ shops: "all", filter: SegmentSchema.parse({ tags: [TAG], badges: ["lapsed"] }), columns: [{ field: "name" }] }),
      { pageSize: 50 },
    );
    expect(filtered.lines.filter((l) => l.kind === "row").map((l) => String(l.kind === "row" && l.cells[0]))).toEqual(["Cy Badgetest"]);
  });

  it("makes custom badges from a segment filter, and only shows them to people who could run it", async () => {
    const admin = await ctxOf("admin");
    const id = await bd.saveCustomBadge(admin, { label: "Big spender", tooltip: "Spent $1,000 or more this year", icon: "crown", tone: "amber", filter: { minSpendCents: 100_000 } });
    await expect(bd.saveCustomBadge(admin, { label: "Nothing", filter: {} })).rejects.toMatchObject({ code: "bad_request" });
    await expect(bd.saveCustomBadge(admin, { label: "Loop", filter: { badges: ["vip"] } })).rejects.toMatchObject({ code: "bad_request" });
    await expect(bd.saveCustomBadge(await ctxOf("makenna"), { label: "Mine", filter: { tags: [TAG] } })).rejects.toMatchObject({ code: "forbidden" });
    const key = `custom:${id}`;
    expect((await bd.storedBadges([c.cy.id])).get(c.cy.id)!.map((b) => b.k)).toContain(key);
    expect((await bd.storedBadges([c.ana.id])).get(c.ana.id)!.map((b) => b.k)).not.toContain(key);
    const owner = await policyOf("owner");
    expect((await bd.shownBadges(owner, [c.cy.id])).get(c.cy.id)!.find((b) => b.key === key)).toMatchObject({ label: "Big spender", tip: "Spent $1,000 or more this year", icon: "crown", tone: "amber" });
    // A spend filter: not for a barber without every client.
    expect((await policyOf("makenna")).badges.has(key)).toBe(false);
    expect((await listed("owner", { badges: [key] })).names).toEqual(["cy"]);
    await bd.deleteCustomBadge(admin, id);
    expect(await keysOf(c.cy.id)).not.toContain(key);
    expect((await policyOf("owner")).badges.has(key)).toBe(false);
  });

  it("counts today's booked clients by badge on Today and in the Morning Dashboard", async () => {
    const mine = await bd.badgeCounts([coralville], today, ["at_risk", "second_visit", "birthday_week"], { staffId: people.makenna });
    expect(mine.find((x) => x.key === "at_risk")?.count).toBeGreaterThanOrEqual(1);
    expect(mine.find((x) => x.key === "birthday_week")?.count).toBeGreaterThanOrEqual(1);
    const michelle = await bd.badgeCounts([coralville], today, ["second_visit"], { staffId: people.michelle });
    expect(michelle.find((x) => x.key === "second_visit")?.count).toBeGreaterThanOrEqual(1);

    await signInAs(people.makenna);
    const r = await open("/admin");
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.text).toContain("Your clients today");
    expect(r.text).toMatch(/at-risk client/);
    expect(r.text).toMatch(/Ana B\..{0,1500}at_risk/);
    expect(r.text).not.toMatch(/Ana B\..{0,1500}data-badge="?missing_info/);
    expect(r.text).not.toContain("Badgetest");

    const md = await import("@/server/morning-dashboard");
    const access = await import("@/server/auth/access");
    const { renderMorningText } = await import("@/domain/morning-render");
    const d = (await md.buildMorningDashboard({ access: (await access.loadStaffAccess(people.owner))!, firstName: "Ray", shopIds: [coralville], today, now: new Date() }))!;
    const atRisk = d.today?.clients?.find((x) => x.key === "at_risk");
    expect(atRisk?.count).toBeGreaterThanOrEqual(1);
    expect(atRisk?.label).toMatch(/at-risk client/);
    expect(renderMorningText(d).body).toMatch(/at-risk clients? booked today/);
  });

  it("runs from the cron route only with the secret", async () => {
    const { GET } = await import("@/app/api/cron/badges/route");
    const before = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-badges-secret";
    const call = (headers: Record<string, string> = {}) => GET(new Request("http://localhost/api/cron/badges", { headers }), { params: Promise.resolve({}) });
    try {
      expect((await call()).status).toBe(401);
      expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
      const ok = await call({ authorization: "Bearer test-badges-secret" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ remaining: 0 });
    } finally {
      process.env.CRON_SECRET = before;
    }
  });
});
