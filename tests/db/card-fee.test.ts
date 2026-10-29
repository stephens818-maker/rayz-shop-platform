/**
 * The credit card surcharge policy end to end: brand and shop settings (audited, mirrored to the
 * shop columns), which shops the brand applies it to and the bulk actions on them, who may change a
 * shop's own, waivers at checkout, what each payment records, the refund rule, and the reports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TOTAL } from "@/domain/report-views";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let fee: typeof import("@/server/payments/card-fee");
let policy: typeof import("@/domain/card-fee-policy");
let report: typeof import("@/server/card-fee-report");
let qbo: typeof import("@/server/quickbooks-export");
let comp: typeof import("@/server/compensation");
let shopId: string;
let barberId: string;
let otherId: string;
let saved: { id: string; o: Record<string, unknown> | null }[] = [];

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
  otherId = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "moline") }))!.id;
  saved = await m.db.db.select({ id: m.schema.shops.id, o: m.schema.shops.cardFeeOverride }).from(m.schema.shops);
}, 120_000);

afterAll(async () => {
  if (m) {
    await fee.saveBrandFeePolicy(actor, brand());
    for (const r of saved) await m.db.db.update(m.schema.shops).set({ cardFeeOverride: r.o }).where(m.drizzle.eq(m.schema.shops.id, r.id));
  }
  await m?.db.closeDb();
});

/** The seeded brand, turned on at a chosen test rate. The default rate is 0, so turning it on needs one. */
const brand = (over: Partial<import("@/domain/card-fee-policy").CardFeePolicy> = {}) => ({ ...policy.DEFAULT_CARD_FEE_POLICY, enabled: true, rate: 0.03, ...over });

beforeEach(async () => {
  await fee.saveBrandFeePolicy(actor, brand());
  await fee.saveShopFeeOverride(actor, shopId, null);
  await fee.saveShopFeeOverride(actor, otherId, null);
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

  it("refuses debit and prepaid, a rate above 100%, and turning the fee on with no rate", async () => {
    await expect(fee.saveBrandFeePolicy(actor, brand({ funding: { debit: true, prepaid: false, applePay: false, googlePay: false } }))).rejects.toThrow(/only allowed on credit/);
    await fee.saveBrandFeePolicy(actor, brand({ rate: 0.04, notice: "Card fee applies" }));
    expect((await fee.shopFeePolicy(shopId)).policy.rate).toBe(0.04);
    await expect(fee.saveBrandFeePolicy(actor, brand({ rate: 1.5 }))).rejects.toThrow(/0 to 100/);
    await expect(fee.saveBrandFeePolicy(actor, brand({ enabled: true, rate: 0 }))).rejects.toThrow(/before turning it on/);
    await fee.saveShopFeeOverride(actor, shopId, { rate: 0.05 });
    expect((await fee.shopFeePolicy(shopId)).policy.rate).toBe(0.05);
  });

  it("keeps the credit card fee and sales tax that were in effect, and a later change does not rewrite them", async () => {
    const rates = await import("@/server/fee-tax-rates");
    const jan = new Date("2027-01-15T00:00:00Z");
    const jun = new Date("2027-06-15T00:00:00Z");
    await rates.recordCardFeeRate(m.db.db, { shopId, rate: 0.02, label: "Credit card fee", at: jan });
    await rates.recordCardFeeRate(m.db.db, { shopId, rate: 0.04, label: "Processing fee", at: jun });
    expect(await rates.getCardFeeRate(shopId, new Date("2027-03-01T00:00:00Z"))).toBe(0.02);
    expect(await rates.getCardFeeRate(shopId, new Date("2027-07-01T00:00:00Z"))).toBe(0.04);
    await rates.recordSalesTaxRate(m.db.db, { shopId, serviceRate: 0.01, productRate: 0.02, at: jan });
    await rates.recordSalesTaxRate(m.db.db, { shopId, serviceRate: 0.06, productRate: 0.07, at: jun });
    expect(await rates.getSalesTaxRate(shopId, new Date("2027-03-01T00:00:00Z"))).toMatchObject({ serviceRate: 0.01, productRate: 0.02, taxRateBps: 100, productTaxRateBps: 200 });
    expect(await rates.getSalesTaxRate(shopId, new Date("2027-07-01T00:00:00Z"))).toMatchObject({ serviceRate: 0.06, productRate: 0.07, taxRateBps: 600, productTaxRateBps: 700 });
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

  it("is off at a brand that never turned it on (core_0152), and the migration keeps a saved choice and a shop's own", async () => {
    const { readFileSync } = await import("node:fs");
    const S = m.schema;
    const migrate = async () => {
      for (const q of readFileSync("drizzle/core_0152_surcharge_off_by_default.sql", "utf8").split("--> statement-breakpoint")) await m.db.db.execute(m.drizzle.sql.raw(q));
    };
    const enabled = async (id: string) => (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(S.shops.id, id) }))!.cardFeeEnabled;
    await m.db.db.update(S.brandSettings).set({ cardFee: {} });
    await m.db.db.update(S.shops).set({ cardFeeEnabled: true });
    await m.db.db.update(S.shops).set({ cardFeeOverride: { enabled: true } }).where(m.drizzle.eq(S.shops.id, otherId));
    // An empty saved policy uses the 3% default. core_0152 still records an explicit off when it sees an empty policy.
    expect(await fee.cardFeeConfigFor(shopId, "pos")).toMatchObject({ enabled: true, rate: 0.03 });
    expect(await fee.computeCardFee(shopId, "credit", { chargeCents: 5000 })).toMatchObject({ feeCents: 150 });

    await migrate();
    expect((await m.db.db.query.brandSettings.findFirst())!.cardFee).toEqual({ enabled: false });
    expect(await enabled(shopId)).toBe(false);
    expect(await enabled(otherId)).toBe(true);

    await m.db.db.update(S.brandSettings).set({ cardFee: { enabled: true } });
    await m.db.db.update(S.shops).set({ cardFeeEnabled: true }).where(m.drizzle.eq(S.shops.id, shopId));
    await migrate();
    expect((await m.db.db.query.brandSettings.findFirst())!.cardFee).toEqual({ enabled: true });
    expect(await enabled(shopId)).toBe(true);
  });
});

describe("which shops use it", () => {
  const shopRow = async (id: string) => (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.id, id) }))!;
  const status = async (id: string) => (await fee.shopFeeRows()).find((r) => r.shopId === id)!;

  it("charges nothing at a shop the brand doesn't apply it to, and audits which shops a change reached", async () => {
    await fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: [otherId] });
    expect((await fee.cardFeeConfigFor(shopId, "pos")).enabled).toBe(false);
    expect((await fee.cardFeeConfigFor(otherId, "pos")).enabled).toBe(true);
    expect((await shopRow(shopId)).cardFeeEnabled).toBe(false);
    expect(await status(shopId)).toMatchObject({ on: false, off: "not_applied", inherits: true });
    const [a] = await audits("card_fee.brand");
    const d = a.details as { changes: Record<string, unknown>; shopIds: string[]; shops: { shopId: string; from: { on: boolean }; to: { on: boolean } }[] };
    expect(d.changes.appliesTo).toEqual({ from: "all", to: "selected" });
    expect(d.shopIds).toContain(shopId);
    expect(d.shopIds).not.toContain(otherId);
    expect(d.shops.find((x) => x.shopId === shopId)).toMatchObject({ from: { on: true }, to: { on: false } });
    const [own] = await audits("card_fee.shop");
    expect(own).toMatchObject({ shopId: expect.any(String), details: expect.objectContaining({ via: "brand" }) });
    const { sale } = await sell();
    expect(sale.cardFeeCents).toBe(0);
    await fee.saveBrandFeePolicy(actor, { appliesTo: "none" });
    expect((await fee.cardFeeConfigFor(otherId, "pos")).enabled).toBe(false);
    await expect(fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/no longer exists/);
  });

  it("a shop's own setting can't turn it on where the brand doesn't apply it", async () => {
    await fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: [otherId] });
    await fee.saveShopFeeOverride(actor, shopId, { enabled: true, rate: 0.02 });
    expect((await fee.cardFeeConfigFor(shopId, "pos")).enabled).toBe(false);
    expect((await fee.shopFeePolicy(shopId)).configured).toMatchObject({ enabled: true, rate: 0.02 });
  });

  it("enable and disable: under all shops, disabling one lists every other shop; audited once and on each shop", async () => {
    const before = (await shopRow(shopId)).cardFeeChangedAt;
    const off = await fee.bulkShopFee(actor, "disable", [shopId]);
    expect(off.map((c) => c.shopId)).toEqual([shopId]);
    const b = await fee.brandFeePolicy();
    expect(b.appliesTo).toBe("selected");
    expect(b.shopIds).toContain(otherId);
    expect(b.shopIds).not.toContain(shopId);
    expect(await status(shopId)).toMatchObject({ on: false, off: "not_applied" });
    expect((await shopRow(shopId)).cardFeeChangedAt!.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    const [a] = await audits("card_fee.shops");
    expect(a.details).toMatchObject({ action: "disable", shopIds: [shopId], appliesTo: { from: { appliesTo: "all" }, to: { appliesTo: "selected" } }, shops: [{ shopId, from: { on: true }, to: { on: false, off: "not_applied" } }] });
    expect(a.actorLabel).toBe(actor.label);

    await fee.saveShopFeeOverride(actor, shopId, { enabled: false });
    const on = await fee.bulkShopFee(actor, "enable", [shopId, otherId]);
    expect(on.map((c) => c.shopId)).toEqual([shopId]);
    expect(await status(shopId)).toMatchObject({ on: true, inherits: true });
    expect((await fee.brandFeePolicy()).shopIds).toContain(shopId);
  });

  it("apply brand rate keeps the shop's other settings; reset drops them all; push resets and applies", async () => {
    await fee.saveShopFeeOverride(actor, shopId, { rate: 0.02, channels: { app: false } });
    await fee.saveShopFeeOverride(actor, otherId, { type: "both", rate: 0.01, flatCents: 25 });
    await fee.bulkShopFee(actor, "brand_rate", [shopId, otherId]);
    expect((await fee.shopFeePolicy(shopId)).override).toEqual({ channels: { app: false } });
    expect((await fee.shopFeePolicy(otherId)).override).toBeNull();
    expect((await status(shopId)).fee).toBe("3%");

    await fee.bulkShopFee(actor, "reset", [shopId]);
    expect((await fee.shopFeePolicy(shopId)).override).toBeNull();

    await fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: [otherId] });
    await fee.saveShopFeeOverride(actor, shopId, { rate: 0.01 });
    const pushed = await fee.bulkShopFee(actor, "push", [shopId]);
    expect(pushed[0]).toMatchObject({ shopId, from: { on: false, override: { rate: 0.01 } }, to: { on: true, inherits: true, fee: "3%", override: null } });
    expect((await fee.brandFeePolicy()).shopIds.sort()).toEqual([shopId, otherId].sort());
    expect(await fee.bulkShopFee(actor, "push", [shopId])).toEqual([]);
  });

  it("the report filters to shops by their surcharge", async () => {
    await fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: [otherId] });
    await fee.saveShopFeeOverride(actor, otherId, { rate: 0.025 });
    expect(await fee.shopsMatchingFee([shopId, otherId], "on")).toEqual([otherId]);
    expect(await fee.shopsMatchingFee([shopId, otherId], "off")).toEqual([shopId]);
    expect(await fee.shopsMatchingFee([shopId, otherId], "own")).toEqual([otherId]);
    expect(await fee.shopsMatchingFee([shopId, otherId], "brand")).toEqual([shopId]);
    const { REPORT_LOADERS } = await import("@/server/report-data");
    const day = m.time.todayLocal();
    const data = await REPORT_LOADERS.card_fees({
      scope: { shopIds: [shopId, otherId], from: day, to: day },
      loc: { view: "shops", shops: [{ id: shopId, name: "Coralville" }, { id: otherId, name: "Moline" }] } as never,
      viewer: { brandWide: true, currentShopId: null, shopIds: [shopId, otherId] },
      params: { fee: "off" },
    });
    expect(data.options?.[0]).toMatchObject({ param: "fee", value: "off" });
    expect(data.notes?.[0]).toMatch(/Surcharge off now: Coralville/);
  });

  it("shop managers only see their shop's surcharge unless the brand lets them change it", async () => {
    const { signInAs } = await import("./session");
    const actions = await import("@/app/admin/settings/actions");
    const michelle = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, "michelle@rayz.test") }))!;
    await signInAs(michelle.id, shopId);
    expect(await actions.saveShopCardFeeAction(shopId, { rate: 0.02 })).toMatchObject({ ok: false, error: expect.stringMatching(/view only/) });
    await fee.saveBrandFeePolicy(actor, { shopsCanEdit: true });
    expect(await actions.saveShopCardFeeAction(shopId, { rate: 0.02 })).toEqual({ ok: true, data: null });
    expect((await fee.shopFeePolicy(shopId)).override).toEqual({ rate: 0.02 });
    expect(await actions.saveShopCardFeeAction(otherId, { rate: 0.02 })).toMatchObject({ ok: false });
    expect(await brandAction("card_fee", "brand", { rate: 0.02 })).toMatchObject({ ok: false });
    const page = await import("@/app/admin/card-fee/actions");
    expect(await page.bulkShopFeeAction("reset", [shopId])).toMatchObject({ ok: false });
    expect(fee.canEditShopFee(new Set(["settings.shop_checkout"]), { shopsCanEdit: true })).toBe(true);
    expect(fee.canEditShopFee(new Set(["settings.shop_checkout"]), { shopsCanEdit: false })).toBe(false);
    expect(fee.canEditShopFee(new Set(["settings.card_fee"]), { shopsCanEdit: false })).toBe(true);
    await signInAs(null);
  });

  it("a location added in the wizard takes the brand's surcharge, with no setting of its own", async () => {
    const { createLocation } = await import("@/server/location-admin");
    const { draftDefaults } = await import("@/domain/location-draft");
    const owner = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, "owner@rayz.test") }))!;
    const { signInAs } = await import("./session");
    await signInAs(owner.id);
    const auth = await import("@/server/auth/staff");
    const ctx = (await auth.getStaffContext())!;
    await fee.saveBrandFeePolicy(actor, { rate: 0.025, appliesToTip: true });
    const admin = { actor, brandWide: true, shopIds: ctx.shopIds, grantor: auth.staffGrantor(ctx) };
    const slug = `fee-new-${Date.now() % 100000}`;
    const made = await createLocation(admin, draftDefaults({ name: `Fee New ${slug}`, slug, address: "1 Main St", city: "Davenport", state: "IA", zip: "52801", cardFeeEnabled: false, cardFeeRate: 0.01 }));
    const row = await shopRow(made.id);
    expect(row).toMatchObject({ cardFeeOverride: null, cardFeeEnabled: true, cardFeeAppliesToTip: true });
    expect(Number(row.cardFeeRate)).toBe(0.025);
    expect(row.cardFeeChangedAt).toBeInstanceOf(Date);
    expect((await fee.cardFeeConfigFor(made.id, "pos")).rate).toBe(0.025);
    const [a] = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(m.drizzle.eq(m.schema.auditLog.action, "card_fee.shop"), m.drizzle.eq(m.schema.auditLog.shopId, made.id)));
    expect(a.details).toMatchObject({ via: "new_location", to: { on: true, inherits: true, fee: "2.5%" } });

    await fee.saveBrandFeePolicy(actor, { appliesTo: "selected", shopIds: [shopId] });
    const slug2 = `${slug}-b`;
    const made2 = await createLocation(admin, draftDefaults({ name: `Fee New ${slug2}`, slug: slug2, address: "2 Main St", city: "Davenport", state: "IA", zip: "52801" }));
    expect((await fee.cardFeeConfigFor(made2.id, "pos")).enabled).toBe(true);
    expect(Number((await shopRow(made2.id)).cardFeeRate)).toBe(0.025);
    expect((await shopRow(made2.id)).cardFeeEnabled).toBe(true);
    await signInAs(null);
  });
});

describe("checkout", () => {
  it("records how each card payment's surcharge was worked out", async () => {
    const { pay, r, sale } = await sell({ tipCents: 300 });
    expect(r.totals.cardFeeCents).toBeGreaterThan(0);
    expect(pay).toMatchObject({ cardFeeCents: r.totals.cardFeeCents, feeBasis: "charge_excluding_tip", feeReason: "applies", feeChannel: "pos", feeWaived: false, feeWaivedCents: 0, feeFlatCents: 0 });
    expect(Number(pay.feeRate)).toBe(0.03);
    // The fee is on the merchandise, before sales tax and before the tip.
    expect(pay.feeBasisCents).toBe(pay.amountCents - pay.cardFeeCents - 300 - Number(sale.serviceTaxCents) - Number(sale.productTaxCents));
  });

  it("works the rate and basis of an old payment back from what was charged (core_0092)", async () => {
    const { readFileSync } = await import("node:fs");
    const { pay } = await sell({ tipCents: 300 });
    const P = m.schema.payments;
    // core_0092 rebuilds an old charge, whose fee was on the whole card amount except the tip.
    const basis = 10_000;
    const tip = 300;
    const feeCents = 300;
    await m.db.db.update(P).set({ amountCents: basis + tip + feeCents, tipCents: tip, cardFeeCents: feeCents, feeBasis: "charge_excluding_tip", feeRate: "0", feeBasisCents: null }).where(m.drizzle.eq(P.id, pay.id));
    for (const q of readFileSync("drizzle/core_0092_card_fee_backfill.sql", "utf8").split("--> statement-breakpoint")) await m.db.db.execute(m.drizzle.sql.raw(q));
    const [after] = await m.db.db.select().from(P).where(m.drizzle.eq(P.id, pay.id));
    expect(after.feeBasisCents).toBe(basis);
    expect(Number(after.feeRate)).toBeCloseTo(0.03, 3);
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
