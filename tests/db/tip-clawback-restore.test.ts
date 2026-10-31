/**
 * core_0156: an old partial refund that took a transferred tip back (Jessica's $7.60 on ticket 14858)
 * is restored. The barber keeps the tip, the shop absorbs it, and a second run changes nothing.
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
  const file = readFileSync("drizzle/core_0156_tip_clawback_restore.sql", "utf8");
  for (const q of file.split("--> statement-breakpoint")) {
    const sql = q.trim();
    if (sql) await m.db.db.execute(m.drizzle.sql.raw(sql));
  }
}

describe("core_0156 tip claw-back restore", () => {
  it("gives Jessica's transferred $7.60 back and leaves a refund-before-send and a real Stripe reversal", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!;
    const [jessica] = await m.db.db
      .select({ id: s().staff.id })
      .from(s().staff)
      .where(eq(s().staff.displayLabel, "Jessica"));
    const day = m.time.todayLocal();
    const [sale] = await m.db.db
      .insert(s().sales)
      .values({ shopId: shop.id, staffId: jessica.id, status: "partially_refunded", businessDate: day, serviceNetCents: 4000, tipCents: 760, totalCents: 4760 })
      .returning();
    const [pay] = await m.db.db
      .insert(s().payments)
      .values({
        saleId: sale.id,
        shopId: shop.id,
        businessDate: day,
        method: "card",
        status: "partially_refunded",
        amountCents: 4760,
        tipCents: 760,
        chargeType: "separate",
        settlement: "platform",
        transferGroup: `sale_${sale.id}`,
      })
      .returning();
    const [transfer] = await m.db.db
      .insert(s().paymentTransfers)
      .values({
        paymentId: pay.id,
        saleId: sale.id,
        shopId: shop.id,
        kind: "tip",
        staffId: jessica.id,
        destinationAccount: "acct_jessica_test",
        amountCents: 760,
        transferGroup: `sale_${sale.id}`,
        status: "sent",
        stripeTransferId: `tr_claw_${sale.id.slice(0, 8)}`,
        sentAt: new Date(),
        stripeReversedAt: new Date(),
      })
      .returning();
    const [refund] = await m.db.db
      .insert(s().refunds)
      .values({ saleId: sale.id, paymentId: pay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 760, tipCents: 760, reason: "Partial refund", kind: "refund" })
      .returning();
    await m.db.db.insert(s().tipLedger).values([
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, kind: "tip", method: "card", amountCents: 760, feeCents: 0, businessDate: day },
      { shopId: shop.id, staffId: jessica.id, saleId: sale.id, paymentId: pay.id, refundId: refund.id, kind: "refund", method: "card", amountCents: -760, feeCents: 0, businessDate: day },
    ]);

    const [earlySale] = await m.db.db
      .insert(s().sales)
      .values({ shopId: shop.id, staffId: jessica.id, status: "refunded", businessDate: day, tipCents: 500, totalCents: 500 })
      .returning();
    const [earlyPay] = await m.db.db
      .insert(s().payments)
      .values({ saleId: earlySale.id, shopId: shop.id, businessDate: day, method: "card", status: "refunded", amountCents: 500, tipCents: 500, chargeType: "separate", settlement: "platform" })
      .returning();
    const [earlyRefund] = await m.db.db
      .insert(s().refunds)
      .values({ saleId: earlySale.id, paymentId: earlyPay.id, shopId: shop.id, businessDate: day, method: "card", amountCents: 500, tipCents: 500, reason: "Refund before the tip was sent" })
      .returning();
    await m.db.db.insert(s().tipLedger).values({
      shopId: shop.id,
      staffId: jessica.id,
      saleId: earlySale.id,
      paymentId: earlyPay.id,
      refundId: earlyRefund.id,
      kind: "refund",
      method: "card",
      amountCents: -500,
      feeCents: 0,
      businessDate: day,
    });

    const [stripeSale] = await m.db.db
      .insert(s().sales)
      .values({ shopId: shop.id, staffId: jessica.id, status: "paid", businessDate: day, tipCents: 300, totalCents: 300 })
      .returning();
    const [stripePay] = await m.db.db
      .insert(s().payments)
      .values({ saleId: stripeSale.id, shopId: shop.id, businessDate: day, method: "card", status: "succeeded", amountCents: 300, tipCents: 300, chargeType: "separate", settlement: "platform", transferGroup: `sale_${stripeSale.id}` })
      .returning();
    const [stripeTransfer] = await m.db.db
      .insert(s().paymentTransfers)
      .values({
        paymentId: stripePay.id,
        saleId: stripeSale.id,
        shopId: shop.id,
        kind: "tip",
        staffId: jessica.id,
        destinationAccount: "acct_jessica_test",
        amountCents: 300,
        transferGroup: `sale_${stripeSale.id}`,
        status: "sent",
        stripeTransferId: `tr_stripe_${stripeSale.id.slice(0, 8)}`,
        sentAt: new Date(),
        stripeReversedAt: new Date(),
      })
      .returning();

    await replay();
    await tl.syncTipLedger(m.db.db, { saleId: sale.id });

    const lines = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, sale.id));
    expect(lines.map((l) => l.kind).sort()).toEqual(["tip"]);
    expect(lines.reduce((n, l) => n + l.amountCents, 0)).toBe(760);
    const [abs] = await m.db.db.select().from(s().tipAbsorptions).where(and(eq(s().tipAbsorptions.refundId, refund.id), eq(s().tipAbsorptions.staffId, jessica.id)));
    expect(abs).toMatchObject({ kind: "after_payout", amountCents: 760, shopId: shop.id });
    const [tr] = await m.db.db.select().from(s().paymentTransfers).where(eq(s().paymentTransfers.id, transfer.id));
    expect(tr.stripeReversedAt).toBeNull();
    expect(tr.amountCents).toBe(760);
    const audits = await m.db.db
      .select()
      .from(s().auditLog)
      .where(and(eq(s().auditLog.action, "tips.clawback_restored"), eq(s().auditLog.entityId, `${refund.id}:${jessica.id}`)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorLabel: "system", shopId: shop.id, entity: "refund" });
    expect(audits[0].details).toMatchObject({ ticket: sale.number, cents: 760, how: "removed", refundId: refund.id, staffId: jessica.id });

    const early = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.refundId, earlyRefund.id));
    expect(early).toMatchObject([{ amountCents: -500, kind: "refund" }]);
    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.refundId, earlyRefund.id))).toEqual([]);

    const [kept] = await m.db.db.select().from(s().paymentTransfers).where(eq(s().paymentTransfers.id, stripeTransfer.id));
    expect(kept.stripeReversedAt).not.toBeNull();

    await replay();
    const again = await m.db.db
      .select()
      .from(s().auditLog)
      .where(and(eq(s().auditLog.action, "tips.clawback_restored"), eq(s().auditLog.entityId, `${refund.id}:${jessica.id}`)));
    expect(again).toHaveLength(1);
    expect(await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, sale.id))).toHaveLength(1);
  });
});
