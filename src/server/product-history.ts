import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { products, saleItems, sales, shopProducts, shops } from "@/db/schema";
import { REFILL_GAPS, REFILL_LEAD_DAYS, REFILL_MIN_SAMPLE, productHistory, type ProductBuy, type ProductHistory } from "@/domain/product-history";
import { todayLocal } from "@/lib/time";
import { type Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

/** Products a client bought (domain/product-history.ts): the history, refill intervals, and buying the same again. */

const PAID = sql.raw("('paid', 'partially_refunded', 'refunded')");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.filter((i) => UUID.test(i)).join(",")}}`}::uuid[]`;

/** Purchase days (`_b`: customer_id, product_id, d, qty) and their gaps per unit (`_g`: gap, rn newest first) under `cond` on sales `s` and lines `i`. */
function gapCtes(prefix: string, cond: SQL): SQL {
  const n = (suffix: string) => sql.raw(`${prefix}${suffix}`);
  return sql`${n("_b")} as (
      select s.customer_id, i.ref_id product_id, s.business_date d, sum(i.qty - i.refunded_qty)::int qty
      from sale_items i join sales s on s.id = i.sale_id
      where i.kind = 'product' and i.ref_id is not null and s.status in ${PAID} and s.customer_id is not null${cond}
      group by 1, 2, 3 having sum(i.qty - i.refunded_qty) > 0
    ), ${n("_g")} as (
      select b.customer_id, b.product_id, b.d, b.qty,
        (lead(b.d) over (partition by b.customer_id, b.product_id order by b.d) - b.d)::float8 / b.qty gap,
        row_number() over (partition by b.customer_id, b.product_id order by b.d desc) rn
      from ${n("_b")} b
    )`;
}

/**
 * The refill intervals as CTEs ending in `name`: one row per client and catalog product they paid
 * for (customer_id, product_id, times, last_day, last_qty, per_unit, source, supply, since_days, due,
 * status). `cond` narrows the client's purchases (a report's dates, locations and barbers); a
 * product's typical interval always reads every client's. Mirrors domain/product-history.ts.
 */
export function refillCtes(name: string, cond: SQL, now: Date): SQL {
  const n = (suffix = "") => sql.raw(`${name}${suffix}`);
  const today = sql`${todayLocal(now)}::date`;
  const recent = sql.raw(`g.gap is not null and g.rn <= ${REFILL_GAPS + 1}`);
  return sql`${gapCtes(`${name}_a`, sql``)}, ${gapCtes(name, cond)}, ${n("_t")} as (
      select g.product_id, (percentile_cont(0.5) within group (order by g.gap))::float8 typical
      from ${n("_a_g")} g where ${recent} group by g.product_id having count(*) >= ${REFILL_MIN_SAMPLE}
    ), ${n("_m")} as (
      select g.customer_id, g.product_id, count(*)::int times, max(g.d) last_day, (array_agg(g.qty order by g.d desc))[1] last_qty,
        (percentile_cont(0.5) within group (order by g.gap) filter (where ${recent}))::float8 own
      from ${n("_g")} g group by g.customer_id, g.product_id
    ), ${n("_s")} as (
      select m.customer_id, m.product_id, m.times, m.last_day, m.last_qty, coalesce(m.own, t.typical) per_unit,
        case when m.own is not null then 'client' when t.typical is not null then 'product' end source,
        coalesce(m.own, t.typical) * m.last_qty supply, (${today} - m.last_day) since_days
      from ${n("_m")} m left join ${n("_t")} t on t.product_id = m.product_id
    ), ${n()} as (
      select x.*, x.last_day + round(x.supply::numeric)::int due,
        case when x.supply is null then null
          when x.since_days < x.supply - ${REFILL_LEAD_DAYS} then 'stocked'
          when x.since_days <= x.supply + greatest(14, x.supply * 0.5) then 'running_out'
          else 'ran_out' end status
      from ${n("_s")} x
    )`;
}

/** Each product's typical days per unit across every client, for those that have one. */
export async function typicalIntervals(productIds: readonly string[], tx: DBorTx = db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!productIds.length) return out;
  const rows = (await tx.execute(
    sql`with ${gapCtes("ty", sql` and i.ref_id = any(${uuidArray(productIds)})`)}
      select g.product_id, (percentile_cont(0.5) within group (order by g.gap))::float8 typical from ty_g g
      where g.gap is not null and g.rn <= ${REFILL_GAPS + 1} group by g.product_id having count(*) >= ${REFILL_MIN_SAMPLE}`,
  )) as unknown as { product_id: string; typical: number }[];
  for (const r of rows) out.set(r.product_id, Number(r.typical));
  return out;
}

/** Every product line the client paid for (net of refunds), newest first. */
export async function productBuys(customerId: string, tx: DBorTx = db): Promise<ProductBuy[]> {
  const rows = await tx
    .select({
      saleId: sales.id,
      productId: saleItems.refId,
      name: saleItems.name,
      date: sales.businessDate,
      paidAt: sales.paidAt,
      createdAt: sales.createdAt,
      shopId: sales.shopId,
      shop: shops.name,
      qty: sql<number>`(${saleItems.qty} - ${saleItems.refundedQty})::int`,
    })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .where(and(eq(sales.customerId, customerId), sql`${sales.status} in ${PAID}`, eq(saleItems.kind, "product"), sql`${saleItems.qty} - ${saleItems.refundedQty} > 0`))
    .orderBy(desc(sales.businessDate), desc(sql`coalesce(${sales.paidAt}, ${sales.createdAt})`))
    .limit(2000);
  return rows.map((r) => ({ saleId: r.saleId, productId: r.productId, name: r.name, date: r.date, at: (r.paidAt ?? r.createdAt).toISOString(), shopId: r.shopId, shop: r.shop, qty: Number(r.qty) }));
}

/** The client's last product, recent purchases and refill intervals, from every location. */
export async function clientProductHistory(customerId: string, now: Date, tx: DBorTx = db): Promise<ProductHistory> {
  const buys = await productBuys(customerId, tx);
  const once = [...new Set(buys.filter((b) => b.productId).map((b) => b.productId!))].filter((id) => new Set(buys.filter((b) => b.productId === id).map((b) => b.date)).size < 2);
  return productHistory(buys, await typicalIntervals(once, tx), todayLocal(now));
}

/**
 * Buy again from the profile: the product, as many as last time, on the client's open ticket at
 * this shop today (one the person may check out), or on a new retail ticket for them.
 */
export async function buyAgain(
  input: { customerId: string; productId: string; qty: number },
  who: { shopId: string; staffId: string; anyTicket: boolean; actor: Actor },
  now = new Date(),
): Promise<{ saleId: string; created: boolean }> {
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 20) throw new AppError("bad_request", "1 to 20");
  const [carried] = await db
    .select({ name: products.name, brand: products.brand, shop: shops.name })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(and(eq(shopProducts.shopId, who.shopId), eq(shopProducts.productId, input.productId), eq(shopProducts.active, true), eq(products.active, true)));
  if (!carried) {
    const p = await db.query.products.findFirst({ where: eq(products.id, input.productId), columns: { name: true, brand: true } });
    if (!p) throw notFound("Product");
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, who.shopId), columns: { name: true } });
    throw new AppError("bad_request", `${p.brand} ${p.name} isn't stocked at ${shop?.name ?? "this shop"}`);
  }
  const open = await db
    .select({ id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.status, "open"),
        eq(sales.shopId, who.shopId),
        eq(sales.customerId, input.customerId),
        eq(sales.businessDate, todayLocal(now)),
        who.anyTicket ? undefined : eq(sales.staffId, who.staffId),
      ),
    )
    .orderBy(sql`${sales.appointmentId} is null`, desc(sales.createdAt))
    .limit(1);
  const { activeHandoffFor } = await import("./handoff");
  if (open[0] && (await activeHandoffFor(open[0].id))) throw new AppError("conflict", "Their ticket is with the client right now. Take the device back first.");
  let saleId = open[0]?.id;
  if (!saleId) {
    const { openBlankSale } = await import("./checkout");
    const sale = await openBlankSale(who.shopId, who.actor, who.anyTicket ? null : who.staffId);
    await db.update(sales).set({ customerId: input.customerId }).where(eq(sales.id, sale.id));
    saleId = sale.id;
  }
  const lines = await db.select({ productId: saleItems.refId, qty: saleItems.qty }).from(saleItems).where(and(eq(saleItems.saleId, saleId), eq(saleItems.kind, "product")));
  const held = lines.filter((l): l is { productId: string; qty: number } => !!l.productId);
  const { holdRetail } = await import("./inventory/stock");
  await holdRetail(saleId, [...held, { productId: input.productId, qty: input.qty }]);
  await audit(who.actor, "sale.buy_again", "sale", saleId, { customerId: input.customerId, productId: input.productId, product: `${carried.brand} ${carried.name}`, qty: input.qty }, who.shopId);
  return { saleId, created: !open[0] };
}
