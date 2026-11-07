/**
 * Combined checkout against a real database: barbers sending a group's children to checkout at once
 * (one ticket, each cut's finish recorded); the desk sending the whole group, combining the tickets
 * it already had; combining walk-in tickets from different households and splitting them back;
 * racing combines; a screen paying a ticket that changed under it; one ticket for three people and
 * two barbers paid with cash and two cards by different payers, with tips typed per barber landing
 * exactly; a declined second card undoing the first; a line refunded back off its own barber in
 * reports and payroll; held coupons and loyalty rewards from anyone on the ticket; and the receipt
 * itemized by person.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let fam: typeof import("@/server/family");
let cc: typeof import("@/server/combined-checkout");
let times: typeof import("@/server/service-times");
let receipts: typeof import("@/server/receipts");
let coupons: typeof import("@/server/coupons");
let today: string;
const fx = { shop: "", makenna: "", michelle: "", cut: "", cutCents: 0 };
const slots = new Map<string, number>();
let seq = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const inArray = (...a: Parameters<Mods["drizzle"]["inArray"]>) => m.drizzle.inArray(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const keyed = (pm: string) => ({ method: "card" as const, paymentMethodId: pm, entryMode: "keyed" as const });

beforeAll(async () => {
  m = await loadModules();
  fam = await import("@/server/family");
  cc = await import("@/server/combined-checkout");
  times = await import("@/server/service-times");
  receipts = await import("@/server/receipts");
  coupons = await import("@/server/coupons");
  today = m.time.todayLocal();
  fx.shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  const staff = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!.id;
  fx.makenna = await staff("makenna@rayz.test");
  fx.michelle = await staff("michelle@rayz.test");
  const svc = (await m.catalog.shopCatalog(fx.shop)).find((x) => x.slug === "rayz-cut-shampoo")!;
  fx.cut = svc.id;
  fx.cutCents = svc.priceCents;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

async function customer(firstName: string) {
  const n = String(2000 + ++seq + Math.floor(Math.random() * 7000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName, lastName: "Combined", phone: `+1319558${n}`, email: `${firstName.toLowerCase()}.${n}@combined.test`, smsOptIn: true, emailOptIn: true, homeShopId: fx.shop })
    .returning();
  return c;
}

/** Today's appointment before opening (so it never meets the seeded book), each barber's back to back, checked in. */
async function appt(customerId: string, staffId: string, groupId: string | null = null) {
  const n = slots.get(staffId) ?? 0;
  slots.set(staffId, n + 1);
  const startsAt = m.time.zonedWallTime(today, 10 + 20 * n).toJSDate();
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `C${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: fx.shop,
      staffId,
      customerId,
      groupId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 20 * 60_000),
      status: "checked_in",
      source: "staff",
      estimateCents: fx.cutCents,
    })
    .returning();
  await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, serviceId: fx.cut, kind: "service", name: "Ray'z Cut", priceCents: fx.cutCents, durationMin: 20 });
  return a;
}

/** A parent and children booked as one group: the parent with Makenna, the children with Michelle. */
async function group(kids: string[]) {
  const p = await customer("Dana");
  const children = [];
  for (const k of kids) children.push(await fam.addChild(p.id, { firstName: k }, actor));
  const [g] = await m.db.db
    .insert(s().bookingGroups)
    .values({ code: `G${crypto.randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`, shopId: fx.shop, guardianId: p.id, plan: "custom", source: "staff" })
    .returning();
  const pa = await appt(p.id, fx.makenna, g.id);
  const ka = [];
  for (const c of children) ka.push(await appt(c.id, fx.michelle, g.id));
  return { g, p, kids: children, pa, ka };
}

const saleRow = async (id: string) => (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, id) }))!;
const itemsOf = (saleId: string) => m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, saleId));
const cutFor = (appointmentId: string) => ({ kind: "service" as const, refId: fx.cut, qty: 1, appointmentId });
const peopleOn = async (saleId: string) => {
  const sale = await saleRow(saleId);
  return [sale.appointmentId, ...(await m.db.db.select().from(s().saleAppointments).where(eq(s().saleAppointments.saleId, saleId))).map((r) => r.appointmentId)].filter(Boolean).sort();
};

describe("sending to checkout", () => {
  it("two barbers sending a group's children at once put them on one ticket, paid by the parent, each cut's finish recorded", async () => {
    const f = await group(["Milo", "Ava"]);
    const now = new Date();
    await times.startService(f.ka[0].id, actor, new Date(now.getTime() - 25 * 60_000));
    await times.startService(f.ka[1].id, actor, new Date(now.getTime() - 15 * 60_000));

    const [a, b] = await Promise.all([cc.sendToCheckout(f.ka[0].id, actor, now), cc.sendToCheckout(f.ka[1].id, actor, now)]);
    expect(a.saleId).toBe(b.saleId);
    expect([a.joined, b.joined].sort()).toEqual([false, true]);
    const sale = await saleRow(a.saleId);
    expect(sale.customerId).toBe(f.p.id);
    expect(await peopleOn(a.saleId)).toEqual([f.ka[0].id, f.ka[1].id].sort());

    const t = await times.timesFor([f.ka[0].id, f.ka[1].id], now);
    expect(t.get(f.ka[0].id)?.finished).toMatchObject({ via: "finish" });
    expect(Math.round(t.get(f.ka[0].id)!.actualMin!)).toBe(25);
    expect(Math.round(t.get(f.ka[1].id)!.actualMin!)).toBe(15);
    const rows = await m.db.db.select().from(s().appointments).where(inArray(s().appointments.id, [f.ka[0].id, f.ka[1].id]));
    expect(rows.every((r) => r.checkoutReadyAt)).toBe(true);

    // The parent's own cut joins the same ticket, and everyone's ready.
    const c = await cc.sendToCheckout(f.pa.id, actor);
    expect(c).toMatchObject({ saleId: a.saleId, joined: true, ready: 3, total: 3, all: true });
    await expect(cc.sendToCheckout(f.pa.id, actor)).resolves.toMatchObject({ saleId: a.saleId });

    await m.checkout.finalizeSale({ saleId: a.saleId, lines: [f.pa, ...f.ka].map((x) => cutFor(x.id)), tipCents: 0, tender: cash, actor });
    const items = await itemsOf(a.saleId);
    expect(items.map((i) => [i.appointmentId, i.staffId]).sort()).toEqual([[f.pa.id, fx.makenna], [f.ka[0].id, fx.michelle], [f.ka[1].id, fx.michelle]].sort());
    await expect(cc.sendToCheckout(f.ka[0].id, actor)).rejects.toMatchObject({ code: "conflict" });
    // The cut time stays what the barber did, not the wait for the family's payment.
    expect(Math.round((await times.timesFor([f.ka[0].id], now)).get(f.ka[0].id)!.actualMin!)).toBe(25);
  });

  it("the desk sends the whole group, combining the tickets the group already had into the parent's", async () => {
    const f = await group(["Quin"]);
    const own = await m.checkout.openSaleForAppointment(f.pa.id, actor);
    const kidOwn = await m.checkout.openSaleForAppointment(f.ka[0].id, actor);
    expect(kidOwn.id).not.toBe(own.id);

    const saleId = await cc.sendGroupToCheckout(f.g.id, actor);
    expect(saleId).toBe(own.id);
    const gone = await saleRow(kidOwn.id);
    expect(gone).toMatchObject({ status: "voided", mergedIntoSaleId: own.id });
    expect(gone.voidReason).toMatch(/Combined into ticket #/);
    expect(await peopleOn(saleId)).toEqual([f.pa.id, f.ka[0].id].sort());
    expect((await itemsOf(saleId)).map((i) => i.appointmentId).sort()).toEqual([f.pa.id, f.ka[0].id].sort());
    const [queued] = await cc.openTickets([fx.shop], { q: "quin" });
    expect(queued).toMatchObject({ id: saleId, ready: 2, total: 2 });
    expect(queued.groupCode).toBe(f.g.code);
    expect(await cc.sendGroupToCheckout(f.g.id, actor)).toBe(saleId);

    await expect(m.checkout.finalizeSale({ saleId: kidOwn.id, lines: [cutFor(f.ka[0].id)], tipCents: 0, tender: cash, actor })).rejects.toThrow(/combined into another/);
  });

  it("a group ticket started from a child's ticket is paid by the parent", async () => {
    const f = await group(["Rio"]);
    const kidOwn = await m.checkout.openSaleForAppointment(f.ka[0].id, actor);
    expect((await saleRow(kidOwn.id)).customerId).toBe(f.kids[0].id);
    expect(await cc.sendGroupToCheckout(f.g.id, actor, { ready: false })).toBe(kidOwn.id);
    expect((await saleRow(kidOwn.id)).customerId).toBe(f.p.id);
    expect((await m.db.db.select().from(s().appointments).where(eq(s().appointments.id, f.pa.id)))[0].checkoutReadyAt).toBeNull();
  });
});

describe("combining and splitting at checkout", () => {
  it("combines walk-in tickets from different households, then splits them back", async () => {
    const [c1, c2, c3] = [await customer("Walker"), await customer("Sibling"), await customer("Cousin")];
    const [a1, a2, a3] = [await appt(c1.id, fx.makenna), await appt(c2.id, fx.michelle), await appt(c3.id, fx.michelle)];
    const [s1, s2, s3] = [await m.checkout.openSaleForAppointment(a1.id, actor), await m.checkout.openSaleForAppointment(a2.id, actor), await m.checkout.openSaleForAppointment(a3.id, actor)];

    const found = await cc.openTickets([fx.shop], { q: c2.firstName, excludeSaleId: s1.id });
    expect(found.map((t) => t.id)).toContain(s2.id);
    expect(found.map((t) => t.id)).not.toContain(s1.id);
    expect((await cc.openTickets([fx.shop], { q: `#${s3.number}` })).map((t) => t.id)).toEqual([s3.id]);

    await cc.mergeTickets(s1.id, [s2.id, s3.id], actor);
    expect(await peopleOn(s1.id)).toEqual([a1.id, a2.id, a3.id].sort());
    const ctx = await m.checkout.loadCheckoutContext(s1.id);
    expect(ctx.family.members.map((x) => [x.appointmentId, x.staffId])).toEqual([
      [a2.id, fx.michelle],
      [a3.id, fx.michelle],
    ]);
    expect((await itemsOf(s1.id)).map((i) => i.appointmentId).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    await expect(cc.mergeTickets(s1.id, [s2.id], actor)).rejects.toMatchObject({ code: "conflict" });

    const back = await cc.splitOffTicket(s1.id, a2.id, actor);
    expect(await peopleOn(back)).toEqual([a2.id]);
    expect(await saleRow(back)).toMatchObject({ customerId: c2.id, staffId: fx.michelle, status: "open" });
    expect((await itemsOf(back)).map((i) => i.appointmentId)).toEqual([a2.id]);
    expect(await peopleOn(s1.id)).toEqual([a1.id, a3.id].sort());

    // Splitting off the ticket's own person hands the ticket to the next one.
    const lead = await cc.splitOffTicket(s1.id, a1.id, actor);
    expect(await saleRow(s1.id)).toMatchObject({ appointmentId: a3.id, customerId: c3.id, staffId: fx.michelle });
    expect((await itemsOf(lead)).map((i) => i.appointmentId)).toEqual([a1.id]);
    await expect(cc.splitOffTicket(s1.id, a3.id, actor)).rejects.toThrow(/Only one person/);

    await cc.mergeTickets(back, [lead], actor);
    expect(await cc.splitTicketApart(back, actor)).toHaveLength(1);
    expect(await peopleOn(back)).toEqual([a2.id]);
  });

  it("two combines over the same tickets at once: one wins, the other is told, and nothing deadlocks", async () => {
    const [c1, c2] = [await customer("Racer"), await customer("Chaser")];
    const [a1, a2] = [await appt(c1.id, fx.makenna), await appt(c2.id, fx.michelle)];
    const [s1, s2] = [await m.checkout.openSaleForAppointment(a1.id, actor), await m.checkout.openSaleForAppointment(a2.id, actor)];
    const out = await Promise.allSettled([cc.mergeTickets(s1.id, [s2.id], actor), cc.mergeTickets(s2.id, [s1.id], actor)]);
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "conflict" });
    const won = (out.find((o) => o.status === "fulfilled") as PromiseFulfilledResult<string>).value;
    expect(await peopleOn(won)).toEqual([a1.id, a2.id].sort());
  });

  it("a screen that showed the ticket before someone was combined in can't pay it", async () => {
    const [c1, c2] = [await customer("Stale"), await customer("Added")];
    const [a1, a2] = [await appt(c1.id, fx.makenna), await appt(c2.id, fx.michelle)];
    const [s1, s2] = [await m.checkout.openSaleForAppointment(a1.id, actor), await m.checkout.openSaleForAppointment(a2.id, actor)];
    const shown = [a1.id];
    await cc.mergeTickets(s1.id, [s2.id], actor);
    await expect(m.checkout.finalizeSale({ saleId: s1.id, lines: [cutFor(a1.id)], tipCents: 0, tender: cash, ticketPeople: shown, actor })).rejects.toThrow(/added to or taken off/);
    expect((await saleRow(s1.id)).status).toBe("open");
    await m.checkout.finalizeSale({ saleId: s1.id, lines: [cutFor(a1.id), cutFor(a2.id)], tipCents: 0, tender: cash, ticketPeople: [a1.id, a2.id], actor });
    expect((await saleRow(s1.id)).status).toBe("paid");
  });
});

describe("paying a combined ticket", () => {
  it("three people, two barbers: cash and two cards by different payers, tips per barber exact, reports and payroll per barber, a line refunded off its own barber", async () => {
    const f = await group(["Lu", "Bo"]);
    const saleId = await cc.sendGroupToCheckout(f.g.id, actor);
    const lines = [f.pa, ...f.ka].map((x) => cutFor(x.id));
    const tipByStaff = [
      { staffId: fx.makenna, cents: 901 },
      { staffId: fx.michelle, cents: 600 },
    ];
    const base = { saleId, lines, tipCents: 1501, tipSplit: "per_barber" as const, tipByStaff };
    const priced = await m.checkout.priceCart({ ...base, tender: cash }, null);
    const due = priced.totals.primaryBaseCents;
    expect(due).toBeGreaterThan(6000);

    await expect(m.checkout.finalizeSale({ ...base, tipByStaff: [{ staffId: fx.makenna, cents: 1501 }, { staffId: fx.michelle, cents: 1 }], tender: cash, actor })).rejects.toThrow(/add up to/);
    const stranger = await customer("Stranger");
    const tenders = [
      { ...cash, amountCents: 2000, payerLabel: "Grandma 4242 4242 4242 4242" },
      { ...keyed("pm_card_visa"), amountCents: due - 3000, payerCustomerId: f.p.id },
      { ...keyed("pm_card_visa_debit"), amountCents: 1000, payerCustomerId: f.kids[0].id },
    ];
    await expect(m.checkout.finalizeSale({ ...base, tender: cash, tenders: tenders.map((t, i) => (i === 2 ? { ...t, payerCustomerId: stranger.id } : t)), actor })).rejects.toThrow(/payer isn't on this ticket/);
    await expect(m.checkout.finalizeSale({ ...base, tender: cash, tenders: tenders.map((t, i) => (i === 0 ? { ...t, amountCents: 1999 } : t)), actor })).rejects.toThrow(/short/);

    const scope = { shopIds: [fx.shop], from: today, to: today };
    const before = await m.reports.byBarber(scope);
    const payBefore = await m.reports.payrollSalesBetween({ shopIds: [fx.shop] }, today, today);
    const r = await m.checkout.finalizeSale({ ...base, tender: cash, tenders, actor });
    expect(r.cards).toHaveLength(2);

    const sale = await saleRow(saleId);
    const pays = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, saleId)).orderBy(s().payments.amountCents);
    expect(pays).toHaveLength(3);
    expect(pays.reduce((a, p) => a + p.amountCents, 0)).toBe(sale.totalCents);
    expect(pays.reduce((a, p) => a + p.tipCents, 0)).toBe(1501);
    const credit = pays.find((p) => p.cardFunding === "credit")!;
    const debit = pays.find((p) => p.cardFunding === "debit")!;
    const cashPay = pays.find((p) => p.method === "cash")!;
    expect(credit.tipCents).toBe(1501);
    expect(credit.payerCustomerId).toBe(f.p.id);
    expect(debit).toMatchObject({ payerCustomerId: f.kids[0].id, cardFeeCents: 0, amountCents: 1000 });
    expect(cashPay).toMatchObject({ payerLabel: "Grandma", payerCustomerId: null, amountCents: 2000 });
    const { planSplitTenders } = await import("@/domain/combined-checkout");
    const plan = planSplitTenders({
      tipCents: 1501,
      cardFee: priced.ctx.config.cardFee,
      tenders: tenders.map((t, i) => ({ key: String(i), method: t.method, amountCents: t.amountCents, funding: i === 1 ? "credit" : i === 2 ? "debit" : null })),
    });
    expect(credit.cardFeeCents).toBe(plan.parts[1].feeCents);
    expect(sale.cardFeeCents).toBe(plan.cardFeeCents);
    expect(sale.totalCents).toBe(due + plan.cardFeeCents);

    const ledger = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId));
    const tipOf = (id: string) => ledger.filter((t) => t.staffId === id).reduce((a, t) => a + t.amountCents, 0);
    expect([tipOf(fx.makenna), tipOf(fx.michelle)]).toEqual([901, 600]);
    expect((await m.db.db.select().from(s().appointments).where(inArray(s().appointments.id, [f.pa.id, ...f.ka.map((k) => k.id)]))).every((a) => a.status === "completed")).toBe(true);

    const items = await itemsOf(saleId);
    const lineOf = (appointmentId: string) => items.find((i) => i.appointmentId === appointmentId)!;
    const after = await m.reports.byBarber(scope);
    const payAfter = await m.reports.payrollSalesBetween({ shopIds: [fx.shop] }, today, today);
    const row = (rows: typeof before, id: string) => rows.find((x) => x.staffId === id) ?? { services: 0, netServicesCents: 0, tipsCents: 0, refundCents: 0 };
    const pay = (rows: typeof payBefore, id: string) => rows.filter((x) => x.staffId === id).reduce((a, x) => a + x.serviceSalesCents, 0);
    const delta = (id: string, k: "services" | "netServicesCents" | "tipsCents") => row(after, id)[k] - row(before, id)[k];
    expect([delta(fx.makenna, "services"), delta(fx.michelle, "services")]).toEqual([1, 2]);
    expect(delta(fx.makenna, "netServicesCents")).toBe(lineOf(f.pa.id).netCents);
    expect(delta(fx.michelle, "netServicesCents")).toBe(lineOf(f.ka[0].id).netCents + lineOf(f.ka[1].id).netCents);
    expect([delta(fx.makenna, "tipsCents"), delta(fx.michelle, "tipsCents")]).toEqual([901, 600]);
    expect(pay(payAfter, fx.makenna) - pay(payBefore, fx.makenna)).toBe(lineOf(f.pa.id).netCents);
    expect(pay(payAfter, fx.michelle) - pay(payBefore, fx.michelle)).toBe(lineOf(f.ka[0].id).netCents + lineOf(f.ka[1].id).netCents);
    const totalsBefore = before.reduce((a, x) => a + x.netServicesCents, 0);
    expect(after.reduce((a, x) => a + x.netServicesCents, 0) - totalsBefore).toBe(sale.serviceNetCents);

    const receipt = await receipts.receiptData(saleId);
    expect(receipt.people?.map((p) => [p.name, p.barbers, p.lines.length])).toEqual([
      ["Dana", ["Makenna"], 1],
      ["Lu", ["Michelle"], 1],
      ["Bo", ["Michelle"], 1],
    ]);
    expect(receipt.tenders.some((t) => t.label === "Cash (Grandma)")).toBe(true);
    expect(receipt.tenders.some((t) => t.label.includes("(Dana)"))).toBe(true);
    expect(receipt.tenders.some((t) => t.label.includes("(Lu)"))).toBe(true);
    const email = await receipts.composeReceipt(saleId, "email", "https://example.test/r/x");
    expect(email.body).toMatch(/Lu · with Michelle/);
    expect(email.body).not.toMatch(/4242 4242/);

    // Bo's cut refunded: off Michelle only, the refund recorded against that line.
    const bo = lineOf(f.ka[1].id);
    await m.checkout.refundSale({ saleId, items: [{ saleItemId: bo.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Redo", restock: false, actor });
    const [ref] = await m.db.db.select().from(s().refunds).where(m.drizzle.and(eq(s().refunds.saleId, saleId), m.drizzle.isNotNull(s().refunds.items)));
    expect(ref.items).toEqual([expect.objectContaining({ saleItemId: bo.id, qty: 1, netCents: bo.netCents, kind: "service" })]);
    const refunded = await m.reports.byBarber(scope);
    expect(row(refunded, fx.michelle).netServicesCents - row(after, fx.michelle).netServicesCents).toBe(-bo.netCents);
    expect(row(refunded, fx.makenna).netServicesCents).toBe(row(after, fx.makenna).netServicesCents);
    expect(row(refunded, fx.michelle).refundCents - row(after, fx.michelle).refundCents).toBe(bo.netCents);
    const payRefunded = await m.reports.payrollSalesBetween({ shopIds: [fx.shop] }, today, today);
    expect(pay(payRefunded, fx.michelle) - pay(payAfter, fx.michelle)).toBe(-bo.netCents);
    expect(pay(payRefunded, fx.makenna)).toBe(pay(payAfter, fx.makenna));
    expect((await receipts.receiptData(saleId)).people?.find((p) => p.name === "Bo")?.lines[0]).toMatchObject({ refunded: true });
  });

  it("a declined second card undoes the first, and the ticket stays open", async () => {
    const [c1, c2] = [await customer("Declined"), await customer("Friend")];
    const [a1, a2] = [await appt(c1.id, fx.makenna), await appt(c2.id, fx.michelle)];
    const s1 = await m.checkout.openSaleForAppointment(a1.id, actor);
    const s2 = await m.checkout.openSaleForAppointment(a2.id, actor);
    await cc.mergeTickets(s1.id, [s2.id], actor);
    const lines = [cutFor(a1.id), cutFor(a2.id)];
    const due = (await m.checkout.priceCart({ saleId: s1.id, lines, tipCents: 0, tender: cash }, null)).totals.primaryBaseCents;
    await expect(
      m.checkout.finalizeSale({
        saleId: s1.id,
        lines,
        tipCents: 0,
        tender: cash,
        tenders: [
          { ...keyed("pm_card_visa"), amountCents: due - 1000, payerCustomerId: c1.id },
          { ...keyed("pm_card_chargeDeclined"), amountCents: 1000, payerCustomerId: c2.id },
        ],
        actor,
      }),
    ).rejects.toMatchObject({ code: "payment_failed" });
    expect((await saleRow(s1.id)).status).toBe("open");
    expect(await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, s1.id))).toEqual([]);
    const logs = await m.db.db.select().from(s().auditLog).where(m.drizzle.and(eq(s().auditLog.entityId, s1.id), eq(s().auditLog.action, "payment.compensated")));
    expect(logs).toHaveLength(1);
  });

  it("a coupon held by a child's booking and a reward owned by someone else on the ticket apply at the combined level", async () => {
    const f = await group(["Cy"]);
    const code = `KIDS${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [promo] = await m.db.db.insert(s().promoCodes).values({ code, description: code, type: "amount", value: 500 }).returning();
    await m.db.db.insert(s().appointmentCoupons).values({ appointmentId: f.ka[0].id, promoId: promo.id, code });
    const saleId = await cc.sendGroupToCheckout(f.g.id, actor);
    const sale = await saleRow(saleId);
    expect(sale.appointmentId).toBe(f.pa.id);
    expect((await coupons.ticketCoupons(sale)).held).toMatchObject({ code, problem: null });
    await m.checkout.finalizeSale({ saleId, lines: [cutFor(f.pa.id), cutFor(f.ka[0].id)], promoCode: code, tipCents: 0, tender: cash, actor });
    expect((await saleRow(saleId)).discountCents).toBe(500);

    const [c1, c2] = [await customer("Payer"), await customer("Owner")];
    const [a1, a2] = [await appt(c1.id, fx.makenna), await appt(c2.id, fx.michelle)];
    const s1 = await m.checkout.openSaleForAppointment(a1.id, actor);
    const s2 = await m.checkout.openSaleForAppointment(a2.id, actor);
    await cc.mergeTickets(s1.id, [s2.id], actor);
    const [reward] = await m.db.db.insert(s().loyaltyRewards).values({ customerId: c2.id, amountCents: 1000, source: "manual" }).returning();
    await m.checkout.finalizeSale({ saleId: s1.id, lines: [cutFor(a1.id), cutFor(a2.id)], loyaltyRewardId: reward.id, tipCents: 0, tender: cash, actor });
    expect((await saleRow(s1.id)).discountCents).toBe(1000);
    expect((await m.db.db.query.loyaltyRewards.findFirst({ where: eq(s().loyaltyRewards.id, reward.id) }))!.redeemedSaleId).toBe(s1.id);
  });
});
