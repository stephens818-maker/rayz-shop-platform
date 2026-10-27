/**
 * The payroll review fixes: Squire-era tips never reach payroll (SB-C1), a refund of tips already
 * paid is the shop's cost and never takes the payable below zero (SB-C2), cash tip declarations feed
 * payroll (SB-C3), and a locked period stays as exported, with drift and late imports flagged.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let run: typeof import("@/server/payroll/run");
let dec: typeof import("@/server/tips/declarations");
let reassign: typeof import("@/server/reassign");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  run = await import("@/server/payroll/run");
  dec = await import("@/server/tips/declarations");
  reassign = await import("@/server/reassign");
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
const noon = (d: string) => m.time.zonedWallTime(d, 12 * 60).toJSDate();

async function barberAt(slug: string, n: number) {
  const sh = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
  const list = await m.db.db
    .select({ id: s().staff.id, label: s().staff.displayLabel })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, sh.id), eq(s().staff.kind, "person"), eq(s().staff.active, true)))
    .orderBy(s().staff.displayLabel);
  return { shop: sh, b: list[n] };
}

async function tipSale(shopId: string, staffId: string, tipCents: number, now?: Date) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: cash, actor, now });
  return sale.id;
}

/** As the importer leaves it: an imported Squire ticket never had a ledger entry. */
async function asImported(saleId: string, how: "ticket" | "payment") {
  if (how === "ticket") await m.db.db.update(s().sales).set({ isImported: true }).where(eq(s().sales.id, saleId));
  else await m.db.db.update(s().payments).set({ processor: "squire_import" }).where(eq(s().payments.saleId, saleId));
  await m.db.db.delete(s().tipLedger).where(eq(s().tipLedger.saleId, saleId));
}

async function periods() {
  const choices = await run.periodChoices();
  const i = choices.findIndex((c) => c.current);
  return { cur: choices[i], prev: choices[i + 1] };
}

const lineOf = (v: Awaited<ReturnType<typeof run.buildPayroll>>, shopId: string, staffId: string) => v!.blocks.find((b) => b.shopId === shopId)!.lines.find((l) => l.staffId === staffId);
const blockOf = (v: Awaited<ReturnType<typeof run.buildPayroll>>, shopId: string) => v!.blocks.find((b) => b.shopId === shopId)!;

async function setStaffPayouts(v: Record<string, unknown>) {
  const [b] = await m.db.db.select({ v: s().brandSettings.staffPayouts }).from(s().brandSettings);
  const was = b?.v;
  await m.db.db.update(s().brandSettings).set({ staffPayouts: { ...((was as object) ?? {}), ...v } });
  onTestFinished(async () => void (await m.db.db.update(s().brandSettings).set({ staffPayouts: was ?? {} })));
}

describe("SB-C1: Squire-era tips never reach payroll", () => {
  it("an imported ticket's tip, and a squire_import payment's, are left out of payroll sales, tips, the run, the iSolved file and the ledger; they're in the reference table", async () => {
    const { shop: sh, b } = await barberAt("moline", 0);
    const { cur } = await periods();
    await tipSale(sh.id, b.id, 300);
    const before = await m.reports.payrollSalesBetween({ shopIds: [sh.id], staffId: b.id }, cur.start, cur.end);
    const runBefore = await run.buildPayroll(cur.start, cur.end);

    const ticket = await tipSale(sh.id, b.id, 900);
    await asImported(ticket, "ticket");
    const payment = await tipSale(sh.id, b.id, 700);
    await asImported(payment, "payment");
    await tl.syncTipLedger();

    expect(await m.reports.payrollSalesBetween({ shopIds: [sh.id], staffId: b.id }, cur.start, cur.end)).toEqual(before);
    const r = await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: cur.start, to: cur.end });
    expect(r.rows.reduce((t, x) => t + x.cashTipsCents, 0)).toBe(before[0].cashTipsCents);
    expect(r.squire.filter((x) => x.staffId === b.id).reduce((t, x) => t + x.tipsCents, 0)).toBe(1600);

    const v = await run.buildPayroll(cur.start, cur.end);
    expect(lineOf(v, sh.id, b.id)!.tips).toBe(lineOf(runBefore, sh.id, b.id)!.tips);
    expect(blockOf(v, sh.id).exportRows).toEqual(blockOf(runBefore, sh.id).exportRows);
    expect(v!.tips.mismatches).toEqual([]);
    const ledger = await m.db.db.select().from(s().tipLedger).where(m.drizzle.inArray(s().tipLedger.saleId, [ticket, payment]));
    expect(ledger).toEqual([]);
  });
});

describe("SB-C2: a refund of tips already paid", () => {
  it("is the shop's cost by default: absorbed, flagged on the run, never subtracted, and the tip check still matches", async () => {
    const { shop: sh, b } = await barberAt("silvis", 0);
    const { cur, prev } = await periods();
    const sale = await tipSale(sh.id, b.id, 800, noon(m.time.addDays(prev.start, 2)));
    await tl.syncTipLedger();
    const prevBefore = (await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: prev.start, to: prev.end })).rows;
    const curBefore = lineOf(await run.buildPayroll(cur.start, cur.end), sh.id, b.id);

    await m.checkout.refundSale({ saleId: sale, items: [], tipCents: 800, refundCardFee: false, reason: "Tip keyed twice", restock: false, actor });
    await tl.syncTipLedger();

    expect(await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, sale), eq(s().tipLedger.kind, "refund")))).toEqual([]);
    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, sale))).toEqual([expect.objectContaining({ kind: "after_payout", amountCents: 800, staffId: b.id })]);

    expect((await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: prev.start, to: prev.end })).rows).toEqual(prevBefore);
    const r = await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: cur.start, to: cur.end });
    expect(r.lateRefunds).toBe("shop_cost");
    const row = r.rows.find((x) => x.staffId === b.id)!;
    expect(row).toMatchObject({ lateTipRefundsCents: 800, tipRefundsCents: 0 });
    expect(row.totalTipsCents).toBeGreaterThanOrEqual(0);

    const v = await run.buildPayroll(cur.start, cur.end);
    const line = lineOf(v, sh.id, b.id)!;
    expect(line).toMatchObject({ lateTipRefunds: 8, tipRefundsShopCost: 8, tips: curBefore?.tips ?? 0 });
    expect(v!.anomalies).toContainEqual(expect.objectContaining({ kind: "late_tip_refund", staffId: b.id, shopId: sh.id }));
    expect(v!.tips.mismatches).toEqual([]);
    expect(v!.mismatches).toEqual([]);
  });

  it("when the brand deducts them instead, the next period's tips go down, never below zero", async () => {
    await setStaffPayouts({ afterPayoutRefunds: "deduct", reversalRule: "any_refund" });
    const { shop: sh, b } = await barberAt("silvis", 1);
    const { cur, prev } = await periods();
    const sale = await tipSale(sh.id, b.id, 50_000, noon(m.time.addDays(prev.start, 3)));
    await tl.syncTipLedger();
    await m.checkout.refundSale({ saleId: sale, items: [], tipCents: 50_000, refundCardFee: false, reason: "Wrong amount", restock: false, actor });
    await tl.syncTipLedger();

    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, sale))).toEqual([]);
    expect(await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, sale), eq(s().tipLedger.kind, "refund")))).toEqual([expect.objectContaining({ amountCents: -50_000 })]);
    const r = await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: cur.start, to: cur.end });
    expect(r.lateRefunds).toBe("deduct");
    expect(r.rows.find((x) => x.staffId === b.id)).toMatchObject({ lateTipRefundsCents: 50_000, totalTipsCents: 0 });
    const line = lineOf(await run.buildPayroll(cur.start, cur.end), sh.id, b.id)!;
    expect(line.tips).toBe(0);
    expect(line.lateTipRefunds).toBe(500);
    expect(line.tipsOutside).toBeGreaterThanOrEqual(0);
  });
});

describe("SB-C3: cash tip declarations", () => {
  it("count in payroll under their own iSolved column and in the tips report; a correction replaces, and rows never change", async () => {
    const { shop: sh, b } = await barberAt("moline", 1);
    const { cur } = await periods();
    const base = { staffId: b.id, shopId: sh.id, businessDate: today, source: "staff_app" as const, actor };
    await expect(dec.declareCashTips({ ...base, amountCents: 4500, attested: false })).rejects.toThrow(/Check the box/);
    await expect(dec.declareCashTips({ ...base, businessDate: m.time.addDays(today, 1), amountCents: 4500, attested: true })).rejects.toThrow(/hasn't happened/);
    const d = await dec.declareCashTips({ ...base, amountCents: 4500, attested: true });
    expect(d).toMatchObject({ amountCents: 4500, source: "staff_app", replacesId: null });

    const v = await run.buildPayroll(cur.start, cur.end);
    expect(lineOf(v, sh.id, b.id)!.declaredCashTips).toBe(45);
    const block = blockOf(v, sh.id);
    const col = block.exportHeaders!.indexOf("E_Cash Tips Declared_Dollars");
    expect(col).toBeGreaterThanOrEqual(0);
    expect(v!.mismatches).toEqual([]);
    const r = await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: cur.start, to: cur.end });
    expect(r.rows.find((x) => x.staffId === b.id)!.declaredCashTipsCents).toBe(4500);

    await expect(dec.declareCashTips({ ...base, amountCents: 5000, attested: true, replacesId: d.id })).rejects.toThrow(/why/);
    const fixed = await dec.declareCashTips({ ...base, amountCents: 5000, attested: true, replacesId: d.id, reason: "Miscounted the jar" });
    await expect(dec.declareCashTips({ ...base, amountCents: 5200, attested: true, replacesId: d.id, reason: "Again" })).rejects.toThrow(/already corrected/);
    expect((await dec.declaredTipsBetween([sh.id], cur.start, cur.end)).get(`${b.id}|${sh.id}`)).toBe(5000);
    const mine = await dec.myDeclarations(b.id, cur.start, today);
    expect(mine.declarations.map((x) => [x.id, x.current])).toEqual(expect.arrayContaining([[d.id, false], [fixed.id, true]]));

    await expect(m.db.db.update(s().tipDeclarations).set({ amountCents: 1 }).where(eq(s().tipDeclarations.id, fixed.id))).rejects.toThrow();
    await expect(m.db.db.delete(s().tipDeclarations).where(eq(s().tipDeclarations.id, fixed.id))).rejects.toThrow();
    const audits = await m.db.db.select().from(s().auditLog).where(m.drizzle.inArray(s().auditLog.entityId, [d.id, fixed.id]));
    expect(audits.map((a) => a.action).sort()).toEqual(["tips.declaration_correct", "tips.declare"]);
  });
});

describe("a locked pay period stays as exported", () => {
  it("keeps the hash it was approved on; drift and late Squire imports are flagged, and its tickets, tips and declarations can't change", async () => {
    const { shop: sh, b } = await barberAt("rock-island", 0);
    const { prev } = await periods();
    const ours = await tipSale(sh.id, b.id, 400, noon(m.time.addDays(prev.start, 1)));
    const squire = await tipSale(sh.id, b.id, 1200, noon(m.time.addDays(prev.start, 1)));
    await asImported(squire, "ticket");
    await tl.syncTipLedger();

    expect(await run.approveAndLock(prev.start, prev.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const locked = await run.buildPayroll(prev.start, prev.end);
    const lb = blockOf(locked, sh.id);
    expect(lb.lockCheck).toMatchObject({ drift: [], importedAfterLock: 0 });
    expect(lb.lockCheck!.liveHash).toBe(lb.lockCheck!.hash);
    expect(lb.lockCheck!.hash).toBe(run.inputsHash(lb.lines));

    await m.db.db.update(s().sales).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(s().sales.id, squire));
    await m.db.db.insert(s().timeEntries).values({ staffId: b.id, shopId: sh.id, kind: "worked", startsAt: noon(m.time.addDays(prev.start, 4)), endsAt: new Date(noon(m.time.addDays(prev.start, 4)).getTime() + 2 * 3_600_000), source: "manual" });

    const after = await run.buildPayroll(prev.start, prev.end);
    const ab = blockOf(after, sh.id);
    expect(ab.exportRows).toEqual(lb.exportRows);
    expect(ab.lockCheck!.hash).toBe(lb.lockCheck!.hash);
    expect(ab.lockCheck!.liveHash).not.toBe(ab.lockCheck!.hash);
    expect(ab.lockCheck!.importedAfterLock).toBe(1);
    expect(ab.lockCheck!.drift).toContainEqual(expect.objectContaining({ staffId: b.id, field: "workedHours", now: expect.any(Number) }));
    expect(after!.anomalies.map((a) => a.kind)).toEqual(expect.arrayContaining(["changed_since_lock", "late_import"]));

    const other = (await barberAt("rock-island", 1)).b;
    await expect(reassign.reassignSale({ saleId: ours, toStaffId: other.id, reason: "Wrong barber", actor })).rejects.toThrow(/locked/);
    await expect(dec.declareCashTips({ staffId: b.id, shopId: sh.id, businessDate: m.time.addDays(prev.start, 1), amountCents: 1000, attested: true, source: "staff_app", actor })).rejects.toThrow(/locked|closed/);
  });
});
