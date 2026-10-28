/**
 * My Earnings on the staff app (Charles, 2026-10-28) against a real database and a stand-in Stripe:
 * /me/earnings, /me/earnings/tips and /me/earnings/transfers give the signed-in employee their own
 * tips by ticket and by day (card and cash against declared cash), each card tip's transfer to their
 * Stripe account and the payout after it, and pay-period totals and the greater-of that match their
 * Payroll Report line and their row in the iSolved file to the cent. Then the negative side: another
 * employee, their shop's manager, the brand owner, a shop login, a staffId in the query and a dead
 * token never get anyone else's figures.
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

const MINE = ["me/earnings", "me/earnings/tips", "me/earnings/transfers", "me/earnings/ytd"];

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

describe("My Earnings: their own tips, transfers and pay", () => {
  it("tips per ticket and per day: card and cash on tickets, declared cash, their share of a split ticket", async () => {
    const r = await call("GET", `me/earnings/tips?period=${today}`, { token: tokens.makenna });
    expect(r.status, r.text).toBe(200);
    const cv = coralville(r);
    const ticket = (id: string) => cv.tickets.find((t: J) => t.saleId === id)!;
    const [card, inCash] = trail.makenna.sales;
    expect(ticket(card)).toMatchObject({ cardCents: 1237, cashCents: 0, tipsCents: 1237, shared: false, transfer: { status: "sent", amountCents: 1237, stripeTransferId: expect.stringMatching(/^tr_fake_/) } });
    expect(ticket(inCash)).toMatchObject({ cardCents: 0, cashCents: 503, tipsCents: 503, transfer: null });
    expect(ticket(split)).toMatchObject({ cardCents: 1209, tipsCents: 1209, shared: true, transfer: { status: "sent", amountCents: 1209 } });
    const day = cv.days.find((d: J) => d.date === today)!;
    expect(day.declaredCashCents).toBe(2519);
    expect(day.cardCents).toBeGreaterThanOrEqual(1237 + 1209);
    expect(day.cashCents).toBeGreaterThanOrEqual(503);
    expect(cv.declarations.map((d: J) => d.amountCents)).toContain(2519);
    const sumOf = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
    expect(sumOf(cv.days as J[], (d) => d.tipsCents)).toBe(cv.totals.tipsCents);
    expect(cv.totals.cardCents + cv.totals.cashCents + cv.totals.giftCardCents - cv.totals.refundedCents + cv.totals.adjustmentsCents).toBe(cv.totals.tipsCents);
    expect(cv.totals.cashTipsRecdCents).toBe(cv.totals.tipsCents + cv.totals.declaredCashCents);
    expect(r.json.next).toBeNull();
    expect(r.json.previous < r.json.shops[0].period.start).toBe(true);
  });

  it("each card tip's Stripe transfer, and the payout that takes it to their bank, through to paid", async () => {
    let r = await call("GET", `me/earnings/transfers?period=${today}`, { token: tokens.makenna });
    expect(r.status, r.text).toBe(200);
    let cv = coralville(r);
    expect(cv.transfers.map((t: J) => t.saleId).sort()).toEqual([trail.makenna.sales[0], split].sort());
    for (const t of cv.transfers) {
      expect(t).toMatchObject({ status: "sent", statusLabel: "In your Stripe account", stripeTransferId: expect.stringMatching(/^tr_fake_/) });
      expect(trail.makenna.payouts).toContain(t.payout!.id);
      expect(t.payout!.stripePayoutId).toMatch(/^po_fake_/);
    }
    expect(cv.totals.sentCents).toBe(1237 + 1209);
    expect(cv.payouts.map((p: J) => p.id)).toEqual(trail.makenna.payouts);

    const [p] = await m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.id, trail.makenna.payouts[0]));
    await tp.applyStaffPayoutEvent("acct_fake_makenna", { id: p.stripePayoutId!, status: "paid", failure_message: null, metadata: { tipPayoutId: p.id } });
    r = await call("GET", `me/earnings/transfers?period=${today}`, { token: tokens.makenna });
    cv = coralville(r);
    expect(cv.transfers.every((t: J) => t.payout?.status === "paid" && t.payoutStatusLabel === "Paid")).toBe(true);
    expect(cv.totals.paidOutCents).toBe(1237 + 1209);
  });

  it("without compensation.own (Barber's default) there's no pay and no wage column; tips and hours still check out", async () => {
    const r = await call("GET", `me/earnings?period=${today}`, { token: tokens.makenna });
    expect(r.status, r.text).toBe(200);
    const cv = coralville(r);
    expect([r.json.sees.wages, cv.pay, cv.wages]).toEqual([false, null, null]);
    expect(cv.reconciliation.isolved.map((c: { group: string }) => c.group).sort()).toEqual(["hours", "hours", "hours", "hours", "tips"]);
    expect(cv.reconciliation.matches).toBe(true);
  });

  it("pay-period totals match their Payroll Report line and their row in the iSolved file to the cent, with the greater-of", async () => {
    await m.db.db.update(s().staff).set({ permissionOverrides: { "compensation.own": true } }).where(eq(s().staff.id, ids.makenna));
    onTestFinished(async () => void (await m.db.db.update(s().staff).set({ permissionOverrides: {} }).where(eq(s().staff.id, ids.makenna))));
    const r = await call("GET", `me/earnings?period=${today}`, { token: tokens.makenna });
    expect(r.status, r.text).toBe(200);
    const cv = coralville(r);
    expect(cv.reconciliation.matches, JSON.stringify(cv.reconciliation)).toBe(true);

    const { buildPayroll } = await import("@/server/payroll/run");
    const { isolvedWorkbook } = await import("@/server/payroll/reports");
    const { toCents } = await import("@/domain/payroll/calc");
    const view = (await buildPayroll(cv.period.start, cv.period.end, { clockChecks: false }))!;
    const line = view.blocks.find((b) => b.shopId === shop.coralville)!.lines.find((l) => l.staffId === ids.makenna)!;
    expect(cv.tips.totalCents).toBe(toCents(line.tips));
    expect(cv.tips.declaredCashCents).toBe(toCents(line.declaredCashTips));
    expect(cv.tips.declaredCashCents).toBeGreaterThanOrEqual(2519);
    expect(cv.hours.regular).toBe(line.hours);
    expect(cv.pay.totalWagesCents).toBe(toCents(line.totalWages));
    expect(cv.pay.commSalesCents).toBe(toCents(line.netComm));
    expect(cv.pay.greaterOf.result).toBe(line.serviceTotal > 0 ? "commission" : "hourly");
    expect(cv.pay.greaterOf.paidCents).toBe(toCents(line.serviceTotal > 0 ? line.commission : line.hourlyTotal));
    expect(cv.pay.greaterOf.paidCents + cv.pay.productCommissionCents + cv.pay.lateCommissionCents).toBe(cv.pay.totalWagesCents);

    const tips = (await call("GET", `me/earnings/tips?period=${today}`, { token: tokens.makenna })).json.shops.find((x: { shopId: string }) => x.shopId === shop.coralville);
    expect(cv.reconciliation.tickets).toMatchObject({ tipsCents: tips.totals.tipsCents, declaredCashCents: tips.totals.declaredCashCents, payrollReport: { tipsCents: toCents(line.tips), declaredCashCents: toCents(line.declaredCashTips) } });
    expect(cv.tips.cashTipsRecdCents).toBe(tips.totals.cashTipsRecdCents);

    const file = (await isolvedWorkbook(cv.period.start, cv.period.end, [shop.coralville]))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as never);
    const rows = wb.worksheets.flatMap((ws) => {
      const out: (string | number | null)[][] = [];
      ws.eachRow((row) => void out.push((row.values as ExcelJS.CellValue[]).slice(1).map((v) => (v === undefined || v === null ? null : typeof v === "number" ? v : String(v)))));
      return out;
    });
    const header = rows.find((x) => x.includes("E_Regular_Hours"))!;
    const mine = rows.find((x) => x.includes(line.input.isolvedName))!;
    expect(mine, line.input.isolvedName).toBeTruthy();
    expect(cv.reconciliation.isolved.map((c: J) => c.header)).toEqual(header.filter((h): h is string => typeof h === "string" && /^[EM]_/.test(h)));
    for (const c of cv.reconciliation.isolved) {
      const inFile = Number(mine[header.indexOf(c.header)] ?? 0);
      expect(toCents(inFile), c.header).toBe(toCents(c.amount));
      expect(toCents(c.payrollReport), c.header).toBe(toCents(c.amount));
    }
    const tipsRecd = cv.reconciliation.isolved.find((c: J) => c.header === "E_Cash Tips Recd_Dollars")!;
    expect(toCents(tipsRecd.amount)).toBe(cv.tips.cashTipsRecdCents);
  });
});

describe("nobody reads anyone else's earnings", () => {
  it("another employee at the same shop: neither sees the other's tickets, transfers, payouts, declarations or amounts", async () => {
    for (const [me, other] of [
      ["makenna", "michelle"],
      ["michelle", "makenna"],
    ] as const)
      for (const p of MINE) {
        const r = await call("GET", `${p}?${p.endsWith("ytd") ? "" : `period=${today}`}`, { token: tokens[me] });
        expect(r.status, `${me} ${p} ${r.text}`).toBe(200);
        expectNoTrace(trail[other], r, `${me} ${p}`);
      }
  });

  it("on a split ticket each sees only their own share and their own transfer", async () => {
    for (const [me, mine, theirs] of [
      ["makenna", 1209, 3307],
      ["michelle", 3307, 1209],
    ] as const) {
      const tips = (await call("GET", `me/earnings/tips?period=${today}`, { token: tokens[me] })).json;
      const t = tips.shops.find((x: { shopId: string }) => x.shopId === shop.coralville).tickets.find((x: { saleId: string }) => x.saleId === split);
      expect(t).toMatchObject({ tipsCents: mine, shared: true });
      const tr = (await call("GET", `me/earnings/transfers?period=${today}`, { token: tokens[me] })).json;
      const row = tr.shops.find((x: { shopId: string }) => x.shopId === shop.coralville).transfers.find((x: { saleId: string }) => x.saleId === split);
      expect(row.tipCents).toBe(mine);
      expect(trail[me].transfers).toContain(row.id);
      expect(numbersIn(tr)).not.toContain(theirs);
    }
  });

  it("a staff id in the query is refused (400), never honoured or quietly dropped", async () => {
    for (const p of MINE)
      for (const k of ["staffId", "staff_id", "employeeId", "userId", "as"]) {
        const r = await call("GET", `${p}?${k}=${ids.michelle}`, { token: tokens.makenna });
        expect(r.status, `${p}?${k}: ${r.text}`).toBe(400);
        expectNoTrace(trail.michelle, r, `${p}?${k}`);
      }
  });

  it("no route under /me/earnings takes an id, and every handler reads the employee from the token", async () => {
    const files = STAFF_ROUTE_FILES.map(routePathOf).filter((x) => x.startsWith("me/earnings"));
    expect(files.sort()).toEqual(["me/earnings", "me/earnings/tips", "me/earnings/transfers", "me/earnings/ytd"]);
    for (const f of files) expect(f).not.toMatch(/\[/);
    const { readFileSync } = await import("node:fs");
    const src = ["src/server/staff-api/earnings-detail.ts", "src/server/staff-api/pay.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const fn of ["myEarningsTips", "myTipTransfers", "myPeriodEarnings", "myYearToDate"]) expect(src).toMatch(new RegExp(`export async function ${fn}\\(ctx: StaffAppContext, (period|year): [^,)]+(, today: LocalDate = todayLocal\\(\\))?\\)`));
  });

  it("their shop's manager and the brand owner get only their own figures here, whatever else they can see", async () => {
    // Michelle manages Coralville's timecards; the owner holds every permission.
    expect((await call("GET", `timecards/${ids.makenna}?period=${today}`, { token: tokens.michelle })).status).toBe(200);
    for (const p of MINE) {
      const r = await call("GET", `${p}?${p.endsWith("ytd") ? "" : `period=${today}`}`, { token: tokens.owner });
      expect([200, 403], `owner ${p} ${r.text}`).toContain(r.status);
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
      const q = `${p}${p.endsWith("ytd") ? "" : `?period=${today}`}`;
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
