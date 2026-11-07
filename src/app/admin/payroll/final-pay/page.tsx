import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { fmtHours, fmtMoney } from "@/domain/payroll/calc";
import { formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { finalPaysList, previewFinalPay } from "@/server/payroll/final-pay";
import { preparersOf, SELF_APPROVAL } from "@/server/payroll/run";
import { ApproveFinalPay } from "./client";

export const metadata: Metadata = { title: "Final pay" };

export default async function FinalPayPage({ searchParams }: { searchParams: Promise<{ staff?: string; last?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/payroll/final-pay");
  const people = await db.select({ id: staff.id, label: staff.displayLabel, active: staff.active }).from(staff).where(and(eq(staff.kind, "person"))).orderBy(staff.displayLabel);
  const picked = people.find((p) => p.id === sp.staff) ?? null;
  const preview = picked && sp.last ? await previewFinalPay(picked.id, sp.last) : null;
  const ok = preview && !("error" in preview) ? preview : null;
  const selfPrepared = ok && !ctx.isOwner && (await preparersOf(ok.start, ok.end)).some((p) => p.staffId === ctx.actor.staffId);
  const canApprove = can(ctx, "payroll.approve") && ctx.brandWide;
  const canFiles = can(ctx, "payroll.run") || can(ctx, "payroll.export");
  const history = await finalPaysList();

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Final pay"
        subtitle="Pay someone who's left off-cycle, by the next regular payday at the latest: their figures for the pay period of their last day, at every shop, approved on their own. Each shop gets a one-row iSolved file in the usual format, and the regular file for that period leaves them out."
      />
      <Card>
        <CardHeader title="Who's leaving" />
        <form className="flex flex-wrap items-end gap-3 px-4 pb-4 text-sm" method="get">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Employee</span>
            <select name="staff" defaultValue={picked?.id ?? ""} className="h-9 rounded-md border border-zinc-300 bg-white px-2">
              <option value="">Pick someone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Last day worked</span>
            <input type="date" name="last" defaultValue={sp.last ?? todayLocal()} max={todayLocal()} className="h-9 rounded-md border border-zinc-300 px-2" />
          </label>
          <button type="submit" className="h-9 rounded-md bg-ink-900 px-3 font-medium text-white">
            Work out final pay
          </button>
        </form>
      </Card>

      {preview && "error" in preview && <Notice tone="amber">{preview.error}</Notice>}
      {ok && (
        <Card>
          <CardHeader
            title={`${ok.name}: ${formatDate(ok.start, "MMM d")} – ${formatDate(ok.end, "MMM d, yyyy")}`}
            subtitle={`Last day ${formatDate(ok.lastDay, "EEE MMM d")}. Total wages ${fmtMoney(ok.totalWages)}, as the Payroll Report has them now.`}
            action={canApprove ? <ApproveFinalPay staffId={ok.staffId} lastDay={ok.lastDay} name={ok.name} blocked={selfPrepared ? SELF_APPROVAL : null} /> : undefined}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="final-pay-preview">
              <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Shop</th>
                  <th className="px-3 py-2 text-right">Hours</th>
                  <th className="px-3 py-2 text-right">O.T.</th>
                  <th className="px-3 py-2 text-right">PTO</th>
                  <th className="px-3 py-2 text-right">Service sales</th>
                  <th className="px-3 py-2 text-right">Product sales</th>
                  <th className="px-3 py-2 text-right">Tips</th>
                  <th className="px-3 py-2 text-right">Total wages</th>
                </tr>
              </thead>
              <tbody>
                {ok.shops.map((x) => (
                  <tr key={x.shopId} className="border-t border-zinc-100">
                    <td className="px-3 py-1.5">{x.shop}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtHours(x.line.hours)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtHours(x.line.otHours)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtHours(x.line.ptoHours)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(x.line.service)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(x.line.product)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(x.line.tips)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">{fmtMoney(x.line.totalWages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ok.anomalies.length > 0 && (
            <ul className="space-y-1 border-t border-zinc-100 px-4 py-3 text-sm text-amber-800">
              {ok.anomalies.map((a, i) => (
                <li key={i}>{a.message}</li>
              ))}
            </ul>
          )}
          <p className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500">
            Illinois requires earned vacation to be paid at separation; PTO here is what the time clock or a manager recorded. Anything that changes after approval is flagged on the regular Payroll Report to pay or recover in iSolved.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader title="Approved final pays" subtitle="Kept as approved. Each shop's file downloads as many times as needed; every download is logged." />
        {history.length ? (
          <ul className="divide-y divide-zinc-100 text-sm" data-testid="final-pay-history">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                <span className="font-medium">{h.name}</span>
                <span className="text-zinc-600">
                  {formatDate(h.periodStart, "MMM d")} – {formatDate(h.periodEnd, "MMM d")}, last day {formatDate(h.lastDay, "MMM d")}
                </span>
                <span className="text-zinc-500">
                  Approved {formatDateTime(h.approvedAt)}
                  {h.approvedBy ? ` by ${h.approvedBy}` : ""}
                  {h.note ? ` (${h.note})` : ""}
                </span>
                {canFiles &&
                  h.shops.map((x) => (
                    <a key={x.payGroupId} className="font-medium text-brand-700 hover:underline" href={`/admin/payroll/final-pay/file?${new URLSearchParams({ id: h.id, group: x.payGroupId })}`}>
                      {x.shop} file ({fmtMoney(x.totalWages)})
                    </a>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-zinc-500">No final pays yet.</p>
        )}
      </Card>
    </div>
  );
}
