/**
 * The W-2 safeguards on tips paid straight to employees: every payout records its employee, shop,
 * pay period and tips; the iSolved file's tips match each employee's tips and payouts to the cent,
 * and a difference blocks approve and lock; an adjustment never lands in a locked pay period; and
 * the payroll-period tip report as a CSV.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let run: typeof import("@/server/payroll/run");
let rec: typeof import("@/server/payroll/tip-reconcile");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  run = await import("@/server/payroll/run");
  rec = await import("@/server/payroll/tip-reconcile");
  today = m.time.todayLocal();
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };

async function barber(slug: string, label: string) {
  const sh = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
  const [b] = await m.db.db
    .select({ id: s().staff.id, firstName: s().staff.firstName, lastName: s().staff.lastName })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, sh.id), eq(s().staff.displayLabel, label)));
  return { shop: sh, b };
}

async function tipSale(shopId: string, staffId: string, tipCents: number) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: cash, actor });
}

/** A tip adjustment dated `day`, not in a payout yet (as one typed in before a batch). */
const adjustOn = (shopId: string, staffId: string, cents: number, day: string) =>
  m.db.db.insert(s().tipLedger).values({ shopId, staffId, kind: "adjust", method: "adjust", amountCents: cents, businessDate: day, reason: "Tip left off a ticket" });

const periodsOf = (payoutId: string) => m.db.db.select().from(s().tipPayoutPeriods).where(eq(s().tipPayoutPeriods.payoutId, payoutId)).orderBy(s().tipPayoutPeriods.periodStart);
const mine = async (batchId: string, staffId: string) => (await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, batchId), eq(s().tipPayouts.staffId, staffId))))[0];

async function periods() {
  const choices = await run.periodChoices();
  const i = choices.findIndex((c) => c.current);
  return { cur: choices[i], prev: choices[i + 1] };
}

describe("every payout records its employee, shop, pay period and tips", () => {
  it("once approved, a row per pay period its tips were earned in; held ones have none until released", async () => {
    const { shop: sh, b } = await barber("rock-island", "Garrett");
    const { cur, prev } = await periods();
    await adjustOn(sh.id, b.id, 250, prev.end);
    await tipSale(sh.id, b.id, 900);
    const batch = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const p = await mine(batch.batchId, b.id);
    expect(await periodsOf(p.id)).toEqual([]);

    await tp.approveBatch(batch.batchId, actor);
    const rows = await periodsOf(p.id);
    expect(rows).toEqual([
      expect.objectContaining({ shopId: sh.id, staffId: b.id, method: "cash", periodStart: prev.start, periodEnd: prev.end, tipsCents: 0, adjustCents: 250 }),
      expect.objectContaining({ shopId: sh.id, staffId: b.id, method: "cash", periodStart: cur.start, periodEnd: cur.end, tipsCents: 900, adjustCents: 0 }),
    ]);

    await tp.holdPayout(p.id, "Checking the drawer count first", actor);
    expect(await periodsOf(p.id)).toEqual([]);
    await tp.releasePayout(p.id, actor);
    expect(await periodsOf(p.id)).toHaveLength(2);
    await tp.acknowledgeCashPayout({ payoutId: p.id, by: "name", name: `${b.firstName} ${b.lastName}`, actor });
    expect((await periodsOf(p.id)).map((r) => r.tipsCents + r.adjustCents)).toEqual([250, 900]);
  });
});

describe("the W-2 tip check", () => {
  it("the iSolved file's tips match each employee's tips and payouts to the cent, listing every payout", async () => {
    const { shop: sh, b } = await barber("rock-island", "Garrett");
    const { cur, prev } = await periods();
    const v = (await run.buildPayroll(cur.start, cur.end))!;
    expect(v.mismatches).toEqual([]);
    expect(v.tips.mismatches).toEqual([]);
    const row = v.tips.rows.find((r) => r.staffId === b.id && r.shopId === sh.id)!;
    expect(row.problems).toEqual([]);
    expect(row.directCents).toBe(row.earnedCents - row.inPayrollCents);
    expect(row.exportCashTipsCents).toBe(row.directCents);
    expect(row.exportPaidMemoCents).toBe(row.paidCents);
    expect(row.paidCents).toBeGreaterThanOrEqual(900);
    const p = row.payouts.find((x) => x.tipsCents === 900)!;
    expect(p).toMatchObject({ method: "cash", status: "paid", adjustCents: 0, split: true });
    expect(p.paidAt).not.toBeNull();

    const before = (await run.buildPayroll(prev.start, prev.end))!.tips.rows.find((r) => r.staffId === b.id && r.shopId === sh.id)!;
    expect(before.payouts.find((x) => x.id === p.id)).toMatchObject({ tipsCents: 0, adjustCents: 250, split: true });

    const csv = rec.tipCheckCsv(v.tips, cur.start, cur.end);
    expect(csv.split("\n")[0]).toBe(`Pay period,${cur.start} to ${cur.end}`);
    const line = csv.split("\n").find((l) => l.startsWith("Rock Island,Garrett,"))!;
    expect(line.split(",").at(-2)).toBe("yes");
    expect(csv).toContain(`Rock Island,Garrett,${p.id},cash,paid,9.00`);
  });

  it("a typed-over TIPS value doesn't match what was paid, and blocks approve and lock while Stripe pays tips direct", async () => {
    const { shop: sh, b } = await barber("rock-island", "Garrett");
    const { cur } = await periods();
    const line = (await run.buildPayroll(cur.start, cur.end))!.blocks.find((x) => x.shopId === sh.id)!.lines.find((l) => l.staffId === b.id)!;
    expect(await run.setOverride(sh.id, cur.start, b.id, "tips", line.tips + 5, "Typed in the wrong tips", actor)).toBeNull();
    onTestFinished(async () => void (await run.setOverride(sh.id, cur.start, b.id, "tips", null, "", actor)));

    const bad = (await run.buildPayroll(cur.start, cur.end))!;
    const diff = bad.mismatches.filter((x) => x.check === "tips");
    expect(diff).toEqual([expect.objectContaining({ shopId: sh.id, column: "E_Cash Tips Recd_Dollars", report: expect.closeTo(line.tipsOutside + 5, 2), other: expect.closeTo(line.tipsOutside, 2) })]);
    expect(diff[0].detail).toMatch(/Garrett: the iSolved file has \$[\d.]+ of tips already received; the tip ledger has/);
    expect(bad.tips.rows.find((r) => r.staffId === b.id && r.shopId === sh.id)!.problems).toHaveLength(1);
    expect(await run.approveAndLock(cur.start, cur.end, actor)).toMatchObject({ error: expect.stringMatching(/reconcile/), mismatches: expect.arrayContaining(diff) });

    process.env.FEATURE_STAFF_STRIPE_PAYOUTS = "false";
    onTestFinished(() => void delete process.env.FEATURE_STAFF_STRIPE_PAYOUTS);
    const payrollOnly = (await run.buildPayroll(cur.start, cur.end))!;
    expect(payrollOnly.mismatches.filter((x) => x.check === "tips")).toEqual([]);
    expect(payrollOnly.tips.mismatches).toHaveLength(1);
  });
});

describe("a locked pay period stays as it went to iSolved", () => {
  it("an adjustment is dated today, not in the locked period; a payout paid after the lock isn't in the locked file's memo, and still matches", async () => {
    const { shop: sh, b } = await barber("rock-island", "Mercedez");
    const { cur, prev } = await periods();
    await adjustOn(sh.id, b.id, 300, prev.end);
    const batch = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: prev.end, actor });
    const q = await mine(batch.batchId, b.id);
    expect(q).toMatchObject({ status: "pending" });

    expect(await run.approveAndLock(prev.start, prev.end, actor)).toMatchObject({ locked: expect.any(Number) });
    await tp.adjustPayout(q.id, 100, "One more tip left off a ticket", actor);
    const [last] = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, q.id)).orderBy(m.drizzle.desc(s().tipLedger.createdAt)).limit(1);
    expect(last).toMatchObject({ kind: "adjust", amountCents: 100, businessDate: today });

    await tp.approveBatch(batch.batchId, actor);
    await tp.acknowledgeCashPayout({ payoutId: q.id, by: "name", name: `${b.firstName} ${b.lastName}`, actor });
    expect((await periodsOf(q.id)).map((r) => [r.periodStart, r.adjustCents])).toEqual([
      [prev.start, 300],
      [cur.start, 100],
    ]);

    const locked = (await run.buildPayroll(prev.start, prev.end))!;
    expect(locked.locked).toBe("all");
    const row = locked.tips.rows.find((r) => r.staffId === b.id && r.shopId === sh.id)!;
    expect(row.paidCents - row.paidAtLockCents).toBe(300);
    expect(row.exportPaidMemoCents).toBe(row.paidAtLockCents);
    expect(row.problems).toEqual([]);
    expect(locked.tips.mismatches).toEqual([]);
  });
});
