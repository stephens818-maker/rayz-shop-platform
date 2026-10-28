/**
 * The Payroll Report on start and end dates (Charles, via claude bot: "make sure payroll report is
 * date range"), against a real database:
 * 1. presets per pay group (current and last pay period, this and last week, month to date, custom;
 *    Dubuque on its own calendar), America/Chicago dates, 12-hour times;
 * 2. any range viewed and drilled into, overtime per whole Chicago workweek, partial weeks flagged
 *    and their overtime an estimate;
 * 3. approve, lock and the iSolved downloads on whole workweeks that don't overlap a locked range,
 *    blocked with a message otherwise (an overlap block included);
 * 4. sales, refunds, tips, commission at the rate in effect on each sale date, training and hours on
 *    the same range, so two workweeks add up to their pay period;
 * 5. /me/earnings and /me/earnings/tickets on from/to as well as a pay period.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { get, open } from "./render";
import { signInAs } from "./session";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let run: typeof import("@/server/payroll/run");
let S: typeof import("@/app/admin/reports/scope");
let R: typeof import("@/domain/report-range");
let periods: typeof import("@/server/payroll/periods");
let cal: typeof import("@/domain/payroll/calendar");
let api: Awaited<ReturnType<typeof staffApp>>;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const ids: Record<string, string> = {};
const fx = { a: "", moline: "", dubuque: "", coralville: "", start: "", end: "", molineGroup: "", dubuqueGroup: "", sold: "" };
const cash = { method: "cash" as const, cashTenderedCents: null };
const at = (d: string, h = 12) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + h * 3_600_000);
const day = (n: number) => m.time.addDays(fx.start, n);
const groupOf = async (shop: string) => (await run.ensurePayGroups()).find((g) => norm(g.shop) === shop)!;
const lineOf = (v: import("@/server/payroll/run").PayrollView | null, shopId = fx.moline, staffId = fx.a) => v!.blocks.find((b) => b.shopId === shopId)!.lines.find((l) => l.staffId === staffId)!;
const weeks = (from: string, to: string) => run.buildPayroll(from, to, { weeks: { shopIds: [fx.moline] } });
const download = async () => (await import("@/app/admin/payroll/download/route")).GET;

async function sell(d: string, o: { product?: boolean; tipCents?: number } = {}) {
  const sale = await m.checkout.openBlankSale(fx.moline, actor, fx.a);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const svc = (await m.catalog.shopCatalog(fx.moline)).find((s) => s.slug === "rayz-cut-shampoo")!;
  const product = ctx.retail.find((p) => p.stock > 0)!;
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "service", refId: svc.id, qty: 1 }, ...(o.product ? [{ kind: "product" as const, refId: product.productId, qty: 1 }] : [])],
    tipCents: o.tipCents ?? 0,
    tender: cash,
    actor,
    now: at(d),
  });
  return sale.id;
}

beforeAll(async () => {
  m = await loadModules();
  run = await import("@/server/payroll/run");
  S = await import("@/app/admin/reports/scope");
  R = await import("@/domain/report-range");
  periods = await import("@/server/payroll/periods");
  cal = await import("@/domain/payroll/calendar");
  api = await staffApp();
  for (const l of ["owner", "manager.moline", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  fx.moline = (await m.catalog.getShop("moline"))!.id;
  fx.dubuque = (await m.catalog.getShop("dubuque"))!.id;
  fx.coralville = (await m.catalog.getShop("coralville"))!.id;
  const g = await groupOf("moline");
  fx.molineGroup = g.id;
  fx.dubuqueGroup = (await groupOf("dubuque")).id;

  const links = await m.db.db
    .select({ id: m.schema.staff.id, n: m.drizzle.sql<number>`(select count(*) from staff_shops x where x.staff_id = ${m.schema.staff.id})::int` })
    .from(m.schema.staffShops)
    .innerJoin(m.schema.staff, eq(m.schema.staff.id, m.schema.staffShops.staffId))
    .where(m.drizzle.and(eq(m.schema.staffShops.shopId, fx.moline), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true), eq(m.schema.staff.active, true)));
  fx.a = links.filter((l) => l.n === 1 && !Object.values(ids).includes(l.id)).at(-1)!.id;

  // A Moline pay period no other test reaches. A works 9-hour days Monday to Friday the first week,
  // with 2 hours of training on the Monday (47 hours toward the 40: 7 overtime, on the Friday), and
  // 8-hour days the second (40, none). A raise starts on the second Sunday.
  const p = cal.periodOf(g.calendar, "2031-03-12");
  [fx.start, fx.end] = [p.start, p.end];
  const worked = (days: number[], hours: number) => days.map((n) => ({ staffId: fx.a, shopId: fx.moline, kind: "worked" as const, startsAt: at(day(n), 8), endsAt: at(day(n), 8 + hours) }));
  const entries = [...worked([1, 2, 3, 4, 5], 9), ...worked([8, 9, 10, 11, 12], 8), { staffId: fx.a, shopId: fx.moline, kind: "training" as const, startsAt: at(day(1), 18), endsAt: at(day(1), 20) }];
  expect(await run.addTimeEntries(entries, actor)).toMatchObject({ added: entries.length });
  expect(await run.saveRate(fx.a, null, { hourlyRate: 15, servicePct: 0.5, productPct: 0.1, trainingRate: 10 }, actor)).toBeNull();
  expect(await run.saveRate(fx.a, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.2, trainingRate: 10, effectiveFrom: day(7) }, actor)).toBeNull();

  // Week 1: a service and a product (tip $5), and a service refunded in week 2. Week 2: two services (tip $3).
  await sell(day(1), { product: true, tipCents: 500 });
  fx.sold = await sell(day(2));
  await sell(day(9), { tipCents: 300 });
  await sell(day(9));
  await m.checkout.refundEverything(fx.sold, "Wrong client", false, actor, at(day(10)));

  await lockHours(fx.start, fx.end, [fx.moline]);
  await signInAs(ids.owner);
  await m.db.db.delete(m.schema.staffReportRanges).where(eq(m.schema.staffReportRanges.staffId, ids.owner));
}, 240_000);

afterAll(async () => {
  if (ids.owner) await m.db.db.delete(m.schema.staffReportRanges).where(eq(m.schema.staffReportRanges.staffId, ids.owner));
  await m?.db.closeDb();
});

describe("rule 1: presets per pay group, Chicago dates", () => {
  const today = "2026-10-28";

  it("current and last pay period, this and last week, month to date; custom dates are any from/to", async () => {
    expect(R.PAYROLL_PRESETS.map((p) => [p.id, p.label])).toEqual([
      ["payperiod", "Current pay period"],
      ["lastpayperiod", "Last pay period"],
      ["week", "This week"],
      ["lastweek", "Last week"],
      ["month", "Month to date"],
    ]);
    expect(await periods.payrollPresetChips([fx.moline], today)).toEqual(R.PAYROLL_PRESETS);
    const range = (preset: string, wholePayPeriod = true) => S.resolveRange({ preset }, { shopIds: [fx.moline], defaultPreset: "lastpayperiod", wholePayPeriod, presets: R.PAYROLL_PRESETS, today });
    // The current pay period and week run to their last day, not today.
    expect(await range("payperiod")).toMatchObject({ from: "2026-10-18", to: "2026-10-31", rangeLabel: "Current pay period" });
    expect(await range("payperiod", false)).toMatchObject({ from: "2026-10-18", to: today });
    expect(await range("lastpayperiod")).toMatchObject({ from: "2026-10-04", to: "2026-10-17", rangeLabel: "Last pay period" });
    expect(await range("week")).toMatchObject({ from: "2026-10-25", to: "2026-10-31", rangeLabel: "This week" });
    expect(await range("lastweek")).toMatchObject({ from: "2026-10-18", to: "2026-10-24", rangeLabel: "Last week" });
    expect(await range("month")).toMatchObject({ from: "2026-10-01", to: today, rangeLabel: "Month to date" });
    expect(await S.resolveRange({ from: day(3), to: day(9) }, { shopIds: [fx.moline], defaultPreset: "lastpayperiod", wholePayPeriod: true, today })).toMatchObject({ from: day(3), to: day(9), preset: null });
    expect(R.RANGE_TIME_ZONE).toBe("America/Chicago");
  });

  it("each pay group has its own: Dubuque's current and last pay period, on its own calendar", async () => {
    const d = await groupOf("dubuque");
    const save = (calendar: import("@/domain/payroll/calendar").PayCalendar) => run.savePayGroup(d.id, { label: d.label, legalEntity: d.legalEntity, exportTab: d.exportTab, code: d.code, calendar }, actor);
    expect(await save({ ...cal.DEFAULT_BRAND_CALENDAR, anchorStart: "2026-10-11", anchorNumber: 1 })).toBeNull();
    onTestFinished(async () => void (await save(d.calendar)));

    const chips = await periods.payrollPresetChips([fx.moline, fx.dubuque], today);
    expect(chips.slice(0, R.PAYROLL_PRESETS.length)).toEqual(R.PAYROLL_PRESETS);
    expect(chips.slice(R.PAYROLL_PRESETS.length)).toEqual([
      { id: R.payGroupPeriodPreset(fx.dubuqueGroup, "current"), label: "Current pay period (Dubuque)" },
      { id: R.payGroupPeriodPreset(fx.dubuqueGroup, "last"), label: "Last pay period (Dubuque)" },
    ]);
    const opts = { shopIds: [fx.moline, fx.dubuque], defaultPreset: "lastpayperiod", wholePayPeriod: true, presets: chips, today };
    expect(await S.resolveRange({ preset: chips.at(-2)!.id }, opts)).toMatchObject({ from: "2026-10-25", to: "2026-11-07", payGroupId: fx.dubuqueGroup, rangeLabel: "Current pay period (Dubuque)" });
    expect(await S.resolveRange({ preset: chips.at(-1)!.id }, opts)).toMatchObject({ from: "2026-10-11", to: "2026-10-24", payGroupId: fx.dubuqueGroup });
    // Dubuque on its own: "Current pay period" already follows its calendar.
    expect(await periods.payrollPresetChips([fx.dubuque], today)).toEqual(R.PAYROLL_PRESETS);

    const page = await open("/admin/payroll/report", {}, { preset: chips.at(-1)!.id, shop: "all" });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Last pay period (Dubuque)");
    expect(page.text).toContain("Current pay period (Dubuque)");
    expect(page.text).not.toContain("Not an official pay period");
  });

  it("the report pages offer the presets and open on the pay period", async () => {
    for (const route of ["/admin/payroll/report", "/admin/reports/payroll/report"]) {
      const r = await open(route, {}, { preset: "lastpayperiod", shop: fx.moline });
      expect(r.kind, route).toBe("ok");
      for (const p of R.PAYROLL_PRESETS) expect(r.text, `${route} ${p.label}`).toContain(p.label);
    }
  });
});

describe("rule 2: any range, overtime per whole workweek, partial weeks an estimate", () => {
  it("a range cutting both workweeks: the overtime of the whole week, flagged as an estimate", async () => {
    const v = await run.buildPayroll(day(3), day(9), { review: { shopIds: [fx.moline] } });
    expect(v!.kind).toBe("review");
    expect(v!.review!.partialWeeks).toEqual([
      { weekStart: fx.start, from: day(3), to: day(6) },
      { weekStart: day(7), from: day(7), to: day(9) },
    ]);
    const l = lineOf(v);
    const wk1 = lineOf(await weeks(fx.start, day(6)));
    expect(wk1.otHours).toBe(7);
    // All 7 hours over 40 fall on the Friday, inside the range.
    expect(l.otHours).toBe(7);
    expect(v!.review!.otEstimates).toEqual({ [`${fx.a}|${fx.moline}`]: 7 });
    expect(v!.weeks[fx.a].map((w) => [w.weekStart, !!w.partial])).toEqual([
      [fx.start, true],
      [day(7), true],
    ]);
    const flagged = v!.anomalies.filter((a) => a.kind === "partial_workweek");
    expect(flagged.map((a) => a.message)).toEqual([expect.stringContaining("an estimated")]);

    // Days before the overtime: none estimated, still the week's.
    const early = await run.buildPayroll(day(1), day(3), { review: { shopIds: [fx.moline] } });
    expect(lineOf(early).otHours).toBe(0);
    expect(early!.review!.otEstimates).toEqual({});
  });

  it("both pages show the range, the partial weeks, the estimate and each week's breakdown", async () => {
    const r = await open("/admin/payroll/report", {}, { from: day(3), to: day(9), shop: fx.moline });
    expect(r.kind).toBe("ok");
    expect(r.text).toContain(R.rangeText(day(3), day(9)));
    for (const t of ["not-official", "partial-weeks", "partial-week", "ot-estimate", "estimate"]) expect(r.text, t).toContain(t);
    expect(r.text).toContain("starts on a Wednesday and ends on a Tuesday");
    const reports = await open("/admin/reports/payroll/report", {}, { from: day(3), to: day(9), shop: fx.moline });
    expect(reports.kind).toBe("ok");
    expect(reports.text).toContain("Not an official pay period");
    expect(reports.text).toMatch(/2 workweeks are only partly in these dates/);
  });
});

describe("rule 4: everything on the same range, commission at each sale date's rate (before any lock)", () => {
  it("two workweeks add up to their pay period: sales, refunds, tips, commission, training and hours", async () => {
    const [w1, w2, pp] = [lineOf(await weeks(fx.start, day(6))), lineOf(await weeks(day(7), fx.end)), lineOf(await run.buildPayroll(fx.start, fx.end))];
    const P = w2.service; // week 2: two services less the refund of one: one service's net.
    expect(w1.service).toBeCloseTo(2 * P, 2);
    for (const k of ["service", "product", "tips", "commission", "productTotal", "otHours", "trainingHours"] as const) expect(pp[k], k).toBeCloseTo(w1[k] + w2[k], 2);
    expect(pp.input.workedHours).toBe(w1.input.workedHours + w2.input.workedHours);
    expect([w1.input.workedHours, w2.input.workedHours, w1.trainingHours, w2.trainingHours]).toEqual([45, 40, 2, 0]);
    expect([w1.tips, w2.tips, pp.tips]).toEqual([5, 3, 8]);
    expect(w2.product).toBe(0);

    // Week 1 at the first rates; week 2's sales at the raise, its refund of a week 1 sale at the rate it was sold at.
    expect([w1.servicePct, w1.productPct, w1.wage]).toEqual([0.5, 0.1, 15]);
    expect(w1.commission).toBeCloseTo(0.5 * 2 * P, 2);
    expect(w1.productTotal).toBeCloseTo(0.1 * w1.product, 2);
    expect(w2.commission).toBeCloseTo(0.4 * 2 * P - 0.5 * P, 2);
    expect(w2.wage).toBe(16);
    expect(pp.input.mixedRates).toEqual(expect.arrayContaining(["servicePct", "wage"]));
    expect(pp.commission).toBeCloseTo(0.5 * 2 * P + 0.4 * 2 * P - 0.5 * P, 2);
  });

  it("the review of any range uses the same dates for each", async () => {
    const v = lineOf(await run.buildPayroll(day(3), day(9), { review: { shopIds: [fx.moline] } }));
    // Wed–Fri of week 1 (no sales), Mon–Tue of week 2 (the two services on the Tuesday); the refund is on the Wednesday after.
    expect([v.input.workedHours, v.trainingHours, v.tips, v.product]).toEqual([43, 0, 3, 0]);
    expect(v.commission).toBeCloseTo(0.4 * v.service, 2);
  });
});

describe("rule 3: approve, lock and download on whole workweeks that don't overlap a lock", () => {
  it("dates that aren't whole workweeks are blocked, with why", async () => {
    const msg = run.notWholeWeeksMessage(day(3), day(9));
    expect(msg).toContain("starts on a Wednesday and ends on a Tuesday");
    for (const r of [
      await run.approvePayroll(day(3), day(9), actor, null, [fx.moline]),
      await run.lockPayroll(day(3), day(9), actor, [fx.moline]),
      await run.approveAndLock(day(3), day(9), actor, [fx.moline]),
    ])
      expect(r).toEqual({ error: msg });
    const r = await get((await download()) as never, `/admin/payroll/download?group=${fx.molineGroup}&start=${day(3)}&end=${day(9)}&shop=${fx.moline}`);
    expect([r.status, r.text]).toEqual([409, msg]);
    expect(await run.runRefusal(day(3), day(9), [fx.moline])).toBe(msg);
  });

  it("the pay period is the default and the expected run", async () => {
    expect(await run.runRefusal(fx.start, fx.end)).toBeNull();
    expect((await run.payrollRunView(fx.start, fx.end))!.kind).toBe("pay_period");
    expect((await run.payrollRunView(fx.start, day(6), [fx.moline]))!).toMatchObject({ kind: "weeks", scope: fx.moline, scopeShopIds: [fx.moline] });
    expect(await run.payrollRunView(fx.start, day(6))).toBeNull();
  });

  it("whole workweeks run for the shops picked: approved, locked (number 0) and downloaded", async () => {
    expect(await run.isLockedOn(fx.moline, day(3))).toBe(false);
    expect(await run.approveAndLock(fx.start, day(6), actor, [fx.moline])).toEqual({ locked: 1 });
    const [r] = await m.db.db.select().from(m.schema.payrollRuns).where(m.drizzle.and(eq(m.schema.payrollRuns.payGroupId, fx.molineGroup), eq(m.schema.payrollRuns.periodStart, fx.start)));
    expect(r).toMatchObject({ periodEnd: day(6), periodNumber: 0 });
    const [a] = await m.db.db.select().from(m.schema.payrollApprovals).where(m.drizzle.and(eq(m.schema.payrollApprovals.periodStart, fx.start), m.drizzle.isNull(m.schema.payrollApprovals.revokedAt)));
    expect(a).toMatchObject({ periodEnd: day(6), scope: fx.moline });
    expect(await run.isLockedOn(fx.moline, day(3))).toBe(true);
    expect(await run.isLockedOn(fx.moline, day(10))).toBe(false);

    const file = await get((await download()) as never, `/admin/payroll/download?group=${fx.molineGroup}&start=${fx.start}&end=${day(6)}&shop=${fx.moline}`);
    expect(file.status, file.text).toBe(200);

    // 12-hour times on the locked run.
    const page = await open("/admin/payroll/report", {}, { from: fx.start, to: day(6), shop: fx.moline });
    expect(page.text).toContain("weeks-run");
    expect(page.text).toMatch(/Locked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · \d{1,2}:\d{2}\s?[AP]M/);
    expect(page.text).not.toMatch(/Locked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} · (1[3-9]|2\d):\d{2}/);
  });

  it("an overlap block: the pay period over the locked week can't be approved, locked or downloaded", async () => {
    const view = await run.payrollRunView(fx.start, fx.end);
    expect(view!.lockOverlaps).toEqual([expect.objectContaining({ shopId: fx.moline, start: fx.start, end: day(6) })]);
    const msg = run.overlapMessage(view!.lockOverlaps);
    expect(msg).toContain(`${R.rangeText(fx.start, day(6))} is locked at Moline`);
    for (const r of [await run.approvePayroll(fx.start, fx.end, actor), await run.lockPayroll(fx.start, fx.end, actor), await run.approveAndLock(fx.start, fx.end, actor)]) expect(r).toEqual({ error: msg });
    const r = await get((await download()) as never, `/admin/payroll/download?group=${fx.molineGroup}&start=${fx.start}&end=${fx.end}`);
    expect([r.status, r.text]).toEqual([409, msg]);
    // A run of whole weeks straddling the lock is blocked too.
    expect(await run.approveAndLock(m.time.addDays(fx.start, -7), day(6), actor, [fx.moline])).toEqual({ error: expect.stringContaining("These dates overlap a locked run") });

    for (const route of ["/admin/payroll/report", "/admin/reports/payroll/report"]) {
      const page = await open(route, {}, { from: fx.start, to: fx.end, shop: fx.moline });
      expect(page.text, route).toContain("lock-overlap");
      expect(page.text, route).toContain("These dates overlap a locked run");
    }

    // The database refuses an overlapping run whatever the code does.
    await expect(
      m.db.db.insert(m.schema.payrollRuns).values({ payGroupId: fx.molineGroup, periodStart: day(3), periodEnd: day(9), periodNumber: 0, checkDate: day(9), settings: {}, snapshot: {} }),
    ).rejects.toThrow();
  });

  it("the next workweek, which doesn't overlap, can still be run", async () => {
    expect(await run.runRefusal(day(7), fx.end, [fx.moline])).toBeNull();
    expect(await run.approveAndLock(day(7), fx.end, actor, [fx.moline])).toEqual({ locked: 1 });
    expect(await run.isLockedOn(fx.moline, day(10))).toBe(true);
    // The exact locked dates still open as locked.
    expect((await run.buildPayroll(fx.start, day(6), { weeks: { shopIds: [fx.moline] } }))!).toMatchObject({ locked: "all", lockOverlaps: [] });
  });
});

describe("rule 4, once locked: rates are effective-dated after the lock only", () => {
  it("a rate change on or before a locked range is refused, by the code and the database", async () => {
    expect(await run.saveRate(fx.a, null, { hourlyRate: 17, servicePct: 0.4, productPct: 0.2, trainingRate: 10, effectiveFrom: day(5) }, actor)).toMatch(/^Rates can't change on or before a locked pay period/);
    await expect(m.db.db.insert(m.schema.payrollRateVersions).values({ staffId: fx.a, shopId: null, effectiveFrom: day(5), hourlyRate: 17, servicePct: 0.4, productPct: 0.2 })).rejects.toThrow();
    const versions = await m.db.db.select().from(m.schema.payrollRateVersions).where(eq(m.schema.payrollRateVersions.staffId, fx.a)).orderBy(m.schema.payrollRateVersions.effectiveFrom);
    expect(versions.map((x) => [x.effectiveFrom, x.hourlyRate, x.servicePct])).toEqual([
      [run.FIRST_RATE_DATE, 15, 0.5],
      [day(7), 16, 0.4],
    ]);
    expect(await run.saveRate(fx.a, null, { hourlyRate: 17, servicePct: 0.4, productPct: 0.2, trainingRate: 10, effectiveFrom: m.time.addDays(fx.end, 1) }, actor)).toBeNull();
  });
});

describe("rule 5: /me/earnings on from/to", () => {
  let token = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type J = any;
  const call = async (p: string) => api.call("GET", p, { token });
  const ok = async (p: string) => {
    const r = await call(p);
    expect(r.status, `${p} ${r.text}`).toBe(200);
    return r.json as J;
  };

  beforeAll(async () => {
    const worked = (days: number[], hours: number) => days.map((n) => ({ staffId: ids.makenna, shopId: fx.coralville, kind: "worked" as const, startsAt: at(day(n), 8), endsAt: at(day(n), 8 + hours) }));
    const entries = [...worked([1, 2, 3, 4, 5], 9), ...worked([8, 9, 10, 11, 12], 8)];
    expect(await run.addTimeEntries(entries, actor)).toMatchObject({ added: entries.length });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(m.schema.staff.id, ids.makenna));
    token = (await api.login("makenna@rayz.test")).accessToken;
  }, 120_000);

  afterAll(async () => {
    if (m) await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, ids.makenna));
  });

  it("any dates: no pay period, the run kind, the partial weeks, an estimate", async () => {
    const e = await ok(`me/earnings?from=${day(3)}&to=${day(9)}`);
    expect(e).toMatchObject({ from: day(3), to: day(9), timezone: "America/Chicago", period: null, previousPeriodId: null, nextPeriodId: null, isEstimate: true });
    expect(e.range).toMatchObject({ kind: "review", wholeWorkweeks: false });
    expect(e.range.partialWeeks).toEqual([
      { weekStart: fx.start, from: day(3), to: day(6) },
      { weekStart: day(7), from: day(7), to: day(9) },
    ]);
    if (e.productionHours !== null) expect(e.productionHours).toBeCloseTo(43, 2);

    const w = await ok(`me/earnings?from=${fx.start}&to=${day(6)}`);
    expect(w.range).toMatchObject({ kind: "weeks", wholeWorkweeks: true, partialWeeks: [] });
    expect(w.period).toBeNull();
  });

  it("from/to that is exactly a pay period is that pay period; periodId still works", async () => {
    const e = await ok(`me/earnings?from=${fx.start}&to=${fx.end}`);
    expect(e.period).toMatchObject({ id: fx.start, start: fx.start, end: fx.end });
    expect(e.range).toBeNull();
    expect((await ok(`me/earnings?periodId=${fx.start}`)).period).toMatchObject({ id: fx.start });
  });

  it("tickets take from/to too; too long a range or half of one is a 400", async () => {
    const t = await ok(`me/earnings/tickets?from=${day(3)}&to=${day(9)}&date=${day(4)}`);
    expect(t).toMatchObject({ periodId: null, from: day(3), to: day(9) });
    expect((await ok(`me/earnings/tickets?periodId=${fx.start}&date=${day(4)}`)).periodId).toBe(fx.start);
    for (const p of [
      `me/earnings?from=${fx.start}&to=${m.time.addDays(fx.start, 92)}`,
      `me/earnings?from=${fx.start}`,
      `me/earnings?periodId=${fx.start}&from=${fx.start}&to=${day(6)}`,
      `me/earnings/tickets?from=${day(3)}&to=${day(9)}&date=${day(10)}`,
      `me/earnings/tickets?date=${day(4)}`,
    ]) {
      const r = await call(p);
      expect(r.status, `${p}: ${r.text}`).toBe(400);
    }
  });
});
