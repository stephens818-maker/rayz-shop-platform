import type { Metadata } from "next";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { WEEKDAYS, formatDate } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { byBarber, byShop, dailyTotals, kpis, monthlyTotals, salesSummary, tenderBreakdown } from "@/server/reports";
import { ReportFilters } from "./filters";
import { ReportParams, resolveScope } from "./scope";

export const metadata: Metadata = { title: "Reports" };

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export default async function ReportsPage({ searchParams }: { searchParams: Promise<ReportParams> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const scope = resolveScope(ctx, sp);
  const t0 = performance.now();
  const [summary, tender, barbers, shopRows, daily, monthly, k, barberOpts] = await Promise.all([
    salesSummary(scope),
    tenderBreakdown(scope),
    byBarber(scope),
    scope.shopIds.length > 1 ? byShop(scope) : Promise.resolve([]),
    dailyTotals(scope),
    monthlyTotals(scope),
    kpis(scope),
    ctx.isBarber
      ? Promise.resolve(null)
      : db
          .selectDistinct({ id: staff.id, label: staff.displayLabel })
          .from(staffShops)
          .innerJoin(staff, eq(staff.id, staffShops.staffId))
          .where(inArray(staffShops.shopId, scope.shopIds))
          .orderBy(asc(staff.displayLabel)),
  ]);
  const ms = Math.round(performance.now() - t0);
  const exportQs = (type: string) => {
    const q = new URLSearchParams({ type, from: scope.from, to: scope.to });
    if (scope.shopParam) q.set("shop", scope.shopParam);
    if (scope.staffId && !ctx.isBarber) q.set("staff", scope.staffId);
    return `/admin/reports/export?${q}`;
  };
  const scopeLabel =
    scope.shopIds.length === 1 ? ctx.shops.find((s) => s.id === scope.shopIds[0])?.name : scope.shopIds.length === ctx.shops.length ? "All shops" : `${scope.shopIds.length} shops`;
  const heatMax = Math.max(1, ...k.heatmap.map((h) => h.n));
  const hours = Array.from({ length: 13 }, (_, i) => i + 8);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={ctx.isBarber ? "My sales" : "Reports"}
        subtitle={
          <>
            {scopeLabel} · {formatDate(scope.from, "MMM d, yyyy")}
            {scope.to !== scope.from && ` – ${formatDate(scope.to, "MMM d, yyyy")}`}
            {scope.staffId && !ctx.isBarber && ` · ${barberOpts?.find((b) => b.id === scope.staffId)?.label ?? "barber"}`}
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={exportQs("summary")}>
            Export summary CSV
          </a>
        }
      />
      <ReportFilters
        base="/admin/reports"
        preset={scope.preset}
        from={scope.from}
        to={scope.to}
        shop={scope.shopParam}
        staff={ctx.isBarber ? null : (scope.staffId ?? null)}
        shops={ctx.shops}
        barbers={barberOpts}
        showShop={ctx.shops.length > 1}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gross sales" value={formatCents(summary.grossSalesCents)} hint={`${summary.tickets} tickets · avg ${formatCents(summary.avgTicketCents)}`} />
        <Stat label="Net services" value={formatCents(summary.netServicesCents)} hint={summary.discountCents ? `after ${formatCents(summary.discountCents)} discounts` : undefined} />
        <Stat label="Net products" value={formatCents(summary.netProductsCents)} hint={`${summary.productTickets} tickets with retail`} />
        <Stat label="Tips" value={formatCents(summary.tipsCents)} hint={`card ${formatCents(tender.cardTipsCents)} · cash ${formatCents(tender.cashTipsCents)}`} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Card" value={formatCents(tender.cardCents)} hint={`credit ${formatCents(tender.cardCreditCents)} · debit ${formatCents(tender.cardDebitCents)}`} />
        <Stat label="Cash" value={formatCents(tender.cashCents)} />
        <Stat label="Tax collected" value={formatCents(summary.taxCents)} hint={`gift cards sold ${formatCents(summary.giftCardsSoldCents)}`} />
        <Stat label="Card surcharges" value={formatCents(summary.cardFeeCents)} hint={summary.refundCents ? `refunds ${formatCents(summary.refundCents)}` : "no refunds"} />
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500">Client KPIs</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Rebook rate"
          value={pct(k.rebookRate)}
          hint={`${k.rebooked} of ${k.visits} visits rebooked within 24h${k.visitsWithoutBookingTime ? ` · ${k.visitsWithoutBookingTime} Squire visits without booking times left out` : ""}`}
        />
        <Stat label="Retention" value={pct(k.retentionRate)} hint={`${k.retainedClients} of ${k.priorClients} clients from prior ${k.priorWindow.from} – ${k.priorWindow.to} came back`} />
        <Stat
          label="New vs returning"
          value={`${k.newClients} / ${k.returningClients}`}
          hint={k.newClients + k.returningClients ? `${Math.round((k.newClients / (k.newClients + k.returningClients)) * 100)}% new to ${scope.shopIds.length > 1 ? "these shops" : "this shop"} · ${k.newToBrand} new to Ray'z` : undefined}
        />
        <Stat label="No-shows" value={k.noShows.n} hint={`${formatCents(k.noShows.cents)} lost · ${k.cancellations.n} cancellations`} tone={k.noShows.n ? "down" : undefined} />
      </div>

      <Card className="mt-4">
        <CardHeader title="Busiest times" subtitle="Appointments by day and hour (Chicago time)" />
        <div className="overflow-x-auto p-4">
          <table className="text-xs">
            <thead>
              <tr>
                <th />
                {hours.map((h) => (
                  <th key={h} className="px-1 pb-1 font-normal text-zinc-500">
                    {h % 12 || 12}
                    {h < 12 ? "a" : "p"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6].map((d) => (
                <tr key={d}>
                  <td className="pr-2 text-zinc-500">{WEEKDAYS[d]}</td>
                  {hours.map((h) => {
                    const n = k.heatmap.find((x) => x.dow === d && x.hour === h)?.n ?? 0;
                    const a = n / heatMax;
                    return (
                      <td key={h} className="p-0.5">
                        <div
                          title={`${WEEKDAYS[d]} ${h}:00 — ${n}`}
                          className={cx("grid h-7 w-9 place-items-center rounded tabular", a > 0.55 ? "text-white" : "text-zinc-700")}
                          style={{ background: n ? `rgba(200, 30, 30, ${0.08 + a * 0.85})` : "#f4f4f5" }}
                        >
                          {n || ""}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-xs text-zinc-400">Sundays omitted (all shops closed).</div>
        </div>
      </Card>

      {shopRows.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="By shop" action={<a className="text-xs underline" href={exportQs("shops")}>CSV</a>} />
          <Table>
            <thead>
              <tr>
                <Th>Shop</Th>
                <Th right>Tickets</Th>
                <Th right>Gross</Th>
                <Th right>Net services</Th>
                <Th right>Net products</Th>
                <Th right>Tips</Th>
              </tr>
            </thead>
            <tbody>
              {shopRows.map((r) => (
                <tr key={r.shopId}>
                  <Td>{r.name}</Td>
                  <Td right>{r.tickets}</Td>
                  <Td right>{formatCents(r.grossCents)}</Td>
                  <Td right>{formatCents(r.netServicesCents)}</Td>
                  <Td right>{formatCents(r.netProductsCents)}</Td>
                  <Td right>{formatCents(r.tipsCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title="By barber" action={<a className="text-xs underline" href={exportQs("barbers")}>CSV</a>} />
        {barbers.length === 0 ? (
          <div className="p-4">
            <Empty title="No sales in this range" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Barber</Th>
                <Th right>Tickets</Th>
                <Th right>Services</Th>
                <Th right>Net services</Th>
                <Th right>Net products</Th>
                <Th right>Tips</Th>
                <Th right>Avg ticket</Th>
              </tr>
            </thead>
            <tbody>
              {barbers.map((r) => (
                <tr key={r.staffId}>
                  <Td>{r.label}</Td>
                  <Td right>{r.tickets}</Td>
                  <Td right>{r.services}</Td>
                  <Td right>{formatCents(r.netServicesCents)}</Td>
                  <Td right>{formatCents(r.netProductsCents)}</Td>
                  <Td right>{formatCents(r.tipsCents)}</Td>
                  <Td right>{formatCents(r.avgTicketCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Daily totals" action={<a className="text-xs underline" href={exportQs("daily")}>CSV</a>} />
          <Table className="max-h-[480px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Day</Th>
                <Th right>Tickets</Th>
                <Th right>Gross</Th>
                <Th right>Net</Th>
                <Th right>Tips</Th>
                <Th right>Card</Th>
                <Th right>Cash</Th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day}>
                  <Td>{formatDate(d.day, "EEE MMM d")}</Td>
                  <Td right>{d.tickets}</Td>
                  <Td right>{formatCents(d.grossCents)}</Td>
                  <Td right>{formatCents(d.netCents)}</Td>
                  <Td right>{formatCents(d.tipsCents)}</Td>
                  <Td right>{formatCents(d.cardCents)}</Td>
                  <Td right>{formatCents(d.cashCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Monthly totals" action={<a className="text-xs underline" href={exportQs("monthly")}>CSV</a>} />
          <Table>
            <thead>
              <tr>
                <Th>Month</Th>
                <Th right>Tickets</Th>
                <Th right>Services</Th>
                <Th right>Tips</Th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <Td>{m.month}</Td>
                  <Td right>{m.tickets}</Td>
                  <Td right>{formatCents(m.netServicesCents)}</Td>
                  <Td right>{formatCents(m.tipsCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
