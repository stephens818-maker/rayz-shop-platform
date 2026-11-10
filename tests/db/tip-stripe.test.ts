/**
 * Employees' Stripe tip payouts against a stand-in Stripe client that records every call: test mode
 * only; with no transfer path, approved payouts are held as owed and nothing moves; a transfer path is
 * asked for exactly what reaches the employee and what it costs the shop, and unwinds a failed payout;
 * the platform transfer path (ST-C11) moves tips for brand-settled shops; a connected shop's own
 * tips are never a Stripe payout; and the Connect webhooks keep each bank account and card with its
 * last 4 only. FEATURE_TIP_TO_BARBER is on here, and the shops whose cash tips are paid by Stripe are
 * on the brand's account, since a connected shop keeps its own cash (I10).
 */
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { CONSENT_HOLD_REASON, TIP_DEPOSIT_CONSENT_TEXT, TIP_DEPOSIT_CONSENT_VERSION } from "@/domain/tip-deposit-consent";
import { Mods, actor, agreeToStripeDeposits, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

type Call = { op: string; params: Record<string, unknown>; opts: Record<string, unknown> | undefined; id?: string };
const calls: Call[] = [];
let n = 0;
const record = (op: string, prefix: string) => async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
  const id = `${prefix}_fake_${++n}`;
  calls.push({ op, params, opts, id });
  return { id, url: "https://connect.stripe.com/setup/e/acct_fake/test", client_secret: `${id}_secret_fake`, expires_at: Math.floor(Date.now() / 1000) + 1800 };
};
const fake = {
  charges: { create: record("debit", "py") },
  transfers: {
    create: record("transfer", "tr"),
    createReversal: async (id: string, params: Record<string, unknown>, opts?: Record<string, unknown>) => (calls.push({ op: "reversal", params: { id, ...params }, opts }), { id: `trr_fake_${++n}` }),
  },
  payouts: { create: record("payout", "po") },
  refunds: { create: record("refund", "re") },
  accounts: {
    create: record("account", "acct"),
    update: async (id: string, params: Record<string, unknown>) => (calls.push({ op: "account_update", params: { id, ...params }, opts: undefined }), { id }),
    retrieve: async () => {
      throw new Error("offline in the test");
    },
    createLoginLink: async () => ({ url: "https://connect.stripe.com/express/fake" }),
  },
  accountLinks: { create: record("account_link", "link") },
  accountSessions: { create: record("account_session", "accs") },
};
const fakeStripe = (on: boolean) => ((globalThis as { __fakeStripe?: unknown }).__fakeStripe = on ? fake : undefined);
const STRIPE_MONEY = ["debit", "transfer", "payout", "refund", "reversal"];

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let mm: typeof import("@/server/payments/money-movement");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  mm = await import("@/server/payments/money-movement");
  connectWebhook = await import("@/server/payments/connect-webhook");
  today = m.time.todayLocal();
  // Batches by hand here, so a test's tips aren't swept into a scheduled batch.
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  // Each test picks its transfer path; the platform's is the default outside tests.
  mm.registerMoneyMovement(null);
  await setModes("brand");
}, 180_000);

afterEach(() => {
  fakeStripe(false);
  mm.registerMoneyMovement(null);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.MONEY_MOVEMENT_LIVE;
});

afterAll(async () => {
  if (m) await setModes("connected");
  await m?.db.closeDb();
});

const BRAND_SETTLED = ["moline", "silvis", "utica"];
const setModes = (mode: "brand" | "connected") => m.db.db.update(m.schema.shops).set({ paymentsMode: mode }).where(m.drizzle.inArray(m.schema.shops.slug, BRAND_SETTLED));

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };

type TipTransfer = import("@/server/payments/money-movement").TipTransfer;
type MovedIds = import("@/server/payments/money-movement").MovedIds;

/** A stand-in transfer path: records what it's asked to move and unwind; fails partway when told to. */
function movement(o: { failWith?: string } = {}) {
  const sent: TipTransfer[] = [];
  const unwound: { key: string; ids: MovedIds; transferReversed?: boolean }[] = [];
  const impl: import("@/server/payments/money-movement").MoneyMovement = {
    name: "fake",
    async send(t, save) {
      sent.push(t);
      const k = ++n;
      const ids: MovedIds = { debitId: `py_mm_${k}`, transferId: `tr_mm_${k}`, payoutId: null };
      if (o.failWith) {
        await save({ ...ids });
        throw new mm.MovementError(o.failWith, { ...ids });
      }
      ids.payoutId = `po_mm_${k}`;
      await save(ids);
      return ids;
    },
    async unwind(u) {
      unwound.push({ key: u.key, ids: u.ids, transferReversed: u.transferReversed });
      return { ok: true, errors: [] };
    },
  };
  mm.registerMoneyMovement(impl);
  return { sent, unwound };
}

async function person(slug: string, label: string) {
  const sh = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
  const [p] = await m.db.db
    .select({ id: s().staff.id })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, sh.id), eq(s().staff.displayLabel, label)));
  return { shop: sh, staffId: p.id };
}

async function tipSale(shopId: string, staffId: string, tipCents: number) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: cash, actor });
}

const BANK = { id: "ba_fake_bank", type: "bank_account" as const, name: "STRIPE TEST BANK", last4: "6789", default: true, instant: false };
const CARD = { id: "card_fake_debit", type: "card" as const, name: "Visa", last4: "5556", default: false, instant: true };

/** A real (not simulator) recipient account for the employee, active, agreed to Stripe deposits, with a bank as the default and a debit card for instant payouts; instant with Stripe's fee accepted. */
async function readyOnStripe(staffId: string, acct: string, instant: boolean) {
  const row = {
    method: "stripe" as const,
    instant,
    instantFeeTerms: instant ? accounts.currentInstantFeeTerms() : null,
    instantFeeAcceptedAt: instant ? new Date() : null,
    stripeAccountId: acct,
    simulated: false,
    payoutsEnabled: true,
    detailsSubmitted: true,
    transfersCapability: "active",
    feesPayer: "application",
    instantEligible: true,
    destinationType: "bank_account" as const,
    destinationLast4: "6789",
    destinationName: "STRIPE TEST BANK",
    externalAccounts: [BANK, CARD],
    depositConsentVersion: TIP_DEPOSIT_CONSENT_VERSION,
    depositConsentAt: new Date(),
  };
  await m.db.db.insert(s().staffPayoutAccounts).values({ staffId, ...row }).onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: row });
}

async function setPolicy(p: Partial<import("@/domain/tips").BrandTipPolicy>) {
  const [b] = await m.db.db.select({ t: s().brandSettings.tipPayouts }).from(s().brandSettings);
  await m.db.db.update(s().brandSettings).set({ tipPayouts: { ...(b?.t as object), ...p } });
}

const payoutRow = async (id: string) => (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, id) }))!;

async function payOne(shopId: string, staffId: string, tipCents: number) {
  await tipSale(shopId, staffId, tipCents);
  const r = await tp.buildBatch({ shopId, kind: "manual", cutoff: today, actor });
  const draft = (await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId))))[0];
  calls.length = 0;
  fakeStripe(true);
  await tp.approveBatch(r.batchId, actor);
  return { draft, sent: await payoutRow(draft.id), batchId: r.batchId, stripeMoney: calls.filter((c) => STRIPE_MONEY.includes(c.op)) };
}

describe("test mode only", () => {
  it("live keys are refused for employee accounts and onboarding, and Stripe payouts are held as owed, unless MONEY_MOVEMENT_LIVE is on", async () => {
    const { shop, staffId } = await person("moline", "Jen");
    await tipSale(shop.id, staffId, 1200);
    fakeStripe(true);
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    expect(mm.moneyMovementReady()).toBe(false);
    expect(() => mm.moneyClient()).toThrow(/test mode only/);
    await expect(accounts.staffOnboardingUrl(staffId, actor, "http://localhost")).rejects.toThrow(/test mode only/);
    await expect(accounts.staffAccountSession(staffId, actor)).rejects.toThrow(/test mode only/);

    await readyOnStripe(staffId, "acct_fake_jen", false);
    const { sent: moved } = movement();
    calls.length = 0;
    const r = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [held] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(held).toMatchObject({ method: "stripe", status: "held", holdKind: "transfers_pending", holdReason: mm.LIVE_SWITCH_REASON });
    await tp.approveBatch(r.batchId, actor);
    expect(moved).toEqual([]);
    expect(calls.filter((c) => STRIPE_MONEY.includes(c.op))).toEqual([]);
    await expect(tp.releasePayout(held.id, actor)).rejects.toThrow(/tested end to end/);

    process.env.MONEY_MOVEMENT_LIVE = "true";
    expect(mm.moneyMovementReady()).toBe(true);
    expect(mm.moneyClient()).toBe(fake);
    process.env.STRIPE_SECRET_KEY = "sk_test_fine";
    delete process.env.MONEY_MOVEMENT_LIVE;
    expect(mm.moneyClient()).toBe(fake);
  });
});

describe("the money-movement module, with a stand-in transfer path", () => {
  it("with no transfer path registered, an approved Stripe payout is held as owed, nothing moves, and it can't be released until one is", async () => {
    const { shop, staffId } = await person("moline", "Sara");
    await readyOnStripe(staffId, "acct_fake_sara_owed", false);
    fakeStripe(true);
    expect(mm.directPayoutsAvailable()).toBe(false);
    const { sent, stripeMoney } = await payOne(shop.id, staffId, 1300);
    expect(stripeMoney).toEqual([]);
    expect(sent).toMatchObject({ status: "held", holdKind: "transfers_pending", holdReason: mm.TRANSFERS_PENDING_REASON, stripeTransferId: null, stripeDebitId: null, stripePayoutId: null });
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, sent.id))).not.toEqual([]);
    await expect(tp.releasePayout(sent.id, actor)).rejects.toThrow(/aren't switched on in this deployment/);
    expect((await payoutRow(sent.id)).status).toBe("held");

    const { sent: moved } = movement();
    expect(mm.directPayoutsAvailable()).toBe(true);
    await tp.releasePayout(sent.id, actor);
    expect(await payoutRow(sent.id)).toMatchObject({ status: "processing", holdKind: null, stripeTransferId: expect.stringMatching(/^tr_mm_/), stripePayoutId: expect.stringMatching(/^po_mm_/) });
    expect(moved).toHaveLength(1);
    expect(calls.filter((c) => STRIPE_MONEY.includes(c.op))).toEqual([]);
    const [audit] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.stripe_sent"), eq(s().auditLog.entityId, sent.id)));
    expect(audit.details).toMatchObject({ via: "fake", amountCents: 1300 });
  });

  it("an instant payout, fee passed on: the employee receives net − fee to the debit card, and the shop's cost is the net", async () => {
    const { shop, staffId } = await person("moline", "Jilane");
    await setPolicy({ instantAllowed: true, instantFeePassedOn: true });
    await readyOnStripe(staffId, "acct_fake_jilane", true);
    const { sent: moved } = movement();
    const { draft, sent } = await payOne(shop.id, staffId, 2500);
    expect(draft).toMatchObject({ method: "stripe", instant: true, netCents: 2500, instantFeeCents: 50, instantFeePaidBy: "employee" });
    expect(moved).toEqual([
      {
        key: `tip-${draft.id}`,
        shopId: shop.id,
        amountCents: 2450,
        prefundedCents: 0,
        shopCostCents: 2500,
        to: "acct_fake_jilane",
        group: `tips-${draft.batchId}`,
        description: `Tip payout ${draft.id}`,
        metadata: { tipPayoutId: draft.id, shopId: shop.id, staffId },
        payout: { method: "instant", destination: "card_fake_debit", statementDescriptor: "RAYZ TIPS" },
      },
    ]);
    expect(sent).toMatchObject({ status: "processing", failureMessage: null, stripeDebitId: expect.stringMatching(/^py_mm_/), destinationType: "card", destinationLast4: "5556" });
    const k = sent.stripeDebitId!.slice("py_mm_".length);
    expect([sent.stripeTransferId, sent.stripePayoutId]).toEqual([`tr_mm_${k}`, `po_mm_${k}`]);
    expect(sent.sentAt).not.toBeNull();

    const secret = "whsec_test_tip_stripe";
    const payload = JSON.stringify({ id: "evt_po_paid", object: "event", type: "payout.paid", account: "acct_fake_jilane", data: { object: { id: sent.stripePayoutId, object: "payout", status: "paid", metadata: { tipPayoutId: draft.id } } } });
    expect((await connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret)).status).toBe(200);
    expect((await payoutRow(draft.id)).status).toBe("paid");
  });

  it("instant payouts stay off until the employee accepts Stripe's fee as shown (ST-I12)", async () => {
    const { shop, staffId } = await person("moline", "Mackenzie");
    await setPolicy({ instantAllowed: true });
    await readyOnStripe(staffId, "acct_fake_mackenzie_ack", false);
    await m.db.db.update(s().staffPayoutAccounts).set({ instant: true }).where(eq(s().staffPayoutAccounts.staffId, staffId));
    movement();
    const { draft } = await payOne(shop.id, staffId, 1000);
    expect(draft).toMatchObject({ instant: false, instantFeeCents: 0 });
    await expect(accounts.setPayoutChoice(staffId, { method: "stripe", instant: true, acceptInstantFee: "something else" }, actor)).rejects.toThrow(/Accept the fee/);
    await accounts.setPayoutChoice(staffId, { method: "stripe", instant: true, acceptInstantFee: accounts.currentInstantFeeTerms() }, actor);
    const [audit] = (await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.method"), eq(s().auditLog.entityId, staffId)))).slice(-1);
    expect(audit.details).toMatchObject({ instant: true, instantFeeAccepted: accounts.currentInstantFeeTerms() });
  });

  it("the brand absorbs the fee: the employee gets the whole net instantly and the shop's cost is net + fee; a standard payout goes to the default bank with no fee", async () => {
    const { shop, staffId } = await person("moline", "Mackenzie");
    await setPolicy({ instantAllowed: true, instantFeePassedOn: false });
    await readyOnStripe(staffId, "acct_fake_mackenzie", true);
    await m.db.db.update(s().staff).set({ email: "mackenzie.tips@rayz.test" }).where(eq(s().staff.id, staffId));
    const { sent: moved } = movement();
    const { draft } = await payOne(shop.id, staffId, 4000);
    expect(draft).toMatchObject({ instant: true, netCents: 4000, instantFeeCents: 60, instantFeePaidBy: "shop" });
    expect(moved.map((t) => [t.amountCents, t.shopCostCents, t.payout.method, t.payout.destination])).toEqual([[4000, 4060, "instant", "card_fake_debit"]]);
    const [note] = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.to, "mackenzie.tips@rayz.test")));
    expect(note.subject).toBe("Tip payout: $40.00");
    expect(note.body).toMatch(/to your debit card ••5556 \(instant\)\. The shop paid Stripe's instant payout fee\./);

    await accounts.setPayoutChoice(staffId, { method: "stripe", instant: false }, actor);
    const std = await payOne(shop.id, staffId, 1500);
    expect(std.draft).toMatchObject({ instant: false, instantFeeCents: 0 });
    expect(moved.slice(1).map((t) => [t.amountCents, t.shopCostCents, t.payout.method, t.payout.destination])).toEqual([[1500, 1500, "standard", null]]);
    expect(std.sent).toMatchObject({ destinationType: "bank_account", destinationLast4: "6789" });
    await setPolicy({ instantAllowed: false, instantFeePassedOn: true });
  });

  it("a move that stops partway fails the payout, unwinds what went through, and the tips go back for the next batch", async () => {
    const { shop, staffId } = await person("moline", "Jilane");
    await readyOnStripe(staffId, "acct_fake_jilane", false);
    const { unwound } = movement({ failWith: "Your card doesn't support instant payouts" });
    const { draft, sent } = await payOne(shop.id, staffId, 700);
    expect(sent).toMatchObject({ status: "failed", failureMessage: "Stripe: Your card doesn't support instant payouts", stripeDebitId: expect.stringMatching(/^py_mm_/), stripeTransferId: expect.stringMatching(/^tr_mm_/) });
    expect(unwound).toEqual([{ key: `tip-${draft.id}`, ids: { debitId: sent.stripeDebitId, transferId: sent.stripeTransferId, payoutId: null }, transferReversed: undefined }]);
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, draft.id))).toEqual([]);

    mm.registerMoneyMovement(null);
    const again = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [back] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, again.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(back.netCents).toBe(700);
    await tp.cancelBatch(again.batchId, "Test over", actor);
  });
});

describe("the platform transfer path (ST-C11, separate charges and transfers)", () => {
  const usePlatform = () => mm.registerMoneyMovement(mm.platformTipTransfers);
  const setMode = (shopId: string, mode: "brand" | "connected") => m.db.db.update(s().shops).set({ paymentsMode: mode }).where(eq(s().shops.id, shopId));

  it("a brand-settled shop: a transfer from the platform balance to the employee's account, then their payout, each idempotent on the payout's id, with no account debit", async () => {
    const { shop, staffId } = await person("silvis", "Abigail");
    await readyOnStripe(staffId, "acct_fake_abigail", false);
    usePlatform();
    const { draft, sent, stripeMoney } = await payOne(shop.id, staffId, 1800);
    expect(stripeMoney.map((c) => c.op)).toEqual(["transfer", "payout"]);
    const [tr, po] = stripeMoney;
    expect(tr.params).toMatchObject({ amount: 1800, currency: "usd", destination: "acct_fake_abigail", transfer_group: `tips-${draft.batchId}`, metadata: { tipPayoutId: draft.id } });
    expect(tr.params).not.toHaveProperty("source_transaction");
    expect(tr.opts).toEqual({ idempotencyKey: `tip-${draft.id}-transfer` });
    expect(po.params).toMatchObject({ amount: 1800, currency: "usd", method: "standard", statement_descriptor: "RAYZ TIPS" });
    expect(po.opts).toEqual({ stripeAccount: "acct_fake_abigail", idempotencyKey: `tip-${draft.id}-payout` });
    expect(sent).toMatchObject({ status: "processing", stripeDebitId: null, stripeTransferId: tr.id, stripePayoutId: po.id });
    const [audit] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.stripe_sent"), eq(s().auditLog.entityId, draft.id)));
    expect(audit.details).toMatchObject({ via: "platform_transfers", amountCents: 1800 });
  });

  it("a shop on its own Stripe account keeps its cash tips, so they're never a Stripe payout: they go on the paycheck", async () => {
    const { shop, staffId } = await person("moline", "Kat");
    await setMode(shop.id, "connected");
    onTestFinished(async () => void (await setMode(shop.id, "brand")));
    await readyOnStripe(staffId, "acct_fake_kat_connected", false);
    usePlatform();
    expect(mm.directPayoutsAvailable()).toBe(true);
    await tipSale(shop.id, staffId, 900);
    calls.length = 0;
    fakeStripe(true);
    const r = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    expect(await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId)))).toEqual([]);
    await tp.approveBatch(r.batchId, actor);
    expect(calls.filter((c) => STRIPE_MONEY.includes(c.op))).toEqual([]);
    const split = (await tp.payrollTipSplit([shop.id], today, today)).get(`${staffId}|${shop.id}`)!;
    expect(split.inPayrollCents).toBeGreaterThanOrEqual(900);
  });

  it("live keys without MONEY_MOVEMENT_LIVE: direct payouts are off and holds say it waits for the CPA's sign-off", async () => {
    usePlatform();
    fakeStripe(true);
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    expect(mm.directPayoutsAvailable()).toBe(false);
    expect(mm.transfersPendingReason()).toBe(mm.LIVE_SWITCH_REASON);
    process.env.MONEY_MOVEMENT_LIVE = "true";
    expect(mm.directPayoutsAvailable()).toBe(true);
  });

  it("a payout Stripe refuses after the transfer: the payout fails, the transfer is reversed once, and the tips go back for the next batch", async () => {
    const { shop, staffId } = await person("silvis", "Abigail");
    await readyOnStripe(staffId, "acct_fake_abigail_fail", false);
    usePlatform();
    const ok = fake.payouts.create;
    fake.payouts.create = async () => {
      throw new Error("Insufficient funds in Stripe account");
    };
    onTestFinished(() => void (fake.payouts.create = ok));
    const { draft, sent, stripeMoney } = await payOne(shop.id, staffId, 600);
    expect(sent).toMatchObject({ status: "failed", failureMessage: "Stripe: Insufficient funds in Stripe account", stripeTransferId: expect.stringMatching(/^tr_fake_/), stripePayoutId: null });
    expect(stripeMoney.map((c) => c.op)).toEqual(["transfer", "reversal"]);
    const reversals = calls.filter((c) => c.op === "reversal");
    expect(reversals).toEqual([{ op: "reversal", params: { id: sent.stripeTransferId, metadata: { tipPayoutId: draft.id } }, opts: { idempotencyKey: `tip-${draft.id}-reverse` } }]);
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, draft.id))).toEqual([]);
    expect(await tp.markFailed(draft.id, "again")).toBeNull();
    expect(calls.filter((c) => c.op === "reversal")).toHaveLength(1);
  });

  it("a transfer Stripe already reversed isn't reversed again", async () => {
    fakeStripe(true);
    calls.length = 0;
    const r = await mm.platformTipTransfers.unwind({ key: "tip-x", ids: { debitId: null, transferId: "tr_already", payoutId: null }, transferReversed: true, metadata: {} });
    expect(r).toEqual({ ok: true, errors: [] });
    expect(calls).toEqual([]);
  });
});

describe("Connect webhooks for employees' accounts", () => {
  const secret = "whsec_test_tip_stripe";
  const event = (type: string, object: object, account: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account, data: { object } });
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };

  it("account.updated keeps every bank account and card with its id, type, name and last 4 only; instant payouts go to the debit card; payout.failed releases the tips and unwinds", async () => {
    const { shop, staffId } = await person("utica", "Kate");
    const acct = "acct_fake_kate";
    await m.db.db
      .insert(s().staffPayoutAccounts)
      .values({ staffId, method: "stripe", instant: true, stripeAccountId: acct, simulated: false })
      .onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: { method: "stripe", instant: true, stripeAccountId: acct, simulated: false } });
    await agreeToStripeDeposits(staffId);
    fakeStripe(true);
    const res = await event(
      "account.updated",
      {
        id: acct,
        object: "account",
        payouts_enabled: true,
        details_submitted: true,
        capabilities: { transfers: "active" },
        controller: { stripe_dashboard: { type: "none" }, fees: { payer: "application" } },
        tos_acceptance: { service_agreement: "recipient" },
        requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null, current_deadline: null },
        external_accounts: {
          object: "list",
          data: [
            { id: "ba_fake_kate", object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789", routing_number: "110000000", account_holder_name: "Kate Test", fingerprint: "fp_bank_secret", default_for_currency: true, available_payout_methods: ["standard"] },
            { id: "card_fake_kate", object: "card", brand: "Visa", last4: "5556", funding: "debit", exp_month: 12, exp_year: 2030, fingerprint: "fp_card_secret", default_for_currency: false, available_payout_methods: ["standard", "instant"] },
          ],
        },
      },
      acct,
    );
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.op === "account_update")?.params).toMatchObject({ id: acct, metadata: { staffId, ...accounts.W2_METADATA } });
    const a = (await accounts.staffAccount(staffId))!;
    expect(a.w2TaggedAt).toBeNull();
    expect(accounts.staffAccountStatus(a)).toBe("active");
    expect(a).toMatchObject({ dashboard: "none", serviceAgreement: "recipient", transfersCapability: "active" });
    expect(a.externalAccounts).toEqual([
      { id: "ba_fake_kate", type: "bank_account", name: "STRIPE TEST BANK", last4: "6789", default: true, instant: false },
      { id: "card_fake_kate", type: "card", name: "Visa", last4: "5556", default: false, instant: true },
    ]);
    expect(a).toMatchObject({ destinationType: "bank_account", destinationLast4: "6789", instantEligible: true });
    expect(JSON.stringify(a)).not.toMatch(/110000000|fp_|Kate Test|2030/);
    expect(accounts.externalAccountsView(a).find((x) => x.instantDestination)).toMatchObject({ id: "card_fake_kate", label: "Visa card ••5556" });

    await event("account.external_account.deleted", { id: "card_fake_kate", object: "card", account: acct, brand: "Visa", last4: "5556", default_for_currency: false }, acct);
    const gone = (await accounts.staffAccount(staffId))!;
    expect(gone.externalAccounts.map((x) => x.id)).toEqual(["ba_fake_kate"]);
    expect(gone.instantEligible).toBe(false);

    const { sent: moved, unwound } = movement();
    await tipSale(shop.id, staffId, 800);
    const r = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [p] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(p.instant).toBe(false);
    await tp.approveBatch(r.batchId, actor);
    expect(moved.find((t) => t.metadata.tipPayoutId === p.id)).toMatchObject({ amountCents: 800, payout: { method: "standard", destination: null } });
    const out = await payoutRow(p.id);

    await event("payout.failed", { id: out.stripePayoutId, object: "payout", status: "failed", failure_message: "Account closed", metadata: { tipPayoutId: p.id } }, acct);
    expect(await payoutRow(p.id)).toMatchObject({ status: "failed", failureMessage: "Payout failed: Account closed" });
    expect(unwound.filter((u) => u.key === `tip-${p.id}`).map((u) => u.ids.transferId)).toEqual([out.stripeTransferId]);
  });
});

describe("recipient accounts and no 1099s for employees (their tips are W-2 wages)", () => {
  const secret = "whsec_test_tip_stripe";
  const event = (type: string, object: object, account: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account, data: { object } });
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };

  it("every account is a recipient account with no Stripe Dashboard and only the transfers capability, Ray'z paying its fees, tagged as a W-2 employee's; set up embedded with an Account Session or on Stripe's page", async () => {
    const { staffId } = await person("rock-island", "Garrett");
    fakeStripe(true);
    calls.length = 0;
    const session = (await accounts.staffAccountSession(staffId, actor))!;
    const made = calls.find((c) => c.op === "account")!;
    expect(made.params).toMatchObject({
      controller: { fees: { payer: "application" }, losses: { payments: "application" }, stripe_dashboard: { type: "none" }, requirement_collection: "stripe" },
      capabilities: { transfers: { requested: true } },
      tos_acceptance: { service_agreement: "recipient" },
      metadata: { staffId, ...accounts.W2_METADATA },
    });
    expect(made.params.capabilities).not.toHaveProperty("card_payments");
    const sess = calls.find((c) => c.op === "account_session")!;
    expect(sess.params).toMatchObject({ account: made.id, components: { account_onboarding: { enabled: true }, account_management: { enabled: true }, notification_banner: { enabled: true } } });
    expect(session).toMatchObject({ accountId: made.id, clientSecret: expect.stringContaining("_secret_") });
    const a = (await accounts.staffAccount(staffId))!;
    expect(a).toMatchObject({ stripeAccountId: made.id, simulated: false, feesPayer: "application", dashboard: "none", serviceAgreement: "recipient", taxForms: "will_not_file" });
    expect(JSON.stringify(a)).not.toContain(session.clientSecret);
    expect(a.w2TaggedAt).not.toBeNull();
    expect(accounts.issues1099K(a)).toBe(false);

    calls.length = 0;
    const url = await accounts.staffOnboardingUrl(staffId, actor, "https://rayz.test", "app");
    expect(url).toMatch(/^https:\/\//);
    expect(calls.filter((c) => c.op === "account")).toEqual([]);
    expect(calls.find((c) => c.op === "account_link")!.params).toMatchObject({
      account: made.id,
      type: "account_onboarding",
      return_url: `https://rayz.test${accounts.STRIPE_RETURN_PAGE}`,
      refresh_url: `https://rayz.test${accounts.STRIPE_REFRESH_PAGE}`,
    });
  });

  it("a brand setting saved as Express, full or hosted still makes a recipient account with no dashboard; barbers never get a Stripe login link", async () => {
    const [{ staffPayouts: was }] = await m.db.db.select({ staffPayouts: s().brandSettings.staffPayouts }).from(s().brandSettings);
    await m.db.db.update(s().brandSettings).set({ staffPayouts: { ...was, dashboard: "express", serviceAgreement: "full", onboarding: "hosted" } });
    onTestFinished(async () => void (await m.db.db.update(s().brandSettings).set({ staffPayouts: was })));
    const { staffId } = await person("rock-island", "Mercedez");
    fakeStripe(true);
    calls.length = 0;
    await accounts.ensureStaffAccount(staffId, actor);
    expect(calls.find((c) => c.op === "account")!.params).toMatchObject({ controller: { stripe_dashboard: { type: "none" } }, tos_acceptance: { service_agreement: "recipient" } });
    expect(accounts.staffAccountParams({ email: null }, staffId)).toMatchObject({ controller: { stripe_dashboard: { type: "none" }, fees: { payer: "application" } } });
    expect(accounts).not.toHaveProperty("staffDashboardUrl");

    const ctx = { staff: { id: staffId }, actor } as unknown as Parameters<typeof import("@/server/staff-api/money").dashboardLink>[0];
    const money = await import("@/server/staff-api/money");
    await expect(money.dashboardLink(ctx)).rejects.toMatchObject({ code: "conflict", details: { reason: "no_stripe_dashboard" } });
    await m.db.db.update(s().staffPayoutAccounts).set({ detailsSubmitted: true }).where(eq(s().staffPayoutAccounts.staffId, staffId));
    await expect(money.dashboardLink(ctx)).rejects.toThrow(accounts.NO_STRIPE_DASHBOARD);
  });

  it("an account Stripe says pays its own fees has its payouts held, not sent; the Dashboard exclusions list every real account", async () => {
    const { shop, staffId } = await person("moline", "Sara");
    const acct = "acct_fake_sara";
    await readyOnStripe(staffId, acct, false);
    fakeStripe(true);
    calls.length = 0;
    const base = { id: acct, object: "account", payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null, current_deadline: null } };
    await event("account.updated", { ...base, controller: { fees: { payer: "account" } }, metadata: { staffId, ...accounts.W2_METADATA } }, acct);
    expect((await accounts.staffAccount(staffId))!).toMatchObject({ feesPayer: "account" });
    expect(calls.filter((c) => c.op === "account_update")).toEqual([]);
    const [flagged] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.account_1099k"), eq(s().auditLog.entityId, staffId)));
    expect(flagged.details).toMatchObject({ stripeAccountId: acct, feesPayer: "account" });
    expect(await accounts.taxFormStatus()).toMatchObject({ feesOnAccount: 1 });

    const { sent: all } = movement();
    const moved = () => all.filter((t) => t.metadata.staffId === staffId);
    const { sent } = await payOne(shop.id, staffId, 1100);
    expect(moved()).toEqual([]);
    expect(sent).toMatchObject({ status: "held", holdKind: "manager", holdReason: accounts.TAX_FORMS_HOLD_REASON, stripeTransferId: null, stripeDebitId: null });
    expect(await m.db.db.select().from(s().tipPayoutPeriods).where(eq(s().tipPayoutPeriods.payoutId, sent.id))).toEqual([]);

    await event("account.updated", { ...base, controller: { fees: { payer: "application" } }, metadata: { staffId, ...accounts.W2_METADATA } }, acct);
    await tp.releasePayout(sent.id, actor);
    expect((await payoutRow(sent.id)).status).toBe("processing");
    expect(moved().map((t) => t.amountCents)).toEqual([1100]);

    const { csv, accounts: count } = await accounts.taxFormExclusionCsv();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("stripe_account_id,filing_requirement,postal_delivery");
    expect(lines).toContain(`${acct},NOT_REQUIRED,FALSE`);
    expect(lines.slice(1).every((l) => /^acct_[A-Za-z0-9_]+,NOT_REQUIRED,FALSE$/.test(l))).toBe(true);
    expect(count).toBe(lines.length - 1);
    expect(csv).not.toMatch(/sim_acct/);
  });
});

describe("recorded, revocable consent to Stripe tip deposits (ST-C17)", () => {
  it("nothing goes to Stripe without the employee's yes to today's wording; agreeing sends what waited, withdrawing holds what's unsent, and every change is kept", async () => {
    const { shop, staffId } = await person("utica", "Lindsay");
    const me = { staffId, label: "Lindsay" };
    await m.db.db.update(s().staff).set({ email: "lindsay.tips@rayz.test" }).where(eq(s().staff.id, staffId));
    await readyOnStripe(staffId, "acct_fake_lindsay", false);
    await m.db.db.update(s().staffPayoutAccounts).set({ depositConsentVersion: null, depositConsentAt: null }).where(eq(s().staffPayoutAccounts.staffId, staffId));
    expect(accounts.stripeReady(await accounts.staffAccount(staffId))).toBe(true);
    expect(accounts.canReceive(await accounts.staffAccount(staffId))).toBe(false);

    const { sent: all } = movement();
    const moved = () => all.filter((t) => t.metadata.staffId === staffId);
    const { draft, sent } = await payOne(shop.id, staffId, 1400);
    expect(draft).toMatchObject({ method: "stripe", status: "held", holdKind: "stripe_setup", holdReason: CONSENT_HOLD_REASON });
    expect(sent).toMatchObject({ status: "held", holdKind: "stripe_setup", stripeTransferId: null, stripeDebitId: null });
    expect(moved()).toEqual([]);
    await expect(tp.releasePayout(sent.id, actor)).rejects.toThrow(/haven't agreed to Stripe tip deposits/);

    // Only the employee, and only for the wording they were shown.
    await expect(accounts.setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "web" }, actor)).rejects.toThrow(/Only the employee/);
    await expect(accounts.setDepositConsent(staffId, { agree: true, version: "2020-01-01", source: "web" }, me)).rejects.toMatchObject({ code: "bad_request", details: { reason: "consent_version", version: TIP_DEPOSIT_CONSENT_VERSION } });
    expect(await accounts.setDepositConsent(staffId, { agree: false, source: "web" }, me)).toEqual({ changed: false });

    expect(await accounts.setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "staff_app" }, me)).toEqual({ changed: true });
    expect(await payoutRow(sent.id)).toMatchObject({ status: "processing", holdKind: null, holdReason: null, stripeTransferId: expect.stringMatching(/^tr_mm_/) });
    expect(moved().map((t) => t.amountCents)).toEqual([1400]);
    expect(await accounts.setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "web" }, me)).toEqual({ changed: false });

    // A payout built but not yet sent is held the moment they withdraw; the one already sent is left alone.
    await tipSale(shop.id, staffId, 600);
    const next = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [pending] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, next.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(pending).toMatchObject({ status: "pending", method: "stripe" });
    await accounts.setDepositConsent(staffId, { agree: false, source: "web" }, me);
    expect(await payoutRow(pending.id)).toMatchObject({ status: "held", holdKind: "stripe_setup", holdReason: CONSENT_HOLD_REASON });
    expect((await payoutRow(sent.id)).status).toBe("processing");
    expect((await tp.waitingForSetup([staffId])).get(staffId)).toEqual({ cents: 600, payouts: 1 });
    await tp.approveBatch(next.batchId, actor);
    expect(moved().map((t) => t.amountCents)).toEqual([1400]);

    const view = await accounts.depositConsentView(staffId);
    expect(view).toMatchObject({ version: TIP_DEPOSIT_CONSENT_VERSION, text: TIP_DEPOSIT_CONSENT_TEXT, agreed: false, agreedAt: null, needsRenewal: false });
    expect(view.history.map((h) => [h.action, h.version, h.source])).toEqual([
      ["revoked", TIP_DEPOSIT_CONSENT_VERSION, "web"],
      ["granted", TIP_DEPOSIT_CONSENT_VERSION, "staff_app"],
    ]);
    const kept = await m.db.db.select().from(s().tipDepositConsents).where(eq(s().tipDepositConsents.staffId, staffId));
    expect(kept.every((k) => k.text === TIP_DEPOSIT_CONSENT_TEXT)).toBe(true);
    await expect(m.db.db.update(s().tipDepositConsents).set({ action: "granted" }).where(eq(s().tipDepositConsents.id, kept[0].id))).rejects.toThrow();
    await expect(m.db.db.delete(s().tipDepositConsents).where(eq(s().tipDepositConsents.id, kept[0].id))).rejects.toThrow();
    const trail = await m.db.db.select().from(s().auditLog).where(and(m.drizzle.inArray(s().auditLog.action, ["tips.deposit_consent", "tips.deposit_consent_withdrawn"]), eq(s().auditLog.entityId, staffId)));
    expect(trail.map((t) => t.action).sort()).toEqual(["tips.deposit_consent", "tips.deposit_consent_withdrawn"]);
    const notices = await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.to, "lindsay.tips@rayz.test")).orderBy(s().notificationJobs.createdAt);
    expect(notices.map((x) => x.subject).filter((x) => /Stripe tip deposits/.test(x ?? ""))).toEqual(["Security notice: you agreed to Stripe tip deposits", "Security notice: you withdrew from Stripe tip deposits"]);

    // Agreeing again sends what waited; a newer wording would need a fresh yes.
    await accounts.setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "web" }, me);
    expect((await payoutRow(pending.id)).status).toBe("processing");
    expect(moved().map((t) => t.amountCents)).toEqual([1400, 600]);
    await m.db.db.update(s().staffPayoutAccounts).set({ depositConsentVersion: "2020-01-01" }).where(eq(s().staffPayoutAccounts.staffId, staffId));
    expect(accounts.canReceive(await accounts.staffAccount(staffId))).toBe(false);
    expect(await accounts.depositConsentView(staffId)).toMatchObject({ agreed: false, needsRenewal: true });
    await expect(m.db.db.update(s().staffPayoutAccounts).set({ depositConsentAt: null }).where(eq(s().staffPayoutAccounts.staffId, staffId))).rejects.toThrow();
    await accounts.setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "web" }, me);
  });

  it("tips on the paycheck is offered only when the brand turns it on, off by default", async () => {
    const { staffId } = await person("utica", "Sarah");
    const [b] = await m.db.db.select({ v: s().brandSettings.staffPayouts }).from(s().brandSettings);
    const saved = (b?.v as Record<string, unknown>) ?? {};
    expect(saved.tipsOnPaycheck ?? false).toBe(false);
    await expect(accounts.setPayoutChoice(staffId, { method: "payroll", instant: false }, actor)).rejects.toThrow(/isn't offered yet/);
    await m.db.db.update(s().brandSettings).set({ staffPayouts: { ...saved, tipsOnPaycheck: true } });
    try {
      await accounts.setPayoutChoice(staffId, { method: "payroll", instant: false }, actor);
      expect((await accounts.staffAccount(staffId))!.method).toBe("payroll");
      await m.db.db.update(s().brandSettings).set({ staffPayouts: saved });
      // Someone already on payroll keeps it if the brand turns the option back off.
      await accounts.setPayoutChoice(staffId, { method: "payroll", instant: false }, actor);
      await accounts.setPayoutChoice(staffId, { method: "cash", instant: false }, actor);
      await expect(accounts.setPayoutChoice(staffId, { method: "payroll", instant: false }, actor)).rejects.toThrow(/isn't offered yet/);
    } finally {
      await m.db.db.update(s().brandSettings).set({ staffPayouts: saved });
    }
  });
});
