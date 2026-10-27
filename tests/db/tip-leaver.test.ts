/**
 * Someone who leaves before finishing Stripe payout setup (L34) against a real database: their held
 * payouts come out of their batches when they're offboarded or made inactive; tips of open pay
 * periods go with their last paycheck even where the brand holds owed tips, and tips of locked
 * periods (already reported to iSolved as paid outside payroll) are paid in cash from the next batch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, agreeToStripeDeposits, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let off: typeof import("@/server/offboarding");
let today: string;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const fx = { shop: "", owner: "", leaver: "", stayer: "", past: "", open: { start: "", end: "" } };

async function who(label: string) {
  const [p] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, label));
  return p.id;
}
async function tipSale(staffId: string, tipCents: number, now?: Date) {
  const sale = await m.checkout.openBlankSale(fx.shop, actor, staffId);
  const svc = (await m.catalog.shopCatalog(fx.shop)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: cash, actor, ...(now ? { now } : {}) });
}
async function setOwedVia(owedVia: "payroll" | "hold") {
  const [b] = await m.db.db.select({ v: s().brandSettings.staffPayouts }).from(s().brandSettings);
  await m.db.db.update(s().brandSettings).set({ staffPayouts: { ...(b?.v as object), owedVia } });
}
/** Their payouts at the shop, apart from the opening one that covers tips from before tip payouts. */
const payoutsOf = (staffId: string) =>
  m.db.db
    .select()
    .from(s().tipPayouts)
    .where(and(eq(s().tipPayouts.staffId, staffId), eq(s().tipPayouts.shopId, fx.shop), m.drizzle.ne(s().tipPayouts.method, "prior")));

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  off = await import("@/server/offboarding");
  today = m.time.todayLocal();
  fx.shop = (await m.catalog.getShop("coralville"))!.id;
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "owner@rayz.test") }))!.id;
  [fx.leaver, fx.stayer] = await Promise.all(["Delaney", "Jessica"].map(who));
  await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(eq(s().shops.id, fx.shop));
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  (await import("@/server/payments/money-movement")).registerMoneyMovement(null);
  await setOwedVia("hold");

  const run = await import("@/server/payroll/run");
  const { periodOf } = await import("@/domain/payroll/calendar");
  const g = (await run.ensurePayGroups()).find((x) => x.shopId === fx.shop)!;
  fx.past = m.time.addDays(today, -21);
  fx.open = periodOf(g.calendar, today);
  for (const id of [fx.leaver, fx.stayer]) {
    await accounts.setPayoutChoice(id, { method: "stripe", instant: false }, actor);
    await agreeToStripeDeposits(id);
    await tipSale(id, 900, new Date(`${fx.past}T17:00:00Z`));
    await tipSale(id, 1500);
  }
  const first = await tp.buildBatch({ shopId: fx.shop, kind: "manual", cutoff: today, actor });
  await tp.approveBatch(first.batchId, actor);
  const past = periodOf(g.calendar, fx.past);
  await m.db.db.insert(s().payrollRuns).values({ payGroupId: g.id, periodStart: past.start, periodEnd: past.end, periodNumber: 1, checkDate: past.end, settings: {}, snapshot: {} });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("someone who leaves before finishing Stripe setup", () => {
  it("while they're on the team, the brand's hold keeps their tips waiting for Stripe", async () => {
    const [p] = await payoutsOf(fx.leaver);
    expect(p).toMatchObject({ method: "stripe", status: "held", holdKind: "stripe_setup", netCents: 2400 });
    const split = await tp.payrollTipSplit([fx.shop], fx.open.start, fx.open.end);
    expect(split.get(`${fx.leaver}|${fx.shop}`)).toMatchObject({ inPayrollCents: 0, owedInPayrollCents: 0 });
  });

  it("offboarding lets go of their held payouts; open-period tips go with the last paycheck, locked-period ones in cash", async () => {
    const r = await off.offboardStaff(fx.leaver, { staffId: fx.owner, label: "owner" }, "Moved away");
    expect(r.heldTipPayouts).toBe(1);
    const [was] = await payoutsOf(fx.leaver);
    expect(was).toMatchObject({ status: "cancelled", holdReason: tp.LEFT_REASON });
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, was.id))).toEqual([]);
    const [a] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.remove"), eq(s().auditLog.entityId, was.id)));
    expect(a.details).toMatchObject({ reason: tp.LEFT_REASON, staffId: fx.leaver, holdKind: "stripe_setup" });

    const split = await tp.payrollTipSplit([fx.shop], fx.open.start, fx.open.end);
    expect(split.get(`${fx.leaver}|${fx.shop}`)).toMatchObject({ inPayrollCents: 1500, owedInPayrollCents: 1500 });
    expect(split.get(`${fx.stayer}|${fx.shop}`)).toMatchObject({ inPayrollCents: 0, owedInPayrollCents: 0 });

    const next = await tp.buildBatch({ shopId: fx.shop, kind: "manual", cutoff: today, actor });
    const mine = (await payoutsOf(fx.leaver)).filter((p) => p.batchId === next.batchId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ method: "cash", status: "pending", holdKind: null, netCents: 900 });
    const theirs = await payoutsOf(fx.stayer);
    expect(theirs.every((p) => p.status === "held" && p.holdKind === "stripe_setup")).toBe(true);
  });

  it("their final pay carries the open period's owed tips and claims them, so nothing pays them again", async () => {
    const run = await import("@/server/payroll/run");
    const fp = await import("@/server/payroll/final-pay");
    expect(await run.saveProfile(fx.leaver, { employeeNumber: "9201", keyIsText: false, isolvedName: "LEAVER, TEST", exportPosition: null }, actor)).toBeNull();
    const pre = await fp.previewFinalPay(fx.leaver, today);
    if ("error" in pre) throw new Error(pre.error);
    expect(pre.shops.map((x) => x.line.tipsInPayroll)).toEqual([15]);
    const r = await fp.approveFinalPay(fx.leaver, today, null, { staffId: fx.owner, label: "owner" });
    expect("id" in r).toBe(true);
    const viaPayroll = (await payoutsOf(fx.leaver)).filter((p) => p.method === "payroll");
    expect(viaPayroll).toMatchObject([{ status: "paid", netCents: 1500, payrollPeriodStart: fx.open.start }]);
    const split = await tp.payrollTipSplit([fx.shop], fx.open.start, fx.open.end);
    expect(split.get(`${fx.leaver}|${fx.shop}`)).toMatchObject({ inPayrollCents: 1500 });
    const again = await tp.buildBatch({ shopId: fx.shop, kind: "manual", cutoff: today, actor });
    expect((await payoutsOf(fx.leaver)).filter((p) => p.batchId === again.batchId).map((p) => [p.method, p.netCents])).toEqual([["cash", 900]]);
  });

  it("making someone inactive does the same, and a second time finds nothing to let go", async () => {
    await m.db.db.update(s().staff).set({ active: false }).where(eq(s().staff.id, fx.stayer));
    expect(await tp.releaseLeaverPayouts(fx.stayer, actor)).toEqual({ payouts: 1, entries: 2 });
    expect(await tp.releaseLeaverPayouts(fx.stayer, actor)).toEqual({ payouts: 0, entries: 0 });
    const split = await tp.payrollTipSplit([fx.shop], fx.open.start, fx.open.end);
    expect(split.get(`${fx.stayer}|${fx.shop}`)).toMatchObject({ inPayrollCents: 1500, owedInPayrollCents: 1500 });
  });
});
