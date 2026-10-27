/**
 * Employees' Stripe tip payouts through the money-movement module, against a stand-in Stripe client
 * that records every call: test mode only, the account debit from the shop's connected account, the
 * transfer and the payout (instant to the debit card), who pays the instant fee, unwinding a failed
 * payout, and the Connect webhooks keeping each bank account and card with its last 4 only.
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
let failPayout: string | null = null;
let n = 0;
const record = (op: string, prefix: string) => async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
  if (op === "payout" && failPayout) throw new Error(failPayout);
  const id = `${prefix}_fake_${++n}`;
  calls.push({ op, params, opts, id });
  return { id, url: "https://connect.stripe.com/setup/e/acct_fake/test" };
};
const fake = {
  charges: { create: record("debit", "py") },
  transfers: {
    create: record("transfer", "tr"),
    createReversal: async (id: string, params: Record<string, unknown>, opts?: Record<string, unknown>) => (calls.push({ op: "reverse", params: { id, ...params }, opts }), { id: `trr_fake_${++n}` }),
  },
  payouts: { create: record("payout", "po") },
  refunds: { create: record("refund", "re") },
  accounts: {
    create: record("account", "acct"),
    retrieve: async () => {
      throw new Error("offline in the test");
    },
    createLoginLink: async () => ({ url: "https://connect.stripe.com/express/fake" }),
  },
  accountLinks: { create: record("account_link", "link") },
};
const fakeStripe = (on: boolean) => ((globalThis as { __fakeStripe?: unknown }).__fakeStripe = on ? fake : undefined);

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
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterEach(() => {
  fakeStripe(false);
  failPayout = null;
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

/** A real (not simulator) Express account for the employee, paid by Stripe, with a bank as the default and a debit card for instant payouts. */
async function readyOnStripe(staffId: string, acct: string, instant: boolean) {
  const row = {
    method: "stripe" as const,
    instant,
    stripeAccountId: acct,
    simulated: false,
    payoutsEnabled: true,
    detailsSubmitted: true,
    instantEligible: true,
    destinationType: "bank_account" as const,
    destinationLast4: "6789",
    destinationName: "STRIPE TEST BANK",
    externalAccounts: [BANK, CARD],
  };
  await m.db.db.insert(s().staffPayoutAccounts).values({ staffId, ...row }).onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: row });
}

async function shopOnStripe(shopId: string, acct: string) {
  const row = { stripeAccountId: acct, simulated: false, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
  await m.db.db.insert(s().shopPaymentAccounts).values({ shopId, ...row }).onConflictDoUpdate({ target: s().shopPaymentAccounts.shopId, set: row });
}

async function setPolicy(p: Partial<import("@/domain/tips").BrandTipPolicy>) {
  const [b] = await m.db.db.select({ t: s().brandSettings.tipPayouts }).from(s().brandSettings);
  await m.db.db.update(s().brandSettings).set({ tipPayouts: { ...(b?.t as object), ...p } });
}

async function payOne(shopId: string, staffId: string, tipCents: number) {
  await tipSale(shopId, staffId, tipCents);
  const r = await tp.buildBatch({ shopId, kind: "manual", cutoff: today, actor });
  const draft = (await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId))))[0];
  calls.length = 0;
  fakeStripe(true);
  await tp.approveBatch(r.batchId, actor);
  const sent = (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, draft.id) }))!;
  const mine = (c: Call) => (c.params.metadata as { tipPayoutId?: string } | undefined)?.tipPayoutId === draft.id;
  return { draft, sent, batchId: r.batchId, made: calls.filter((c) => mine(c) && ["debit", "transfer", "payout"].includes(c.op)), unwound: calls.filter((c) => mine(c) && ["reverse", "refund"].includes(c.op)) };
}

describe("test mode only", () => {
  it("live keys are refused for employee accounts, onboarding and approving Stripe payouts, unless MONEY_MOVEMENT_LIVE is on", async () => {
    const { shop, staffId } = await person("moline", "Jen");
    await shopOnStripe(shop.id, "acct_fake_moline");
    await tipSale(shop.id, staffId, 1200);
    fakeStripe(true);
    process.env.STRIPE_SECRET_KEY = "sk_live_not_real";
    expect(mm.moneyMovementReady()).toBe(false);
    expect(() => mm.moneyClient()).toThrow(/test mode only/);
    await expect(accounts.staffOnboardingUrl(staffId, actor, "http://localhost")).rejects.toThrow(/test mode only/);

    await readyOnStripe(staffId, "acct_fake_jen", false);
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

describe("separate charges and transfers", () => {
  it("an instant payout, fee passed on: the shop's account is debited the net, the employee's account gets net − fee, paid out instantly to the debit card", async () => {
    const { shop, staffId } = await person("moline", "Jilane");
    await setPolicy({ instantAllowed: true, instantFeePassedOn: true });
    await readyOnStripe(staffId, "acct_fake_jilane", true);
    await shopOnStripe(shop.id, "acct_fake_moline");
    const { draft, sent, made } = await payOne(shop.id, staffId, 2500);
    expect(draft).toMatchObject({ method: "stripe", instant: true, netCents: 2500, instantFeeCents: 50, instantFeePaidBy: "employee" });
    expect(made.map((c) => c.op)).toEqual(["debit", "transfer", "payout"]);
    const [debit, transfer, payout] = made;
    expect(debit.params).toMatchObject({ amount: 2500, currency: "usd", source: "acct_fake_moline" });
    expect(debit.opts).toEqual({ idempotencyKey: `tip-${draft.id}-debit` });
    expect(transfer.params).toMatchObject({ amount: 2450, destination: "acct_fake_jilane", source_transaction: debit.id, transfer_group: `tips-${draft.batchId}` });
    expect(transfer.opts).toEqual({ idempotencyKey: `tip-${draft.id}-transfer` });
    expect(payout.params).toMatchObject({ amount: 2450, method: "instant", destination: "card_fake_debit", statement_descriptor: "RAYZ TIPS" });
    expect(payout.opts).toEqual({ stripeAccount: "acct_fake_jilane", idempotencyKey: `tip-${draft.id}-payout` });
    expect(sent).toMatchObject({ status: "processing", stripeDebitId: debit.id, stripeTransferId: transfer.id, stripePayoutId: payout.id, destinationType: "card", destinationLast4: "5556" });
    expect(sent.sentAt).not.toBeNull();

    const secret = "whsec_test_tip_stripe";
    const payload = JSON.stringify({ id: "evt_po_paid", object: "event", type: "payout.paid", account: "acct_fake_jilane", data: { object: { id: payout.id, object: "payout", status: "paid", metadata: { tipPayoutId: draft.id } } } });
    expect((await connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret)).status).toBe(200);
    expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, draft.id) }))!.status).toBe("paid");
  });

  it("the brand absorbs the fee: the shop is debited net + fee, the employee gets the whole net instantly; a standard payout goes to the default bank with no fee", async () => {
    const { shop, staffId } = await person("moline", "Mackenzie");
    await setPolicy({ instantAllowed: true, instantFeePassedOn: false });
    await readyOnStripe(staffId, "acct_fake_mackenzie", true);
    await m.db.db.update(s().staff).set({ email: "mackenzie.tips@rayz.test" }).where(eq(s().staff.id, staffId));
    const { draft, made } = await payOne(shop.id, staffId, 4000);
    expect(draft).toMatchObject({ instant: true, netCents: 4000, instantFeeCents: 60, instantFeePaidBy: "shop" });
    expect(made.map((c) => [c.op, c.params.amount])).toEqual([
      ["debit", 4060],
      ["transfer", 4000],
      ["payout", 4000],
    ]);
    expect(made[2].params).toMatchObject({ method: "instant", destination: "card_fake_debit" });
    const [note] = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.to, "mackenzie.tips@rayz.test")));
    expect(note.subject).toBe("Tip payout: $40.00");
    expect(note.body).toMatch(/to your debit card ••5556 \(instant\)\. The shop paid Stripe's instant payout fee\./);

    await accounts.setPayoutChoice(staffId, { method: "stripe", instant: false }, actor);
    const std = await payOne(shop.id, staffId, 1500);
    expect(std.draft).toMatchObject({ instant: false, instantFeeCents: 0 });
    expect(std.made.map((c) => [c.op, c.params.amount])).toEqual([
      ["debit", 1500],
      ["transfer", 1500],
      ["payout", 1500],
    ]);
    expect(std.made[2].params.method).toBe("standard");
    expect(std.made[2].params).not.toHaveProperty("destination");
    expect(std.sent).toMatchObject({ destinationType: "bank_account", destinationLast4: "6789" });
    await setPolicy({ instantFeePassedOn: true });
  });

  it("a shop on the brand's account pays from the platform balance, with no account debit", async () => {
    const { shop, staffId } = await person("utica", "Sarah");
    await m.db.db.update(s().shops).set({ paymentsMode: "brand" }).where(eq(s().shops.id, shop.id));
    await readyOnStripe(staffId, "acct_fake_sarah", false);
    const { made, sent } = await payOne(shop.id, staffId, 900);
    expect(made.map((c) => c.op)).toEqual(["transfer", "payout"]);
    expect(made[0].params).not.toHaveProperty("source_transaction");
    expect(sent).toMatchObject({ status: "processing", stripeDebitId: null });
  });

  it("a payout Stripe refuses unwinds: the transfer is reversed, the debit refunded, and the tips go back for the next batch", async () => {
    const { shop, staffId } = await person("moline", "Jilane");
    await readyOnStripe(staffId, "acct_fake_jilane", false);
    failPayout = "Your card doesn't support instant payouts";
    const { draft, sent, made, unwound: after } = await payOne(shop.id, staffId, 700);
    expect(sent).toMatchObject({ status: "failed", failureMessage: "Stripe: Your card doesn't support instant payouts" });
    const debit = made.find((c) => c.op === "debit")!;
    const transfer = made.find((c) => c.op === "transfer")!;
    expect(sent).toMatchObject({ stripeDebitId: debit.id, stripeTransferId: transfer.id });
    expect(after.map((c) => c.op)).toEqual(["reverse", "refund"]);
    expect(after[0]).toMatchObject({ params: { id: transfer.id }, opts: { idempotencyKey: `tip-${draft.id}-reverse` } });
    expect(after[1]).toMatchObject({ params: { charge: debit.id }, opts: { idempotencyKey: `tip-${draft.id}-debit-refund` } });
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, draft.id))).toEqual([]);
  });
});

describe("Connect webhooks for employees' accounts", () => {
  const secret = "whsec_test_tip_stripe";
  const event = (type: string, object: object, account: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account, data: { object } });
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };

  it("account.updated keeps every bank account and card with its id, type, name and last 4 only; instant payouts go to the debit card; payout.failed releases the tips", async () => {
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
    const a = (await accounts.staffAccount(staffId))!;
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

    await tipSale(shop.id, staffId, 800);
    const r = await tp.buildBatch({ shopId: shop.id, kind: "manual", cutoff: today, actor });
    const [p] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, r.batchId), eq(s().tipPayouts.staffId, staffId)));
    expect(p.instant).toBe(false);
    calls.length = 0;
    await tp.approveBatch(r.batchId, actor);
    const payout = calls.find((c) => c.op === "payout" && (c.params.metadata as { tipPayoutId?: string }).tipPayoutId === p.id)!;
    expect(payout.params).toMatchObject({ method: "standard", amount: 800 });

    await event("payout.failed", { id: payout.id, object: "payout", status: "failed", failure_message: "Account closed", metadata: { tipPayoutId: p.id } }, acct);
    expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, p.id) }))!).toMatchObject({ status: "failed", failureMessage: "Payout failed: Account closed" });
    const mine = (c: Call) => (c.params.metadata as { tipPayoutId?: string } | undefined)?.tipPayoutId === p.id;
    expect(calls.filter((c) => c.op === "reverse" && mine(c)).map((c) => c.params.id)).toEqual([calls.find((c) => c.op === "transfer" && mine(c))!.id]);
  });
});
