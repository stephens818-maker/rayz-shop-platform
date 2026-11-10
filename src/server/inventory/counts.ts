import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, products, shopProducts, shops, staff, stockCountLines, stockCounts } from "@/db/schema";
import { countAdjustments } from "@/domain/inventory";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { Who, assertOwnRecord, assertShop, lockStock, postMovements } from "./ledger";

/**
 * Cycle counts (some products) and full stocktakes (everything the shop carries). Counting is
 * saved as it goes; posting moves on-hand to what was counted with one stocktake entry per
 * difference, measured against on-hand at that moment.
 */
export const StartCountInput = z.object({
  shopId: z.uuid(),
  kind: z.enum(["cycle", "full"]),
  /** Cycle counts: these products, or a whole category. */
  productIds: z.array(z.uuid()).optional(),
  category: z.string().optional(),
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((s) => (s ? s : null)),
});

export async function startCount(who: Who, raw: z.input<typeof StartCountInput>) {
  const v = StartCountInput.parse(raw);
  assertShop(who, v.shopId);
  return db.transaction(async (tx) => {
    const open = await tx
      .select({ id: stockCounts.id })
      .from(stockCounts)
      .where(and(eq(stockCounts.shopId, v.shopId), eq(stockCounts.status, "open"), eq(stockCounts.kind, "full")));
    if (v.kind === "full" && open.length) throw new AppError("conflict", "A full stocktake is already open at this shop");
    const carried = await tx
      .select({ productId: shopProducts.productId, stock: shopProducts.stock, active: shopProducts.active, category: products.category })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .where(eq(shopProducts.shopId, v.shopId));
    const pick =
      v.kind === "full"
        ? carried.filter((c) => c.active || c.stock !== 0)
        : carried.filter((c) => (v.productIds?.length ? v.productIds.includes(c.productId) : v.category ? c.category === v.category : false));
    if (!pick.length) throw new AppError("bad_request", v.kind === "full" ? "This shop doesn't carry anything to count" : "Pick the products or a category to count");
    const [c] = await tx.insert(stockCounts).values({ shopId: v.shopId, kind: v.kind, note: v.note, createdBy: who.actor.staffId ?? null }).returning();
    await tx.insert(stockCountLines).values(pick.map((p) => ({ countId: c.id, productId: p.productId, expectedAtStart: p.stock })));
    await audit(who.actor, "count.start", "count", c.id, { number: c.number, kind: v.kind, products: pick.length, category: v.category ?? null }, v.shopId, tx);
    return { id: c.id, number: c.number };
  });
}

export const CountLinesInput = z.array(z.object({ productId: z.uuid(), counted: z.number().int("Count whole units").min(0).max(100_000).nullable() }));

export async function saveCountLines(who: Who, id: string, raw: z.input<typeof CountLinesInput>) {
  const lines = CountLinesInput.parse(raw);
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
    if (!c) throw notFound("Count");
    assertOwnRecord(who, [c.shopId], "Count");
    if (c.status !== "open") throw new AppError("conflict", `This count is already ${c.status}`);
    for (const l of lines) {
      const r = await tx
        .update(stockCountLines)
        .set({ counted: l.counted })
        .where(and(eq(stockCountLines.countId, id), eq(stockCountLines.productId, l.productId)))
        .returning({ id: stockCountLines.id });
      if (!r.length) throw new AppError("bad_request", "That product isn't on this count");
    }
  });
}

export async function postCount(who: Who, id: string, o: { zeroUncounted?: boolean } = {}) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
    if (!c) throw notFound("Count");
    assertOwnRecord(who, [c.shopId], "Count");
    if (c.status !== "open") throw new AppError("conflict", `This count is already ${c.status}`);
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, id));
    const uncounted = lines.filter((l) => l.counted === null).length;
    if (c.kind === "full" && uncounted && !o.zeroUncounted) throw new AppError("conflict", `${uncounted} ${uncounted === 1 ? "product hasn't" : "products haven't"} been counted. Count them, or post with uncounted products as zero.`);
    if (c.kind === "cycle" && uncounted === lines.length) throw new AppError("bad_request", "Enter at least one count");
    const locked = await lockStock(
      tx,
      lines.map((l) => ({ shopId: c.shopId, productId: l.productId })),
    );
    const onHand = Object.fromEntries(lines.map((l) => [l.productId, locked.get(`${c.shopId}|${l.productId}`)?.stock ?? 0]));
    const adj = countAdjustments(c.kind, lines, onHand);
    for (const a of adj) {
      const cost = locked.get(`${c.shopId}|${a.productId}`)?.cost_cents ?? null;
      await tx
        .update(stockCountLines)
        .set({ counted: a.counted, onHandAtPost: a.onHand, variance: a.variance, unitCostCents: cost })
        .where(and(eq(stockCountLines.countId, id), eq(stockCountLines.productId, a.productId)));
    }
    await postMovements(
      tx,
      adj.map((a) => ({ shopId: c.shopId, productId: a.productId, delta: a.variance, kind: "stocktake" as const, countId: id })),
      { actor: who.actor, negative: "allow", audit: false },
    );
    const now = new Date();
    await tx.update(stockCounts).set({ status: "posted", postedAt: now, postedBy: who.actor.staffId ?? null }).where(eq(stockCounts.id, id));
    const varianceCents = adj.reduce((a, x) => a + x.variance * (locked.get(`${c.shopId}|${x.productId}`)?.cost_cents ?? 0), 0);
    await audit(
      who.actor,
      "count.post",
      "count",
      id,
      { number: c.number, kind: c.kind, counted: adj.length, changed: adj.filter((a) => a.variance).length, varianceUnits: adj.reduce((a, x) => a + x.variance, 0), varianceCents, lines: adj.filter((a) => a.variance) },
      c.shopId,
      tx,
    );
    return { counted: adj.length, changed: adj.filter((a) => a.variance).length, varianceCents };
  });
}

export async function cancelCount(who: Who, id: string) {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
    if (!c) throw notFound("Count");
    assertOwnRecord(who, [c.shopId], "Count");
    if (c.status !== "open") throw new AppError("conflict", `This count is already ${c.status}`);
    await tx.update(stockCounts).set({ status: "cancelled" }).where(eq(stockCounts.id, id));
    await audit(who.actor, "count.cancel", "count", id, { number: c.number }, c.shopId, tx);
  });
}

export async function listCounts(shopIds: string[]) {
  return (await db.execute(sql`
    select c.id, c.number, c.kind, c.status, c.shop_id "shopId", sh.name shop, c.note, c.created_at "createdAt", c.posted_at "postedAt",
      count(l.id)::int lines, count(l.counted)::int counted,
      coalesce(sum(abs(l.variance)), 0)::int "absVariance", coalesce(sum(l.variance * coalesce(l.unit_cost_cents, 0)), 0)::int "varianceCents",
      st.display_label "createdBy"
    from stock_counts c
    join shops sh on sh.id = c.shop_id
    left join stock_count_lines l on l.count_id = c.id
    left join staff st on st.id = c.created_by
    where c.shop_id in (${sql.join(shopIds.length ? shopIds.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})
    group by c.id, sh.name, st.display_label
    order by case c.status when 'open' then 0 else 1 end, c.number desc
    limit 200`)) as unknown as {
    id: string;
    number: number;
    kind: "cycle" | "full";
    status: "open" | "posted" | "cancelled";
    shopId: string;
    shop: string;
    note: string | null;
    createdAt: string;
    postedAt: string | null;
    lines: number;
    counted: number;
    absVariance: number;
    varianceCents: number;
    createdBy: string | null;
  }[];
}

export async function loadCount(id: string) {
  const [c] = await db.select({ c: stockCounts, shop: shops.name }).from(stockCounts).innerJoin(shops, eq(shops.id, stockCounts.shopId)).where(eq(stockCounts.id, id));
  if (!c) return null;
  const [lines, history, people] = await Promise.all([
    db
      .select({ l: stockCountLines, sku: products.sku, brand: products.brand, name: products.name, category: products.category, stock: shopProducts.stock, costCents: shopProducts.costCents })
      .from(stockCountLines)
      .innerJoin(products, eq(products.id, stockCountLines.productId))
      .leftJoin(shopProducts, and(eq(shopProducts.shopId, c.c.shopId), eq(shopProducts.productId, stockCountLines.productId)))
      .where(eq(stockCountLines.countId, id))
      .orderBy(asc(products.category), asc(products.brand), asc(products.name)),
    db
      .select({ at: auditLog.at, who: auditLog.actorLabel, action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entity, "count"), eq(auditLog.entityId, id)))
      .orderBy(desc(auditLog.at)),
    db
      .select({ id: staff.id, label: staff.displayLabel })
      .from(staff)
      .where(inArray(staff.id, [c.c.createdBy, c.c.postedBy].filter((x): x is string => !!x).concat("00000000-0000-0000-0000-000000000000"))),
  ]);
  const label = (sid: string | null) => people.find((p) => p.id === sid)?.label ?? null;
  return {
    count: c.c,
    shop: c.shop,
    lines: lines.map(({ l, ...p }) => ({ ...l, ...p, stock: p.stock ?? 0, costCents: p.costCents ?? 0 })),
    history,
    people: { createdBy: label(c.c.createdBy), postedBy: label(c.c.postedBy) },
  };
}
