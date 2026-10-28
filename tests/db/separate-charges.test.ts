/**
 * I10, separate charges and transfers (Charles, 2026-10-28), against a stand-in Stripe that records
 * every transfer: each card sale is charged on the platform with its transfer_group, then the shop's
 * portion goes to the shop's connected account and, with FEATURE_TIP_TO_BARBER on (the launch
 * default, unset here), each tip to its barber's recipient account, all with source_transaction. Off,
 * brand-wide (FEATURE_TIP_TO_BARBER=false) or at the shops the brand picks (tip_to_barber), the tip is in
 * the shop's transfer and goes on the paycheck. Either way every tip is in the iSolved figures, under
 * E_Cash Tips Recd. Refunds and disputes are taken
 * back from the shop's transfer only; a tip is never clawed back; a won dispute goes back to the shop.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
let n = 0;
let failTransfers = 0;
const fake = {
  transfers: {
    create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
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
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  settlement = await import("@/server/payments/settlement");
  webhook = await import("@/server/payments/webhook");
  run = await import("@/server/payroll/run");
  today = m.time.todayLocal();
  await m.db.db.update(m.schema.shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } });
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterEach(() => {
  delete process.env.FEATURE_TIP_TO_BARBER;
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

/** A shop whose connected account is a real (not simulator) one in the stand-in Stripe, and one of its barbers. */
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

/** The barber's Express account: active, agreed to Stripe deposits, paid by Stripe. */
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

async function cardSale(shopId: string, staffId: string, tipCents: number) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  calls.length = 0;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: credit, actor });
  const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, sale.id));
  const rows = await m.db.db.select().from(s().paymentTransfers).where(eq(s().paymentTransfers.saleId, sale.id));
  return { saleId: sale.id, pay, shopRow: rows.find((r) => r.kind === "shop"), tipRows: rows.filter((r) => r.kind === "tip"), moved: [...calls] };
}

const reversalsOf = (paymentId: string) => m.db.db.select().from(s().paymentTransferReversals).where(eq(s().paymentTransferReversals.paymentId, paymentId));
const transferRow = async (id: string) => (await m.db.db.query.paymentTransfers.findFirst({ where: eq(s().paymentTransfers.id, id) }))!;
const lossesOf = (paymentId: string) => m.db.db.select().from(s().platformLosses).where(eq(s().platformLosses.paymentId, paymentId));
const lossById = async (id: string) => (await m.db.db.query.platformLosses.findFirst({ where: eq(s().platformLosses.id, id) }))!;
const recoveriesOf = (lossId: string) => m.db.db.select().from(s().platformLossRecoveries).where(eq(s().platformLossRecoveries.lossId, lossId)).orderBy(s().platformLossRecoveries.createdAt);

/** The barber's line in this pay period's iSolved figures. */
async function payrollLine(shopId: string, staffId: string) {
  const p = (await run.periodChoices()).find((c) => c.current)!;
  const view = (await run.buildPayroll(p.start, p.end, { clockChecks: false }))!;
  const line = view.blocks.find((b) => b.shopId === shopId)?.lines.find((l) => l.staffId === staffId);
  return { tips: line?.input.tips ?? 0, tipsInPayroll: line?.input.tipsInPayroll ?? 0, tipsOutside: line?.tipsOutside ?? 0 };
}

describe("FEATURE_TIP_TO_BARBER=false (the brand-wide kill switch)", () => {
  beforeEach(() => void (process.env.FEATURE_TIP_TO_BARBER = "false"));

  it("one platform charge with the sale's transfer_group; the shop's transfer is the charge less the processing fee, tip included, waiting on the charge's funds", async () => {
    const { shop, acct, staffId } = await setup("moline", "Jen");
    await barberOnStripe(staffId, "acct_fake_jen");
    const before = await payrollLine(shop.id, staffId);
    const { saleId, pay, shopRow, tipRows, moved } = await cardSale(shop.id, staffId, 1000);
    expect(pay).toMatchObject({ chargeType: "separate", transferGroup: `sale_${saleId}`, settlement: "connected", stripeAccountId: acct, stripeTransferId: null });
    expect(pay.applicationFeeCents).toBeGreaterThan(0);
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent.transferGroup).toBe(`sale_${saleId}`);
    expect(tipRows).toEqual([]);
    expect(shopRow).toMatchObject({ status: "sent", amountCents: pay.amountCents - pay.applicationFeeCents, destinationAccount: acct, transferGroup: `sale_${saleId}` });
    expect(moved).toEqual([
      {
        op: "transfer",
        id: shopRow!.stripeTransferId,
        params: expect.objectContaining({ amount: shopRow!.amountCents, destination: acct, transfer_group: `sale_${saleId}`, source_transaction: pay.stripeChargeId }),
        opts: { idempotencyKey: `${saleId}:shop` },
      },
    ]);
    expect(shopRow!.idempotencyKey).toBe(`${saleId}:shop`);

    // The tip is with the shop, so no Stripe payout: it goes on the paycheck, and it's in the iSolved figures.
    const b = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const mine = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(mine).toEqual([]);
    const after = await payrollLine(shop.id, staffId);
    expect(after.tips - before.tips).toBeCloseTo(10);
    expect(after.tipsInPayroll - before.tipsInPayroll).toBeCloseTo(10);
    await tp.cancelBatch(b.batchId, "test", actor);
  });

  it("a shop on the brand's account has no shop transfer, and the tip stays on the platform for payroll", async () => {
    const { shop, staffId } = await setup("silvis", "Abigail");
    await m.db.db.update(s().shops).set({ paymentsMode: "brand" }).where(eq(s().shops.id, shop.id));
    onTestFinished(async () => void (await m.db.db.update(s().shops).set({ paymentsMode: "connected" }).where(eq(s().shops.id, shop.id))));
    await barberOnStripe(staffId, "acct_fake_abigail");
    const { pay, shopRow, tipRows, moved } = await cardSale(shop.id, staffId, 800);
    expect(pay).toMatchObject({ chargeType: "separate", settlement: "platform", stripeAccountId: null });
    expect([shopRow, tipRows, moved]).toEqual([undefined, [], []]);
  });
});

describe("FEATURE_TIP_TO_BARBER on (the launch default)", () => {
  it("the tip goes to the barber's Express account with source_transaction, the shop gets the rest, and the batch only pays it out of their balance", async () => {
    const { shop, acct, staffId } = await setup("coralville", "Makenna");
    await barberOnStripe(staffId, "acct_fake_makenna");
    const before = await payrollLine(shop.id, staffId);
    const { saleId, pay, shopRow, tipRows, moved } = await cardSale(shop.id, staffId, 1500);
    expect(tipRows).toEqual([expect.objectContaining({ staffId, destinationAccount: "acct_fake_makenna", amountCents: 1500, status: "sent", reversedCents: 0 })]);
    expect(shopRow).toMatchObject({ status: "sent", amountCents: pay.amountCents - pay.applicationFeeCents - 1500 });
    expect(moved.map((c) => [c.params.destination, c.params.amount, c.params.source_transaction, c.params.transfer_group])).toEqual([
      [acct, shopRow!.amountCents, pay.stripeChargeId, `sale_${saleId}`],
      ["acct_fake_makenna", 1500, pay.stripeChargeId, `sale_${saleId}`],
    ]);
    // One transfer_group per ticket; Stripe's idempotency keys are {saleId}:shop and {saleId}:tip.
    expect(moved.map((c) => c.opts?.idempotencyKey)).toEqual([`${saleId}:shop`, `${saleId}:tip`]);
    expect([shopRow!.idempotencyKey, tipRows[0].idempotencyKey]).toEqual([`${saleId}:shop`, `${saleId}:tip`]);
    expect(new Set([pay.transferGroup, shopRow!.transferGroup, tipRows[0].transferGroup])).toEqual(new Set([`sale_${saleId}`]));

    const b = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [draft] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(draft).toMatchObject({ method: "stripe", status: "pending", netCents: 1500 });
    calls.length = 0;
    await tp.approveBatch(b.batchId, actor);
    expect(calls.map((c) => [c.op, c.params.amount, c.opts?.stripeAccount])).toEqual([["payout", 1500, "acct_fake_makenna"]]);
    const sent = (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, draft.id) }))!;
    expect(sent).toMatchObject({ status: "processing", stripeTransferId: null, stripePayoutId: calls[0].id });

    // Paid outside payroll, so not on the paycheck; in the iSolved file as E_Cash Tips Recd, tips they already have.
    const after = await payrollLine(shop.id, staffId);
    expect(after.tips - before.tips).toBeCloseTo(15);
    expect(after.tipsInPayroll - before.tipsInPayroll).toBeCloseTo(0);
    expect(after.tipsOutside - before.tipsOutside).toBeCloseTo(15);
  });

  it("a barber who can't take Stripe yet: their tip stays in the shop's transfer and goes on the paycheck", async () => {
    const { shop, staffId } = await setup("kimberly", "Beth");
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "stripe" } }).where(eq(s().shops.id, shop.id));
    onTestFinished(async () => void (await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(eq(s().shops.id, shop.id))));
    await m.db.db.delete(s().staffPayoutAccounts).where(eq(s().staffPayoutAccounts.staffId, staffId));
    const before = await payrollLine(shop.id, staffId);
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 700);
    expect(tipRows).toEqual([]);
    expect(shopRow!.amountCents).toBe(pay.amountCents - pay.applicationFeeCents);
    // Other barbers' tip transfers (earlier tests) don't make this one the barber's.
    const [entry] = await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, saleId), eq(s().tipLedger.kind, "tip")));
    expect((await settlement.tipRoutes(m.db.db, [entry.id])).get(entry.id)).toBe("shop");
    const after = await payrollLine(shop.id, staffId);
    expect(after.tips - before.tips).toBeCloseTo(7);
    expect(after.tipsInPayroll - before.tipsInPayroll).toBeCloseTo(7);
  });
});

describe("a shop's Tips to barbers switch (the per-shop kill switch)", () => {
  it("off at one shop: new card tips stay in its transfer and go on the paycheck, other shops' still go to barbers, and a tip already transferred is paid out of the barber's balance", async () => {
    const { shop, staffId } = await setup("utica", "Sarah");
    const other = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    await barberOnStripe(staffId, "acct_fake_sarah");
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "stripe" } }).where(eq(s().shops.id, shop.id));
    onTestFinished(async () => void (await m.db.db.update(s().shops).set({ tipToBarber: true, tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(eq(s().shops.id, shop.id))));
    const first = await cardSale(shop.id, staffId, 900);
    expect(first.tipRows).toEqual([expect.objectContaining({ staffId, destinationAccount: "acct_fake_sarah", amountCents: 900, status: "sent" })]);

    // The brand turns it off at this shop only, through the shop picker.
    await brandSet("shop_setting", "tip_to_barber", { enabled: false }, { shops: [shop.id] });
    const logs = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.tip_to_barber"), eq(s().auditLog.entityId, shop.id)));
    expect(logs.map((l) => l.details)).toEqual([{ setting: "tip_to_barber", before: { enabled: true }, after: { enabled: false }, via: "brand_sync" }]);
    expect([...(await settlement.tipToBarberShops([shop.id, other.id]))]).toEqual([other.id]);

    const before = await payrollLine(shop.id, staffId);
    const second = await cardSale(shop.id, staffId, 600);
    expect(second.tipRows).toEqual([]);
    expect(second.shopRow!.amountCents).toBe(second.pay.amountCents - second.pay.applicationFeeCents);
    const [entry] = await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, second.saleId), eq(s().tipLedger.kind, "tip")));
    expect((await settlement.tipRoutes(m.db.db, [entry.id])).get(entry.id)).toBe("shop");
    const after = await payrollLine(shop.id, staffId);
    expect([after.tips - before.tips, after.tipsInPayroll - before.tipsInPayroll, after.tipsOutside - before.tipsOutside].map((x) => Math.round(x * 100) / 100)).toEqual([6, 6, 0]);

    const b = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const mine = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, b.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(mine).toEqual([expect.objectContaining({ method: "stripe", status: "pending", netCents: 900 })]);
    calls.length = 0;
    await tp.approveBatch(b.batchId, actor);
    expect(calls.map((c) => [c.op, c.params.amount, c.opts?.stripeAccount])).toEqual([["payout", 900, "acct_fake_sarah"]]);

    // Back on, the next card tip goes to her account again.
    await brandSet("shop_setting", "tip_to_barber", { enabled: true }, { shops: [shop.id] });
    const third = await cardSale(shop.id, staffId, 400);
    expect(third.tipRows).toEqual([expect.objectContaining({ amountCents: 400, status: "sent" })]);
  });
});

describe("refunds and disputes: the shop's transfer only, never a tip", () => {
  it("a refund reverses the shop's transfer; the barber keeps the tip, and what the shop's transfer can't cover is recorded as the platform's", async () => {
    const { shop, staffId } = await setup("le-claire", "Skylar");
    await barberOnStripe(staffId, "acct_fake_skylar");
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 2000);
    const tipRow = tipRows[0];

    calls.length = 0;
    await m.checkout.refundSale({ saleId, items: [], tipCents: 500, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    expect(calls).toEqual([expect.objectContaining({ op: "reversal", params: expect.objectContaining({ transfer: shopRow!.stripeTransferId, amount: 500 }) })]);
    expect(m.processor.simulatorLedger().refunds.filter((r) => r.paymentIntentId === pay.stripePaymentIntentId)).toEqual([expect.objectContaining({ amountCents: 500, reverseTransfer: false })]);
    expect((await transferRow(shopRow!.id)).reversedCents).toBe(500);
    // The refunded tip is the shop's cost (already with the barber), never a tip ledger reversal.
    const absorbed = await m.db.db.select().from(s().tipAbsorptions).where(and(eq(s().tipAbsorptions.saleId, saleId), eq(s().tipAbsorptions.staffId, staffId)));
    expect(absorbed).toEqual([expect.objectContaining({ amountCents: 500, kind: "after_payout" })]);
    expect(await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, saleId), eq(s().tipLedger.kind, "refund")))).toEqual([]);

    calls.length = 0;
    await m.checkout.refundEverything(saleId, "Unhappy client", false, actor);
    const rest = (await reversalsOf(pay.id)).find((r) => r.kind === "refund" && r.amountCents !== 500)!;
    const left = shopRow!.amountCents - 500;
    expect(rest).toMatchObject({ status: "sent", amountCents: left });
    expect(rest.uncoveredCents).toBeGreaterThan(0);
    expect(calls.map((c) => [c.op, c.params.transfer, c.params.amount])).toEqual([["reversal", shopRow!.stripeTransferId, left]]);
    expect(await transferRow(tipRow.id)).toMatchObject({ status: "sent", amountCents: 2000, reversedCents: 0 });
    expect(calls.some((c) => c.params.transfer === tipRow.stripeTransferId)).toBe(false);

    // What the shop's portion couldn't cover is a platform loss: the tip already with the barber, and the fee.
    const losses = await lossesOf(pay.id);
    expect(losses).toEqual([expect.objectContaining({ kind: "refund", refundId: rest.refundId, cents: rest.uncoveredCents, tipCents: 2000, bearer: "platform", recoveredCents: 0 })]);
    expect(rest.uncoveredCents - 2000).toBe(pay.applicationFeeCents);
    const [logged] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "payment.platform_loss"), eq(s().auditLog.entityId, pay.id)));
    expect(logged.details).toMatchObject({ cents: rest.uncoveredCents, tipCents: 2000, feeCents: pay.applicationFeeCents, bearer: "platform" });
    // The first refund (500) was covered by the shop's portion: no loss for it.
    expect(losses.some((l) => l.refundId !== rest.refundId)).toBe(false);
  });

  it("a dispute takes the disputed amount back from the shop's transfer, and a won dispute sends it back to the shop", async () => {
    const { shop, acct, staffId } = await setup("rock-island", "Garrett");
    const { pay, shopRow } = await cardSale(shop.id, staffId, 600);
    const dispute = { id: "dp_test_won", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: 2500, reason: "fraudulent", created: Math.floor(Date.now() / 1000) };
    const event = (type: string, object: object) => ({ id: `evt_${type}`, type, created: Math.floor(Date.now() / 1000), data: { object } }) as never;

    calls.length = 0;
    await webhook.platformEvent(event("charge.dispute.created", { ...dispute, status: "needs_response" }));
    const opened = (await reversalsOf(pay.id)).find((r) => r.kind === "dispute")!;
    expect(opened).toMatchObject({ status: "sent", amountCents: 2500, stripeDisputeId: "dp_test_won" });
    expect(calls).toEqual([expect.objectContaining({ op: "reversal", params: expect.objectContaining({ transfer: shopRow!.stripeTransferId, amount: 2500 }) })]);
    // The webhook replays: still one reversal.
    await webhook.platformEvent(event("charge.dispute.created", { ...dispute, status: "needs_response" }));
    expect((await reversalsOf(pay.id)).filter((r) => r.kind === "dispute")).toHaveLength(1);

    calls.length = 0;
    await webhook.platformEvent(event("charge.dispute.closed", { ...dispute, status: "won" }));
    const won = (await reversalsOf(pay.id)).find((r) => r.kind === "dispute_won")!;
    expect(won).toMatchObject({ status: "sent", amountCents: 2500 });
    expect(calls).toEqual([expect.objectContaining({ op: "transfer", id: won.stripeId })]);
    expect(calls[0].params).toMatchObject({ amount: 2500, destination: acct, transfer_group: shopRow!.transferGroup });
    expect(calls[0].params).not.toHaveProperty("source_transaction");
    expect(await lossesOf(pay.id)).toEqual([]);
  });

  it("a lost dispute leaves the reversal; a dispute on a tip-heavy charge takes only what the shop's transfer has", async () => {
    const { shop, staffId } = await setup("silvis", "Liv");
    await barberOnStripe(staffId, "acct_fake_liv");
    const { pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 3000);
    const d = { id: "dp_test_lost", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: pay.amountCents, reason: "fraudulent", created: Math.floor(Date.now() / 1000) };
    await webhook.platformEvent({ id: "evt_d1", type: "charge.dispute.created", created: d.created, data: { object: { ...d, status: "needs_response" } } } as never);
    await webhook.platformEvent({ id: "evt_d2", type: "charge.dispute.closed", created: d.created, data: { object: { ...d, status: "lost" } } } as never);
    const rs = await reversalsOf(pay.id);
    expect(rs).toEqual([expect.objectContaining({ kind: "dispute", amountCents: shopRow!.amountCents, uncoveredCents: pay.amountCents - shopRow!.amountCents, status: "sent" })]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", reversedCents: 0 });
    // Lost: the part past the shop's portion is a platform loss, the tip transfer untouched. A replayed event books it once.
    await webhook.platformEvent({ id: "evt_d3", type: "charge.dispute.closed", created: d.created, data: { object: { ...d, status: "lost" } } } as never);
    expect(await lossesOf(pay.id)).toEqual([
      expect.objectContaining({ kind: "dispute_lost", stripeDisputeId: "dp_test_lost", refundId: null, cents: pay.amountCents - shopRow!.amountCents, tipCents: 3000, bearer: "platform" }),
    ]);
  });

  it("a dispute closed any other way than lost or won (an inquiry closed) books nothing", async () => {
    const { shop, staffId } = await setup("silvis", "Liv");
    const { pay } = await cardSale(shop.id, staffId, 3000);
    const d = { id: "dp_test_warning", object: "dispute", payment_intent: pay.stripePaymentIntentId, amount: pay.amountCents, reason: "fraudulent", created: Math.floor(Date.now() / 1000) };
    await webhook.platformEvent({ id: "evt_w1", type: "charge.dispute.created", created: d.created, data: { object: { ...d, status: "warning_needs_response" } } } as never);
    await webhook.platformEvent({ id: "evt_w2", type: "charge.dispute.closed", created: d.created, data: { object: { ...d, status: "warning_closed" } } } as never);
    expect(await lossesOf(pay.id)).toEqual([]);
  });
});

describe("a refund bigger than the sale's portion (the brand's tip_refund_overflow, sent to the shops picked; confirm with Charles)", () => {
  async function overflowSetting(v: "platform" | "shop", slug: string) {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
    await brandSet("shop_setting", "tip_refund_overflow", { bearer: v }, { shops: [shop.id] });
    onTestFinished(async () => void (await brandSet("shop_setting", "tip_refund_overflow", { bearer: "platform" })));
  }

  it("the shop: the tip part is taken from its next transfers (never the barber's tip), a refund of that later sale reopens it, and the one after takes it again", async () => {
    await overflowSetting("shop", "le-claire");
    expect(await settlement.tipRefundOverflowAt((await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id)).toBe("platform");
    const { shop, staffId } = await setup("le-claire", "Audra");
    const jamie = (await setup("le-claire", "Jamie")).staffId;
    await m.db.db.delete(s().staffPayoutAccounts).where(eq(s().staffPayoutAccounts.staffId, jamie));
    await barberOnStripe(staffId, "acct_fake_audra");
    const first = await cardSale(shop.id, staffId, 1500);
    calls.length = 0;
    await m.checkout.refundEverything(first.saleId, "Unhappy client", false, actor);
    expect(calls.some((c) => c.params.transfer === first.tipRows[0].stripeTransferId)).toBe(false);
    const [loss] = await lossesOf(first.pay.id);
    expect(loss).toMatchObject({ bearer: "shop", tipCents: 1500, cents: 1500 + first.pay.applicationFeeCents, recoveredCents: 0 });

    const second = await cardSale(shop.id, jamie, 0);
    const normal = second.pay.amountCents - second.pay.applicationFeeCents;
    expect(second.shopRow).toMatchObject({ amountCents: normal - 1500, status: "sent" });
    expect(second.moved).toEqual([expect.objectContaining({ params: expect.objectContaining({ amount: normal - 1500, source_transaction: second.pay.stripeChargeId }) })]);
    expect((await lossById(loss.id)).recoveredCents).toBe(1500);
    expect(await recoveriesOf(loss.id)).toEqual([expect.objectContaining({ transferId: second.shopRow!.id, cents: 1500 })]);

    await m.checkout.refundEverything(second.saleId, "Unhappy client", false, actor);
    expect((await lossById(loss.id)).recoveredCents).toBe(0);
    expect((await recoveriesOf(loss.id)).map((r) => r.cents)).toEqual([1500, -1500]);
    // Only the fee of the second sale is a new loss; the 1500 is the shop's again.
    expect(await lossesOf(second.pay.id)).toEqual([expect.objectContaining({ cents: second.pay.applicationFeeCents, tipCents: 0, bearer: "platform" })]);

    const third = await cardSale(shop.id, jamie, 0);
    expect(third.shopRow!.amountCents).toBe(third.pay.amountCents - third.pay.applicationFeeCents - 1500);
    expect((await lossById(loss.id)).recoveredCents).toBe(1500);
    const refused = (q: Promise<unknown>) => q.then(() => "", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(await refused(m.db.db.insert(s().platformLossRecoveries).values({ lossId: loss.id, transferId: first.tipRows[0].id, cents: 1 }))).toMatch(/tip transfer is never taken back/);
  });

  it("the platform (the default): the tip part is logged as the platform's loss and nothing is taken from the shop later", async () => {
    await overflowSetting("platform", "le-claire");
    const { shop, staffId } = await setup("le-claire", "Em");
    await barberOnStripe(staffId, "acct_fake_em");
    const first = await cardSale(shop.id, staffId, 1200);
    await m.checkout.refundEverything(first.saleId, "Unhappy client", false, actor);
    expect(await lossesOf(first.pay.id)).toEqual([expect.objectContaining({ bearer: "platform", tipCents: 1200, recoveredCents: 0 })]);
    const jamie = (await setup("le-claire", "Jamie")).staffId;
    const next = await cardSale(shop.id, jamie, 0);
    expect(next.shopRow!.amountCents).toBe(next.pay.amountCents - next.pay.applicationFeeCents);
  });

  it("a shop on the brand's account: the sale's portion is on the platform already, and only the part of a refund past it (a tip with the barber) is a loss, always the platform's", async () => {
    await overflowSetting("shop", "silvis");
    const { shop, staffId } = await setup("silvis", "Abigail");
    await m.db.db.update(s().shops).set({ paymentsMode: "brand" }).where(eq(s().shops.id, shop.id));
    onTestFinished(async () => void (await m.db.db.update(s().shops).set({ paymentsMode: "connected" }).where(eq(s().shops.id, shop.id))));
    await barberOnStripe(staffId, "acct_fake_abigail");
    const { saleId, pay, shopRow, tipRows } = await cardSale(shop.id, staffId, 800);
    expect(shopRow).toBeUndefined();
    expect(tipRows).toEqual([expect.objectContaining({ amountCents: 800, status: "sent", idempotencyKey: `${saleId}:tip` })]);
    await m.checkout.refundSale({ saleId, items: [], tipCents: 500, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    expect(await lossesOf(pay.id)).toEqual([]);
    await m.checkout.refundEverything(saleId, "Unhappy client", false, actor);
    expect(await lossesOf(pay.id)).toEqual([expect.objectContaining({ kind: "refund", cents: 800, tipCents: 800, bearer: "platform" })]);
    expect(await transferRow(tipRows[0].id)).toMatchObject({ status: "sent", amountCents: 800, reversedCents: 0 });
  });
});

describe("retries and the database's own guard", () => {
  it("a transfer Stripe refused is retried by the cron; a refund meanwhile waits for it, then reverses it", async () => {
    const { shop, staffId } = await setup("utica", "Kate");
    failTransfers = 1;
    const { saleId, shopRow } = await cardSale(shop.id, staffId, 0);
    expect(shopRow).toMatchObject({ status: "pending", attempts: 1, stripeTransferId: null });
    expect(shopRow!.lastError).toMatch(/down in the test/);
    // The refund's own settle tries the transfer again (and Stripe refuses again), so the reversal waits.
    failTransfers = 1;
    await m.checkout.refundSale({ saleId, items: [], tipCents: 0, refundCardFee: true, reason: "Fee waived after", restock: false, actor });
    expect(await transferRow(shopRow!.id)).toMatchObject({ status: "pending", attempts: 2 });
    const [waiting] = await reversalsOf(shopRow!.paymentId);
    expect(waiting).toMatchObject({ status: "pending", kind: "refund" });
    calls.length = 0;
    await settlement.settlementCron();
    expect(await transferRow(shopRow!.id)).toMatchObject({ status: "sent", attempts: 3 });
    expect(calls.map((c) => c.op)).toEqual(["transfer", "reversal"]);
    expect((await reversalsOf(shopRow!.paymentId))[0]).toMatchObject({ status: "sent", amountCents: waiting.amountCents });
  });

  it("a row planned before the {saleId} keys (core_0137) retries with the key it was first sent with, so it can't move twice", async () => {
    const { shop, staffId } = await setup("utica", "Lindsay");
    failTransfers = 1;
    const { shopRow } = await cardSale(shop.id, staffId, 0);
    expect(shopRow).toMatchObject({ status: "pending", attempts: 1 });
    await m.db.db.update(s().paymentTransfers).set({ idempotencyKey: null }).where(eq(s().paymentTransfers.id, shopRow!.id));
    calls.length = 0;
    await settlement.settlementCron();
    expect(calls).toEqual([expect.objectContaining({ op: "transfer", opts: { idempotencyKey: `sale-transfer-${shopRow!.id}` } })]);
  });

  it("a transfer that never went is lowered instead of reversed (netted)", async () => {
    const { shop, staffId } = await setup("rock-island", "Mercedez");
    failTransfers = 99;
    const { saleId, shopRow } = await cardSale(shop.id, staffId, 0);
    for (let i = 0; i < 4; i++) await settlement.settlementCron();
    expect(await transferRow(shopRow!.id)).toMatchObject({ status: "failed", attempts: 5 });
    failTransfers = 0;
    calls.length = 0;
    await m.checkout.refundSale({ saleId, items: [], tipCents: 0, refundCardFee: true, reason: "Fee waived after", restock: false, actor });
    const [r] = await reversalsOf(shopRow!.paymentId);
    expect(r).toMatchObject({ status: "netted", stripeId: null });
    expect((await transferRow(shopRow!.id)).amountCents).toBe(shopRow!.amountCents - r.amountCents);
    expect(calls).toEqual([]);
  });

  it("refuses a reversal of a tip transfer, and a tip transfer can't be changed", async () => {
    const { shop, staffId } = await setup("kimberly", "Sammie");
    await barberOnStripe(staffId, "acct_fake_sammie");
    const { pay, tipRows } = await cardSale(shop.id, staffId, 900);
    const refused = (q: Promise<unknown>) => q.then(() => "", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(await refused(m.db.db.insert(s().paymentTransferReversals).values({ transferId: tipRows[0].id, paymentId: pay.id, kind: "dispute", stripeDisputeId: "dp_never", amountCents: 900 }))).toMatch(
      /tip transfer is never reversed/,
    );
    expect(await refused(m.db.db.update(s().paymentTransfers).set({ amountCents: 1 }).where(eq(s().paymentTransfers.id, tipRows[0].id)))).toMatch(/can't be changed/);
    await expect(m.db.db.update(s().paymentTransfers).set({ reversedCents: 100 }).where(eq(s().paymentTransfers.id, tipRows[0].id))).rejects.toThrow();
  });
});
