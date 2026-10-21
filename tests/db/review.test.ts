/**
 * Regression tests for the PR #1 review. Each test reproduces the bug it's named after
 * and fails on the old code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

async function shop(slug = "coralville") {
  return (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;
}

async function cut(shopId: string) {
  const menu = await m.catalog.shopCatalog(shopId);
  return menu.find((s) => s.slug === "rayz-cut-shampoo")!;
}

let phoneSeq = 0;
async function client(firstName: string, progressCents = 0) {
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName, lastName: "Review", phone: `+1319555${String(3000 + ++phoneSeq).padStart(4, "0")}` })
    .returning();
  if (progressCents) await m.db.db.insert(m.schema.loyaltyAccounts).values({ customerId: c.id, progressCents, lastEarnAt: new Date() });
  return c;
}

async function ticket(opts: { customerId?: string | null; slug?: string } = {}) {
  const s = await shop(opts.slug);
  const sale = await m.checkout.openBlankSale(s.id, actor);
  if (opts.customerId) await m.db.db.update(m.schema.sales).set({ customerId: opts.customerId }).where(eq(m.schema.sales.id, sale.id));
  return { sale, shop: s, svc: await cut(s.id) };
}

const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

async function giftCardsFor(saleId: string) {
  const items = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, saleId));
  const cards = await m.db.db.select().from(m.schema.giftCards);
  return cards.filter((c) => items.some((i) => i.id === c.saleItemId));
}

describe("P0#1 checkout prices come from the shop menu", () => {
  it("ignores a client-sent service price", async () => {
    const t = await ticket();
    const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, name: t.svc.name, unitPriceCents: 100, qty: 1 }], tipCents: 0, tender: cash, actor });
    expect(r.totals.lines[0].unitPriceCents).toBe(t.svc.priceCents);
    expect(r.totals.serviceNetCents).toBe(t.svc.priceCents);
    expect(r.totals.totalCents).toBeGreaterThan(107);
  });

  it("refuses a price override from someone who isn't a manager", async () => {
    const t = await ticket();
    await expect(
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1, priceOverride: { unitPriceCents: 0, reason: "friend" } }], tipCents: 0, tender: cash, actor }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const still = await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) });
    expect(still!.status).toBe("open");
  });

  it("applies a manager override with a reason and audits it", async () => {
    const t = await ticket();
    const r = await m.checkout.finalizeSale({
      saleId: t.sale.id,
      lines: [{ kind: "service", refId: t.svc.id, qty: 1, priceOverride: { unitPriceCents: 2500, reason: "Kid's cut" } }],
      tipCents: 0,
      tender: cash,
      canOverridePrice: true,
      actor,
    });
    expect(r.totals.serviceNetCents).toBe(2500);
    const [item] = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, t.sale.id));
    expect(item).toMatchObject({ unitPriceCents: 2500, catalogPriceCents: t.svc.priceCents, overrideReason: "Kid's cut" });
    const log = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.entityId, t.sale.id), eq(m.schema.auditLog.action, "sale.price_override")));
    expect(log).toHaveLength(1);
  });

  it("requires a reason for an override, and rejects services that aren't on this shop's menu", async () => {
    const t = await ticket();
    await expect(
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1, priceOverride: { unitPriceCents: 100, reason: " " } }], tipCents: 0, tender: cash, canOverridePrice: true, actor }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: "00000000-0000-0000-0000-000000000001", qty: 1 }], tipCents: 0, tender: cash, actor }),
    ).rejects.toThrow(/isn't on the/);
  });

  it("bounds gift card face values", async () => {
    const t = await ticket();
    await expect(m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "gift_card", unitPriceCents: 1, qty: 1 }], tipCents: 0, tender: cash, actor })).rejects.toThrow(/Gift cards are sold/);
  });
});

describe("P0#2 a double-submitted checkout charges once and never refunds the winner", () => {
  it("two overlapping card submits: one charge, no refunds, one payment row", async () => {
    const t = await ticket();
    const input = { saleId: t.sale.id, lines: [{ kind: "service" as const, refId: t.svc.id, qty: 1 }], tipCents: 500, tender: credit, actor };
    const results = await Promise.allSettled([m.checkout.finalizeSale(input), m.checkout.finalizeSale(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "conflict" });

    const pays = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, t.sale.id));
    expect(pays).toHaveLength(1);
    const ledger = m.processor.simulatorLedger();
    const intents = ledger.intents.filter((i) => i.metadata.saleId === t.sale.id);
    expect(intents).toHaveLength(1);
    expect(intents[0].id).toBe(pays[0].stripePaymentIntentId);
    expect(intents[0].amountRefundedCents).toBe(0);
    expect(ledger.refunds.filter((r) => r.paymentIntentId === intents[0].id)).toHaveLength(0);
  });

  it("a declined card leaves the ticket open with no stock, loyalty, or gift card writes", async () => {
    const c = await client("Declined", 29_000);
    const t = await ticket({ customerId: c.id });
    const ctx = await m.checkout.loadCheckoutContext(t.sale.id);
    const product = ctx.retail.find((p) => p.stock > 2)!;
    await expect(
      m.checkout.finalizeSale({
        saleId: t.sale.id,
        lines: [
          { kind: "service", refId: t.svc.id, qty: 1 },
          { kind: "product", refId: product.productId, qty: 1 },
          { kind: "gift_card", unitPriceCents: 2500, qty: 1 },
        ],
        tipCents: 0,
        tender: { method: "card", paymentMethodId: "pm_card_chargeDeclined", entryMode: "keyed" },
        actor,
      }),
    ).rejects.toMatchObject({ code: "payment_failed" });
    const s = await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) });
    expect(s!.status).toBe("open");
    const stock = await m.db.db.query.shopProducts.findFirst({ where: m.drizzle.and(eq(m.schema.shopProducts.shopId, t.shop.id), eq(m.schema.shopProducts.productId, product.productId)) });
    expect(stock!.stock).toBe(product.stock);
    expect((await m.loyalty.loyaltyBalance(c.id)).progressCents).toBe(29_000);
    expect(await giftCardsFor(t.sale.id)).toHaveLength(0);
  });

  it("the simulator honors idempotency keys and refuses to rebook a refunded intent", async () => {
    const args = { paymentMethodId: "pm_card_visa", amountCents: 1000, description: "t", metadata: {}, idempotencyKey: `test-${Date.now()}` };
    const a = await m.processor.chargeCard(args);
    const b = await m.processor.chargeCard(args);
    expect(b.paymentIntentId).toBe(a.paymentIntentId);
    await m.processor.refundCard(a.paymentIntentId, 1000, `r-${a.paymentIntentId}`);
    await expect(m.processor.chargeCard(args)).rejects.toMatchObject({ code: "payment_failed" });
  });
});

describe("P0#3 refunding a gift card sale voids the card", () => {
  it("full refund of a $50 card voids it", async () => {
    const t = await ticket();
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "gift_card", unitPriceCents: 5000, qty: 1 }], tipCents: 0, tender: cash, actor });
    const [card] = await giftCardsFor(t.sale.id);
    expect((await m.checkout.lookupGiftCard(card.code)).balanceCents).toBe(5000);
    const out = await m.checkout.refundEverything(t.sale.id, "Changed mind", false, actor);
    expect(out.refundedCents).toBe(5000);
    await expect(m.checkout.lookupGiftCard(card.code)).rejects.toThrow(/not found/);
    const s = await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) });
    expect(s!.status).toBe("refunded");
  });

  it("a partly spent card refunds only what's left; a spent card can't be refunded; void refuses a used card", async () => {
    const t = await ticket();
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "gift_card", unitPriceCents: 5000, qty: 2 }], tipCents: 0, tender: cash, actor });
    const cards = await giftCardsFor(t.sale.id);
    expect(cards).toHaveLength(2);
    const t2 = await ticket();
    await m.checkout.finalizeSale({ saleId: t2.sale.id, lines: [{ kind: "service", refId: t2.svc.id, qty: 1 }], tipCents: 0, giftCard: { code: cards[0].code, amountCents: 2000 }, tender: cash, actor });

    await expect(m.checkout.voidSale(t.sale.id, "oops", actor)).rejects.toThrow(/already been used/);

    const item = (await m.checkout.refundableState(t.sale.id)).items[0];
    const out = await m.checkout.refundSale({ saleId: t.sale.id, items: [{ saleItemId: item.id, qty: 2 }], tipCents: 0, refundCardFee: false, reason: "Return", restock: false, actor });
    expect(out.refundedCents).toBe(5000 + 3000);
    for (const c of cards) await expect(m.checkout.lookupGiftCard(c.code)).rejects.toThrow();

    const t3 = await ticket();
    await m.checkout.finalizeSale({ saleId: t3.sale.id, lines: [{ kind: "gift_card", unitPriceCents: 1000, qty: 1 }], tipCents: 0, tender: cash, actor });
    const [spent] = await giftCardsFor(t3.sale.id);
    const t4 = await ticket();
    await m.checkout.finalizeSale({ saleId: t4.sale.id, lines: [{ kind: "service", refId: t4.svc.id, qty: 1 }], tipCents: 0, giftCard: { code: spent.code, amountCents: 1000 }, tender: cash, actor });
    await expect(m.checkout.refundEverything(t3.sale.id, "Return", false, actor)).rejects.toThrow(/fully spent/);
  });
});

describe("P1#5–7 loyalty", () => {
  it("a full refund revokes the reward the sale earned and restores progress", async () => {
    const c = await client("Rewarded", 29_000);
    const t = await ticket({ customerId: c.id });
    const r = await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], tipCents: 0, tender: cash, actor });
    expect(r.rewardsIssued).toBe(1);
    expect((await m.loyalty.loyaltyBalance(c.id)).availableCents).toBe(1500);
    await m.checkout.refundEverything(t.sale.id, "Refund", false, actor);
    const bal = await m.loyalty.loyaltyBalance(c.id);
    expect(bal.availableCents).toBe(0);
    expect(bal.progressCents).toBe(29_000);
  });

  it("a void does the same", async () => {
    const c = await client("Voided", 29_000);
    const t = await ticket({ customerId: c.id });
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], tipCents: 0, tender: cash, actor });
    await m.checkout.voidSale(t.sale.id, "Wrong client", actor);
    const bal = await m.loyalty.loyaltyBalance(c.id);
    expect(bal.availableCents).toBe(0);
    expect(bal.progressCents).toBe(29_000);
  });

  it("two tickets at two shops can't both spend one reward, and concurrent earns don't lose progress", async () => {
    const c = await client("Twice");
    const [reward] = await m.db.db.insert(m.schema.loyaltyRewards).values({ customerId: c.id, amountCents: 1500, source: "manual" }).returning();
    const a = await ticket({ customerId: c.id });
    const b = await ticket({ customerId: c.id, slug: "kimberly" });
    const go = (t: Awaited<ReturnType<typeof ticket>>) =>
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], tipCents: 0, loyaltyRewardId: reward.id, tender: cash, actor });
    const results = await Promise.allSettled([go(a), go(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const d = await client("Parallel");
    const x = await ticket({ customerId: d.id });
    const y = await ticket({ customerId: d.id, slug: "kimberly" });
    const earn = (t: Awaited<ReturnType<typeof ticket>>) => m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], tipCents: 0, tender: cash, actor });
    await Promise.all([earn(x), earn(y)]);
    expect((await m.loyalty.loyaltyBalance(d.id)).progressCents).toBe(x.svc.priceCents + y.svc.priceCents);
  });

  it("a reward that discounts nothing isn't consumed", async () => {
    const c = await client("ProductOnly");
    const [reward] = await m.db.db.insert(m.schema.loyaltyRewards).values({ customerId: c.id, amountCents: 1500, source: "manual" }).returning();
    const t = await ticket({ customerId: c.id });
    const product = (await m.checkout.loadCheckoutContext(t.sale.id)).retail.find((p) => p.stock > 0)!;
    await expect(
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "product", refId: product.productId, qty: 1 }], tipCents: 0, loyaltyRewardId: reward.id, tender: cash, actor }),
    ).rejects.toThrow(/doesn't apply/);
    const after = await m.db.db.query.loyaltyRewards.findFirst({ where: eq(m.schema.loyaltyRewards.id, reward.id) });
    expect(after!.redeemedAt).toBeNull();
  });
});

describe("P1#8 partial refunds follow the chosen line", () => {
  it("refunding the cut on a cut + $50 gift card ticket touches only the cut", async () => {
    const c = await client("Split");
    const t = await ticket({ customerId: c.id });
    const r = await m.checkout.finalizeSale({
      saleId: t.sale.id,
      lines: [
        { kind: "service", refId: t.svc.id, qty: 1 },
        { kind: "gift_card", unitPriceCents: 5000, qty: 1 },
      ],
      tipCents: 800,
      tender: credit,
      actor,
    });
    const st = await m.checkout.refundableState(t.sale.id);
    const svcItem = st.items.find((i) => i.kind === "service")!;
    const out = await m.checkout.refundSale({ saleId: t.sale.id, items: [{ saleItemId: svcItem.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Bad fade", restock: false, actor });
    expect(out.components).toEqual({ serviceNetCents: t.svc.priceCents, productNetCents: 0, giftCardSalesCents: 0, taxCents: r.totals.serviceTaxCents, tipCents: 0, cardFeeCents: 0 });
    const [card] = await giftCardsFor(t.sale.id);
    expect((await m.checkout.lookupGiftCard(card.code)).balanceCents).toBe(5000);
    expect((await m.loyalty.loyaltyBalance(c.id)).progressCents).toBe(0);

    const tip = await m.checkout.refundSale({ saleId: t.sale.id, items: [], tipCents: 800, refundCardFee: true, reason: "Goodwill", restock: false, actor });
    expect(tip.components).toMatchObject({ tipCents: 800, cardFeeCents: r.totals.cardFeeCents, serviceNetCents: 0 });
    await expect(m.checkout.refundSale({ saleId: t.sale.id, items: [{ saleItemId: svcItem.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "again", restock: false, actor })).rejects.toThrow(/already refunded/);
  });
});

describe("P1#20 a refund issued in the Stripe dashboard reaches the books", () => {
  const secret = "whsec_test_review";
  async function deliver(pi: string, amountRefunded: number, id = `evt_${Math.random().toString(36).slice(2)}`) {
    const payload = JSON.stringify({ id, object: "event", type: "charge.refunded", data: { object: { id: "ch_test", object: "charge", payment_intent: pi, amount_refunded: amountRefunded } } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return m.webhook.handleStripeWebhook(payload, header, secret);
  }

  it("records the refund, reverses loyalty, and ignores redelivery and the POS's own refunds", async () => {
    const c = await client("Dashboard");
    const t = await ticket({ customerId: c.id });
    await m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], tipCents: 0, tender: credit, actor });
    const [pay] = await m.db.db.select().from(m.schema.payments).where(eq(m.schema.payments.saleId, t.sale.id));
    expect((await m.loyalty.loyaltyBalance(c.id)).progressCents).toBe(t.svc.priceCents);

    expect((await deliver(pay.stripePaymentIntentId!, 1000, "evt_first")).status).toBe(200);
    const bad = await m.webhook.handleStripeWebhook("{}", "t=1,v1=nope", secret);
    expect(bad.status).toBe(400);

    let refs = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, t.sale.id));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ source: "stripe_dashboard", amountCents: 1000, method: "card" });
    expect(refs[0].serviceNetCents + refs[0].taxCents + refs[0].cardFeeCents).toBe(1000);
    expect((await m.loyalty.loyaltyBalance(c.id)).progressCents).toBe(t.svc.priceCents - refs[0].serviceNetCents);
    expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) }))!.status).toBe("partially_refunded");

    await deliver(pay.stripePaymentIntentId!, 1000);
    refs = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, t.sale.id));
    expect(refs).toHaveLength(1);

    const pos = await m.checkout.refundEverything(t.sale.id, "Rest of it", false, actor);
    const p2 = await m.db.db.query.payments.findFirst({ where: eq(m.schema.payments.id, pay.id) });
    expect(p2!.refundedCents).toBe(pay.amountCents);
    await deliver(pay.stripePaymentIntentId!, pay.amountCents);
    refs = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, t.sale.id));
    expect(refs).toHaveLength(2);
    expect(refs.reduce((a, r) => a + r.amountCents, 0)).toBe(1000 + pos.refundedCents);
    expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, t.sale.id) }))!.status).toBe("refunded");
    expect((await m.loyalty.loyaltyBalance(c.id)).progressCents).toBe(0);
  });
});
