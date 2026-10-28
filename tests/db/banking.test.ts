/**
 * Per-location banking: the brand owner chooses, per shop, whether card money settles in the
 * brand's own Stripe account, the shop's own connected account, or nowhere (cash only). Every
 * charge, tip, gift card sale, reader payment and refund follows that choice; webhooks and payouts
 * land on the right shop; go-live waits for Stripe; and only the Brand Owner, or someone they
 * grant it to, can change any of it.
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
let setup: typeof import("@/app/admin/setup/actions");
let connect: typeof import("@/server/payments/connect");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let accountReport: typeof import("@/server/payments/account-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shopIds: Record<string, string> = {};
const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!.id;
const shop = async (id: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) }))!;
const shopBySlug = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;
const account = async (shopId: string) => (await m.db.db.query.shopPaymentAccounts.findFirst({ where: eq(m.schema.shopPaymentAccounts.shopId, shopId) })) ?? null;
const paymentFor = async (saleId: string) => (await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, saleId)))[0];
const audits = async (action: string, entityId?: string) =>
  m.db.db
    .select()
    .from(m.schema.auditLog)
    .where(entityId ? m.drizzle.and(eq(m.schema.auditLog.action, action), eq(m.schema.auditLog.entityId, entityId)) : eq(m.schema.auditLog.action, action))
    .orderBy(m.schema.auditLog.at);

async function draft(name: string, slug: string, staffId: string, days: number[], extra: Record<string, unknown> = {}) {
  const { wizardOptions } = await import("@/server/location-admin");
  const { draftDefaults } = await import("@/domain/location-draft");
  const { staffGrantor, getStaffContext } = await import("@/server/auth/staff");
  const opts = await wizardOptions(staffGrantor((await getStaffContext())!));
  const moline = opts.shops.find((s) => s.name === "Moline")!;
  const menu = opts.shopServices.filter((s) => s.shopId === moline.id && s.enabled);
  return draftDefaults({
    name,
    slug,
    address: "1 Main St",
    city: name,
    state: "IA",
    zip: "52001",
    phone: "5635550111",
    serviceTaxRate: 0.07,
    productTaxRate: 0.07,
    taxRatesVerified: true,
    services: menu.map((s) => ({ serviceId: s.serviceId, enabled: true, bookableOnline: true, priceCents: null, durationMin: null })),
    staff: [{ staffId, bookable: true, access: false, primary: false, schedule: days.map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) }],
    ...extra,
  });
}

async function ticket(shopId: string, o: { giftCardCents?: number } = {}) {
  const sale = await m.checkout.openBlankSale(shopId, actor);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.kind === "service")!;
  const lines = [
    { kind: "service" as const, refId: svc.id, qty: 1 },
    ...(o.giftCardCents ? [{ kind: "gift_card" as const, qty: 1, unitPriceCents: o.giftCardCents, name: "Gift card" }] : []),
  ];
  return { sale, lines };
}

beforeAll(async () => {
  m = await loadModules();
  setup = await import("@/app/admin/setup/actions");
  connect = await import("@/server/payments/connect");
  connectWebhook = await import("@/server/payments/connect-webhook");
  accountReport = await import("@/server/payments/account-report");
  for (const k of ["owner", "admin", "michelle", "manager.moline", "makenna"]) ids[k] = await staffBy(`${k}@rayz.test`);
  for (const label of ["Autumn", "Charles"]) ids[label] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the wizard's Payments and banking step", () => {
  it("anything but the default needs the banking permission, which a Brand Admin doesn't have", async () => {
    await signInAs(ids.admin);
    const brand = await setup.createLocationAction(await draft("Clinton", "clinton", ids.Autumn, [1, 2], { paymentsMode: "brand" }));
    expect(brand).toMatchObject({ ok: false, error: expect.stringMatching(/banking permission/) });
    const descriptor = await setup.createLocationAction(await draft("Clinton", "clinton", ids.Autumn, [1, 2], { statementDescriptor: "RAYZ CLINTON" }));
    expect(descriptor).toMatchObject({ ok: false, error: expect.stringMatching(/banking permission/) });

    const made = await setup.createLocationAction(await draft("Clinton", "clinton", ids.Autumn, [1, 2]));
    expect(made).toMatchObject({ ok: true, data: { paymentsMode: "connected", readerProblems: [] } });
    shopIds.connected = (made as { data: { id: string } }).data.id;
    expect((await shop(shopIds.connected)).paymentsMode).toBe("connected");
    expect(await setup.startPaymentsOnboardingAction(shopIds.connected)).toMatchObject({ ok: false, error: expect.stringMatching(/Only the Brand Owner/) });
  });

  it("the owner puts a shop on the brand's account, with its descriptor, receipt and a reader registered to its own Terminal location", async () => {
    await signInAs(ids.owner);
    const made = await setup.createLocationAction(
      await draft("Iowa City", "iowa-city", ids.Autumn, [3, 4], {
        paymentsMode: "brand",
        statementDescriptor: "rayz iowa city",
        receipt: { headline: "Ray'z Iowa City", footer: "See you in three weeks", showLogo: false, showAddress: true, showPhone: false },
        readers: [
          { label: "Front counter", serialNumber: null, registrationCode: "simulated-wpe" },
          { label: "Back bar", serialNumber: "WSC-9", registrationCode: null },
        ],
      }),
    );
    expect(made).toMatchObject({ ok: true, data: { paymentsMode: "brand", readerProblems: [] } });
    shopIds.brand = (made as { data: { id: string } }).data.id;
    const s = await shop(shopIds.brand);
    expect(s).toMatchObject({ paymentsMode: "brand", statementDescriptor: "RAYZ IOWA CITY", receipt: expect.objectContaining({ headline: "Ray'z Iowa City", showPhone: false }) });
    expect(s.stripeTerminalLocationId).toMatch(/^sim_tml_iowa_city_/);
    const readers = await m.db.db.select().from(m.schema.terminalReaders).where(eq(m.schema.terminalReaders.shopId, shopIds.brand));
    const front = readers.find((r) => r.label === "Front counter")!;
    expect(front).toMatchObject({ stripeLocationId: s.stripeTerminalLocationId, deviceType: "simulated_wisepos_e" });
    expect(front.stripeReaderId).toMatch(/^sim_tmr_/);
    expect(front.registeredAt).not.toBeNull();
    expect(readers.find((r) => r.label === "Back bar")).toMatchObject({ stripeReaderId: null, registeredAt: null, serialNumber: "WSC-9" });
    shopIds.reader = front.id;

    expect(await audits("shop.create", shopIds.brand)).toEqual([expect.objectContaining({ details: expect.objectContaining({ paymentsMode: "brand", statementDescriptor: "RAYZ IOWA CITY" }) })]);
    expect(await audits("reader.register", front.id)).toHaveLength(1);
    expect(await audits("payments.terminal_location", shopIds.brand)).toHaveLength(1);
    expect(await account(shopIds.brand)).toBeNull();
  });

  it("the owner can open a shop cash-only", async () => {
    await signInAs(ids.owner);
    const made = await setup.createLocationAction(await draft("Muscatine", "muscatine", ids.Charles, [1, 2], { paymentsMode: "cash_only" }));
    expect(made).toMatchObject({ ok: true, data: { paymentsMode: "cash_only" } });
    shopIds.cash = (made as { data: { id: string } }).data.id;
  });
});

describe("go-live", () => {
  it("a shop on its own account waits for Stripe to enable charges, unless it opens cash-only", async () => {
    await signInAs(ids.owner);
    const { locationSetup } = await import("@/server/location-setup");
    expect((await locationSetup(shopIds.connected))!.blockers).toEqual(["payments"]);
    expect(await setup.goLiveAction(shopIds.connected, false)).toMatchObject({ ok: false, error: expect.stringMatching(/Finish these first/) });

    expect(await setup.startPaymentsOnboardingAction(shopIds.connected)).toMatchObject({ ok: true });
    await m.db.db.update(m.schema.shopPaymentAccounts).set({ detailsSubmitted: true, payoutsEnabled: true }).where(eq(m.schema.shopPaymentAccounts.shopId, shopIds.connected));
    expect((await locationSetup(shopIds.connected))!.blockers).toEqual(["payments"]);

    expect(await setup.goLiveAction(shopIds.connected, true)).toEqual({ ok: true, data: null });
    expect((await shop(shopIds.connected)).paymentsMode).toBe("connected");
    const t = await ticket(shopIds.connected);
    await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: credit, actor })).rejects.toMatchObject({
      code: "payment_failed",
      details: { reason: "payments_not_ready" },
    });
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: cash, actor });

    expect(await setup.completeSimulatedOnboardingAction(shopIds.connected, true)).toMatchObject({ ok: true });
    const card = await ticket(shopIds.connected);
    await m.checkout.finalizeSale({ saleId: card.sale.id, lines: card.lines, tipCents: 400, tender: credit, actor });
    const pay = await paymentFor(card.sale.id);
    expect(pay).toMatchObject({ stripeAccountId: (await account(shopIds.connected))!.stripeAccountId, settlement: "connected" });
  });

  it("a shop on the brand's account, or cash-only, has nothing to wait for", async () => {
    await signInAs(ids.owner);
    const { locationSetup } = await import("@/server/location-setup");
    for (const id of [shopIds.brand, shopIds.cash]) {
      expect((await locationSetup(id))!.blockers).toEqual([]);
      expect(await setup.goLiveAction(id, false)).toEqual({ ok: true, data: null });
    }
    const audit = (await audits("shop.go_live", shopIds.brand)).concat(await audits("location.go_live", shopIds.brand));
    expect(audit.map((a) => (a.details as { paymentsMode?: string }).paymentsMode)).toContain("brand");
  });
});

describe("charge routing", () => {
  it("on the brand's account a charge is a plain platform charge, with the shop's statement suffix and Stripe's fee", async () => {
    const t = await ticket(shopIds.brand);
    const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 500, tender: credit, actor });
    const pay = await paymentFor(t.sale.id);
    const fee = (await import("@/domain/connect")).processingFeeCents(pay.amountCents, connect.feeSchedule().keyed);
    expect(pay).toMatchObject({ shopId: shopIds.brand, stripeAccountId: null, stripeTransferId: null, settlement: "platform", processorFeeCents: fee, amountCents: r.totals.primaryChargeCents });
    expect(pay.applicationFeeCents ?? 0).toBe(0);
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent).toMatchObject({ destination: null, statementDescriptorSuffix: "IOWA CITY" });
  });

  it("a cash-only shop refuses cards before anything is charged; cash works", async () => {
    const t = await ticket(shopIds.cash);
    const before = m.processor.simulatorLedger().intents.length;
    await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: credit, actor })).rejects.toMatchObject({
      code: "payment_failed",
      details: { reason: "cash_only" },
    });
    expect(m.processor.simulatorLedger().intents.length).toBe(before);
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: cash, actor });
  });

  it("a gift card sold by card, and the tip, settle in the selling shop's own account", async () => {
    const moline = await shopBySlug("moline");
    const t = await ticket(moline.id, { giftCardCents: 5_000 });
    const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 700, tender: credit, actor });
    const pay = await paymentFor(t.sale.id);
    const a = (await account(moline.id))!;
    expect(r.totals.giftCardSalesCents).toBe(5_000);
    expect(pay).toMatchObject({ stripeAccountId: a.stripeAccountId, settlement: "connected", tipCents: 700 });
    const intent = m.processor.simulatorLedger().intents.find((i) => i.id === pay.stripePaymentIntentId)!;
    expect(intent.destination?.accountId).toBe(a.stripeAccountId);
    expect(intent.amountCents).toBe(pay.amountCents);
  });

  it("a reader payment has to come from one of the shop's own readers, and is recorded against it", async () => {
    const moline = await shopBySlug("moline");
    const t = await ticket(moline.id);
    const reader = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "terminal" as const, readerId: shopIds.reader };
    await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: reader, actor })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/isn't one of this shop's/),
    });
    const own = await ticket(shopIds.brand);
    await m.checkout.finalizeSale({ saleId: own.sale.id, lines: own.lines, tipCents: 0, tender: reader, actor });
    const pay = await paymentFor(own.sale.id);
    expect(pay).toMatchObject({ terminalReaderId: shopIds.reader, entryMode: "terminal", settlement: "platform" });
    expect(pay.processorFeeCents).toBe(Math.round(pay.amountCents * 0.027) + 5);
  });
});

describe("refunds follow the account the payment settled in, whatever the shop uses now", () => {
  it("a brand-account payment refunds from the brand's account after the shop moves to its own", async () => {
    await signInAs(ids.owner);
    const t = await ticket(shopIds.brand);
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 300, tender: credit, actor });
    const pay = await paymentFor(t.sale.id);
    expect(await setup.setPaymentsModeAction(shopIds.brand, "connected")).toEqual({ ok: true, data: null });
    try {
      await m.checkout.refundSale({ saleId: t.sale.id, items: [], tipCents: 300, refundCardFee: false, reason: "Tip typo", restock: false, actor });
      expect(m.processor.simulatorLedger().refunds.filter((x) => x.paymentIntentId === pay.stripePaymentIntentId)).toEqual([
        expect.objectContaining({ amountCents: 300, reverseTransfer: false }),
      ]);
      const [ref] = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, t.sale.id));
      expect(ref.shopId).toBe(shopIds.brand);
    } finally {
      expect(await setup.setPaymentsModeAction(shopIds.brand, "brand")).toEqual({ ok: true, data: null });
    }
    expect((await audits("payments.mode", shopIds.brand)).map((a) => [(a.details as { from: string }).from, (a.details as { to: string }).to])).toEqual([
      ["brand", "connected"],
      ["connected", "brand"],
    ]);
  });

  it("a connected-account payment still reverses its shop transfer after the shop moves to the brand's account", async () => {
    await signInAs(ids.owner);
    const moline = await shopBySlug("moline");
    const t = await ticket(moline.id);
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 200, tender: credit, actor });
    const pay = await paymentFor(t.sale.id);
    await setup.setPaymentsModeAction(moline.id, "brand");
    try {
      const after = await ticket(moline.id);
      await m.checkout.finalizeSale({ saleId: after.sale.id, lines: after.lines, tipCents: 0, tender: credit, actor });
      expect(await paymentFor(after.sale.id)).toMatchObject({ settlement: "platform", stripeAccountId: null });
      await m.checkout.refundSale({ saleId: t.sale.id, items: [], tipCents: 200, refundCardFee: false, reason: "Tip typo", restock: false, actor });
      expect(m.processor.simulatorLedger().refunds.filter((x) => x.paymentIntentId === pay.stripePaymentIntentId)).toEqual([
        expect.objectContaining({ amountCents: 200, reverseTransfer: false }),
      ]);
      expect(await m.db.db.select().from(m.schema.paymentTransferReversals).where(eq(m.schema.paymentTransferReversals.paymentId, pay.id))).toEqual([
        expect.objectContaining({ kind: "refund", amountCents: 200, status: "sent" }),
      ]);
    } finally {
      await setup.setPaymentsModeAction(moline.id, "connected");
    }
  });
});

describe("webhooks", () => {
  const platformSecret = "whsec_test_platform";
  const connectSecret = "whsec_test_connect";
  const event = (type: string, object: object, account?: string) =>
    JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, ...(account ? { account } : {}), data: { object } });
  const platform = (type: string, object: object) => {
    const payload = event(type, object);
    return m.webhook.handleStripeWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: platformSecret }), platformSecret);
  };
  const connected = (type: string, object: object, account: string) => {
    const payload = event(type, object, account);
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: connectSecret }), connectSecret);
  };

  it("account.updated stores the payout schedule Stripe reports; events for accounts that aren't ours are ignored", async () => {
    const a = (await account(shopIds.connected))!;
    const acct = {
      id: a.stripeAccountId,
      object: "account",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
      settings: { payouts: { schedule: { interval: "weekly", delay_days: 7, weekly_anchor: "friday" } } },
    };
    expect((await connected("account.updated", acct, a.stripeAccountId)).status).toBe(200);
    expect((await account(shopIds.connected))!.payoutSchedule).toMatchObject({ interval: "weekly", delayDays: 7, weeklyAnchor: "friday" });
    const { payoutScheduleLabel } = await import("@/domain/connect");
    expect(payoutScheduleLabel((await account(shopIds.connected))!.payoutSchedule)).toMatch(/^Weekly on Friday/);
    expect(await connected("account.updated", { ...acct, id: "acct_not_ours" }, "acct_not_ours")).toEqual({ status: 200, body: "ignored" });
  });

  it("a payout from the shop's own account lands on that shop; one from the brand's account is a brand payout", async () => {
    const a = (await account(shopIds.connected))!;
    const arrival = Math.floor(Date.now() / 1000) + 86_400;
    await connected("payout.paid", { id: "po_test_clinton", object: "payout", amount: 4_321, status: "paid", arrival_date: arrival, failure_message: null }, a.stripeAccountId);
    await platform("payout.paid", { id: "po_test_brand", object: "payout", amount: 98_765, status: "paid", arrival_date: arrival, failure_message: null });
    await platform("payout.failed", { id: "po_test_brand_failed", object: "payout", amount: 1_234, status: "failed", arrival_date: arrival, failure_message: "The bank account has been closed." });
    const rows = await m.db.db.select().from(m.schema.shopPayouts).where(m.drizzle.inArray(m.schema.shopPayouts.stripePayoutId, ["po_test_clinton", "po_test_brand", "po_test_brand_failed"]));
    expect(rows.find((r) => r.stripePayoutId === "po_test_clinton")).toMatchObject({ shopId: shopIds.connected, stripeAccountId: a.stripeAccountId, amountCents: 4_321 });
    expect(rows.find((r) => r.stripePayoutId === "po_test_brand")).toMatchObject({ shopId: null, stripeAccountId: connect.PLATFORM_ACCOUNT, amountCents: 98_765, status: "paid" });
    expect(rows.find((r) => r.stripePayoutId === "po_test_brand_failed")).toMatchObject({ shopId: null, status: "failed" });
  });

  it("a refund made in Stripe's dashboard on a brand-account charge is booked at the shop it belongs to", async () => {
    const t = await ticket(shopIds.brand);
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: t.lines, tipCents: 0, tender: credit, actor });
    const pay = await paymentFor(t.sale.id);
    const r = await platform("charge.refunded", { id: "ch_x", object: "charge", payment_intent: pay.stripePaymentIntentId, amount_refunded: 1_000, refunds: { data: [{ id: "re_dash_1" }] } });
    expect(r.status).toBe(200);
    const refs = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, t.sale.id));
    expect(refs).toEqual([expect.objectContaining({ shopId: shopIds.brand, amountCents: 1_000, method: "card" })]);
  });
});

describe("permissions", () => {
  it("a shop manager and a Brand Admin can see the account but not change where the money goes", async () => {
    const coralville = await shopBySlug("coralville");
    for (const who of [ids.michelle, ids.admin]) {
      await signInAs(who);
      for (const r of [
        await setup.setPaymentsModeAction(coralville.id, "brand"),
        await setup.saveStatementDescriptorAction(coralville.id, "RAYZ CORAL"),
        await setup.startPaymentsOnboardingAction(coralville.id),
        await setup.expressDashboardAction(coralville.id),
      ])
        expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Only the Brand Owner/) });
    }
    expect((await shopBySlug("coralville")).paymentsMode).toBe("connected");
  });

  it("the owner can grant banking to a Brand Admin, who then can change it; an admin can't pass it on", async () => {
    const perms = await import("@/app/admin/permissions/actions");
    const role = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!.id;
    const coralville = await shopBySlug("coralville");
    await signInAs(ids.owner);
    const give = await perms.saveUserAccessAction({ staffId: ids.admin, roleId: await role("brand_admin"), scope: "all", shopIds: [], overrides: { "payments.banking": true }, maxDiscountPct: null });
    expect(give).toMatchObject({ ok: true });

    await signInAs(ids.admin);
    expect(await setup.saveStatementDescriptorAction(coralville.id, "rayz coralville")).toEqual({ ok: true, data: { descriptor: "RAYZ CORALVILLE" } });
    expect(await audits("payments.statement_descriptor", coralville.id)).toEqual([expect.objectContaining({ actorStaffId: ids.admin, details: expect.objectContaining({ to: "RAYZ CORALVILLE" }) })]);
    const pass = await perms.saveUserAccessAction({
      staffId: ids["manager.moline"],
      roleId: await role("shop_manager"),
      scope: "one",
      shopIds: [(await shopBySlug("moline")).id],
      overrides: { "payments.banking": true },
      maxDiscountPct: null,
    });
    expect(pass).toMatchObject({ ok: false, error: expect.stringMatching(/Only the Brand Owner can grant or remove/) });
  });
});

describe("reports and payouts", () => {
  it("Shop P&L counts brand-account takings and Stripe's fee at the shop, not as unrouted", async () => {
    const today = m.time.todayLocal();
    const [row] = await accountReport.shopAccountRows({ shopIds: [shopIds.brand], from: today, to: today });
    const pays = await m.db.db.select().from(m.schema.payments).where(m.drizzle.and(eq(m.schema.payments.shopId, shopIds.brand), eq(m.schema.payments.method, "card")));
    const refs = await m.db.db.select().from(m.schema.refunds).where(m.drizzle.and(eq(m.schema.refunds.shopId, shopIds.brand), eq(m.schema.refunds.method, "card")));
    const card = pays.reduce((a, p) => a + p.amountCents, 0) - refs.reduce((a, r) => a + r.amountCents, 0);
    expect(row).toMatchObject({ paymentsMode: "brand", canCharge: true, unroutedCardCents: 0, cardNetCents: card, brandSettledCents: card });
    expect(row.processingFeesCents).toBe(pays.reduce((a, p) => a + (p.processorFeeCents ?? 0), 0));
    expect(row.brandFeesCents).toBe(row.processingFeesCents);
    expect(row.toAccountCents).toBe(card - row.processingFeesCents);
  });

  it("the brand account's payouts are only shown with every shop", async () => {
    const today = m.time.todayLocal();
    const scope = { shopIds: [shopIds.brand, shopIds.connected], from: today, to: m.time.addDays(today, 3) };
    expect((await accountReport.payoutRows(scope)).map((p) => p.stripePayoutId)).toEqual(["po_test_clinton"]);
    expect((await accountReport.payoutRows(scope, { brand: true })).map((p) => p.stripePayoutId).sort()).toEqual(["po_test_brand", "po_test_brand_failed", "po_test_clinton"]);
  });

  it("the payouts page shows each account and the brand's, and Today flags the failed brand payout", async () => {
    await signInAs(ids.owner);
    const page = await open("/admin/payouts", {}, { shop: "all", to: m.time.addDays(m.time.todayLocal(), 3) });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Brand account");
    expect(page.text).toContain("po_test_brand");
    expect(page.text).toContain("Clinton");
    expect(page.text).toContain("Weekly on Friday");

    const one = await open("/admin/payouts", {}, { shop: shopIds.connected, to: m.time.addDays(m.time.todayLocal(), 3) });
    expect(one.kind).toBe("ok");
    expect(one.text).toContain("po_test_clinton");
    expect(one.text).not.toContain("po_test_brand");

    const today = await import("@/server/today");
    const { getStaffContext } = await import("@/server/auth/staff");
    const alerts = await today.todayAlerts(today.viewerOf((await getStaffContext())!), new Date());
    expect(alerts.find((a) => a.key === "failed_payout:po_test_brand_failed")).toMatchObject({ type: "failed_payouts", severity: "high", shopId: null });
    expect(alerts.some((a) => a.type === "not_taking_cards" && (a.shopId === shopIds.cash || a.shopId === shopIds.brand))).toBe(false);

    await signInAs(ids.makenna);
    expect((await open("/admin/payouts")).kind).toBe("denied");
  });

  it("the setup page shows the shop's descriptor, the brand's payout schedule and its Terminal location; the receipt uses the shop's branding", async () => {
    await signInAs(ids.owner);
    const page = await open("/admin/setup", {}, { shop: shopIds.brand });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("RAYZ IOWA CITY");
    expect(page.text).toContain("Daily, 2 days after the charge");
    expect(page.text).toContain((await shop(shopIds.brand)).stripeTerminalLocationId!);
    const overview = await open("/admin/setup");
    expect(overview.text).toMatch(/Muscatine[\s\S]*Cash only/);

    const [sale] = await m.db.db.select().from(m.schema.sales).where(m.drizzle.and(eq(m.schema.sales.shopId, shopIds.brand), eq(m.schema.sales.status, "paid"))).limit(1);
    const receipt = await open("/admin/sales/[id]", { id: sale.id });
    expect(receipt.kind).toBe("ok");
    expect(receipt.text).toContain("Ray'z Iowa City");
    expect(receipt.text).toContain("See you in three weeks");
    expect(receipt.text).not.toContain("Book again at rayzbarbershop.com");
  });
});
