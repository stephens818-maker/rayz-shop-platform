import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, Notice, PageHeader, StarBadge, Table, Td, Th } from "@/components/ui";
import { RATINGS_MASKED_HINT } from "@/domain/client-privacy";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { clientListDenied, clientPolicy } from "@/server/client-privacy";
import { RatedClientRow, ratingsByShop } from "@/server/ratings";
import { ratingsGivenTable } from "@/server/report-data";
import { ReportView } from "@/domain/report-views";
import { BarberField, LocationField, LocationNotice, ViewInput, ViewToggle, locationProps, reportQuery, withView } from "../filters";
import { ReportTableCard, ReportTabs } from "../report-view";
import { MIN_RATINGS, PERIODS, RatingsParams, resolveRatingsParams } from "./params";

export const metadata: Metadata = { title: "Client ratings" };

function ClientTable({ title, rows, notes }: { title: string; rows: RatedClientRow[]; notes: boolean }) {
  return (
    <div>
      <div className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-zinc-400">No clients yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Client</Th>
              <Th>Rating</Th>
              <Th>Last rated</Th>
              {notes && <Th>Latest note</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customerId}>
                <Td>
                  <Link className="font-medium hover:underline" href={`/admin/customers/${r.customerId}`}>
                    {r.name}
                  </Link>
                </Td>
                <Td>
                  <StarBadge rating={{ avg: r.avg, count: r.count }} />
                </Td>
                <Td className="whitespace-nowrap">{formatDate(r.lastRatedAt, "MMM d, yyyy")}</Td>
                {notes && <Td className="max-w-xs truncate text-zinc-600">{r.lastNote ?? "—"}</Td>}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

export default async function RatingsReportPage({ searchParams }: { searchParams: Promise<RatingsParams> }) {
  const ctx = await guardPage("/admin/reports/ratings");
  const p = await resolveRatingsParams(ctx, await searchParams);
  const policy = await clientPolicy(ctx);
  const clients = policy.stars({ avg: 0, count: 0 }) !== null;
  const t0 = performance.now();
  const [shops, given] = await Promise.all([clients ? ratingsByShop(p.query) : [], ratingsGivenTable(p.scope, p.loc)]);
  const ms = Math.round(performance.now() - t0);
  const canExport = can(ctx, "report.client_ratings.export") && !clientListDenied(ctx);
  const csv = reportQuery(p, { min: String(p.min), period: p.period });
  const here = (view: ReportView) => `/admin/reports/ratings?${reportQuery(withView(p, view), { min: String(p.min), period: p.period })}`;
  const barbers = p.barbers?.pickable && p.barbers.selection.staffIds ? ` · rated by ${p.barbers.label}` : "";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Client ratings"
        subtitle={
          <>
            {p.label}
            {barbers} · {p.query.combined ? "Lowest- and highest-rated clients across these shops" : "Lowest- and highest-rated clients at each shop"}, from staff ratings
            given there. Staff only.
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          canExport && clients ? (
            <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/reports/ratings/export?${csv}`}>
              Export CSV
            </a>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active="client_ratings" />
      <form key={`${p.shopParam ?? ""}|${p.staffParam ?? ""}`} className="no-print mb-4 flex flex-wrap items-end gap-2 text-sm" action="/admin/reports/ratings">
        {ctx.shops.length > 1 && <LocationField p={locationProps(ctx, p)} />}
        <BarberField l={p} />
        <ViewInput l={p} />
        <select name="period" defaultValue={p.period} aria-label="Period" className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
          {Object.entries(PERIODS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select name="min" defaultValue={String(p.min)} aria-label="Minimum ratings" className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
          {MIN_RATINGS.map((m) => (
            <option key={m} value={m}>
              {m === 1 ? "Any number of ratings" : `At least ${m} ratings`}
            </option>
          ))}
        </select>
        <button className="h-9 rounded-lg bg-ink-900 px-4 font-medium text-white">Show</button>
        <div className="ml-auto self-center">
          <ViewToggle l={p} href={here} />
        </div>
      </form>
      <LocationNotice locations={p} />
      <ReportTableCard t={given} csv={canExport ? `/admin/reports/ratings/export?${reportQuery(p, { period: p.period, table: "given" })}` : null} />
      <div className="h-4" />
      {!clients ? (
        <Notice>Client ratings aren&apos;t shown to you, so the rated-client lists are left out.</Notice>
      ) : shops.length === 0 ? (
        <Empty title="No shops in scope" />
      ) : (
        <div className="space-y-4">
          {shops.map((s) => (
            <Card key={s.shopId}>
              <CardHeader title={s.shop} subtitle={`${s.ratedClients} rated client${s.ratedClients === 1 ? "" : "s"}${policy.ratingDetail ? "" : ` · ${RATINGS_MASKED_HINT.toLowerCase()}`}`} />
              <div className="grid gap-2 pb-2 lg:grid-cols-2">
                <ClientTable title="Lowest rated" rows={s.lowest} notes={policy.ratingDetail} />
                <ClientTable title="Highest rated" rows={s.highest} notes={policy.ratingDetail} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
