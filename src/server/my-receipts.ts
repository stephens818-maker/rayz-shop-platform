import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, payments, refunds, sales, shops } from "@/db/schema";
import { notFound } from "./errors";
import { latestReceipts, receiptData } from "./receipts";

const PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account holder and the children on their account: whose tickets they see. */
async function household(customerId: string) {
  const kids = await db.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, customerId));
  return [customerId, ...kids.map((k) => k.id)];
}

const mine = (ids: string[]) =>
  or(
    inArray(sales.customerId, ids),
    sql`exists (select 1 from ${payments} p where p.sale_id = ${sales.id} and p.payer_customer_id in (${sql.join(
      ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    )}))`,
  );

/** The client's paid tickets, newest first: theirs, their children's, and ones they paid for. Squire imports have no digital receipt. */
export async function myReceipts(customerId: string, opts: { before?: Date; limit?: number } = {}) {
  const ids = await household(customerId);
  const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 50);
  const rows = await db
    .select({
      id: sales.id,
      number: sales.number,
      status: sales.status,
      paidAt: sales.paidAt,
      totalCents: sales.totalCents,
      shopId: shops.id,
      shopName: shops.name,
      firstName: customers.firstName,
      refundedCents: sql<number>`coalesce((select sum(${refunds.amountCents}) from ${refunds} where ${refunds.saleId} = ${sales.id}), 0)::int`,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(mine(ids), ne(sales.status, "open"), eq(sales.isImported, false), sql`${sales.paidAt} is not null`, opts.before ? lt(sales.paidAt, opts.before) : undefined))
    .orderBy(desc(sales.paidAt), desc(sales.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const sent = await latestReceipts(page.map((r) => r.id));
  return {
    receipts: page.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      paidAt: r.paidAt!.toISOString(),
      totalCents: r.totalCents,
      refundedCents: r.refundedCents,
      shop: { id: r.shopId, name: r.shopName },
      forFirstName: r.firstName,
      deliveredBy: (sent.get(r.id)?.channel ?? null) as "sms" | "email" | "app" | "none" | null,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1].paidAt!.toISOString() : null,
  };
}

/** One receipt as the digital receipt shows it: no card numbers beyond the last four, no contact details. */
export async function myReceipt(customerId: string, saleId: string) {
  if (!UUID.test(saleId)) throw notFound("Receipt");
  const ids = await household(customerId);
  const [hit] = await db
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.id, saleId), mine(ids), ne(sales.status, "open"), eq(sales.isImported, false)));
  if (!hit) throw notFound("Receipt");
  const d = await receiptData(saleId);
  return {
    id: d.sale.id,
    number: d.sale.number,
    status: d.sale.status,
    paidAt: (d.sale.paidAt ?? d.sale.createdAt).toISOString(),
    voidedAt: d.sale.voidedAt?.toISOString() ?? null,
    shop: { name: d.shop.name, title: d.shop.title, address: d.shop.address, phone: d.shop.phone, logoUrl: d.shop.logoUrl, footer: d.shop.footer },
    forFirstName: d.firstName,
    barber: d.barber,
    lines: d.lines.map((l) => ({ name: l.name, kind: l.kind, qty: l.qty, cents: l.cents, refundedQty: l.refundedQty })),
    people: d.people?.map((p) => ({ name: p.name, barbers: p.barbers, cents: p.cents })) ?? null,
    discounts: d.discounts,
    subtotalCents: d.subtotalCents,
    taxCents: d.taxCents,
    tipCents: d.tipCents,
    fee: d.fee,
    totalCents: d.totalCents,
    tenders: d.tenders,
    refunds: d.refunds.map((r) => ({ label: r.label, cents: r.cents, at: r.at.toISOString() })),
    refundedCents: d.refundedCents,
    disclosures: d.disclosures,
    loyalty: d.loyalty?.text ?? null,
    rebookPath: d.rebookUrl,
  };
}
