import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { connectTransfers, payments, refunds, saleItems, sales, shops, staff } from "@/db/schema";
import { renderReceiptText, receiptPdf, type ReceiptSale } from "./receipt";
import { portionsForRefunds, settlementFromLedger, type LedgerPayment, type LedgerTransfer } from "./settlement";

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Paid tickets for the signed-in customer. Service, product, tax, and tip stay separate. Refunds are their own records. */
export async function purchaseHistory(customerId: string, limit = 20) {
  const rows = await db
    .select({
      id: sales.id,
      number: sales.number,
      paidAt: sales.paidAt,
      shopName: shops.name,
      shopSlug: shops.slug,
      serviceCents: sales.serviceNetCents,
      productCents: sales.productNetCents,
      serviceTaxCents: sales.serviceTaxCents,
      productTaxCents: sales.productTaxCents,
      tipCents: sales.tipCents,
      totalCents: sales.totalCents,
      barberFirstName: staff.firstName,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(staff, eq(staff.id, sales.staffId))
    .where(and(eq(sales.customerId, customerId), inArray(sales.status, ["paid", "partially_refunded", "refunded"])))
    .orderBy(desc(sales.paidAt))
    .limit(Math.min(50, Math.max(1, limit)));
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db
        .select({ saleId: saleItems.saleId, name: saleItems.name, kind: saleItems.kind, qty: saleItems.qty, netCents: saleItems.netCents })
        .from(saleItems)
        .where(inArray(saleItems.saleId, ids))
    : [];
  const refundRows = ids.length
    ? await db
        .select({
          id: refunds.id,
          saleId: refunds.saleId,
          createdAt: refunds.createdAt,
          amountCents: refunds.amountCents,
          serviceCents: refunds.serviceNetCents,
          productCents: refunds.productNetCents,
          taxCents: refunds.taxCents,
          tipCents: refunds.tipCents,
          method: refunds.method,
        })
        .from(refunds)
        .where(inArray(refunds.saleId, ids))
        .orderBy(desc(refunds.createdAt))
    : [];
  const payRows = ids.length
    ? await db
        .select({
          saleId: payments.saleId,
          amountCents: payments.amountCents,
          tipCents: payments.tipCents,
          applicationFeeCents: payments.applicationFeeCents,
          stripeAccountId: payments.stripeAccountId,
          stripePaymentIntentId: payments.stripePaymentIntentId,
        })
        .from(payments)
        .where(inArray(payments.saleId, ids))
    : [];
  const intentIds = [...new Set(payRows.map((p) => p.stripePaymentIntentId).filter((id): id is string => !!id))];
  const transferRows = intentIds.length
    ? await db
        .select({
          paymentIntentId: connectTransfers.paymentIntentId,
          role: connectTransfers.role,
          amountCents: connectTransfers.amountCents,
          reversedCents: connectTransfers.reversedCents,
          status: connectTransfers.status,
          transferGroup: connectTransfers.transferGroup,
          note: connectTransfers.note,
        })
        .from(connectTransfers)
        .where(inArray(connectTransfers.paymentIntentId, intentIds))
    : [];
  const purchases = rows.map((r) => {
    const salePayments: LedgerPayment[] = payRows
      .filter((p) => p.saleId === r.id)
      .map((p) => ({
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        applicationFeeCents: p.applicationFeeCents,
        stripeAccountId: p.stripeAccountId,
        stripePaymentIntentId: p.stripePaymentIntentId,
      }));
    const intents = new Set(salePayments.map((p) => p.stripePaymentIntentId).filter((id): id is string => !!id));
    const saleTransfers: LedgerTransfer[] = transferRows
      .filter((t) => intents.has(t.paymentIntentId))
      .map((t) => ({
        paymentIntentId: t.paymentIntentId,
        role: t.role,
        amountCents: t.amountCents,
        reversedCents: t.reversedCents,
        status: t.status,
        transferGroup: t.transferGroup,
        note: t.note,
      }));
    const saleRefunds = refundRows.filter((f) => f.saleId === r.id);
    const portions = portionsForRefunds(
      saleRefunds.map((f) => ({ createdAt: f.createdAt, amountCents: f.amountCents, method: f.method })),
      saleTransfers,
      salePayments,
    );
    return {
      id: r.id,
      paidAt: iso(r.paidAt),
      serviceCents: r.serviceCents,
      productCents: r.productCents,
      taxCents: r.serviceTaxCents + r.productTaxCents,
      tipCents: r.tipCents,
      totalCents: r.totalCents,
      shop: { name: r.shopName, slug: r.shopSlug },
      barberFirstName: r.barberFirstName?.trim().split(/\s+/)[0] || null,
      settlement: settlementFromLedger(salePayments, saleTransfers),
      items: items.filter((i) => i.saleId === r.id).map((i) => ({ name: i.name, kind: i.kind, qty: i.qty, netCents: i.netCents })),
      refunds: saleRefunds.map((f, i) => ({
        id: f.id,
        createdAt: iso(f.createdAt),
        amountCents: f.amountCents,
        serviceCents: f.serviceCents,
        productCents: f.productCents,
        taxCents: f.taxCents,
        tipCents: f.tipCents,
        shopPortionCents: portions[i]?.shopPortionCents ?? null,
        tipPortionCents: portions[i]?.tipPortionCents ?? null,
        from: portions[i]?.from ?? null,
      })),
    };
  });
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
    lastProduct: last ? { name: last.name, purchasedAt: iso(last.paid_at) } : null,
  };
}

export async function receiptForCustomer(customerId: string, saleId: string) {
  const history = await purchaseHistory(customerId, 50);
  const sale = history.purchases.find((p) => p.id === saleId);
  if (!sale) return null;
  const [num] = await db.select({ number: sales.number }).from(sales).where(eq(sales.id, saleId));
  const payload: ReceiptSale = {
    id: sale.id,
    number: num?.number ?? null,
    paidAt: sale.paidAt,
    shopName: sale.shop.name,
    serviceCents: sale.serviceCents,
    productCents: sale.productCents,
    taxCents: sale.taxCents,
    tipCents: sale.tipCents,
    totalCents: sale.totalCents,
    barberFirstName: sale.barberFirstName,
    settlement: sale.settlement,
    refunds: sale.refunds.flatMap((r) => (r.createdAt ? [{ ...r, createdAt: r.createdAt }] : [])),
  };
  const text = await renderReceiptText(payload);
  return { sale: payload, text, pdf: receiptPdf(text) };
}
