/**
 * The stock ledger end to end: sales, refunds, voids, receiving, transfers and counts all post
 * ledger entries and on-hand always equals their sum; concurrent sales on the last unit; suggested
 * orders; partial receiving; approval and sending; and who may do what.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Who } from "@/server/inventory/ledger";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const ids: Record<string, string> = {};
const shopId: Record<string, string> = {};
let who: Who;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const cash = { method: "cash" as const, cashTenderedCents: null };

beforeAll(async () => {
  m = await loadModules();
  for (const l of ["owner", "admin", "regional", "michelle", "frontdesk", "makenna"]) ids[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shopId[s.slug] = s.id;
  who = { actor, name: "test", shopIds: Object.values(shopId) };
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

let seq = 0;
/** A product nobody else touches, carried (with no stock) at these shops, sold by a test vendor. */
async function product(shops: string[], o: { reorder?: number; par?: number; casePack?: number; cost?: number } = {}) {
  seq++;
  const [p] = await m.db.db
    .insert(m.schema.products)
    .values({ sku: `INV-TEST-${seq}`, name: `Test Pomade ${seq}`, brand: "Testco", category: "Styling", costCents: o.cost ?? 1000, priceCents: 2000, lowStockThreshold: o.reorder ?? 3, parLevel: o.par ?? 8 })
    .returning();
  await m.db.db.insert(m.schema.shopProducts).values(shops.map((s) => ({ shopId: s, productId: p.id, costCents: o.cost ?? 1000, priceCents: 2000 })));
  const [v] = await m.db.db
    .insert(m.schema.vendors)
    .values({ name: `Test Vendor ${seq}`, email: `orders${seq}@vendor.test`, leadTimeDays: 5 })
    .returning();
  await m.db.db.insert(m.schema.vendorProducts).values({ vendorId: v.id, productId: p.id, vendorSku: `V-${seq}`, casePack: o.casePack ?? 1, costCents: o.cost ?? 1000, preferred: true });
  return { id: p.id, vendorId: v.id };
}

const onHand = async (shop: string, productId: string) => (await m.db.db.query.shopProducts.findFirst({ where: and(eq(m.schema.shopProducts.shopId, shop), eq(m.schema.shopProducts.productId, productId)) }))!;
const ledger = (shop: string, productId: string) =>
  m.db.db
    .select()
    .from(m.schema.inventoryLedger)
    .where(and(eq(m.schema.inventoryLedger.shopId, shop), eq(m.schema.inventoryLedger.productId, productId)))
    .orderBy(m.schema.inventoryLedger.seq);
const position = async (shop: string, productId: string) => (await m.stock.stockLevels([shop], { productIds: [productId] }))[0];
const setTo = (shop: string, productId: string, to: number) => m.db.db.transaction((tx) => m.ledger.setOnHand(tx, { shopId: shop, productId, to, kind: "adjust", reason: "count_correction" }, { actor, negative: "allow" }));
const sell = async (shop: string, productId: string, qty = 1) => {
  const sale = await m.checkout.openBlankSale(shop, actor);
  const r = await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "product", refId: productId, qty }], tipCents: 0, tender: cash, actor });
  return { ...r, saleId: sale.id };
};

/** A sent purchase order for one product. */
async function sentPo(shop: string, p: { id: string; vendorId: string }, qty: number, unitCostCents = 1000) {
  const { created } = await m.purchasing.createPos(who, { picks: [{ shopId: shop, vendorId: p.vendorId }], fill: "empty" });
  const id = created[0].id;
  await m.purchasing.updatePo(who, id, { lines: [{ productId: p.id, qtyOrdered: qty, unitCostCents, vendorSku: null, casePack: 1 }] });
  await m.purchasing.sendPo(who, id, { method: "manual", reference: "Phoned in" });
  const lines = await m.db.db.select().from(m.schema.purchaseOrderLines).where(eq(m.schema.purchaseOrderLines.purchaseOrderId, id));
  return { id, lineId: lines[0].id };
}

describe("ledger math", () => {
  it("receiving, sales, refunds, voids and transfers each post an entry, and on-hand is always their sum", async () => {
    const cv = shopId.coralville;
    const ml = shopId.moline;
    const p = await product([cv, ml]);

    const po = await sentPo(cv, p, 12);
    await m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 12 }] });
    expect((await onHand(cv, p.id)).stock).toBe(12);

    const sale = await sell(cv, p.id, 3);
    expect((await onHand(cv, p.id)).stock).toBe(9);
    const item = (await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, sale.saleId)))[0];
    await m.checkout.refundSale({ saleId: sale.saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Returned unopened", restock: true, actor });
    expect((await onHand(cv, p.id)).stock).toBe(10);
    await m.checkout.refundSale({ saleId: sale.saleId, items: [{ saleItemId: item.id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Opened, binned", restock: false, actor });
    expect((await onHand(cv, p.id)).stock).toBe(10);

    const wrong = await sell(cv, p.id, 2);
    expect((await onHand(cv, p.id)).stock).toBe(8);
    await m.checkout.voidSale(wrong.saleId, "Rang up the wrong item", actor);
    expect((await onHand(cv, p.id)).stock).toBe(10);

    const t = await m.transfers.createTransfer(who, { fromShopId: cv, toShopId: ml, lines: [{ productId: p.id, qty: 4 }] });
    expect(await position(cv, p.id)).toMatchObject({ onHand: 10, committed: 4, available: 6 });
    await m.transfers.sendTransfer(who, t.id);
    expect(await position(cv, p.id)).toMatchObject({ onHand: 6, committed: 0 });
    expect(await position(ml, p.id)).toMatchObject({ onHand: 0, inTransit: 4 });
    const tl = (await m.db.db.select().from(m.schema.stockTransferLines).where(eq(m.schema.stockTransferLines.transferId, t.id)))[0];
    expect(await m.transfers.receiveTransfer(who, t.id, { lines: [{ lineId: tl.id, qty: 3 }] })).toEqual({ received: 3, short: 1 });
    expect(await position(ml, p.id)).toMatchObject({ onHand: 3, inTransit: 0 });

    const rows = await ledger(cv, p.id);
    expect(rows.map((r) => [r.kind, r.delta, r.balanceAfter])).toEqual([
      ["receive", 12, 12],
      ["sale", -3, 9],
      ["refund", 1, 10],
      ["sale", -2, 8],
      ["void", 2, 10],
      ["transfer_out", -4, 6],
    ]);
    expect(rows.find((r) => r.kind === "receive")).toMatchObject({ purchaseOrderId: po.id, unitCostCents: 1000 });
    expect(rows.find((r) => r.kind === "transfer_out")).toMatchObject({ transferId: t.id });
    expect((await ledger(ml, p.id)).map((r) => [r.kind, r.delta, r.balanceAfter])).toEqual([["transfer_in", 3, 3]]);
    expect(await m.stock.inventoryDrift()).toEqual([]);

    const today = m.time.todayLocal();
    const mv = (await m.invReports.movement({ shopIds: [cv], from: today, to: today })).find((r) => r.productId === p.id)!;
    expect(mv).toMatchObject({ opening: 0, received: 12, sold: 5, returned: 3, transferOut: 4, closing: 6, lostInTransit: 1, shrinkCents: 1000 });
    expect(mv.opening + mv.received + mv.returned + mv.transferIn - mv.sold - mv.transferOut - mv.damaged - mv.theft - mv.backBar + mv.found + mv.countVariance + mv.other).toBe(mv.closing);
  });

  it("manual adjustments need a reason that matches the direction, and are audited with the person", async () => {
    const p = await product([shopId.coralville]);
    await setTo(shopId.coralville, p.id, 6);
    const r = await m.adjust.adjustStock({ ...who, actor: { staffId: ids.michelle, label: "Michelle" } }, { shopId: shopId.coralville, productId: p.id, mode: "remove", qty: 2, reason: "damage", note: "Dropped" });
    expect(r).toMatchObject({ delta: -2, onHand: 4 });
    await expect(m.adjust.adjustStock(who, { shopId: shopId.coralville, productId: p.id, mode: "add", qty: 1, reason: "theft" })).rejects.toThrow();
    await expect(m.adjust.adjustStock(who, { shopId: shopId.coralville, productId: p.id, mode: "add", qty: 1, reason: "other" })).rejects.toThrow(/note/i);
    const set = await m.adjust.adjustStock(who, { shopId: shopId.coralville, productId: p.id, mode: "set", qty: 7, reason: "count_correction" });
    expect(set).toMatchObject({ delta: 3, onHand: 7 });
    const last = (await ledger(shopId.coralville, p.id)).slice(-2);
    expect(last.map((l) => [l.kind, l.reason, l.delta, l.note, l.staffId])).toEqual([
      ["adjust", "damage", -2, "Dropped", ids.michelle],
      ["adjust", "count_correction", 3, null, null],
    ]);
    const audit = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(and(eq(m.schema.auditLog.entityId, p.id), eq(m.schema.auditLog.actorStaffId, ids.michelle)));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("stock can't be written directly, and ledger entries can't be changed or deleted", async () => {
    const p = await product([shopId.coralville]);
    await setTo(shopId.coralville, p.id, 2);
    const where = and(eq(m.schema.shopProducts.shopId, shopId.coralville), eq(m.schema.shopProducts.productId, p.id));
    await expect(m.db.db.update(m.schema.shopProducts).set({ stock: 50 }).where(where)).rejects.toThrow();
    const [row] = await ledger(shopId.coralville, p.id);
    await expect(m.db.db.update(m.schema.inventoryLedger).set({ delta: 50 }).where(eq(m.schema.inventoryLedger.id, row.id))).rejects.toThrow();
    await expect(m.db.db.delete(m.schema.inventoryLedger).where(eq(m.schema.inventoryLedger.id, row.id))).rejects.toThrow();
    expect((await onHand(shopId.coralville, p.id)).stock).toBe(2);
    await m.db.db.update(m.schema.shopProducts).set({ priceCents: 2500 }).where(where);
    expect((await onHand(shopId.coralville, p.id)).priceCents).toBe(2500);
  });

  it("open tickets hold their retail as committed", async () => {
    const p = await product([shopId.coralville]);
    await setTo(shopId.coralville, p.id, 5);
    const sale = await m.checkout.openBlankSale(shopId.coralville, actor);
    await m.stock.holdRetail(sale.id, [{ productId: p.id, qty: 2 }]);
    expect(await position(shopId.coralville, p.id)).toMatchObject({ onHand: 5, committed: 2, available: 3 });
    await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "product", refId: p.id, qty: 2 }], tipCents: 0, tender: cash, actor });
    expect(await position(shopId.coralville, p.id)).toMatchObject({ onHand: 3, committed: 0, available: 3 });
  });
});

describe("concurrent sales", () => {
  it("five tickets at once each take one unit; none is lost and balances run 4..0", async () => {
    const p = await product([shopId.coralville]);
    await setTo(shopId.coralville, p.id, 5);
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => sell(shopId.coralville, p.id)));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect((await onHand(shopId.coralville, p.id)).stock).toBe(0);
    const sales = (await ledger(shopId.coralville, p.id)).filter((r) => r.kind === "sale");
    expect(sales.map((s) => s.balanceAfter)).toEqual([4, 3, 2, 1, 0]);
  });

  it("block: two tickets racing for the last unit, one sells it and the other is refused", async () => {
    const shop = await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, shopId.coralville) });
    expect(shop!.negativeStock).toBe("block");
    const p = await product([shopId.coralville]);
    await setTo(shopId.coralville, p.id, 1);
    const out = await Promise.allSettled([sell(shopId.coralville, p.id), sell(shopId.coralville, p.id)]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((out.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    expect((await onHand(shopId.coralville, p.id)).stock).toBe(0);
    expect(await m.stock.inventoryDrift()).toEqual([]);
  });

  it("warn: both sell, stock goes to −1, and the second sale says so", async () => {
    const shop = await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, shopId.moline) });
    expect(shop!.negativeStock).toBe("warn");
    const p = await product([shopId.moline]);
    await setTo(shopId.moline, p.id, 1);
    const out = await Promise.all([sell(shopId.moline, p.id), sell(shopId.moline, p.id)]);
    expect(out.flatMap((o) => o.stockWarnings)).toHaveLength(1);
    expect(out.flatMap((o) => o.stockWarnings)[0]).toMatch(/−1|-1/);
    expect((await onHand(shopId.moline, p.id)).stock).toBe(-1);
    expect(await m.stock.inventoryDrift()).toEqual([]);
  });

  it("a transfer can't send what a blocking shop doesn't have", async () => {
    const p = await product([shopId.coralville, shopId.moline]);
    await setTo(shopId.coralville, p.id, 2);
    const t = await m.transfers.createTransfer(who, { fromShopId: shopId.coralville, toShopId: shopId.moline, lines: [{ productId: p.id, qty: 3 }] });
    await expect(m.transfers.sendTransfer(who, t.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await onHand(shopId.coralville, p.id)).stock).toBe(2);
  });
});

describe("suggested purchase orders", () => {
  it("below the reorder point orders up to par in whole cases; drafts and open orders count as on order", async () => {
    const cv = shopId.coralville;
    const p = await product([cv], { reorder: 3, par: 8, casePack: 6 });
    const find = async () => (await m.purchasing.suggestionsFor([cv]))[0].orders.flatMap((o) => o.lines.map((l) => ({ ...l, vendorId: o.vendorId }))).find((l) => l.productId === p.id);
    await setTo(cv, p.id, 4);
    expect(await find()).toBeUndefined();
    await setTo(cv, p.id, 3);
    expect(await find()).toMatchObject({ vendorId: p.vendorId, qty: 6, cases: 1, casePack: 6, vendorSku: expect.any(String) });
    await setTo(cv, p.id, 1);
    expect(await find()).toMatchObject({ qty: 12, cases: 2 });

    const { created } = await m.purchasing.createPos(who, { picks: [{ shopId: cv, vendorId: p.vendorId }], fill: "suggested" });
    expect(created).toHaveLength(1);
    const lines = await m.db.db.select().from(m.schema.purchaseOrderLines).where(eq(m.schema.purchaseOrderLines.purchaseOrderId, created[0].id));
    expect(lines.map((l) => [l.productId, l.qtyOrdered, l.casePack])).toEqual([[p.id, 12, 6]]);
    expect(await find()).toBeUndefined();
    expect(await position(cv, p.id)).toMatchObject({ onOrder: 0 });
    await m.purchasing.sendPo(who, created[0].id, { method: "manual" });
    expect(await position(cv, p.id)).toMatchObject({ onOrder: 12, projected: 13 });
    expect(await find()).toBeUndefined();
  });

  it("a shop override replaces the brand default levels", async () => {
    const cv = shopId.coralville;
    const p = await product([cv], { reorder: 3, par: 8 });
    await setTo(cv, p.id, 4);
    await m.adjust.saveShopLevels(who, { shopId: cv, productId: p.id, reorderPoint: 5, par: 14 });
    expect((await position(cv, p.id)).levels).toEqual({ reorderPoint: 5, par: 14 });
    const s = (await m.purchasing.suggestionsFor([cv]))[0].orders.flatMap((o) => o.lines).find((l) => l.productId === p.id);
    expect(s?.qty).toBe(10);
    await m.adjust.saveShopLevels(who, { shopId: cv, productId: p.id, reorderPoint: null, par: null });
    expect((await position(cv, p.id)).levels).toEqual({ reorderPoint: 3, par: 8 });
  });

  it("brand level creates one draft per shop in a single batch", async () => {
    const p = await product([shopId.coralville, shopId.moline, shopId["rock-island"]]);
    for (const s of [shopId.coralville, shopId.moline]) await setTo(s, p.id, 0);
    await setTo(shopId["rock-island"], p.id, 9);
    const r = await m.purchasing.createPos(who, { picks: [shopId.coralville, shopId.moline, shopId["rock-island"]].map((s) => ({ shopId: s, vendorId: p.vendorId })), fill: "suggested" });
    expect(r.created).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    const batch = await m.purchasing.listPos(Object.values(shopId), { batchId: r.batchId! });
    expect(batch.map((b) => b.shopId).sort()).toEqual([shopId.coralville, shopId.moline].sort());
  });
});

describe("receiving", () => {
  it("partial deliveries add stock as they arrive; a cost change moves shelf cost to the weighted average", async () => {
    const cv = shopId.coralville;
    const p = await product([cv], { cost: 1000 });
    const po = await sentPo(cv, p, 12, 1000);
    expect(await position(cv, p.id)).toMatchObject({ onHand: 0, onOrder: 12 });

    const first = await m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 5 }], note: "Rest backordered" });
    expect(first).toMatchObject({ status: "partially_received", units: 5 });
    expect(await position(cv, p.id)).toMatchObject({ onHand: 5, onOrder: 7 });

    await expect(m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 8 }] })).rejects.toThrow(/only 7 are still due/);
    await expect(m.purchasing.cancelPo(who, po.id, "changed mind")).rejects.toThrow(/Close it instead/);

    const second = await m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 7, unitCostCents: 1300 }], updateVendorCost: true });
    expect(second).toMatchObject({ status: "received", units: 7 });
    expect(await position(cv, p.id)).toMatchObject({ onHand: 12, onOrder: 0 });
    expect((await onHand(cv, p.id)).costCents).toBe(Math.round((5 * 1000 + 7 * 1300) / 12));
    const offer = await m.db.db.query.vendorProducts.findFirst({ where: and(eq(m.schema.vendorProducts.vendorId, p.vendorId), eq(m.schema.vendorProducts.productId, p.id)) });
    expect(offer!.costCents).toBe(1300);

    const rows = (await ledger(cv, p.id)).filter((r) => r.kind === "receive");
    expect(rows.map((r) => [r.delta, r.unitCostCents, r.purchaseOrderId])).toEqual([
      [5, 1000, po.id],
      [7, 1300, po.id],
    ]);
    expect(new Set(rows.map((r) => r.receiptId)).size).toBe(2);
    await expect(m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 1 }] })).rejects.toThrow(/has been received/);
    const d = await m.purchasing.loadPo(po.id);
    expect(d!.receipts).toHaveLength(2);
    expect(d!.lines[0]).toMatchObject({ qtyOrdered: 12, qtyReceived: 12 });
  });

  it("closing short stops counting the rest as on order", async () => {
    const p = await product([shopId.coralville]);
    const po = await sentPo(shopId.coralville, p, 10);
    await m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 4 }] });
    await m.purchasing.closePoShort(who, po.id, "Discontinued by the vendor");
    expect(await position(shopId.coralville, p.id)).toMatchObject({ onHand: 4, onOrder: 0 });
    expect((await m.db.db.query.purchaseOrders.findFirst({ where: eq(m.schema.purchaseOrders.id, po.id) }))!).toMatchObject({ status: "received", closedShort: true });
  });

  it("receiving into a shop that didn't carry the product starts carrying it", async () => {
    const p = await product([shopId.coralville]);
    const po = await sentPo(shopId["rock-island"], p, 3);
    await m.purchasing.receivePo(who, po.id, { lines: [{ lineId: po.lineId, qty: 3 }] });
    expect((await onHand(shopId["rock-island"], p.id)).stock).toBe(3);
  });
});

describe("approval and sending", () => {
  it("over the limit a draft must be approved first; under it, sending approves it; editing an approved order reopens it", async () => {
    const [brand] = await m.db.db.select().from(m.schema.brandSettings).limit(1);
    expect(brand.poApprovalThresholdCents).toBe(50_000);
    const p = await product([shopId.coralville]);
    const { created } = await m.purchasing.createPos(who, { picks: [{ shopId: shopId.coralville, vendorId: p.vendorId }], fill: "empty" });
    const id = created[0].id;
    const big = { lines: [{ productId: p.id, qtyOrdered: 60, unitCostCents: 1000, vendorSku: "V", casePack: 1 }] };
    await m.purchasing.updatePo(who, id, big);
    await expect(m.purchasing.sendPo(who, id, { method: "email" })).rejects.toThrow(/needs approval/);
    await m.purchasing.approvePo({ ...who, actor: { staffId: ids.regional, label: "Regional" } }, id);
    expect(await m.purchasing.updatePo(who, id, { ...big, notes: "Add a note" })).toMatchObject({ reopened: true });
    expect((await m.db.db.query.purchaseOrders.findFirst({ where: eq(m.schema.purchaseOrders.id, id) }))!.status).toBe("draft");
    await m.purchasing.approvePo(who, id);

    const sent = await m.purchasing.sendPo(who, id, { method: "email", csv: true, message: "Thanks!" });
    expect(sent.sentTo).toMatch(/@vendor\.test$/);
    expect(sent.attachments).toEqual([expect.stringMatching(/^PO-\d+\.pdf$/), expect.stringMatching(/^PO-\d+\.csv$/)]);
    const job = (await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.purchaseOrderId, id)))[0];
    expect(job).toMatchObject({ kind: "purchase_order", channel: "email", shopId: shopId.coralville, status: "pending" });
    expect(Buffer.from(job.attachments![0].content, "base64").toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(Buffer.from(job.attachments![1].content, "base64").toString("utf8")).toContain("V,INV-TEST-");

    const small = await m.purchasing.createPos(who, { picks: [{ shopId: shopId.coralville, vendorId: p.vendorId }], fill: "empty" });
    await m.purchasing.updatePo(who, small.created[0].id, { lines: [{ productId: p.id, qtyOrdered: 2, unitCostCents: 1000, vendorSku: null, casePack: 1 }] });
    await m.purchasing.sendPo(who, small.created[0].id, { method: "manual", reference: "Ordered on their site" });
    const s = (await m.db.db.query.purchaseOrders.findFirst({ where: eq(m.schema.purchaseOrders.id, small.created[0].id) }))!;
    expect(s).toMatchObject({ status: "sent" });
    expect(s.approvedAt).not.toBeNull();
  });
});

describe("counts", () => {
  it("posting a stocktake sets on-hand to the count against stock at posting, so sales during the count aren't variance", async () => {
    const cv = shopId.coralville;
    const p = await product([cv]);
    await setTo(cv, p.id, 10);
    const c = await m.counts.startCount(who, { shopId: cv, kind: "cycle", productIds: [p.id] });
    await sell(cv, p.id, 2);
    await m.counts.saveCountLines(who, c.id, [{ productId: p.id, counted: 7 }]);
    const r = await m.counts.postCount(who, c.id);
    expect(r).toMatchObject({ counted: 1, changed: 1, varianceCents: -1000 });
    expect((await onHand(cv, p.id)).stock).toBe(7);
    expect((await ledger(cv, p.id)).at(-1)).toMatchObject({ kind: "stocktake", delta: -1, countId: c.id, balanceAfter: 7 });
    const line = (await m.counts.loadCount(c.id))!.lines[0];
    expect(line).toMatchObject({ expectedAtStart: 10, onHandAtPost: 8, counted: 7, variance: -1 });
  });
});

describe("permissions", () => {
  async function as(login: string) {
    await signInAs(ids[login]);
  }
  it("each purchasing and stock action needs its own permission and the shop", async () => {
    const po = await import("@/app/admin/purchase-orders/actions");
    const vend = await import("@/app/admin/vendors/actions");
    const inv = await import("@/app/admin/inventory/actions");
    const tr = await import("@/app/admin/inventory/transfers/actions");
    const ct = await import("@/app/admin/inventory/counts/actions");
    const p = await product([shopId.coralville, shopId.moline]);
    await setTo(shopId.coralville, p.id, 5);
    const pick = (s: string) => ({ picks: [{ shopId: s, vendorId: p.vendorId }], fill: "empty" as const });
    const vendor = { name: "Nope Supply", leadTimeDays: 3, minimumOrderCents: 0, sendCsv: false };
    const denied = { ok: false, error: expect.stringMatching(/permission/) };

    await as("makenna");
    expect(await po.createPosAction(pick(shopId.coralville))).toMatchObject(denied);
    expect(await inv.adjustStockAction({ shopId: shopId.coralville, productId: p.id, mode: "remove", qty: 1, reason: "damage" })).toMatchObject(denied);
    expect(await ct.startCountAction({ shopId: shopId.coralville, kind: "full" })).toMatchObject(denied);

    await as("frontdesk");
    expect(await po.createPosAction(pick(shopId.coralville))).toMatchObject(denied);
    expect(await vend.saveVendorAction(null, vendor)).toMatchObject(denied);
    expect(await inv.adjustStockAction({ shopId: shopId.coralville, productId: p.id, mode: "remove", qty: 1, reason: "damage" })).toMatchObject(denied);
    expect(await tr.createTransferAction({ fromShopId: shopId.coralville, toShopId: shopId.moline, lines: [] })).toMatchObject(denied);

    await as("michelle");
    const mine = await po.createPosAction(pick(shopId.coralville));
    expect(mine).toMatchObject({ ok: true });
    const myPo = (mine as { data: { created: { id: string }[] } }).data.created[0].id;
    expect(await po.createPosAction(pick(shopId.moline))).toMatchObject({ ok: false, error: "That shop is outside your access" });
    expect(await vend.saveVendorAction(null, vendor)).toMatchObject(denied);
    expect(await po.updatePoAction(myPo, { lines: [{ productId: p.id, qtyOrdered: 80, unitCostCents: 1000, vendorSku: null, casePack: 1 }] })).toMatchObject({ ok: true });
    expect(await po.approvePoAction(myPo)).toMatchObject(denied);
    expect(await po.sendPoAction(myPo, { method: "manual" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs approval/) });

    await as("regional");
    expect(await po.approvePoAction(myPo)).toMatchObject({ ok: false, error: expect.stringMatching(/outside your access/) });
    const theirs = await po.createPosAction(pick(shopId.moline));
    expect(theirs).toMatchObject({ ok: true });
    expect(await vend.saveVendorAction(null, vendor)).toMatchObject({ ok: true });

    await as("admin");
    expect(await po.approvePoAction(myPo)).toMatchObject({ ok: true });

    await as("michelle");
    expect(await po.sendPoAction(myPo, { method: "manual" })).toMatchObject({ ok: true });
    expect(await inv.adjustStockAction({ shopId: shopId.moline, productId: p.id, mode: "remove", qty: 1, reason: "damage" })).toMatchObject({ ok: false, error: "That shop is outside your access" });
    expect(await inv.saveBrandLevelsAction({ productId: p.id, reorderPoint: 1, par: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/all shops/) });
    expect(await tr.createTransferAction({ fromShopId: shopId.moline, toShopId: shopId.coralville, lines: [] })).toMatchObject({ ok: false, error: "That shop is outside your access" });
    const out = await tr.createTransferAction({ fromShopId: shopId.coralville, toShopId: shopId.moline, lines: [{ productId: p.id, qty: 1 }] });
    expect(out).toMatchObject({ ok: true });
    const tid = (out as { data: { id: string } }).data.id;
    expect(await tr.sendTransferAction(tid)).toMatchObject({ ok: true });
    const tl = (await m.db.db.select().from(m.schema.stockTransferLines).where(eq(m.schema.stockTransferLines.transferId, tid)))[0];
    expect(await tr.receiveTransferAction(tid, { lines: [{ lineId: tl.id, qty: 1 }] })).toMatchObject({ ok: false, error: expect.stringMatching(/receiving shop/) });

    await as("frontdesk");
    const line = (await m.db.db.select().from(m.schema.purchaseOrderLines).where(eq(m.schema.purchaseOrderLines.purchaseOrderId, myPo)))[0];
    expect(await po.receivePoAction(myPo, { lines: [{ lineId: line.id, qty: 10 }] })).toMatchObject({ ok: true, data: { status: "partially_received" } });
    expect(await po.sendPoAction(myPo, { method: "manual" })).toMatchObject(denied);
    expect(await ct.startCountAction({ shopId: shopId.coralville, kind: "cycle", productIds: [p.id] })).toMatchObject({ ok: true });

    await as("regional");
    expect(await tr.receiveTransferAction(tid, { lines: [{ lineId: tl.id, qty: 1 }] })).toMatchObject({ ok: true });
    expect(await m.stock.inventoryDrift()).toEqual([]);
  });

  it("purchase order documents and email attachments are only for purchasing staff at that shop", async () => {
    const doc = await import("@/app/admin/purchase-orders/[id]/document/route");
    const att = await import("@/app/admin/notifications/[id]/attachment/route");
    const p = await product([shopId.coralville]);
    const { created } = await m.purchasing.createPos(who, { picks: [{ shopId: shopId.coralville, vendorId: p.vendorId }], fill: "empty" });
    const id = created[0].id;
    await m.purchasing.updatePo(who, id, { lines: [{ productId: p.id, qtyOrdered: 2, unitCostCents: 1000, vendorSku: null, casePack: 1 }] });
    const sent = await m.purchasing.sendPo(who, id, { method: "email" });
    const get = (format: string) => doc.GET(new Request(`http://x/admin/purchase-orders/${id}/document?format=${format}`), { params: Promise.resolve({ id }) });
    const file = () => att.GET(new Request(`http://x/admin/notifications/${sent.jobId}/attachment?i=0`), { params: Promise.resolve({ id: sent.jobId! }) });

    await as("makenna");
    expect((await get("pdf")).status).toBe(403);
    expect((await file()).status).toBe(403);
    await as("regional");
    expect((await get("pdf")).status).toBe(404);
    expect((await file()).status).toBe(404);
    await as("frontdesk");
    const pdf = await get("pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const csv = await get("csv");
    expect(await csv.text()).toMatch(/^po_number,/);
    const a = await file();
    expect(a.status).toBe(200);
    expect(Buffer.from(await a.arrayBuffer()).toString("latin1").startsWith("%PDF-")).toBe(true);
  });

  it("inventory pages follow their permissions", async () => {
    const { pageOutcome } = await import("./session");
    const pages = {
      vendors: (await import("@/app/admin/vendors/page")).default,
      pos: (await import("@/app/admin/purchase-orders/page")).default,
      counts: (await import("@/app/admin/inventory/counts/page")).default,
      transfers: (await import("@/app/admin/inventory/transfers/page")).default,
      low: (await import("@/app/admin/inventory/low-stock/page")).default,
      settings: (await import("@/app/admin/inventory/settings/page")).default,
    };
    const run = async (login: string) => {
      await as(login);
      const out: Record<string, string> = {};
      for (const [k, page] of Object.entries(pages)) out[k] = await pageOutcome(() => (page as (p: unknown) => Promise<unknown>)({ searchParams: Promise.resolve({}), params: Promise.resolve({}) }));
      return out;
    };
    expect(await run("makenna")).toEqual({ vendors: "denied", pos: "denied", counts: "denied", transfers: "denied", low: "denied", settings: "denied" });
    expect(await run("frontdesk")).toEqual({ vendors: "denied", pos: "ok", counts: "ok", transfers: "ok", low: "ok", settings: "denied" });
    expect(await run("michelle")).toEqual({ vendors: "ok", pos: "ok", counts: "ok", transfers: "ok", low: "ok", settings: "ok" });
  });
});
