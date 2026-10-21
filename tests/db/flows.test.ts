/**
 * Integration tests against a real Postgres (TEST_DATABASE_URL). Seeds a short history first.
 * Run with: pnpm test:db
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function coralville() {
  const shop = await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") });
  const svc = (await m.public.publicServices("coralville")).services.find((s) => s.slug === "rayz-cut-shampoo")!;
  return { shop: shop!, svc };
}

/** First weekday ≥ 3 days out with at least one opening at Coralville. */
async function openSlot(barber = "any") {
  const { svc } = await coralville();
  for (let i = 3; i < 20; i++) {
    const date = m.time.addDays(m.time.todayLocal(), i);
    const a = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: barber });
    if (a.slots.length) return { date, slot: a.slots[0], svc, avail: a };
  }
  throw new Error("no slots");
}

describe("booking", () => {
  it("public API data never includes surnames", async () => {
    const barbers = await m.public.publicShops();
    expect(barbers.find((s) => s.slug === "dubuque")!.barberCount).toBe(0);
    const { avail } = await openSlot();
    for (const b of avail.barbers) {
      expect(Object.keys(b)).not.toContain("lastName");
      expect(b.slug).toMatch(/^[a-z]+-[a-z0-9]{4}$/);
    }
  });

  it("handles a shop with zero barbers (Dubuque) gracefully", async () => {
    const svc = (await m.public.publicServices("dubuque")).services[0];
    const r = await m.booking.getAvailability({ shopRef: "dubuque", date: m.time.addDays(m.time.todayLocal(), 3), serviceId: svc.id });
    expect(r.slots).toEqual([]);
    expect(r.reason).toMatch(/no barbers/i);
  });

  it("books, then refuses the same barber/time again", async () => {
    const { slot, svc } = await openSlot();
    const a = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      barberRef: slot.barberIds[0],
      startsAt: slot.startsAt,
      customer: { firstName: "Test", lastName: "Person", phone: "3195559999" },
      source: "online",
      actor,
    });
    expect(a.status).toBe("booked");
    expect(a.code).toMatch(/^[2-9A-Z]{10}$/);
    await expect(
      m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: slot.barberIds[0], startsAt: slot.startsAt, customer: { firstName: "Other", phone: "3195558888" }, source: "online", actor }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    // Confirmation + 24h + 2h reminders queued (SMS), and suppressed when providers are disabled.
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.eq(m.schema.notificationJobs.appointmentId, a.id));
    expect(jobs.map((j) => j.kind).sort()).toEqual(["confirmation", "reminder_24h", "reminder_2h"]);
    const stats = await m.queue.processDueJobs();
    expect(stats.suppressed).toBeGreaterThan(0);
  });

  it("the database blocks cross-shop double booking even if app checks are bypassed", async () => {
    const { slot } = await openSlot();
    const kim = await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "kimberly") });
    const start = new Date(slot.startsAt);
    const base = { staffId: slot.barberIds[0], startsAt: start, endsAt: new Date(start.getTime() + 40 * 60_000), status: "booked" as const, source: "staff" as const };
    await m.db.db.insert(m.schema.appointments).values({ ...base, code: "TESTXSHOP1", shopId: (await coralville()).shop.id });
    await expect(m.db.db.insert(m.schema.appointments).values({ ...base, code: "TESTXSHOP2", shopId: kim!.id })).rejects.toThrow();
  });

  it("customers can cancel until 30 minutes before, not after", async () => {
    const { slot, svc } = await openSlot();
    const a = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: "any", startsAt: slot.startsAt, customer: { firstName: "Late", phone: "3195557777" }, source: "online", actor });
    const start = new Date(a.startsAt).getTime();
    await expect(m.booking.cancelAppointment(a.code, { actor, byCustomer: true, now: new Date(start - 20 * 60_000) })).rejects.toMatchObject({ code: "cutoff_passed" });
    const c = await m.booking.cancelAppointment(a.code, { actor, byCustomer: true, now: new Date(start - 31 * 60_000) });
    expect(c.status).toBe("cancelled");
  });

  it("reschedules to another open time", async () => {
    const { slot, svc, date } = await openSlot();
    const a = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: slot.barberIds[0], startsAt: slot.startsAt, customer: { firstName: "Move", phone: "3195556666" }, source: "online", actor });
    const avail = await m.booking.getAvailability({ shopRef: "coralville", date, serviceId: svc.id, barberRef: slot.barberIds[0], ignoreAppointmentId: a.id });
    const target = avail.slots[avail.slots.length - 1];
    const r = await m.booking.rescheduleAppointment(a.code, { startsAt: target.startsAt, actor, byCustomer: true });
    expect(r.startsAt).toBe(target.startsAt);
  });
});

describe("checkout → reports → loyalty", () => {
  it("credit card gets the 3% fee, tip is recorded, sale appears in reports, loyalty crosses $300", async () => {
    const { slot, svc } = await openSlot();
    const appt = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: "any", startsAt: slot.startsAt, customer: { firstName: "Jordan", phone: "+13195550100" }, source: "online", actor });
    const jordanBefore = await m.loyalty.loyaltyBalance(appt.customer!.id);
    expect(jordanBefore.progressCents).toBe(29_000);

    const sale = await m.checkout.openSaleForAppointment(appt.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    const before = await m.reports.salesSummary({ shopIds: [ctx.shop.id], from: m.time.todayLocal(), to: m.time.todayLocal() });

    const r = await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 700, tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" }, actor });
    expect(r.totals.serviceTaxCents).toBe(Math.round(3300 * 0.07));
    expect(r.totals.cardFeeCents).toBe(Math.round((3300 + 231) * 0.03));
    expect(r.totals.tipCents).toBe(700);
    expect(r.rewardsIssued).toBe(1);

    const after = await m.reports.salesSummary({ shopIds: [ctx.shop.id], from: m.time.todayLocal(), to: m.time.todayLocal() });
    expect(after.tickets).toBe(before.tickets + 1);
    expect(after.tipsCents - before.tipsCents).toBe(700);
    expect(after.netServicesCents - before.netServicesCents).toBe(3300);

    const jordan = await m.loyalty.loyaltyBalance(appt.customer!.id);
    expect(jordan.progressCents).toBe(29_000 + 3300 - 30_000);
    expect(jordan.availableCents).toBe(1500);

    const done = await m.booking.getAppointmentByCode(appt.code);
    expect(done.status).toBe("completed");
  });

  it("debit card pays no fee; refunding the service line takes back net services and loyalty, not the tip", async () => {
    const { slot, svc } = await openSlot();
    const appt = await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: "any", startsAt: slot.startsAt, customer: { firstName: "Refund", phone: "3195554444" }, source: "online", actor });
    const sale = await m.checkout.openSaleForAppointment(appt.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const lines = ctx.items.map((i) => ({ kind: i.kind, refId: i.refId, name: i.name, qty: i.qty }));
    const r = await m.checkout.finalizeSale({ saleId: sale.id, lines, tipCents: 500, tender: { method: "card", paymentMethodId: "pm_card_visa_debit", entryMode: "terminal" }, actor });
    expect(r.totals.cardFeeCents).toBe(0);
    const before = await m.reports.salesSummary({ shopIds: [ctx.shop.id], from: m.time.todayLocal(), to: m.time.todayLocal() });
    const progressBefore = (await m.loyalty.loyaltyBalance(appt.customer!.id)).progressCents;
    const item = (await m.checkout.refundableState(sale.id)).items.find((i) => i.kind === "service")!;
    const out = await m.checkout.refundSale({ saleId: sale.id, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Customer unhappy", restock: false, actor });
    expect(out.refundedCents).toBe(item.netCents + item.taxCents);
    expect(out.components).toMatchObject({ serviceNetCents: item.netCents, taxCents: item.taxCents, tipCents: 0, giftCardSalesCents: 0 });
    const after = await m.reports.salesSummary({ shopIds: [ctx.shop.id], from: m.time.todayLocal(), to: m.time.todayLocal() });
    expect(before.netServicesCents - after.netServicesCents).toBe(item.netCents);
    expect(after.tipsCents).toBe(before.tipsCents);
    expect((await m.loyalty.loyaltyBalance(appt.customer!.id)).progressCents).toBe(progressBefore - item.netCents);
  });

  it("gift card + cash, promo code, product sale decrements stock; void reverses it", async () => {
    const { shop } = await coralville();
    const sale = await m.checkout.openBlankSale(shop.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    const product = ctx.retail.find((p) => p.stock > 0)!;
    const r = await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [{ kind: "product", refId: product.productId, name: product.name, unitPriceCents: 1, qty: 1 }],
      tipCents: 0,
      giftCard: { code: "DEMO-GIFT-2500", amountCents: 1000 },
      tender: { method: "cash", cashTenderedCents: 10_000 },
      actor,
    });
    expect(r.totals.lines[0].unitPriceCents).toBe(product.priceCents); // server price, not client
    expect(r.totals.giftCardAppliedCents).toBe(1000);
    const stock = await m.db.db.query.shopProducts.findFirst({ where: m.drizzle.and(m.drizzle.eq(m.schema.shopProducts.shopId, shop.id), m.drizzle.eq(m.schema.shopProducts.productId, product.productId)) });
    expect(stock!.stock).toBe(product.stock - 1);
    await m.checkout.voidSale(sale.id, "Rang up wrong item", actor);
    const restored = await m.db.db.query.shopProducts.findFirst({ where: m.drizzle.and(m.drizzle.eq(m.schema.shopProducts.shopId, shop.id), m.drizzle.eq(m.schema.shopProducts.productId, product.productId)) });
    expect(restored!.stock).toBe(product.stock);
    const g = await m.checkout.lookupGiftCard("DEMO-GIFT-2500");
    expect(g.balanceCents).toBe(2500);
  });

  it("expired promos are refused; active promos discount services", async () => {
    const { shop } = await coralville();
    await expect(m.checkout.validatePromo("SPRING2026", shop.id)).rejects.toThrow();
    const p = await m.checkout.validatePromo("welcome5", shop.id, "2026-10-20");
    expect(p).toMatchObject({ type: "amount", value: 500, appliesTo: "services" });
  });

  it("payroll export groups tips by barber per bi-weekly period", async () => {
    const shops = (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id);
    const r = await m.reports.payrollTips({ shopIds: shops, from: m.time.addDays(m.time.todayLocal(), -3), to: m.time.todayLocal() });
    expect(r.periods.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.totalTipsCents).toBe(row.cardTipsCents + row.cashTipsCents + row.giftCardTipsCents);
  });

  it("daily, monthly, per-shop, and per-barber reports reconcile with the summary", async () => {
    const shopIds = (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id);
    const scope = { shopIds, from: m.time.addDays(m.time.todayLocal(), -40), to: m.time.todayLocal() };
    const [sum, daily, monthly, shops, barbers] = await Promise.all([
      m.reports.salesSummary(scope),
      m.reports.dailyTotals(scope),
      m.reports.monthlyTotals(scope),
      m.reports.byShop(scope),
      m.reports.byBarber(scope),
    ]);
    const total = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
    expect(sum.tickets).toBeGreaterThan(0);
    expect(daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    expect(total(daily, (d) => d.tickets)).toBe(sum.tickets);
    expect(total(daily, (d) => d.grossCents)).toBe(sum.grossSalesCents);
    expect(total(daily, (d) => d.netCents)).toBe(sum.netSalesCents);
    expect(total(monthly, (x) => x.netServicesCents)).toBe(sum.netServicesCents);
    expect(total(shops, (x) => x.netServicesCents)).toBe(sum.netServicesCents);
    expect(monthly.every((x) => /^\d{4}-\d{2}$/.test(x.month))).toBe(true);
    expect(total(monthly, (x) => x.tickets)).toBe(sum.tickets);
    expect(total(shops, (x) => x.tickets)).toBe(sum.tickets);
    expect(shops.find((x) => x.name === "Dubuque")?.tickets).toBe(0);
    expect(total(barbers, (x) => x.tipsCents)).toBeLessThanOrEqual(sum.tipsCents);

    const one = barbers[0];
    const mine = await m.reports.salesSummary({ ...scope, staffId: one.staffId });
    expect(mine.tickets).toBe(one.tickets);
    expect(mine.netServicesCents).toBe(one.netServicesCents);
  });

  it("KPIs: rates are bounded and the heatmap is in shop-local days and hours", async () => {
    const shopIds = (await m.db.db.select({ id: m.schema.shops.id }).from(m.schema.shops)).map((s) => s.id);
    const k = await m.reports.kpis({ shopIds, from: m.time.addDays(m.time.todayLocal(), -2), to: m.time.todayLocal() });
    for (const rate of [k.rebookRate, k.retentionRate]) {
      if (rate === null) continue;
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
    expect(k.newClients + k.returningClients).toBeGreaterThan(0);
    expect(k.heatmap.length).toBeGreaterThan(0);
    for (const h of k.heatmap) {
      expect(h.dow).toBeGreaterThanOrEqual(1); // closed Sundays
      expect(h.dow).toBeLessThanOrEqual(6);
      expect(h.hour).toBeGreaterThanOrEqual(6);
      expect(h.hour).toBeLessThanOrEqual(21);
    }
  });
});

describe("Squire importer", () => {
  it("dry-runs without writing, then imports clients, history, loyalty, and gift cards", async () => {
    const read = (f: string) => readFileSync(`samples/squire/${f}`, "utf8");
    const dry = await m.importer.runImport("clients", read("clients.csv"), { dryRun: true, actor });
    expect(dry).toMatchObject({ totalRows: 5, inserted: 4, skipped: 1 });
    expect(await m.db.db.query.customers.findFirst({ where: m.drizzle.eq(m.schema.customers.squireId, "SQ-10001") })).toBeUndefined();

    const clients = await m.importer.runImport("clients", read("clients.csv"), { dryRun: false, actor });
    expect(clients.inserted).toBe(4);
    const alex = await m.db.db.query.customers.findFirst({ where: m.drizzle.eq(m.schema.customers.squireId, "SQ-10001") });
    expect(alex!.phone).toBe("+13195557001");

    const appts = await m.importer.runImport("appointments", read("appointments.csv"), { dryRun: false, actor, now: new Date("2026-10-20T12:00:00Z") });
    expect(appts.inserted).toBe(4);
    expect(appts.errors.map((e) => e.message).join(" | ")).toMatch(/Ambiguous barber "Taylor"/);
    expect(appts.errors.map((e) => e.message).join(" | ")).toMatch(/Unknown shop "Clinton"/);

    const loyalty = await m.importer.runImport("loyalty", read("loyalty.csv"), { dryRun: false, actor });
    expect(loyalty.inserted).toBe(2);
    expect((await m.loyalty.loyaltyBalance(alex!.id)).progressCents).toBe(21_500);

    const gc = await m.importer.runImport("gift_cards", read("gift_cards.csv"), { dryRun: false, actor });
    expect(gc.inserted).toBe(3);
    expect((await m.checkout.lookupGiftCard("SQGC-0001")).balanceCents).toBe(4860);
  });
});
