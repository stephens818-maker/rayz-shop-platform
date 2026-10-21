import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { payPeriodByIndex, payPeriodFor } from "@/domain/payroll";
import { formatCents } from "@/lib/money";
import { formatDate, todayLocal } from "@/lib/time";
import { can, guardPage, reportShopIds } from "@/server/auth/staff";
import { ReportTabs } from "../reports/report-view";
import { payrollTips } from "@/server/reports";

export const metadata: Metadata = { title: "Payroll tips" };

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ p?: string; shop?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/payroll");
  const current = payPeriodFor(todayLocal());
  const index = sp.p !== undefined && /^-?\d+$/.test(sp.p) ? Number(sp.p) : current.index - 1;
  const period = payPeriodByIndex(index);
  const shopIds = reportShopIds(ctx, sp.shop ?? null);
  const t0 = performance.now();
  const { rows } = await payrollTips({ shopIds, from: period.start, to: period.end });
  const ms = Math.round(performance.now() - t0);
  const choices = Array.from({ length: 6 }, (_, i) => payPeriodByIndex(current.index - i));
  const totals = rows.reduce(
    (a, r) => ({ tickets: a.tickets + r.tickets, svc: a.svc + r.serviceSalesCents, card: a.card + r.cardTipsCents, cash: a.cash + r.cashTipsCents, gc: a.gc + r.giftCardTipsCents, ref: a.ref + r.tipRefundsCents, tips: a.tips + r.totalTipsCents }),
    { tickets: 0, svc: 0, card: 0, cash: 0, gc: 0, ref: 0, tips: 0 },
  );
  const multiShop = new Set(rows.map((r) => r.staffId)).size < rows.length;
  const q = new URLSearchParams({ type: "tips_payroll", from: period.start, to: period.end });
  if (sp.shop) q.set("shop", sp.shop);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Payroll: tips by pay period"
        subtitle={
          <>
            Bi-weekly, Sunday to Saturday. {formatDate(period.start, "MMM d")} – {formatDate(period.end, "MMM d, yyyy")}
            {period.index === current.index && " (in progress)"}
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          can(ctx, "report.tips_payroll.export") ? (
            <a className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700" href={`/admin/reports/export?${q}`}>
              Export tips CSV
            </a>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active="tips_payroll" />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {choices.map((c) => (
          <Link
            key={c.index}
            href={`/admin/payroll?p=${c.index}${sp.shop ? `&shop=${sp.shop}` : ""}`}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", c.index === period.index ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.index === current.index && " · current"}
          </Link>
        ))}
      </div>
      <div className="mb-4">
        <Notice tone="blue">Hours stay in the HR system, so there&apos;s no clock-in here. This export covers tips and sales per barber per shop for the period.</Notice>
      </div>
      {rows.length === 0 ? (
        <Empty title="No sales in this pay period" />
      ) : (
        <Card>
          <CardHeader title={`${new Set(rows.map((r) => r.staffId)).size} barbers`} subtitle={multiShop ? "Barbers who worked at more than one shop have a row per shop." : undefined} />
          <Table>
            <thead>
              <tr>
                <Th>Staff ID</Th>
                <Th>Barber</Th>
                <Th>Shop</Th>
                <Th right>Tickets</Th>
                <Th right>Service sales</Th>
                <Th right>Card tips</Th>
                <Th right>Cash tips</Th>
                <Th right>Gift card tips</Th>
                <Th right>Tip refunds (netted)</Th>
                <Th right>Total tips</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.staffId}-${r.shop}`}>
                  <Td className="font-mono text-xs">{r.staffCode}</Td>
                  <Td>{r.label}</Td>
                  <Td>{r.shop}</Td>
                  <Td right>{r.tickets}</Td>
                  <Td right>{formatCents(r.serviceSalesCents)}</Td>
                  <Td right>{formatCents(r.cardTipsCents)}</Td>
                  <Td right>{formatCents(r.cashTipsCents)}</Td>
                  <Td right>{formatCents(r.giftCardTipsCents)}</Td>
                  <Td right>{r.tipRefundsCents ? `-${formatCents(r.tipRefundsCents)}` : "—"}</Td>
                  <Td right className="font-semibold">
                    {formatCents(r.totalTipsCents)}
                  </Td>
                </tr>
              ))}
              <tr className="bg-zinc-50 font-semibold">
                <Td>Total</Td>
                <Td />
                <Td />
                <Td right>{totals.tickets}</Td>
                <Td right>{formatCents(totals.svc)}</Td>
                <Td right>{formatCents(totals.card)}</Td>
                <Td right>{formatCents(totals.cash)}</Td>
                <Td right>{formatCents(totals.gc)}</Td>
                <Td right>{totals.ref ? `-${formatCents(totals.ref)}` : "—"}</Td>
                <Td right>{formatCents(totals.tips)}</Td>
              </tr>
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
