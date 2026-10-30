import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { BANKING_STATUS_LABEL } from "@/domain/banking";
import { METHOD_LABEL, STATUS_LABEL, employeeFeeCents, receivedCents, shopCostCents } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { inTenant } from "@/server/tenant";
import { payoutAccountSummaries } from "@/server/tips/accounts";
import { batchDetail } from "@/server/tips/payouts";
import { BatchActions, PayoutActions } from "../client";
import { BATCH_KIND_LABEL, BATCH_STATUS_LABEL, BATCH_STATUS_TONE, PAYOUT_STATUS_TONE } from "../labels";

export const metadata: Metadata = { title: "Tip payout batch" };

const ENTRY_LABEL: Record<string, string> = { tip: "Tip", refund: "Refund", adjust: "Adjustment" };
const ENTRY_METHOD: Record<string, string> = { card: "Card", cash: "Cash", gift_card: "Gift card", adjust: "Manager" };

export default async function TipBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/tips/[id]");
  if (!(await inTenant(ctx, "tip_payout_batch", id))) notFound();
  const d = await batchDetail(id);
  if (!d) notFound();
  const { batch, payouts } = d;
  const shop = ctx.shops.find((s) => s.id === batch.shopId);
  const accounts = await payoutAccountSummaries(payouts.filter((p) => p.method === "stripe").map((p) => p.staffId));
  const live = payouts.filter((p) => p.status !== "cancelled");
  const sum = (f: (p: (typeof payouts)[number]) => number) => live.reduce((a, p) => a + f(p), 0);
  const toApprove = live.filter((p) => p.status === "pending" && p.netCents > 0);
  const waitsForSetup = (p: (typeof payouts)[number]) => p.status === "held" && p.holdKind === "stripe_setup";
  const setupWaiting = live.filter(waitsForSetup);
  const owedToPayroll = (p: (typeof payouts)[number]) => p.status === "held" && p.holdKind === "transfers_pending";
  const owed = live.filter(owedToPayroll);
  const opsFor = (p: (typeof payouts)[number]) => {
    const own = p.staffId === ctx.staff.id;
    if (waitsForSetup(p) || owedToPayroll(p)) return batch.status === "draft" && !own ? (["remove", "adjust"] as const) : (["remove"] as const);
    if (batch.status === "draft") {
      if (p.status === "pending") return own ? (["hold", "remove"] as const) : (["hold", "remove", "adjust"] as const);
      if (p.status === "held") return own ? (["release", "remove"] as const) : (["release", "remove", "adjust"] as const);
    }
    if (batch.status === "approved") {
      if (p.status === "approved" && p.method === "cash") return ["hold", "remove"] as const;
      if (p.status === "held") return ["release", "remove"] as const;
    }
    return [] as const;
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title={`${BATCH_KIND_LABEL[batch.kind]} tip payouts`}
        subtitle={`${shop?.name ?? ""} · tips through ${formatDate(batch.cutoffDate, "EEEE, MMM d")} · built ${formatDateTime(batch.createdAt)}`}
        actions={
          <>
            <Badge tone={BATCH_STATUS_TONE[batch.status]}>{BATCH_STATUS_LABEL[batch.status]}</Badge>
            <LinkButton variant="secondary" href="/admin/tips">
              All batches
            </LinkButton>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Tips" value={formatCents(sum((p) => p.grossCents))} hint="less refunds" />
        <Stat label="Adjustments" value={formatCents(sum((p) => p.adjustCents), { sign: true })} />
        <Stat label="To pay" value={formatCents(sum((p) => p.netCents))} hint={`${live.length} employee${live.length === 1 ? "" : "s"}`} />
      </div>
      {batch.status === "draft" && (
        <Card className="p-4">
          <p className="mb-3 text-sm text-zinc-600">
            Check each employee&rsquo;s tickets below, then approve. Stripe payouts go out at once; cash payouts wait at the cash drawer for the employee to take and acknowledge. Held payouts
            stay back until they&rsquo;re released.
          </p>
          <BatchActions batchId={batch.id} canApprove={toApprove.length > 0} total={formatCents(toApprove.reduce((a, p) => a + p.netCents, 0))} />
        </Card>
      )}
      {batch.status === "approved" && live.some((p) => p.method === "cash" && p.status === "approved") && (
        <Notice tone="blue">
          Cash payouts are waiting at the <Link className="underline" href="/admin/drawer">cash drawer</Link> for each employee to take and acknowledge.
        </Notice>
      )}
      {setupWaiting.length > 0 && (
        <Notice tone="amber">
          {setupWaiting.length === 1 ? `${setupWaiting[0].name}'s payout` : `${setupWaiting.length} payouts`} ({formatCents(setupWaiting.reduce((a, p) => a + p.netCents, 0))}) wait for Stripe payout
          setup. Their tips stay reserved; each goes out on its own once the person finishes{batch.status === "draft" ? " and this batch is approved" : ""}. See{" "}
          <Link className="underline" href="/admin/tips/onboarding">
            Payout onboarding
          </Link>{" "}
          to invite or remind them.
        </Notice>
      )}
      {owed.length > 0 && (
        <Notice tone="amber">
          {owed.length === 1 ? `${owed[0].name}'s payout` : `${owed.length} payouts`} ({formatCents(owed.reduce((a, p) => a + p.netCents, 0))}) can&rsquo;t go to Stripe yet: direct payouts
          aren&rsquo;t turned on. Their tips are owed and go on payroll at the period&rsquo;s cutoff, never twice. See{" "}
          <Link className="underline" href="/admin/tips/tracker">
            Payout tracker
          </Link>
          .
        </Notice>
      )}
      {batch.notes && <Notice tone="amber">{batch.notes}</Notice>}
      {payouts.map((p) => (
        <Card key={p.id} className={p.status === "cancelled" ? "opacity-60" : ""}>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {p.name}
                <Badge tone={PAYOUT_STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                <span className="text-xs font-normal text-zinc-500">
                  {METHOD_LABEL[p.method]}
                  {p.instant ? " · instant" : ""}
                  {p.method === "stripe" && accounts.get(p.staffId)?.last4 ? ` to ••${accounts.get(p.staffId)!.last4}` : ""}
                </span>
                {p.method === "stripe" && ["pending", "held", "approved"].includes(p.status) && (accounts.get(p.staffId)?.status ?? "not_set_up") !== "ready" && (
                  <Badge tone="amber">Stripe account: {BANKING_STATUS_LABEL[accounts.get(p.staffId)?.status ?? "not_set_up"]}</Badge>
                )}
              </span>
            }
            subtitle={
              <>
                {p.holdReason && <span className="block text-amber-700">{waitsForSetup(p) ? "Waiting for Stripe setup" : owedToPayroll(p) ? "Owed" : p.status === "held" ? "Held" : "Taken out"}: {p.holdReason}</span>}
                {p.failureMessage && <span className="block text-red-600">{p.failureMessage}</span>}
                {p.acknowledgedAt && (
                  <span className="block">
                    Taken from the drawer {formatDateTime(p.acknowledgedAt)}, {p.ackMethod === "pin" ? "confirmed with their PIN" : `signed "${p.ackName}"`}
                  </span>
                )}
                {p.stripeTransferId && (
                  <span className="block font-mono text-[11px]">
                    {p.stripeTransferId}
                    {p.stripePayoutId ? ` · ${p.stripePayoutId}` : ""}
                  </span>
                )}
              </>
            }
            action={
              <div className="text-right tabular">
                <div className="text-lg font-semibold">{formatCents(receivedCents(p))}</div>
                <div className="text-xs text-zinc-500">
                  {formatCents(p.grossCents)} tips
                  {p.feeCents ? ` − ${formatCents(p.feeCents)} card fee` : ""}
                  {p.adjustCents ? ` ${p.adjustCents < 0 ? "−" : "+"} ${formatCents(Math.abs(p.adjustCents))} adjusted` : ""}
                  {employeeFeeCents(p) ? ` − ${formatCents(p.instantFeeCents)} instant fee` : ""}
                  {p.instantFeeCents && p.instantFeePaidBy === "shop" ? ` · shop pays the ${formatCents(p.instantFeeCents)} instant fee (${formatCents(shopCostCents(p))} in all)` : ""}
                  {p.destinationLast4 ? ` · to ••${p.destinationLast4}` : ""}
                </div>
              </div>
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Ticket</Th>
                <Th>Kind</Th>
                <Th>Paid by</Th>
                <Th right>Tip</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {p.entries.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDate(e.businessDate, "EEE MMM d")}</Td>
                  <Td>
                    {e.saleId ? (
                      <Link className="hover:underline" href={`/admin/sales/${e.saleId}`}>
                        #{e.saleNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>{ENTRY_LABEL[e.kind] ?? e.kind}</Td>
                  <Td>{ENTRY_METHOD[e.method] ?? e.method}</Td>
                  <Td right className={e.amountCents < 0 ? "text-red-600" : ""}>
                    {formatCents(e.amountCents)}
                  </Td>
                  <Td className="whitespace-normal text-zinc-600">{e.reason}</Td>
                </tr>
              ))}
              {!p.entries.length && (
                <tr>
                  <Td className="text-zinc-500">Its tips went back for the next batch.</Td>
                </tr>
              )}
            </tbody>
          </Table>
          {opsFor(p).length > 0 && (
            <div className="border-t border-zinc-100 px-4 py-3">
              <PayoutActions payoutId={p.id} ops={[...opsFor(p)]} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
