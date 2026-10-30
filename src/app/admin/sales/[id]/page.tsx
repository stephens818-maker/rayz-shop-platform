import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { receiptBranding } from "@/domain/connect";
import { appointments, customers, payments, refunds, saleItems, sales, shops, staff, staffShops } from "@/db/schema";
import { Badge, Card, LinkButton, Notice, StarBadge } from "@/components/ui";
import { progressLabel } from "@/domain/loyalty";
import { formatCents, formatRate } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { feeLabel } from "@/domain/checkout";
import { personHeading } from "@/domain/receipts";
import { formatDateTime, localDateOf } from "@/lib/time";
import { can, guardPage, ratingViewer } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { refundableState } from "@/server/checkout";
import { splitCents } from "@/domain/handoff";
import { handoffOnSale } from "@/server/handoff";
import { inTenant } from "@/server/tenant";
import { lookups } from "@/server/lookups";
import { loyaltyBalance } from "@/server/loyalty";
import { ratingSummaries, visitForSale } from "@/server/ratings";
import { receiptData, saleReceiptState } from "@/server/receipts";
import { QuickRate } from "../../customers/ratings";
import { ReceiptPanel } from "./receipt-panel";
import { approvers, needsManager, ownLimit } from "@/server/manager-approval";
import { reassignments } from "@/server/reassign";
import { AssignDashboardRefund, PrintButton, ReassignPanel, SaleActions } from "./sale-actions";

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
  const policy = await clientPolicy(ctx);
  const receipt = receiptBranding(shop?.receipt);
  const payerIds = [...new Set(pays.map((p) => p.payerCustomerId).filter((x): x is string => !!x))];
  const [loyalty, rateable, ratingMap, screen, receiptState, printed, payerRows] = await Promise.all([
    customer ? loyaltyBalance(customer.id) : null,
    customer && policy.ratingDetail ? visitForSale(ratingViewer(ctx), id) : null,
    ratingSummaries([customer?.id]),
    handoffOnSale(id),
    saleReceiptState(id, policy),
    receiptData(id),
    payerIds.length ? db.select({ id: customers.id, first: customers.firstName, last: customers.lastName }).from(customers).where(inArray(customers.id, payerIds)) : [],
  ]);
  const people = printed.people;
  const personOf = new Map((people ?? []).flatMap((p) => p.lines.flatMap((l) => (l.id ? [[l.id, `${p.name}${l.barber ? ` · ${l.barber}` : ""}`] as [string, string]] : []))));
  const payerOf = (p: (typeof pays)[number]) => {
    const c = p.payerCustomerId ? payerRows.find((x) => x.id === p.payerCustomerId) : null;
    return c ? policy.name(c.first, c.last) : p.payerLabel;
  };
  const tipShares = screen.shares.length ? splitCents(sale.tipCents, screen.shares.map((x) => ({ id: x.staffId, weight: x.weight }))) : null;
  const splitName = new Map(screen.shares.map((x) => [x.staffId, x.label]));
  const pricing = (sale.pricing ?? {}) as { disclosures?: string[]; discounts?: { label: string; cents: number }[]; taxRates?: { serviceRate: number; productRate: number }; cardFee?: { rate: number } };
  const worksTickets = can(ctx, "sales.view") || can(ctx, "checkout.any");
  const manager = can(ctx, "sales.refund") || can(ctx, "sales.void") || worksTickets;
  const refundPin = needsManager(ctx, "sales.refund");
  const voidPin = needsManager(ctx, "sales.void");
  const refundLimit = refundPin ? 0 : ownLimit(ctx, sale.shopId, "sales.refund");
  const voidLimit = voidPin ? 0 : ownLimit(ctx, sale.shopId, "sales.void");
  const awaiting = refs.filter((r) => r.awaitingLines);
  const reversible = manager && (["paid", "partially_refunded"].includes(sale.status) || awaiting.length > 0);
  const reassignPin = needsManager(ctx, "sales.reassign");
  const mayReassign = !sale.isImported && ["paid", "partially_refunded", "refunded"].includes(sale.status) && (can(ctx, "sales.reassign") || worksTickets);
  const [refundable, refundApprovers, voidApprovers, reassignApprovers, shopBarbers, moves] = await Promise.all([
    reversible ? refundableState(id) : null,
    reversible && refundLimit !== null ? approvers(sale.shopId, "sales.refund", ctx.staff.id) : [],
    reversible && sale.status === "paid" && voidLimit !== null ? approvers(sale.shopId, "sales.void", ctx.staff.id) : [],
    mayReassign && reassignPin ? approvers(sale.shopId, "sales.reassign", ctx.staff.id) : [],
    mayReassign
      ? db
          .select({ id: staff.id, label: staff.displayLabel })
          .from(staffShops)
          .innerJoin(staff, eq(staff.id, staffShops.staffId))
          .where(and(eq(staffShops.shopId, sale.shopId), eq(staff.active, true), eq(staff.kind, "person"), eq(staff.isBookable, true)))
          .orderBy(asc(staff.displayLabel))
      : [],
    reassignments(id),
  ]);

  const refundItems = (refundable?.items ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    kind: i.kind,
    qty: i.qty,
    refundedQty: i.refundedQty,
    netCents: i.netCents,
    taxCents: i.taxCents,
    person: personOf.get(i.id) ?? null,
    giftCardBalances: i.giftCards.filter((g) => g.status === "active").map((g) => (g.reload ? Math.min(g.balanceCents, i.unitPriceCents) : g.balanceCents)).sort((a, b) => b - a),
  }));
  const mergedInto = sale.mergedIntoSaleId ? await db.query.sales.findFirst({ where: eq(sales.id, sale.mergedIntoSaleId), columns: { id: true, number: true } }) : null;
  return (
    <div className="mx-auto max-w-4xl">
      {mergedInto && (
        <div className="no-print mb-4">
          <Notice tone="blue">
            <span data-testid="merged-into">
              This ticket was combined into{" "}
              <Link className="font-semibold underline" href={`/admin/sales/${mergedInto.id}`}>
                ticket #{mergedInto.number}
              </Link>
              , with everyone and everything on it.
            </span>
          </Notice>
        </div>
      )}
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
            {ctx.staff.kind === "shop" && (
              <LinkButton href="/admin" size="lg" data-testid="next-client">
                Next client
              </LinkButton>
            )}
            <LinkButton href="/admin/calendar" variant={ctx.staff.kind === "shop" ? "secondary" : "primary"}>
              Back to calendar
            </LinkButton>
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
            {receipt.showLogo && shop?.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shop.logoUrl} alt="" className="mx-auto mb-2 h-12 w-12 object-contain" />
            )}
            <div className="text-lg font-semibold">{receipt.headline ?? <>Ray&apos;z Barber Shop · {shop?.name}</>}</div>
            {(receipt.showAddress || (receipt.showPhone && shop?.phone)) && (
              <div className="text-xs text-zinc-500">
                {[receipt.showAddress && shop && `${shop.address}, ${shop.city}, ${shop.state} ${shop.zip}`, receipt.showPhone && shop?.phone && (formatPhone(shop.phone) || shop.phone)].filter(Boolean).join(" · ")}
              </div>
            )}
            <div className="mt-2 text-xs text-zinc-500">
              Ticket #{sale.number} · {formatDateTime(sale.paidAt ?? sale.createdAt)}
              {barber && ` · Barber: ${barber.displayLabel}`}
            </div>
            {customer && <div className="text-xs text-zinc-500">Client: {policy.name(customer.firstName, customer.lastName)}</div>}
            <div className="mt-2">
              <Badge tone={sale.status === "paid" ? "green" : sale.status === "voided" ? "gray" : "red"}>{sale.status.replace("_", " ")}</Badge>
            </div>
          </div>
          <table className="mt-5 w-full text-sm tabular">
            <tbody>
              {(people ?? [{ name: null as string | null, barbers: [] as string[], cents: 0, lines: items.map((i) => ({ id: i.id })) }]).flatMap((p, k) => [
                ...(p.name
                  ? [
                      <tr key={`p${k}`} data-testid="sale-person">
                        <td colSpan={2} className={k ? "pt-3 font-semibold" : "font-semibold"}>
                          {personHeading({ name: p.name, barbers: p.barbers })}
                          <span className="float-right tabular">{formatCents(p.cents)}</span>
                        </td>
                      </tr>,
                    ]
                  : []),
                ...items.filter((i) => p.lines.some((l) => l.id === i.id)).map((i) => (
                <tr key={i.id}>
                  <td className="py-1">
                    {i.name}
                    {i.qty > 1 && <span className="text-zinc-500"> × {i.qty}</span>}
                    {i.staffId && i.staffId !== sale.staffId && splitName.has(i.staffId) && <span className="text-zinc-500"> · {splitName.get(i.staffId)}</span>}
                    {i.overrideReason && i.catalogPriceCents != null && (
                      <span className="block text-[11px] text-zinc-500">
                        Price changed from {formatCents(i.catalogPriceCents)}: {i.overrideReason}
                      </span>
                    )}
                    {i.refundedQty > 0 && <span className="block text-[11px] text-red-700">{i.refundedQty === i.qty ? "Refunded" : `${i.refundedQty} refunded`}</span>}
                  </td>
                  <td className="py-1 text-right">{formatCents(i.grossCents)}</td>
                </tr>
                )),
              ])}
              <tr>
                <td colSpan={2} className="pt-2" />
              </tr>
              {(pricing.discounts ?? []).map((d, k) => (
                <tr key={k} className="text-emerald-700">
                  <td>{d.label}</td>
                  <td className="text-right">-{formatCents(d.cents)}</td>
                </tr>
              ))}
              {printed.taxLines.map((t, i) => (
                <tr key={`${t.label}-${i}`}>
                  <td>
                    {t.label}
                    {t.rate > 0 ? ` (${formatRate(t.rate)})` : ""}
                  </td>
                  <td className="text-right">{formatCents(t.cents)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  Tip
                  {screen.screen?.tipSource && <span className="text-zinc-500"> ({screen.screen.tipSource === "reader" ? "on the reader" : "on the customer screen"})</span>}
                </td>
                <td className="text-right">{formatCents(sale.tipCents)}</td>
              </tr>
              {tipShares &&
                screen.shares.map((x) => (
                  <tr key={x.staffId} className="text-xs text-zinc-500" data-testid="tip-share">
                    <td className="pl-3">{x.label}</td>
                    <td className="text-right">{formatCents(tipShares.get(x.staffId) ?? 0)}</td>
                  </tr>
                ))}
              {sale.cardFeeCents > 0 && (
                <tr className="text-amber-800">
                  <td>{pricing.cardFee ? feeLabel(pricing.cardFee) : "Credit card fee"}</td>
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
                    {payerOf(p) && <span className="normal-case" data-testid="payer"> · paid by {payerOf(p)}</span>}
                  </td>
                  <td className="text-right">{formatCents(p.amountCents)}</td>
                </tr>
              ))}
              {moves.map(({ r, toLabel }) => (
                <tr key={r.id} className="text-xs text-zinc-500" data-testid="reassigned">
                  <td colSpan={2}>
                    Reassigned to {toLabel} {formatDateTime(r.createdAt)}: {r.reason}
                  </td>
                </tr>
              ))}
              {refs.map((r) => (
                <tr key={r.id} className="text-red-700">
                  <td>
                    {r.kind === "void" ? "Voided" : "Refund"} to {r.method.replace("_", " ")}
                    {r.source === "stripe_dashboard" ? " (Stripe dashboard)" : ""}: {r.reason}
                    {r.awaitingLines && (
                      <span className="block text-[11px] text-amber-700" data-testid="awaiting-lines">
                        Lines not assigned yet
                      </span>
                    )}
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
          {screen.screen?.signature && (
            <div className="mt-4 border-t border-dashed border-zinc-300 pt-3">
              <svg viewBox="0 0 600 200" className="mx-auto block h-16 w-48 text-zinc-900" role="img" aria-label="Client's signature">
                <path d={screen.screen.signature} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="text-center text-[11px] text-zinc-500">Signed on the customer screen{screen.screen.signedAt ? ` · ${formatDateTime(screen.screen.signedAt)}` : ""}</div>
            </div>
          )}
          {loyalty && loyalty.enabled && (
            <div className="mt-3 text-center text-xs text-zinc-500">
              Loyalty: {progressLabel(loyalty, formatCents)} toward your next {formatCents(loyalty.rewardCents)} reward
              {loyalty.availableCents > 0 && ` · ${formatCents(loyalty.availableCents)} in rewards ready`}
            </div>
          )}
          <div className="mt-4 text-center text-xs text-zinc-400">{receipt.footer ?? "Thank you! Book again at rayzbarbershop.com"}</div>
        </Card>
        <div className="no-print space-y-3">
          {receiptState.available && <ReceiptPanel saleId={sale.id} onFile={receiptState.onFile} atCheckout={receiptState.atCheckout} history={receiptState.history} highlight={!!sp.done} />}
          {receipt.allowPrint && <PrintButton />}
          {screen.screen && <div className="rounded-xl bg-white px-4 py-3 text-sm text-zinc-600 ring-1 ring-zinc-200">Paid on the customer screen.</div>}
          {customer && (
            <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3 text-sm ring-1 ring-zinc-200">
              <Link className="font-medium underline" href={`/admin/customers/${customer.id}`}>
                {policy.name(customer.firstName, customer.lastName)}
              </Link>
              <StarBadge rating={policy.stars(ratingMap.get(customer.id))} />
            </div>
          )}
          {customer && rateable && <QuickRate customerId={customer.id} firstName={customer.firstName} appointmentId={rateable.appointmentId} saleId={id} myRating={rateable.myRating} />}
          {mayReassign && <ReassignPanel saleId={sale.id} current={sale.staffId} barbers={shopBarbers} needsPin={reassignPin} approvers={reassignApprovers} />}
          {manager && refundable && awaiting[0] && (
            <AssignDashboardRefund
              saleId={sale.id}
              refundId={awaiting[0].id}
              amountCents={awaiting[0].amountCents}
              tipRemainingCents={refundable.tipRemainingCents}
              cardFeeRemainingCents={refundable.cardFeeRemainingCents}
              feeRefundRule={refundable.feeRefundRule}
              needsPin={refundPin}
              approvers={refundApprovers.map((a) => ({ id: a.id, label: a.label }))}
              items={refundItems}
            />
          )}
          {manager && refundable && !awaiting.length && (
            <SaleActions
              reasons={(await lookups(sale.shopId)).refundReasons}
              refundPin={refundPin}
              voidPin={voidPin}
              refundLimitCents={refundLimit}
              voidLimitCents={voidLimit}
              voidCents={sale.totalCents - refundable.refundedCents}
              approvers={[...new Map([...refundApprovers, ...voidApprovers].map((a) => [a.id, a])).values()].map((a) => ({
                ...a,
                refund: refundApprovers.some((r) => r.id === a.id),
                void: voidApprovers.some((v) => v.id === a.id),
              }))}
              saleId={sale.id}
              status={sale.status}
              imported={sale.isImported}
              tipRemainingCents={refundable.tipRemainingCents}
              cardFeeRemainingCents={refundable.cardFeeRemainingCents}
              feeRefundRule={refundable.feeRefundRule}
              items={refundItems}
            />
          )}
        </div>
      </div>
    </div>
  );
}
