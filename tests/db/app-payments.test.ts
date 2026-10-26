/**
 * Cards and paying in the app (C6–C8, I11, I1) against a real database, on the simulator: saved
 * cards on the account holder's Stripe Customer (a child's are the parent's), a ticket staff send
 * to the app, the card fee shown before authorizing (credit only; not debit, prepaid or wallets by
 * default), paying with 3-D Secure, the webhook finishing a payment the app never came back to (and
 * refunding one for a ticket paid another way), each Stripe event handled once, the surcharge going
 * back in proportion on a partial refund, and deletion removing the Stripe Customer.
 */
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let P: typeof import("@/server/app-pay");
let C: typeof import("@/server/payments/saved-cards");
let proc: typeof import("@/server/payments/processor");
let wh: typeof import("@/server/payments/webhook");
let cardsRoute: typeof import("@/app/api/v1/me/payment-methods/route");
let setupRoute: typeof import("@/app/api/v1/me/payment-methods/setup/route");
let ticketRoute: typeof import("@/app/api/v1/me/tickets/[id]/route");
let quoteRoute: typeof import("@/app/api/v1/me/tickets/[id]/quote/route");
let payRoute: typeof import("@/app/api/v1/me/tickets/[id]/pay/route");
const fx = { shopId: "", michelle: "", cut: { id: "", priceCents: 0 } };
let seq = 0;
const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });
const by = () => ({ actor: { staffId: fx.michelle, label: "test" }, staffId: fx.michelle, canDiscount: false, canOverridePrice: false, maxManualDiscountPct: 0 });
const draft = () => ({
  lines: [{ kind: "service" as const, refId: fx.cut.id, qty: 1 }],
  promoCode: null,
  manualDiscount: null,
  loyaltyRewardId: null,
  giftCard: null,
  rebookInWeeks: null,
  tipSplit: null,
});

async function auth(id: string) {
  const { accessToken } = await m.auth.issueTokens(id, "phone");
  return { authorization: `Bearer ${accessToken}`, "x-client": "ios", "x-app-version": "2.4.0" };
}

beforeAll(async () => {
  m = await loadModules();
  P = await import("@/server/app-pay");
  C = await import("@/server/payments/saved-cards");
  proc = await import("@/server/payments/processor");
  wh = await import("@/server/payments/webhook");
  cardsRoute = await import("@/app/api/v1/me/payment-methods/route");
  setupRoute = await import("@/app/api/v1/me/payment-methods/setup/route");
  ticketRoute = await import("@/app/api/v1/me/tickets/[id]/route");
  quoteRoute = await import("@/app/api/v1/me/tickets/[id]/quote/route");
  payRoute = await import("@/app/api/v1/me/tickets/[id]/pay/route");
  const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
  fx.shopId = shop.id;
  await m.db.db.update(s().shops).set({ cardFeeEnabled: true, cardFeeRate: "0.03", cardFeeAppliesToTip: false }).where(eq(s().shops.id, shop.id));
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  const menu = await m.catalog.shopCatalog(shop.id);
  const cut = menu.find((x) => x.kind === "service" && x.priceCents >= 2000)!;
  fx.cut = { id: cut.id, priceCents: cut.priceCents };
}, 180_000);

afterAll(async () => {
  delete process.env.FEATURE_WALLET_FEE;
  await m?.db.closeDb();
});

async function client(o: Partial<typeof m.schema.customers.$inferInsert> = {}) {
  const n = String(1000 + ++seq + Math.floor(Math.random() * 8000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Paige", lastName: "Payer", phone: `+1641556${n}`, ...o })
    .returning();
  return c;
}

/** An open ticket for this client, sent to their app. */
async function sentTicket(customerId: string) {
  const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
  await m.db.db.update(s().sales).set({ customerId }).where(eq(s().sales.id, sale.id));
  const sent = await P.sendToApp(sale.id, draft(), by());
  return { saleId: sale.id, id: sent.id };
}

const fee = (cents: number) => Math.round(cents * 0.03);

describe("saved cards (C6)", () => {
  it("live on the holder's own Stripe Customer; a child's account uses the parent's", async () => {
    const parent = await client({ firstName: "Gina" });
    const child = await client({ firstName: "Gus", guardianId: parent.id, phone: null });
    const setup = await setupRoute.POST(req("/api/v1/me/payment-methods/setup", { method: "POST", headers: await auth(parent.id), body: "{}" }), ctx({}));
    expect(setup.status).toBe(200);
    const sj = await setup.json();
    expect(sj).toMatchObject({ mode: "simulator", merchantCountryCode: "US", ephemeralKeySecret: null });
    expect(sj.customerId).toMatch(/^sim_cus_/);
    expect(sj.testCards.map((c: { id: string }) => c.id)).toContain("pm_card_visa_debit");
    const again = await C.startCardSetup(child.id);
    expect(again.customerId).toBe(sj.customerId);

    const saved = await cardsRoute.POST(req("/api/v1/me/payment-methods", { method: "POST", headers: await auth(parent.id), body: JSON.stringify({ paymentMethodId: "pm_card_visa" }) }), ctx({}));
    expect(saved.status).toBe(201);
    expect((await saved.json()).paymentMethod).toMatchObject({ brand: "visa", last4: "4242", funding: "credit", isDefault: true });
    await C.saveCard(child.id, { paymentMethodId: "pm_card_visa_debit" });
    await expect(C.saveCard(parent.id, { paymentMethodId: "pm_card_chargeDeclined" })).rejects.toThrow(/test cards/);

    const list = await (await cardsRoute.GET(req("/api/v1/me/payment-methods", { headers: await auth(child.id) }), ctx({}))).json();
    expect(list.paymentMethods.map((c: { last4: string }) => c.last4)).toEqual(["4242", "5556"]);
    expect(list.reAddPrompt).toBe(false);
    const rows = await m.db.db.select().from(s().customerCards).where(eq(s().customerCards.customerId, child.id));
    expect(rows).toHaveLength(0);

    const debit = list.paymentMethods.find((c: { last4: string }) => c.last4 === "5556");
    await C.setDefaultCard(parent.id, debit.id);
    await C.removeCard(parent.id, debit.id);
    const after = await C.listCards(parent.id);
    expect(after.map((c) => [c.last4, c.isDefault])).toEqual([["4242", true]]);
    expect((await C.recordDetached("pm_card_visa")).outcome).toBe("detached");
    expect(await C.listCards(parent.id)).toEqual([]);
  });

  it("a client who came over from Squire is asked to add a card again (C14)", async () => {
    const c = await client();
    await m.db.db.insert(s().customerSquireIds).values({ squireId: `sq_${c.id.slice(0, 8)}`, customerId: c.id });
    expect(await C.reAddCardPrompt(c.id)).toBe(true);
    await C.saveCard(c.id, { paymentMethodId: "pm_card_mastercard" });
    expect(await C.reAddCardPrompt(c.id)).toBe(false);
  });
});

describe("paying a ticket in the app (C7, C8)", () => {
  it("is sent only to a client signed in to the app, and lists for them and their parent", async () => {
    const off = await client();
    const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
    await m.db.db.update(s().sales).set({ customerId: off.id }).where(eq(s().sales.id, sale.id));
    await expect(P.sendToApp(sale.id, draft(), by())).rejects.toThrow(/isn't signed in to the Ray'z app/);

    const parent = await client({ firstName: "Rita" });
    const kid = await client({ firstName: "Remy", guardianId: parent.id, phone: null });
    await auth(parent.id);
    const t = await sentTicket(kid.id);
    const mine = await P.myOpenTickets(parent.id);
    expect(mine.find((x) => x.id === t.id)).toMatchObject({ forFirstName: "Remy", dueCents: fx.cut.priceCents + (await taxOn(t.saleId)) });
    const res = await ticketRoute.GET(req(`/api/v1/me/tickets/${t.id}`, { headers: await auth(parent.id) }), ctx({ id: t.id }));
    const j = (await res.json()).ticket;
    expect(j).toMatchObject({ status: "open", cardFee: { enabled: true, rate: 0.03, walletFee: false } });
    expect(j.tips.choices.length).toBeGreaterThan(0);
    const stranger = await client();
    expect((await ticketRoute.GET(req(`/api/v1/me/tickets/${t.id}`, { headers: await auth(stranger.id) }), ctx({ id: t.id }))).status).toBe(404);
  });

  it("shows the fee before authorizing: credit pays it, debit, prepaid and wallets don't (until the owner turns the wallet fee on)", async () => {
    const c = await client();
    await auth(c.id);
    await C.saveCard(c.id, { paymentMethodId: "pm_card_visa" });
    const t = await sentTicket(c.id);
    const quote = async (paymentMethodId: string) => {
      const r = await quoteRoute.POST(
        req(`/api/v1/me/tickets/${t.id}/quote`, { method: "POST", headers: await auth(c.id), body: JSON.stringify({ tipChoice: "none", paymentMethodId }) }),
        ctx({ id: t.id }),
      );
      expect(r.status).toBe(200);
      return (await r.json()).quote;
    };
    const credit = await quote("pm_card_visa");
    expect(credit).toMatchObject({ feeReason: "applies", card: { funding: "credit", saved: true } });
    expect(credit.feeCents).toBe(fee(credit.dueCents));
    expect(credit.totalCents).toBe(credit.dueCents + credit.feeCents);
    expect(await quote("ctoken_sim_visa_debit")).toMatchObject({ feeCents: 0, feeReason: "not_credit" });
    expect(await quote("ctoken_sim_mastercard_prepaid")).toMatchObject({ feeCents: 0, feeReason: "not_credit" });
    expect(await quote("ctoken_sim_apple_pay")).toMatchObject({ feeCents: 0, feeReason: "wallet_fee_off", card: { wallet: "apple_pay" } });
    // A wallet pays it only with the flag on and the brand's policy turning that wallet on.
    const cf = await import("@/server/payments/card-fee");
    const { DEFAULT_CARD_FEE_POLICY } = await import("@/domain/card-fee-policy");
    process.env.FEATURE_WALLET_FEE = "true";
    try {
      expect((await quote("ctoken_sim_google_pay")).feeReason).toBe("wallet_fee_off");
      await cf.saveBrandFeePolicy(actor, { ...DEFAULT_CARD_FEE_POLICY, funding: { ...DEFAULT_CARD_FEE_POLICY.funding, googlePay: true } });
      expect((await quote("ctoken_sim_google_pay")).feeReason).toBe("applies");
      expect((await quote("ctoken_sim_apple_pay")).feeReason).toBe("wallet_fee_off");
    } finally {
      delete process.env.FEATURE_WALLET_FEE;
      await cf.saveBrandFeePolicy(actor, DEFAULT_CARD_FEE_POLICY);
    }
    const r = await quoteRoute.POST(
      req(`/api/v1/me/tickets/${t.id}/quote`, { method: "POST", headers: await auth(c.id), body: JSON.stringify({ tipChoice: "none", paymentMethodId: "pm_card_amex" }) }),
      ctx({ id: t.id }),
    );
    expect(r.status).toBe(403);
  });

  it("pays with a saved card: the guardian is the payer, the receipt goes to the app, the counter sees it paid", async () => {
    const parent = await client({ firstName: "Hal" });
    const kid = await client({ firstName: "Hank", guardianId: parent.id, phone: null });
    await auth(parent.id);
    await C.saveCard(parent.id, { paymentMethodId: "pm_card_visa" });
    const t = await sentTicket(kid.id);
    const q = await P.quoteTicket(parent.id, t.id, { tipChoice: "custom", tipCents: 500, paymentMethodId: "pm_card_visa" });
    const stale = await payRoute.POST(
      req(`/api/v1/me/tickets/${t.id}/pay`, {
        method: "POST",
        headers: await auth(parent.id),
        body: JSON.stringify({ tipChoice: "custom", tipCents: 500, paymentMethodId: "pm_card_visa", expectedTotalCents: q.totalCents - 1 }),
      }),
      ctx({ id: t.id }),
    );
    expect(stale.status).toBe(409);
    expect(await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId))).toHaveLength(0);
    const res = await payRoute.POST(
      req(`/api/v1/me/tickets/${t.id}/pay`, {
        method: "POST",
        headers: await auth(parent.id),
        body: JSON.stringify({ tipChoice: "custom", tipCents: 500, paymentMethodId: "pm_card_visa", expectedTotalCents: q.totalCents }),
      }),
      ctx({ id: t.id }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe("paid");
    expect(j.receipt).toMatchObject({ totalCents: q.totalCents, tipCents: 500, forFirstName: "Hank" });
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, t.saleId));
    expect(pay).toMatchObject({ method: "card", payerCustomerId: parent.id, cardFunding: "credit", cardFeeCents: q.feeCents, amountCents: q.chargeCents });
    const ap = (await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId)))[0];
    expect(ap).toMatchObject({ status: "succeeded", stripePaymentIntentId: pay.stripePaymentIntentId });
    expect(proc.simulatedIntent(pay.stripePaymentIntentId!)?.customerId).toBe((await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, parent.id) }))!.stripeCustomerId);
    const h = (await m.db.db.select().from(s().checkoutHandoffs).where(eq(s().checkoutHandoffs.id, t.id)))[0];
    expect(h).toMatchObject({ status: "paid", via: "app", tipCents: 500 });
    const rd = await m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, t.saleId));
    expect(rd.map((r) => r.channel)).toEqual(["app"]);
    // Paying again is answered with the same receipt rather than a second charge.
    await expect(P.payTicket(parent.id, t.id, { tipChoice: "none", paymentMethodId: "pm_card_visa", expectedTotalCents: q.totalCents })).rejects.toThrow(/paid/);
  });

  it("3-D Secure comes back to the app, which finishes it with the intent", async () => {
    const c = await client();
    await auth(c.id);
    const t = await sentTicket(c.id);
    const q = await P.quoteTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required" });
    const first = await P.payTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required", expectedTotalCents: q.totalCents });
    expect(first.status).toBe("requires_action");
    if (first.status !== "requires_action") return;
    expect(first.clientSecret).toContain("_secret_");
    expect((await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, t.saleId) }))!.status).toBe("open");
    await expect(P.payTicket(c.id, t.id, { tipChoice: "none", paymentIntentId: first.paymentIntentId })).resolves.toMatchObject({ status: "requires_action" });
    proc.simulateNextAction(first.paymentIntentId);
    const done = await P.payTicket(c.id, t.id, { tipChoice: "none", paymentIntentId: first.paymentIntentId });
    expect(done.status).toBe("paid");
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, t.saleId));
    expect(pay.stripePaymentIntentId).toBe(first.paymentIntentId);
  });

  it("a declined card fails without touching the ticket", async () => {
    const c = await client();
    await auth(c.id);
    const t = await sentTicket(c.id);
    const q = await P.quoteTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_chargeDeclined" });
    await expect(P.payTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_chargeDeclined", expectedTotalCents: q.totalCents })).rejects.toThrow(/declined/);
    expect((await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId)))[0]).toMatchObject({ status: "failed", failureCode: "card_declined" });
    expect((await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, t.saleId) }))!.status).toBe("open");
  });
});

describe("app payment webhooks (I11)", () => {
  const secret = "whsec_test_app_payments";
  const deliver = async (type: string, object: object, id = `evt_${Math.random().toString(36).slice(2)}`) => {
    const payload = JSON.stringify({ id, object: "event", type, data: { object } });
    return wh.handleStripeWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };

  it("finishes a payment the app never came back to, once, however often Stripe sends it", async () => {
    const c = await client();
    await auth(c.id);
    const t = await sentTicket(c.id);
    const q = await P.quoteTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required" });
    const first = await P.payTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required", expectedTotalCents: q.totalCents });
    if (first.status !== "requires_action") throw new Error("expected requires_action");
    proc.simulateNextAction(first.paymentIntentId);
    const ap = (await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId)))[0];
    const pi = { id: first.paymentIntentId, object: "payment_intent", metadata: { appPaymentId: ap.id, saleId: t.saleId } };
    const r1 = await deliver("payment_intent.succeeded", pi, "evt_app_once");
    expect(r1).toEqual({ status: 200, body: "paid" });
    expect(await deliver("payment_intent.succeeded", pi, "evt_app_once")).toEqual({ status: 200, body: "duplicate" });
    expect(await deliver("payment_intent.succeeded", pi)).toEqual({ status: 200, body: "already_paid" });
    expect(await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, t.saleId))).toHaveLength(1);
    const [ev] = await m.db.db.select().from(s().stripeEvents).where(eq(s().stripeEvents.id, "evt_app_once"));
    expect(ev).toMatchObject({ attempts: 2, outcome: "paid" });
    expect(ev.processedAt).not.toBeNull();
  });

  it("refunds a payment that went through after the shop took the ticket back", async () => {
    const c = await client();
    await auth(c.id);
    const t = await sentTicket(c.id);
    const q = await P.quoteTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required" });
    const first = await P.payTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required", expectedTotalCents: q.totalCents });
    if (first.status !== "requires_action") throw new Error("expected requires_action");
    await (await import("@/server/handoff")).endHandoffFromCounter(t.saleId, actor);
    proc.simulateNextAction(first.paymentIntentId);
    const ap = (await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId)))[0];
    expect(await deliver("payment_intent.succeeded", { id: first.paymentIntentId, object: "payment_intent", metadata: { appPaymentId: ap.id } })).toEqual({ status: 200, body: "refunded_stray" });
    expect(proc.simulatorLedger().refunds.some((r) => r.paymentIntentId === first.paymentIntentId && r.amountCents === q.chargeCents)).toBe(true);
    expect((await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.id, ap.id)))[0].status).toBe("refunded");
  });

  it("payment_failed marks it and tells the client; setup_intent.succeeded and payment_method.detached keep cards in step", async () => {
    const c = await client();
    await auth(c.id);
    const t = await sentTicket(c.id);
    const q = await P.quoteTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required" });
    const first = await P.payTicket(c.id, t.id, { tipChoice: "none", paymentMethodId: "ctoken_sim_threeDSecure2Required", expectedTotalCents: q.totalCents });
    if (first.status !== "requires_action") throw new Error("expected requires_action");
    const ap = (await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.saleId, t.saleId)))[0];
    const failed = await deliver("payment_intent.payment_failed", {
      id: first.paymentIntentId,
      object: "payment_intent",
      metadata: { appPaymentId: ap.id },
      last_payment_error: { code: "authentication_required" },
    });
    expect(failed.body).toBe("failed");
    expect((await m.db.db.select().from(s().appPayments).where(eq(s().appPayments.id, ap.id)))[0]).toMatchObject({ status: "failed", failureCode: "authentication_required" });

    const stripeCustomer = await C.ensureStripeCustomer(c.id);
    expect((await deliver("setup_intent.succeeded", { id: "seti_x", object: "setup_intent", customer: stripeCustomer, payment_method: "pm_card_amex" })).body).toBe("saved");
    expect((await C.listCards(c.id)).map((x) => x.last4)).toEqual(["8431"]);
    expect((await deliver("payment_method.detached", { id: "pm_card_amex", object: "payment_method" })).body).toBe("detached");
    expect(await C.listCards(c.id)).toEqual([]);
  });
});

describe("the surcharge on a refund, and deletion", () => {
  it("a partial refund gives back the surcharge's share; refunding the rest gives back the rest", async () => {
    const c = await client();
    const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
    await m.db.db.update(s().sales).set({ customerId: c.id }).where(eq(s().sales.id, sale.id));
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [{ kind: "service", refId: fx.cut.id, qty: 2 }],
      tipCents: 0,
      tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" },
      actor,
    });
    const paid = (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, sale.id) }))!;
    expect(paid.cardFeeCents).toBeGreaterThan(0);
    const [item] = await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, sale.id));
    const r1 = await m.checkout.refundSale({ saleId: sale.id, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: "proportional", reason: "One cut redone", restock: false, actor });
    const half = Math.round(paid.cardFeeCents / 2);
    const [first] = await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, sale.id));
    expect(first.cardFeeCents).toBe(half);
    expect(r1.refundedCents).toBe(Math.round((paid.totalCents - paid.cardFeeCents) / 2) + half);
    await m.checkout.refundSale({ saleId: sale.id, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: "proportional", reason: "Both", restock: false, actor });
    const all = await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, sale.id));
    expect(all.reduce((a, r) => a + r.cardFeeCents, 0)).toBe(paid.cardFeeCents);
  });

  it("deleting the account removes the Stripe Customer and its cards", async () => {
    const c = await client();
    await C.saveCard(c.id, { paymentMethodId: "pm_card_visa" });
    const del = await import("@/server/account-deletion");
    const preview = await del.deletionPreview(c.id);
    expect(preview.consequences.join(" ")).toMatch(/saved card is removed/);
    await del.deleteAccount({ staffId: null, label: "customer:test" }, c.id, { source: "app" });
    const after = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, c.id) }))!;
    expect(after.stripeCustomerId).toBeNull();
    expect(await C.listCards(c.id)).toEqual([]);
  });
});

async function taxOn(saleId: string) {
  const v = await (await import("@/server/handoff")).handoffView((await m.db.db.select().from(s().checkoutHandoffs).where(eq(s().checkoutHandoffs.saleId, saleId)))[0].id);
  return v.taxCents;
}
