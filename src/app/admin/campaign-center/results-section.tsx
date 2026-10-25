import { Badge, Card, CardHeader, Table, Td, Th } from "@/components/ui";
import { pctLabel, ratesOf, type MetricKey } from "@/domain/campaign-metrics";
import { AB_METRIC_LABEL } from "@/domain/campaign-schedule";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import type { StaffContext } from "@/server/auth/staff";
import { campaignResults, type Breakdown } from "@/server/marketing/results";
import { KpiTiles, MetricLabel, liftLabel } from "./kpis";

type Defs = Record<MetricKey, { label: string; definition: string }>;

function BreakdownTable({ title, rows, defs }: { title: string; rows: Breakdown[]; defs: Defs }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</div>
      <Table>
        <thead>
          <tr>
            <Th />
            <Th right>Sent</Th>
            <Th right>
              <MetricLabel k="openRate" defs={defs} />
            </Th>
            <Th right>
              <MetricLabel k="clickRate" defs={defs} />
            </Th>
            <Th right>
              <MetricLabel k="bookingRate" defs={defs} />
            </Th>
            <Th right>
              <MetricLabel k="attributedSales" defs={defs} />
            </Th>
            <Th right>
              <MetricLabel k="unsubscribeRate" defs={defs} />
            </Th>
            <Th right>
              <MetricLabel k="optOutRate" defs={defs} />
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const r = ratesOf(b.funnel);
            return (
              <tr key={b.key}>
                <Td className="font-medium">{b.label}</Td>
                <Td right>{b.funnel.sent}</Td>
                <Td right>{pctLabel(r.openRate)}</Td>
                <Td right>{pctLabel(r.clickRate)}</Td>
                <Td right>{pctLabel(r.bookingRate)}</Td>
                <Td right>{formatCents(b.funnel.revenueCents)}</Td>
                <Td right>{pctLabel(r.unsubscribeRate)}</Td>
                <Td right>{pctLabel(r.optOutRate)}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/** How one campaign did, at the person's locations. */
export async function CampaignResultsSection({ ctx, campaign }: { ctx: StaffContext; campaign: { id: string; ab: unknown } }) {
  const res = await campaignResults(ctx, campaign);
  const { funnel: f, lift } = res.overall;
  const r = ratesOf(f);
  const defs = res.definitions;
  if (!f.sent && !lift.holdout.n) return null;
  return (
    <Card data-testid="campaign-results">
      <CardHeader title="Results" subtitle={`Each message counts once. Bookings and sales within ${res.attributionDays} days, last touch. Clients already booked when it went aren't credited.`} />
      <div className="space-y-4 p-4">
        <KpiTiles funnel={f} defs={defs} />
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div>
            <div className="text-xs text-zinc-500">
              <MetricLabel k="delivered" defs={defs} />
            </div>
            <div className="tabular font-semibold">
              {f.delivered} of {f.sent}
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">
              <MetricLabel k="unsubscribeRate" defs={defs} />
            </div>
            <div className="tabular font-semibold">
              {pctLabel(r.unsubscribeRate)} <span className="text-xs font-normal text-zinc-500">({f.unsubscribes})</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">
              <MetricLabel k="optOutRate" defs={defs} />
            </div>
            <div className="tabular font-semibold">
              {pctLabel(r.optOutRate)} <span className="text-xs font-normal text-zinc-500">({f.optOuts})</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">
              <MetricLabel k="roi" defs={defs} />
            </div>
            <div className="tabular font-semibold">{r.roi === null ? "—" : `${Math.round(r.roi * 100)}%`}</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">
              <MetricLabel k="lift" defs={defs} />
            </div>
            <div className="tabular font-semibold" data-testid="lift">
              {lift.holdout.n ? liftLabel(lift) : "No holdout group"}
            </div>
            {lift.holdout.n > 0 && (
              <div className="text-xs text-zinc-500">
                {pctLabel(lift.treated.rate)} booked vs {pctLabel(lift.holdout.rate)} of {lift.holdout.n} held back
              </div>
            )}
          </div>
        </div>
        {f.alreadyBooked > 0 && <p className="text-xs text-zinc-500">{f.alreadyBooked} message{f.alreadyBooked === 1 ? " was" : "s were"} to clients who already had an appointment booked; their spend isn&apos;t credited.</p>}
        {res.ab && (
          <div className="rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200" data-testid="ab-result">
            <span className="font-semibold">A/B test</span> by {AB_METRIC_LABEL[res.ab.metric].toLowerCase()}:{" "}
            {res.ab.winner ? (
              <>
                <Badge tone="green">Version {res.ab.winner.toUpperCase()} won</Badge>
                {res.ab.result && (
                  <span className="ml-2 text-zinc-600">
                    A {pctLabel(res.ab.result.a.n ? res.ab.result.a.hits / res.ab.result.a.n : null)} of {res.ab.result.a.n} · B {pctLabel(res.ab.result.b.n ? res.ab.result.b.hits / res.ab.result.b.n : null)} of {res.ab.result.b.n}
                  </span>
                )}
                {res.ab.decidedAt && <span className="ml-2 text-xs text-zinc-500">picked {formatDateTime(res.ab.decidedAt)}, then sent to everyone else</span>}
              </>
            ) : res.ab.testEndsAt ? (
              <span>running; the winner is picked {formatDateTime(res.ab.testEndsAt)}</span>
            ) : (
              <span>not started</span>
            )}
          </div>
        )}
      </div>
      <BreakdownTable title="By variant" rows={res.byVariant} defs={defs} />
      <BreakdownTable title="By location" rows={res.byShop} defs={defs} />
      <BreakdownTable title="By barber" rows={res.byBarber} defs={defs} />
    </Card>
  );
}
