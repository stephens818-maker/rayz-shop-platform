import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { connectTransfers, customerDependents, payments, refunds, saleItems, sales, shops } from "@/db/schema";
import { feeLabel } from "@/domain/checkout";
import { portionsForRefunds, settlementFromLedger } from "./settlement";

function storedFeeRate(pricing: unknown): number | null {
  if (!pricing || typeof pricing !== "object") return null;
  const row = pricing as { feeRate?: unknown; cardFee?: { rate?: unknown } };
  const rate = typeof row.feeRate === "number" ? row.feeRate : typeof row.cardFee?.rate === "number" ? row.cardFee.rate : null;
  return rate && rate > 0 ? rate : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function visibleCustomerIds(customerId: string) {
  const links = await db
    .select({ id: customerDependents.dependentId })
    .from(customerDependents)
    .where(eq(customerDependents.guardianId, customerId));
  return [customerId, ...links.map((row) => row.id)];
}

function tenderLabel(brand: string | null, last4: string | null) {
  if (!brand || !last4) return "card";
  const name = brand.charAt(0).toUpperCase() + brand.slice(1);
  return `${name} ••${last4}`;
}

export async function listReceipts(customerId: string, opts: { limit?: number; cursor?: string | null } = {}) {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const ids = await visibleCustomerIds(customerId);
  const cursorSale = opts.cursor
    ? await db.query.sales.findFirst({ where: eq(sales.id, opts.cursor), columns: { id: true, paidAt: true, customerId: true } })
    : null;
  const cursorOk = cursorSale && cursorSale.customerId && ids.includes(cursorSale.customerId) && cursorSale.paidAt;
  const rows = await db
    .select({
      id: sales.id,
      shopName: shops.name,
      paidAt: sales.paidAt,
      totalCents: sales.totalCents,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .where(
      and(
        inArray(sales.customerId, ids),
        inArray(sales.status, ["paid", "partially_refunded", "refunded"]),
        cursorOk ? or(lt(sales.paidAt, cursorSale!.paidAt!), and(eq(sales.paidAt, cursorSale!.paidAt!), lt(sales.id, cursorSale!.id))) : undefined,
      ),
    )
    .orderBy(desc(sales.paidAt), desc(sales.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const names = page.length
    ? await db
        .select({ saleId: saleItems.saleId, name: saleItems.name })
        .from(saleItems)
        .where(and(inArray(saleItems.saleId, page.map((row) => row.id)), eq(saleItems.kind, "service")))
    : [];
  const next = rows.length > limit ? page[page.length - 1] : null;
  return {
    receipts: page.map((row) => ({
      id: row.id,
      shopName: row.shopName,
      paidAt: iso(row.paidAt),
      totalCents: row.totalCents,
      serviceName: names.find((item) => item.saleId === row.id)?.name ?? null,
    })),
    limit,
    nextCursor: next ? next.id : null,
  };
}

/** Unknown ids, including a missing path segment, are null. Refunds stay their own records. */
export async function customerReceipt(customerId: string, saleId: string) {
  if (!saleId || saleId === "undefined") return null;
  const ids = await visibleCustomerIds(customerId);
  const [row] = await db
    .select({
      id: sales.id,
      shopName: shops.name,
      serviceCents: sales.serviceNetCents,
      serviceTaxCents: sales.serviceTaxCents,
      productTaxCents: sales.productTaxCents,
      tipCents: sales.tipCents,
      feeCents: sales.cardFeeCents,
      pricing: sales.pricing,
      cardFeeRate: shops.cardFeeRate,
      totalCents: sales.totalCents,
      paidAt: sales.paidAt,
      customerId: sales.customerId,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .where(and(eq(sales.id, saleId), inArray(sales.customerId, ids), inArray(sales.status, ["paid", "partially_refunded", "refunded"])));
  if (!row) return null;
  const [pay] = await db
    .select({
      brand: payments.cardBrand,
      last4: payments.cardLast4,
      amountCents: payments.amountCents,
      tipCents: payments.tipCents,
      applicationFeeCents: payments.applicationFeeCents,
      stripeAccountId: payments.stripeAccountId,
      stripePaymentIntentId: payments.stripePaymentIntentId,
    })
    .from(payments)
    .where(eq(payments.saleId, saleId));
  const [service] = await db
    .select({ name: saleItems.name })
    .from(saleItems)
    .where(and(eq(saleItems.saleId, saleId), eq(saleItems.kind, "service")))
    .limit(1);
  const refundRows = await db
    .select({
      id: refunds.id,
      createdAt: refunds.createdAt,
      amountCents: refunds.amountCents,
      serviceCents: refunds.serviceNetCents,
      productCents: refunds.productNetCents,
      taxCents: refunds.taxCents,
      tipCents: refunds.tipCents,
      feeCents: refunds.cardFeeCents,
      method: refunds.method,
    })
    .from(refunds)
    .where(eq(refunds.saleId, saleId))
    .orderBy(desc(refunds.createdAt));
  const transferRows = pay?.stripePaymentIntentId
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
        .where(eq(connectTransfers.paymentIntentId, pay.stripePaymentIntentId))
    : [];
  const portions = portionsForRefunds(
    refundRows.map((f) => ({ createdAt: f.createdAt, amountCents: f.amountCents, method: f.method })),
    transferRows,
    pay
      ? [
          {
            amountCents: pay.amountCents,
            tipCents: pay.tipCents,
            applicationFeeCents: pay.applicationFeeCents,
            stripeAccountId: pay.stripeAccountId,
            stripePaymentIntentId: pay.stripePaymentIntentId,
          },
        ]
      : [],
  );
  return {
    id: row.id,
    shopName: row.shopName,
    serviceName: service?.name ?? null,
    serviceCents: row.serviceCents,
    taxCents: row.serviceTaxCents + row.productTaxCents,
    tipCents: row.tipCents,
    feeCents: row.feeCents,
    feeLabel: row.feeCents > 0 ? feeLabel({ rate: storedFeeRate(row.pricing) ?? Number(row.cardFeeRate) }) : null,
    totalCents: row.totalCents,
    tender: tenderLabel(pay?.brand ?? null, pay?.last4 ?? null),
    paidAt: iso(row.paidAt),
    grossLabel: "Gross receipt",
    settlement: pay
      ? settlementFromLedger(
          [
            {
              amountCents: pay.amountCents,
              tipCents: pay.tipCents,
              applicationFeeCents: pay.applicationFeeCents,
              stripeAccountId: pay.stripeAccountId,
              stripePaymentIntentId: pay.stripePaymentIntentId,
            },
          ],
          transferRows,
        )
      : null,
    refunds: refundRows.map((f, i) => ({
      id: f.id,
      createdAt: iso(f.createdAt),
      amountCents: f.amountCents,
      serviceCents: f.serviceCents,
      productCents: f.productCents,
      taxCents: f.taxCents,
      tipCents: f.tipCents,
      feeCents: f.feeCents,
      shopPortionCents: portions[i]?.shopPortionCents ?? null,
      tipPortionCents: portions[i]?.tipPortionCents ?? null,
      from: portions[i]?.from ?? null,
    })),
  };
}
