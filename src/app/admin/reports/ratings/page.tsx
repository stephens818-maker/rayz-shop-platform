import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, PageHeader, StarBadge, Table, Td, Th } from "@/components/ui";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { RatedClientRow, ratingsByShop } from "@/server/ratings";
import { LocationView } from "@/domain/report-views";
import { LocationField, LocationNotice, ViewToggle, locationProps, reportQuery } from "../filters";
import { ReportTabs } from "../report-view";
import { MIN_RATINGS, PERIODS, RatingsParams, resolveRatingsParams } from "./params";

export const metadata: Metadata = { title: "Client ratings" };

function ClientTable({ title, rows }: { title: string; rows: RatedClientRow[] }) {
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
              <Th>Latest note</Th>
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
                <Td className="max-w-xs truncate text-zinc-600">{r.lastNote ?? "—"}</Td>
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
  const t0 = performance.now();
  const shops = await ratingsByShop(p.query);
  const ms = Math.round(performance.now() - t0);
  const csv = reportQuery(p, { min: String(p.min), period: p.period });
  const here = (view: LocationView) => `/admin/reports/ratings?${reportQuery({ ...p, loc: { ...p.loc, view } }, { min: String(p.min), period: p.period })}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Client ratings"
        subtitle={
          <>
            {p.label} · {p.query.combined ? "Lowest- and highest-rated clients across these shops" : "Lowest- and highest-rated clients at each shop"}, from staff ratings given
            there. Staff only.
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          can(ctx, "report.client_ratings.export") ? (
            <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/reports/ratings/export?${csv}`}>
              Export CSV
            </a>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active="client_ratings" />
      <form key={p.shopParam ?? ""} className="no-print mb-4 flex flex-wrap items-end gap-2 text-sm" action="/admin/reports/ratings">
        {ctx.shops.length > 1 && <LocationField p={locationProps(ctx, p)} />}
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
        {p.selection.shopIds.length > 1 && (
          <div className="ml-auto self-center">
            <ViewToggle view={p.loc.view} href={here} />
          </div>
        )}
      </form>
      <LocationNotice locations={p} />
      {shops.length === 0 ? (
        <Empty title="No shops in scope" />
      ) : (
        <div className="space-y-4">
          {shops.map((s) => (
            <Card key={s.shopId}>
              <CardHeader title={s.shop} subtitle={`${s.ratedClients} rated client${s.ratedClients === 1 ? "" : "s"}`} />
              <div className="grid gap-2 pb-2 lg:grid-cols-2">
                <ClientTable title="Lowest rated" rows={s.lowest} />
                <ClientTable title="Highest rated" rows={s.highest} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
