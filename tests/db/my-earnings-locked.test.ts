/**
 * My Earnings for a locked and exported pay period: the figures are what the lock kept (the approved
 * lines, the days and the workweeks), never worked out again, whatever changes in the live data
 * afterwards. periodStatus and isEstimate say so on every endpoint.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let run: typeof import("@/server/payroll/run");
let tl: typeof import("@/server/tips/ledger");
let today = "";
let token = "";
let me = "";
let cv = "";
let prev: { start: string; end: string };
let cur: { start: string; end: string };
let day = "";
const sales: Record<string, string> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const at = (d: string, minutes: number) => m.time.zonedWallTime(d, minutes).toJSDate();
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

async function sale(tipCents: number, tender: typeof credit | typeof cash, now: Date) {
  const x = await m.checkout.openBlankSale(cv, actor, me);
  const svc = (await m.catalog.shopCatalog(cv)).find((c) => c.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: x.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender, actor, now });
  return x.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const get = async (p: string) => {
  const r = await api.call("GET", p, { token });
  expect(r.status, `${p} ${r.text}`).toBe(200);
  return r.json as J;
};

async function withPay() {
  await m.db.db.update(s().staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(s().staff.id, me));
  onTestFinished(async () => void (await m.db.db.update(s().staff).set({ permissionOverrides: {} }).where(eq(s().staff.id, me))));
}

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  run = await import("@/server/payroll/run");
  tl = await import("@/server/tips/ledger");
  today = m.time.todayLocal();
  cv = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  me = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "makenna@rayz.test") }))!.id;
  await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(m.drizzle.sql`${s().shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  const choices = await run.periodChoices();
  const i = choices.findIndex((c) => c.current);
  [cur, prev] = [choices[i], choices[i + 1]];
  day = m.time.addDays(prev.start, 1);

  await m.db.db.insert(s().timeEntries).values({ staffId: me, shopId: cv, startsAt: at(day, 9 * 60), endsAt: at(day, 15 * 60), source: "manual" });
  sales.card = await sale(1500, credit, at(day, 10 * 60));
  sales.cash = await sale(700, cash, at(day, 11 * 60));
  const { declareCashTips } = await import("@/server/tips/declarations");
  await declareCashTips({ staffId: me, shopId: cv, businessDate: day, amountCents: 1100, attested: true, source: "manager", reason: "Handed in cash for the test", actor });
  await tl.syncTipLedger();
  await lockHours(prev.start, prev.end);
  expect(await run.approveAndLock(prev.start, prev.end, actor)).toMatchObject({ locked: expect.any(Number) });
  token = (await api.login("makenna@rayz.test")).accessToken;
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("a locked pay period is what its lock kept", () => {
  it("is locked and final on every endpoint, its figures and days from the lock", async () => {
    await withPay();
    const e = await get(`me/earnings?period=${prev.start}`);
    expect(e).toMatchObject({ periodStatus: "locked", isEstimate: false, exportStatus: "approved", snapshotId: expect.any(String) });
    expect(e.shops.find((x: J) => x.shopId === cv)).toMatchObject({ locked: true, fromLock: true });
    expect(e.cardTipsCents).toBeGreaterThanOrEqual(1500);
    expect(e.declaredCashTipsCents).toBeGreaterThanOrEqual(1100);
    expect(e.productionHours).toBeGreaterThanOrEqual(6);
    expect(e.workweeks.length).toBeGreaterThan(0);

    const d = await get(`me/earnings/days?periodId=${prev.start}`);
    expect(d).toMatchObject({ periodId: prev.start, periodStatus: "locked", isEstimate: false });
    expect(d.days.every((x: J) => x.fromLock)).toBe(true);
    const sum = (k: string) => d.days.reduce((a: number, x: J) => a + x[k], 0);
    for (const k of ["cardTipsCents", "cashTipsCents", "declaredCashTipsCents", "totalTipsCents"]) expect(sum(k), k).toBe(e[k]);
    expect(sum("productionHours")).toBeCloseTo(e.productionHours, 2);

    expect(await get(`me/payouts?periodId=${prev.start}`)).toMatchObject({ periodStatus: "locked", isEstimate: false });
    const list = (await get("me/pay-periods")).periods as J[];
    expect(list.find((p) => p.id === prev.start)).toMatchObject({ periodStatus: "locked", isEstimate: false });
    expect(list.find((p) => p.current)).toMatchObject({ periodStatus: "draft", isEstimate: true });

    const [r] = await m.db.db.select().from(s().payrollRuns).where(m.drizzle.and(eq(s().payrollRuns.periodStart, prev.start), eq(s().payrollRuns.payGroupId, (await run.ensurePayGroups()).find((g) => g.shopId === cv)!.id)));
    const snap = r.snapshot as { days: Record<string, unknown[]>; weeks: Record<string, unknown[]> };
    expect(snap.days[me].length).toBeGreaterThan(0);
    expect(snap.weeks[me].length).toBe(e.workweeks.length);
  });

  it("changes to the live data after the lock (a punch, a sale, a new wage) change nothing it shows; the report's lock check flags the drift", async () => {
    await withPay();
    const before = { e: await get(`me/earnings?period=${prev.start}`), d: await get(`me/earnings/days?periodId=${prev.start}`) };
    await m.db.db.insert(s().timeEntries).values({ staffId: me, shopId: cv, startsAt: at(m.time.addDays(day, 1), 9 * 60), endsAt: at(m.time.addDays(day, 1), 19 * 60), source: "manual" });
    await sale(900, cash, at(m.time.addDays(day, 1), 12 * 60));
    await m.db.db.update(s().payrollRates).set({ hourlyRate: 99 }).where(eq(s().payrollRates.staffId, me));
    await tl.syncTipLedger();

    const after = { e: await get(`me/earnings?period=${prev.start}`), d: await get(`me/earnings/days?periodId=${prev.start}`) };
    expect(after.e).toEqual(before.e);
    expect(after.d).toEqual(before.d);
    const view = (await run.buildPayroll(prev.start, prev.end, { clockChecks: false }))!;
    expect(view.blocks.find((b) => b.shopId === cv)!.lockCheck!.drift.some((x) => x.staffId === me)).toBe(true);
    expect(view.weeks[me].length).toBe(before.e.workweeks.length);
  });

  it("marked sent to iSolved: exported, sent to payroll, and still the same figures", async () => {
    await withPay();
    const before = await get(`me/earnings?period=${prev.start}`);
    await m.db.db.insert(s().payrollExportSends).values({ periodStart: prev.start, periodEnd: prev.end, shops: [], note: "test", sentBy: null });
    const e = await get(`me/earnings?period=${prev.start}`);
    expect(e).toMatchObject({ periodStatus: "exported", exportStatus: "sent", isEstimate: false, payrollStatus: expect.stringMatching(/^(sent_to_payroll|paid_in_paycheck)$/), sentToPayrollAt: expect.any(String) });
    const strip = (x: J) => ({ ...x, periodStatus: null, exportStatus: null, payrollStatus: null, sentToPayrollAt: null, periods: null });
    expect(strip(e)).toEqual(strip(before));
    expect(await get(`me/earnings/days?periodId=${prev.start}`)).toMatchObject({ periodStatus: "exported", isEstimate: false });
  });
});
