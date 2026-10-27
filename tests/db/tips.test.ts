/**
 * Tip payouts against a real database: the ledger from checkout, refunds and voids; card tips
 * waiting for settlement; a tip never paid twice; cash tips out of the drawer; Stripe payout and
 * transfer webhooks; and the payroll export showing tips already paid.
 */
import Stripe from "stripe";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let run: typeof import("@/server/payroll/run");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  connectWebhook = await import("@/server/payments/connect-webhook");
  run = await import("@/server/payroll/run");
  today = m.time.todayLocal();
  // Batches by hand and cash by default here, so each test builds the batches it checks.
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  // The seed's last few days of tips start unpaid; settle them so each test sees only its own.
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  // These tests cover reversals, so the window rule; the brand's default is that the shop absorbs every refunded tip.
  const [b] = await m.db.db.select({ v: m.schema.brandSettings.staffPayouts }).from(m.schema.brandSettings);
  savedPayouts = (b?.v as Record<string, unknown>) ?? {};
  await m.db.db.update(m.schema.brandSettings).set({ staffPayouts: { ...savedPayouts, reversalRule: "full_refund_in_window", reversalWindowDays: 7 } });
}, 180_000);

let savedPayouts: Record<string, unknown> = {};
afterAll(async () => {
  if (m) await m.db.db.update(m.schema.brandSettings).set({ staffPayouts: savedPayouts });
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const card = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;

/** Barbers who work only at this shop (or nowhere else these tests touch), so one test's tips never show up in another's. */
async function barbers(slug: string, labels: string[]) {
  const sh = await shop(slug);
  const rows = await m.db.db
    .select({ id: s().staff.id, firstName: s().staff.firstName, lastName: s().staff.lastName, label: s().staff.displayLabel })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, sh.id), m.drizzle.inArray(s().staff.displayLabel, labels)));
  expect(rows).toHaveLength(labels.length);
  return { shop: sh, barbers: labels.map((l) => rows.find((r) => r.label === l)!) };
}

async function tipSale(shopId: string, staffId: string, tipCents: number, tender: typeof card | typeof cash) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender, actor });
  return sale;
}

const entriesOf = (saleId: string) => m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId)).orderBy(s().tipLedger.createdAt);
const payoutsOf = (batchId: string) => m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.batchId, batchId));
const mine = async (batchId: string, staffId: string) => (await payoutsOf(batchId)).find((p) => p.staffId === staffId) ?? null;

describe("tip ledger", () => {
  it("records every card and cash tip per employee, shop and ticket; refunds and voids reverse them", async () => {
    const { shop: sh, barbers: [b] } = await barbers("kimberly", ["Beth"]);
    const start = (await tl.myTips(b.id, [sh.id], today)).total;
    const cardSale = await tipSale(sh.id, b.id, 1000, card);
    const [tip] = await entriesOf(cardSale.id);
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, cardSale.id));
    expect(tip).toMatchObject({ shopId: sh.id, staffId: b.id, kind: "tip", method: "card", amountCents: 1000, businessDate: today, paymentId: pay.id, payoutId: null });
    expect(tip.feeCents).toBe(Math.round(((pay.processorFeeCents || pay.applicationFeeCents || 0) * 1000) / pay.amountCents));
    expect(tip.feeCents).toBeGreaterThan(0);

    // A partial refund doesn't take tip back from the barber: the shop absorbs it (ST-C15).
    await m.checkout.refundSale({ saleId: cardSale.id, items: [], tipCents: 400, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    expect(await entriesOf(cardSale.id)).toHaveLength(1);
    const absorbed = await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, cardSale.id));
    expect(absorbed).toEqual([expect.objectContaining({ kind: "partial_refund", amountCents: 400, staffId: b.id, shopId: sh.id })]);

    // A full refund within the window reverses the tip, fee and all.
    const fullSale = await tipSale(sh.id, b.id, 800, card);
    const [fullTip] = await entriesOf(fullSale.id);
    await m.refunds.refundEverything(fullSale.id, "Client unhappy", false, actor);
    const [, back] = await entriesOf(fullSale.id);
    expect(back).toMatchObject({ kind: "refund", method: "card", amountCents: -800, feeCents: -fullTip.feeCents, staffId: b.id });

    const cashSale = await tipSale(sh.id, b.id, 500, cash);
    await m.checkout.voidSale(cashSale.id, "Rang up the wrong client", actor);
    expect((await entriesOf(cashSale.id)).map((e) => [e.kind, e.method, e.amountCents])).toEqual([
      ["tip", "cash", 500],
      ["refund", "cash", -500],
    ]);

    const count = async () => (await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.staffId, b.id), eq(s().tipLedger.shopId, sh.id)))).length;
    const before = await count();
    await tl.syncTipLedger();
    expect(await count()).toBe(before);

    const t = await tl.myTips(b.id, [sh.id], today);
    expect(t.total.todayCents - start.todayCents).toBe(1000);
    expect(t.total.availableCents - start.availableCents).toBe(1000);
  });

  it("the ledger is append-only: amounts, people and dates can't be edited", async () => {
    const [e] = await m.db.db.select().from(s().tipLedger).limit(1);
    await expect(m.db.db.update(s().tipLedger).set({ amountCents: e.amountCents + 100 }).where(eq(s().tipLedger.id, e.id))).rejects.toThrow();
    await expect(m.db.db.update(s().tipLedger).set({ businessDate: "2020-01-01" }).where(eq(s().tipLedger.id, e.id))).rejects.toThrow();
  });
});

describe("delayed availability", () => {
  it("card tips wait the shop's settlement delay; cash tips are paid at once", async () => {
    const { shop: sh, barbers: [b] } = await barbers("moline", ["Jilane"]);
    expect(await tl.shopTipConfig(sh.id)).toMatchObject({ schedule: "daily_delay", cardDelayDays: 2 });
    await tipSale(sh.id, b.id, 1500, card);
    await tipSale(sh.id, b.id, 300, cash);

    const t = await tl.myTips(b.id, [sh.id], today);
    expect(t.total).toMatchObject({ pendingSettlementCents: 1500, availableCents: 300 });

    const first = await tp.buildBatch({ shopId: sh.id, kind: "daily_delay", cutoff: today, asOf: today, actor });
    expect(await mine(first.batchId, b.id)).toMatchObject({ grossCents: 300, netCents: 300, status: "pending" });
    await tp.cancelBatch(first.batchId, "Testing the delay", actor);
    expect(await mine(first.batchId, b.id)).toMatchObject({ status: "cancelled" });

    const later = await tp.buildBatch({ shopId: sh.id, kind: "daily_delay", cutoff: today, asOf: m.time.addDays(today, 2), actor });
    expect(later.batchId).not.toBe(first.batchId);
    expect(await mine(later.batchId, b.id)).toMatchObject({ grossCents: 1800, netCents: 1800 });
    await tp.cancelBatch(later.batchId, "Done", actor);
  });

  it("cancelling needs a reason, and goes in the audit log", async () => {
    const { shop: sh, barbers: [b] } = await barbers("moline", ["Jilane"]);
    await tipSale(sh.id, b.id, 200, cash);
    const r = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    await expect(tp.cancelBatch(r.batchId, "  ", actor)).rejects.toMatchObject({ message: "A reason is required" });
    await tp.cancelBatch(r.batchId, "Wrong day", actor);
    const [a] = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.batch_cancel"), eq(s().auditLog.entityId, r.batchId)));
    expect(a.details).toMatchObject({ reason: "Wrong day" });
  });
});

describe("double-payout prevention", () => {
  it("rebuilding a batch reuses the same payout, and claimed tips can't move to another one", async () => {
    const { shop: sh, barbers: [b] } = await barbers("le-claire", ["Audra"]);
    const sale = await tipSale(sh.id, b.id, 700, cash);
    const one = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const two = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect(two.batchId).toBe(one.batchId);
    expect((await payoutsOf(one.batchId)).filter((p) => p.staffId === b.id)).toHaveLength(1);
    const p = (await mine(one.batchId, b.id))!;
    const [entry] = await entriesOf(sale.id);
    expect(entry.payoutId).toBe(p.id);

    await expect(m.db.db.insert(s().tipPayouts).values({ batchId: one.batchId, shopId: sh.id, staffId: b.id, method: "cash" })).rejects.toThrow();
    const [other] = await m.db.db.select({ id: s().tipPayouts.id }).from(s().tipPayouts).where(m.drizzle.ne(s().tipPayouts.id, p.id)).limit(1);
    await expect(m.db.db.update(s().tipLedger).set({ payoutId: other.id }).where(eq(s().tipLedger.id, entry.id))).rejects.toThrow();

    await tp.approveBatch(one.batchId, actor);
    expect((await mine(one.batchId, b.id))!.status).toBe("approved");
    await expect(m.db.db.update(s().tipLedger).set({ payoutId: null }).where(eq(s().tipLedger.id, entry.id))).rejects.toThrow();
    await expect(m.db.db.delete(s().tipLedger).where(eq(s().tipLedger.id, entry.id))).rejects.toThrow();

    const next = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect(await mine(next.batchId, b.id)).toBeNull();
    await tp.cancelBatch(next.batchId, "Nothing to pay", actor);

    await tp.acknowledgeCashPayout({ payoutId: p.id, by: "name", name: `${b.firstName} ${b.lastName}`, actor });
    await expect(tp.acknowledgeCashPayout({ payoutId: p.id, by: "name", name: `${b.firstName} ${b.lastName}`, actor })).rejects.toMatchObject({ message: "That payout was already paid." });
    await expect(tp.approveBatch(one.batchId, actor)).rejects.toMatchObject({ code: "conflict" });
    expect((await tl.myTips(b.id, [sh.id], today)).total).toMatchObject({ paidOutCents: expect.any(Number), availableCents: 0, inPayoutCents: 0 });
  });

  it("a hold or adjustment needs a reason; managers can't adjust their own tips", async () => {
    const { shop: sh, barbers: [b] } = await barbers("le-claire", ["Audra"]);
    await tipSale(sh.id, b.id, 900, cash);
    const r = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const p = (await mine(r.batchId, b.id))!;
    await expect(tp.holdPayout(p.id, "", actor)).rejects.toMatchObject({ message: "A reason is required" });
    await expect(tp.adjustPayout(p.id, -100, "", actor)).rejects.toMatchObject({ message: "A reason is required" });
    await expect(tp.adjustPayout(p.id, -100, "Mine", { staffId: b.id, label: b.label })).rejects.toMatchObject({ code: "forbidden" });
    await expect(tp.adjustPayout(p.id, -1000, "Too much", actor)).rejects.toMatchObject({ message: expect.stringMatching(/below zero/) });
    await tp.adjustPayout(p.id, -150, "Split with the shampoo assistant", actor);
    expect(await mine(r.batchId, b.id)).toMatchObject({ grossCents: 900, adjustCents: -150, netCents: 750 });
    await tp.holdPayout(p.id, "Checking the split", actor);
    await tp.approveBatch(r.batchId, actor);
    expect((await mine(r.batchId, b.id))!.status).toBe("held");
    await tp.removePayout(p.id, "Pay next week", actor);
    const released = await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.staffId, b.id), eq(s().tipLedger.shopId, sh.id), m.drizzle.isNull(s().tipLedger.payoutId)));
    expect(released.reduce((a, e) => a + e.amountCents, 0)).toBe(750);
    const audits = await m.db.db.select({ action: s().auditLog.action, details: s().auditLog.details }).from(s().auditLog).where(eq(s().auditLog.entityId, p.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["tips.adjust", "tips.hold", "tips.remove"]);
    expect(audits.find((a) => a.action === "tips.adjust")!.details).toMatchObject({ reason: "Split with the shampoo assistant", cents: -150 });
  });
});

describe("tips are never reduced by fees (ST-C18)", () => {
  it("a surcharge on the tip and the processor's fee stay with the shop: the payout is the whole tip", async () => {
    const fee = await import("@/server/payments/card-fee");
    const { shop: sh, barbers: [b] } = await barbers("kimberly", ["Beth"]);
    const before = await fee.shopFeePolicy(sh.id);
    await fee.saveShopFeeOverride(actor, sh.id, { enabled: true, rate: 0.03, appliesToTip: true });
    await m.db.db.update(s().shops).set({ tipPayouts: { ...sh.tipPayouts, netCardFee: true } }).where(eq(s().shops.id, sh.id));
    onTestFinished(async () => {
      await fee.saveShopFeeOverride(actor, sh.id, before.override);
      await m.db.db.update(s().shops).set({ tipPayouts: sh.tipPayouts }).where(eq(s().shops.id, sh.id));
    });

    const sale = await tipSale(sh.id, b.id, 1000, card);
    const [row] = await m.db.db.select().from(s().sales).where(eq(s().sales.id, sale.id));
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, sale.id));
    expect(row.tipCents).toBe(1000);
    expect(pay.cardFeeCents).toBeGreaterThan(0);
    const [tip] = await entriesOf(sale.id);
    expect(tip).toMatchObject({ kind: "tip", amountCents: 1000 });
    expect(tip.feeCents).toBeGreaterThan(0);

    const batch = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const p = (await mine(batch.batchId, b.id))!;
    const inPayout = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, p.id));
    expect(inPayout.map((e) => e.id)).toContain(tip.id);
    expect(inPayout.some((e) => e.feeCents > 0)).toBe(true);
    expect(p.feeCents).toBe(0);
    expect(p.grossCents).toBe(inPayout.filter((e) => e.kind !== "adjust").reduce((a, e) => a + e.amountCents, 0));
    expect(p.netCents).toBe(p.grossCents + p.adjustCents);
    await tp.cancelBatch(batch.batchId, "ST-C18 check only", actor);

    const violates = async (q: Promise<unknown>) => {
      const err = (await q.then(() => null, (x: unknown) => x)) as { message?: string; cause?: { message?: string } } | null;
      return err ? `${err.message} ${err.cause?.message ?? ""}` : "no error";
    };
    const taken = (await payoutsOf(batch.batchId)).map((x) => x.staffId);
    const [other] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(m.drizzle.notInArray(s().staff.id, taken)).limit(1);
    const open = { batchId: batch.batchId, shopId: sh.id, staffId: other.id, method: "cash" as const, grossCents: 1000, feeCents: 30, netCents: 970 };
    expect(await violates(m.db.db.insert(s().tipPayouts).values(open))).toContain("tip_payouts_no_fee_on_open");
    expect(await violates(m.db.db.insert(s().staffCompensation).values({ staffId: b.id, effectiveFrom: today, tipCardFeeNetting: true }))).toContain("staff_compensation_no_tip_fee_netting");
  });
});

describe("cash tips from the drawer", () => {
  it("come out of the drawer count, are acknowledged by the employee, and must be settled before close", async () => {
    const { shop: sh, barbers: [b, c] } = await barbers("coralville", ["Delaney", "Jessica"]);
    await m.db.db.update(s().staff).set({ phone: "+13195550177", email: null }).where(eq(s().staff.id, b.id));
    expect(await tl.shopTipConfig(sh.id)).toMatchObject({ schedule: "end_of_night", defaultMethod: "cash" });
    await tipSale(sh.id, b.id, 900, cash);
    await tipSale(sh.id, b.id, 1100, card);
    await tipSale(sh.id, c.id, 400, cash);
    const before = await m.checkout.drawerSummary(sh.id, today);
    expect(before.tipPayoutsCents).toBe(0);

    const r = await tp.buildBatch({ shopId: sh.id, kind: "end_of_night", cutoff: today, actor });
    await tp.approveBatch(r.batchId, actor);
    const pb = (await mine(r.batchId, b.id))!;
    const pc = (await mine(r.batchId, c.id))!;
    expect([pb.method, pb.status, pb.netCents]).toEqual(["cash", "approved", 2000]);
    expect((await tp.cashAwaiting(sh.id)).map((x) => x.p.id).sort()).toEqual([pb.id, pc.id].sort());
    expect((await tp.batchesFor([sh.id])).find((x) => x.b.id === r.batchId)).toMatchObject({ payouts: 2, netCents: 2400, held: 0, failed: 0 });

    const close = { shopId: sh.id, date: today, openingFloatCents: before.openingFloatCents, payoutsCents: 0, countedCents: 0, actor };
    await expect(m.checkout.closeDrawer(close)).rejects.toMatchObject({ message: expect.stringMatching(/still waiting to be paid/) });

    await expect(tp.acknowledgeCashPayout({ payoutId: pb.id, by: "name", name: "Somebody Else", actor })).rejects.toMatchObject({ code: "bad_request" });
    await expect(tp.acknowledgeCashPayout({ payoutId: pb.id, by: "pin", pin: "4826", actor })).rejects.toThrow();
    const tc = await import("@/server/time-clock");
    await tc.setPin(b.id, "4826", actor);
    await expect(tp.acknowledgeCashPayout({ payoutId: pb.id, by: "pin", pin: "9999", actor })).rejects.toThrow();
    const paid = await tp.acknowledgeCashPayout({ payoutId: pb.id, by: "pin", pin: "4826", actor });
    expect(paid).toMatchObject({ status: "paid", drawerDate: today, ackMethod: "pin" });

    const mid = await m.checkout.drawerSummary(sh.id, today);
    expect(mid.tipPayoutsCents).toBe(2000);
    expect(mid.expectedCents).toBe(before.expectedCents - 2000);

    await tp.acknowledgeCashPayout({ payoutId: pc.id, by: "name", name: `  ${c.firstName.toUpperCase()} ${c.lastName} `, actor });
    const after = await m.checkout.drawerSummary(sh.id, today);
    expect(after.tipPayoutsCents).toBe(2400);
    const closed = await m.checkout.closeDrawer({ ...close, countedCents: after.expectedCents });
    expect(closed.varianceCents).toBe(0);
    const drawer = (await m.db.db.query.cashDrawers.findFirst({ where: and(eq(s().cashDrawers.shopId, sh.id), eq(s().cashDrawers.businessDate, today)) }))!;
    expect(drawer.tipPayoutsCents).toBe(2400);
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, r.batchId) }))!.status).toBe("completed");

    const texts = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.to, "+13195550177")));
    expect(texts).toEqual([expect.objectContaining({ channel: "sms", body: expect.stringMatching(/your tips were paid out, \$20\.00 in cash from the drawer/) })]);

    await tipSale(sh.id, b.id, 300, cash);
    const late = await tp.buildBatch({ shopId: sh.id, kind: "end_of_night", cutoff: today, actor });
    await tp.approveBatch(late.batchId, actor);
    await expect(tp.acknowledgeCashPayout({ payoutId: (await mine(late.batchId, b.id))!.id, by: "pin", pin: "4826", actor })).rejects.toMatchObject({ message: expect.stringMatching(/already closed/) });
  });
});

describe("Stripe payouts and webhooks", () => {
  const secret = "whsec_test_tips";
  const connectEvent = (type: string, object: object, account: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account, data: { object } });
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };
  const platformEvent = (type: string, object: object) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, data: { object } });
    return m.webhook.handleStripeWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };
  const acct = "acct_test_tip_staff";

  /** One Stripe payout for the employee, as if it's been sent and Stripe hasn't reported back yet. */
  async function inFlight(shopId: string, staffId: string, cents: number, n: number) {
    await tipSale(shopId, staffId, cents, cash);
    const r = await tp.buildBatch({ shopId, kind: "manual", cutoff: today, actor });
    const p = (await mine(r.batchId, staffId))!;
    expect(p).toMatchObject({ method: "stripe", status: "pending", stripeAccountId: acct });
    await tp.holdPayout(p.id, "Sending by hand in the test", actor);
    await tp.approveBatch(r.batchId, actor);
    await m.db.db
      .update(s().tipPayouts)
      .set({ status: "processing", stripeTransferId: `tr_test_tip_${n}`, stripePayoutId: `po_test_tip_${n}`, sentAt: new Date(), holdReason: null })
      .where(eq(s().tipPayouts.id, p.id));
    return { batchId: r.batchId, payoutId: p.id };
  }

  it("employees onboard on Stripe's hosted page; the app keeps only the account id, its status and the last 4 Stripe returns", async () => {
    const { barbers: [, c] } = await barbers("silvis", ["Abigail", "Liv"]);
    expect(await accounts.staffOnboardingUrl(c.id, actor, "http://localhost")).toBeNull();
    await accounts.simulateStaffOnboarding(c.id, actor);
    const a = (await accounts.staffAccount(c.id))!;
    expect(accounts.staffAccountState(a)).toBe("ready");
    expect(a).toMatchObject({ destinationType: "card", destinationLast4: "5556", destinationName: "Visa" });
    expect(a.taxForms).toBe("will_not_file");
    expect(Object.keys(a).filter((k) => k !== "taxForms" && /routing|account_?number|card_?number|ssn|tax|fingerprint|dob|birth/i.test(k))).toEqual([]);
  });

  it("an approved Stripe payout goes out (simulator) and the employee is told", async () => {
    const { shop: sh, barbers: [, c] } = await barbers("silvis", ["Abigail", "Liv"]);
    await m.db.db.update(s().staff).set({ email: "liv.tips@rayz.test" }).where(eq(s().staff.id, c.id));
    const [bs] = await m.db.db.select({ t: s().brandSettings.tipPayouts }).from(s().brandSettings);
    await m.db.db.update(s().brandSettings).set({ tipPayouts: { ...(bs?.t as object), instantAllowed: true } });
    onTestFinished(async () => {
      await m.db.db.update(s().brandSettings).set({ tipPayouts: bs?.t ?? {} });
    });
    // Instant payouts are off by default and need Stripe's fee accepted as shown (ST-I12).
    await expect(accounts.setPayoutChoice(c.id, { method: "stripe", instant: true }, actor)).rejects.toThrow(/Accept the fee/);
    await accounts.setPayoutChoice(c.id, { method: "stripe", instant: true, acceptInstantFee: accounts.currentInstantFeeTerms() }, actor);
    expect((await accounts.staffAccount(c.id))!).toMatchObject({ instant: true, instantFeeTerms: accounts.currentInstantFeeTerms() });
    await tipSale(sh.id, c.id, 2500, card);
    await tl.saveShopTipSettings(sh.id, { schedule: "manual", cardDelayDays: 0, weeklyDay: 1, defaultMethod: "cash" }, actor);
    const r = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    await tp.approveBatch(r.batchId, actor);
    const p = (await mine(r.batchId, c.id))!;
    expect(p).toMatchObject({ method: "stripe", status: "paid", instant: true, instantFeeCents: 50, netCents: 2500 });
    expect(p.stripeTransferId).toMatch(/^sim_tr_/);
    const [note] = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.to, "liv.tips@rayz.test")));
    expect(note.subject).toBe("Tip payout: $24.50");
    expect(note.body).toMatch(/Stripe's instant payout fee was \$0\.50/);
  });

  it("payout.paid marks it paid; payout.failed and transfer.reversed release its tips for the next batch", async () => {
    const { shop: sh, barbers: [b] } = await barbers("silvis", ["Abigail", "Liv"]);
    await m.db.db
      .insert(s().staffPayoutAccounts)
      .values({ staffId: b.id, method: "stripe", stripeAccountId: acct, simulated: false, payoutsEnabled: true, detailsSubmitted: true })
      .onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: { method: "stripe", stripeAccountId: acct, simulated: false, payoutsEnabled: true, detailsSubmitted: true } });

    const one = await inFlight(sh.id, b.id, 1000, 1);
    expect((await connectEvent("payout.paid", { id: "po_test_tip_1", object: "payout", status: "paid", metadata: { tipPayoutId: one.payoutId } }, acct)).status).toBe(200);
    const paid = (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, one.payoutId) }))!;
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).not.toBeNull();
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, one.batchId) }))!.status).toBe("completed");

    const two = await inFlight(sh.id, b.id, 600, 2);
    await connectEvent("payout.failed", { id: "po_test_tip_2", object: "payout", status: "failed", failure_message: "Card declined", metadata: {} }, acct);
    const failed = (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, two.payoutId) }))!;
    expect(failed).toMatchObject({ status: "failed", failureMessage: "Payout failed: Card declined" });
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, two.payoutId))).toEqual([]);
    const shopMail = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.subject, "Tip payout failed: $6.00")));
    expect(shopMail).toHaveLength(1);
    await connectEvent("payout.failed", { id: "po_test_tip_2", object: "payout", status: "failed", failure_message: "Card declined", metadata: {} }, acct);
    expect(await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.subject, "Tip payout failed: $6.00")))).toHaveLength(1);

    const three = await inFlight(sh.id, b.id, 400, 3);
    const threeEntries = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, three.payoutId));
    expect(threeEntries.reduce((a, e) => a + e.amountCents, 0)).toBe(1000);
    expect((await platformEvent("transfer.reversed", { id: "tr_test_tip_3", object: "transfer", metadata: {} })).status).toBe(200);
    expect((await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, three.payoutId) }))!.status).toBe("failed");

    const again = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect(await mine(again.batchId, b.id)).toMatchObject({ netCents: 1000 });
    await tp.cancelBatch(again.batchId, "Test over", actor);
    const audits = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "tips.payout_failed"));
    expect(audits.map((a) => a.entityId).sort()).toEqual([two.payoutId, three.payoutId].sort());
  });

  it("banking status flow: not set up, pending verification, action needed (told once per request), ready; a new destination is audited with a security notice", async () => {
    const { barbers: [b] } = await barbers("silvis", ["Abigail", "Liv"]);
    const email = "abigail.bank@rayz.test";
    const phone = "+13195550188";
    await m.db.db.update(s().staff).set({ email, phone }).where(eq(s().staff.id, b.id));
    await m.db.db
      .update(s().staffPayoutAccounts)
      .set({ payoutsEnabled: false, detailsSubmitted: false, requirementsDue: [], requirementsPending: [], destinationType: null, destinationLast4: null, destinationName: null })
      .where(eq(s().staffPayoutAccounts.staffId, b.id));
    const state = async () => accounts.staffAccountState(await accounts.staffAccount(b.id));
    const notices = () => m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_banking"), m.drizzle.inArray(s().notificationJobs.to, [email, phone]))).orderBy(s().notificationJobs.createdAt);
    const audits = (action: string) =>
      m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, action), eq(s().auditLog.entityId, b.id))).orderBy(s().auditLog.at);
    const accountUpdated = (o: { payouts: boolean; due?: string[]; pending?: string[]; deadline?: number; external?: object[] }) =>
      connectEvent(
        "account.updated",
        {
          id: acct,
          object: "account",
          payouts_enabled: o.payouts,
          details_submitted: true,
          requirements: { currently_due: o.due ?? [], past_due: [], pending_verification: o.pending ?? [], disabled_reason: null, current_deadline: o.deadline ?? null },
          ...(o.external ? { external_accounts: { object: "list", data: o.external } } : {}),
        },
        acct,
      );
    expect(await state()).toBe("not_set_up");
    const auditsBefore = (await audits("tips.account_state")).length;

    expect((await accountUpdated({ payouts: false, pending: ["individual.id_number"] })).status).toBe(200);
    expect(await state()).toBe("pending_verification");
    expect((await accounts.staffAccount(b.id))!.requirementsPending).toEqual(["individual.id_number"]);
    expect(await notices()).toEqual([]);

    const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
    await accountUpdated({ payouts: false, due: ["individual.verification.document"], deadline });
    expect(await state()).toBe("action_needed");
    expect((await accounts.staffAccount(b.id))!.requirementsDeadline?.getTime()).toBe(deadline * 1000);
    let sent = await notices();
    expect(sent).toEqual([expect.objectContaining({ channel: "email", to: email, subject: "Stripe needs more information for your tip payouts", body: expect.stringMatching(/A photo of your ID/) })]);
    expect(sent[0].body).toMatch(/\/admin\/my-banking/);
    await accountUpdated({ payouts: false, due: ["individual.verification.document"], deadline });
    expect(await notices()).toHaveLength(1);
    await accountUpdated({ payouts: false, due: ["individual.verification.document", "external_account"], deadline });
    sent = await notices();
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatch(/A bank account or debit card for payouts/);

    await accountUpdated({
      payouts: true,
      external: [{ id: "ba_test_tip", object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789", routing_number: "110000000", account_holder_name: "Abigail Test", fingerprint: "fp_secret", default_for_currency: true }],
    });
    expect(await state()).toBe("ready");
    const ready = (await accounts.staffAccount(b.id))!;
    expect(ready).toMatchObject({ destinationType: "bank_account", destinationLast4: "6789", destinationName: "STRIPE TEST BANK", requirementsDue: [] });
    expect(JSON.stringify(ready)).not.toMatch(/110000000|fp_secret|Abigail Test/);
    expect((await audits("tips.account_state")).slice(auditsBefore).map((a) => [(a.details as { from: string }).from, (a.details as { to: string }).to])).toEqual([
      ["not_set_up", "pending_verification"],
      ["pending_verification", "action_needed"],
      ["action_needed", "ready"],
    ]);
    sent = await notices();
    expect(sent.slice(2).map((n) => n.channel).sort()).toEqual(["email", "sms"]);
    expect(sent.find((n) => n.channel === "email" && n.subject?.startsWith("Security notice"))!.body).toMatch(/was set to STRIPE TEST BANK ••6789/);

    await connectEvent(
      "account.external_account.created",
      { id: "card_test_tip", object: "card", account: acct, brand: "Visa", last4: "5556", funding: "debit", default_for_currency: true, available_payout_methods: ["standard", "instant"], fingerprint: "fp_card" },
      acct,
    );
    const changed = (await accounts.staffAccount(b.id))!;
    expect(changed).toMatchObject({ destinationType: "card", destinationLast4: "5556", destinationName: "Visa", instantEligible: true });
    let moved = await audits("tips.destination_changed");
    expect(moved.at(-1)!.details).toEqual({ stripeAccountId: acct, from: { type: "bank_account", name: "STRIPE TEST BANK", last4: "6789" }, to: { type: "card", name: "Visa", last4: "5556" } });
    expect(moved.at(-1)!.actorLabel).toBe("stripe");
    sent = await notices();
    const security = sent.filter((n) => n.subject === "Security notice: your tip payout account changed" || n.body.startsWith("Ray'z security notice: your tip payout account"));
    expect(security).toHaveLength(4);
    expect(security.at(-1)!.body).toMatch(/changed to Visa card ••5556 \(it was STRIPE TEST BANK ••6789\)/);

    await connectEvent("account.external_account.updated", { id: "ba_test_tip", object: "bank_account", account: acct, bank_name: "STRIPE TEST BANK", last4: "6789", default_for_currency: false }, acct);
    expect((await accounts.staffAccount(b.id))!.destinationLast4).toBe("5556");
    await connectEvent("account.external_account.deleted", { id: "card_test_tip", object: "card", account: acct, brand: "Visa", last4: "5556", default_for_currency: true }, acct);
    expect(accounts.accountDestination(await accounts.staffAccount(b.id))).toBeNull();
    moved = await audits("tips.destination_changed");
    expect(moved.at(-1)!.details).toMatchObject({ from: { last4: "5556" }, to: null });
    expect((await notices()).at(-1)!.body).toMatch(/was removed \(it was Visa card ••5556\)/);

    const beforeMethod = (await notices()).length;
    await accounts.setPayoutChoice(b.id, { method: "cash", instant: false }, actor);
    const methodNotes = (await notices()).slice(beforeMethod);
    expect(methodNotes.map((n) => n.channel).sort()).toEqual(["email", "sms"]);
    expect(methodNotes.find((n) => n.channel === "email")).toMatchObject({ subject: "Security notice: how your tips are paid changed", body: expect.stringMatching(/paid by cash/i) });
    expect((await audits("tips.method")).at(-1)!.details).toMatchObject({ method: "cash", from: { method: "stripe" } });
    await accounts.setPayoutChoice(b.id, { method: "cash", instant: false }, actor);
    expect(await notices()).toHaveLength(beforeMethod + 2);

    const summary = (await accounts.payoutAccountSummaries([b.id])).get(b.id)!;
    expect(summary).toEqual({ staffId: b.id, method: "cash", status: "ready", state: accounts.staffAccountStatus(await accounts.staffAccount(b.id)), last4: null });
    const sh = await shop("silvis");
    const team = await accounts.shopPayoutAccounts(sh.id);
    expect(Object.keys(team.find((t) => t.staffId === b.id)!).sort()).toEqual(["last4", "method", "name", "staffId", "state", "status"]);
    const activity = await accounts.bankingActivity(b.id, 50);
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["tips.account_state", "tips.destination_changed", "tips.method"]));
    await accounts.setPayoutChoice(b.id, { method: "stripe", instant: false }, actor);
  });
});

describe("payroll export shows tips already paid", () => {
  it("tips paid outside payroll go to iSolved as received; tips paid through payroll get their own column and are locked as paid", async () => {
    const { shop: sh, barbers: [a, c] } = await barbers("rock-island", ["Garrett", "Mercedez"]);
    await accounts.setPayoutChoice(a.id, { method: "payroll", instant: false }, actor);
    await tipSale(sh.id, a.id, 800, card);
    await tipSale(sh.id, c.id, 600, cash);
    const r = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect(await mine(r.batchId, a.id)).toBeNull();
    await tp.approveBatch(r.batchId, actor);
    await tp.acknowledgeCashPayout({ payoutId: (await mine(r.batchId, c.id))!.id, by: "name", name: `${c.firstName} ${c.lastName}`, actor });

    const period = (await run.periodChoices()).find((p) => p.current)!;
    const v = (await run.buildPayroll(period.start, period.end))!;
    const block = v.blocks.find((b) => b.shopId === sh.id)!;
    const la = block.lines.find((l) => l.staffId === a.id)!;
    const lc = block.lines.find((l) => l.staffId === c.id)!;
    expect(la.tipsInPayroll).toBe(8);
    expect(la.tipsOutside).toBeCloseTo(la.tips - 8, 6);
    expect(lc.tipsInPayroll).toBe(0);
    expect(lc.tipsOutside).toBe(lc.tips);
    expect(lc.tipsPaidOut).toBe(lc.tips);
    expect(block.exportHeaders!.slice(6)).toEqual([v.settings.tipsInPayrollHeader, v.settings.tipsPaidOutHeader]);
    expect(block.exportFrom).toEqual(["tipsInPayroll", "tipsPaidOut"]);
    const row = (staffId: string) => block.exportRows.find((x) => x.staffId === staffId)!.values;
    expect([row(a.id)[2], row(a.id)[6], row(a.id)[7]]).toEqual([la.tipsOutside, 8, la.tipsPaidOut]);
    expect([row(c.id)[2], row(c.id)[6], row(c.id)[7]]).toEqual([lc.tips, 0, lc.tips]);
    expect(v.mismatches, JSON.stringify(v.mismatches)).toEqual([]);

    expect(await run.approveAndLock(period.start, period.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const [locked] = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.staffId, a.id), eq(s().tipPayouts.shopId, sh.id), eq(s().tipPayouts.method, "payroll")));
    expect(locked).toMatchObject({ status: "paid", shopId: sh.id, grossCents: 800, netCents: 800, payrollPeriodStart: period.start });
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, locked.batchId) }))!).toMatchObject({ kind: "payroll", status: "completed" });

    const after = (await run.buildPayroll(period.start, period.end))!.blocks.find((b) => b.shopId === sh.id)!;
    expect(after.totals).toEqual(block.totals);
    const next = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect(await mine(next.batchId, a.id)).toBeNull();

    const f = (await run.lockedExport(block.payGroupId, period.start, period.end))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Rock Island")!;
    expect(ws.getCell(1, 9).value).toBe(v.settings.tipsInPayrollHeader);
    expect(ws.getCell(1, 10).value).toBe("M_Tips Paid Out_Dollars");
    expect(ws.getCell(1, 5).value).toBe("E_Cash Tips Recd_Dollars");
    const values: unknown[] = [];
    const paid: unknown[] = [];
    ws.eachRow((rw, n) => {
      if (n > 1) values.push(rw.getCell(9).value);
      if (n > 1) paid.push(rw.getCell(10).value);
    });
    expect(values).toContain(8);
    expect(paid).toContain(lc.tips);
  });

  it("marking paid tips is required while Stripe pays tips direct, can be turned off where payroll pays them, and its column can't take another column's name", async () => {
    const before = await m.db.db.query.brandSettings.findFirst();
    const def = (await import("@/server/brand-sync/settings")).settingDef("payroll")!;
    type P = import("@/domain/payroll/calc").PayrollSettings;
    const base = def.read(before?.payroll) as P;
    await expect(Promise.resolve().then(() => def.parse({ tipsPaidOutHeader: "E_Cash Tips Recd_Dollars" }, base, actor as never, m.db.db as never))).rejects.toThrow(/its own name/);
    await expect(Promise.resolve().then(() => def.parse({ markPaidTips: false }, base, actor as never, m.db.db as never))).rejects.toThrow(/can't be turned off while Stripe payouts are on/);
    process.env.FEATURE_STAFF_STRIPE_PAYOUTS = "false";
    onTestFinished(() => void delete process.env.FEATURE_STAFF_STRIPE_PAYOUTS);
    const off = (await def.parse({ markPaidTips: false }, base, actor as never, m.db.db as never)) as P;
    expect(off).toMatchObject({ markPaidTips: false });
    const calc = await import("@/domain/payroll/calc");
    const period = (await run.periodChoices()).find((p) => p.current)!;
    const lines = (await run.buildPayroll(period.start, period.end))!.blocks.flatMap((b) => b.lines);
    expect(lines.some((l) => l.tipsPaidOut > 0)).toBe(true);
    expect(calc.exportExtraColumns(lines, base).map((c) => c.from)).toContain("tipsPaidOut");
    expect(calc.exportExtraColumns(lines, off).map((c) => c.from)).not.toContain("tipsPaidOut");
    expect(calc.exportHeaders(lines, off)).not.toContain(base.tipsPaidOutHeader);
  });
});
