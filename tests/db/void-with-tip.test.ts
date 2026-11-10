/**
 * Void a paid ticket that has a tip already sent to the barber. The client gets the tip back.
 * The tip transfer is not reversed, and the shop absorbs it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;

beforeAll(async () => {
  m = await loadModules();
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;

describe("void with a tip", () => {
  it("gives the tip back to the client and does not claw it back from the barber", async () => {
    const shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "moline") }))!;
    const [barber] = await m.db.db
      .select({ id: s().staff.id })
      .from(s().staffShops)
      .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
      .where(and(eq(s().staffShops.shopId, shop.id), eq(s().staff.displayLabel, "Jilane")));
    const sale = await m.checkout.openBlankSale(shop.id, actor, barber.id);
    const svc = (await m.catalog.shopCatalog(shop.id)).find((x) => x.slug === "rayz-cut-shampoo")!;
    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [{ kind: "service", refId: svc.id, qty: 1 }],
      tipCents: 900,
      tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" },
      actor,
    });
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, sale.id));
    const [transfer] = await m.db.db
      .insert(s().paymentTransfers)
      .values({
        paymentId: pay.id,
        saleId: sale.id,
        shopId: shop.id,
        kind: "tip",
        staffId: barber.id,
        destinationAccount: "acct_void_tip_test",
        amountCents: 900,
        transferGroup: `sale_${sale.id}`,
        status: "sent",
        stripeTransferId: `tr_void_${sale.id.replace(/-/g, "").slice(0, 12)}`,
        sentAt: new Date(),
      })
      .returning();

    await m.checkout.voidSale(sale.id, "Rang up the wrong client", actor);

    const [refund] = await m.db.db.select().from(s().refunds).where(eq(s().refunds.saleId, sale.id));
    expect(refund.kind).toBe("void");
    expect(refund.tipCents).toBe(900);
    const [kept] = await m.db.db.select().from(s().paymentTransfers).where(eq(s().paymentTransfers.id, transfer.id));
    expect(kept.reversedCents).toBe(0);
    expect(kept.stripeReversedAt).toBeNull();
    expect(kept.status).toBe("sent");
    const reversals = await m.db.db.select().from(s().paymentTransferReversals).where(eq(s().paymentTransferReversals.transferId, transfer.id));
    expect(reversals).toEqual([]);
    const absorbed = await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, sale.id));
    expect(absorbed).toEqual([expect.objectContaining({ staffId: barber.id, amountCents: 900, kind: "after_payout" })]);
    const clawed = (await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.saleId, sale.id), eq(s().tipLedger.kind, "refund")))).filter((r) => r.amountCents < 0);
    expect(clawed).toEqual([]);
  });
});
