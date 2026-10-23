/**
 * The customer screen at checkout against a real database: handing a ticket over locks the browser
 * to it (middleware, server actions and the staff session all refuse anything else), the client's
 * tip, signature, receipt and payment, staff and manager PINs taking it back, the thank-you screen
 * giving it back by itself, tips on the reader, and split tips flowing into the tip ledger, reports
 * and payroll for every barber on the ticket.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { jar, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let H: typeof import("@/server/handoff");
let lock: typeof import("@/server/auth/handoff-lock");
let mw: typeof import("@/middleware");
let staffAuth: typeof import("@/server/auth/staff");
let tl: typeof import("@/server/tips/ledger");
let clock: typeof import("@/server/time-clock");
let screenActions: typeof import("@/app/handoff/[id]/actions");
let posActions: typeof import("@/app/admin/checkout/actions");
let today: string;

const fx = { shopId: "", michelle: "", makenna: "", delaney: "", cut: { id: "", priceCents: 0 }, beard: { id: "", priceCents: 0 } };
const PIN = { michelle: "4821", makenna: "1357", delaney: "2468" };

beforeAll(async () => {
  m = await loadModules();
  H = await import("@/server/handoff");
  lock = await import("@/server/auth/handoff-lock");
  mw = await import("@/middleware");
  staffAuth = await import("@/server/auth/staff");
  tl = await import("@/server/tips/ledger");
  clock = await import("@/server/time-clock");
  screenActions = await import("@/app/handoff/[id]/actions");
  posActions = await import("@/app/admin/checkout/actions");
  today = m.time.todayLocal();
  const shop = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") }))!;
  fx.shopId = shop.id;
  const people = await m.db.db.select({ id: m.schema.staff.id, label: m.schema.staff.displayLabel }).from(m.schema.staff);
  const id = (label: string) => people.find((p) => p.label === label)!.id;
  fx.michelle = id("Michelle");
  fx.makenna = id("Makenna");
  fx.delaney = id("Delaney");
  for (const [k, pin] of Object.entries(PIN)) await clock.setPin(fx[k as keyof typeof PIN], pin, actor);
  const menu = await m.catalog.shopCatalog(shop.id);
  const cut = menu.find((s) => s.slug === "rayz-cut-shampoo") ?? menu.find((s) => s.kind === "service")!;
  const other = menu.find((s) => s.kind === "service" && s.id !== cut.id && s.priceCents > 0)!;
  fx.cut = { id: cut.id, priceCents: cut.priceCents };
  fx.beard = { id: other.id, priceCents: other.priceCents };
  await tl.syncTipLedger();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

beforeEach(async () => {
  jar.handoff = undefined;
  await setRules({});
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const by = (staffId: string) => ({ actor: { staffId, label: "test" }, staffId, canDiscount: false, canOverridePrice: false, maxManualDiscountPct: 0 });
const draft = (lines: { kind: "service"; refId: string; qty: number; staffId?: string | null }[], tipSplit: "services" | "even" | null = null) => ({
  lines,
  promoCode: null,
  manualDiscount: null,
  loyaltyRewardId: null,
  giftCard: null,
  rebookInWeeks: null,
  tipSplit,
});

async function setRules(over: Partial<import("@/domain/handoff").ShopHandoff>) {
  await H.saveShopHandoff(fx.shopId, { ...(await import("@/domain/handoff")).DEFAULT_SHOP_HANDOFF, ...over }, actor);
}

/** A ticket for Michelle with one cut, handed over. */
async function handedOver(lines = [{ kind: "service" as const, refId: fx.cut.id, qty: 1 }], tipSplit: "services" | "even" | null = null, barber = fx.michelle) {
  const sale = await m.checkout.openBlankSale(fx.shopId, actor, barber);
  const h = await H.startHandoff(sale.id, draft(lines, tipSplit), by(barber));
  return { saleId: sale.id, id: h.id };
}

const handoffRow = async (id: string) => (await m.db.db.select().from(s().checkoutHandoffs).where(eq(s().checkoutHandoffs.id, id)))[0];
const saleRow = async (id: string) => (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, id) }))!;
const keyed = (pm = "pm_card_visa_debit") => ({ method: "card" as const, paymentMethodId: pm, entryMode: "keyed" as const });

describe("handing a ticket to the client", () => {
  it("prices the ticket, shows the itemized total, and the tip, receipt and card payment go on the sale", async () => {
    const { saleId, id } = await handedOver();
    expect(await H.activeHandoffFor(saleId)).toMatchObject({ id });
    let v = await H.handoffView(id);
    expect(v.status).toBe("active");
    expect(v.steps).toEqual(["tip", "receipt", "pay", "done"]);
    expect(v.lines).toEqual([expect.objectContaining({ qty: 1, cents: fx.cut.priceCents })]);
    expect(v.barbers).toEqual(["Michelle"]);
    expect(v.tips.choices.map((c) => c.key)).toEqual(["p20", "p25", "p30"]);
    expect(v.tips.choices[0].cents).toBe(Math.round(fx.cut.priceCents * 0.2));

    await expect(H.payHandoff(id, keyed(), v.totalCents)).rejects.toThrow(/tip first/);
    v = await H.chooseTip(id, "p20", 1);
    expect(v.tip).toEqual({ cents: Math.round(fx.cut.priceCents * 0.2), choice: "p20", source: "screen" });
    await expect(H.chooseTip(id, "p19", 0)).rejects.toThrow(/one of the tips/);
    await expect(H.chooseTip(id, "custom", 60_000)).rejects.toThrow(/entered at the counter/);
    await expect(H.payHandoff(id, keyed(), v.totalCents)).rejects.toThrow(/receipt/);
    await expect(H.chooseReceipt(id, { channel: "sms", onFile: false, to: "12" })).rejects.toThrow(/10-digit/);
    v = await H.chooseReceipt(id, { channel: "sms", onFile: false, to: "(319) 555-0142" });
    expect(v.receipt.masked).toMatch(/0142$/);
    expect(v.receipt.masked).not.toContain("555");

    await expect(m.checkout.finalizeSale({ saleId, lines: [{ kind: "service", refId: fx.cut.id, qty: 1 }], tipCents: 0, tender: { method: "cash", cashTenderedCents: null }, actor })).rejects.toThrow(
      /with the client/,
    );
    await expect(H.startHandoff(saleId, draft([{ kind: "service", refId: fx.cut.id, qty: 1 }]), by(fx.michelle))).rejects.toThrow(/already with the client/);

    await expect(H.payHandoff(id, keyed("pm_card_visa"), v.totalCents)).rejects.toThrow();
    const paid = await H.payHandoff(id, keyed("pm_card_visa"), v.creditTotalCents);
    expect(paid.saleId).toBe(saleId);
    const sale = await saleRow(saleId);
    expect(sale).toMatchObject({ status: "paid", tipCents: v.tipCents, totalCents: v.creditTotalCents });
    expect(sale.cardFeeCents).toBe(v.creditFeeCents);
    expect(await H.handoffView(id)).toMatchObject({ status: "paid", dueCents: sale.totalCents, creditFeeCents: sale.cardFeeCents, feeLabel: expect.stringMatching(/surcharge/) });
    const row = await handoffRow(id);
    expect(row).toMatchObject({ status: "paid", receiptChannel: "sms", receiptTo: null });
    const [job] = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.kind, "receipt"), eq(s().notificationJobs.to, "+13195550142")));
    expect(job.body).toContain(`#${sale.number}`);
    expect(job.body).toMatch(/\/receipt\/[A-Za-z0-9_-]{43} /);
    await expect(H.chooseTip(id, "none", 0)).rejects.toThrow(/paid/);
    expect((await H.handoffOnSale(saleId)).screen).toMatchObject({ tipSource: "screen", receiptChannel: "sms" });

    await tl.syncTipLedger();
    const tips = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId));
    expect(tips).toEqual([expect.objectContaining({ staffId: fx.michelle, amountCents: v.tipCents, kind: "tip" })]);
  });

  it("asks for a signature where the location wants one, and a new tip is signed for again", async () => {
    await setRules({ signature: true });
    const { id } = await handedOver();
    let v = await H.handoffView(id);
    expect(v.steps).toEqual(["tip", "signature", "receipt", "pay", "done"]);
    await H.chooseTip(id, "none", 0);
    await H.chooseReceipt(id, { channel: "none", onFile: false });
    await expect(H.payHandoff(id, keyed(), v.totalCents)).rejects.toThrow(/Sign first/);
    await expect(H.sign(id, "M1 1")).rejects.toThrow(/Sign in the box/);
    await expect(H.sign(id, "<script>")).rejects.toThrow(/isn't a signature/);
    v = await H.sign(id, "M10 10 L20 20 L30 25 L40 30");
    expect(v.signed).toBe(true);
    v = await H.chooseTip(id, "p25", 0);
    expect(v.signed).toBe(false);
    await H.sign(id, "M10 10 L20 20 L30 25 L40 30");
    v = await H.chooseTip(id, "p25", 0);
    expect(v.signed).toBe(true);
    await H.payHandoff(id, keyed(), v.totalCents);
    expect((await handoffRow(id)).signature).toContain("L40 30");
  });

  it("staff ending it from another device sends the screen back, and checkout picks the ticket back up", async () => {
    const { saleId, id } = await handedOver();
    await H.chooseTip(id, "p30", 0);
    await H.endHandoffFromCounter(saleId, actor);
    expect(await H.activeHandoffFor(saleId)).toBeNull();
    await expect(H.chooseReceipt(id, { channel: "none", onFile: false })).rejects.toThrow(/took this ticket back/);
    expect(await H.resumeDraft(saleId, id)).toMatchObject({ tipCents: Math.round(fx.cut.priceCents * 0.3), cash: false });
    await expect(H.endHandoffFromCounter(saleId, actor)).rejects.toThrow(/isn't with the client/);
  });
});

describe("the lock", () => {
  it("keeps the browser on the ticket's screen: other pages redirect, actions are refused, the staff session is off", async () => {
    const { saleId, id } = await handedOver();
    const token = await lock.handoffToken(id);
    const req = (path: string, init: { method?: string; action?: boolean } = {}) =>
      new NextRequest(`http://localhost${path}`, { method: init.method ?? "GET", headers: { cookie: `rayz_handoff=${token}`, ...(init.action ? { "next-action": "abc" } : {}) } });

    const away = await mw.middleware(req("/admin/calendar"));
    expect(away.status).toBe(307);
    expect(new URL(away.headers.get("location")!).pathname).toBe(`/handoff/${id}`);
    expect((await mw.middleware(req(`/admin/checkout/${saleId}`))).headers.get("location")).toContain(`/handoff/${id}`);
    expect((await mw.middleware(req("/book/coralville"))).headers.get("location")).toContain(`/handoff/${id}`);
    expect((await mw.middleware(req("/handoff/00000000-0000-4000-8000-000000000000"))).headers.get("location")).toContain(`/handoff/${id}`);
    const action = await mw.middleware(req("/admin/calendar", { method: "POST", action: true }));
    expect(action.status).toBe(403);
    expect(await action.text()).toMatch(/handed to a client/);
    const own = await mw.middleware(req(`/handoff/${id}`));
    expect(own.headers.get("location")).toBeNull();
    expect((await mw.middleware(req(`/handoff/${id}`, { method: "POST", action: true }))).status).not.toBe(403);
    const forged = new NextRequest("http://localhost/admin/calendar", { headers: { cookie: "rayz_handoff=not-a-token" } });
    expect((await mw.middleware(forged)).headers.get("location")).toContain("/login");

    await signInAs(fx.michelle, fx.shopId);
    expect(await staffAuth.getStaffContext()).not.toBeNull();
    jar.handoff = token;
    expect(await staffAuth.getStaffContext()).toBeNull();

    await H.endHandoffFromCounter(saleId, actor);
    expect(await lock.lockedHandoff(token)).toBeNull();
    expect(await staffAuth.getStaffContext()).not.toBeNull();
    const after = await mw.middleware(req("/admin/calendar"));
    expect(after.headers.get("location") ?? "").not.toContain("/handoff/");
    expect(after.cookies.get("rayz_handoff")?.value ?? "").toBe("");
    await signInAs(null);
  });

  it("'Hand to customer' sets the lock cookie, and only that browser drives the customer screen", async () => {
    await signInAs(fx.michelle, fx.shopId);
    const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
    const r = await posActions.handToCustomerAction(sale.id, draft([{ kind: "service", refId: fx.cut.id, qty: 1 }]));
    if (!r.ok) throw new Error(r.error);
    expect(await lock.handoffIdFrom(jar.handoff)).toBe(r.data.id);
    expect(await staffAuth.getStaffContext()).toBeNull();
    const ok = await screenActions.tipAction(r.data.id, "none", 0);
    expect(ok.ok).toBe(true);

    const mine = jar.handoff;
    jar.handoff = undefined;
    for (const call of [() => screenActions.viewAction(r.data.id), () => screenActions.tipAction(r.data.id, "none", 0), () => screenActions.unlockAction(r.data.id, fx.michelle, PIN.michelle)]) {
      const res = await call();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/isn't open on this device/);
    }
    const other = await handedOver();
    jar.handoff = await lock.handoffToken(other.id);
    expect((await screenActions.tipAction(r.data.id, "none", 0)).ok).toBe(false);

    jar.handoff = mine;
    const back = await screenActions.unlockAction(r.data.id, fx.makenna, PIN.makenna);
    if (!back.ok) throw new Error(back.error);
    expect(back.data.path).toBe(`/admin/checkout/${sale.id}?resume=${r.data.id}`);
    expect(jar.handoff).toBeUndefined();
    expect(await staffAuth.getStaffContext()).not.toBeNull();
    await H.endHandoffFromCounter(other.saleId, actor);
    await signInAs(null);
  });

  it("is checked against the ticket every request: an ended hand-off no longer locks, even with a valid cookie", async () => {
    const { saleId, id } = await handedOver();
    const token = await lock.handoffToken(id);
    expect(await lock.lockedHandoff(token)).toMatchObject({ id, saleId });
    expect(await lock.handoffIdFrom(await (await import("@/server/auth/tokens")).signToken({ hid: id }, "staff_session", 60))).toBeNull();
    await H.endHandoffFromCounter(saleId, actor);
    expect(await lock.lockedHandoff(token)).toBeNull();
  });
});

describe("taking the device back", () => {
  it("any staff PIN by default; a wrong PIN counts toward the time clock lockout; cash goes back to checkout with the tip", async () => {
    const { saleId, id } = await handedOver();
    const people = await H.unlockPeople(id);
    expect(people.rule).toBe("staff");
    expect(people.people.map((p) => p.id)).toEqual(expect.arrayContaining([fx.michelle, fx.makenna, fx.delaney]));
    await H.chooseTip(id, "custom", 700);
    await H.requestCash(id);
    expect((await H.handoffView(id)).cashRequested).toBe(true);
    await expect(H.unlockHandoff(id, fx.delaney, "0000")).rejects.toThrow(/Wrong PIN/);
    expect((await m.db.db.query.staff.findFirst({ where: eq(s().staff.id, fx.delaney) }))!.clockPinFailures).toBe(1);
    const r = await H.unlockHandoff(id, fx.delaney, PIN.delaney);
    expect(r.path).toBe(`/admin/checkout/${saleId}?resume=${id}`);
    expect(await handoffRow(id)).toMatchObject({ status: "returned", endedBy: fx.delaney });
    const resume = (await H.resumeDraft(saleId, id))!;
    expect(resume).toMatchObject({ tipCents: 700, tipChoice: "custom", cash: true });
    await m.checkout.finalizeSale({ saleId, ...resume, lines: resume.lines, tipCents: resume.tipCents!, tender: { method: "cash", cashTenderedCents: null }, actor });
    expect((await saleRow(saleId)).tipCents).toBe(700);
  });

  it("a manager's PIN only, where the location asks for it", async () => {
    await setRules({ unlock: "manager" });
    const { id } = await handedOver();
    const people = await H.unlockPeople(id);
    expect(people.rule).toBe("manager");
    expect(people.people.map((p) => p.id)).toContain(fx.michelle);
    expect(people.people.map((p) => p.id)).not.toContain(fx.makenna);
    await expect(H.unlockHandoff(id, fx.makenna, PIN.makenna)).rejects.toThrow(/manager's PIN/);
    expect((await handoffRow(id)).status).toBe("active");
    await H.unlockHandoff(id, fx.michelle, PIN.michelle);
    expect((await handoffRow(id)).status).toBe("returned");
  });

  it("after payment, the thank-you screen gives the device back by itself, or waits for a PIN", async () => {
    await setRules({ afterPayment: "auto", thankYouSeconds: 5 });
    const a = await handedOver();
    const token = await lock.handoffToken(a.id);
    await H.chooseTip(a.id, "none", 0);
    await H.chooseReceipt(a.id, { channel: "none", onFile: false });
    const now = new Date();
    const v = await H.handoffView(a.id);
    const paid = await H.payHandoff(a.id, keyed(), v.totalCents, now);
    expect(new Date(paid.returnsAt!).getTime() - now.getTime()).toBe(5000);
    expect((await H.handoffView(a.id)).returnsAt).toBe(paid.returnsAt);
    expect(await lock.lockedHandoff(token, new Date(now.getTime() + 4000))).not.toBeNull();
    expect(await lock.lockedHandoff(token, new Date(now.getTime() + 6000))).toBeNull();
    expect((await H.finishHandoff(a.id)).path).toBe(`/admin/sales/${a.saleId}?done=1`);
    expect(await lock.lockedHandoff(token)).toBeNull();

    await setRules({ afterPayment: "pin" });
    const b = await handedOver();
    const tb = await lock.handoffToken(b.id);
    await H.chooseTip(b.id, "none", 0);
    await H.chooseReceipt(b.id, { channel: "none", onFile: false });
    const pb = await H.payHandoff(b.id, keyed(), (await H.handoffView(b.id)).totalCents);
    expect(pb.returnsAt).toBeNull();
    await expect(H.finishHandoff(b.id)).rejects.toThrow(/PIN/);
    expect(await lock.lockedHandoff(tb, new Date(Date.now() + 3_600_000))).not.toBeNull();
    expect((await H.unlockHandoff(b.id, fx.makenna, PIN.makenna)).path).toBe(`/admin/sales/${b.saleId}?done=1`);
    expect(await lock.lockedHandoff(tb)).toBeNull();
  });
});

describe("tips on the reader", () => {
  it("skips the screen's tip step, takes the tip from the reader, and pays on the reader", async () => {
    const [reader] = await m.db.db
      .insert(s().terminalReaders)
      .values({ shopId: fx.shopId, label: "Front counter", stripeReaderId: "tmr_sim_handoff", active: true })
      .returning();
    await setRules({ tipEntry: "reader" });
    const { saleId, id } = await handedOver();
    let v = await H.handoffView(id);
    expect(v.pay.readerTips).toBe(true);
    expect(v.steps).toEqual(["receipt", "pay", "done"]);
    await H.chooseReceipt(id, { channel: "none", onFile: false });
    const terminal = { method: "card" as const, paymentMethodId: "pm_card_visa_debit", entryMode: "terminal" as const, readerId: reader.id };
    await expect(H.payHandoff(id, terminal, v.totalCents)).rejects.toThrow(/reader first/);
    await expect(H.collectOnReader(id, { testCard: "pm_card_visa_debit", readerId: reader.id })).rejects.toThrow(/tip first/);
    const got = await H.collectOnReader(id, { testCard: "pm_card_visa_debit", readerId: reader.id, tip: { choice: "p25", cents: 0 } });
    v = got.view;
    expect(got.card).toMatchObject({ funding: "debit", last4: "5556" });
    expect(v.tip).toEqual({ cents: Math.round(fx.cut.priceCents * 0.25), choice: "p25", source: "reader" });
    await H.payHandoff(id, terminal, v.totalCents);
    expect((await saleRow(saleId)).tipCents).toBe(v.tipCents);
    expect((await H.handoffOnSale(saleId)).screen?.tipSource).toBe("reader");
    expect(await H.syncReaderTipping(fx.shopId, (await H.shopHandoffConfig(fx.shopId)).tips)).toMatchObject({ status: "skipped" });
    await m.db.db.update(s().terminalReaders).set({ active: false }).where(eq(s().terminalReaders.id, reader.id));
  });

  it("falls back to the screen's tip step when the shop has no reader", async () => {
    await setRules({ tipEntry: "reader" });
    const { id } = await handedOver();
    const v = await H.handoffView(id);
    expect(v.pay.readerTips).toBe(false);
    expect(v.steps[0]).toBe("tip");
  });
});

describe("split tips", () => {
  it("splits a ticket's tip between its barbers by services or evenly, into the ledger, reports and payroll", async () => {
    const lines = [
      { kind: "service" as const, refId: fx.cut.id, qty: 1 },
      { kind: "service" as const, refId: fx.beard.id, qty: 1, staffId: fx.makenna },
    ];
    const { saleId, id } = await handedOver(lines, "services");
    let v = await H.handoffView(id);
    expect(v.barbers.sort()).toEqual(["Makenna", "Michelle"]);
    v = await H.chooseTip(id, "custom", 1001);
    expect(v.split.reduce((a, x) => a + x.cents, 0)).toBe(1001);
    await H.chooseReceipt(id, { channel: "none", onFile: false });
    await H.payHandoff(id, keyed(), v.totalCents);

    const shares = await m.db.db.select().from(s().saleTipShares).where(eq(s().saleTipShares.saleId, saleId));
    expect(shares.map((x) => x.staffId).sort()).toEqual([fx.michelle, fx.makenna].sort());
    const items = await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, saleId));
    const net = (staffId: string) => items.filter((i) => i.staffId === staffId).reduce((a, i) => a + i.netCents, 0);
    const want = new Map([
      [fx.michelle, net(fx.michelle)],
      [fx.makenna, net(fx.makenna)],
    ]);
    const { splitCents } = await import("@/domain/handoff");
    const expected = splitCents(1001, [...want].map(([id, weight]) => ({ id, weight })));
    const paidView = await H.handoffView(id);
    expect(paidView.status).toBe("paid");
    expect(paidView.split.map((x) => x.cents).sort()).toEqual([...expected.values()].sort());

    await tl.syncTipLedger();
    const ledger = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId));
    expect(ledger).toHaveLength(2);
    for (const e of ledger) expect(e.amountCents).toBe(expected.get(e.staffId));
    expect(ledger.reduce((a, e) => a + e.amountCents, 0)).toBe(1001);
    await tl.syncTipLedger();
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId))).toHaveLength(2);

    const scope = { shopIds: [fx.shopId], from: today, to: today };
    const before = await m.reports.byBarber(scope);
    const tipsOf = (rows: typeof before, staffId: string) => rows.find((r) => r.staffId === staffId)?.tipsCents ?? 0;
    const sum = await m.reports.salesSummary(scope);
    expect(before.reduce((a, r) => a + r.tipsCents, 0)).toBe(sum.tipsCents);

    const refund = await m.checkout.refundSale({ saleId, items: [], tipCents: 401, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    expect(refund).toBeTruthy();
    await tl.syncTipLedger();
    const reversals = (await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId))).filter((e) => e.amountCents < 0);
    expect(reversals.reduce((a, e) => a + e.amountCents, 0)).toBe(-401);
    const after = await m.reports.byBarber(scope);
    const refundShares = splitCents(401, [...want].map(([id, weight]) => ({ id, weight })));
    expect(tipsOf(before, fx.makenna) - tipsOf(after, fx.makenna)).toBe(refundShares.get(fx.makenna));
    expect(tipsOf(before, fx.michelle) - tipsOf(after, fx.michelle)).toBe(refundShares.get(fx.michelle));
    expect(after.reduce((a, r) => a + r.tipsCents, 0)).toBe((await m.reports.salesSummary(scope)).tipsCents);

    const payroll = await m.reports.payrollSalesBetween({ shopIds: [fx.shopId] }, today, today);
    const tipTotal = payroll.reduce((a, r) => a + r.cardTipsCents + r.cashTipsCents + r.giftCardTipsCents, 0);
    expect(tipTotal).toBe((await m.reports.salesSummary(scope)).tipsCents);
    const mk = payroll.find((r) => r.staffId === fx.makenna)!;
    expect(mk.cardTipsCents + mk.cashTipsCents + mk.giftCardTipsCents).toBe(tipsOf(after, fx.makenna));
    expect(mk.tipRefundsCents).toBeGreaterThanOrEqual(refundShares.get(fx.makenna)!);
  });

  it("splits evenly when asked, and from the counter too", async () => {
    const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.delaney);
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [
        { kind: "service", refId: fx.cut.id, qty: 1 },
        { kind: "service", refId: fx.beard.id, qty: 1, staffId: fx.makenna },
      ],
      tipCents: 1001,
      tipSplit: "even",
      tender: { method: "cash", cashTenderedCents: null },
      actor,
    });
    await tl.syncTipLedger();
    const ledger = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, sale.id));
    const [lo, hi] = [fx.delaney, fx.makenna].sort();
    expect(Object.fromEntries(ledger.map((e) => [e.staffId, e.amountCents]))).toEqual({ [lo]: 501, [hi]: 500 });
    const view = await m.db.db.execute<{ staff_id: string; tip_cents: number }>(m.drizzle.sql`select staff_id, tip_cents from tip_split_shares where sale_id = ${sale.id}`);
    expect(Object.fromEntries([...view].map((r) => [r.staff_id, Number(r.tip_cents)]))).toEqual({ [lo]: 501, [hi]: 500 });
  });

  it("refuses a barber who doesn't work at the shop", async () => {
    const outsider = (await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, "Owner")))[0];
    const sale = await m.checkout.openBlankSale(fx.shopId, actor, fx.michelle);
    const lines = [{ kind: "service" as const, refId: fx.cut.id, qty: 1, staffId: outsider.id }];
    await expect(H.startHandoff(sale.id, draft(lines), by(fx.michelle))).rejects.toThrow(/doesn.t work at this shop/);
  });
});

describe("settings", () => {
  it("validates presets, uses the brand's unless the location sets its own, and keeps the counter's percent buttons in step", async () => {
    await expect(H.saveBrandHandoff({ type: "percent", values: [], allowCustom: true, allowNoTip: true }, actor)).rejects.toThrow(/at least one/);
    await H.saveBrandHandoff({ type: "amount", values: [300, 500, 1000], allowCustom: true, allowNoTip: false }, actor);
    let cfg = await H.shopHandoffConfig(fx.shopId);
    expect(cfg.tips).toMatchObject({ type: "amount", values: [300, 500, 1000] });
    const { id } = await handedOver();
    const v = await H.handoffView(id);
    expect(v.tips.choices.map((c) => c.label)).toEqual(["$3", "$5", "$10"]);
    expect(v.tips.allowNoTip).toBe(false);
    await expect(H.chooseTip(id, "none", 0)).rejects.toThrow(/Choose a tip/);

    await expect(H.saveShopHandoff(fx.shopId, { ...cfg.shop, thankYouSeconds: 600 }, actor)).rejects.toThrow(/seconds/);
    await H.saveShopHandoff(fx.shopId, { ...cfg.shop, tips: { type: "percent", values: [18, 20, 25], allowCustom: true, allowNoTip: true } }, actor);
    cfg = await H.shopHandoffConfig(fx.shopId);
    expect(cfg.tips.values).toEqual([18, 20, 25]);
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, fx.shopId) }))!.tipPresets).toEqual([18, 20, 25]);
    const audits = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "handoff.settings"));
    expect(audits.length).toBeGreaterThan(0);
    await H.saveBrandHandoff({ type: "percent", values: [20, 25, 30], allowCustom: true, allowNoTip: true }, actor);
  });

  it("writes the text and email receipts from the paid ticket", async () => {
    const { saleId, id } = await handedOver();
    await H.chooseTip(id, "custom", 500);
    await H.chooseReceipt(id, { channel: "email", onFile: false, to: "Client@Example.com" });
    expect((await handoffRow(id)).receiptTo).toBe("client@example.com");
    await H.payHandoff(id, keyed(), (await H.handoffView(id)).totalCents);
    const R = await import("@/server/receipts");
    const email = await R.composeReceipt(saleId, "email", "https://example.test/receipt/x");
    expect(email.subject).toMatch(/receipt/i);
    expect(email.body).toMatch(/Tip\s+\$5\.00/);
    expect(email.body).toMatch(/Visa •••• 5556/i);
    const sms = await R.composeReceipt(saleId, "sms", "https://example.test/receipt/x");
    expect(sms.body.length).toBeLessThan(320);
    const [job] = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.kind, "receipt"), eq(s().notificationJobs.to, "client@example.com")));
    expect(job).toMatchObject({ channel: "email", shopId: fx.shopId });
    expect(job.body).toMatch(/\/receipt\/[A-Za-z0-9_-]{43}/);
    const [d] = await m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, saleId));
    expect(d).toMatchObject({ purpose: "handoff", channel: "email", destination: "client@example.com", jobId: job.id });
  });

  it("records 'no receipt', and doesn't offer or take a number that replied STOP", async () => {
    const { saleId, id } = await handedOver();
    await H.chooseTip(id, "none", 0);
    await m.db.db.insert(s().contactOptOuts).values({ phone: "+13195550177", channel: "sms", source: "reply" }).onConflictDoNothing();
    await expect(H.chooseReceipt(id, { channel: "sms", onFile: false, to: "319-555-0177" })).rejects.toThrow(/STOP/);
    await H.chooseReceipt(id, { channel: "none", onFile: false });
    await H.payHandoff(id, keyed(), (await H.handoffView(id)).totalCents);
    const rows = await m.db.db.select().from(s().receiptDeliveries).where(eq(s().receiptDeliveries.saleId, saleId));
    expect(rows).toEqual([expect.objectContaining({ channel: "none", purpose: "handoff", destination: null, tokenHash: null })]);
  });
});
