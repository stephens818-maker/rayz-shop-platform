/**
 * Employees' Stripe tip payouts against a stand-in Stripe client that records every call, with the
 * money-movement module kept abstract (ST-C11 pending): test mode only; no transfer path registered
 * means approved payouts are held as owed and nothing moves; a registered implementation is asked for
 * exactly what reaches the employee and what it costs the shop, and unwinds a failed payout; and the
 * Connect webhooks keep each bank account and card with its last 4 only.
 */
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

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
  transfers: { create: record("transfer", "tr") },
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
const STRIPE_MONEY = ["debit", "transfer", "payout", "refund"];

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
}, 180_000);

afterEach(() => {
  fakeStripe(false);
  mm.registerMoneyMovement(null);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.MONEY_MOVEMENT_LIVE;
});

afterAll(async () => {
  await m?.db.closeDb();
});

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

/** A real (not simulator) recipient account for the employee, active, with a bank as the default and a debit card for instant payouts; instant with Stripe's fee accepted. */
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
  it("live keys are refused for employee accounts, onboarding and approving Stripe payouts, unless MONEY_MOVEMENT_LIVE is on", async () => {
    const { shop, staffId } = await person("moline", "Jen");
    await tipSale(shop.id, staffId, 1200);
    fakeStripe(true);
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    expect(mm.moneyMovementReady()).toBe(false);
    expect(() => mm.moneyClient()).toThrow(/test mode only/);
    await expect(accounts.staffOnboardingUrl(staffId, actor, "http://localhost")).rejects.toThrow(/test mode only/);
    await expect(accounts.staffAccountSession(staffId, actor)).rejects.toThrow(/test mode only/);

    await readyOnStripe(staffId, "acct_fake_jen", false);
    movement();
    const r = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    await expect(tp.approveBatch(r.batchId, actor)).rejects.toThrow(/test mode only/);
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, r.batchId) }))!.status).toBe("draft");
    await tp.cancelBatch(r.batchId, "Test over", actor);

    process.env.MONEY_MOVEMENT_LIVE = "true";
    expect(mm.moneyMovementReady()).toBe(true);
    expect(mm.moneyClient()).toBe(fake);
    process.env.STRIPE_SECRET_KEY = "sk_test_fine";
    delete process.env.MONEY_MOVEMENT_LIVE;
    expect(mm.moneyClient()).toBe(fake);
  });
});

describe("the money-movement module stays abstract (ST-C11 pending)", () => {
  it("with no transfer path registered, an approved Stripe payout is held as owed, nothing moves, and it can't be released until one is", async () => {
    const { shop, staffId } = await person("moline", "Sara");
    await readyOnStripe(staffId, "acct_fake_sara_owed", false);
    fakeStripe(true);
    expect(mm.directPayoutsAvailable()).toBe(false);
    const { sent, stripeMoney } = await payOne(shop.id, staffId, 1300);
    expect(stripeMoney).toEqual([]);
    expect(sent).toMatchObject({ status: "held", holdKind: "transfers_pending", holdReason: mm.TRANSFERS_PENDING_REASON, stripeTransferId: null, stripeDebitId: null, stripePayoutId: null });
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, sent.id))).not.toEqual([]);
    await expect(tp.releasePayout(sent.id, actor)).rejects.toThrow(/aren't switched on yet/);
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
