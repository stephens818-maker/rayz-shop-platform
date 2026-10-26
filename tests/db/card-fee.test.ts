/**
 * The credit card surcharge policy end to end: brand and shop settings (audited, mirrored to the
 * shop columns), waivers at checkout, what each payment records, the refund rule, and the reports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOTAL } from "@/domain/report-views";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let fee: typeof import("@/server/payments/card-fee");
let policy: typeof import("@/domain/card-fee-policy");
let report: typeof import("@/server/card-fee-report");
let qbo: typeof import("@/server/quickbooks-export");
let comp: typeof import("@/server/compensation");
let shopId: string;
let barberId: string;

beforeAll(async () => {
  m = await loadModules();
  fee = await import("@/server/payments/card-fee");
  policy = await import("@/domain/card-fee-policy");
  report = await import("@/server/card-fee-report");
  qbo = await import("@/server/quickbooks-export");
  comp = await import("@/server/compensation");
  const shop = await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") });
  shopId = shop!.id;
  const [b] = await m.db.db.select({ id: m.schema.staffShops.staffId }).from(m.schema.staffShops).where(m.drizzle.eq(m.schema.staffShops.shopId, shopId)).limit(1);
  barberId = b.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const brand = (over: Partial<import("@/domain/card-fee-policy").CardFeePolicy> = {}) => ({ ...policy.DEFAULT_CARD_FEE_POLICY, ...over });

beforeEach(async () => {
  await fee.saveBrandFeePolicy(actor, brand());
  await fee.saveShopFeeOverride(actor, shopId, null);
});

const credit = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };

/** A one-product ticket at Coralville with a barber, paid by credit card unless told otherwise. */
async function sell(o: { tender?: typeof credit | { method: "cash"; cashTenderedCents: number | null }; tipCents?: number; waive?: string | null; canWaive?: boolean } = {}) {
  const sale = await m.checkout.openBlankSale(shopId, actor, barberId);
  const ctx = await m.checkout.loadCheckoutContext(sale.id);
  const product = ctx.retail.find((p) => p.stock > 0 && p.priceCents >= 1000)!;
  const r = await m.checkout.finalizeSale({
    saleId: sale.id,
    lines: [{ kind: "product", refId: product.productId, name: product.name, qty: 1 }],
    tipCents: o.tipCents ?? 0,
    tender: o.tender ?? credit,
    waiveCardFee: o.waive != null ? { reason: o.waive, byStaffId: barberId } : null,
    canWaiveCardFee: o.canWaive ?? true,
    actor,
  });
  const [pay] = await m.db.db.select().from(m.schema.payments).where(m.drizzle.eq(m.schema.payments.saleId, sale.id));
  const s = await m.db.db.query.sales.findFirst({ where: m.drizzle.eq(m.schema.sales.id, sale.id) });
  return { saleId: sale.id, r, pay, sale: s!, product };
}

const audits = (action: string) => m.db.db.select().from(m.schema.auditLog).where(m.drizzle.eq(m.schema.auditLog.action, action)).orderBy(m.drizzle.desc(m.schema.auditLog.at));

describe("settings", () => {
  it("saves the brand policy with an audit of what changed, and mirrors it to the shop columns", async () => {
    await fee.saveBrandFeePolicy(actor, brand({ rate: 0.025, capCents: 500 }));
    const [a] = await audits("card_fee.brand");
    expect((a.details as { changes: Record<string, unknown> }).changes).toEqual({ rate: { from: 0.03, to: 0.025 }, capCents: { from: null, to: 500 } });
    const shop = await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.id, shopId) });
    expect(Number(shop!.cardFeeRate)).toBe(0.025);
    expect((await fee.shopFeePolicy(shopId)).policy).toMatchObject({ rate: 0.025, capCents: 500 });
  });

  it("refuses debit, prepaid, more than 3%, and a notice without the word surcharge", async () => {
    await expect(fee.saveBrandFeePolicy(actor, brand({ funding: { debit: true, prepaid: false, applePay: false, googlePay: false } }))).rejects.toThrow(/only allowed on credit/);
    await expect(fee.saveBrandFeePolicy(actor, brand({ rate: 0.04 }))).rejects.toThrow(/3%/);
    await expect(fee.saveBrandFeePolicy(actor, brand({ notice: "Card fee applies" }))).rejects.toThrow(/surcharge/);
    await expect(fee.saveShopFeeOverride(actor, shopId, { rate: 0.05 })).rejects.toThrow(/3%/);
  });

  it("keeps a shop override to what differs, audits it, and the shop follows the brand again on null", async () => {
    const r = await fee.saveShopFeeOverride(actor, shopId, { rate: 0.02, enabled: true, channels: { app: false } });
    expect(r.override).toEqual({ rate: 0.02, channels: { app: false } });
    const [a] = await audits("card_fee.shop");
    expect(a).toMatchObject({ entityId: shopId, shopId });
    expect(Number((await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.id, shopId) }))!.cardFeeRate)).toBe(0.02);
    expect((await fee.cardFeeConfigFor(shopId, "app")).off).toBe("channel_off");
    await fee.saveShopFeeOverride(actor, shopId, null);
    expect((await fee.shopFeePolicy(shopId)).override).toBeNull();
  });
});

describe("checkout", () => {
  it("records how each card payment's surcharge was worked out", async () => {
    const { pay, r } = await sell({ tipCents: 300 });
    expect(r.totals.cardFeeCents).toBeGreaterThan(0);
    expect(pay).toMatchObject({ cardFeeCents: r.totals.cardFeeCents, feeBasis: "charge_excluding_tip", feeReason: "applies", feeChannel: "pos", feeWaived: false, feeWaivedCents: 0, feeFlatCents: 0 });
    expect(Number(pay.feeRate)).toBe(0.03);
    expect(pay.feeBasisCents).toBe(pay.amountCents - pay.cardFeeCents - 300);
  });

  it("never surcharges cash", async () => {
    const { r, pay } = await sell({ tender: { method: "cash", cashTenderedCents: null } });
    expect(r.totals.cardFeeCents).toBe(0);
    expect(pay.cardFeeCents).toBe(0);
  });

  it("waives it with a reason, audited, when the person may and the brand allows", async () => {
    await expect(sell({ waive: "Regular", canWaive: false })).rejects.toThrow(/permission/);
    await expect(sell({ waive: " " })).rejects.toMatchObject({ code: "bad_request" });
    const { pay, sale, saleId } = await sell({ waive: "Card reader was down, keyed in" });
    expect(pay).toMatchObject({ cardFeeCents: 0, feeWaived: true, feeWaivedBy: barberId, feeWaivedReason: "Card reader was down, keyed in", feeReason: "waived" });
    expect(pay.feeWaivedCents).toBeGreaterThan(0);
    expect(sale.cardFeeWaivedCents).toBe(pay.feeWaivedCents);
    const [a] = await audits("sale.card_fee_waived");
    expect(a).toMatchObject({ entityId: saleId });
    await fee.saveBrandFeePolicy(actor, brand({ waiverAllowed: false }));
    await expect(sell({ waive: "Regular" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is off on a channel the brand turned off, and in a state that isn't allowed", async () => {
    await fee.saveBrandFeePolicy(actor, brand({ channels: { pos: false, app: true, deposit: true, card_on_file: true } }));
    expect((await sell()).pay).toMatchObject({ cardFeeCents: 0, feeReason: "channel_off" });
    await fee.saveBrandFeePolicy(actor, brand({ states: ["IL"] }));
    expect((await sell()).pay).toMatchObject({ cardFeeCents: 0, feeReason: "state_not_allowed" });
  });

  it("treats a booking deposit's ticket as the deposit channel", async () => {
    const sale = await m.checkout.openBlankSale(shopId, actor);
    expect(await fee.saleFeeChannel(sale.id, "pos")).toBe("pos");
    const [guardian] = await m.db.db.select({ id: m.schema.customers.id }).from(m.schema.customers).limit(1);
    await m.db.db.insert(m.schema.bookingGroups).values({ code: `CF${Date.now()}`, shopId, guardianId: guardian.id, plan: "together", source: "online", depositSaleId: sale.id });
    expect(await fee.saleFeeChannel(sale.id, "pos")).toBe("deposit");
    await fee.saveBrandFeePolicy(actor, brand({ channels: { pos: true, app: true, deposit: false, card_on_file: true } }));
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    expect(ctx.config.cardFee.off).toBe("channel_off");
  });

  it("applies a flat fee and the cap", async () => {
    await fee.saveBrandFeePolicy(actor, brand({ type: "both", rate: 0.02, flatCents: 25, capCents: 30 }));
    const { pay, r } = await sell();
    expect(pay.cardFeeCents).toBe(Math.min(30, Math.round(pay.feeBasisCents! * 0.03), Math.round(pay.feeBasisCents! * 0.02) + 25));
    expect(pay.feeFlatCents).toBe(25);
    expect(r.totals.disclosures.join(" ")).toContain("2% + $0.25");
  });

  it("goes to the shop with the rest of the charge: the platform's application fee is processing only", async () => {
    const { pay } = await sell();
    if (pay.applicationFeeCents > 0) {
      const { processingFeeCents } = await import("@/domain/connect");
      const { feeSchedule } = await import("@/server/payments/connect");
      expect(pay.applicationFeeCents).toBe(processingFeeCents(pay.amountCents, feeSchedule().keyed));
    }
  });

  it("is left out of commission and tips", async () => {
    const { pay, sale, product } = await sell({ tipCents: 400 });
    expect(pay.cardFeeCents).toBeGreaterThan(0);
    expect(sale.productNetCents + sale.serviceNetCents).toBe(sale.totalCents - sale.cardFeeCents - sale.tipCents - sale.serviceTaxCents - sale.productTaxCents);
    const lines = (await comp.commissionLines([barberId], sale.businessDate, sale.businessDate)).get(barberId) ?? [];
    expect(lines.some((l) => l.netCents === sale.productNetCents && l.refId === product.productId)).toBe(true);
    const tips = await m.db.db.select().from(m.schema.tipLedger).where(m.drizzle.eq(m.schema.tipLedger.saleId, sale.id));
    expect(tips.reduce((a, t) => a + t.amountCents, 0)).toBe(400);
  });
});

describe("refunds", () => {
  it("proportional: the surcharge's share goes back with what's refunded", async () => {
    const { saleId, pay } = await sell();
    const st = await m.checkout.refundableState(saleId);
    expect(st.feeRefundRule).toBe("proportional");
    const item = st.items[0];
    const out = await m.checkout.refundSale({ saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: "proportional", reason: "Returned", restock: true, actor });
    expect(out.components.cardFeeCents).toBe(pay.cardFeeCents);
  });

  it("keep: no surcharge back on a refund, but a void still reverses it", async () => {
    await fee.saveBrandFeePolicy(actor, brand({ refundRule: "keep" }));
    const a = await sell();
    const st = await m.checkout.refundableState(a.saleId);
    expect(st.feeRefundRule).toBe("keep");
    const out = await m.checkout.refundSale({ saleId: a.saleId, items: [{ saleItemId: st.items[0].id, qty: 1 }], tipCents: 0, refundCardFee: true, reason: "Returned", restock: true, actor });
    expect(out.components.cardFeeCents).toBe(0);
    expect(out.refundedCents).toBe(a.pay.amountCents - a.pay.cardFeeCents);

    const b = await sell();
    await m.checkout.voidSale(b.saleId, "Rang up wrong", actor);
    const refs = await m.db.db.select().from(m.schema.refunds).where(m.drizzle.eq(m.schema.refunds.saleId, b.saleId));
    expect(refs.reduce((x, r) => x + r.cardFeeCents, 0)).toBe(b.pay.cardFeeCents);
  });
});

describe("reports", () => {
  it("the card fee report counts surcharges collected and waived", async () => {
    const day = m.time.todayLocal();
    const scope = { shopIds: [shopId], from: day, to: day };
    const total = async () => report.feeTotalsAt(await report.cardFeeRows(scope), { view: "combined", shops: [] } as never)[TOTAL];
    const before = await total();
    const a = await sell();
    const w = await sell({ waive: "Owner's friend" });
    const after = await total();
    expect(after.feeCents - before.feeCents).toBe(a.pay.cardFeeCents);
    expect(after.waivedCents - before.waivedCents).toBe(w.pay.feeWaivedCents);
    expect(after.waivers - before.waivers).toBe(1);
    expect(report.effectiveRate(after)).toBeGreaterThan(0);
    expect(report.effectiveRate(after)).toBeLessThanOrEqual(0.03);
  });

  it("the QuickBooks journal balances, with surcharges in their own account", async () => {
    await sell();
    const day = m.time.todayLocal();
    const days = await qbo.quickbooksDays({ shopIds: [shopId], from: day, to: day });
    expect(days.length).toBe(1);
    const lines = qbo.journalLines(days[0]);
    expect(lines.reduce((a, l) => a + l[1], 0)).toBe(lines.reduce((a, l) => a + l[2], 0));
    const surcharge = lines.find((l) => l[0] === qbo.QBO_ACCOUNTS.surcharge)!;
    expect(surcharge[2]).toBe(days[0].fee - days[0].r_fee);
    expect(lines.find((l) => l[0] === qbo.QBO_ACCOUNTS.products)![2]).toBe(days[0].pn - days[0].r_pn);
  });
});
