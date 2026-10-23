import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { saleItems, sales, shops } from "@/db/schema";

/** Paid tickets for the signed-in customer, plus the most recent product. Staff notes are not included. */
export async function purchaseHistory(customerId: string, limit = 20) {
  const rows = await db
    .select({
      id: sales.id,
      paidAt: sales.paidAt,
      totalCents: sales.totalCents,
      shopName: shops.name,
      shopSlug: shops.slug,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .where(and(eq(sales.customerId, customerId), inArray(sales.status, ["paid", "partially_refunded", "refunded"])))
    .orderBy(desc(sales.paidAt))
    .limit(Math.min(50, Math.max(1, limit)));
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db
        .select({
          saleId: saleItems.saleId,
          name: saleItems.name,
          kind: saleItems.kind,
          qty: saleItems.qty,
          netCents: saleItems.netCents,
        })
        .from(saleItems)
        .where(inArray(saleItems.saleId, ids))
    : [];
  const purchases = rows.map((r) => ({
    id: r.id,
    paidAt: r.paidAt?.toISOString() ?? null,
    totalCents: r.totalCents,
    shop: { name: r.shopName, slug: r.shopSlug },
    items: items
      .filter((i) => i.saleId === r.id)
      .map((i) => ({ name: i.name, kind: i.kind, qty: i.qty, netCents: i.netCents })),
  }));
  const [last] = (await db.execute(sql`
    select si.name, s.paid_at
    from sale_items si
    join sales s on s.id = si.sale_id
    where s.customer_id = ${customerId}
      and s.status in ('paid', 'partially_refunded', 'refunded')
      and si.kind = 'product'
    order by s.paid_at desc nulls last
    limit 1
  `)) as unknown as { name: string; paid_at: string | null }[];
  return {
    purchases,
    lastProduct: last ? { name: last.name, purchasedAt: last.paid_at ? new Date(last.paid_at).toISOString() : null } : null,
  };
}
