/**
 * Stripe Connect (I10): one platform account, one connected account per shop. Card charges are
 * destination charges to the shop where the service happened, refunds pull the transfer back,
 * shops that aren't onboarded can't take cards, the location setup wizard onboards each shop, and
 * the Shop P&L report ties each shop's card money to its own account, grouped by owner.
 */
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let connect: typeof import("@/server/payments/connect");
let webhook: typeof import("@/server/payments/connect-webhook");
let accountReport: typeof import("@/server/payments/account-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

beforeAll(async () => {
  m = await loadModules();
  connect = await import("@/server/payments/connect");
  webhook = await import("@/server/payments/connect-webhook");
  accountReport = await import("@/server/payments/account-report");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;
const account = async (shopId: string) => (await m.db.db.query.shopPaymentAccounts.findFirst({ where: eq(m.schema.shopPaymentAccounts.shopId, shopId) })) ?? null;
const staffId = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!.id;
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const reader = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "terminal" as const };

async function ticket(slug: string) {
  const s = await shop(slug);
  const sale = await m.checkout.openBlankSale(s.id, actor);
  const svc = (await m.catalog.shopCatalog(s.id)).find((x) => x.slug === "rayz-cut-shampoo")!;
  return { sale, shop: s, lines: [{ kind: "service" as const, refId: svc.id, qty: 1 }] };
}

describe("seeded shops", () => {
  it("each has its own onboarded connected account and the brand as owner; card history is routed to it", async () => {
    const shops = await m.db.db.select().from(m.schema.shops);
    const owners = await m.db.db.select().from(m.schema.ownerEntities);
    expect(owners).toHaveLength(1);
    expect(owners[0].kind).toBe("brand");
    const accounts = await m.db.db.select().from(m.schema.shopPaymentAccounts);
    expect(new Set(accounts.map((a) => a.stripeAccountId)).size).toBe(shops.length);
    for (const s of shops) {
      expect(s.ownerEntityId).toBe(owners[0].id);
      const a = accounts.find((x) => x.shopId === s.id)!;
      expect(a.simulated && a.chargesEnabled && a.payoutsEnabled).toBe(true);
    }
    const unrouted = await m.db.db.execute(m.drizzle.sql`select count(*)::int n from payments p left join shop_payment_accounts a on a.shop_id = p.shop_id
      where p.method = 'card' and p.amount_cents > 0 and (p.stripe_account_id is distinct from a.stripe_account_id or p.application_fee_cents <= 0)`);
    expect((unrouted as unknown as { n: number }[])[0].n).toBe(0);
  });
});

describe("destination charges", () => {
  it("a card charge settles to the shop's own account, with the processing fee as the application fee", async () => {
    const t = await ticket("moline");
    const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 500, tender: credit, actor });
    const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, t.sale.id));
    const a = (await account(t.shop.id))!;
    const fee = (await import("@/domain/connect")).processingFeeCents(pay.amountCents, connect.feeSchedule().keyed);
    expect(pay.amountCents).toBe(r.totals.primaryChargeCents);
    expect(pay.stripeAccountId).toBe(a.stripeAccountId);
    expect(pay.applicationFeeCents).toBe(fee);
    expect(pay.stripeTransferId).toMatch(/^sim_tr_/);
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent.destination).toEqual({ accountId: a.stripeAccountId, applicationFeeCents: fee, processingFeeCents: fee, royaltyCents: 0, adFundCents: 0 });
  });

  it("the card reader uses the in-person rate", async () => {
    const t = await ticket("kimberly");
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: reader, actor });
    const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, t.sale.id));
    expect(pay.applicationFeeCents).toBe(Math.round(pay.amountCents * 0.027) + 5);
  });

  it("each shop's charge goes to that shop, never another's", async () => {
    const a = await ticket("coralville");
    const b = await ticket("silvis");
    await m.checkout.finalizeSale({ saleId: a.sale.id, lines: a.lines, tipCents: 0, tender: credit, actor });
    await m.checkout.finalizeSale({ saleId: b.sale.id, lines: b.lines, tipCents: 0, tender: credit, actor });
    const pays = await m.db.db
      .select()
      .from(m.schema.payments)
      .where(m.drizzle.inArray(m.schema.payments.saleId, [a.sale.id, b.sale.id]));
    expect(pays.find((p) => p.saleId === a.sale.id)!.stripeAccountId).toBe((await account(a.shop.id))!.stripeAccountId);
    expect(pays.find((p) => p.saleId === b.sale.id)!.stripeAccountId).toBe((await account(b.shop.id))!.stripeAccountId);
  });

  it("refunds pull the money back from the shop's account; the processing fee isn't returned", async () => {
    const t = await ticket("moline");
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 300, tender: credit, actor });
    const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, t.sale.id));
    await m.checkout.refundSale({ saleId: t.sale.id, items: [], tipCents: 300, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    const ref = m.processor.simulatorLedger().refunds.filter((x) => x.paymentIntentId === pay.stripePaymentIntentId);
    expect(ref).toEqual([expect.objectContaining({ amountCents: 300, reverseTransfer: true })]);

    const v = await ticket("moline");
    await m.checkout.finalizeSale({ saleId: v.sale.id, lines: v.lines, tipCents: 0, tender: credit, actor });
    const [vp] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, v.sale.id));
    await m.checkout.voidSale(v.sale.id, "Rang up the wrong client", actor);
    expect(m.processor.simulatorLedger().refunds.filter((x) => x.paymentIntentId === vp.stripePaymentIntentId)).toEqual([
      expect.objectContaining({ amountCents: vp.amountCents, reverseTransfer: true }),
    ]);
  });

  it("a shop that isn't onboarded can't take cards, but cash still works", async () => {
    const t = await ticket("utica");
    const before = (await account(t.shop.id))!;
    await m.db.db.update(m.schema.shopPaymentAccounts).set({ chargesEnabled: false, detailsSubmitted: false }).where(eq(m.schema.shopPaymentAccounts.shopId, t.shop.id));
    const intents = m.processor.simulatorLedger().intents.length;
    try {
      await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: credit, actor })).rejects.toMatchObject({
        code: "payment_failed",
        message: expect.stringMatching(/can't take cards until its Stripe account is set up/),
        details: { reason: "payments_not_ready", state: "onboarding" },
      });
      expect(m.processor.simulatorLedger().intents.length).toBe(intents);
      expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) }))!.status).toBe("open");
      const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor });
      expect(r.totals.totalCents).toBeGreaterThan(0);
    } finally {
      await m.db.db
        .update(m.schema.shopPaymentAccounts)
        .set({ chargesEnabled: before.chargesEnabled, detailsSubmitted: before.detailsSubmitted })
        .where(eq(m.schema.shopPaymentAccounts.shopId, t.shop.id));
    }
  });
});

describe("Connect webhook", () => {
  const secret = "whsec_test_connect";
  const deliver = (type: string, object: object, accountId: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account: accountId, data: { object } });
    return webhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };

  it("refuses unsigned or unconfigured deliveries", async () => {
    expect((await webhook.handleConnectWebhook("{}", "t=1,v1=nope", secret)).status).toBe(400);
    expect((await webhook.handleConnectWebhook("{}", "t=1,v1=nope", undefined)).status).toBe(400);
  });

  it("account.updated tracks verification; a disconnect stops card payments", async () => {
    const s = await shop("dubuque");
    const a = (await account(s.id))!;
    try {
      const update = {
        id: a.stripeAccountId,
        object: "account",
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: { currently_due: ["external_account"], past_due: [], disabled_reason: null },
      };
      expect((await deliver("account.updated", update, a.stripeAccountId)).status).toBe(200);
      let now = (await account(s.id))!;
      expect(now).toMatchObject({ chargesEnabled: true, payoutsEnabled: false, requirementsDue: ["external_account"] });
      const state = (await import("@/domain/connect")).accountState(now);
      expect(state).toBe("restricted");
      expect((await connect.chargeDestination(s, 5000, "keyed")).accountId).toBe(a.stripeAccountId);
      const today = m.time.todayLocal();
      const [row] = await accountReport.shopAccountRows({ shopIds: [s.id], from: today, to: today });
      expect(row).toMatchObject({ state: "restricted", canCharge: true });

      await deliver("account.application.deauthorized", { id: "ca_x", object: "application" }, a.stripeAccountId);
      now = (await account(s.id))!;
      expect(now.deauthorizedAt).not.toBeNull();
      await expect(connect.chargeDestination(s, 5000, "keyed")).rejects.toMatchObject({
        message: expect.stringMatching(/disconnected/),
        details: { reason: "payments_not_ready", state: "disconnected" },
      });
    } finally {
      await m.db.db
        .update(m.schema.shopPaymentAccounts)
        .set({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [], deauthorizedAt: null })
        .where(eq(m.schema.shopPaymentAccounts.shopId, s.id));
    }
  });

  it("payouts are recorded per shop and updated in place", async () => {
    const s = await shop("rock-island");
    const a = (await account(s.id))!;
    const po = { id: "po_test_ri_1", object: "payout", amount: 12_345, status: "in_transit", arrival_date: Math.floor(Date.now() / 1000) + 86_400, failure_message: null };
    await deliver("payout.created", po, a.stripeAccountId);
    await deliver("payout.paid", { ...po, status: "paid" }, a.stripeAccountId);
    const rows = await m.db.db.select().from(m.schema.shopPayouts).where(eq(m.schema.shopPayouts.stripePayoutId, po.id));
    expect(rows).toEqual([expect.objectContaining({ shopId: s.id, amountCents: 12_345, status: "paid" })]);
    expect((await deliver("payout.paid", { ...po, id: "po_unknown" }, "acct_not_ours")).status).toBe(200);
    expect(await m.db.db.select().from(m.schema.shopPayouts).where(eq(m.schema.shopPayouts.stripePayoutId, "po_unknown"))).toEqual([]);
  });
});

describe("location setup", () => {
  it("a new shop starts with the brand as owner and no account, then onboards through the (simulated) hosted flow", async () => {
    const setup = await import("@/app/admin/setup/actions");
    const { draftDefaults } = await import("@/domain/location-draft");
    const { locationSetup } = await import("@/server/location-setup");
    await signInAs(await staffId("owner@rayz.test"));
    const made = await setup.createLocationAction(draftDefaults({ name: "Davenport", slug: "davenport", address: "100 Main St", city: "Davenport", state: "IA", zip: "52801", phone: "5635550100" }));
    expect(made.ok).toBe(true);
    const id = (made as { data: { id: string } }).data.id;
    let s = (await locationSetup(id))!;
    expect(s.owner?.kind).toBe("brand");
    expect(s.state).toBe("not_started");
    expect(s.steps.find((x) => x.key === "payments")!.done).toBe(false);

    const t = await ticket("davenport").catch(() => null);
    if (t)
      await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: credit, actor })).rejects.toMatchObject({
        details: { reason: "payments_not_ready", state: "not_started" },
      });

    const started = await setup.startPaymentsOnboardingAction(id);
    expect(started).toEqual({ ok: true, data: { url: `/admin/setup/simulated-onboarding?shop=${id}` } });
    s = (await locationSetup(id))!;
    expect(s.state).toBe("onboarding");
    expect(s.account!.stripeAccountId).toMatch(/^sim_acct_davenport_/);
    const again = await setup.startPaymentsOnboardingAction(id);
    expect((await account(id))!.stripeAccountId).toBe(s.account!.stripeAccountId);
    expect(again.ok).toBe(true);

    expect(await setup.completeSimulatedOnboardingAction(id, false)).toMatchObject({ ok: true });
    s = (await locationSetup(id))!;
    expect(s.state).toBe("restricted");
    expect(s.account!.requirementsDue).toEqual(["external_account"]);
    expect(await setup.completeSimulatedOnboardingAction(id, true)).toMatchObject({ ok: true });
    expect((await locationSetup(id))!.state).toBe("enabled");

    const audits = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["shop.create", "payments.account_created", "payments.onboarding_simulated"]));
  });

  it("a franchisee owner groups its shops in the P&L report; only the brand edits owners", async () => {
    const setup = await import("@/app/admin/setup/actions");
    await signInAs(await staffId("owner@rayz.test"));
    expect(await setup.saveOwnerEntityAction(null, { name: "x", legalName: null, kind: "franchisee", contactEmail: null })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/name/),
    });
    const made = await setup.saveOwnerEntityAction(null, { name: "Quad Cities Cuts LLC", legalName: null, kind: "franchisee", contactEmail: "qc@example.test" });
    expect(made.ok).toBe(true);
    const ownerId = (made as { data: { id: string } }).data.id;
    const [moline, silvis] = [await shop("moline"), await shop("silvis")];
    expect(await setup.setShopOwnerAction(moline.id, ownerId)).toMatchObject({ ok: true });
    expect(await setup.setShopOwnerAction(silvis.id, ownerId)).toMatchObject({ ok: true });

    const today = m.time.todayLocal();
    const all = (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id);
    const rows = await accountReport.shopAccountRows({ shopIds: all, from: m.time.addDays(today, -3), to: today });
    const franchise = rows.filter((r) => r.ownerId === ownerId);
    expect(franchise.map((r) => r.shopName).sort()).toEqual(["Moline", "Silvis"]);
    expect(rows[0].ownerKind).toBe("brand");
    const at = rows.findIndex((r) => r.ownerId === ownerId);
    expect(rows.slice(at, at + 2).every((r) => r.ownerId === ownerId)).toBe(true);

    await signInAs(await staffId("manager.moline@rayz.test"));
    expect(await setup.saveOwnerEntityAction(ownerId, { name: "Taken over", legalName: null, kind: "franchisee", contactEmail: null })).toMatchObject({ ok: false });
    expect((await m.db.db.query.ownerEntities.findFirst({ where: eq(m.schema.ownerEntities.id, ownerId) }))!.name).toBe("Quad Cities Cuts LLC");
  });
});

describe("Shop P&L by Stripe account", () => {
  it("each shop's card money reconciles: charges less refunds and fees is what its account received", async () => {
    const today = m.time.todayLocal();
    const scope = { shopIds: (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id), from: m.time.addDays(today, -3), to: today };
    const rows = await accountReport.shopAccountRows(scope);
    const sum = await m.reports.salesSummary(scope);
    const q = (await m.db.db.execute(m.drizzle.sql`
      select p.shop_id "shopId",
        sum(p.amount_cents) filter (where p.status <> 'voided' and s.status <> 'voided')::int card,
        sum(p.application_fee_cents)::int fees
      from payments p join sales s on s.id = p.sale_id
      where p.method = 'card' and p.status not in ('pending', 'failed') and p.business_date between ${scope.from} and ${scope.to}
      group by 1`)) as unknown as { shopId: string; card: number | null; fees: number }[];
    const refunds = (await m.db.db.execute(m.drizzle.sql`select shop_id "shopId", sum(amount_cents)::int n from refunds
      where method = 'card' and kind = 'refund' and business_date between ${scope.from} and ${scope.to} group by 1`)) as unknown as { shopId: string; n: number }[];
    for (const r of rows) {
      const p = q.find((x) => x.shopId === r.shopId);
      const back = refunds.find((x) => x.shopId === r.shopId)?.n ?? 0;
      expect(r.cardNetCents).toBe((p?.card ?? 0) - back);
      expect(r.processingFeesCents).toBe(p?.fees ?? 0);
      expect(r.toAccountCents).toBe(r.cardNetCents - r.unroutedCardCents - r.processingFeesCents);
    }
    expect(rows.reduce((a, r) => a + r.processingFeesCents, 0)).toBeGreaterThan(0);
    expect(rows.reduce((a, r) => a + r.cardTipsCents, 0)).toBeLessThanOrEqual(sum.tipsCents);
  });

  it("seeded payouts are each day's card takings less fees and refunds", async () => {
    const s = await shop("coralville");
    const [po] = await m.db.db.select().from(m.schema.shopPayouts).where(eq(m.schema.shopPayouts.shopId, s.id)).orderBy(m.drizzle.asc(m.schema.shopPayouts.arrivalDate)).limit(1);
    const day = m.time.addDays(po.arrivalDate, -2);
    const [{ net }] = (await m.db.db.execute(m.drizzle.sql`select (
        coalesce((select sum(amount_cents - application_fee_cents) from payments where shop_id = ${s.id} and method = 'card' and business_date = ${day} and status not in ('pending', 'failed')), 0)
      - coalesce((select sum(amount_cents) from refunds where shop_id = ${s.id} and method = 'card' and business_date = ${day}), 0))::int net`)) as unknown as { net: number }[];
    expect(po.amountCents).toBe(net);
  });

  it("the report page and setup pages render for the brand; a shop manager gets the report for their shop only", async () => {
    await signInAs(await staffId("owner@rayz.test"));
    const report = await open("/admin/reports/shop-accounts");
    expect(report.kind).toBe("ok");
    expect(report.text).toMatch(/Quad Cities Cuts LLC/);
    expect(report.text).toMatch(/sim_acct_coralville/);
    const overview = await open("/admin/setup");
    expect(overview.text).toMatch(/Davenport/);
    const cv = await shop("coralville");
    const detail = await open("/admin/setup", {}, { shop: cv.id });
    expect(detail.text).toMatch(/Coralville.*Live.*required steps done/);
    expect(detail.text).toMatch(/Taking cards; payouts go to the shop's bank/);
    const davenport = await shop("davenport");
    expect((await open("/admin/setup/simulated-onboarding", {}, { shop: davenport.id })).text).toMatch(/stands in for Stripe/);

    await signInAs(await staffId("michelle@rayz.test"));
    const mine = await open("/admin/reports/shop-accounts");
    expect(mine.text).toMatch(/Coralville/);
    expect(mine.text).not.toMatch(/sim_acct_moline/);
    expect((await open("/admin/setup")).kind).toBe("denied");
  });
});
