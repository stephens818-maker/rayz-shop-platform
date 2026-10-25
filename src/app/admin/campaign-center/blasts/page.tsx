import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Card, Empty, LinkButton, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { bySuccess, metricDefinitions, pctLabel, ratesOf } from "@/domain/campaign-metrics";
import { FREQ_LABEL } from "@/domain/campaign-schedule";
import { CHANNEL_LABEL } from "@/domain/marketing";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { can, guardPage, openShops, type StaffContext } from "@/server/auth/staff";
import { listBlasts } from "@/server/marketing/campaigns";
import { campaignFunnels, centerKpis } from "@/server/marketing/results";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { OTHER_SHOP } from "@/server/tenant";
import { KpiSkeleton, KpiTiles, MetricLabel, TableSkeleton } from "../kpis";
import { BlastActions } from "./blast-actions";
import { BLAST_STATUS, STATUS_FILTERS, type StatusFilter } from "./status";

export const metadata: Metadata = { title: "Blasts" };
export const dynamic = "force-dynamic";

const SORTS = { newest: "Newest", success: "Most successful" } as const;
type Sort = keyof typeof SORTS;

async function Kpis({ shopIds }: { shopIds: string[] }) {
  const k = await centerKpis(shopIds);
  return <KpiTiles funnel={k.funnel} defs={k.definitions} caption={`Last ${k.days} days, every campaign`} />;
}

async function BlastTable({ ctx, status, sort }: { ctx: StaffContext; status: StatusFilter; sort: Sort }) {
  const all = await listBlasts(ctx);
  const want = STATUS_FILTERS[status].statuses as readonly string[] | null;
  const list = want ? all.filter((b) => want.includes(b.status)) : all;
  const mayCreate = can(ctx, "campaign_center.create");
  const maySend = can(ctx, "campaign_center.send");
  const [funnels, s] = await Promise.all([campaignFunnels(list.map((b) => b.id), ctx.brandWide ? undefined : ctx.shopIds), loadMarketingSettings()]);
  const defs = metricDefinitions(s.attributionDays, s.attributeOn);
  const rows = list.map((b) => ({ b, ...(funnels.get(b.id) ?? { funnel: undefined, lift: undefined, last: null }) })).filter((r): r is typeof r & { funnel: NonNullable<typeof r.funnel> } => !!r.funnel);
  if (sort === "success") rows.sort(bySuccess);
  const shops = openShops(ctx);
  const where = (ids: string[]) => (ids.length ? ids.map((id) => shops.find((x) => x.id === id)?.name ?? OTHER_SHOP).join(", ") : "Every location");
  if (!rows.length)
    return (
      <div className="p-4">
        <Empty title={status === "all" ? "No blasts yet" : `No ${STATUS_FILTERS[status].label.toLowerCase()} blasts`}>
          {status === "all" ? (mayCreate ? "Pick a type, choose who gets it, write it, then review and send. You can send yourself a test first." : "Blasts your locations send show up here.") : "Try another filter."}
        </Empty>
      </div>
    );
  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th>When</Th>
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
        </tr>
      </thead>
      <tbody>
        {rows.map(({ b, funnel, last }) => {
          const r = ratesOf(funnel);
          const lr = last ? ratesOf(last.funnel) : null;
          const cell = (k: "openRate" | "clickRate" | "bookingRate") =>
            lr ? (
              <>
                <div title="Every send together">
                  {pctLabel(r[k])} <span className="text-[10px] text-zinc-400">lifetime</span>
                </div>
                <div className="text-xs text-zinc-500" title={`The send on ${last!.label}`}>
                  {pctLabel(lr[k])} <span className="text-[10px] text-zinc-400">last send</span>
                </div>
              </>
            ) : (
              pctLabel(r[k])
            );
          const st = BLAST_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
          const at = b.status === "scheduled" || b.status === "paused" ? b.scheduledAt : (b.sentAt ?? b.scheduledAt);
          return (
            <tr key={b.id}>
              <Td className="whitespace-normal">
                <Link href={`/admin/campaign-center/blasts/${b.id}`} className="font-semibold hover:underline">
                  {b.name}
                </Link>
                <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-zinc-500">
                  <span>{b.campaignType === "promotion" ? "Promotion" : "Quick update"}</span>·<span>{b.channels.map((c) => CHANNEL_LABEL[c]).join(" → ")}</span>·<span>{where(b.shopIds)}</span>
                  {b.recurrence && <Badge tone="blue">{FREQ_LABEL[b.recurrence.freq]}</Badge>}
                  {b.ab && <Badge tone="violet">A/B</Badge>}
                  {b.holdoutPct > 0 && <Badge>Holdout {b.holdoutPct}%</Badge>}
                  {b.aiDrafted && <Badge tone="violet">AI draft</Badge>}
                </div>
                <BlastActions id={b.id} name={b.name} status={b.status} mayWrite={mayCreate} maySend={maySend} mayManage={b.inScope} className="mt-1" />
              </Td>
              <Td>
                <Badge tone={st.tone}>{st.label}</Badge>
              </Td>
              <Td className="text-xs">
                {at
                  ? formatDateTime(at)
                      .split(" · ")
                      .map((x) => (
                        <div key={x}>{x}</div>
                      ))
                  : "—"}
              </Td>
              <Td right>{funnel.sent}</Td>
              <Td right>{cell("openRate")}</Td>
              <Td right>{cell("clickRate")}</Td>
              <Td right>{cell("bookingRate")}</Td>
              <Td right>{formatCents(funnel.revenueCents)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default async function BlastsPage({ searchParams }: { searchParams: Promise<{ status?: string; sort?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/blasts");
  const sp = await searchParams;
  const status: StatusFilter = sp.status && sp.status in STATUS_FILTERS ? (sp.status as StatusFilter) : "all";
  const sort: Sort = sp.sort === "success" ? "success" : "newest";
  const mayCreate = can(ctx, "campaign_center.create");
  const href = (o: { status?: StatusFilter; sort?: Sort }) => {
    const q = new URLSearchParams();
    const st = o.status ?? status;
    const so = o.sort ?? sort;
    if (st !== "all") q.set("status", st);
    if (so !== "newest") q.set("sort", so);
    return `/admin/campaign-center/blasts${q.size ? `?${q}` : ""}`;
  };
  const shopIds = ctx.brandWide ? openShops(ctx).map((s) => s.id) : ctx.shopIds;
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Blasts"
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · Messages to a segment of clients who agreed to marketing, once or on a repeat. Each client gets each send once, on the first channel they agreed to.
          </>
        }
        actions={
          <>
            <LinkButton variant="secondary" href="/admin/campaign-center/calendar">
              Calendar
            </LinkButton>
            {mayCreate && <LinkButton href="/admin/campaign-center/blasts/new">New blast</LinkButton>}
          </>
        }
      />
      <Suspense fallback={<KpiSkeleton />}>
        <Kpis shopIds={shopIds} />
      </Suspense>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
          <nav className="flex flex-wrap gap-1" aria-label="Status">
            {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((k) => (
              <Link key={k} href={href({ status: k })} aria-current={status === k ? "page" : undefined} className={cx("rounded-full px-3 py-1 text-sm", status === k ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100")}>
                {STATUS_FILTERS[k].label}
              </Link>
            ))}
          </nav>
          <nav className="flex items-center gap-1 text-sm" aria-label="Sort">
            <span className="text-xs text-zinc-500">Sort</span>
            {(Object.keys(SORTS) as Sort[]).map((k) => (
              <Link key={k} href={href({ sort: k })} aria-current={sort === k ? "page" : undefined} className={cx("rounded-full px-3 py-1", sort === k ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-600 hover:bg-zinc-100")}>
                {SORTS[k]}
              </Link>
            ))}
          </nav>
        </div>
        <Suspense key={`${status}:${sort}`} fallback={<TableSkeleton cols={8} />}>
          <BlastTable ctx={ctx} status={status} sort={sort} />
        </Suspense>
      </Card>
    </div>
  );
}
