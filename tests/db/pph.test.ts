/**
 * Production per hour (Charles, Oct 28) against a real database, in a pay period no other test
 * reaches: service and product sales before tax and tips over clocked worked hours, per barber,
 * location and brand; N/A with no hours; ranks with ties; the trend; a barber seeing only their own;
 * the Payroll Report's review columns matching the report (and never in the iSolved file); the
 * Morning Dashboard section; /me/earnings' own PPH; and the migration's grants.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReportTable } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let api: Awaited<ReturnType<typeof staffApp>>;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx = { start: "", end: "" };
let barberB: string;
let barberC: string;
let barberM: string;
const label: Record<string, string> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const day = (n: number) => m.time.addDays(fx.start, n);
const span = (d: string, fromH: number, toH: number) => ({ startsAt: m.time.zonedWallTime(d, fromH * 60).toJSDate(), endsAt: m.time.zonedWallTime(d, toH * 60).toJSDate() });
const worked = (staffId: string, shopId: string, n: number, fromH: number, toH: number) => ({ staffId, shopId, kind: "worked" as const, ...span(day(n), fromH, toH) });
async function sale(staffId: string, shopId: string, n: number, serviceNetCents: number, productNetCents = 0, o: { imported?: boolean } = {}) {
  await m.db.db.insert(m.schema.sales).values({
    shopId,
    staffId,
    businessDate: day(n),
    status: "paid",
    serviceNetCents,
    productNetCents,
    serviceTaxCents: Math.round(serviceNetCents * 0.07),
    productTaxCents: Math.round(productNetCents * 0.07),
    paidAt: m.time.zonedWallTime(day(n), 12 * 60).toJSDate(),
    isImported: o.imported ?? false,
  });
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
  run = await import("@/server/payroll/run");
  api = await staffApp();
  for (const l of ["owner", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const x of await m.db.db.select().from(m.schema.shops)) shop[x.slug] = x.id;
  barberB = await bookable(shop.coralville, [ids.makenna]);
  barberC = await bookable(shop.coralville, [ids.makenna, barberB]);
  barberM = await bookable(shop.moline, [ids.makenna, barberB, barberC]);
  for (const s of await m.db.db.select({ id: m.schema.staff.id, label: m.schema.staff.displayLabel }).from(m.schema.staff)) label[s.id] = s.label;
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === shop.coralville)!;
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2029-08-15");
  [fx.start, fx.end] = [p.start, p.end];
  expect(m.time.weekdayOf(fx.start)).toBe(0);

  // Week one at Coralville: Makenna 9–5 Monday to Wednesday (24 hours), barber B Monday 9–1 (4 hours),
  // barber C sells with no hours. At Moline, barber M Tuesday 10–3 (5 hours).
  expect(
    await run.addTimeEntries(
      [worked(ids.makenna, shop.coralville, 1, 9, 17), worked(ids.makenna, shop.coralville, 2, 9, 17), worked(ids.makenna, shop.coralville, 3, 9, 17), worked(barberB, shop.coralville, 1, 9, 13), worked(barberM, shop.moline, 2, 10, 15)],
      actor,
    ),
  ).toEqual({ added: 5 });
  await sale(ids.makenna, shop.coralville, 1, 40_000, 5_000);
  await sale(ids.makenna, shop.coralville, 2, 32_000);
  await sale(ids.makenna, shop.coralville, 3, 24_000);
  await sale(barberB, shop.coralville, 1, 16_000);
  await sale(barberC, shop.coralville, 2, 10_000);
  await sale(barberM, shop.moline, 2, 30_000, 2_500);
  // A ticket imported from Squire in week two: payroll leaves it out, PPH counts it.
  await sale(ids.makenna, shop.coralville, 10, 4_800, 0, { imported: true });
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function load(who: string, p: Record<string, string | string[]>) {
  await signInAs(ids[who]);
  const S = await import("@/app/admin/reports/scope");
  const L = await import("@/server/report-data");
  const access = await import("@/server/report-access");
  const ctx = (await (await import("@/server/auth/staff")).getStaffContext())!;
  const rctx = await access.reportContext(ctx, "pph");
  const q = { from: fx.start, to: fx.end, ...p };
  const scope = await S.resolveScope(rctx, q, "pph");
  const params = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return { ...(await L.loadReport("pph", { scope, loc: scope.loc, viewer: rctx, params } as never)), scope };
}
const table = (d: { tables: ReportTable[] }, id: string) => d.tables.find((t) => t.id === id)!;
const col = (t: ReportTable, l: string) => t.columns.findIndex((c) => c.label === l);
const cells = (t: ReportTable, ...ls: string[]) => t.rows.map((r) => ls.map((l) => r[col(t, l)]));

describe("the PPH report", () => {
  it("ranks barbers by service PPH, ties sharing a rank and no hours N/A last, with the brand alongside", async () => {
    const d = await load("owner", { shop: shop.coralville, to: day(6) });
    const b = table(d, "barbers");
    const row = (id: string) => (id === ids.makenna ? [24, 96_000, 5_000, 4_000, 208, 4_208] : [4, 16_000, 0, 4_000, 0, 4_000]);
    const tied = [ids.makenna, barberB].sort((x, y) => label[x].localeCompare(label[y]));
    expect(cells(b, "Rank", "Barber", "Worked hours", "Service sales", "Product sales", "Service PPH", "Product PPH", "Total PPH")).toEqual([
      [1, label[tied[0]], ...row(tied[0])],
      [1, label[tied[1]], ...row(tied[1])],
      [null, label[barberC], 0, 10_000, 0, "N/A", "N/A", "N/A"],
      [null, expect.any(String), 28, 122_000, 5_000, 4_357, 179, 4_536],
      [null, "Brand", 33, 152_000, 7_500, 4_606, 227, 4_833],
    ]);
    expect(b.sorted).toEqual({ column: col(b, "Service PPH"), dir: "desc" });
    expect(b.sortBy?.[col(b, "Service PPH")]).toEqual({ rank: "service", order: "low" });
    expect(b.sortBy?.[col(b, "Total PPH")]).toEqual({ rank: "total", order: "high" });
    expect(d.stats.map((s) => [s.label, s.value])).toEqual([
      ["Service PPH", "$43.57"],
      ["Product PPH", "$1.79"],
      ["Total PPH", "$45.36"],
      ["Worked hours", "28"],
    ]);
    expect(d.stats[0].hint).toContain("brand $46.06");
    expect(d.stats[3].hint).toBe("1 with sales but no worked hours: N/A");
  });

  it("counts Squire-era tickets on the days they were sold, over a pay period", async () => {
    const d = await load("owner", { shop: shop.coralville });
    const b = table(d, "barbers");
    expect(cells(b, "Rank", "Barber").slice(0, 2)).toEqual([
      [1, label[ids.makenna]],
      [2, label[barberB]],
    ]);
    expect(b.rows[0].slice(2)).toEqual([24, 100_800, 5_000, 4_200, 208, 4_408]);
  });

  it("ranks by product or total PPH, lowest first when asked", async () => {
    const d = await load("owner", { shop: shop.coralville, rank: "product", order: "low" });
    const b = table(d, "barbers");
    expect(b.title).toBe("Barber leaderboard: Product PPH");
    expect(cells(b, "Rank", "Barber").slice(0, 3)).toEqual([
      [1, label[barberB]],
      [2, label[ids.makenna]],
      [null, label[barberC]],
    ]);
    expect(b.sorted).toEqual({ column: col(b, "Product PPH"), dir: "asc" });
  });

  it("per location and brand: every location's sales over its hours, and the whole brand needs no brand row", async () => {
    const d = await load("owner", { shop: Object.values(shop) });
    const locs = table(d, "locations");
    expect(cells(locs, "Location", "Worked hours", "Service PPH").filter((r) => r[1])).toEqual([
      ["Moline", 5, 6_000],
      ["Coralville", 28, 4_529],
      [expect.any(String), 33, 4_752],
    ]);
    expect(locs.rows.some((r) => r[1] === "Brand")).toBe(false);
    expect(d.notes?.join(" ")).toContain("the total is the brand");
    const byLoc = await load("owner", { shop: [shop.coralville, shop.moline], view: "shops" });
    const bl = table(byLoc, "barbers");
    expect(bl.title).toBe("Barbers by location: Service PPH");
    expect(bl.rows.filter((r) => r[2] === "Subtotal").map((r) => [r[0], r[col(bl, "Service PPH")]])).toEqual([
      ["Coralville", 4_529],
      ["Moline", 6_000],
    ]);
  });

  it("trends by week and by pay period, each period on its own, N/A where nobody worked", async () => {
    const d = await load("owner", { shop: shop.coralville, trend: "week" });
    const t = table(d, "trend");
    expect(cells(t, "Week", "Worked hours", "Service PPH")).toEqual([
      [expect.stringMatching(/^Week of /), 28, 4_357],
      [expect.stringMatching(/^Week of /), 0, "N/A"],
    ]);
    expect(t.columns.at(-1)!.label).toBe("Brand Service PPH");
    expect(d.charts?.map((c) => [c.id, c.kind])).toEqual([
      ["trend_pph", "money"],
      ["trend_total", "money"],
    ]);
    const pp = await load("owner", { shop: shop.coralville, trend: "period" });
    expect(cells(table(pp, "trend"), "Worked hours", "Service PPH")).toEqual([[28, 4_529]]);
    const daily = await load("owner", { shop: shop.coralville, trend: "day" });
    expect(table(daily, "trend").rows).toHaveLength(14);
  });

  it("shows a barber only their own PPH, without the brand", async () => {
    const d = await load("makenna", {});
    expect(d.scope.staffIds).toEqual([ids.makenna]);
    const b = table(d, "barbers");
    expect(b.rows.filter((r) => r[1] === label[ids.makenna])).toHaveLength(1);
    expect(b.rows.some((r) => r[1] === label[barberB] || r[1] === "Brand")).toBe(false);
  });
});

describe("the Payroll Report", () => {
  it("its PPH review columns are the report's, less the Squire-era tickets payroll leaves out", async () => {
    const { linePph, NA } = await import("@/domain/pph");
    const v = (await run.buildPayroll(fx.start, fx.end, { clockChecks: false }))!;
    const lineOf = (staffId: string) => v.blocks.find((b) => b.shopId === shop.coralville)!.lines.find((l) => l.staffId === staffId)!;
    const mk = lineOf(ids.makenna);
    expect(mk.hours + mk.otHours).toBe(24);
    expect(Math.round(linePph(mk).servicePph! * 100)).toBe(4_000);
    expect(Math.round(linePph(lineOf(barberB)).servicePph! * 100)).toBe(4_000);

    const { payrollReportData } = await import("@/server/payroll/reports");
    const report = await payrollReportData({ scope: { shopIds: [shop.coralville], from: fx.start, to: fx.end }, loc: { view: "combined", shops: [{ id: shop.coralville, name: "Coralville" }] } as never, perms: new Set(["payroll.rates"]) as never });
    const t = report.tables.find((x) => x.id === `loc-${fx.start}_${fx.end}-${shop.coralville}`)!;
    const labels = t.columns.map((c) => c.label);
    expect(labels.slice(-3)).toEqual(["Service PPH", "Product PPH", "Total PPH"]);
    const row = (name: string) => t.rows.find((r) => r[0] === name)!;
    expect(row(mk.name).slice(-3)).toEqual([4_000, 208, 4_208]);
    const c = lineOf(barberC);
    if (c) expect(row(c.name).slice(-3)).toEqual([NA, NA, NA]);
    expect(report.notes?.join(" ")).toMatch(/PPH/);

    const d = await load("owner", { shop: shop.coralville });
    expect(table(d, "barbers").rows.find((r) => r[1] === label[ids.makenna])![col(table(d, "barbers"), "Service PPH")]).toBe(4_200);
  });

  it("the iSolved file never carries PPH", async () => {
    const v = (await run.buildPayroll(fx.start, fx.end, { clockChecks: false }))!;
    for (const b of v.blocks) expect((b.exportHeaders ?? []).join("|")).not.toMatch(/pph|per hour/i);
  });
});

describe("other places", () => {
  it("the Morning Dashboard: the day's and week's PPH, per location, against the brand, barbers highest first", async () => {
    const md = await import("@/server/morning-dashboard");
    const access = (await (await import("@/server/auth/access")).loadStaffAccess(ids.owner))!;
    const d = (await md.buildMorningDashboard({ access, firstName: "Owner", shopIds: [shop.coralville], today: day(4), now: m.time.zonedWallTime(day(4), 7 * 60).toJSDate(), allSections: true }))!;
    expect(d.periods.reportDay).toBe(day(3));
    const p = d.pph!;
    expect([p.centi.day, p.service.day, p.centi.wtd, p.service.wtd, p.product.wtd]).toEqual([800, 24_000, 2_800, 122_000, 5_000]);
    expect(p.brand?.wtd).toEqual({ centi: 3_300, service: 152_000, product: 7_500 });
    expect(p.byShop).toEqual([]);
    expect(p.byBarber.map((b) => b.staffId)).toEqual([...[ids.makenna, barberB].sort((a, b) => label[a].localeCompare(label[b])), barberC]);
    expect(p.ownOnly).toBe(false);
    const { renderMorningText } = await import("@/domain/morning-render");
    expect(renderMorningText(d).body).toContain("Service PPH: $30.00");
  });

  it("/me/earnings: their own PPH for the period and per shop; none without sales or hours", async () => {
    const token = (await api.login("makenna@rayz.test")).accessToken;
    const r = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token });
    expect(r.status, r.text).toBe(200);
    expect(r.json.pph).toEqual({ workedHours: 24, servicePphCents: 4_000, productPphCents: 208, totalPphCents: 4_208, na: false });
    expect((r.json.shops as J[]).find((s) => s.shopId === shop.coralville).pph).toMatchObject({ servicePphCents: 4_000 });
    expect(JSON.stringify(r.json)).not.toContain(barberB);
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "reports.money": false } }).where(eq(m.schema.staff.id, ids.makenna));
    try {
      const t2 = (await api.login("makenna@rayz.test")).accessToken;
      const hidden = await api.call("GET", `me/earnings?periodId=${fx.start}`, { token: t2 });
      expect(hidden.json.pph).toBeNull();
    } finally {
      await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.makenna));
    }
  });

  it("the migration grants the report's view to managers and barbers, export with labor's, not the front desk", async () => {
    const roles = await m.db.db.select().from(m.schema.roles);
    const perms = (key: string) => (roles.find((r) => r.key === key)!.permissions as string[]) ?? [];
    for (const k of ["barber", "apprentice"]) {
      expect(perms(k)).toContain("report.pph.view");
      expect(perms(k)).not.toContain("report.pph.export");
    }
    expect(perms("shop_manager")).toEqual(expect.arrayContaining(["report.pph.view", "report.pph.export"]));
    expect(perms("front_desk")).not.toContain("report.pph.view");
  });
});
