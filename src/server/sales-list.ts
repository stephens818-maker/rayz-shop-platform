import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, payments, refunds, saleReassignments, sales, shops, staff } from "@/db/schema";

export const SALES_PAGE_SIZE = 100;

const day = (shopIds: string[], date: string) => and(inArray(sales.shopId, shopIds.length ? shopIds : [crypto.randomUUID()]), eq(sales.businessDate, date));
const closed = and(ne(sales.status, "open"), isNull(sales.mergedIntoSaleId));

/** A day's completed tickets and what they collected, counted in the database rather than from one page. */
export async function salesDayTotals(shopIds: string[], date: string) {
  const [r] = await db
    .select({
      tickets: sql<number>`count(*)::int`,
      paidCents: sql<number>`coalesce(sum(${sales.totalCents}) filter (where ${sales.status} <> 'voided'), 0)::int`,
    })
    .from(sales)
    .where(and(day(shopIds, date), closed));
  return r;
}

/**
 * One page of a day's completed tickets, newest first. The cursor is the last sale on the previous
 * page; rows are compared on (created_at, id) as stored, so ties and sub-millisecond times never
 * skip or repeat a ticket.
 */
export async function salesPage(o: { shopIds: string[]; date: string; before?: string | null; limit?: number }) {
  const limit = o.limit ?? SALES_PAGE_SIZE;
  const cursor = o.before
    ? sql`(${sales.createdAt}, ${sales.id}) < (select c.created_at, c.id from ${sales} c where c.id = ${o.before}::uuid)`
    : undefined;
  const rows = await db
    .select({
      id: sales.id,
      number: sales.number,
      status: sales.status,
      totalCents: sales.totalCents,
      tipCents: sales.tipCents,
      cardFeeCents: sales.cardFeeCents,
      paidAt: sales.paidAt,
      createdAt: sales.createdAt,
      shop: shops.name,
      barber: staff.displayLabel,
      firstName: customers.firstName,
      lastName: customers.lastName,
      methods: sql<string>`(select string_agg(distinct ${payments.method}::text, ' + ') from ${payments} where ${payments.saleId} = ${sales.id})`,
      reassigned: sql<boolean>`exists (select 1 from ${saleReassignments} where ${saleReassignments.saleId} = ${sales.id})`,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(staff, eq(staff.id, sales.staffId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(day(o.shopIds, o.date), closed, cursor))
    .orderBy(desc(sales.createdAt), desc(sales.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { rows: page, next: more ? page[page.length - 1].id : null };
}

/** Tickets still open on a day (past days only: today's are in the checkout queue). */
export async function openSales(shopIds: string[], date: string) {
  return db
    .select({ id: sales.id, number: sales.number, barber: staff.displayLabel, firstName: customers.firstName })
    .from(sales)
    .leftJoin(staff, eq(staff.id, sales.staffId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(day(shopIds, date), eq(sales.status, "open")))
    .orderBy(desc(sales.createdAt))
    .limit(200);
}

/** Tickets combined into another ticket that day. */
export async function combinedSales(shopIds: string[], date: string) {
  return db
    .select({
      id: sales.id,
      number: sales.number,
      mergedIntoSaleId: sales.mergedIntoSaleId,
      mergedIntoNumber: sql<number | null>`(select m.number from ${sales} m where m.id = ${sales.mergedIntoSaleId})`,
    })
    .from(sales)
    .where(and(day(shopIds, date), isNotNull(sales.mergedIntoSaleId)))
    .orderBy(desc(sales.createdAt))
    .limit(200);
}

/** Card refunds made in the Stripe dashboard that still need staff to say which lines went back. */
export async function refundsAwaitingLines(shopIds: string[]) {
  if (!shopIds.length) return [];
  return db
    .select({ id: refunds.id, saleId: refunds.saleId, number: sales.number, amountCents: refunds.amountCents, createdAt: refunds.createdAt, shop: shops.name })
    .from(refunds)
    .innerJoin(sales, eq(sales.id, refunds.saleId))
    .innerJoin(shops, eq(shops.id, refunds.shopId))
    .where(and(inArray(refunds.shopId, shopIds), eq(refunds.awaitingLines, true)))
    .orderBy(desc(refunds.createdAt))
    .limit(50);
}
