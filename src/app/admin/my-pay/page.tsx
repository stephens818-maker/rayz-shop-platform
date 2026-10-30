import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { services, shops } from "@/db/schema";
import { Card, CardHeader, Empty, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import {
  addTotals,
  boothRentForDays,
  commissionBetween,
  describePlan,
  monthEnd,
  monthStart,
  tierRate,
  versionOn,
  zeroTotals,
  type CommissionTotals,
} from "@/domain/compensation";
import { paystubLines, type Line, type PaystubLine } from "@/domain/payroll/calc";
import { METHOD_LABEL } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { addDays, diffDays, formatDate, todayLocal, type LocalDate } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { commissionLines, loadCompensationSettings, setupRates, versionsFor } from "@/server/compensation";
import { buildPayroll, periodChoices } from "@/server/payroll/run";
import { formatPayHours } from "@/lib/hours";

export const metadata: Metadata = { title: "My pay" };

const pct = (f: number) => `${Math.round(f * 10000) / 100}%`;
const dollars = (n: number) => formatCents(Math.round(n * 100));
const sum = (m: Map<string, CommissionTotals>) => [...m.values()].reduce(addTotals, zeroTotals());

export default async function MyPayPage() {
  const ctx = await guardPage("/admin/my-pay");
  if (ctx.staff.kind !== "person") return <Empty title="Shop logins don't have pay">Sign in as yourself to see your pay.</Empty>;
  const settings = await loadCompensationSettings();
  const me = ctx.staff.id;
  const today = todayLocal();
  const periods = (await periodChoices()).filter((p) => p.current);
  const period = periods[0] ?? null;
  const lastMonth = monthStart(addDays(monthStart(today), -1));
  const from = [lastMonth, ...(period ? [monthStart(period.start)] : [])].sort()[0];

  const [vs, fallbackOf, lines] = await Promise.all([versionsFor([me]).then((m) => m.get(me) ?? []), setupRates([me]), commissionLines([me], from, today).then((m) => m.get(me) ?? [])]);
  const fb = fallbackOf(me);
  const span = (a: LocalDate, b: LocalDate) => sum(commissionBetween(lines, vs, fb, a, b));
  const month = span(monthStart(today), today);
  const rows: { label: string; t: CommissionTotals }[] = [
    ...(period ? [{ label: `This pay period (${formatDate(period.start, "MMM d")} – ${formatDate(period.end, "MMM d")}, so far)`, t: span(period.start, today < period.end ? today : period.end) }] : []),
    { label: `${formatDate(today, "MMMM")} to date`, t: month },
    { label: formatDate(lastMonth, "MMMM"), t: span(lastMonth, monthEnd(lastMonth)) },
  ];

  const current = versionOn(vs, today);
  const next = vs.filter((v) => v.effectiveFrom > today).at(-1) ?? null;
  const ids = (k: "shop" | "service") => (current ? (k === "shop" ? current.shopHourlyRates.map((r) => r.shopId) : current.serviceOverrides.filter((o) => o.kind === "service").map((o) => o.ref)) : []);
  const [shopNames, serviceNames] = await Promise.all([
    ids("shop").length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ids("shop"))) : [],
    ids("service").length ? db.select({ id: services.id, name: services.name }).from(services).where(inArray(services.id, ids("service"))) : [],
  ]);
  const names = {
    shop: (id: string) => shopNames.find((s) => s.id === id)?.name ?? "a shop",
    service: (id: string) => serviceNames.find((s) => s.id === id)?.name ?? "A service",
    tipMethod: (m: keyof typeof METHOD_LABEL) => METHOD_LABEL[m],
  };
  const monthNet = month.serviceNetCents;
  const tiers = current?.serviceTiers ?? [];
  const base = current?.servicePct ?? fb(null).servicePct;
  const nextTier = tiers.find((t) => t.fromCents > monthNet) ?? null;
  const rent = current?.boothRentCents != null && current.boothRentFrequency ? boothRentForDays({ cents: current.boothRentCents, frequency: current.boothRentFrequency }, diffDays(monthEnd(today), monthStart(today)) + 1) : null;

  let estimate: { shop: string; l: Line; locked: boolean; stub: PaystubLine[] }[] = [];
  if (periods.length) {
    const seen = new Set<string>();
    for (const p of periods) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      const view = await buildPayroll(p.start, p.end, { clockChecks: false });
      for (const b of view?.blocks ?? []) for (const l of b.lines) if (l.staffId === me) estimate.push({ shop: b.shop, l, locked: !!b.locked, stub: paystubLines(b, me) });
    }
    estimate = estimate.sort((a, b) => a.shop.localeCompare(b.shop));
  }
  const gross = estimate.reduce((a, e) => a + e.l.hourlyTotal, 0);
  const tipsEarned = estimate.reduce((a, e) => a + e.l.tips, 0);
  const tipsPaid = estimate.reduce((a, e) => a + e.l.tipsPaidOut, 0);
  const commission = estimate.reduce((a, e) => a + e.l.commission + e.l.productTotal, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="My pay" subtitle="Your own hours, commission and tips. Nobody else's pay shows here." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Hourly gross this period" value={estimate.length ? dollars(gross) : "—"} hint="hours × your rate" />
        <Stat label="Commission this period" value={estimate.length ? dollars(commission) : "—"} hint="service and product" />
        <Stat label="Tips earned" value={estimate.length ? dollars(tipsEarned) : "—"} />
        <Stat label="Tips paid out" value={estimate.length ? dollars(tipsPaid) : "—"} hint={estimate.length ? `${dollars(Math.max(0, tipsEarned - tipsPaid))} pending` : undefined} />
      </div>
      {settings.enabled && (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Service commission this month" value={formatCents(Math.round(month.serviceCommissionCents))} />
        <Stat label="Product commission this month" value={formatCents(Math.round(month.productCommissionCents))} />
        <Stat label="Net service sales this month" value={formatCents(monthNet)} hint="after discounts and refunds" />
      </div>
      )}
      <Card>
        <CardHeader title="Commission" subtitle="On your sales after discounts and refunds. A refund takes back the commission its sale earned, on the day it's given." />
        <Table>
          <thead>
            <tr>
              <Th />
              <Th right>Net service</Th>
              <Th right>Service commission</Th>
              <Th right>Net product</Th>
              <Th right>Product commission</Th>
              <Th right>Total</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <Td>{r.label}</Td>
                <Td right>{formatCents(r.t.serviceNetCents)}</Td>
                <Td right>{formatCents(Math.round(r.t.serviceCommissionCents))}</Td>
                <Td right>{formatCents(r.t.productNetCents)}</Td>
                <Td right>{formatCents(Math.round(r.t.productCommissionCents))}</Td>
                <Td right>{formatCents(Math.round(r.t.serviceCommissionCents) + Math.round(r.t.productCommissionCents))}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-4 py-2 text-xs text-zinc-500">Payroll pays the greater of your hourly pay and your service commission, plus product commission.</p>
      </Card>
      {tiers.length > 0 && (
        <Notice tone="blue">
          This month you&apos;re at {pct(tierRate(tiers, current!.tierMode, base, monthNet))} on {formatCents(monthNet)} of service sales.
          {nextTier ? ` ${formatCents(nextTier.fromCents - monthNet)} more reaches ${pct(nextTier.pct)}.` : " That's the top tier."}
        </Notice>
      )}
      <Card>
        <CardHeader title="My plan" subtitle={current ? `In effect since ${formatDate(current.effectiveFrom, "MMM d, yyyy")}` : "No plan of your own: Payroll setup's rates apply."} />
        {current ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 text-sm sm:grid-cols-2">
            {describePlan(current, names).map((l, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-zinc-50 py-1">
                <dt className="text-zinc-500">{l.label}</dt>
                <dd className="text-right tabular">{l.value}</dd>
              </div>
            ))}
            {rent !== null && (
              <div className="flex justify-between gap-3 border-b border-zinc-50 py-1">
                <dt className="text-zinc-500">Booth rent this month</dt>
                <dd className="text-right tabular">{formatCents(Math.round(rent))}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="px-4 py-3 text-sm text-zinc-500">
            ${fb(null).hourlyRate.toFixed(2)}/h, service {pct(fb(null).servicePct)}, product {pct(fb(null).productPct)}.
          </p>
        )}
        {next && <p className="px-4 pb-3 text-xs text-zinc-500">A change starts {formatDate(next.effectiveFrom, "MMM d, yyyy")}.</p>}
      </Card>
      {settings.payEstimate && (
        <Card>
          <CardHeader title="Pay estimate" subtitle="The current pay period so far, from the Payroll Report's numbers. Final pay is what payroll approves; hours and sales still to come aren't in it." />
          {estimate.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Shop</Th>
                  <Th right>Hours</Th>
                  <Th right>Hourly pay</Th>
                  <Th right>Service commission</Th>
                  <Th right>Product commission</Th>
                  <Th right>Overtime</Th>
                  <Th right>Training</Th>
                  <Th right>Guarantee top-up</Th>
                  <Th right>Gross (before tips)</Th>
                  <Th right>Tips through payroll</Th>
                </tr>
              </thead>
              <tbody>
                {estimate.map(({ shop, l, locked }) => (
                  <tr key={shop}>
                    <Td>
                      {shop}
                      {locked && <span className="ml-1 text-xs text-zinc-500">(approved)</span>}
                    </Td>
                    <Td right>{formatPayHours(l.hours + l.otHours)}</Td>
                    <Td right>{dollars(l.hourlyTotal)}</Td>
                    <Td right>{dollars(l.commission)}</Td>
                    <Td right>{dollars(l.productTotal)}</Td>
                    <Td right>{dollars(l.otPay)}</Td>
                    <Td right>{dollars(l.trainingPay)}</Td>
                    <Td right>{dollars(l.guaranteeTopUp ?? 0)}</Td>
                    <Td right>{dollars(l.laborCost)}</Td>
                    <Td right>{dollars(l.tipsInPayroll)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="px-4 py-6 text-sm text-zinc-500">No hours or sales in the current pay period yet.</p>
          )}
          {estimate.some((e) => e.stub.length) && (
            <div className="space-y-1 border-t border-zinc-100 px-4 py-3 text-sm">
              <p className="text-xs text-zinc-500">As your paystub will name them (the payroll file&apos;s earnings):</p>
              {estimate.map(({ shop, stub }) =>
                stub.length ? (
                  <p key={shop}>
                    <span className="font-medium">{shop}:</span>{" "}
                    {stub.map((s) => `${s.name} ${s.unit === "hours" ? formatPayHours(s.amount, { unit: "hrs" }) : dollars(s.amount)}${s.memo ? " (already paid to you)" : ""}`).join(" · ")}
                  </p>
                ) : null,
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
