/**
 * Pay day end to end, from what staff actually do to what lands in iSolved and their banks, with
 * every figure worked out by hand. Two pay periods for Jamie (Moline, Illinois, and Le Claire, Iowa:
 * one employer, so overtime crosses the shops) and Kat (Moline):
 *
 * - Sandbox (Stripe test mode, brand-settled shops, FEATURE_TIP_TO_BARBER on by default): phone punches and a manager-fixed missed
 *   clock-out → each timesheet signed by the employee, approved by a manager and locked → the
 *   period's sales and tips → the tip batch moves Jamie's tips by transfer and payout (Kat hasn't
 *   finished Stripe setup, so hers are owed) → the payout.paid webhook → the Payroll Report (greater-
 *   of at each shop, overtime split by hours) → approved by someone who didn't change the figures →
 *   each shop's iSolved file downloaded, cell for cell → locked → Kat's owed tips on her paycheck and
 *   never again, the tips-paid file final.
 * - Production with live keys before MONEY_MOVEMENT_LIVE (FEATURE_TIP_TO_BARBER on, as at launch): nothing moves on
 *   Stripe until live keys have been tested end to end; Jamie's tips are owed and go on his paycheck in the iSolved file instead.
 */
import ExcelJS from "exceljs";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TIP_DEPOSIT_CONSENT_VERSION } from "@/domain/tip-deposit-consent";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

type Call = { op: string; params: Record<string, unknown>; opts?: Record<string, unknown>; id: string };
const calls: Call[] = [];
let n = 0;
const record = (op: string, prefix: string) => async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
  const id = `${prefix}_payday_${++n}`;
  calls.push({ op, params, opts, id });
  return { id };
};
const fake = {
  charges: { create: record("debit", "py") },
  transfers: { create: record("transfer", "tr"), createReversal: record("reversal", "trr") },
  payouts: { create: record("payout", "po") },
  accounts: {
    update: async (id: string) => ({ id }),
    retrieve: async () => {
      throw new Error("offline in the test");
    },
  },
};
const fakeStripe = (on: boolean) => ((globalThis as { __fakeStripe?: unknown }).__fakeStripe = on ? fake : undefined);
const MONEY = ["debit", "transfer", "payout", "reversal"];
const WEBHOOK_SECRET = "whsec_payday_test";

let m: Mods;
let tc: typeof import("@/server/time-clock");
let run: typeof import("@/server/payroll/run");
let actions: typeof import("@/app/admin/payroll/actions");
let download: typeof import("@/app/admin/payroll/download/route");
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let mm: typeof import("@/server/payments/money-movement");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let reports: typeof import("@/server/payroll/reports");

type Person = { id: string; displayLabel: string };
const who: Record<"owner" | "jamie" | "kat", Person> = {} as never;
const shop = { moline: "", leclaire: "" };
const price = { product: 0, productId: "", cutId: { moline: "", leclaire: "" } };
const sandbox = { start: "", end: "" };
const launch = { start: "", end: "" };
let katOwed = "";

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
/** Chicago wall time: `min` minutes after midnight on `date`. */
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
const H = (h: number, mm = 0) => h * 60 + mm;
const day = (p: { start: string }, k: number) => m.time.addDays(p.start, k);
const actorOf = (p: Person) => ({ staffId: p.id, label: p.displayLabel });
const allShops: string[] = [];
const manager = () => ({ actor: actorOf(who.owner), staffId: who.owner.id, isOwner: true, shopIds: allShops });

async function punch(p: Person, shopId: string, type: "in" | "out" | "break_start" | "break_end", now: Date) {
  const r = await tc.punch({ staffId: p.id, shopId, type, source: "self", evidence: { deviceShopId: shopId, ip: null, gps: null }, deviceId: null, photo: null, actor: actorOf(p), now });
  if (r.kind !== "done") throw new Error(r.message);
  return r;
}
async function shift(p: Person, shopId: string, date: string, from: number, to: number, meal?: [number, number]) {
  await punch(p, shopId, "in", at(date, from));
  if (meal) {
    await punch(p, shopId, "break_start", at(date, meal[0]));
    await punch(p, shopId, "break_end", at(date, meal[1]));
  }
  await punch(p, shopId, "out", at(date, to));
}

const card = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };
/** A Ray'z Cut w/ Shampoo (and a product, if asked) for `p` at `when`, with a tip. */
async function ticket(p: Person, shopId: string, when: Date, tipCents: number, o: { product?: boolean; card?: boolean } = {}) {
  const sale = await m.checkout.openBlankSale(shopId, actor, p.id);
  await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [
      { kind: "service", refId: shopId === shop.moline ? price.cutId.moline : price.cutId.leclaire, qty: 1 },
      ...(o.product ? [{ kind: "product" as const, refId: price.productId, qty: 1 }] : []),
    ],
    tipCents,
    tender: o.card ? card : cash,
    actor,
    now: when,
  });
  return sale.id;
}

async function readyOnStripe(staffId: string, acct: string) {
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
    externalAccounts: [{ id: "ba_payday_bank", type: "bank_account" as const, name: "STRIPE TEST BANK", last4: "6789", default: true, instant: false }],
    depositConsentVersion: TIP_DEPOSIT_CONSENT_VERSION,
    depositConsentAt: new Date(),
  };
  await m.db.db.insert(s().staffPayoutAccounts).values({ staffId, ...row }).onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: row });
}

/** Every timesheet in the period signed by its employee and approved by a manager, then every shop's locked the morning after it ends (the run waits for all of them). */
async function closeTimesheets(p: { start: string; end: string }, people: [Person, string][]) {
  const inPeriod = at(p.end, H(20));
  const after = at(m.time.addDays(p.end, 1), H(9));
  const periods = new Set<string>();
  for (let d = p.start; d <= p.end; d = m.time.addDays(d, 1)) periods.add((await tc.periodFor(d)).start);
  for (const start of periods) {
    for (const [person, shopId] of people) {
      await tc.approveOwn(person.id, shopId, start, actorOf(person), inPeriod);
      await tc.approveAsManager(manager(), person.id, shopId, start, null, inPeriod);
    }
    for (const shopId of allShops) await tc.lockPeriod(manager(), shopId, start, after);
  }
}

const lineOf = (v: NonNullable<Awaited<ReturnType<typeof run.buildPayroll>>>, shopId: string, p: Person) => v.blocks.find((b) => b.shopId === shopId)!.lines.find((l) => l.staffId === p.id)!;
const payoutsOf = (batchId: string) => m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.batchId, batchId));
const employeeNumber = async (p: Person) => (await m.db.db.query.payrollProfiles.findFirst({ where: eq(s().payrollProfiles.staffId, p.id) }))!.employeeNumber;

/** Downloads one shop's iSolved file through the Payroll Report's route, as the signed-in user, and reads it back. */
async function isolvedFile(p: { start: string; end: string }, shopId: string) {
  const v = (await run.buildPayroll(p.start, p.end))!;
  const group = v.blocks.find((b) => b.shopId === shopId)!.payGroupId;
  const res = await download.GET(new Request(`http://localhost/admin/payroll/download?${new URLSearchParams({ group, start: p.start, end: p.end })}`));
  expect(res.status).toBe(200);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  expect(wb.worksheets).toHaveLength(1);
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  const rows = new Map<string, unknown[]>();
  ws.eachRow((r, i) => {
    if (i > 1) rows.set(String(r.getCell(1).value), (r.values as unknown[]).slice(1));
  });
  return { name, sheet: ws.name, header, rows };
}

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  run = await import("@/server/payroll/run");
  actions = await import("@/app/admin/payroll/actions");
  download = await import("@/app/admin/payroll/download/route");
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  mm = await import("@/server/payments/money-movement");
  connectWebhook = await import("@/server/payments/connect-webhook");
  reports = await import("@/server/payroll/reports");

  for (const [k, email] of [
    ["owner", "owner@rayz.test"],
    ["kat", "kat@rayz.test"],
  ] as const)
    who[k] = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!;
  who.jamie = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Jamie") }))!;
  shop.moline = (await m.catalog.getShop("moline"))!.id;
  shop.leclaire = (await m.catalog.getShop("le-claire"))!.id;
  allShops.push(...(await m.db.db.select({ id: s().shops.id }).from(s().shops).where(eq(s().shops.isDemo, false))).map((r) => r.id));

  const cut = async (shopId: string) => (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  const [cm, cl] = [await cut(shop.moline), await cut(shop.leclaire)];
  expect([cm.priceCents, cl.priceCents]).toEqual([2600, 2700]);
  price.cutId = { moline: cm.id, leclaire: cl.id };
  const probe = await m.checkout.openBlankSale(shop.moline, actor, who.jamie.id);
  const product = (await m.checkout.loadCheckoutContext(probe.id)).retail.find((p) => p.stock > 10)!;
  await m.db.db.delete(s().sales).where(eq(s().sales.id, probe.id));
  price.product = product.priceCents / 100;
  price.productId = product.productId;

  // Both shops settle card payments to the brand's account, so the platform can transfer their tips (ST-C11).
  await m.db.db.update(s().shops).set({ paymentsMode: "brand" }).where(m.drizzle.inArray(s().shops.id, [shop.moline, shop.leclaire]));
  await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } });
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(m.time.todayLocal(), 1));

  expect(await run.saveRate(who.jamie.id, null, { hourlyRate: 16, servicePct: 0.4, productPct: 0.15, trainingRate: null }, actor)).toBeNull();
  expect(await run.saveRate(who.kat.id, null, { hourlyRate: 14, servicePct: 0.5, productPct: 0.1, trainingRate: null }, actor)).toBeNull();

  const groups = await run.ensurePayGroups();
  const g = groups.find((x) => x.shopId === shop.moline)!;
  expect(groups.find((x) => x.shopId === shop.leclaire)!.legalEntity).toBe(g.legalEntity);
  const { periodOf } = await import("@/domain/payroll/calendar");
  const p = periodOf(g.calendar, "2027-03-10");
  Object.assign(sandbox, { start: p.start, end: p.end });
  const q = periodOf(g.calendar, m.time.addDays(p.end, 1));
  Object.assign(launch, { start: q.start, end: q.end });
  expect(m.time.weekdayOf(sandbox.start)).toBe(0);
  expect(periodOf(groups.find((x) => x.shopId === shop.leclaire)!.calendar, "2027-03-10").start).toBe(sandbox.start);
}, 240_000);

afterEach(() => {
  fakeStripe(false);
  mm.registerMoneyMovement(null);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.MONEY_MOVEMENT_LIVE;
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("sandbox pay period: Stripe test mode, tips straight to Jamie's bank", () => {
  it("punches become hours: meal breaks unpaid, a missed clock-out fixed by a manager with a reason", async () => {
    const p = sandbox;
    // Week 1: Moline Mon–Fri 9 to 3 (30h), Le Claire Saturday 8 to 8:30 with a half-hour meal (12h). 42h: 2h of overtime.
    for (let k = 1; k <= 5; k++) await shift(who.jamie, shop.moline, day(p, k), H(9), H(15));
    await shift(who.jamie, shop.leclaire, day(p, 6), H(8), H(20, 30), [H(12), H(12, 30)]);
    // Week 2: Moline Mon–Wed 9 to 3 (18h).
    for (let k = 8; k <= 10; k++) await shift(who.jamie, shop.moline, day(p, k), H(9), H(15));
    // Kat: Moline Mon–Thu of week 2, 10 to 4 (24h); she forgets to clock out on Thursday.
    for (let k = 8; k <= 10; k++) await shift(who.kat, shop.moline, day(p, k), H(10), H(16));
    await punch(who.kat, shop.moline, "in", at(day(p, 11), H(10)));
    await expect(tc.approveOwn(who.kat.id, shop.moline, p.start, actorOf(who.kat), at(p.end, H(20)))).rejects.toThrow(/missed punches/);
    await tc.addPunch(manager(), { staffId: who.kat.id, shopId: shop.moline, type: "out", at: at(day(p, 11), H(16)) }, "Forgot to clock out; left at 4", at(day(p, 12), H(9)));

    const v = (await run.buildPayroll(p.start, p.end))!;
    expect(lineOf(v, shop.moline, who.jamie).input.workedHours).toBe(48);
    expect(lineOf(v, shop.leclaire, who.jamie).input.workedHours).toBe(12);
    expect(lineOf(v, shop.moline, who.kat).input.workedHours).toBe(24);
    expect(v.weeks[who.jamie.id].find((w) => w.weekStart === p.start)).toMatchObject({ basis: 42, ot: 2 });
  });

  it("the period's tickets: Jamie 20 cuts and 2 products at Moline ($5 tips), 25 cuts at Le Claire ($6 tips); Kat 10 cuts ($3 tips)", async () => {
    const p = sandbox;
    const moline = [1, 2, 3, 4, 5, 8, 9, 10];
    for (let i = 0; i < 20; i++) await ticket(who.jamie, shop.moline, at(day(p, moline[i % moline.length]), H(10) + 15 * Math.floor(i / moline.length)), 500, { product: i < 2, card: i % 2 === 0 });
    for (let i = 0; i < 25; i++) await ticket(who.jamie, shop.leclaire, at(day(p, 6), H(8, 30) + 20 * i), 600, { card: i % 3 === 0 });
    for (let i = 0; i < 10; i++) await ticket(who.kat, shop.moline, at(day(p, 8 + (i % 4)), H(11) + 20 * Math.floor(i / 4)), 300, { card: i % 2 === 1 });
  });

  it("the tip batch moves Jamie's tips to his bank by transfer then payout; Kat hasn't finished Stripe setup, so hers are owed", async () => {
    const p = sandbox;
    await accounts.setPayoutChoice(who.jamie.id, { method: "stripe", instant: false }, actor);
    await readyOnStripe(who.jamie.id, "acct_payday_jamie");
    await accounts.setPayoutChoice(who.kat.id, { method: "stripe", instant: false }, actor);
    mm.registerMoneyMovement(mm.platformTipTransfers);
    fakeStripe(true);
    expect(mm.directPayoutsAvailable()).toBe(true);
    calls.length = 0;

    const cutoffAt = at(m.time.addDays(p.end, 1), H(9));
    const paid: Record<string, string> = {};
    for (const [shopId, cents] of [
      [shop.moline, 20 * 500],
      [shop.leclaire, 25 * 600],
    ] as const) {
      const b = await tp.buildBatch({ shopId, kind: "manual", cutoff: p.end, asOf: m.time.addDays(p.end, 1), actor, now: cutoffAt });
      const draft = await payoutsOf(b.batchId);
      const jamie = draft.find((x) => x.staffId === who.jamie.id)!;
      expect(jamie).toMatchObject({ method: "stripe", status: "pending", netCents: cents });
      if (shopId === shop.moline) {
        const kat = draft.find((x) => x.staffId === who.kat.id)!;
        expect(kat).toMatchObject({ method: "stripe", status: "held", holdKind: "stripe_setup", netCents: 10 * 300 });
        katOwed = kat.id;
      }
      await tp.approveBatch(b.batchId, actor, cutoffAt);
      const sent = (await payoutsOf(b.batchId)).find((x) => x.staffId === who.jamie.id)!;
      expect(sent).toMatchObject({ status: "processing", stripeTransferId: expect.any(String), stripePayoutId: expect.any(String) });
      paid[sent.stripePayoutId!] = sent.id;
    }
    const money = calls.filter((c) => MONEY.includes(c.op));
    expect(money.map((c) => [c.op, c.params.amount])).toEqual([
      ["transfer", 10_000],
      ["payout", 10_000],
      ["transfer", 15_000],
      ["payout", 15_000],
    ]);
    expect(money.filter((c) => c.op === "transfer").every((c) => c.params.destination === "acct_payday_jamie")).toBe(true);
    expect(money.filter((c) => c.op === "payout").every((c) => c.opts?.stripeAccount === "acct_payday_jamie")).toBe(true);

    // Stripe says each payout reached the bank.
    for (const [poId, payoutId] of Object.entries(paid)) {
      const amount = money.find((c) => c.id === poId)!.params.amount;
      const payload = JSON.stringify({ id: `evt_${poId}`, object: "event", type: "payout.paid", account: "acct_payday_jamie", data: { object: { id: poId, object: "payout", amount, status: "paid", arrival_date: Math.floor(cutoffAt.getTime() / 1000) + 86_400, failure_message: null } } });
      const r = await connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }), WEBHOOK_SECRET);
      expect(r.status).toBe(200);
      expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, payoutId) }))!.status).toBe("paid");
    }
  });

  it("the Payroll Report, by hand: overtime split by hours across the shops, the greater-of at each shop, tips paid direct vs. on the paycheck", async () => {
    const p = sandbox;
    await closeTimesheets(p, [
      [who.jamie, shop.moline],
      [who.jamie, shop.leclaire],
      [who.kat, shop.moline],
    ]);
    const v = (await run.buildPayroll(p.start, p.end))!;
    expect(v.mismatches).toEqual([]);

    // Jamie at Moline: 48h worked; of week 1's 2h OT, 30/42 here = 1.43. 46.57 regular × $16 = $745.12 beats 40% of $520 (20 cuts at $26, $208): hourly wins, so NetComm is the products' 15% only.
    const jm = lineOf(v, shop.moline, who.jamie);
    expect([jm.otHours, jm.hours]).toEqual([1.43, 46.57]);
    expect(jm.hourlyTotal).toBeCloseTo(745.12, 2);
    expect(jm.service).toBeCloseTo(520, 2);
    expect(jm.commission).toBeCloseTo(208, 2);
    expect(jm.product).toBeCloseTo(2 * price.product, 2);
    expect(jm.netComm).toBeCloseTo(0.15 * 2 * price.product, 2);
    expect(jm.totalWages).toBeCloseTo(745.12 + 0.15 * 2 * price.product, 2);
    expect([jm.tips, jm.tipsInPayroll, jm.tipsOutside]).toEqual([100, 0, 100]);
    expect(jm.otPay).toBeCloseTo(1.5 * 16 * 1.43, 2);

    // Jamie at Le Claire: 12h worked, 12/42 of the OT = 0.57; 11.43 × $16 = $182.88 under 40% of $675 (25 cuts at $27, $270): commission wins, NetComm $87.12.
    const jl = lineOf(v, shop.leclaire, who.jamie);
    expect([jl.otHours, jl.hours]).toEqual([0.57, 11.43]);
    expect(jl.hourlyTotal).toBeCloseTo(182.88, 2);
    expect(jl.commission).toBeCloseTo(270, 2);
    expect(jl.netComm).toBeCloseTo(87.12, 2);
    expect(jl.totalWages).toBeCloseTo(270, 2);
    expect([jl.tips, jl.tipsInPayroll, jl.tipsOutside]).toEqual([150, 0, 150]);

    // Kat at Moline: 24h × $14 = $336 beats 50% of $260 ($130). Her $30 of tips are owed (no Stripe setup), so they're on her paycheck.
    const k = lineOf(v, shop.moline, who.kat);
    expect([k.otHours, k.hours]).toEqual([0, 24]);
    expect(k.hourlyTotal).toBeCloseTo(336, 2);
    expect(k.netComm).toBe(0);
    expect([k.tips, k.tipsInPayroll, k.tipsInPayrollOwed, k.tipsOutside]).toEqual([30, 30, 30, 0]);

    const tips = (r: { staffId: string; shopId: string }) => r.staffId === who.jamie.id;
    expect(v.tips.mismatches).toEqual([]);
    expect(v.tips.rows.filter(tips).map((r) => [r.shopId, r.earnedCents, r.directCents, r.paidCents, r.problems.length])).toEqual(
      expect.arrayContaining([
        [shop.moline, 10_000, 10_000, 10_000, 0],
        [shop.leclaire, 15_000, 15_000, 15_000, 0],
      ]),
    );
  });

  it("approved by someone who didn't change the figures; each shop's iSolved file, cell for cell; then locked", async () => {
    const p = sandbox;
    await signInAs(who.kat.id);
    expect(await actions.approvePayrollAction(p.start, p.end, "")).toMatchObject({ ok: false });
    await signInAs(who.owner.id);
    expect(await actions.approvePayrollAction(p.start, p.end, "Checked against the timesheets")).toMatchObject({ ok: true });

    const [jamieNo, katNo] = [await employeeNumber(who.jamie), await employeeNumber(who.kat)];
    const mol = await isolvedFile(p, shop.moline);
    expect(mol.sheet).toBe("Moline");
    expect(mol.name).toMatch(/Moline\.xlsx$/);
    // The workbook's 8 columns, every tip in E_Cash Tips Recd however it's paid (Charles declined separate tip codes).
    expect(mol.header).toEqual(["Key", undefined, "E_Regular_Hours", "E_Overtime 1.5_Hours", "E_Cash Tips Recd_Dollars", "E_Comm Sales_Dollars", "E_Ray'z Paid Time_Hours", "E_Training_Hours"]);
    const productComm = Math.round(0.15 * 2 * price.product * 100) / 100;
    expect(mol.rows.get(String(jamieNo))!.slice(2)).toEqual([46.57, 1.43, 100, productComm, 0, 0]);
    expect(mol.rows.get(String(katNo))!.slice(2)).toEqual([24, 0, 30, 0, 0, 0]);

    const lc = await isolvedFile(p, shop.leclaire);
    expect(lc.sheet).toBe("LeClaire");
    expect(lc.header.at(-1)).toBe("E_Training_Hours");
    expect(lc.rows.get(String(jamieNo))!.slice(2)).toEqual([11.43, 0.57, 150, 87.12, 0, 0]);
    expect(lc.rows.has(String(katNo))).toBe(false);

    expect(await actions.lockPayrollAction(p.start, p.end)).toMatchObject({ ok: true });
    const locked = await isolvedFile(p, shop.moline);
    expect(locked.rows).toEqual(mol.rows);
    const downloads = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "payroll.download")).orderBy(s().auditLog.at);
    expect(downloads.map((d) => (d.details as { locked: boolean }).locked)).toEqual([false, false, true]);
  });

  it("after the lock: Kat's owed tips were paid on this paycheck, so no later batch pays them again, and the tips-paid file is final", async () => {
    const p = sandbox;
    expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, katOwed) }))!.status).toBe("cancelled");
    mm.registerMoneyMovement(mm.platformTipTransfers);
    fakeStripe(true);
    calls.length = 0;
    const later = at(m.time.addDays(p.end, 3), H(9));
    const b = await tp.buildBatch({ shopId: shop.moline, kind: "manual", cutoff: m.time.addDays(p.end, 2), asOf: m.time.addDays(p.end, 3), actor, now: later });
    expect((await payoutsOf(b.batchId)).filter((x) => x.netCents > 0)).toEqual([]);
    expect(calls).toEqual([]);
    await tp.cancelBatch(b.batchId, "Nothing left to pay", actor);

    const groups = await import("@/server/payroll/groups");
    for (const g of (await groups.ensurePayGroups()).filter((x) => x.shopId === shop.moline || x.shopId === shop.leclaire))
      expect(await groups.saveEmployer(g.employerId!, { isolvedCompanyCode: "RZI01", taxIdLast4: "6789" }, actor)).toBeNull();
    const file = (await reports.tipsPaidFile(p.start, p.end, [shop.moline, shop.leclaire]))!;
    expect(file.status).toBe("final");
    const [header, ...rows] = file.body.trim().split("\n").map((l) => l.split(","));
    const col = (r: string[], h: string) => r[header.indexOf(h)];
    const [jamieNo, katNo] = [String(await employeeNumber(who.jamie)), String(await employeeNumber(who.kat))];
    const rowFor = (no: string, state: string) => rows.find((r) => col(r, "Employee Number") === no && col(r, "Work State") === state)!;
    const jil = rowFor(jamieNo, "IL");
    const jia = rowFor(jamieNo, "IA");
    const kil = rowFor(katNo, "IL");
    expect([col(jil, "Tips Earned"), col(jil, "Paid via Stripe"), col(jil, "Owed")]).toEqual(["100.00", "100.00", "0.00"]);
    expect([col(jia, "Tips Earned"), col(jia, "Paid via Stripe")]).toEqual(["150.00", "150.00"]);
    expect([col(kil, "Tips Earned"), col(kil, "Paid Through Payroll"), col(kil, "Owed")]).toEqual(["30.00", "30.00", "0.00"]);
  });
});

describe("production with live keys before MONEY_MOVEMENT_LIVE: direct payouts wait for it", () => {
  it("nothing moves on Stripe; Jamie's tips are owed and go on his paycheck in the iSolved file", async () => {
    const p = launch;
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    mm.registerMoneyMovement(mm.platformTipTransfers);
    fakeStripe(true);
    calls.length = 0;
    expect(mm.moneyMovementLive()).toBe(false);
    // FEATURE_TIP_TO_BARBER is on at launch, but it doesn't move live money alone: MONEY_MOVEMENT_LIVE still has to be on.
    expect((await import("@/lib/flags")).flags.tipToBarber()).toBe(true);
    expect([mm.directPayoutsAvailable(), mm.transfersPendingReason()]).toEqual([false, mm.LIVE_SWITCH_REASON]);

    await shift(who.jamie, shop.moline, day(p, 1), H(9), H(15));
    await shift(who.jamie, shop.moline, day(p, 2), H(9), H(15));
    for (let i = 0; i < 5; i++) await ticket(who.jamie, shop.moline, at(day(p, 1 + (i % 2)), H(10) + 20 * i), 400, { card: true });

    const cutoffAt = at(m.time.addDays(p.end, 1), H(9));
    const b = await tp.buildBatch({ shopId: shop.moline, kind: "manual", cutoff: p.end, asOf: m.time.addDays(p.end, 1), actor, now: cutoffAt });
    const [held] = (await payoutsOf(b.batchId)).filter((x) => x.staffId === who.jamie.id);
    expect(held).toMatchObject({ method: "stripe", status: "held", holdKind: "transfers_pending", holdReason: mm.LIVE_SWITCH_REASON, netCents: 2000 });
    await tp.approveBatch(b.batchId, actor, cutoffAt);
    expect(calls.filter((c) => MONEY.includes(c.op))).toEqual([]);

    await closeTimesheets(p, [[who.jamie, shop.moline]]);
    const v = (await run.buildPayroll(p.start, p.end))!;
    expect(v.mismatches).toEqual([]);
    const j = lineOf(v, shop.moline, who.jamie);
    expect([j.hours, j.otHours]).toEqual([12, 0]);
    expect([j.tips, j.tipsInPayroll, j.tipsInPayrollOwed, j.tipsOutside]).toEqual([20, 20, 20, 0]);

    await signInAs(who.owner.id);
    expect(await actions.approvePayrollAction(p.start, p.end, "Launch period")).toMatchObject({ ok: true });
    expect(await actions.lockPayrollAction(p.start, p.end)).toMatchObject({ ok: true });
    const f = await isolvedFile(p, shop.moline);
    expect(f.header).toHaveLength(8);
    expect(f.rows.get(String(await employeeNumber(who.jamie)))!.slice(2)).toEqual([12, 0, 20, 0, 0, 0]);
    expect(v.anomalies.filter((a) => a.kind === "tips_in_payroll_memo").map((a) => a.staffId)).toContain(who.jamie.id);
    expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, held.id) }))!.status).toBe("cancelled");
    expect(calls.filter((c) => MONEY.includes(c.op))).toEqual([]);
  });
});
