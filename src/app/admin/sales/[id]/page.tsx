import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, payments, refunds, saleItems, sales, shops, staff } from "@/db/schema";
import { Badge, Card, LinkButton, Notice, StarBadge } from "@/components/ui";
import { formatCents, formatRate } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { feeLabel } from "@/domain/checkout";
import { formatDateTime, localDateOf } from "@/lib/time";
import { can, guardPage, ratingViewer } from "@/server/auth/staff";
import { refundableState } from "@/server/checkout";
import { inTenant } from "@/server/tenant";
import { loyaltyBalance } from "@/server/loyalty";
import { ratingSummaries, visitForSale } from "@/server/ratings";
import { QuickRate } from "../../customers/ratings";
import { PrintButton, SaleActions } from "./sale-actions";

export const metadata: Metadata = { title: "Receipt" };

export default async function SalePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; rebook?: string; rebookError?: string; rewards?: string; stock?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await guardPage("/admin/sales/[id]");
  if (!(await inTenant(ctx, "sale", id))) notFound();
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, id) });
  if (!sale) notFound();
  if (sale.staffId !== ctx.staff.id && !can(ctx, "sales.view") && !can(ctx, "checkout.any")) redirect("/admin?denied=1");
  if (sale.status === "open") redirect(`/admin/checkout/${id}`);
  const [shop, items, pays, refs, barber, customer, rebooked] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, sale.shopId) }),
    db.select().from(saleItems).where(eq(saleItems.saleId, id)).orderBy(asc(saleItems.kind)),
    db.select().from(payments).where(eq(payments.saleId, id)).orderBy(asc(payments.createdAt)),
    db.select().from(refunds).where(eq(refunds.saleId, id)).orderBy(asc(refunds.createdAt)),
    sale.staffId ? db.query.staff.findFirst({ where: eq(staff.id, sale.staffId) }) : null,
    sale.customerId ? db.query.customers.findFirst({ where: eq(customers.id, sale.customerId) }) : null,
    sp.rebook ? db.query.appointments.findFirst({ where: eq(appointments.code, sp.rebook) }) : null,
  ]);
  const [loyalty, rateable, ratingMap] = await Promise.all([
    customer ? loyaltyBalance(customer.id) : null,
    customer ? visitForSale(ratingViewer(ctx), id) : null,
    ratingSummaries([customer?.id]),
  ]);
  const pricing = (sale.pricing ?? {}) as { disclosures?: string[]; discounts?: { label: string; cents: number }[]; taxRates?: { serviceRate: number; productRate: number }; cardFee?: { rate: number } };
  const manager = can(ctx, "sales.refund");
  const refundable = manager && ["paid", "partially_refunded"].includes(sale.status) ? await refundableState(id) : null;

  return (
    <div className="mx-auto max-w-4xl">
      {sp.done && (
        <div className="no-print mb-4 space-y-2">
          <Notice tone="green">
            Paid {formatCents(sale.totalCents)}
            {sale.tipCents > 0 && ` including a ${formatCents(sale.tipCents)} tip`}.
            {sp.rewards && ` ${customer?.firstName} earned ${sp.rewards} loyalty reward${sp.rewards === "1" ? "" : "s"}!`}
          </Notice>
          {rebooked && (
            <Notice tone="blue">
              Rebooked {formatDateTime(rebooked.startsAt)} with {barber?.displayLabel}.{" "}
              <Link className="underline" href={`/admin/calendar?date=${localDateOf(rebooked.startsAt)}&appt=${rebooked.id}`}>
                View
              </Link>
            </Notice>
          )}
          {sp.rebookError && <Notice tone="amber">Couldn&apos;t rebook: {sp.rebookError}</Notice>}
          {sp.stock && <Notice tone="amber">{sp.stock}</Notice>}
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/admin/calendar">Back to calendar</LinkButton>
            {can(ctx, "walkins.manage") && (
              <LinkButton href="/admin/walk-ins" variant="secondary">
                Next walk-in
              </LinkButton>
            )}
          </div>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-[1fr_300px]">
        <Card className="p-6">
          <div className="text-center">
            <div className="text-lg font-semibold">Ray&apos;z Barber Shop · {shop?.name}</div>
            <div className="text-xs text-zinc-500">
              {shop?.address}, {shop?.city}, {shop?.state} {shop?.zip} · {formatPhone(shop?.phone) || shop?.phone}
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              Ticket #{sale.number} · {formatDateTime(sale.paidAt ?? sale.createdAt)}
              {barber && ` · Barber: ${barber.displayLabel}`}
            </div>
            {customer && <div className="text-xs text-zinc-500">Client: {customer.firstName} {customer.lastName}</div>}
            <div className="mt-2">
              <Badge tone={sale.status === "paid" ? "green" : sale.status === "voided" ? "gray" : "red"}>{sale.status.replace("_", " ")}</Badge>
            </div>
          </div>
          <table className="mt-5 w-full text-sm tabular">
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="py-1">
                    {i.name}
                    {i.qty > 1 && <span className="text-zinc-500"> × {i.qty}</span>}
                    {i.overrideReason && i.catalogPriceCents != null && (
                      <span className="block text-[11px] text-zinc-500">
                        Price changed from {formatCents(i.catalogPriceCents)}: {i.overrideReason}
                      </span>
                    )}
                    {i.refundedQty > 0 && <span className="block text-[11px] text-red-700">{i.refundedQty === i.qty ? "Refunded" : `${i.refundedQty} refunded`}</span>}
                  </td>
                  <td className="py-1 text-right">{formatCents(i.grossCents)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="pt-2" />
              </tr>
              {(pricing.discounts ?? []).map((d, k) => (
                <tr key={k} className="text-emerald-700">
                  <td>{d.label}</td>
                  <td className="text-right">-{formatCents(d.cents)}</td>
                </tr>
              ))}
              {sale.serviceTaxCents > 0 || pricing.taxRates?.serviceRate ? (
                <tr>
                  <td>Service tax{pricing.taxRates ? ` (${formatRate(pricing.taxRates.serviceRate)})` : ""}</td>
                  <td className="text-right">{formatCents(sale.serviceTaxCents)}</td>
                </tr>
              ) : null}
              {sale.productNetCents > 0 && (
                <tr>
                  <td>Product tax{pricing.taxRates ? ` (${formatRate(pricing.taxRates.productRate)})` : ""}</td>
                  <td className="text-right">{formatCents(sale.productTaxCents)}</td>
                </tr>
              )}
              <tr>
                <td>Tip</td>
                <td className="text-right">{formatCents(sale.tipCents)}</td>
              </tr>
              {sale.cardFeeCents > 0 && (
                <tr className="text-amber-800">
                  <td>{pricing.cardFee ? feeLabel(pricing.cardFee) : "Credit card surcharge"}</td>
                  <td className="text-right">{formatCents(sale.cardFeeCents)}</td>
                </tr>
              )}
              <tr className="border-t border-zinc-200 text-base font-semibold">
                <td className="pt-2">Total</td>
                <td className="pt-2 text-right">{formatCents(sale.totalCents)}</td>
              </tr>
              {pays.map((p) => (
                <tr key={p.id} className="text-zinc-600">
                  <td className="capitalize">
                    {p.method === "card" ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4 ?? ""} (${p.cardFunding ?? "card"}, ${p.entryMode === "terminal" ? "reader" : "keyed"})` : p.method.replace("_", " ")}
                    {p.method === "cash" && p.cashTenderedCents != null && p.cashTenderedCents > p.amountCents && ` · tendered ${formatCents(p.cashTenderedCents)}, change ${formatCents(p.cashTenderedCents - p.amountCents)}`}
                  </td>
                  <td className="text-right">{formatCents(p.amountCents)}</td>
                </tr>
              ))}
              {refs.map((r) => (
                <tr key={r.id} className="text-red-700">
                  <td>
                    {r.kind === "void" ? "Voided" : "Refund"} to {r.method.replace("_", " ")}
                    {r.source === "stripe_dashboard" ? " (Stripe dashboard)" : ""}: {r.reason}
                  </td>
                  <td className="text-right">-{formatCents(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(pricing.disclosures ?? []).length > 0 && (
            <div className="mt-4 space-y-1 border-t border-dashed border-zinc-300 pt-3 text-[11px] text-zinc-500">
              {pricing.disclosures!.map((d, k) => (
                <p key={k}>{d}</p>
              ))}
            </div>
          )}
          {loyalty && loyalty.enabled && (
            <div className="mt-3 text-center text-xs text-zinc-500">
              Loyalty: {formatCents(loyalty.progressCents)} of {formatCents(loyalty.thresholdCents)} toward your next {formatCents(loyalty.rewardCents)} reward
              {loyalty.availableCents > 0 && ` · ${formatCents(loyalty.availableCents)} in rewards ready`}
            </div>
          )}
          <div className="mt-4 text-center text-xs text-zinc-400">Thank you! Book again at rayzbarbershop.com</div>
        </Card>
        <div className="no-print space-y-3">
          <PrintButton />
          {customer && (
            <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-zinc-200">
              <Link className="font-medium underline" href={`/admin/customers/${customer.id}`}>
                {customer.firstName} {customer.lastName}
              </Link>
              <StarBadge rating={ratingMap.get(customer.id)} />
            </div>
          )}
          {customer && rateable && <QuickRate customerId={customer.id} firstName={customer.firstName} appointmentId={rateable.appointmentId} saleId={id} myRating={rateable.myRating} />}
          {manager && refundable && (
            <SaleActions
              saleId={sale.id}
              status={sale.status}
              imported={sale.isImported}
              tipRemainingCents={refundable.tipRemainingCents}
              cardFeeRemainingCents={refundable.cardFeeRemainingCents}
              items={refundable.items.map((i) => ({
                id: i.id,
                name: i.name,
                kind: i.kind,
                qty: i.qty,
                refundedQty: i.refundedQty,
                netCents: i.netCents,
                taxCents: i.taxCents,
                giftCardBalances: i.giftCards.filter((g) => g.status === "active").map((g) => g.balanceCents).sort((a, b) => b - a),
              }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
