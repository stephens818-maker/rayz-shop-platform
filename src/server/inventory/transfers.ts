import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, Tx } from "@/db";
import { auditLog, products, shopProducts, shops, staff, stockTransferLines, stockTransfers } from "@/db/schema";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { Who, assertShop, lockStock, postMovements } from "./ledger";
import { stockLevels } from "./stock";

/**
 * Moving stock between shops. A draft holds the stock at the source (it counts as committed); sending
 * takes it off the source's shelf; receiving puts it on the destination's. Anything that doesn't
 * arrive is written off as lost in transit at the source's cost.
 */
export const TransferInput = z.object({
  fromShopId: z.uuid(),
  toShopId: z.uuid(),
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((s) => (s ? s : null)),
  lines: z.array(z.object({ productId: z.uuid(), qty: z.number().int("Transfer whole units").min(1, "Quantities are at least 1").max(100_000) })).max(500),
});

type Transfer = typeof stockTransfers.$inferSelect;

async function lockTransfer(tx: Tx, who: Who, id: string, side: "from" | "to" | "either"): Promise<Transfer> {
  const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for("update");
  if (!t) throw notFound("Transfer");
  const ok = side === "from" ? who.shopIds.includes(t.fromShopId) : side === "to" ? who.shopIds.includes(t.toShopId) : who.shopIds.includes(t.fromShopId) || who.shopIds.includes(t.toShopId);
  if (!ok) throw new AppError("forbidden", side === "to" ? "Only the receiving shop can receive this transfer" : "That shop is outside your access");
  return t;
}

async function checkLines(tx: Tx, fromShopId: string, lines: { productId: string }[]) {
  const ids = lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) throw new AppError("bad_request", "Each product goes on the transfer once");
  if (!ids.length) return;
  const carried = await tx
    .select({ productId: shopProducts.productId })
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, fromShopId), inArray(shopProducts.productId, ids)));
  if (carried.length !== ids.length) throw new AppError("bad_request", "Only products the sending shop carries can be transferred");
}

export async function createTransfer(who: Who, raw: z.input<typeof TransferInput>) {
  const v = TransferInput.parse(raw);
  if (v.fromShopId === v.toShopId) throw new AppError("bad_request", "Pick two different shops");
  // Sending only needs the source shop: a manager can send stock to a sister shop, which checks it in.
  assertShop(who, v.fromShopId);
  return db.transaction(async (tx) => {
    const [dest] = await tx.select({ id: shops.id }).from(shops).where(eq(shops.id, v.toShopId));
    if (!dest) throw notFound("Shop");
    await checkLines(tx, v.fromShopId, v.lines);
    const [t] = await tx.insert(stockTransfers).values({ fromShopId: v.fromShopId, toShopId: v.toShopId, note: v.note, createdBy: who.actor.staffId ?? null }).returning();
    if (v.lines.length) await tx.insert(stockTransferLines).values(v.lines.map((l) => ({ transferId: t.id, ...l })));
    await audit(who.actor, "transfer.create", "transfer", t.id, { number: t.number, toShopId: v.toShopId, lines: v.lines }, v.fromShopId, tx);
    return { id: t.id, number: t.number };
  });
}

export async function updateTransfer(who: Who, id: string, raw: { note?: string | null; lines: { productId: string; qty: number }[] }) {
  return db.transaction(async (tx) => {
    const t = await lockTransfer(tx, who, id, "from");
    if (t.status !== "draft") throw new AppError("conflict", "Only drafts can be edited");
    const v = TransferInput.parse({ fromShopId: t.fromShopId, toShopId: t.toShopId, note: raw.note, lines: raw.lines });
    await checkLines(tx, t.fromShopId, v.lines);
    await tx.delete(stockTransferLines).where(eq(stockTransferLines.transferId, id));
    if (v.lines.length) await tx.insert(stockTransferLines).values(v.lines.map((l) => ({ transferId: id, ...l })));
    await tx.update(stockTransfers).set({ note: v.note }).where(eq(stockTransfers.id, id));
    await audit(who.actor, "transfer.update", "transfer", id, { number: t.number, lines: v.lines }, t.fromShopId, tx);
  });
}

/** Takes the stock off the sending shop's shelf; the receiving shop sees it in transit. */
export async function sendTransfer(who: Who, id: string) {
  return db.transaction(async (tx) => {
    const t = await lockTransfer(tx, who, id, "from");
    if (t.status !== "draft") throw new AppError("conflict", `This transfer is already ${t.status}`);
    const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, id));
    if (!lines.length) throw new AppError("bad_request", "Add at least one product");
    const locked = await lockStock(
      tx,
      lines.map((l) => ({ shopId: t.fromShopId, productId: l.productId })),
    );
    for (const l of lines) {
      await tx
        .update(stockTransferLines)
        .set({ unitCostCents: locked.get(`${t.fromShopId}|${l.productId}`)?.cost_cents ?? null })
        .where(eq(stockTransferLines.id, l.id));
    }
    const r = await postMovements(
      tx,
      lines.map((l) => ({ shopId: t.fromShopId, productId: l.productId, delta: -l.qty, kind: "transfer_out" as const, transferId: id })),
      { actor: who.actor, audit: { action: "transfer.send", entity: "transfer", entityId: id, details: { number: t.number, toShopId: t.toShopId } } },
    );
    const now = new Date();
    await tx.update(stockTransfers).set({ status: "sent", sentAt: now, sentBy: who.actor.staffId ?? null }).where(eq(stockTransfers.id, id));
    return { warnings: r.warnings };
  });
}

export const ReceiveTransferInput = z.object({ lines: z.array(z.object({ lineId: z.uuid(), qty: z.number().int("Whole units").min(0) })) });

/**
 * The receiving shop counts what arrived. It can't be more than was sent; anything short is lost
 * in transit and shows as shrink at the sending shop.
 */
export async function receiveTransfer(who: Who, id: string, raw: z.input<typeof ReceiveTransferInput>) {
  const v = ReceiveTransferInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = await lockTransfer(tx, who, id, "to");
    if (t.status !== "sent") throw new AppError("conflict", t.status === "draft" ? "This transfer hasn't been sent yet" : `This transfer is already ${t.status}`);
    const lines = await tx
      .select({ l: stockTransferLines, brand: products.brand, name: products.name, priceCents: products.priceCents })
      .from(stockTransferLines)
      .innerJoin(products, eq(products.id, stockTransferLines.productId))
      .where(eq(stockTransferLines.transferId, id));
    const got = new Map(v.lines.map((l) => [l.lineId, l.qty]));
    for (const id of got.keys()) if (!lines.some((x) => x.l.id === id)) throw new AppError("bad_request", "That line isn't on this transfer");
    for (const { l, brand, name } of lines) {
      const q = got.get(l.id) ?? l.qty;
      if (q > l.qty) throw new AppError("bad_request", `${brand} ${name}: ${l.qty} were sent, so no more than that can arrive`);
    }
    // The receiving shop starts carrying anything it didn't, at the sending shop's cost.
    const [src] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, t.fromShopId));
    await tx
      .insert(shopProducts)
      .values(lines.map(({ l, priceCents }) => ({ shopId: t.toShopId, productId: l.productId, costCents: l.unitCostCents ?? 0, priceCents })))
      .onConflictDoNothing();
    const now = new Date();
    for (const { l } of lines) await tx.update(stockTransferLines).set({ qtyReceived: got.get(l.id) ?? l.qty }).where(eq(stockTransferLines.id, l.id));
    const moves = lines
      .map(({ l }) => ({ shopId: t.toShopId, productId: l.productId, delta: got.get(l.id) ?? l.qty, kind: "transfer_in" as const, unitCostCents: l.unitCostCents, transferId: id }))
      .filter((m) => m.delta > 0);
    // What's short already left the sending shop's shelf when it was sent; reports count it as lost in transit there.
    const short = lines.map(({ l }) => ({ productId: l.productId, qty: l.qty - (got.get(l.id) ?? l.qty) })).filter((s) => s.qty > 0);
    await postMovements(tx, moves, {
      actor: who.actor,
      audit: { action: "transfer.receive", entity: "transfer", entityId: id, details: { number: t.number, fromShopId: t.fromShopId, from: src?.name, ...(short.length ? { lostInTransit: short } : {}) } },
    });
    if (!moves.length) await audit(who.actor, "transfer.receive", "transfer", id, { number: t.number, fromShopId: t.fromShopId, lostInTransit: short }, t.toShopId, tx);
    await tx.update(stockTransfers).set({ status: "received", receivedAt: now, receivedBy: who.actor.staffId ?? null }).where(eq(stockTransfers.id, id));
    return { received: moves.reduce((a, m) => a + m.delta, 0), short: short.reduce((a, s) => a + s.qty, 0) };
  });
}

export async function cancelTransfer(who: Who, id: string) {
  await db.transaction(async (tx) => {
    const t = await lockTransfer(tx, who, id, "from");
    if (t.status !== "draft") throw new AppError("conflict", t.status === "sent" ? "This transfer is on its way; the receiving shop receives it (enter 0 for anything that didn't arrive)" : `This transfer is already ${t.status}`);
    await tx.update(stockTransfers).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(stockTransfers.id, id));
    await audit(who.actor, "transfer.cancel", "transfer", id, { number: t.number }, t.fromShopId, tx);
  });
}

export async function listTransfers(shopIds: string[]) {
  return (await db.execute(sql`
    select t.id, t.number, t.status, t.from_shop_id "fromShopId", f.name "from", t.to_shop_id "toShopId", d.name "to", t.note,
      t.created_at "createdAt", t.sent_at "sentAt", t.received_at "receivedAt",
      coalesce(sum(l.qty), 0)::int units, coalesce(sum(l.qty_received), 0)::int received, count(l.id)::int lines
    from stock_transfers t
    join shops f on f.id = t.from_shop_id
    join shops d on d.id = t.to_shop_id
    left join stock_transfer_lines l on l.transfer_id = t.id
    where t.from_shop_id in (${sql.join(shopIds.length ? shopIds.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})
       or t.to_shop_id in (${sql.join(shopIds.length ? shopIds.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})
    group by t.id, f.name, d.name
    order by case t.status when 'draft' then 0 when 'sent' then 1 else 2 end, t.number desc
    limit 200`)) as unknown as {
    id: string;
    number: number;
    status: "draft" | "sent" | "received" | "cancelled";
    fromShopId: string;
    from: string;
    toShopId: string;
    to: string;
    note: string | null;
    createdAt: string;
    sentAt: string | null;
    receivedAt: string | null;
    units: number;
    received: number;
    lines: number;
  }[];
}

export async function loadTransfer(id: string) {
  const [t] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id));
  if (!t) return null;
  const [shopRows, lines, history, people] = await Promise.all([
    db
      .select({ id: shops.id, name: shops.name })
      .from(shops)
      .where(inArray(shops.id, [t.fromShopId, t.toShopId])),
    db
      .select({ l: stockTransferLines, sku: products.sku, brand: products.brand, name: products.name })
      .from(stockTransferLines)
      .innerJoin(products, eq(products.id, stockTransferLines.productId))
      .where(eq(stockTransferLines.transferId, id))
      .orderBy(asc(products.brand), asc(products.name)),
    db
      .select({ at: auditLog.at, who: auditLog.actorLabel, action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entity, "transfer"), eq(auditLog.entityId, id)))
      .orderBy(desc(auditLog.at)),
    db
      .select({ id: staff.id, label: staff.displayLabel })
      .from(staff)
      .where(inArray(staff.id, [t.createdBy, t.sentBy, t.receivedBy].filter((x): x is string => !!x).concat("00000000-0000-0000-0000-000000000000"))),
  ]);
  const from = await stockLevels([t.fromShopId], { productIds: lines.map((l) => l.l.productId) });
  const label = (sid: string | null) => people.find((p) => p.id === sid)?.label ?? null;
  return {
    t,
    from: shopRows.find((s) => s.id === t.fromShopId)!,
    to: shopRows.find((s) => s.id === t.toShopId)!,
    lines: lines.map(({ l, sku, brand, name }) => ({ ...l, sku, brand, name, atSource: from.find((s) => s.productId === l.productId) ?? null })),
    history,
    people: { createdBy: label(t.createdBy), sentBy: label(t.sentBy), receivedBy: label(t.receivedBy) },
  };
}
