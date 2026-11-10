import { sql } from "drizzle-orm";
import { DBorTx, Tx } from "@/db";
import { AdjustReason, LedgerKind, inventoryLedger } from "@/db/schema";
import { Actor, audit } from "../audit";
import { AppError } from "../errors";

/**
 * The only way stock changes. Each movement is an append-only ledger row; a database trigger moves
 * shop_products.stock by the same amount and records the balance after it, and direct writes to
 * stock are refused (drizzle/0012_inventory.sql). On-hand is therefore always the ledger's sum.
 */
export interface Movement {
  shopId: string;
  productId: string;
  delta: number;
  kind: LedgerKind;
  reason?: AdjustReason | null;
  note?: string | null;
  unitCostCents?: number | null;
  saleId?: string | null;
  purchaseOrderId?: string | null;
  receiptId?: string | null;
  transferId?: string | null;
  countId?: string | null;
}

/** Who is acting, for inventory and purchasing: permission checks happen in the actions, shop scope here. */
export interface Who {
  actor: Actor;
  name: string;
  shopIds: string[];
}

export const whoOf = (ctx: { actor: Actor; staff: { displayLabel: string }; shopIds: string[] }): Who => ({ actor: ctx.actor, name: ctx.staff.displayLabel, shopIds: ctx.shopIds });

export function assertShop(who: Pick<Who, "shopIds">, shopId: string) {
  if (!who.shopIds.includes(shopId)) throw new AppError("forbidden", "That shop is outside your access");
}

/** A record at another shop is reported as missing, the same as one that doesn't exist. */
export function assertOwnRecord(who: Pick<Who, "shopIds">, shopIds: string[], what: string) {
  if (!shopIds.some((s) => who.shopIds.includes(s))) throw new AppError("not_found", `${what} not found`);
}

export interface Posted {
  shopId: string;
  productId: string;
  kind: LedgerKind;
  delta: number;
  balanceAfter: number;
}

export interface PostOptions {
  actor: Actor;
  /**
   * "policy": a movement that takes on-hand below zero follows the shop's setting (refused, or
   * allowed with a warning). "allow": always allowed, for corrections that set stock to a count.
   */
  negative?: "policy" | "allow";
  /** Back-dated entries (seed data and imports). */
  at?: Date;
  /** One audit entry per shop; false when the caller audits the whole operation itself. */
  audit?: { action: string; entity: string; entityId: string | null; details?: Record<string, unknown> } | false;
}

interface Locked {
  shop_id: string;
  product_id: string;
  stock: number;
  cost_cents: number;
  product: string;
  shop: string;
  negative_stock: "block" | "warn";
}

const key = (shopId: string, productId: string) => `${shopId}|${productId}`;

/**
 * Lock the shop products in a fixed order, so two tickets or transfers touching the same products
 * wait for each other instead of deadlocking.
 */
export async function lockStock(tx: DBorTx, pairs: { shopId: string; productId: string }[]): Promise<Map<string, Locked>> {
  const uniq = [...new Map(pairs.map((p) => [key(p.shopId, p.productId), p])).values()];
  if (!uniq.length) return new Map();
  const rows = (await tx.execute(sql`
    select sp.shop_id, sp.product_id, sp.stock, sp.cost_cents, (p.brand || ' ' || p.name) product, sh.name shop, sh.negative_stock
    from shop_products sp join products p on p.id = sp.product_id join shops sh on sh.id = sp.shop_id
    where (sp.shop_id, sp.product_id) in (${sql.join(
      uniq.map((p) => sql`(${p.shopId}::uuid, ${p.productId}::uuid)`),
      sql`, `,
    )})
    order by sp.shop_id, sp.product_id
    for update of sp`)) as unknown as Locked[];
  return new Map(rows.map((r) => [key(r.shop_id, r.product_id), r]));
}

export async function postMovements(tx: Tx, moves: Movement[], o: PostOptions): Promise<{ posted: Posted[]; warnings: string[] }> {
  const list = moves.filter((m) => m.delta !== 0);
  if (!list.length) return { posted: [], warnings: [] };
  for (const m of list) if (!Number.isInteger(m.delta)) throw new AppError("bad_request", "Stock moves in whole units");
  const locked = await lockStock(tx, list);
  const warnings: string[] = [];
  const running = new Map<string, number>();
  for (const m of list) {
    const k = key(m.shopId, m.productId);
    const row = locked.get(k);
    if (!row) throw new AppError("bad_request", "That product isn't carried at this shop");
    const before = running.get(k) ?? row.stock;
    const after = before + m.delta;
    running.set(k, after);
    if (m.delta < 0 && after < 0 && o.negative !== "allow") {
      if (row.negative_stock === "block") {
        throw new AppError("conflict", `Not enough ${row.product} at ${row.shop}: ${Math.max(0, before)} on hand. Count it in Inventory if the shelf disagrees.`, {
          productId: m.productId,
          onHand: before,
        });
      }
      warnings.push(`${row.product} at ${row.shop} is now ${after} on hand. Count it when you can.`);
    }
  }
  const posted = await tx
    .insert(inventoryLedger)
    .values(
      list.map((m) => ({
        shopId: m.shopId,
        productId: m.productId,
        delta: m.delta,
        kind: m.kind,
        reason: m.reason ?? null,
        note: m.note ?? null,
        unitCostCents: m.unitCostCents ?? locked.get(key(m.shopId, m.productId))!.cost_cents,
        saleId: m.saleId ?? null,
        purchaseOrderId: m.purchaseOrderId ?? null,
        receiptId: m.receiptId ?? null,
        transferId: m.transferId ?? null,
        countId: m.countId ?? null,
        staffId: o.actor.staffId ?? null,
        ...(o.at ? { createdAt: o.at } : {}),
      })),
    )
    .returning({ shopId: inventoryLedger.shopId, productId: inventoryLedger.productId, kind: inventoryLedger.kind, delta: inventoryLedger.delta, balanceAfter: inventoryLedger.balanceAfter });

  if (o.audit !== false) {
    const byShop = new Map<string, Posted[]>();
    for (const p of posted) byShop.set(p.shopId, [...(byShop.get(p.shopId) ?? []), p]);
    for (const [shopId, rows] of byShop) {
      const first = list.find((m) => m.shopId === shopId)!;
      await audit(
        o.actor,
        o.audit?.action ?? `inventory.${first.kind}`,
        o.audit?.entity ?? "inventory",
        o.audit?.entityId ?? (rows.length === 1 ? rows[0].productId : null),
        {
          ...(o.audit?.details ?? {}),
          lines: rows.map((r, i) => ({ productId: r.productId, kind: r.kind, delta: r.delta, balanceAfter: r.balanceAfter, reason: list.filter((m) => m.shopId === shopId)[i]?.reason ?? undefined })),
          ...(warnings.length ? { warnings } : {}),
        },
        shopId,
        tx,
      );
    }
  }
  return { posted, warnings };
}

/** Moves stock to an exact number (a count or a bulk upload), whatever sold in the meantime. */
export async function setOnHand(tx: Tx, m: Omit<Movement, "delta"> & { to: number }, o: PostOptions) {
  const locked = await lockStock(tx, [m]);
  const row = locked.get(key(m.shopId, m.productId));
  if (!row) throw new AppError("bad_request", "That product isn't carried at this shop");
  const { to, ...rest } = m;
  const delta = to - row.stock;
  const r = await postMovements(tx, [{ ...rest, delta }], { ...o, negative: "allow" });
  return { from: row.stock, to, delta, posted: r.posted };
}
