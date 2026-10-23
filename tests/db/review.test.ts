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

describe("P1#9–10 payroll and reports are net of refunds", () => {
  async function coralvilleBarber(shopId: string) {
    const [link] = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.shopId, shopId)).limit(1);
    return link.staffId;
  }
  const at = (d: string) => new Date(`${d}T18:00:00Z`);

  it("a card tip refunded in a later pay period nets out there, with its own row", async () => {
    const s = await shop();
    const staffId = await coralvilleBarber(s.id);
    const sale = await m.checkout.openBlankSale(s.id, actor, staffId);
    const svc = await cut(s.id);
    await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 1000, tender: credit, actor, now: at("2026-09-26") });
    const scope = { shopIds: [s.id], staffId };
    const sept = await m.reports.payrollTips({ ...scope, from: "2026-09-20", to: "2026-10-03" });
    const row = sept.rows.find((r) => r.staffId === staffId)!;
    expect(row.cardTipsCents).toBe(1000);

    await m.checkout.refundSale({ saleId: sale.id, items: [], tipCents: 1000, refundCardFee: false, reason: "Tip entered twice", restock: false, actor, now: at("2027-06-12") });
    const sept2 = await m.reports.payrollTips({ ...scope, from: "2026-09-20", to: "2026-10-03" });
    expect(sept2.rows.find((r) => r.staffId === staffId)!.cardTipsCents).toBe(1000);
    const june = await m.reports.payrollTips({ ...scope, from: "2027-06-06", to: "2027-06-19" });
    const j = june.rows.find((r) => r.staffId === staffId)!;
    expect(j).toMatchObject({ tickets: 0, cardTipsCents: -1000, cashTipsCents: 0, tipRefundsCents: 1000, totalTipsCents: -1000, serviceSalesCents: 0 });
  });

  it("a service refund in the same period nets service sales and the tender column that took the tip", async () => {
    const s = await shop();
    const staffId = await coralvilleBarber(s.id);
    const sale = await m.checkout.openBlankSale(s.id, actor, staffId);
    const svc = await cut(s.id);
    await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 600, tender: cash, actor, now: at("2027-01-05") });
    const item = (await m.checkout.refundableState(sale.id)).items[0];
    await m.checkout.refundSale({ saleId: sale.id, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 600, refundCardFee: false, reason: "Redo", restock: false, actor, now: at("2027-01-06") });
    const r = await m.reports.payrollTips({ shopIds: [s.id], staffId, from: "2027-01-03", to: "2027-01-16" });
    expect(r.rows.find((x) => x.staffId === staffId)).toMatchObject({ tickets: 1, serviceSalesCents: 0, cashTipsCents: 0, totalTipsCents: 0, tipRefundsCents: 600 });
  });

  it("tickets imported from Squire never reach payroll tips or sales", async () => {
    const s = await shop();
    const staffId = await coralvilleBarber(s.id);
    const svc = await cut(s.id);
    const ours = await m.checkout.openBlankSale(s.id, actor, staffId);
    await m.checkout.finalizeSale({ saleId: ours.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 300, tender: cash, actor, now: at("2027-04-06") });
    const squire = await m.checkout.openBlankSale(s.id, actor, staffId);
    await m.checkout.finalizeSale({ saleId: squire.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 900, tender: credit, actor, now: at("2027-04-07") });
    await m.db.db.update(m.schema.sales).set({ isImported: true }).where(eq(m.schema.sales.id, squire.id));

    const r = await m.reports.payrollTips({ shopIds: [s.id], staffId, from: "2027-04-04", to: "2027-04-17" });
    const rows = r.rows.filter((x) => x.staffId === staffId);
    expect(rows.reduce((t, x) => t + x.tickets, 0)).toBe(1);
    expect(rows.reduce((t, x) => t + x.cardTipsCents, 0)).toBe(0);
    expect(rows.reduce((t, x) => t + x.cashTipsCents, 0)).toBe(300);
    expect(rows.reduce((t, x) => t + x.serviceSalesCents, 0)).toBe(svc.priceCents);
  });

  it("credit/debit split, daily, monthly, and per-shop totals all subtract refunds and agree with the summary", async () => {
    const s = await shop();
    const svc = await cut(s.id);
    const a = await m.checkout.openBlankSale(s.id, actor);
    await m.checkout.finalizeSale({ saleId: a.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 0, tender: credit, actor, now: at("2027-02-02") });
    const b = await m.checkout.openBlankSale(s.id, actor);
    await m.checkout.finalizeSale({ saleId: b.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents: 0, tender: { ...credit, paymentMethodId: "pm_card_visa_debit" }, actor, now: at("2027-02-02") });
    const out = await m.checkout.refundEverything(a.id, "Wrong client", false, actor, at("2027-02-03"));

    const scope = { shopIds: [s.id], from: "2027-02-01", to: "2027-02-28" };
    const [sum, tender, daily, monthly, shops] = await Promise.all([
      m.reports.salesSummary(scope),
      m.reports.tenderBreakdown(scope),
      m.reports.dailyTotals(scope),
      m.reports.monthlyTotals(scope),
      m.reports.byShop(scope),
    ]);
    expect(tender.cardCreditCents).toBe(0);
    expect(tender.cardCreditCents + tender.cardDebitCents).toBe(tender.cardCents);
    expect(out.refundedCents).toBeGreaterThan(0);
    const total = <T>(xs: T[], f: (x: T) => number) => xs.reduce((acc, x) => acc + f(x), 0);
    expect(daily.find((d) => d.day === "2027-02-03")).toMatchObject({ tickets: 0, netCents: -svc.priceCents });
    expect(total(daily, (d) => d.netCents)).toBe(sum.netSalesCents);
    expect(total(daily, (d) => d.cardCents)).toBe(tender.cardCents);
    expect(total(monthly, (x) => x.netServicesCents)).toBe(sum.netServicesCents);
    expect(shops.find((x) => x.shopId === s.id)!.netServicesCents).toBe(sum.netServicesCents);
    expect(sum.netServicesCents).toBe(svc.priceCents);
  });
});

describe("P1#19 sign-in codes never land in the outbox", () => {
  it("stores a redacted body", async () => {
    const auth = await import("@/server/auth/customer");
    const phone = "+13195553999";
    await auth.startOtp({ phone });
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.and(eq(m.schema.notificationJobs.to, phone), eq(m.schema.notificationJobs.kind, "otp")));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].body).not.toMatch(/\d{6}/);
    expect(jobs[0].status).not.toBe("pending");
  });
});

describe("P2/P3 booking rules", () => {
  async function openSlot() {
    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
    for (let i = 4; i < 20; i++) {
      const date = m.time.addDays(m.time.todayLocal(), i);
      const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
      if (a.slots.length > 4) return { date, slot: a.slots[a.slots.length - 1], svc };
    }
    throw new Error("no slots");
  }
  const book = (svc: { id: string }, barberRef: string, startsAt: string | Date, source: "online" | "staff" = "online") =>
    m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef, startsAt, customer: { firstName: "Rule", phone: `+1319555${String(3500 + ++phoneSeq)}` }, source, actor });

  it("P2#22: the database enforces the buffer, not just the app", async () => {
    const { slot } = await openSlot();
    const s = await shop();
    const start = new Date(slot.startsAt);
    const end = new Date(start.getTime() + 30 * 60_000);
    const base = { staffId: slot.barberIds[0], shopId: s.id, status: "booked" as const, source: "staff" as const };
    const [first] = await m.db.db.insert(m.schema.appointments).values({ ...base, code: "TESTBUFF01", startsAt: start, endsAt: end, bufferMinutes: 15 }).returning();
    expect(first.busyUntil!.getTime()).toBe(end.getTime() + 15 * 60_000);
    const inside = new Date(end.getTime() + 10 * 60_000);
    await expect(m.db.db.insert(m.schema.appointments).values({ ...base, code: "TESTBUFF02", startsAt: inside, endsAt: new Date(inside.getTime() + 30 * 60_000) })).rejects.toThrow();
    const after = new Date(end.getTime() + 15 * 60_000);
    await m.db.db.insert(m.schema.appointments).values({ ...base, code: "TESTBUFF03", startsAt: after, endsAt: new Date(after.getTime() + 30 * 60_000) });
    // Raising the buffer later can't sneak past the neighbour either.
    await expect(m.db.db.update(m.schema.appointments).set({ bufferMinutes: 20 }).where(eq(m.schema.appointments.id, first.id))).rejects.toThrow();
    await m.db.db.delete(m.schema.appointments).where(m.drizzle.inArray(m.schema.appointments.code, ["TESTBUFF01", "TESTBUFF03"]));
  });

  it("P2#24: bookings must start on an offered time; staff pick any minute only by squeezing in", async () => {
    const { date, svc } = await openSlot();
    // Seven minutes before an offered start, with the barber free from then on: an earlier offered start covers the gap.
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: "any" });
    const ms = (x: { startsAt: string | Date }) => new Date(x.startsAt).getTime();
    const free = a.slots
      .flatMap((s) => s.barberIds.map((b) => ({ s, b })))
      .find(({ s, b }) => a.slots.some((p) => p.barberIds.includes(b) && ms(p) <= ms(s) - 7 * 60_000 && ms(p) + a.durationMin * 60_000 >= ms(s)))!;
    expect(free).toBeDefined();
    const barber = free.b;
    const offGrid = new Date(ms(free.s) - 7 * 60_000);
    await expect(book(svc, barber, offGrid)).rejects.toMatchObject({ code: "bad_request" });
    await expect(book(svc, barber, offGrid, "staff")).rejects.toMatchObject({ code: "bad_request", details: { offGrid: true } });
    const staffBooked = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: barber,
      startsAt: offGrid,
      customer: { firstName: "Rule", phone: `+1319555${String(3500 + ++phoneSeq)}` },
      source: "staff",
      squeezeIn: true,
      actor,
    });
    expect(new Date(staffBooked.startsAt).getTime()).toBe(offGrid.getTime());
    await m.booking.cancelAppointment(staffBooked.code, { actor, byCustomer: false });
  });

  it("P3#33: at exactly the cutoff the manage page and the API both say no", async () => {
    const { slot, svc } = await openSlot();
    const a = await book(svc, slot.barberIds[0], slot.startsAt);
    const atCutoff = new Date(new Date(a.startsAt).getTime() - 30 * 60_000);
    expect((await m.booking.getAppointmentByCode(a.code, atCutoff)).canCancel).toBe(false);
    await expect(m.booking.cancelAppointment(a.code, { actor, byCustomer: true, now: atCutoff })).rejects.toMatchObject({ code: "cutoff_passed" });
    await expect(m.booking.rescheduleAppointment(a.code, { startsAt: a.startsAt, actor, byCustomer: true, now: atCutoff })).rejects.toMatchObject({ code: "cutoff_passed" });
    const justBefore = new Date(atCutoff.getTime() - 1000);
    expect((await m.booking.getAppointmentByCode(a.code, justBefore)).canCancel).toBe(true);
    expect((await m.booking.cancelAppointment(a.code, { actor, byCustomer: true, now: justBefore })).status).toBe("cancelled");
  });

  it("P3#34: a completed appointment frees the chair in the app, as it already did in the database", async () => {
    const { slot, svc } = await openSlot();
    const a = await book(svc, slot.barberIds[0], slot.startsAt);
    await m.db.db.update(m.schema.appointments).set({ status: "completed" }).where(eq(m.schema.appointments.id, a.id));
    const again = await book(svc, slot.barberIds[0], slot.startsAt);
    expect(again.status).toBe("booked");
    await m.booking.cancelAppointment(again.code, { actor, byCustomer: false });
  });

  it("P3#35: staff can't enter a time that doesn't exist on the spring-forward morning", () => {
    expect(() => m.booking.staffWallTime("2027-03-14", 2 * 60 + 30)).toThrow(/doesn't exist/);
    expect(m.booking.staffWallTime("2027-03-14", 3 * 60 + 30).toISOString()).toBe("2027-03-14T08:30:00.000Z");
  });
});

describe("P2#29 stock and promo caps hold under concurrent checkouts", () => {
  it("two tickets racing for the last bottle: one sells it, the other is refused, stock never goes negative", async () => {
    const s = await shop();
    const a = await m.checkout.openBlankSale(s.id, actor);
    const b = await m.checkout.openBlankSale(s.id, actor);
    const product = (await m.checkout.loadCheckoutContext(a.id)).retail.find((p) => p.stock > 0)!;
    const where = m.drizzle.and(eq(m.schema.shopProducts.shopId, s.id), eq(m.schema.shopProducts.productId, product.productId));
    const setTo = (to: number) => m.db.db.transaction((tx) => m.ledger.setOnHand(tx, { shopId: s.id, productId: product.productId, to, kind: "adjust", reason: "count_correction" }, { actor, negative: "allow" }));
    await setTo(1);
    const sell = (saleId: string) => m.checkout.finalizeSale({ saleId, lines: [{ kind: "product", refId: product.productId, qty: 1 }], tipCents: 0, tender: cash, actor });
    const out = await Promise.allSettled([sell(a.id), sell(b.id)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "conflict" });
    expect((await m.db.db.query.shopProducts.findFirst({ where }))!.stock).toBe(0);
    await setTo(product.stock);
  });

  it("a one-use promo applied on two tickets at once is redeemed once", async () => {
    await m.db.db.insert(m.schema.promoCodes).values({ code: "ONCEONLY", type: "amount", value: 500, maxRedemptions: 1 });
    const a = await ticket();
    const b = await ticket();
    const pay = (t: Awaited<ReturnType<typeof ticket>>) =>
      m.checkout.finalizeSale({ saleId: t.sale.id, lines: [{ kind: "service", refId: t.svc.id, qty: 1 }], promoCode: "ONCEONLY", tipCents: 0, tender: cash, actor });
    const out = await Promise.allSettled([pay(a), pay(b)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const p = await m.db.db.query.promoCodes.findFirst({ where: eq(m.schema.promoCodes.code, "ONCEONLY") });
    expect(p!.redemptions).toBe(1);
  });
});
