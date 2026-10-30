/**
 * Memberships: the brand switch, plans, signing a client up (simulated billing without Stripe keys),
 * checkout covering the member's own plan services and counting the visit, the monthly visit limit,
 * a void giving the visit back, cancel and keep, monthly renewals, Stripe Billing events, and who sees what.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { brandSettings } from "./brand";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let M: typeof import("@/server/memberships");
const fx = { shop: "", other: "", barber: "", cut: "", cutCents: 0, beard: "", beardCents: 0 };
let seq = 0;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const brand = () => ({ shopIds: [fx.shop, fx.other], brandWide: true });
const at = (id: string) => ({ shopIds: [id], brandWide: false });

beforeAll(async () => {
  m = await loadModules();
  M = await import("@/server/memberships");
  fx.shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  fx.other = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "moline") }))!.id;
  fx.barber = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "makenna@rayz.test") }))!.id;
  const menu = await m.catalog.shopCatalog(fx.shop);
  const [cut, beard] = menu.filter((x) => x.kind === "service").sort((a, b) => b.priceCents - a.priceCents);
  [fx.cut, fx.cutCents, fx.beard, fx.beardCents] = [cut.id, cut.priceCents, beard.id, beard.priceCents];
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function client() {
  const n = String(3000 + ++seq + Math.floor(Math.random() * 6000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: "Member", lastName: `Test${seq}`, phone: `+1319557${n}`, email: `member.${n}.${seq}@members.test`, homeShopId: fx.shop })
    .returning();
  return c;
}

const plan = (name: string, extra: Partial<Parameters<typeof M.savePlan>[2]> = {}) =>
  M.savePlan(actor, null, { name: `${name} ${crypto.randomUUID().slice(0, 6)}`, priceCents: 3900, serviceIds: [fx.cut], visitsPerPeriod: null, productDiscountPct: 0, shopIds: [], active: true, ...extra });

async function ticketFor(customerId: string) {
  const sale = await m.checkout.openBlankSale(fx.shop, actor, fx.barber);
  await m.db.db.update(s().sales).set({ customerId }).where(eq(s().sales.id, sale.id));
  return sale.id;
}

const pay = (saleId: string, membershipId: string | null, lines = [{ kind: "service" as const, refId: fx.cut, qty: 1 }]) =>
  m.checkout.finalizeSale({ saleId, staffId: fx.barber, lines, tipCents: 0, tender: cash, membershipId, actor });

const row = async (id: string) => (await m.db.db.query.memberships.findFirst({ where: eq(s().memberships.id, id) }))!;

describe("memberships", () => {
  it("is off until the brand turns it on: no sign-ups and no checkout coverage", async () => {
    await brandSettings({ memberships: false });
    const p = await plan("Off Club");
    const c = await client();
    await expect(M.enroll(actor, brand(), { planId: p.id, customerId: c.id, homeShopId: fx.shop })).rejects.toThrow(/turned off/);
    expect(await M.checkoutCoverage([c.id], fx.shop)).toEqual([]);
    await brandSettings({ memberships: true });
    expect(await M.membershipsEnabled()).toBe(true);
  });

  it("checks plans: a name, something covered, unique names", async () => {
    await expect(M.savePlan(actor, null, { name: "Nothing", priceCents: 1000, serviceIds: [], visitsPerPeriod: null, productDiscountPct: 0, shopIds: [], active: true })).rejects.toThrow();
    const p = await plan("Dupe");
    await expect(M.savePlan(actor, null, { name: p.name.toUpperCase(), priceCents: 1000, serviceIds: [fx.cut], visitsPerPeriod: null, productDiscountPct: 0, shopIds: [], active: true })).rejects.toThrow(/already exists/);
    const saved = await M.savePlan(actor, p.id, { name: p.name, priceCents: 4500, serviceIds: [fx.cut], visitsPerPeriod: 2, productDiscountPct: 10, shopIds: [], active: true });
    expect([saved.priceCents, saved.visitsPerPeriod, saved.stripePriceId]).toEqual([4500, 2, null]);
  });

  it("signs a client up without Stripe: active today with a recorded first payment, once per plan", async () => {
    const p = await plan("Buzz Club");
    const c = await client();
    const r = await M.enroll(actor, at(fx.shop), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
    expect(r.checkoutUrl).toBeNull();
    const mem = await row(r.id);
    expect([mem.status, mem.billing, mem.priceCents, mem.currentPeriodStart]).toEqual(["active", "simulated", 3900, m.time.todayLocal()]);
    const inv = await m.db.db.select().from(s().membershipInvoices).where(eq(s().membershipInvoices.membershipId, r.id));
    expect(inv.map((i) => [i.status, i.amountCents])).toEqual([["paid", 3900]]);
    await expect(M.enroll(actor, at(fx.shop), { planId: p.id, customerId: c.id, homeShopId: fx.shop })).rejects.toThrow(/already on/);
    await expect(M.enroll(actor, at(fx.shop), { planId: p.id, customerId: c.id, homeShopId: fx.other })).rejects.toThrow(/outside your access/);
    const only = await plan("Moline Only", { shopIds: [fx.other] });
    await expect(M.enroll(actor, brand(), { planId: only.id, customerId: c.id, homeShopId: fx.shop })).rejects.toThrow(/isn't sold at that shop/);
    expect(await M.checkoutCoverage([c.id], fx.shop)).toHaveLength(1);
    const log = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.entityId, r.id));
    expect(log.map((l) => l.action)).toContain("membership.enroll");
  });

  it("covers the member's plan service in full at checkout, counts the visit, and leaves other services alone", async () => {
    const p = await plan("Full Cover");
    const c = await client();
    const { id } = await M.enroll(actor, brand(), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
    const saleId = await ticketFor(c.id);
    await pay(saleId, id, [
      { kind: "service", refId: fx.cut, qty: 1 },
      { kind: "service", refId: fx.beard, qty: 1 },
    ]);
    const sale = (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, saleId) }))!;
    expect([sale.status, sale.discountCents, sale.serviceGrossCents, sale.serviceNetCents]).toEqual(["paid", fx.cutCents, fx.cutCents + fx.beardCents, fx.beardCents]);
    const uses = await m.db.db.select().from(s().membershipUses).where(eq(s().membershipUses.membershipId, id));
    expect(uses.map((u) => [u.saleId, u.visits, u.valueCents])).toEqual([[saleId, 1, fx.cutCents]]);
    const board = await M.membershipBoard(brand(), { planId: p.id });
    expect(board.members).toMatchObject([{ id, used: 1, visitsPerPeriod: null }]);
  });

  it("stops at the monthly visit limit, and a voided ticket gives the visit back", async () => {
    const p = await plan("Two a Month", { visitsPerPeriod: 1 });
    const c = await client();
    const { id } = await M.enroll(actor, brand(), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
    const first = await ticketFor(c.id);
    await pay(first, id);
    expect((await M.checkoutCoverage([c.id], fx.shop))[0].visitsLeft).toBe(0);
    await expect(pay(await ticketFor(c.id), id)).rejects.toThrow(/no visits left/);
    await m.refunds.voidSale(first, "Rang up wrong", actor);
    expect((await M.checkoutCoverage([c.id], fx.shop))[0].visitsLeft).toBe(1);
    await pay(await ticketFor(c.id), id);
  });

  it("won't use someone else's membership on a ticket", async () => {
    const p = await plan("Not Yours");
    const member = await client();
    const other = await client();
    const { id } = await M.enroll(actor, brand(), { planId: p.id, customerId: member.id, homeShopId: fx.shop });
    await expect(pay(await ticketFor(other.id), id)).rejects.toThrow(/can't be used on this ticket/);
  });

  it("cancels at month end or now, takes back a month-end cancel, and keeps other shops out", async () => {
    const p = await plan("Cancel Club");
    const c = await client();
    const { id } = await M.enroll(actor, at(fx.shop), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
    await expect(M.cancelMembership(actor, at(fx.other), { id, when: "now", reason: "Moving" })).rejects.toThrow(/outside your access/);
    await expect(M.cancelMembership(actor, at(fx.shop), { id, when: "now", reason: "" })).rejects.toThrow();
    await M.cancelMembership(actor, at(fx.shop), { id, when: "period_end", reason: "Moving away" });
    expect([(await row(id)).status, (await row(id)).cancelAtPeriodEnd]).toEqual(["active", true]);
    await M.keepMembership(actor, at(fx.shop), id);
    expect((await row(id)).cancelAtPeriodEnd).toBe(false);
    await M.cancelMembership(actor, at(fx.shop), { id, when: "now", reason: "Moving away" });
    expect((await row(id)).status).toBe("canceled");
    expect(await M.checkoutCoverage([c.id], fx.shop)).toEqual([]);
    expect((await M.membershipBoard(at(fx.other), { status: "all" })).members.some((x) => x.id === id)).toBe(false);
    expect((await M.membershipBoard(at(fx.shop), { status: "canceled" })).members.some((x) => x.id === id)).toBe(true);
    await M.enroll(actor, at(fx.shop), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
  });

  it("renews simulated memberships when the month is up and ends those set to cancel", async () => {
    const p = await plan("Renew Club");
    const keep = await M.enroll(actor, brand(), { planId: p.id, customerId: (await client()).id, homeShopId: fx.shop });
    const end = await M.enroll(actor, brand(), { planId: p.id, customerId: (await client()).id, homeShopId: fx.shop });
    await M.cancelMembership(actor, brand(), { id: end.id, when: "period_end", reason: "Too pricey" });
    const later = new Date(Date.now() + 40 * 86_400_000);
    const r = await M.renewSimulatedMemberships(later);
    expect(r.renewed).toBeGreaterThanOrEqual(1);
    expect(r.ended).toBeGreaterThanOrEqual(1);
    const k = await row(keep.id);
    expect(k.status).toBe("active");
    expect(k.currentPeriodEnd > m.time.todayLocal(later)).toBe(true);
    expect((await row(end.id)).status).toBe("canceled");
    const again = await M.renewSimulatedMemberships(later);
    expect(again.renewed).toBe(0);
    const inv = await m.db.db.select().from(s().membershipInvoices).where(eq(s().membershipInvoices.membershipId, keep.id));
    expect(inv).toHaveLength(2);
  });

  it("follows Stripe Billing: subscribed, invoice paid or failed, canceled from Stripe", async () => {
    const p = await plan("Stripe Club");
    const c = await client();
    const { id } = await M.enroll(actor, brand(), { planId: p.id, customerId: c.id, homeShopId: fx.shop });
    await m.db.db.update(s().memberships).set({ billing: "stripe", status: "incomplete" }).where(eq(s().memberships.id, id));
    const sub = `sub_test_${crypto.randomUUID().slice(0, 8)}`;
    const ev = (type: string, object: object) => ({ id: `evt_${crypto.randomUUID().slice(0, 8)}`, type, data: { object } }) as unknown as Stripe.Event;

    expect(await M.applyMembershipEvent(ev("checkout.session.completed", { mode: "subscription", metadata: { membership_id: id }, subscription: sub }))).toBe(true);
    expect((await row(id)).stripeSubscriptionId).toBe(sub);

    const start = Math.floor(Date.now() / 1000);
    const period = { start, end: start + 30 * 86_400 };
    await M.applyMembershipEvent(ev("invoice.paid", { id: "in_paid", amount_paid: 3900, amount_due: 3900, subscription: sub, lines: { data: [{ period }] } }));
    expect((await row(id)).status).toBe("active");
    await M.applyMembershipEvent(ev("invoice.payment_failed", { id: "in_fail", amount_paid: 0, amount_due: 3900, parent: { subscription_details: { subscription: sub } }, lines: { data: [{ period: { start: period.end, end: period.end + 30 * 86_400 } }] } }));
    expect((await row(id)).status).toBe("past_due");
    expect(await M.checkoutCoverage([c.id], fx.shop)).toEqual([]);

    await M.applyMembershipEvent(ev("customer.subscription.updated", { id: sub, cancel_at_period_end: true }));
    expect((await row(id)).cancelAtPeriodEnd).toBe(true);
    await M.applyMembershipEvent(ev("customer.subscription.deleted", { id: sub, cancel_at_period_end: false }));
    expect((await row(id)).status).toBe("canceled");
    expect(await M.applyMembershipEvent(ev("customer.subscription.deleted", { id: "sub_unknown" }))).toBe(false);
    const actions = (await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.entityId, id))).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["membership.subscribed", "membership.invoice_paid", "membership.invoice_failed", "membership.ended"]));
  });
});
