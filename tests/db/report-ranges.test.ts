/**
 * Date ranges against a real database: each person's last range is remembered per report (pages
 * only, never an export); a pay period is picked by number on each pay group's own calendar
 * (Dubuque runs on its own); "This pay period" follows the shops picked; the Payroll Report reviews
 * any dates but approves, locks and hands out iSolved files only on a full pay period, with
 * overtime still worked out per whole workweek; the dashboard's numbers follow the range; and
 * every report CSV and PDF says which dates and time zone it covers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { get, open, propsOf } from "./render";
import { signInAs } from "./session";
import { csvBody, csvRange } from "./csv";
import { fmtHours } from "@/domain/payroll/calc";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let S: typeof import("@/app/admin/reports/scope");
let R: typeof import("@/domain/report-range");
let periods: typeof import("@/server/payroll/periods");
let cal: typeof import("@/domain/payroll/calendar");

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const ids: Record<string, string> = {};
const fx = { a: "", moline: "", dubuque: "", rockIsland: "", start: "", end: "", from: "", to: "", molineGroup: "", dubuqueGroup: "" };
let dubuqueCalendar: import("@/domain/payroll/calendar").PayCalendar;
const at = (d: string, h = 12) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);
const day = (n: number) => m.time.addDays(fx.start, n);
const ctxNow = async () => (await (await import("@/server/auth/staff")).getStaffContext())!;
const groupOf = async (shop: string) => (await run.ensurePayGroups()).find((g) => norm(g.shop) === shop)!;
const saveCalendar = async (shop: string, calendar: import("@/domain/payroll/calendar").PayCalendar) => {
  const g = await groupOf(shop);
  return run.savePayGroup(g.id, { label: g.label, legalEntity: g.legalEntity, exportTab: g.exportTab, code: g.code, calendar }, actor);
};

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  S = await import("@/app/admin/reports/scope");
  R = await import("@/domain/report-range");
  periods = await import("@/server/payroll/periods");
  cal = await import("@/domain/payroll/calendar");
  for (const l of ["owner", "manager.moline"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  fx.dubuque = (await m.catalog.getShop("dubuque"))!.id;
  fx.rockIsland = (await m.catalog.getShop("rock-island"))!.id;

  // Dubuque on a calendar of its own: periods a week later than the brand's, numbered from 1.
  const d = await groupOf("dubuque");
  dubuqueCalendar = d.calendar;
  expect(await saveCalendar("dubuque", { ...cal.DEFAULT_BRAND_CALENDAR, anchorStart: "2026-10-11", anchorNumber: 1 })).toBeNull();
  fx.dubuqueGroup = d.id;
  const g = await groupOf("moline");
  fx.molineGroup = g.id;

  const links = await m.db.db
    .select({ id: m.schema.staff.id, n: m.drizzle.sql<number>`(select count(*) from staff_shops x where x.staff_id = ${m.schema.staff.id})::int` })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  fx.a = links.filter((l) => l.n === 1 && !Object.values(ids).includes(l.id)).at(-1)!.id;

  // A Moline pay period no other test reaches. A works 9-hour days Monday to Friday the first week
  // (45 hours, 5 of them overtime, on the Friday) and 8-hour days the second (40, none).
  const p = cal.periodOf(g.calendar, "2030-02-13");
  [fx.start, fx.end] = [p.start, p.end];
  // A review of Wednesday of the first week to Tuesday of the second: both weeks only partly in it.
  [fx.from, fx.to] = [day(3), day(9)];
  const worked = (days: number[], hours: number) => days.map((n) => ({ staffId: fx.a, shopId: fx.moline, kind: "worked" as const, startsAt: at(day(n), 8), endsAt: at(day(n), 8 + hours) }));
  const entries = [...worked([1, 2, 3, 4, 5], 9), ...worked([8, 9, 10, 11, 12], 8)];
  expect(await run.addTimeEntries(entries, actor)).toMatchObject({ added: entries.length });
  expect(await run.saveRate(fx.a, null, { hourlyRate: 15, servicePct: 0.5, productPct: 0.1, trainingRate: null }, actor)).toBeNull();
  await signInAs(ids.owner);
  await m.db.db.delete(m.schema.staffReportRanges).where(eq(m.schema.staffReportRanges.staffId, ids.owner));
}, 180_000);

afterAll(async () => {
  if (dubuqueCalendar) await saveCalendar("dubuque", dubuqueCalendar);
  if (ids.owner) await m.db.db.delete(m.schema.staffReportRanges).where(eq(m.schema.staffReportRanges.staffId, ids.owner));
  await m?.db.closeDb();
});

describe("each person's last range", () => {
  const scope = async (report: Parameters<typeof S.resolveScope>[2], p: Record<string, string> = {}, remember = true) => S.resolveScope(await ctxOwner(), { shop: fx.moline, ...p }, report, { remember });
  const ctxOwner = async () => (await import("@/server/report-access")).reportContext(await ctxNow(), "sales_summary");

  it("is kept per report when a link picks one, and a link without dates opens on it", async () => {
    expect((await scope("sales_summary")).preset).toBe("7d");
    expect((await scope("sales_summary", { preset: "lastweek" })).preset).toBe("lastweek");
    const back = await scope("sales_summary");
    expect([back.preset, back.rangeLabel, back.from, back.to]).toEqual(["lastweek", "Last week", R.presetRange("lastweek").from, R.presetRange("lastweek").to]);
    expect((await scope("card_vs_cash")).preset).toBe("7d");

    const custom = await scope("sales_summary", { from: "2026-09-30", to: "2026-09-01" });
    expect([custom.from, custom.to, custom.preset]).toEqual(["2026-09-01", "2026-09-30", null]);
    expect(await scope("sales_summary")).toMatchObject({ from: "2026-09-01", to: "2026-09-30", preset: null });
    const rows = await m.db.db.select().from(m.schema.staffReportRanges).where(eq(m.schema.staffReportRanges.staffId, ids.owner));
    expect(rows.map((r) => [r.report, r.preset, r.from, r.to])).toEqual([["sales_summary", null, "2026-09-01", "2026-09-30"]]);
  });

  it("isn't changed by an export, the assistant or another person", async () => {
    const exportRoute = (await import("@/app/admin/reports/export/route")).GET;
    expect((await get(exportRoute, `/admin/reports/export?type=sales_summary&preset=ytd&shop=${fx.moline}`)).status).toBe(200);
    expect(await scope("sales_summary", {}, false)).toMatchObject({ preset: "7d" });
    expect(await scope("sales_summary")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    await signInAs(ids["manager.moline"]);
    const theirs = await S.resolveScope(await (await import("@/server/report-access")).reportContext(await ctxNow(), "sales_summary"), {}, "sales_summary", { remember: true });
    expect(theirs.preset).toBe("7d");
    await signInAs(ids.owner);
  });

  it("keeps a relative pay period relative, and a report page reopens on the range last picked", async () => {
    const range = (p: Record<string, string>) => S.resolveRange(p, { shopIds: [fx.moline], defaultPreset: "7d", memory: { staffId: ids.owner, key: "payroll_summary" } });
    await range({ preset: "pp:last" });
    const [row] = await m.db.db.select().from(m.schema.staffReportRanges).where(m.drizzle.and(eq(m.schema.staffReportRanges.staffId, ids.owner), eq(m.schema.staffReportRanges.report, "payroll_summary")));
    expect(row).toMatchObject({ preset: "pp:last", from: null, to: null });
    expect((await range({})).rangeLabel).toBe("Last pay period");

    const first = await open("/admin/reports/sales", {}, { preset: "month" });
    expect(first.kind).toBe("ok");
    const heading = R.rangeHeading({ ...R.presetRange("month"), label: "Month to date" });
    expect(first.text).toContain(heading);
    expect((await open("/admin/reports/sales")).text).toContain(heading);
  });
});

describe("a pay period by number, per pay calendar", () => {
  const today = "2026-10-28";

  it("the picker has one list per calendar, Dubuque's on its own, newest first", async () => {
    const groups = await periods.payPeriodPicker([fx.moline, fx.rockIsland, fx.dubuque], today);
    expect(groups).toHaveLength(2);
    const [brand, dbq] = [groups.find((g) => g.shopIds.includes(fx.moline))!, groups.find((g) => g.shopIds.includes(fx.dubuque))!];
    expect(brand.shopIds).toEqual(expect.arrayContaining([fx.moline, fx.rockIsland]));
    expect(dbq.shopIds).toEqual([fx.dubuque]);
    expect(brand.periods[0]).toMatchObject({ number: 23, start: "2026-10-18", current: true });
    expect(brand.periods[1]).toMatchObject({ number: 22, start: "2026-10-04", end: "2026-10-17" });
    expect(dbq.periods[0]).toMatchObject({ number: 2, start: "2026-10-25", current: true });
    expect(dbq.periods.every((p) => p.number >= 1)).toBe(true);
    expect((await periods.payPeriodPicker([fx.moline, fx.rockIsland], today)).length).toBe(1);
  });

  it("resolves to that pay group's dates, and an unknown one falls back to the default", async () => {
    const opts = { shopIds: [fx.moline, fx.dubuque], defaultPreset: "lastpayperiod", today };
    const brand = await S.resolveRange({ preset: R.payPeriodNumberPreset(fx.molineGroup, 2026, 22) }, opts);
    expect(brand).toMatchObject({ from: "2026-10-04", to: "2026-10-17", payGroupId: fx.molineGroup });
    expect(brand.rangeLabel).toMatch(/^Pay period 22/);
    const dbq = await S.resolveRange({ preset: R.payPeriodNumberPreset(fx.dubuqueGroup, 2026, 1) }, opts);
    expect(dbq).toMatchObject({ from: "2026-10-11", to: "2026-10-24", payGroupId: fx.dubuqueGroup });
    expect(dbq.rangeLabel).toBe("Pay period 01 (Dubuque)");
    const unknown = await S.resolveRange({ preset: R.payPeriodNumberPreset("00000000-0000-4000-8000-000000000000", 2026, 1) }, opts);
    expect(unknown.preset).toBe("lastpayperiod");
    expect((await S.resolveRange({ preset: R.payPeriodNumberPreset(fx.molineGroup, 2026, 27) }, opts)).from).toBe("2026-12-13");
    expect((await S.resolveRange({ preset: R.payPeriodNumberPreset(fx.molineGroup, 2026, 28) }, opts)).preset).toBe("lastpayperiod");
  });

  it("This pay period and Last pay period follow the calendar of the shops picked", async () => {
    const at = (shopIds: string[], preset: string) => S.resolveRange({ preset }, { shopIds, defaultPreset: "7d", today });
    expect(await at([fx.moline], "payperiod")).toMatchObject({ from: "2026-10-18", to: today });
    expect(await at([fx.dubuque], "payperiod")).toMatchObject({ from: "2026-10-25", to: today });
    expect(await at([fx.dubuque], "lastpayperiod")).toMatchObject({ from: "2026-10-11", to: "2026-10-24" });
    expect(await at([fx.moline, fx.dubuque], "lastpayperiod")).toMatchObject({ from: "2026-10-04", to: "2026-10-17" });
  });
});

describe("the Payroll Report on any dates", () => {
  const line = (v: import("@/server/payroll/run").PayrollView | null) => v!.blocks.find((b) => b.shopId === fx.moline)!.lines.find((l) => l.staffId === fx.a)!;

  it("reviews dates that aren't a pay period: overtime over the whole workweek, partial weeks flagged", async () => {
    const v = await run.buildPayroll(fx.from, fx.to, { review: { shopIds: [fx.moline] } });
    expect(v!.review!.partialWeeks).toEqual([
      { weekStart: fx.start, from: fx.from, to: day(6) },
      { weekStart: day(7), from: day(7), to: fx.to },
    ]);
    const l = line(v);
    expect(l.input.workedHours).toBe(43);
    expect(l.otHours).toBe(5);
    expect(l.hours).toBe(38);
    const flagged = v!.anomalies.filter((a) => a.kind === "partial_workweek");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ staffId: fx.a, shopId: fx.moline });
    expect(flagged[0].message).toContain(`${fmtHours(5)} of overtime that week, an estimated ${fmtHours(5)} of it on days in the range`);

    const before = await run.buildPayroll(fx.start, day(3), { review: { shopIds: [fx.moline] } });
    expect(line(before)).toMatchObject({ otHours: 0 });
    expect(before!.anomalies.find((a) => a.kind === "partial_workweek")!.message).toContain(`${fmtHours(5)} of overtime that week, an estimated ${fmtHours(0)} of it`);

    const official = await run.buildPayroll(fx.start, fx.end);
    expect(official!.review).toBeNull();
    expect(line(official)).toMatchObject({ otHours: 5, hours: 80 });
  });

  it("refuses approve, lock and every download off a full pay period", async () => {
    for (const r of [await run.approvePayroll(fx.from, fx.to, actor), await run.lockPayroll(fx.from, fx.to, actor), await run.approveAndLock(fx.from, fx.to, actor)]) expect(r).toEqual({ error: run.notWholeWeeksMessage(fx.from, fx.to) });
    const download = (await import("@/app/admin/payroll/download/route")).GET;
    const isolved = (await import("@/app/admin/reports/payroll/isolved/file/route")).GET;
    const tipsPaid = (await import("@/app/admin/reports/payroll/tips-paid/file/route")).GET;
    for (const [route, url, text] of [
      [download, `/admin/payroll/download?group=${fx.molineGroup}&start=${fx.from}&end=${fx.to}`, run.notWholeWeeksMessage(fx.from, fx.to)],
      [isolved, `/admin/reports/payroll/isolved/file?start=${fx.from}&end=${fx.to}&shop=${fx.moline}`, run.notWholeWeeksMessage(fx.from, fx.to)],
      [tipsPaid, `/admin/reports/payroll/tips-paid/file?start=${fx.from}&end=${fx.to}&shop=${fx.moline}`, run.notWholeWeeksMessage(fx.from, fx.to)],
    ] as const) {
      const r = await get(route as never, url);
      expect([url, r.status, r.text]).toEqual([url, 409, text]);
    }
    // Dubuque's dates aren't the brand's pay period, so its group can't download the brand's.
    const r = await get(download as never, `/admin/payroll/download?group=${fx.dubuqueGroup}&start=${fx.start}&end=${fx.end}`);
    expect(r.status).toBe(409);
  });

  it("both Payroll Report pages say so, with no approval or files; a full pay period has them", async () => {
    const { ApprovalControls } = await import("@/app/admin/payroll/report/approval");
    for (const route of ["/admin/payroll/report", "/admin/reports/payroll/report"]) {
      const review = await open(route, {}, { from: fx.from, to: fx.to, shop: fx.moline });
      expect(review.kind, route).toBe("ok");
      expect(review.text).toContain("Not an official pay period");
      expect(review.text).toContain(R.rangeText(fx.from, fx.to));
      expect(review.text).toMatch(/2 workweeks are only partly in these dates/);
      expect(review.text).not.toContain("isolved-shop-file");
      expect(await propsOf(ApprovalControls, route, {}, { from: fx.from, to: fx.to, shop: fx.moline })).toEqual([]);

      expect(await propsOf(ApprovalControls, route, {}, { from: fx.start, to: fx.end, shop: fx.moline }), route).toHaveLength(1);
      expect((await open(route, {}, { from: fx.start, to: fx.end, shop: fx.moline })).text).toMatch(/Approve and lock covers every shop on this pay period \( ?\d+ ?\)\. \d+ aren't shown here; approving approves them too\./);
      const every = await open(route, {}, { from: fx.start, to: fx.end, shop: "all" });
      expect(every.text).not.toContain("Not an official pay period");
      expect(every.text).toMatch(/Dubuque is on another pay calendar/);
      expect(await propsOf(ApprovalControls, route, {}, { from: fx.start, to: fx.end, shop: "all" })).toHaveLength(1);
    }
  });

  it("a Dubuque pay period picked by number is official for Dubuque alone", async () => {
    const p = cal.periodOf((await groupOf("dubuque")).calendar, "2030-02-20");
    const r = await open("/admin/reports/payroll/report", {}, { preset: R.payPeriodNumberPreset(fx.dubuqueGroup, Number(p.checkDate.slice(0, 4)), p.number), shop: fx.dubuque });
    expect(r.kind).toBe("ok");
    expect(r.text).not.toContain("Not an official pay period");
    expect(r.text).toContain(`Pay period ${String(p.number).padStart(2, "0")} (Dubuque, ${p.checkDate.slice(0, 4)})`);
    const v = await run.buildPayroll(p.start, p.end);
    expect(v!.blocks.map((b) => b.shopId)).toEqual([fx.dubuque]);
  });
});

describe("the dashboard and exports follow the range", () => {
  it("the dashboard opens on the range picked, remembered, for the shops picked", async () => {
    const { DashboardPph } = await import("@/app/admin/pph-card");
    const sp = { from: fx.from, to: fx.to, shop: fx.moline };
    const [props] = await propsOf<{ range: { from: string; to: string; label: string } | null; shopIds: string[]; rankBy: string }>(DashboardPph, "/admin", {}, sp);
    expect(props).toMatchObject({ range: { from: fx.from, to: fx.to, label: "Custom range" }, shopIds: [fx.moline], rankBy: "range" });
    const page = await open("/admin");
    expect(page.text).toContain(R.rangeText(fx.from, fx.to));
    expect(page.text).toContain("Net sales in range");
    const [today] = await propsOf<{ range: unknown; rankBy: string }>(DashboardPph, "/admin", {}, { preset: "today" });
    expect(today).toMatchObject({ range: null, rankBy: "period" });
    expect((await open("/admin")).text).toContain("Net sales today");
  });

  it("PPH and product sales per client have a tile for the range, ranked by it, a day a point", async () => {
    const { pphDashboard } = await import("@/server/pph-dashboard");
    const ctx = await ctxNow();
    const d = (await pphDashboard({ access: ctx.access, shops: [{ id: fx.moline, name: "Moline" }], brand: false, today: "2030-03-31", now: new Date(), rankBy: "range", range: { from: fx.from, to: fx.to, label: "Custom range" } }))!;
    expect(d.periods).toEqual(["today", "yesterday", "period", "range"]);
    expect(d.barbers.find((b) => b.item.id === fx.a)!.item.p.hours).toBe(43);
    expect(d.spark.map((s) => s.date)).toEqual(Array.from({ length: 7 }, (_, i) => day(3 + i)));
    expect(d.perClient!.total.range).toMatchObject({ clients: expect.any(Number) });
  });

  it("CSVs open with the report, dates, shops and time zone; files made for importing don't", async () => {
    const exportRoute = (await import("@/app/admin/reports/export/route")).GET;
    const named = await get(exportRoute, `/admin/reports/export?type=sales_summary&preset=lastweek&shop=${fx.moline}`);
    const lw = R.presetRange("lastweek");
    expect(csvRange(named.text)).toEqual({ report: expect.stringMatching(/^Sales summary: /), range: `Last week: ${R.rangeText(lw.from, lw.to)}`, shops: "Moline", timeZone: "America/Chicago" });
    expect(csvBody(named.text).split("\n")[0]).not.toMatch(/^Report,/);
    const custom = await get(exportRoute, `/admin/reports/export?type=sales_summary&from=${fx.from}&to=${fx.to}&shop=${fx.moline}`);
    expect(csvRange(custom.text)!.range).toBe(R.rangeText(fx.from, fx.to));
    const journal = await get(exportRoute, `/admin/reports/export?type=card_fees&table=payments&from=${fx.from}&to=${fx.to}&shop=${fx.moline}`);
    expect(journal.status).toBe(200);
    expect(csvRange(journal.text)).toBeNull();
    const pdf = await exportRoute(new Request(`http://localhost/admin/reports/export?type=sales_summary&preset=lastweek&shop=${fx.moline}&format=pdf`));
    expect(pdf.status).toBe(200);
    const [log] = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "report.export")).orderBy(m.drizzle.desc(m.schema.auditLog.at)).limit(1);
    expect(log.details).toMatchObject({ format: "pdf", preset: "lastweek", from: lw.from, to: lw.to });
  });
});
