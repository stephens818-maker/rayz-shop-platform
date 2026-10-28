/**
 * My Earnings on the staff app, the Rayz App builder's contract (2026-10-28), against a real database
 * and a stand-in Stripe: /me/pay-periods, /me/earnings, /me/earnings/days, /me/earnings/tickets and
 * /me/payouts give the signed-in employee their own pay periods, pay with the greater-of worked out on
 * the server, tips by day and by ticket, each card tip's transfer to their Stripe account and the
 * Stripe payouts to their bank. The period's totals equal their row of the Payroll Report and their
 * row in the iSolved file to the cent. Then the negative side: another employee, their shop's
 * manager, the brand owner, a shop login, a staffId in the query and a dead token never get anyone
 * else's figures.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { TIP_DEPOSIT_CONSENT_VERSION } from "@/domain/tip-deposit-consent";
import { Mods, actor, loadModules } from "./setup";
import { STAFF_ROUTE_FILES, routePathOf, staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

let n = 0;
(globalThis as { __fakeStripe?: unknown }).__fakeStripe = {
  transfers: { create: async () => ({ id: `tr_fake_${++n}` }), createReversal: async () => ({ id: `trr_fake_${++n}` }) },
  payouts: { create: async () => ({ id: `po_fake_${++n}` }) },
};

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let tp: typeof import("@/server/tips/payouts");
let today = "";
const shop: Record<string, string> = {};
const ids: Record<string, string> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const call = (...a: Parameters<typeof api.call>) => api.call(...a);
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

/** What one employee's sales left behind, to look for in the other's answers. */
interface Trail {
  staffId: string;
  sales: string[];
  transfers: string[];
  stripeTransfers: string[];
  payouts: string[];
  stripePayouts: string[];
  declarations: string[];
  /** Tip amounts only they got, in cents. */
  amounts: number[];
}
const trail: Record<"makenna" | "michelle", Trail> = {
  makenna: { staffId: "", sales: [], transfers: [], stripeTransfers: [], payouts: [], stripePayouts: [], declarations: [], amounts: [1237, 503, 2519, 1209] },
  michelle: { staffId: "", sales: [], transfers: [], stripeTransfers: [], payouts: [], stripePayouts: [], declarations: [], amounts: [7713, 6619, 4421, 3307] },
};
const tokens: Record<string, string> = {};
let split = "";

async function onStripe(staffId: string, acct: string) {
  const row = {
    method: "stripe" as const,
    instant: false,
    stripeAccountId: acct,
    simulated: false,
    payoutsEnabled: true,
    detailsSubmitted: true,
    transfersCapability: "active",
    feesPayer: "application",
    destinationType: "bank_account" as const,
    destinationLast4: "6789",
    destinationName: "STRIPE TEST BANK",
    externalAccounts: [{ id: "ba_fake_bank", type: "bank_account" as const, name: "STRIPE TEST BANK", last4: "6789", default: true, instant: false }],
    depositConsentVersion: TIP_DEPOSIT_CONSENT_VERSION,
    depositConsentAt: new Date(),
  };
  await m.db.db.insert(s().staffPayoutAccounts).values({ staffId, ...row }).onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: row });
}

async function sale(staffId: string, tipCents: number, tender: typeof credit | typeof cash, o: { with?: string; tipByStaff?: { staffId: string; cents: number }[] } = {}) {
  const sale = await m.checkout.openBlankSale(shop.coralville, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shop.coralville)).find((x) => x.slug === "rayz-cut-shampoo")!;
  const lines = [{ kind: "service" as const, refId: svc.id, qty: 1 }, ...(o.with ? [{ kind: "service" as const, refId: svc.id, qty: 1, staffId: o.with }] : [])];
  await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents, tender, actor, ...(o.tipByStaff ? { tipSplit: "per_barber" as const, tipByStaff: o.tipByStaff } : {}) });
  return sale.id;
}

/** Every number anywhere in a JSON answer. */
function numbersIn(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number") out.push(x);
  else if (Array.isArray(x)) for (const v of x) numbersIn(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) numbersIn(v, out);
  return out;
}

function expectNoTrace(of: Trail, r: { text: string; json: unknown }, where: string) {
  for (const id of [of.staffId, ...of.sales, ...of.transfers, ...of.stripeTransfers, ...of.payouts, ...of.stripePayouts, ...of.declarations]) expect(r.text, `${where}: ${id}`).not.toContain(id);
  const nums = new Set(numbersIn(r.json));
  for (const a of of.amounts) expect(nums.has(a), `${where}: ${a}`).toBe(false);
}

const MINE = ["me/pay-periods", "me/earnings", "me/earnings/days", "me/earnings/tickets", "me/payouts", "me/earnings/ytd"];
const query = (p: string) => (p === "me/earnings/tickets" ? `?periodId=current&date=${today}` : p === "me/pay-periods" || p.endsWith("ytd") ? "" : "?period=current");

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  tp = await import("@/server/tips/payouts");
  const tl = await import("@/server/tips/ledger");
  today = m.time.todayLocal();
  for (const x of await m.db.db.select().from(s().shops)) shop[x.slug] = x.id;
  for (const k of ["makenna", "michelle", "owner"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, `${k}@rayz.test`) }))!.id;
  trail.makenna.staffId = ids.makenna;
  trail.michelle.staffId = ids.michelle;

  await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } });
  await m.db.db.update(s().shopPaymentAccounts).set({ stripeAccountId: "acct_fake_shop_coralville", simulated: false }).where(eq(s().shopPaymentAccounts.shopId, shop.coralville));
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  await onStripe(ids.makenna, "acct_fake_makenna");
  await onStripe(ids.michelle, "acct_fake_michelle");
  await m.db.db.insert(s().timeEntries).values({ staffId: ids.makenna, shopId: shop.coralville, startsAt: m.time.zonedWallTime(today, 30).toJSDate(), endsAt: m.time.zonedWallTime(today, 210).toJSDate(), source: "manual" });

  trail.makenna.sales.push(await sale(ids.makenna, 1237, credit), await sale(ids.makenna, 503, cash));
  trail.michelle.sales.push(await sale(ids.michelle, 7713, credit), await sale(ids.michelle, 6619, cash));
  split = await sale(ids.makenna, 4516, credit, { with: ids.michelle, tipByStaff: [{ staffId: ids.michelle, cents: 3307 }, { staffId: ids.makenna, cents: 1209 }] });

  for (const who of ["makenna", "michelle"] as const) {
    tokens[who] = (await api.login(`${who}@rayz.test`)).accessToken;
    const d = await call("POST", "tips/declarations", { token: tokens[who], body: { shopId: shop.coralville, businessDate: today, amountCents: who === "makenna" ? 2519 : 4421, attest: true } });
    expect(d.status, d.text).toBe(201);
    trail[who].declarations.push(d.json.id);
  }
  tokens.owner = (await api.login("owner@rayz.test")).accessToken;

  const b = await tp.buildBatch({ shopId: shop.coralville, kind: "manual", cutoff: today, actor });
  await tp.approveBatch(b.batchId, actor);
  for (const who of ["makenna", "michelle"] as const) {
    const ts = await m.db.db.select().from(s().paymentTransfers).where(and(eq(s().paymentTransfers.staffId, trail[who].staffId), eq(s().paymentTransfers.kind, "tip")));
    trail[who].transfers.push(...ts.map((t) => t.id));
    trail[who].stripeTransfers.push(...ts.flatMap((t) => (t.stripeTransferId ? [t.stripeTransferId] : [])));
    const ps = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, trail[who].staffId)));
    trail[who].payouts.push(...ps.map((p) => p.id));
    trail[who].stripePayouts.push(...ps.flatMap((p) => (p.stripePayoutId ? [p.stripePayoutId] : [])));
  }
}, 240_000);

afterAll(async () => {
  (globalThis as { __fakeStripe?: unknown }).__fakeStripe = undefined;
  await m?.db.closeDb();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const coralville = (r: { json: J }): J => r.json.shops.find((x: { shopId: string }) => x.shopId === shop.coralville);
const sumOf = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const get = async (p: string, who = "makenna") => {
  const r = await call("GET", p, { token: tokens[who] });
  expect(r.status, `${p} ${r.text}`).toBe(200);
  return r.json as J;
};

/** compensation.own for Makenna for one test (no role has it by default). */
async function withPay() {
  await m.db.db.update(s().staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(s().staff.id, ids.makenna));
  onTestFinished(async () => void (await m.db.db.update(s().staff).set({ permissionOverrides: {} }).where(eq(s().staff.id, ids.makenna))));
}

/** Their row in the shop's iSolved file, by header. */
async function isolvedRow(from: string, to: string, isolvedName: string) {
  const { isolvedWorkbook } = await import("@/server/payroll/reports");
  const file = (await isolvedWorkbook(from, to, [shop.coralville]))!;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.body as never);
  const rows = wb.worksheets.flatMap((ws) => {
    const out: (string | number | null)[][] = [];
    ws.eachRow((row) => void out.push((row.values as ExcelJS.CellValue[]).slice(1).map((v) => (v === undefined || v === null ? null : typeof v === "number" ? v : String(v)))));
    return out;
  });
  const header = rows.find((x) => x.includes("E_Regular_Hours"))!;
  const mine = rows.find((x) => x.includes(isolvedName))!;
  expect(mine, isolvedName).toBeTruthy();
  return { headers: header.filter((h): h is string => typeof h === "string" && /^[EM]_/.test(h)), value: (h: string) => Number(mine[header.indexOf(h)] ?? 0) };
}

describe("My Earnings: their own pay periods, pay, days, tickets and payouts", () => {
  it("pay periods: newest first, ids are start dates, the current one holds today, each with its status", async () => {
    const ps = (await get("me/pay-periods")).periods as J[];
    expect(ps.length).toBeGreaterThan(1);
    expect(ps.map((p) => p.start)).toEqual(ps.map((p) => p.start).sort().reverse());
    for (const p of ps) {
      expect(p.id).toBe(p.start);
      expect(["draft", "approved", "locked", "exported"]).toContain(p.periodStatus);
      expect(["draft", "approved", "sent"]).toContain(p.exportStatus);
    }
    const cur = ps.filter((p) => p.current);
    expect(cur).toHaveLength(1);
    expect(cur[0].start <= today && today <= cur[0].end).toBe(true);
    expect(cur[0]).toMatchObject({ periodStatus: "draft", exportStatus: "draft", payrollStatus: "not_yet_processed", isEstimate: true, shopIds: expect.arrayContaining([shop.coralville]) });

    const e = await get("me/earnings?period=current");
    expect(e.period.id).toBe(cur[0].id);
    expect([e.from, e.to]).toEqual([cur[0].start, cur[0].end]);
    expect(e).toMatchObject({ periodStatus: "draft", exportStatus: "draft", isEstimate: true, snapshotId: null, nextPeriodId: null, previousPeriodId: ps[1].id });
    expect((await get(`me/earnings?periodId=${cur[0].id}`)).period.id).toBe(cur[0].id);
    expect((await get(`me/earnings?from=${cur[0].start}&to=${cur[0].end}`)).period.id).toBe(cur[0].id);
    expect((await get(`me/earnings?period=${ps[1].id}`)).nextPeriodId).toBe(cur[0].id);
  });

  it("without compensation.own (Barber's default) every pay field is null and there's no total; tips still add up and check out against the iSolved row", async () => {
    const e = await get("me/earnings?period=current");
    expect(e.sees.wages).toBe(false);
    for (const k of ["appliedRule", "explanationCode", "hourlyRateCents", "hourlyPayCents", "serviceCommissionCents", "greaterOfCents", "commSalesCents", "wagesCents", "otEstimatedCents", "ptoPayCents", "totalCents"]) expect(e[k], k).toBeNull();
    expect(coralville({ json: e }).pay).toBeNull();
    expect(e.cardTipsCents).toBeGreaterThanOrEqual(1237 + 1209);
    expect(e.cashTipsCents).toBeGreaterThanOrEqual(503 + 2519);
    expect(e.declaredCashTipsCents).toBeGreaterThanOrEqual(2519);
    expect(e.cardTipsCents + e.cashTipsCents + e.giftCardTipsCents + e.tipAdjustmentsCents).toBe(e.totalTipsCents);
    const cv = coralville({ json: e });
    expect([...new Set(cv.reconciliation.isolved.map((c: { group: string }) => c.group))].sort()).toEqual(["hours", "tips"]);
    expect(cv.reconciliation.matches, JSON.stringify(cv.reconciliation)).toBe(true);
  });

  it("the period's totals are their Payroll Report row and their iSolved row to the cent, with the greater-of worked out on the server", async () => {
    await withPay();
    const e = await get("me/earnings?period=current");
    const cv = coralville({ json: e });
    expect(e.sees.wages).toBe(true);
    expect(cv.reconciliation.matches, JSON.stringify(cv.reconciliation)).toBe(true);

    const { buildPayroll } = await import("@/server/payroll/run");
    const { payrollReportData } = await import("@/server/payroll/reports");
    const { employeePay, toCents } = await import("@/domain/payroll/calc");
    const view = (await buildPayroll(e.from, e.to, { clockChecks: false }))!;
    const line = view.blocks.find((b) => b.shopId === shop.coralville)!.lines.find((l) => l.staffId === ids.makenna)!;
    expect(line.hours + line.otHours).toBeGreaterThan(0);

    // The Payroll Report, as the report page renders it for a payroll manager.
    const report = await payrollReportData({ scope: { shopIds: [shop.coralville], from: e.from, to: e.to }, loc: { view: "combined", shops: [{ id: shop.coralville, name: cv.shopName }] } as never, perms: new Set(["payroll.rates"]) as never });
    const table = report.tables.find((t) => t.id === `loc-${e.from}_${e.to}-${shop.coralville}`)!;
    expect(table, report.tables.map((t) => t.id).join()).toBeTruthy();
    const labels = table.columns.map((c) => c.label);
    const row = (table.rows as J[][]).find((x) => x[0] === line.name)!;
    expect(row, line.name).toBeTruthy();
    const R = (label: string) => {
      expect(labels, label).toContain(label);
      return row[labels.indexOf(label)] as number;
    };
    expect(e.hourlyRateCents).toBe(R("Hourly Wage"));
    expect(e.hourlyPayCents).toBe(R("Hourly Total"));
    expect(e.serviceCommissionCents).toBe(R("Commission$"));
    expect(e.productCommissionCents).toBe(R("Product Total"));
    expect(e.commSalesCents).toBe(R("NetComm"));
    expect(e.totalTipsCents - e.declaredCashTipsCents).toBe(R("TIPS"));
    expect([e.regularHours, e.otHours, e.ptoHours, e.trainingHours]).toEqual([R("Hours"), R("O.T. HRS"), R("PTO HRs."), R("Training  Hours")]);
    if (e.sees.sales) expect([e.serviceSalesCents, e.productSalesCents]).toEqual([R("Service$"), R("Product$")]);
    expect(e.appliedRule).toBe(R("Service Total") > 0 ? "commission" : "hourly");
    expect(e.explanationCode).toBe(R("Commission$") === R("Hourly Total") ? "equal" : R("Commission$") > R("Hourly Total") ? "commission_higher" : "hourly_higher");
    expect(Math.abs(e.greaterOfCents - Math.max(R("Hourly Total"), R("Commission$")))).toBeLessThanOrEqual(1);
    expect(e.greaterOfCents + e.productCommissionCents + e.lateCommissionCents + e.commSalesAdjustmentCents).toBe(e.hourlyPayCents + e.commSalesCents);
    expect(cv.pay).toEqual(JSON.parse(JSON.stringify(employeePay(line))));

    // Their row in the iSolved file: iSolved pays the hours at their rate, the dollar columns as they are.
    const f = await isolvedRow(e.from, e.to, line.input.isolvedName);
    const rate = e.hourlyRateCents / 100;
    expect(e.regularHours).toBe(f.value("E_Regular_Hours"));
    expect(e.hourlyPayCents).toBe(toCents(f.value("E_Regular_Hours") * rate));
    expect(e.otHours).toBe(f.value("E_Overtime 1.5_Hours"));
    expect(e.otEstimatedCents).toBe(toCents(f.value("E_Overtime 1.5_Hours") * 1.5 * rate));
    expect(e.ptoPayCents).toBe(toCents(f.value("E_Ray'z Paid Time_Hours") * rate));
    expect(e.trainingPayCents).toBe(toCents(f.value("E_Training_Hours") * (e.trainingRateCents / 100)));
    expect(e.commSalesCents).toBe(toCents(f.value("E_Comm Sales_Dollars")));
    expect(e.totalTipsCents).toBe(toCents(f.value("E_Cash Tips Recd_Dollars")));
    const dollars = sumOf(
      f.headers.filter((h) => h.endsWith("_Dollars")),
      (h) => toCents(f.value(h)),
    );
    expect(e.totalCents).toBe(e.hourlyPayCents + e.otEstimatedCents + e.ptoPayCents + e.trainingPayCents + dollars);
    expect(e.totalCents).toBe(e.wagesCents + e.totalTipsCents);
    expect(e.totalCents).toBe(sumOf(e.shops as J[], (x) => x.pay.grossCents));
  });

  it("days add up to the period: tips by tender, declared cash, sales and hours", async () => {
    const e = await get("me/earnings?period=current");
    const d = await get(`me/earnings/days?periodId=${e.period.id}`);
    expect(d).toMatchObject({ from: e.from, to: e.to, periodId: e.period.id });
    const days = d.days as J[];
    for (const k of ["cardTipsCents", "cashTipsCents", "giftCardTipsCents", "cashOnTicketsCents", "declaredCashTipsCents", "tipAdjustmentsCents", "totalTipsCents"]) expect(sumOf(days, (x) => x[k]), k).toBe(e[k]);
    for (const k of ["productionHours", "trainingHours", "ptoHours"]) expect(sumOf(days, (x) => x[k]), k).toBeCloseTo(e[k], 2);
    if (e.sees.sales) for (const k of ["serviceSalesCents", "productSalesCents"]) expect(sumOf(days, (x) => x[k]), k).toBe(e[k]);
    const t = days.find((x) => x.date === today)!;
    expect(t.cardTipsCents).toBeGreaterThanOrEqual(1237 + 1209);
    expect(t.declaredCashTipsCents).toBe(2519);
    expect(t.cashTipsCents).toBe(t.cashOnTicketsCents + 2519);
    expect(t.productionHours).toBeGreaterThan(0);
    expect((await get(`me/earnings/days?from=${today}&to=${today}`)).days).toEqual([t]);
  });

  it("tickets: one Chicago day of a pay period, their own tip by tender, their share of a split ticket, how it reaches them, and the transfer's and the payout's status apart", async () => {
    const r = await get(`me/earnings/tickets?periodId=current&date=${today}`);
    expect(r).toMatchObject({ date: today, timezone: "America/Chicago", periodStatus: "draft", isEstimate: true });
    expect(r.periodId).toBe((await get("me/earnings?period=current")).period.id);
    expect((await get(`me/earnings/tickets?periodId=${r.periodId}&date=${today}`)).tickets).toEqual(r.tickets);
    const t = (id: string) => (r.tickets as J[]).find((x) => x.saleId === id);
    const [card, inCash] = trail.makenna.sales;
    expect(t(card)).toMatchObject({ shopId: shop.coralville, clientFirstName: expect.any(String), serviceName: expect.stringMatching(/./), cardTipCents: 1237, cashTipCents: 0, shared: false, tipDisposition: "stripe", transferStatus: "paid", transferReversedBy: null, transferArrivalDate: today, payoutId: trail.makenna.payouts[0], payoutStatus: "pending", payoutArrivalDate: null });
    expect(t(card)).not.toHaveProperty("transfer");
    expect(t(card)).not.toHaveProperty("payout");
    expect(t(inCash)).toMatchObject({ cardTipCents: 0, cashTipCents: 503, transferStatus: null, payoutStatus: null });
    expect(t(split)).toMatchObject({ cardTipCents: 1209, shared: true, transferStatus: "paid" });
    for (const x of r.tickets as J[]) expect(x.clientFirstName).not.toMatch(/\s/);
    for (const id of trail.michelle.sales) expect(t(id)).toBeUndefined();
    expect(new Date(t(card).startedAt).toISOString()).toBe(t(card).startedAt);
  });

  it("payouts: Stripe's status and arrival date through in_transit and paid; a bank return fails the payout but not the transfers; only Stripe reverses a transfer", async () => {
    const [card] = trail.makenna.sales;
    let p = await get("me/payouts?period=current");
    expect(p.bankLast4).toBe("6789");
    expect((p.transfers as J[]).map((t) => t.saleId).sort()).toEqual([card, split].sort());
    for (const t of p.transfers) expect(t).toMatchObject({ transferStatus: "paid", transferReversedBy: null, transferArrivalDate: today, payoutStatus: "pending" });
    for (const t of p.transfers) expect(t).not.toHaveProperty("status");
    expect(trail.makenna.payouts).toContain(p.transfers[0].payoutId);
    expect((p.payouts as J[]).map((x) => x.id)).toEqual(trail.makenna.payouts);
    expect(p.payouts[0]).toMatchObject({ payoutStatus: "pending", arrivalDate: null, returned: false, bankLast4: "6789" });
    expect(p.payouts[0]).not.toHaveProperty("status");
    expect(p.shops.find((x: J) => x.shopId === shop.coralville)).toMatchObject({ tipToBarber: true, tipTransfersEnabled: true, payrollCopy: null });

    const [row] = await m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.id, trail.makenna.payouts[0]));
    const arrives = m.time.addDays(today, 2);
    const event = (status: string, failure: string | null = null) =>
      tp.applyStaffPayoutEvent("acct_fake_makenna", { id: row.stripePayoutId!, status, failure_message: failure, metadata: { tipPayoutId: row.id }, arrival_date: Date.parse(`${arrives}T00:00:00Z`) / 1000 });
    await event("in_transit");
    p = await get("me/payouts?period=current");
    expect(p.payouts[0]).toMatchObject({ payoutStatus: "in_transit", arrivalDate: arrives });
    for (const t of p.transfers) expect(t).toMatchObject({ transferStatus: "paid", payoutStatus: "in_transit", payoutArrivalDate: arrives });

    await event("paid");
    await event("in_transit");
    p = await get("me/payouts?period=current");
    expect(p.payouts[0]).toMatchObject({ payoutStatus: "paid", arrivalDate: arrives, returned: false });
    expect(p.transfers.every((t: J) => t.payoutStatus === "paid")).toBe(true);

    await event("failed", "account_closed");
    p = await get("me/payouts?period=current");
    expect(p.payouts.find((x: J) => x.id === row.id)).toMatchObject({ payoutStatus: "failed", returned: true, failureMessage: expect.stringMatching(/account_closed/) });
    for (const t of p.transfers) expect(t).toMatchObject({ transferStatus: "paid", transferReversedBy: null, payoutId: null });

    const [tr] = await m.db.db
      .select()
      .from(s().paymentTransfers)
      .where(and(eq(s().paymentTransfers.saleId, card), eq(s().paymentTransfers.staffId, ids.makenna), eq(s().paymentTransfers.kind, "tip")));
    await tp.applyTransferReversed({ id: tr.stripeTransferId!, metadata: {} });
    await tp.applyTransferReversed({ id: tr.stripeTransferId!, metadata: {} });
    p = await get("me/payouts?period=current");
    expect(p.transfers.find((t: J) => t.saleId === card)).toMatchObject({ transferStatus: "reversed", transferReversedBy: "stripe" });
    expect(p.transfers.find((t: J) => t.saleId === split)).toMatchObject({ transferStatus: "paid", transferReversedBy: null });
    expect((await get(`me/earnings/tickets?periodId=current&date=${today}`)).tickets.find((x: J) => x.saleId === card)).toMatchObject({ transferStatus: "reversed", transferReversedBy: "stripe" });
    const stripePayoutStatuses = ["pending", "in_transit", "paid", "failed", "canceled"];
    for (const x of p.payouts as J[]) expect(stripePayoutStatuses).toContain(x.payoutStatus);
    for (const t of p.transfers as J[]) if (t.payoutStatus !== null) expect(stripePayoutStatuses).toContain(t.payoutStatus);
    const log = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.entityId, tr.id), eq(s().auditLog.action, "tips.transfer_reversed_by_stripe")));
    expect(log).toHaveLength(1);
  });

  it("the shop's tip switch decides: off, a new card tip is paid through payroll (no transfer), what already went to Stripe stays as it was", async () => {
    await m.db.db.update(s().shops).set({ tipToBarber: false }).where(eq(s().shops.id, shop.coralville));
    onTestFinished(async () => void (await m.db.db.update(s().shops).set({ tipToBarber: true }).where(eq(s().shops.id, shop.coralville))));
    const later = await sale(ids.makenna, 1777, credit);
    const tk = await get(`me/earnings/tickets?periodId=current&date=${today}`);
    const t = (id: string) => (tk.tickets as J[]).find((x) => x.saleId === id);
    expect(t(later)).toMatchObject({ cardTipCents: 1777, tipDisposition: "payroll", transferStatus: null, payoutStatus: null });
    expect(t(trail.makenna.sales[0])).toMatchObject({ tipDisposition: "stripe", transferStatus: "reversed" });
    const off = { tipToBarber: false, tipTransfersEnabled: false, payrollCopy: expect.stringMatching(/./) };
    expect(coralville({ json: await get("me/earnings?period=current") })).toMatchObject(off);
    const p = await get("me/payouts?period=current");
    expect(p.shops.find((x: J) => x.shopId === shop.coralville)).toMatchObject(off);
    expect((p.transfers as J[]).map((x) => x.saleId)).not.toContain(later);
  });
});

describe("nobody reads anyone else's earnings", () => {
  it("another employee at the same shop: neither sees the other's tickets, transfers, payouts, declarations or amounts", async () => {
    for (const [me, other] of [
      ["makenna", "michelle"],
      ["michelle", "makenna"],
    ] as const)
      for (const p of MINE) {
        const r = await call("GET", `${p}${query(p)}`, { token: tokens[me] });
        expect(r.status, `${me} ${p} ${r.text}`).toBe(200);
        expectNoTrace(trail[other], r, `${me} ${p}`);
      }
  });

  it("on a split ticket each sees only their own share and their own transfer", async () => {
    for (const [me, mine, theirs] of [
      ["makenna", 1209, 3307],
      ["michelle", 3307, 1209],
    ] as const) {
      const tk = await get(`me/earnings/tickets?periodId=current&date=${today}`, me);
      expect(tk.tickets.find((x: J) => x.saleId === split)).toMatchObject({ cardTipCents: mine, shared: true });
      expect(numbersIn(tk)).not.toContain(theirs);
      const po = await get("me/payouts?period=current", me);
      const row = po.transfers.find((x: J) => x.saleId === split);
      expect(row.amountCents).toBe(mine);
      expect(trail[me].transfers).toContain(row.id);
      expect(numbersIn(po)).not.toContain(theirs);
    }
  });

  it("a staff id in the query is refused (400), never honoured or quietly dropped", async () => {
    for (const p of MINE)
      for (const k of ["staffId", "staff_id", "employeeId", "userId", "as"]) {
        const q = query(p);
        const r = await call("GET", `${p}${q ? `${q}&` : "?"}${k}=${ids.michelle}`, { token: tokens.makenna });
        expect(r.status, `${p}?${k}: ${r.text}`).toBe(400);
        expectNoTrace(trail.michelle, r, `${p}?${k}`);
      }
  });

  it("a period the API can't pin down is 400 and one that doesn't exist is 404, never a guess", async () => {
    const e = await get("me/earnings?period=current");
    const bad = [
      `me/earnings?period=current&periodId=${e.period.id}`,
      "me/earnings?period=last",
      `me/earnings?from=${today}&to=${today}`,
      `me/earnings?from=${e.from}`,
      `me/earnings?period=current&from=${e.from}&to=${e.to}`,
      `me/earnings/days?from=${e.from}&to=${m.time.addDays(e.from, 31)}`,
      `me/earnings/days?from=${e.to}&to=${e.from}`,
      `me/earnings/tickets?periodId=current&date=${m.time.addDays(e.from, -1)}`,
      `me/earnings/tickets?periodId=current&date=${m.time.addDays(e.to, 1)}`,
      `me/earnings/tickets?date=${today}`,
      "me/earnings/tickets?periodId=current",
      "me/earnings/tickets",
      `me/earnings/tickets?period=current&date=${today}`,
      `me/earnings/tickets?periodId=current&date=${today}&from=${e.from}`,
      `me/earnings/tickets?periodId=current&date=2026-02-30`,
    ];
    for (const p of bad) {
      const r = await call("GET", p, { token: tokens.makenna });
      expect(r.status, `${p}: ${r.text}`).toBe(400);
    }
    for (const p of [`me/earnings?period=${m.time.addDays(e.from, 1)}`, "me/earnings?periodId=2020-01-02", "me/earnings/days?periodId=2020-01-02", "me/payouts?periodId=2020-01-02", "me/earnings/tickets?periodId=2020-01-02&date=2020-01-03"]) {
      const r = await call("GET", p, { token: tokens.makenna });
      expect(r.status, `${p}: ${r.text}`).toBe(404);
      expect(r.text).toMatch(/me\/pay-periods/);
    }
    expect((await call("GET", `me/earnings?from=${today}&to=${today}`, { token: tokens.makenna })).text).toMatch(/me\/earnings\/days/);
  });

  it("no route under /me takes an id for these, and every handler reads the employee from the token", async () => {
    const files = STAFF_ROUTE_FILES.map(routePathOf);
    expect(files.filter((x) => x.startsWith("me/earnings")).sort()).toEqual(["me/earnings", "me/earnings/days", "me/earnings/tickets", "me/earnings/ytd"]);
    expect(files).toEqual(expect.arrayContaining(["me/pay-periods", "me/payouts"]));
    for (const f of files.filter((x) => /^me\/(earnings|pay-periods|payouts)/.test(x))) expect(f).not.toMatch(/\[/);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/staff-api/earnings.ts", "utf8");
    for (const fn of ["myPayPeriodList", "myEarnings", "myEarningsDays", "myEarningsTickets", "myPayoutsView"]) expect(src).toMatch(new RegExp(`export async function ${fn}\\(ctx: StaffAppContext(, q: [^,)]+)?, today: LocalDate = todayLocal\\(\\)\\)`));
    expect(src).not.toMatch(/q\.staffId|staffId: q\./);
    expect(readFileSync("src/server/staff-api/pay.ts", "utf8")).toMatch(/export async function myYearToDate\(ctx: StaffAppContext, year: [^,)]+, today: LocalDate = todayLocal\(\)\)/);
  });

  it("their shop's manager and the brand owner get only their own figures here, whatever else they can see", async () => {
    // Michelle manages Coralville's timecards; the owner holds every permission.
    expect((await call("GET", `timecards/${ids.makenna}?period=${today}`, { token: tokens.michelle })).status).toBe(200);
    for (const p of MINE) {
      const r = await call("GET", `${p}${query(p)}`, { token: tokens.owner });
      expect([200, 403, 404], `owner ${p} ${r.text}`).toContain(r.status);
      expectNoTrace(trail.makenna, r, `owner ${p}`);
      expectNoTrace(trail.michelle, r, `owner ${p}`);
    }
  });

  it("a shop login, no token, a forged token and a signed-out session get nothing", async () => {
    const desk = (await api.login("coralville@rayz.test")).accessToken;
    const gone = await api.login("makenna@rayz.test");
    const out = await call("POST", "auth/logout", { body: { refreshToken: gone.refreshToken } });
    expect(out.status).toBe(204);
    for (const p of MINE) {
      const q = `${p}${query(p)}`;
      const cases = [
        ["shop login", desk, [403]],
        ["no token", undefined, [401]],
        ["forged", `${tokens.makenna.slice(0, -4)}AAAA`, [401]],
        ["signed out", gone.accessToken, [401]],
      ] as const;
      for (const [name, token, want] of cases) {
        const r = await call("GET", q, { token });
        expect(want, `${name} ${p}: ${r.status} ${r.text}`).toContain(r.status);
        expectNoTrace(trail.makenna, r, `${name} ${p}`);
        expectNoTrace(trail.michelle, r, `${name} ${p}`);
      }
    }
  });
});
