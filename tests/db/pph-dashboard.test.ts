/**
 * The dashboard's Productivity Per Hour card (Charles, Oct 28) against a real database, in a pay
 * period no other test reaches: today (with a shift still on the clock counted to now), yesterday
 * and the period to date, the barber and location leaderboards with the brand total, the 14-day
 * sparkline, a shop's dashboard showing only that shop, a barber seeing only their own, clients per
 * hour without money, and shops on different pay calendars each using their own period.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let dash: typeof import("@/server/pph-dashboard");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", today: "", now: new Date() };
let barberB: string;
let barberC: string;
let barberM: string;

const day = (n: number) => m.time.addDays(fx.start, n);
const at = (n: number, h: number) => m.time.zonedWallTime(day(n), h * 60).toJSDate();
const worked = (staffId: string, shopId: string, n: number, fromH: number, toH: number) => ({ staffId, shopId, kind: "worked" as const, startsAt: at(n, fromH), endsAt: at(n, toH) });
/** A sale with service sales and no lines: one completed service ticket. */
async function sale(staffId: string, shopId: string, n: number, serviceNetCents: number) {
  await m.db.db.insert(m.schema.sales).values({ shopId, staffId, businessDate: day(n), status: "paid", serviceNetCents, productNetCents: 0, paidAt: at(n, 12) });
}
async function clockIn(staffId: string, shopId: string, n: number, h: number, o: { forgot?: boolean } = {}) {
  await m.db.db.insert(m.schema.timePunches).values({ staffId, shopId, type: "in", at: at(n, h), originalAt: at(n, h), source: "manager", method: "manager", forgotFlaggedAt: o.forgot ? at(n, h + 1) : null });
}
async function bookable(shopId: string, except: string[]) {
  const links = await m.db.db
    .select({ id: m.schema.staffShops.staffId })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, shopId), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  return links.map((l) => l.id).find((id) => !except.includes(id))!;
}
async function card(who: string, shopIds: string[] | null, o: { rankBy?: "today" | "yesterday" | "period"; brand?: boolean } = {}) {
  const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids[who]))!;
  const shops = access.shops.filter((s) => (shopIds ? shopIds.includes(s.id) : true)).map((s) => ({ id: s.id, name: s.name }));
  return (await dash.pphDashboard({ access, shops, brand: o.brand ?? shopIds === null, today: fx.today, now: fx.now, rankBy: o.rankBy ?? "period" }))!;
}

beforeAll(async () => {
  m = await loadModules();
  dash = await import("@/server/pph-dashboard");
  const run = await import("@/server/payroll/run");
  for (const l of ["owner", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  barberB = await bookable(shop.coralville, [ids.makenna]);
  barberC = await bookable(shop.coralville, [ids.makenna, barberB]);
  barberM = await bookable(shop.moline, [ids.makenna, barberB, barberC]);
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  fx.start = periodOf(g.calendar, "2029-11-14").start;
  // Today is the period's second Tuesday; it's 1pm.
  fx.today = day(9);
  fx.now = at(9, 13);

  // Before the period (on the sparkline only): Makenna 8 hours, $240.
  // Day 1 at Moline: barber M 5 hours, $300. Yesterday at Coralville: Makenna 8 hours, $320; barber B 4 hours, $200.
  // Today: Makenna clocked in at 9 and still on the clock (4 hours by 1pm), $160. Barber C's forgotten clock-in doesn't count.
  await run.addTimeEntries([worked(ids.makenna, shop.coralville, -2, 9, 17), worked(barberM, shop.moline, 1, 10, 15), worked(ids.makenna, shop.coralville, 8, 9, 17), worked(barberB, shop.coralville, 8, 9, 13)], actor);
  await sale(ids.makenna, shop.coralville, -2, 24_000);
  await sale(barberM, shop.moline, 1, 30_000);
  await sale(ids.makenna, shop.coralville, 8, 32_000);
  await sale(barberB, shop.coralville, 8, 20_000);
  await sale(ids.makenna, shop.coralville, 9, 16_000);
  await clockIn(ids.makenna, shop.coralville, 9, 9);
  await clockIn(barberC, shop.coralville, 9, 8, { forgot: true });
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const board = (xs: { rank: number | null; item: { id: string; p: { servicePph: number | null } } }[]) => xs.map((x) => [x.rank, x.item.id, x.item.p.servicePph]);

describe("the brand dashboard", () => {
  it("today counts the shift still on the clock to now; yesterday and the period to date", async () => {
    const d = await card("owner", null);
    expect(d.scope).toBe("brand");
    expect(d.totalLabel).toBe("Brand");
    expect(d.money).toBe(true);
    expect(d.total.today).toMatchObject({ hours: 4, service: 16_000, servicePph: 4_000, clients: 1, clientsPerHour: 0.25 });
    expect(d.total.yesterday).toMatchObject({ hours: 12, service: 52_000, servicePph: 4_333 });
    expect(d.total.period).toMatchObject({ hours: 21, service: 98_000, servicePph: 4_667, clients: 4, clientsPerHour: 0.19 });
    expect(d.period).toMatchObject({ start: fx.start, end: day(13) });
    expect(d.dates).toEqual({ today: fx.today, yesterday: day(8) });
  });

  it("ranks barbers and locations by service PPH over the period to date", async () => {
    const d = await card("owner", null);
    expect(board(d.barbers)).toEqual([
      [1, barberM, 6_000],
      [2, barberB, 5_000],
      [3, ids.makenna, 4_000],
    ]);
    expect(d.barbers[0].item.detail).toBe("Moline");
    const locs = board(d.shops).filter((r) => r[2] !== null);
    expect(locs).toEqual([
      [1, shop.moline, 6_000],
      [2, shop.coralville, 4_250],
    ]);
    expect(d.shops.filter((x) => x.rank === null).every((x) => x.item.p.hours === 0)).toBe(true);
  });

  it("ranks today or yesterday when picked", async () => {
    expect(board((await card("owner", null, { rankBy: "today" })).barbers)).toEqual([[1, ids.makenna, 4_000]]);
    expect(board((await card("owner", null, { rankBy: "yesterday" })).barbers)).toEqual([
      [1, barberB, 5_000],
      [2, ids.makenna, 4_000],
    ]);
  });

  it("the sparkline is the last 14 days, each on its own, a gap where nobody worked", async () => {
    const d = await card("owner", null);
    expect(d.spark).toHaveLength(14);
    expect(d.spark[0].date).toBe(day(-4));
    expect(d.spark.at(-1)).toEqual({ date: fx.today, value: 4_000 });
    expect(d.spark.filter((s) => s.value !== null)).toEqual([
      { date: day(-2), value: 3_000 },
      { date: day(1), value: 6_000 },
      { date: day(8), value: 4_333 },
      { date: day(9), value: 4_000 },
    ]);
  });
});

describe("a shop's dashboard", () => {
  it("shows only that shop: its barbers, its total, no locations", async () => {
    const d = await card("owner", [shop.coralville], { brand: false });
    expect(d.scope).toBe("shop");
    expect(d.totalLabel).toBe("Coralville");
    expect(d.shopIds).toEqual([shop.coralville]);
    expect(d.shops).toEqual([]);
    expect(board(d.barbers)).toEqual([
      [1, barberB, 5_000],
      [2, ids.makenna, 4_000],
    ]);
    expect(d.total.period).toMatchObject({ hours: 16, service: 68_000, servicePph: 4_250 });
    expect(d.spark.find((s) => s.date === day(1))?.value).toBeNull();
  });

  it("each shop uses its own pay period where calendars differ", async () => {
    const [g] = await m.db.db.select().from(m.schema.payGroups).where(eq(m.schema.payGroups.shopId, shop.moline));
    await m.db.db
      .update(m.schema.payGroups)
      .set({ anchorStart: m.time.addDays(g.anchorStart, 7) })
      .where(eq(m.schema.payGroups.id, g.id));
    try {
      const d = await card("owner", null);
      expect(d.period).toBeNull();
      expect(d.total.period).toMatchObject({ hours: 16, service: 68_000 });
      expect(d.barbers.map((x) => x.item.id)).not.toContain(barberM);
    } finally {
      await m.db.db.update(m.schema.payGroups).set({ anchorStart: g.anchorStart }).where(eq(m.schema.payGroups.id, g.id));
    }
  });
});

describe("a barber", () => {
  it("sees only their own numbers, with no leaderboards", async () => {
    const d = await card("makenna", null);
    expect(d.scope).toBe("own");
    expect(d.totalLabel).toBe("You");
    expect(d.barbers).toEqual([]);
    expect(d.shops).toEqual([]);
    expect(d.total.period).toMatchObject({ hours: 12, service: 48_000, servicePph: 4_000 });
    expect(d.total.today).toMatchObject({ hours: 4, servicePph: 4_000 });
  });

  it("without money, the card is clients per hour", async () => {
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "reports.money": false } }).where(eq(m.schema.staff.id, ids.makenna));
    try {
      const d = await card("makenna", null);
      expect(d.money).toBe(false);
      expect(d.rank).toBe("clients");
      expect(d.total.period.clientsPerHour).toBe(0.17);
      expect(d.spark.at(-1)?.value).toBe(0.25);
    } finally {
      await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.makenna));
    }
  });

  it("nothing for someone without the PPH report", async () => {
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "report.pph.view": false } }).where(eq(m.schema.staff.id, ids.makenna));
    try {
      const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids.makenna))!;
      expect(await dash.pphDashboard({ access, shops: access.shops, brand: false, today: fx.today, now: fx.now, rankBy: "period" })).toBeNull();
    } finally {
      await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.makenna));
    }
  });
});
