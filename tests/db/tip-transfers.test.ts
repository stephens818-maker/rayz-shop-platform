/**
 * Card sales go to the shop and tips go straight to barbers (I10, approved by Charles), against a
 * stand-in Stripe that records every call, failed ones too. The charge stays on the platform with the
 * ticket's transfer_group; the shop's portion ({saleId}:shop) and, where the shop's Tips to barbers
 * switch is on, the tip ({saleId}:tip) are transferred with the charge as source_transaction. A tip
 * is paid exactly once: never again by a payout, payroll, a retry or a replayed webhook. Refunds and
 * disputes come out of the shop's transfer only, after a plain refund (never reverse_transfer); what
 * it can't cover is a platform loss. The payroll detail file and the tip reconciliation CSV read the
 * tips from the tip transfers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { TIP_DEPOSIT_CONSENT_VERSION } from "@/domain/tip-deposit-consent";
import { brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

type Call = { op: string; params: Record<string, unknown>; opts: Record<string, unknown> | undefined; id: string };
const calls: Call[] = [];
/** Every transfer Stripe was asked for, refused or not: [destination, idempotency key]. */
const tries: [unknown, unknown][] = [];
let n = 0;
let failTransfers = 0;
const fake = {
  transfers: {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      tries.push([params.destination, opts?.idempotencyKey]);
      if (failTransfers > 0) {
        failTransfers--;
        throw new Error("Stripe is down in the test");
      }
      const id = `tr_fake_${++n}`;
      calls.push({ op: "transfer", params, opts, id });
      return { id };
    },
    createReversal: async (transfer: string, params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      const id = `trr_fake_${++n}`;
      calls.push({ op: "reversal", params: { transfer, ...params }, opts, id });
      return { id };
    },
  },
  payouts: {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
      const id = `po_fake_${++n}`;
      calls.push({ op: "payout", params, opts, id });
      return { id };
    },
  },
};
(globalThis as { __fakeStripe?: unknown }).__fakeStripe = fake;

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let settlement: typeof import("@/server/payments/settlement");
let webhook: typeof import("@/server/payments/webhook");
let run: typeof import("@/server/payroll/run");
let rec: typeof import("@/server/payroll/tip-reconcile");
let detail: typeof import("@/server/payroll/detail");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  settlement = await import("@/server/payments/settlement");
  webhook = await import("@/server/payments/webhook");
  run = await import("@/server/payroll/run");
  rec = await import("@/server/payroll/tip-reconcile");
  detail = await import("@/server/payroll/detail");
  today = m.time.todayLocal();
  await m.db.db.update(m.schema.shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } });
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterEach(() => {
  failTransfers = 0;
});

afterAll(async () => {
  (globalThis as { __fakeStripe?: unknown }).__fakeStripe = undefined;
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const event = (id: string, type: string, object: object) => ({ id, type, created: Math.floor(Date.now() / 1000), data: { object } }) as never;

async function setup(slug: string, label: string) {
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
  const acct = `acct_fake_shop_${slug}`;
  await m.db.db.update(s().shopPaymentAccounts).set({ stripeAccountId: acct, simulated: false }).where(eq(s().shopPaymentAccounts.shopId, shop.id));
  const [p] = await m.db.db
    .select({ id: s().staff.id })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, shop.id), eq(s().staff.displayLabel, label)));
  return { shop, acct, staffId: p.id };
}

/** The barber's recipient account (no Stripe Dashboard): active, agreed to Stripe deposits, paid by Stripe. */
async function barberOnStripe(staffId: string, acct: string) {
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

/** A card ticket; with qty 2, refunding one service is well inside the shop's portion. */
async function cardSale(shopId: string, staffId: string, tipCents: number, qty = 1) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  calls.length = 0;
  tries.length = 0;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty }], tipCents, tender: credit, actor });
  return { saleId: sale.id, ...(await moneyOf(sale.id)), moved: [...calls] };
}

async function moneyOf(saleId: string) {
  const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, saleId));
  const rows = await m.db.db.select().from(s().paymentTransfers).where(eq(s().paymentTransfers.saleId, saleId));
  return { pay, shopRow: rows.find((r) => r.kind === "shop")!, tipRows: rows.filter((r) => r.kind === "tip") };
}

const reversalsOf = (paymentId: string) => m.db.db.select().from(s().paymentTransferReversals).where(eq(s().paymentTransferReversals.paymentId, paymentId));
const transferRow = async (id: string) => (await m.db.db.query.paymentTransfers.findFirst({ where: eq(s().paymentTransfers.id, id) }))!;
const lossesOf = (paymentId: string) => m.db.db.select().from(s().platformLosses).where(eq(s().platformLosses.paymentId, paymentId));
const auditsOf = (action: string, entityId: string) => m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, action), eq(s().auditLog.entityId, entityId)));
const serviceItem = async (saleId: string) => (await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, saleId)))[0];

async function period() {
  return (await run.periodChoices()).find((c) => c.current)!;
}

/** This pay period's figures for the barber: the iSolved line, the tip check row and the payroll detail row. */
async function payrollOf(shopId: string, staffId: string) {
  const p = await period();
  const view = (await run.payrollRunView(p.start, p.end, [shopId], { clockChecks: false }))!;
  const block = view.blocks.find((b) => b.shopId === shopId)!;
  const line = block.lines.find((l) => l.staffId === staffId);
  const check = view.tips.rows.find((r) => r.shopId === shopId && r.staffId === staffId);
  const rows = detail.detailRows([block], view.tips.rows);
  const col = (h: string) => detail.DETAIL_HEADERS.indexOf(h);
  const mine = line ? rows.find((r) => r[2] === line.name && r[0] === block.shop) : undefined;
  return {
    p,
    view,
    tips: line?.input.tips ?? 0,
    tipsInPayroll: line?.input.tipsInPayroll ?? 0,
    check,
    csv: rec.tipCheckCsv(view.tips, p.start, p.end),
    detailStripe: mine ? Number(mine[col("Card tips paid via Stripe")]) : 0,
    detailTransfers: mine ? String(mine[col("Stripe transfers")]) : "",
  };
}

describe("a tip is paid once", () => {
  it("the charge's transfers add up to the charge less the fee; the tip goes to the barber once, and no retry, payout or payroll pays it again", async () => {
    const { shop, acct, staffId } = await setup("coralville", "Makenna");
    await barberOnStripe(staffId, "acct_fake_makenna");
    const before = await payrollOf(shop.id, staffId);
    const { saleId, pay, shopRow, tipRows, moved } = await cardSale(shop.id, staffId, 1500);

    expect(pay).toMatchObject({ chargeType: "separate", transferGroup: `sale_${saleId}`, settlement: "connected" });
    expect(m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!.transferGroup).toBe(`sale_${saleId}`);
    expect(moved.map((c) => [c.params.destination, c.params.amount, c.params.source_transaction, c.params.transfer_group, c.opts?.idempotencyKey])).toEqual([
      [acct, pay.amountCents - pay.applicationFeeCents - 1500, pay.stripeChargeId, `sale_${saleId}`, `${saleId}:shop`],
      ["acct_fake_makenna", 1500, pay.stripeChargeId, `sale_${saleId}`, `${saleId}:tip`],
    ]);
    expect(shopRow.amountCents + tipRows[0].amountCents).toBe(pay.amountCents - pay.applicationFeeCents);

    // Replays move nothing: the sale's own settle again, the cron, twice.
    calls.length = 0;
    await settlement.settleSale(saleId);
    await settlement.settlementCron();
    await settlement.settlementCron();
    expect(calls).toEqual([]);

    // The barber's batch pays the tip out of their own balance: a payout, never a second transfer.
    const b = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [draft] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(draft).toMatchObject({ method: "stripe", netCents: 1500 });
    calls.length = 0;
    await tp.approveBatch(b.batchId, actor);
    await settlement.settlementCron();
    expect(calls.map((c) => [c.op, c.params.amount, c.opts?.stripeAccount])).toEqual([["payout", 1500, "acct_fake_makenna"]]);
    expect(await m.db.db.select().from(s().paymentTransfers).where(and(eq(s().paymentTransfers.paymentId, pay.id), eq(s().paymentTransfers.kind, "tip")))).toHaveLength(1);

    // Payroll: reported to iSolved once (E_Cash Tips Recd), not paid again on the paycheck.
    const after = await payrollOf(shop.id, staffId);
    expect(after.tips - before.tips).toBeCloseTo(15);
    expect(after.tipsInPayroll - before.tipsInPayroll).toBeCloseTo(0);
    expect(after.view.tips.mismatches).toEqual([]);
  });

  it("the payroll detail file and the tip reconciliation CSV read the tip from its transfer", async () => {
    const { shop, staffId } = await setup("coralville", "Makenna");
    await barberOnStripe(staffId, "acct_fake_makenna");
    const before = await payrollOf(shop.id, staffId);
    const { saleId, tipRows } = await cardSale(shop.id, staffId, 700);
    const tr = tipRows[0];
    expect(tr).toMatchObject({ status: "sent", amountCents: 700 });

    // Before any payout: the tip is already in their Stripe account, so it's paid via Stripe.
    const after = await payrollOf(shop.id, staffId);
    expect(after.check!.transferredCents - (before.check?.transferredCents ?? 0)).toBe(700);
    expect(after.check!.tipTransfers).toContainEqual(expect.objectContaining({ id: tr.id, saleId, cents: 700, status: "sent", stripeTransferId: tr.stripeTransferId, ledgerCents: 700 }));
    expect(after.check!.problems).toEqual([]);
    expect(Math.round((after.detailStripe - before.detailStripe) * 100)).toBe(700);
    expect(after.detailTransfers.split(" ")).toContain(tr.stripeTransferId);
    const csv = after.csv.split("\n");
    const date = after.check!.tipTransfers.find((x) => x.id === tr.id)!.date;
    expect(csv.find((l) => l.includes(tr.id))).toBe([after.check!.shop, after.check!.name, tr.id, saleId, tr.paymentId, date, "7.00", "sent", tr.stripeTransferId, "7.00"].join(","));
    expect(csv.some((l) => l.startsWith("Shop,Employee,Tips earned") && l.includes("Card tips transferred to Stripe at the sale"))).toBe(true);

    // A tip sent to a barber that the ledger doesn't have would be paid and never reported: flagged, and it blocks.
    const none = await cardSale(shop.id, staffId, 0);
    const [orphan] = await m.db.db
      .insert(s().paymentTransfers)
      .values({ paymentId: none.pay.id, saleId: none.saleId, shopId: shop.id, kind: "tip", staffId, destinationAccount: "acct_fake_makenna", amountCents: 100, transferGroup: `sale_${none.saleId}`, status: "sent", stripeTransferId: "tr_fake_orphan" })
      .returning();
    onTestFinished(async () => void (await m.db.db.delete(s().paymentTransfers).where(eq(s().paymentTransfers.id, orphan.id))));
    const flagged = await payrollOf(shop.id, staffId);
    expect(flagged.check!.problems).toContainEqual(expect.stringMatching(/a tip transfer of \$1\.00 .* has no tip in the tip ledger/));
    expect(flagged.view.tips.mismatches).toContainEqual(expect.objectContaining({ shopId: shop.id, column: "Card tips transferred to Stripe at the sale", check: "tips" }));
    expect(detail.detailRefusal(flagged.view)).toMatch(/has no tip in the tip ledger/);
  });
});

describe("the shop's Tips to barbers switch", () => {
  it("on: the tip is its own transfer to the barber; off: it stays in the shop's transfer, goes on the paycheck, and no Stripe payout pays it", async () => {
    const { shop, staffId } = await setup("utica", "Sarah");
    await barberOnStripe(staffId, "acct_fake_sarah");
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "stripe" } }).where(eq(s().shops.id, shop.id));
    onTestFinished(async () => {
      await brandSet("shop_setting", "tip_to_barber", { enabled: true }, { shops: [shop.id] });
      await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(eq(s().shops.id, shop.id));
    });

    const on = await cardSale(shop.id, staffId, 900);
    expect(on.tipRows).toEqual([expect.objectContaining({ amountCents: 900, idempotencyKey: `${on.saleId}:tip` })]);
    expect(on.shopRow.amountCents).toBe(on.pay.amountCents - on.pay.applicationFeeCents - 900);

    await brandSet("shop_setting", "tip_to_barber", { enabled: false }, { shops: [shop.id] });
    expect(await auditsOf("tips.tip_to_barber", shop.id)).toEqual([expect.objectContaining({ details: { setting: "tip_to_barber", before: { enabled: true }, after: { enabled: false }, via: "brand_sync" } })]);
    const before = await payrollOf(shop.id, staffId);
    const off = await cardSale(shop.id, staffId, 600);
    expect(off.tipRows).toEqual([]);
    expect(off.moved.map((c) => [c.params.amount, c.opts?.idempotencyKey])).toEqual([[off.pay.amountCents - off.pay.applicationFeeCents, `${off.saleId}:shop`]]);
    const after = await payrollOf(shop.id, staffId);
    expect([after.tips - before.tips, after.tipsInPayroll - before.tipsInPayroll].map((x) => Math.round(x * 100))).toEqual([600, 600]);
    expect(after.check!.transferredCents).toBe(before.check!.transferredCents);

    // The batch only pays the tip already with her; the one that stayed with the shop is the paycheck's.
    const b = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const mine = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(mine).toEqual([expect.objectContaining({ method: "stripe", netCents: 900 })]);
    await tp.cancelBatch(b.batchId, "test", actor);
  });
});

describe("refunds: the shop's transfer only, after a plain refund", () => {
  it("partial: the shop's transfer is reversed by exactly the refund; the tip transfer is untouched and nothing is a loss", async () => {
    const { shop, staffId } = await setup("rock-island", "Garrett");
    await barberOnStripe(staffId, "acct_fake_garrett");
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 1200, 2);
    const item = await serviceItem(saleId);
    calls.length = 0;
    await m.checkout.refundSale({ saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Unhappy with the fade", restock: false, actor });
    const [ref] = await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, saleId));
    expect(ref.amountCents).toBeLessThan(shopRow.amountCents);
    expect(m.processor.simulatorLedger().refunds.filter((r) => r.paymentIntentId === pay.stripePaymentIntentId)).toEqual([{ id: expect.any(String), paymentIntentId: pay.stripePaymentIntentId, amountCents: ref.amountCents }]);
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", shopRow.stripeTransferId, ref.amountCents]]);
    expect(await reversalsOf(pay.id)).toEqual([expect.objectContaining({ kind: "refund", refundId: ref.id, amountCents: ref.amountCents, uncoveredCents: 0, status: "sent" })]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", amountCents: 1200, reversedCents: 0 });
    expect(await lossesOf(pay.id)).toEqual([]);
  });

  it("full, with the tip in the shop's transfer (switch off): the whole transfer comes back, and only the processing fee is the platform's", async () => {
    const { shop, staffId } = await setup("silvis", "Liv");
    await barberOnStripe(staffId, "acct_fake_liv");
    await brandSet("shop_setting", "tip_to_barber", { enabled: false }, { shops: [shop.id] });
    onTestFinished(async () => void (await brandSet("shop_setting", "tip_to_barber", { enabled: true }, { shops: [shop.id] })));
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 800);
    expect(tipRows).toEqual([]);
    calls.length = 0;
    await m.checkout.refundEverything(saleId, "Unhappy client", false, actor);
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", shopRow.stripeTransferId, shopRow.amountCents]]);
    const [r] = await reversalsOf(pay.id);
    expect(r).toMatchObject({ amountCents: shopRow.amountCents, uncoveredCents: pay.applicationFeeCents, status: "sent" });
    expect(await lossesOf(pay.id)).toEqual([expect.objectContaining({ kind: "refund", cents: pay.applicationFeeCents, tipCents: 0, bearer: "platform" })]);
  });

  it("past the sale's portion (tip with the barber): the platform absorbs the tip as a platform-loss entry, the barber keeps it, and it's audited", async () => {
    const { shop, staffId } = await setup("kimberly", "Beth");
    await barberOnStripe(staffId, "acct_fake_beth");
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 2500);
    calls.length = 0;
    await m.checkout.refundEverything(saleId, "Charged the wrong card", false, actor);
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", shopRow.stripeTransferId, shopRow.amountCents]]);
    expect(calls.some((c) => c.params.transfer === tipRows[0].stripeTransferId)).toBe(false);
    const [r] = await reversalsOf(pay.id);
    expect(r.uncoveredCents).toBe(pay.amountCents - shopRow.amountCents);
    expect(await lossesOf(pay.id)).toEqual([expect.objectContaining({ kind: "refund", refundId: r.refundId, cents: r.uncoveredCents, tipCents: 2500, bearer: "platform", recoveredCents: 0 })]);
    expect((await auditsOf("payment.platform_loss", pay.id)).map((a) => a.details)).toEqual([expect.objectContaining({ tipCents: 2500, feeCents: pay.applicationFeeCents, bearer: "platform" })]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", amountCents: 2500, reversedCents: 0 });
    // Not clawed back from the barber in the tip ledger either: the shop's cost, still in their reported tips.
    expect(await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, saleId), eq(s().tipLedger.kind, "refund")))).toEqual([]);
    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, saleId))).toEqual([expect.objectContaining({ staffId, amountCents: 2500, kind: "after_payout" })]);
  });

  it("retried: settling again, the cron and Stripe's charge.refunded webhook take nothing more back", async () => {
    const { shop, staffId } = await setup("moline", "Jen");
    await barberOnStripe(staffId, "acct_fake_jen");
    const { saleId, pay } = await cardSale(shop.id, staffId, 500, 2);
    await m.checkout.refundSale({ saleId, items: [{ saleItemId: (await serviceItem(saleId)).id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Unhappy", restock: false, actor });
    const refunded = (await m.db.db.query.payments.findFirst({ where: eq(s().payments.id, pay.id) }))!.refundedCents;
    calls.length = 0;
    await settlement.settleSale(saleId);
    await settlement.settlementCron();
    await webhook.platformEvent(event("evt_refund_replay", "charge.refunded", { id: pay.stripeChargeId, object: "charge", payment_intent: pay.stripePaymentIntentId, amount_refunded: refunded, refunds: { data: [] } }));
    await webhook.platformEvent(event("evt_refund_replay", "charge.refunded", { id: pay.stripeChargeId, object: "charge", payment_intent: pay.stripePaymentIntentId, amount_refunded: refunded, refunds: { data: [] } }));
    expect(calls).toEqual([]);
    expect(await reversalsOf(pay.id)).toHaveLength(1);
  });
});

describe("disputes: charge.dispute.created and charge.dispute.closed", () => {
  it("lost: the shop's portion is reversed, the platform absorbs the tip as a loss entry, the audit rows stay, and replays book it once", async () => {
    const { shop, staffId } = await setup("le-claire", "Skylar");
    await barberOnStripe(staffId, "acct_fake_skylar");
    const { pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 3000);
    const d = { id: "dp_tips_lost", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: pay.amountCents, reason: "fraudulent", created: Math.floor(Date.now() / 1000) };
    calls.length = 0;
    await webhook.platformEvent(event("evt_l1", "charge.dispute.created", { ...d, status: "needs_response" }));
    await webhook.platformEvent(event("evt_l1", "charge.dispute.created", { ...d, status: "needs_response" }));
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", shopRow.stripeTransferId, shopRow.amountCents]]);
    await webhook.platformEvent(event("evt_l2", "charge.dispute.closed", { ...d, status: "lost" }));
    await webhook.platformEvent(event("evt_l2", "charge.dispute.closed", { ...d, status: "lost" }));
    expect(await reversalsOf(pay.id)).toEqual([expect.objectContaining({ kind: "dispute", stripeDisputeId: d.id, amountCents: shopRow.amountCents, uncoveredCents: pay.amountCents - shopRow.amountCents, status: "sent" })]);
    expect(await lossesOf(pay.id)).toEqual([expect.objectContaining({ kind: "dispute_lost", stripeDisputeId: d.id, cents: pay.amountCents - shopRow.amountCents, tipCents: 3000, bearer: "platform" })]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", reversedCents: 0 });
    expect((await auditsOf("stripe.charge.dispute.created", pay.id)).map((a) => a.details)).toContainEqual(expect.objectContaining({ fromShopTransferCents: shopRow.amountCents, uncoveredCents: pay.amountCents - shopRow.amountCents }));
    expect((await auditsOf("stripe.charge.dispute.closed", pay.id)).map((a) => a.details)).toContainEqual(expect.objectContaining({ status: "lost", platformLossCents: pay.amountCents - shopRow.amountCents, platformLossTipCents: 3000 }));
  });

  it("won: what the dispute took goes back to the shop once, with no loss, and the tip is never touched", async () => {
    const { shop, acct, staffId } = await setup("le-claire", "Audra");
    await barberOnStripe(staffId, "acct_fake_audra");
    const { pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 1000);
    const d = { id: "dp_tips_won", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: 2000, reason: "product_not_received", created: Math.floor(Date.now() / 1000) };
    await webhook.platformEvent(event("evt_w1", "charge.dispute.created", { ...d, status: "needs_response" }));
    calls.length = 0;
    await webhook.platformEvent(event("evt_w2", "charge.dispute.closed", { ...d, status: "won" }));
    await webhook.platformEvent(event("evt_w2", "charge.dispute.closed", { ...d, status: "won" }));
    await settlement.settlementCron();
    const won = (await reversalsOf(pay.id)).filter((r) => r.kind === "dispute_won");
    expect(won).toEqual([expect.objectContaining({ amountCents: 2000, status: "sent" })]);
    expect(calls.map((c) => [c.op, c.params.destination, c.params.amount, c.params.transfer_group])).toEqual([["transfer", acct, 2000, shopRow.transferGroup]]);
    expect(await lossesOf(pay.id)).toEqual([]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", amountCents: 1000, reversedCents: 0 });
    expect((await auditsOf("stripe.charge.dispute.closed", pay.id)).map((a) => a.details)).toContainEqual(expect.objectContaining({ status: "won", backToShopCents: 2000 }));
  });
});

describe("idempotent retries", () => {
  it("a refused transfer is retried with the same {saleId}:shop and {saleId}:tip keys, so each moves once", async () => {
    const { shop, acct, staffId } = await setup("moline", "Jen");
    await barberOnStripe(staffId, "acct_fake_jen");
    failTransfers = 2;
    const { saleId, shopRow, tipRows } = await cardSale(shop.id, staffId, 400);
    expect([shopRow.status, tipRows[0].status]).toEqual(["pending", "pending"]);
    await settlement.settlementCron();
    await settlement.settlementCron();
    await settlement.settleSale(saleId);
    const done = await moneyOf(saleId);
    expect([done.shopRow.status, done.tipRows[0].status]).toEqual(["sent", "sent"]);
    expect(tries).toEqual([
      [acct, `${saleId}:shop`],
      ["acct_fake_jen", `${saleId}:tip`],
      [acct, `${saleId}:shop`],
      ["acct_fake_jen", `${saleId}:tip`],
    ]);
    expect(calls.filter((c) => c.op === "transfer").map((c) => c.opts?.idempotencyKey)).toEqual([`${saleId}:shop`, `${saleId}:tip`]);
  });
});

describe("a destination charge from before separate charges (core_0150)", () => {
  /** The backfill as the migration runs it. */
  async function backfill() {
    const file = readFileSync(resolve(__dirname, "../../drizzle/core_0150_shop_transfer_backfill.sql"), "utf8");
    for (const stmt of file.split("--> statement-breakpoint")) if (stmt.replace(/^--.*$/gm, "").trim()) await m.db.db.execute(m.drizzle.sql.raw(stmt));
  }

  it("gets its shop row from payments.stripe_transfer_id; an earlier refund isn't taken twice; new refunds and disputes reverse the shop transfer without reverse_transfer", async () => {
    const { shop, acct, staffId } = await setup("utica", "Kate");
    const { saleId, pay } = await cardSale(shop.id, staffId, 600, 2);
    await m.checkout.refundSale({ saleId, items: [], tipCents: 600, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    // As it was before I10: a destination charge, its transfer made by Stripe with the charge, the refund reversed with it.
    await m.db.db.delete(s().paymentTransferReversals).where(eq(s().paymentTransferReversals.paymentId, pay.id));
    await m.db.db.delete(s().paymentTransfers).where(eq(s().paymentTransfers.paymentId, pay.id));
    await m.db.db.update(s().payments).set({ chargeType: "destination", stripeTransferId: "tr_legacy_kate" }).where(eq(s().payments.id, pay.id));

    await backfill();
    await backfill();
    const { shopRow } = await moneyOf(saleId);
    const cents = pay.amountCents - pay.applicationFeeCents;
    const earlier = Math.round((600 * cents) / pay.amountCents);
    expect(shopRow).toMatchObject({ kind: "shop", status: "sent", stripeTransferId: "tr_legacy_kate", destinationAccount: acct, amountCents: cents, reversedCents: earlier, transferGroup: `sale_${saleId}` });
    expect(await reversalsOf(pay.id)).toEqual([expect.objectContaining({ kind: "refund", amountCents: earlier, status: "in_refund", stripeId: null })]);

    calls.length = 0;
    await m.checkout.refundSale({ saleId, items: [{ saleItemId: (await serviceItem(saleId)).id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Unhappy", restock: false, actor });
    const second = (await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, saleId))).find((r) => r.amountCents !== 600)!;
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", "tr_legacy_kate", second.amountCents]]);
    expect(m.processor.simulatorLedger().refunds.filter((r) => r.paymentIntentId === pay.stripePaymentIntentId).every((r) => Object.keys(r).sort().join() === "amountCents,id,paymentIntentId")).toBe(true);

    calls.length = 0;
    const d = { id: "dp_legacy_kate", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: 1000, reason: "fraudulent", created: Math.floor(Date.now() / 1000) };
    await webhook.platformEvent(event("evt_legacy_d", "charge.dispute.created", { ...d, status: "needs_response" }));
    const left = cents - earlier - second.amountCents;
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", "tr_legacy_kate", Math.min(1000, left)]]);
  });
});
