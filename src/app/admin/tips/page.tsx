import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { BANKING_STATUS_LABEL, BANKING_STATUS_TONE } from "@/domain/banking";
import { ENTRY_STATUS_LABEL, METHOD_LABEL, SCHEDULE_LABEL, effectiveMethod, entryStatus } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage, workingShopId } from "@/server/auth/staff";
import { tipOverrides } from "@/server/compensation";
import { shopPayoutAccounts } from "@/server/tips/accounts";
import { ledgerRows, shopTipConfig, syncTipLedger, tipPolicy } from "@/server/tips/ledger";
import { batchesFor } from "@/server/tips/payouts";
import { BuildBatch } from "./client";
import { BATCH_KIND_LABEL, BATCH_STATUS_LABEL, BATCH_STATUS_TONE } from "./labels";

export const metadata: Metadata = { title: "Tip payouts" };

export default async function TipsPage() {
  const ctx = await guardPage("/admin/tips");
  const shopId = workingShopId(ctx);
  if (!shopId) return <Empty title="No shop selected" />;
  const shop = ctx.shops.find((s) => s.id === shopId)!;
  const today = todayLocal();
  await syncTipLedger(db, { shopIds: [shopId] });
  const [settings, policy, unpaid, batches, accounts] = await Promise.all([shopTipConfig(shopId), tipPolicy(shopId), ledgerRows({ shopIds: [shopId], unpaidOnly: true }), batchesFor([shopId]), shopPayoutAccounts(shopId)]);
  const ids = [...new Set(unpaid.map((e) => e.staffId))];
  const planned = await tipOverrides(accounts.map((a) => a.staffId));
  const names = new Map((ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : []).map((s) => [s.id, s.label]));
  const byStaff = new Map<string, { available: number; pending: number; entries: number }>();
  for (const e of unpaid) {
    const v = byStaff.get(e.staffId) ?? { available: 0, pending: 0, entries: 0 };
    if (entryStatus(e, settings, today) === "pending_settlement") v.pending += e.amountCents;
    else v.available += e.amountCents;
    v.entries++;
    byStaff.set(e.staffId, v);
  }
  const rows = [...byStaff].map(([staffId, v]) => ({ staffId, name: names.get(staffId) ?? "Unknown", ...v })).sort((a, b) => a.name.localeCompare(b.name));
  const draft = batches.find((b) => b.b.status === "draft");
  const total = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const defaultCutoff = settings.schedule === "daily_delay" || settings.schedule === "weekly" ? addDays(today, -1) : today;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Tip payouts"
        subtitle={`${shop.name} · ${SCHEDULE_LABEL[settings.schedule]}${settings.cardDelayDays ? ` · card tips wait ${settings.cardDelayDays} day${settings.cardDelayDays === 1 ? "" : "s"} to settle` : ""}`}
        actions={
          <>
            {can(ctx, "report.tip_payouts.view") && (
              <LinkButton variant="secondary" href="/admin/reports/tip-payouts">
                Report
              </LinkButton>
            )}
            {can(ctx, "tips.settings") && (
              <LinkButton variant="secondary" href="/admin/tips/settings">
                Settings
              </LinkButton>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Available to pay" value={formatCents(total((r) => r.available))} hint="not in a batch yet" />
        <Stat label="Pending settlement" value={formatCents(total((r) => r.pending))} hint="card tips still settling" />
        <Stat label="Waiting for approval" value={formatCents(draft?.netCents ?? 0)} hint={draft ? `${draft.payouts} payouts in the draft batch` : "no draft batch"} />
      </div>
      <Card>
        <CardHeader
          title="Unpaid tips not in a batch"
          subtitle="Card tips become available once they've settled; cash and gift card tips at once. Refunds come off straight away."
          action={settings.schedule === "payroll" ? undefined : <BuildBatch shopId={shopId} defaultCutoff={defaultCutoff} today={today} hasDraft={!!draft} />}
        />
        {settings.schedule === "payroll" && (
          <p className="px-4 pt-3 text-sm text-zinc-600">This shop pays tips through payroll only. They go to iSolved with the pay period, and are marked paid when the period is approved and locked.</p>
        )}
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th right>{ENTRY_STATUS_LABEL.available}</Th>
                <Th right>{ENTRY_STATUS_LABEL.pending_settlement}</Th>
                <Th right>Entries</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staffId}>
                  <Td>{r.name}</Td>
                  <Td right className={r.available < 0 ? "text-red-600" : ""}>
                    {formatCents(r.available)}
                  </Td>
                  <Td right>{formatCents(r.pending)}</Td>
                  <Td right>{r.entries}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">Every tip is paid or in a batch.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Batches" subtitle="A manager reviews and approves every batch. Stripe payouts go out on approval; cash is paid from the drawer." />
        {batches.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Built</Th>
                <Th>Kind</Th>
                <Th>Tips through</Th>
                <Th>Status</Th>
                <Th right>Payouts</Th>
                <Th right>Total</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {batches.map(({ b, payouts, netCents, held, failed }) => (
                <tr key={b.id}>
                  <Td>
                    <Link className="font-medium hover:underline" href={`/admin/tips/${b.id}`}>
                      {formatDateTime(b.createdAt)}
                    </Link>
                  </Td>
                  <Td>{BATCH_KIND_LABEL[b.kind]}</Td>
                  <Td>{formatDate(b.cutoffDate, "EEE MMM d")}</Td>
                  <Td>
                    <Badge tone={BATCH_STATUS_TONE[b.status]}>{BATCH_STATUS_LABEL[b.status]}</Badge>
                  </Td>
                  <Td right>{payouts}</Td>
                  <Td right>{formatCents(netCents)}</Td>
                  <Td className="space-x-1">
                    {held > 0 && <Badge tone="amber">{held} held</Badge>}
                    {failed > 0 && <Badge tone="red">{failed} failed</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No batches yet.</p>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Payout accounts"
          subtitle="How each person is paid and whether Stripe can pay them. Bank and card details stay with Stripe: you see only the status and the last 4 digits."
          action={
            <LinkButton size="sm" variant="secondary" href="/admin/tips/onboarding">
              Payout onboarding
            </LinkButton>
          }
        />
        {accounts.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Paid by</Th>
                <Th>Stripe account</Th>
                <Th>Paid to</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const plan = planned.get(a.staffId);
                const method = effectiveMethod(settings, policy, a.method, plan?.method);
                return (
                  <tr key={a.staffId}>
                    <Td>{a.name}</Td>
                    <Td>
                      {METHOD_LABEL[method]}
                      {settings.schedule !== "payroll" && plan?.method && policy.methods.includes(plan.method) ? (
                        <span className="ml-1 text-xs text-zinc-500">(their pay plan)</span>
                      ) : a.method && policy.employeeChooses ? (
                        <span className="ml-1 text-xs text-zinc-500">(their choice)</span>
                      ) : null}
                      {plan?.netCardFee != null && plan.netCardFee !== settings.netCardFee ? (
                        <span className="ml-1 text-xs text-zinc-500">{plan.netCardFee ? "· card fee taken out" : "· card fee not taken out"}</span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={method === "stripe" && a.status !== "ready" ? "amber" : BANKING_STATUS_TONE[a.status]}>{BANKING_STATUS_LABEL[a.status]}</Badge>
                    </Td>
                    <Td className="tabular">{a.last4 ? `••${a.last4}` : "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No one on this shop&rsquo;s team yet.</p>
        )}
      </Card>
    </div>
  );
}
