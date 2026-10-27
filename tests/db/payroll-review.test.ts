/**
 * The payroll review fixes: Squire-era tips never reach payroll (SB-C1), a refund of tips already
 * paid is the shop's cost and never takes the payable below zero (SB-C2), cash tip declarations feed
 * payroll (SB-C3), and a locked period stays as exported, with drift and late imports flagged.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules, lockHours } from "./setup";
import { brandSettings } from "./brand";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let run: typeof import("@/server/payroll/run");
let dec: typeof import("@/server/tips/declarations");
let reassign: typeof import("@/server/reassign");
let myTips: typeof import("@/app/admin/my-tips/actions");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  run = await import("@/server/payroll/run");
  dec = await import("@/server/tips/declarations");
  reassign = await import("@/server/reassign");
  myTips = await import("@/app/admin/my-tips/actions");
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

  it("nor the time clock's tips CSV or a tip payout batch (ST-C0a)", async () => {
    const tce = await import("@/server/time-clock-export");
    const tp = await import("@/server/tips/payouts");
    const { shop: sh, b } = await barberAt("moline", 2);
    const { cur } = await periods();
    await tipSale(sh.id, b.id, 250);
    const lineFor = async () => (await tce.exportData(cur.start, [sh.id])).lines.find((l) => l.staffId === b.id);
    const before = await lineFor();
    const ticket = await tipSale(sh.id, b.id, 1200);
    await asImported(ticket, "ticket");
    const payment = await tipSale(sh.id, b.id, 800);
    await asImported(payment, "payment");
    await tl.syncTipLedger();
    expect(await lineFor()).toEqual(before);
    const batch = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const claimed = await m.db.db
      .select()
      .from(s().tipLedger)
      .innerJoin(s().tipPayouts, eq(s().tipPayouts.id, s().tipLedger.payoutId))
      .where(and(eq(s().tipPayouts.batchId, batch.batchId), m.drizzle.inArray(s().tipLedger.saleId, [ticket, payment])));
    expect(claimed).toEqual([]);
    await tp.cancelBatch(batch.batchId, "Test batch", actor);
  });

  it("nor commission: an imported ticket's lines and a squire_import payment's ticket aren't commissionable", async () => {
    const comp = await import("@/server/compensation");
    const { shop: sh, b } = await barberAt("silvis", 2);
    const net = async () => ((await comp.commissionLines([b.id], today, today)).get(b.id) ?? []).reduce((t, l) => t + l.netCents, 0);
    await tipSale(sh.id, b.id, 100);
    const before = await net();
    expect(before).toBeGreaterThan(0);
    const ticket = await tipSale(sh.id, b.id, 0);
    const counted = await net();
    expect(counted).toBeGreaterThan(before);
    await asImported(ticket, "ticket");
    expect(await net()).toBe(before);
    const payment = await tipSale(sh.id, b.id, 0);
    expect(await net()).toBe(counted);
    await asImported(payment, "payment");
    expect(await net()).toBe(before);
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

  it("is never clawed back (ST-C15): a saved deduct and the any-refund rule still leave the tip with the barber", async () => {
    await setStaffPayouts({ afterPayoutRefunds: "deduct" as never, reversalRule: "any_refund" });
    const { shop: sh, b } = await barberAt("silvis", 1);
    const { cur, prev } = await periods();
    const sale = await tipSale(sh.id, b.id, 50_000, noon(m.time.addDays(prev.start, 3)));
    await tl.syncTipLedger();
    const curBefore = lineOf(await run.buildPayroll(cur.start, cur.end), sh.id, b.id);
    await m.checkout.refundSale({ saleId: sale, items: [], tipCents: 50_000, refundCardFee: false, reason: "Wrong amount", restock: false, actor });
    await tl.syncTipLedger();

    expect(await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, sale), eq(s().tipLedger.kind, "refund")))).toEqual([]);
    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, sale))).toEqual([expect.objectContaining({ kind: "after_payout", amountCents: 50_000 })]);
    const r = await m.reports.payrollTips({ shopIds: [sh.id], staffId: b.id, from: cur.start, to: cur.end });
    expect(r.lateRefunds).toBe("shop_cost");
    expect(r.rows.find((x) => x.staffId === b.id)).toMatchObject({ lateTipRefundsCents: 50_000 });
    const line = lineOf(await run.buildPayroll(cur.start, cur.end), sh.id, b.id)!;
    expect(line.tips).toBe(curBefore?.tips ?? 0);
    expect(line.lateTipRefunds).toBe(500);
    expect(line.tipRefundsShopCost).toBe(500);
  });
});

describe("SB-C3: cash tip declarations", () => {
  it("remind on the 1st and again on the last reminder day, never twice a day, and stop once they declare (ST-C16)", async () => {
    const { shop: sh, b } = await barberAt("silvis", 0);
    const [row] = await m.db.db.select({ email: s().staff.email }).from(s().staff).where(eq(s().staff.id, b.id));
    const email = `declare-${b.id.slice(0, 8)}@example.test`;
    await m.db.db.update(s().staff).set({ email }).where(eq(s().staff.id, b.id));
    const month = today.slice(0, 7);
    const [shift] = await m.db.db
      .insert(s().timeEntries)
      .values({ staffId: b.id, shopId: sh.id, kind: "worked", startsAt: noon(today), endsAt: new Date(noon(today).getTime() + 3_600_000), source: "manual" })
      .returning({ id: s().timeEntries.id });
    const jobs = () => m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_declaration"), eq(s().notificationJobs.to, email)));
    onTestFinished(async () => {
      await m.db.db.delete(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_declaration"), eq(s().notificationJobs.to, email)));
      await m.db.db.update(s().staff).set({ email: row.email }).where(eq(s().staff.id, b.id));
      await m.db.db.delete(s().timeEntries).where(eq(s().timeEntries.id, shift.id));
    });

    const next = m.time.addDays(`${month}-01`, 32).slice(0, 7);
    const on = (day: number) => new Date(noon(`${next}-${String(day).padStart(2, "0")}`).getTime() + 3 * 3_600_000);
    const rules = await dec.declarationRules();
    expect(rules).toMatchObject({ remindUntilDay: 9, lockDay: 10 });

    await dec.declarationReminderCron(on(1));
    await dec.declarationReminderCron(on(1));
    expect((await jobs()).map((j) => j.subject)).toEqual(["Declare last month's cash tips"]);
    for (const d of [2, 5, 8]) await dec.declarationReminderCron(on(d));
    expect(await jobs()).toHaveLength(1);
    await dec.declarationReminderCron(on(9));
    await dec.declarationReminderCron(on(9));
    expect((await jobs()).map((j) => j.subject).sort()).toEqual(["Declare last month's cash tips", `Last day to declare ${month}'s cash tips`].sort());
    await dec.declarationReminderCron(on(10));
    expect(await jobs()).toHaveLength(2);
    expect((await jobs())[0].body).toContain(`close on ${next}-10`);

    await m.db.db.delete(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_declaration"), eq(s().notificationJobs.to, email)));
    await dec.declareCashTips({ staffId: b.id, shopId: sh.id, businessDate: today, amountCents: 0, attested: true, source: "staff_app", actor });
    await dec.declarationReminderCron(on(1));
    expect(await jobs()).toHaveLength(0);
  });

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

  it("on the web: a barber declares their own; a manager enters someone else's with a reason, never their own", async () => {
    const { shop: sh, b } = await barberAt("moline", 2);
    const mgr = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "manager.moline@rayz.test") }))!;
    const day = today;
    onTestFinished(() => signInAs(null));

    await signInAs(b.id);
    expect(await myTips.declareCashTipsAction({ shopId: sh.id, businessDate: day, amountCents: 1500, attest: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Check the box/) });
    const mine = await myTips.declareCashTipsAction({ shopId: sh.id, businessDate: day, amountCents: 1500, attest: true });
    expect(mine).toMatchObject({ ok: true });
    expect(await myTips.managerDeclareAction({ staffId: b.id, shopId: sh.id, businessDate: day, amountCents: 1500, attest: true, reason: "x" })).toMatchObject({ ok: false });

    await signInAs(mgr.id);
    expect(await myTips.managerDeclareAction({ staffId: mgr.id, shopId: sh.id, businessDate: day, amountCents: 900, attest: true, reason: "Mine" })).toMatchObject({ ok: false, error: expect.stringMatching(/another manager/) });
    expect(await myTips.managerDeclareAction({ staffId: b.id, shopId: sh.id, businessDate: day, amountCents: 1700, attest: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Say why/) });
    const fixed = await myTips.managerDeclareAction({ staffId: b.id, shopId: sh.id, businessDate: day, amountCents: 1700, attest: false, replacesId: (mine as { data: { id: string } }).data.id, reason: "Recounted at close" });
    expect(fixed).toMatchObject({ ok: true });
    const [row] = await m.db.db.select().from(s().tipDeclarations).where(eq(s().tipDeclarations.id, (fixed as { data: { id: string } }).data.id));
    expect(row).toMatchObject({ source: "manager", createdBy: mgr.id, amountCents: 1700, attestation: expect.stringMatching(/^Entered by a manager: Recounted/) });
    expect((await dec.declaredTipsBetween([sh.id], day, day)).get(`${b.id}|${sh.id}`)).toBe(1700);
  });
});

describe("I4 and I10: refunds and the commission base", () => {
  const serviceOf = async (shopId: string, staffId: string, start: string, end: string) => lineOf(await run.buildPayroll(start, end), shopId, staffId)?.service ?? 0;

  it("a refund comes off the period it's issued in, before the greater-of; one on a Squire-era ticket never does", async () => {
    const { shop: sh, b } = await barberAt("moline", 1);
    const { cur, prev } = await periods();
    const sale = await tipSale(sh.id, b.id, 0, noon(m.time.addDays(prev.start, 2)));
    const [item] = await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, sale));
    const prevBefore = await serviceOf(sh.id, b.id, prev.start, prev.end);
    const curBefore = await serviceOf(sh.id, b.id, cur.start, cur.end);
    await m.checkout.refundSale({ saleId: sale, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Redo", restock: false, actor });
    expect(await serviceOf(sh.id, b.id, prev.start, prev.end)).toBe(prevBefore);
    const [refund] = await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, sale));
    expect(await serviceOf(sh.id, b.id, cur.start, cur.end)).toBeCloseTo(curBefore - refund.serviceNetCents / 100, 6);

    await asImported(sale, "ticket");
    expect(await serviceOf(sh.id, b.id, cur.start, cur.end)).toBeCloseTo(curBefore, 6);
    expect(await serviceOf(sh.id, b.id, prev.start, prev.end)).toBeCloseTo(prevBefore - item.netCents / 100, 6);
  });

  it("by default the card surcharge is left out and a loyalty reward comes off; set otherwise, each is in the base", async () => {
    const { shop: sh, b } = await barberAt("moline", 1);
    const { cur } = await periods();
    const base = await serviceOf(sh.id, b.id, cur.start, cur.end);
    const sale = await tipSale(sh.id, b.id, 0);
    const [row] = await m.db.db.select().from(s().sales).where(eq(s().sales.id, sale));
    await m.db.db.update(s().sales).set({ cardFeeCents: 90 }).where(eq(s().sales.id, sale));
    const [c] = await m.db.db.select({ id: s().customers.id }).from(s().customers).limit(1);
    await m.db.db.insert(s().loyaltyLedger).values({ customerId: c.id, saleId: sale, kind: "reward_redeemed", rewardCents: -1500 });
    const withSale = base + row.serviceNetCents / 100;
    expect(await serviceOf(sh.id, b.id, cur.start, cur.end)).toBeCloseTo(withSale, 6);

    const was = await run.loadSettings();
    onTestFinished(async () => void (await brandSettings({ payroll: was })));
    await brandSettings({ payroll: { ...was, commissionBase: { cardFee: "include", loyalty: "reduces" } } });
    expect(await serviceOf(sh.id, b.id, cur.start, cur.end)).toBeCloseTo(withSale + 0.9, 6);
    await brandSettings({ payroll: { ...was, commissionBase: { cardFee: "include", loyalty: "shop_absorbs" } } });
    expect(await serviceOf(sh.id, b.id, cur.start, cur.end)).toBeCloseTo(withSale + 0.9 + 15, 6);
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

    await lockHours(prev.start, prev.end);
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
