/**
 * Gift card management: a paid reload goes through checkout onto the existing card and a refund takes
 * it back off without killing the card; comp value, voids, the reload ticket, and who sees what.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let G: typeof import("@/server/gift-cards");
const shopId: Record<string, string> = {};
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const cash = { method: "cash" as const, cashTenderedCents: null };
const brand = () => ({ shopIds: Object.values(shopId), brandWide: true });
const at = (slug: string) => ({ shopIds: [shopId[slug]], brandWide: false });

beforeAll(async () => {
  m = await loadModules();
  G = await import("@/server/gift-cards");
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const card = async (id: string) => (await m.db.db.query.giftCards.findFirst({ where: eq(m.schema.giftCards.id, id) }))!;
const ledger = async (id: string) => (await m.db.db.select().from(m.schema.giftCardLedger).where(eq(m.schema.giftCardLedger.giftCardId, id))).map((l) => [l.kind, l.deltaCents]);

describe("gift cards", () => {
  it("reloads a card at checkout, and a refund takes the reload back off but leaves the card live", async () => {
    const g = await G.issueCompCard(actor, at("silvis"), { shopId: shopId.silvis, amountCents: 2000, reason: "Test card" });
    const { saleId } = await G.startReloadTicket(actor, at("rock-island"), { shopId: shopId["rock-island"], id: g.id, amountCents: 2500 });
    const items = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, saleId));
    expect(items.map((i) => [i.kind, i.refId, i.unitPriceCents])).toEqual([["gift_card", g.id, 2500]]);

    const r = await m.checkout.finalizeSale({ saleId, lines: [{ kind: "gift_card", refId: g.id, qty: 1, unitPriceCents: 2500 }], tipCents: 0, tender: cash, actor });
    expect(r.reloadedGiftCards).toEqual([{ code: g.code, amountCents: 2500, balanceCents: 4500 }]);
    expect(r.issuedGiftCards).toEqual([]);
    expect((await card(g.id)).balanceCents).toBe(4500);
    const sale = (await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, saleId) }))!;
    expect(sale.giftCardSalesCents).toBe(2500);

    const st = await m.refunds.refundableState(saleId);
    expect(st.items[0].giftCards).toMatchObject([{ id: g.id, reload: true }]);
    await m.refunds.refundSale({ saleId, items: [{ saleItemId: st.items[0].id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Changed mind", restock: false, actor });
    const after = await card(g.id);
    expect([after.status, after.balanceCents]).toEqual(["active", 2000]);
    expect(await ledger(g.id)).toEqual([
      ["issue", 2000],
      ["reload", 2500],
      ["reload_refund", -2500],
    ]);
  });

  it("refuses a reload on a voided card, more than one per line, or paid with itself", async () => {
    const g = await G.issueCompCard(actor, brand(), { shopId: shopId.silvis, amountCents: 1000, reason: "Test" });
    const sale = await m.checkout.openBlankSale(shopId.silvis, actor);
    await expect(m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "gift_card", refId: g.id, qty: 2, unitPriceCents: 1000 }], tipCents: 0, tender: cash, actor })).rejects.toThrow(/one card per line/);
    await expect(
      m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "gift_card", refId: g.id, qty: 1, unitPriceCents: 1000 }], tipCents: 0, giftCard: { code: g.code, amountCents: 1000 }, tender: cash, actor }),
    ).rejects.toThrow(/its own reload/);
    await G.voidGiftCard(actor, brand(), { id: g.id, reason: "Lost" });
    await expect(m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "gift_card", refId: g.id, qty: 1, unitPriceCents: 1000 }], tipCents: 0, tender: cash, actor })).rejects.toThrow(/voided/);
    await expect(G.startReloadTicket(actor, brand(), { shopId: shopId.silvis, id: g.id, amountCents: 1000 })).rejects.toThrow(/voided/);
    await expect(G.voidGiftCard(actor, brand(), { id: g.id, reason: "Again" })).rejects.toThrow(/already voided/);
  });

  it("adds comp value only where the card was issued, and audits every change", async () => {
    const g = await G.issueCompCard(actor, at("silvis"), { shopId: shopId.silvis, amountCents: 1500, reason: "Recovery" });
    await expect(G.compReload(actor, at("moline"), { id: g.id, amountCents: 500, reason: "x" })).rejects.toThrow(/outside your shops/);
    await expect(G.voidGiftCard(actor, at("moline"), { id: g.id, reason: "x" })).rejects.toThrow(/outside your shops/);
    await expect(G.issueCompCard(actor, at("moline"), { shopId: shopId.silvis, amountCents: 500, reason: "x" })).rejects.toThrow(/outside your access/);
    expect(await G.compReload(actor, at("silvis"), { id: g.id, amountCents: 500, reason: "Long wait" })).toEqual({ balanceCents: 2000 });
    const big = await G.issueCompCard(actor, at("silvis"), { shopId: shopId.silvis, amountCents: 50_000, reason: "Raffle" });
    await G.compReload(actor, at("silvis"), { id: big.id, amountCents: 50_000, reason: "Raffle" });
    await expect(G.compReload(actor, at("silvis"), { id: big.id, amountCents: 100, reason: "x" })).rejects.toThrow(/more than \$1,000/);
    const log = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, g.id));
    expect(log.map((l) => l.action).sort()).toEqual(["giftcard.comp_reload", "giftcard.issue_comp"]);
  });

  it("lists cards issued at the person's shops, finds any card by its whole code, and hides other shops' details", async () => {
    const g = await G.issueCompCard(actor, at("silvis"), { shopId: shopId.silvis, amountCents: 1200, reason: "Test" });
    const mine = await G.searchGiftCards(at("silvis"), { q: g.code.slice(0, 9) });
    expect(mine.some((r) => r.id === g.id && r.manageable)).toBe(true);
    expect((await G.searchGiftCards(at("moline"), { q: g.code.slice(0, 9) })).some((r) => r.id === g.id)).toBe(false);
    const found = await G.searchGiftCards(at("moline"), { q: g.code });
    expect(found).toMatchObject([{ id: g.id, issuedAt: "Another Ray'z shop", client: null, manageable: false }]);
    expect(await G.giftCardDetail(at("moline"), { id: g.id })).toBeNull();
    expect(await G.giftCardDetail(at("moline"), { code: g.code })).toMatchObject({ balanceCents: 1200, manageable: false, issuedAt: "Another Ray'z shop" });
    const stats = await G.giftCardStats(at("silvis"));
    expect(stats.outstanding).toBeGreaterThanOrEqual(1200);
    expect(stats.comped).toBeGreaterThanOrEqual(1200);
  });
});
