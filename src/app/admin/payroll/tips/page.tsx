import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, cx } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { buildPayroll, periodChoices } from "@/server/payroll/run";
import type { TipCheckRow } from "@/server/payroll/tip-reconcile";
import { stripePayoutsOn } from "@/server/tips/payout-model";

export const metadata: Metadata = { title: "Payroll tip report" };

const usd = (c: number | null) => (c === null ? "—" : (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const METHOD: Record<string, string> = { stripe: "Stripe", cash: "Cash", payroll: "Payroll", prior: "Before tip payouts" };

export default async function PayrollTipsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  await guardPage("/admin/payroll/tips");
  const choices = await periodChoices();
  const current = choices.findIndex((c) => c.current);
  const chosen = choices.find((c) => c.key === sp.period) ?? choices[current + 1] ?? choices[0];
  const view = chosen ? await buildPayroll(chosen.start, chosen.end) : null;
  const rows = view?.tips.rows ?? [];
  const off = rows.filter((r) => r.problems.length);
  const sum = (f: (r: TipCheckRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const stripe = stripePayoutsOn();

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Payroll tip report"
        subtitle={chosen && `${formatDate(chosen.start, "MMM d")} – ${formatDate(chosen.end, "MMM d, yyyy")} · tips by employee, what was paid out, and what the iSolved file reports`}
        actions={
          view && (
            <a className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" href={`/admin/payroll/tips/download?start=${view.start}&end=${view.end}`}>
              Download CSV for payroll
            </a>
          )
        }
      />
      <div className="no-print mb-4 flex flex-wrap gap-1.5">
        {choices.slice(0, 8).map((c) => (
          <Link
            key={c.key}
            href={`/admin/payroll/tips?period=${c.key}`}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", c.key === chosen?.key ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.current && " · current"}
            {c.lockedGroups > 0 && (c.lockedGroups === c.groups.length ? " · locked" : ` · ${c.lockedGroups} locked`)}
          </Link>
        ))}
      </div>
      {!view ? (
        <Notice>No shop has a pay period with those dates.</Notice>
      ) : (
        <div className="space-y-4">
          <Notice tone="blue">
            Tips are W-2 wages however they&apos;re paid. Tips paid straight to an employee{stripe ? " (Stripe to their bank, or cash)" : " (cash)"} go to iSolved in E_Cash Tips Recd as tips already
            received, and the ones paid by the time the period is locked are marked in the tips-already-paid memo column, so payroll includes them in W-2 wages and withholds tax on them from
            regular pay without paying them again. Tips count in the pay period they were earned (the ticket&apos;s business day), even when they&apos;re paid out after it.
          </Notice>
          {off.length ? (
            <Notice tone="red">
              {off.length} employee{off.length === 1 ? "'s" : "s'"} tips don&apos;t match the iSolved file to the cent.{" "}
              {stripe ? "Approve and lock is blocked until they do." : "Fix them before uploading the file."} The Problems column says what differs; a typed-over TIPS value is the usual cause
              (change tips with a tip adjustment instead).
            </Notice>
          ) : rows.length ? (
            <Notice tone="green">Every employee&apos;s tips match the iSolved file to the cent.</Notice>
          ) : (
            <Notice>No tips in this pay period.</Notice>
          )}

          {rows.length > 0 && (
            <Card>
              <CardHeader title="By employee" subtitle="Per shop: each shop has its own iSolved file. Amounts are tips less refunds, plus tip adjustments dated in the period." />
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Shop</th>
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2 text-right">Tips earned</th>
                      <th className="px-3 py-2 text-right">In payroll</th>
                      <th className="px-3 py-2 text-right">Paid direct</th>
                      <th className="px-3 py-2 text-right">Paid out</th>
                      <th className="px-3 py-2 text-right">Sent, not paid</th>
                      <th className="px-3 py-2 text-right">Still owed</th>
                      <th className="bg-sky-50 px-3 py-2 text-right text-sky-800">iSolved tips received</th>
                      <th className="bg-sky-50 px-3 py-2 text-right text-sky-800">iSolved already paid (memo)</th>
                      <th className="bg-sky-50 px-3 py-2 text-right text-sky-800">iSolved tips in payroll</th>
                      <th className="px-3 py-2">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.shopId}-${r.staffId}`} className="border-t border-zinc-100 align-top">
                        <td className="px-3 py-1.5">{r.shop}</td>
                        <td className="px-3 py-1.5 font-medium">{r.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.earnedCents)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.inPayrollCents)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.directCents)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {usd(r.paidCents)}
                          {r.paidAtLockCents !== r.paidCents && <span className="block text-xs text-zinc-500">{usd(r.paidAtLockCents)} by the lock</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.inFlightCents)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.owedCents)}</td>
                        <td className="bg-sky-50/40 px-3 py-1.5 text-right tabular-nums">{usd(r.exportCashTipsCents)}</td>
                        <td className="bg-sky-50/40 px-3 py-1.5 text-right tabular-nums">{usd(r.exportPaidMemoCents)}</td>
                        <td className="bg-sky-50/40 px-3 py-1.5 text-right tabular-nums">{usd(r.exportPayrollTipsCents)}</td>
                        <td className="px-3 py-1.5 whitespace-normal">
                          {r.problems.length ? (
                            <>
                              <Badge tone="red">no</Badge>
                              <ul className="mt-1 max-w-sm text-xs text-red-800">
                                {r.problems.map((p) => (
                                  <li key={p}>{p}</li>
                                ))}
                              </ul>
                            </>
                          ) : (
                            <Badge tone="green">matches</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold">
                      <td className="px-3 py-1.5" colSpan={2}>
                        Total
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.earnedCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.inPayrollCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.directCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.paidCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.inFlightCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.owedCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.exportCashTipsCents ?? 0))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.exportPaidMemoCents))}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{usd(sum((r) => r.exportPayrollTipsCents))}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {rows.some((r) => r.payouts.length) && (
            <Card>
              <CardHeader
                title="Payouts"
                subtitle="Every payout with tips from this pay period: employee, shop, the tips from this period, and its Stripe ids. A payout with tips from two periods is listed in both, with each period's share."
              />
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">Shop</th>
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2">Method</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Gross tips</th>
                      <th className="px-3 py-2 text-right">Adjustments</th>
                      <th className="px-3 py-2 text-right">Card fee netted</th>
                      <th className="px-3 py-2 text-right">Instant fee</th>
                      <th className="px-3 py-2">Stripe ids</th>
                      <th className="px-3 py-2">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.flatMap((r) =>
                      r.payouts.map((p) => (
                        <tr key={p.id} className="border-t border-zinc-100">
                          <td className="px-3 py-1.5">{r.shop}</td>
                          <td className="px-3 py-1.5">{r.name}</td>
                          <td className="px-3 py-1.5">
                            {METHOD[p.method] ?? p.method}
                            {p.instant && " · instant"}
                            {p.split && <Badge className="ml-1">two periods</Badge>}
                          </td>
                          <td className="px-3 py-1.5">{p.status}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{usd(p.tipsCents)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.adjustCents ? usd(p.adjustCents) : ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.feeCents ? usd(p.feeCents) : ""}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{p.instantFeeCents ? `${usd(p.instantFeeCents)} (${p.instantFeePaidBy})` : ""}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{[p.stripeTransferId, p.stripePayoutId].filter(Boolean).join(" · ") || <span className="text-zinc-400">—</span>}</td>
                          <td className="px-3 py-1.5 text-xs">{p.paidAt ? formatDateTime(p.paidAt) : ""}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
