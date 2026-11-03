/**
 * core_0157: a tip reversal with no Stripe tip transfer (the simulator's Jessica $7.60) is absorbed by the
 * shop and kept by the barber. A void stays reversed. Shops stored on cash tips move to Stripe,
 * except a shop that pays tips through payroll. Iowa's 7% receipt splits into 6% state and 1% city.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let tl: typeof import("@/server/tips/ledger");

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;

async function replay() {
  const file = readFileSync("drizzle/core_0157_no_transfer_tips.sql", "utf8");
  for (const q of file.split("--> statement-breakpoint")) {
    const sql = q.trim();
    if (sql) await m.db.db.execute(m.drizzle.sql.raw(sql));
  }
}

describe("core_0157 no-transfer tips, Stripe default, Iowa tax split", () => {
  it("restores a simulator tip, leaves a void, and sets Stripe plus the city split", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const moline = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "moline") }))!;
    const dubuque = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "dubuque") }))!;
    const clinton = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "clinton") }))!;
    const [jessica] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, "Jessica"));
    const day = m.time.todayLocal();

    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "end_of_night", defaultMethod: "cash" } }).where(eq(s().shops.id, shop.id));
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "daily_delay", cardDelayDays: 2, defaultMethod: "cash" } }).where(eq(s().shops.id, moline.id));
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "payroll", defaultMethod: "cash" } }).where(eq(s().shops.id, clinton.id));
    await m.db.db.update(s().shops).set({ receipt: { taxDisplay: { stateRate: 0.05, cityRate: 0.02 } } }).where(eq(s().shops.id, shop.id));
    await m.db.db.update(s().shops).set({ receipt: {} }).where(eq(s().shops.id, dubuque.id));

    const [sale] = await m.db.db
      .insert(s().sales)
      .values({ shopId: shop.id, staffId: jessica.id, status: "partially_refunded", businessDate: day, serviceNetCents: 4000, tipCents: 760, totalCents: 4760 })
      .returning();
    const [pay] = await m.db.db
      .insert(s().payments)
      .values({ saleId: sale.id, shopId: shop.id, businessDate: day, method: "card", status: "partially_refunded", amountCents: 4760, tipCents: 760, chargeType: "separate", settlement: "platform" })
      .returning();
    const [refund] = await m.db.db
      .insert(s().refunds)
      .values({ saleId: sale.id, paymentId: pay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 760, tipCents: 760, reason: "Simulator partial refund", kind: "refund" })
      .returning();
    await m.db.db.insert(s().tipLedger).values([
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, kind: "tip", method: "card", amountCents: 760, feeCents: 0, businessDate: day },
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, refundId: refund.id, kind: "refund", method: "card", amountCents: -760, feeCents: 0, businessDate: day },
    ]);

    const [voidSale] = await m.db.db
      .insert(s().sales)
      .values({ shopId: shop.id, staffId: jessica.id, status: "voided", businessDate: day, tipCents: 400, totalCents: 400 })
      .returning();
    const [voidPay] = await m.db.db
      .insert(s().payments)
      .values({ saleId: voidSale.id, shopId: shop.id, businessDate: day, method: "card", status: "voided", amountCents: 400, tipCents: 400, chargeType: "separate", settlement: "platform" })
      .returning();
    const [voidRefund] = await m.db.db
      .insert(s().refunds)
      .values({ saleId: voidSale.id, paymentId: voidPay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 400, tipCents: 400, reason: "Void", kind: "void" })
      .returning();
    await m.db.db.insert(s().tipLedger).values({
      shopId: shop.id, staffId: jessica.id, saleId: voidSale.id, paymentId: voidPay.id, refundId: voidRefund.id, kind: "refund", method: "card", amountCents: -400, feeCents: 0, businessDate: day,
    });

    await replay();
    await tl.syncTipLedger(m.db.db, { saleId: sale.id });

    const lines = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, sale.id));
    expect(lines.map((l) => l.kind).sort()).toEqual(["tip"]);
    expect(lines.reduce((n, l) => n + l.amountCents, 0)).toBe(760);
    const [abs] = await m.db.db.select().from(s().tipAbsorptions).where(and(eq(s().tipAbsorptions.refundId, refund.id), eq(s().tipAbsorptions.staffId, jessica.id)));
    expect(abs).toMatchObject({ kind: "after_payout", amountCents: 760 });
    const audits = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.clawback_restored"), eq(s().auditLog.entityId, `${refund.id}:${jessica.id}`)));
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ how: "no_transfer", cents: 760, ticket: sale.number });

    const kept = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.refundId, voidRefund.id));
    expect(kept).toMatchObject([{ amountCents: -400, kind: "refund" }]);

    const again = await replay().then(() => m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.clawback_restored"), eq(s().auditLog.entityId, `${refund.id}:${jessica.id}`))));
    expect(again).toHaveLength(1);

    const rows = await m.db.db.select({ slug: s().shops.slug, tips: s().shops.tipPayouts, receipt: s().shops.receipt, state: s().shops.state, rate: s().shops.serviceTaxRate }).from(s().shops);
    for (const r of rows) {
      const method = (r.tips as { defaultMethod?: string; schedule?: string }).defaultMethod;
      const schedule = (r.tips as { schedule?: string }).schedule;
      if (schedule === "payroll") expect(method).not.toBe("stripe");
      else expect(method === "cash").toBe(false);
    }
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, shop.id) }))!.tipPayouts).toMatchObject({ defaultMethod: "stripe" });
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, moline.id) }))!.tipPayouts).toMatchObject({ defaultMethod: "stripe", cardDelayDays: 2 });
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, clinton.id) }))!.tipPayouts).toMatchObject({ schedule: "payroll", defaultMethod: "cash" });

    const coralville = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, shop.id) }))!;
    expect(coralville.receipt).toMatchObject({ taxDisplay: { stateRate: 0.05, cityRate: 0.02 } });
    const dub = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, dubuque.id) }))!;
    expect(dub.receipt).toMatchObject({ taxDisplay: { stateRate: 0.06, cityRate: 0.01 } });
    const cl = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, clinton.id) }))!;
    expect((cl.receipt as { taxDisplay?: { stateRate?: number } }).taxDisplay?.stateRate ?? null).toBeNull();
  });
});
