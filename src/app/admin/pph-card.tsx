import Link from "next/link";
import { Card, CardHeader, Table, Td, Th, cx } from "@/components/ui";
import { Sparkline } from "@/components/sparkline";
import { BOARD_ROWS, CARD_PERIODS, CARD_PERIOD_LABEL, type BoardEntry, type CardPeriod } from "@/domain/pph-card";
import { CLIENTS_LABEL, PPH_LABEL, type Pph, type Ranked, clientsText, pphText } from "@/domain/pph";
import { formatCents } from "@/lib/money";
import { type LocalDate, formatDate } from "@/lib/time";
import { type StaffContext, reportShopIds } from "@/server/auth/staff";
import { type PphDashboard, pphDashboard } from "@/server/pph-dashboard";
import { Skeleton } from "@/components/skeleton";

const hoursText = (h: number) => h.toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (v: number | null) => pphText(v, formatCents);

/**
 * The card for a dashboard: the brand's (every shop they have, when none is picked) or one shop's,
 * only the shops where they may see the PPH report. Nothing when there are none.
 */
export async function DashboardPph({ ctx, rankBy, today, now }: { ctx: StaffContext; rankBy: CardPeriod; today: LocalDate; now: Date }) {
  const ids = reportShopIds(ctx);
  const d = await pphDashboard({
    access: ctx.access,
    shops: ids.map((id) => ({ id, name: ctx.shops.find((s) => s.id === id)?.name ?? "" })),
    brand: ctx.brandWide && ctx.currentShopId === null,
    today,
    now,
    rankBy,
  });
  if (!d) return null;
  const shop = d.scope === "brand" ? "all" : d.shopIds.join(",");
  return <PphCard d={d} rankHref={(p) => `/admin?pph=${p}`} reportHref={`/admin/reports/pph?preset=pp:current&shop=${shop}`} />;
}

export function PphCardSkeleton() {
  return (
    <Card className="p-4" aria-busy="true">
      <Skeleton className="h-4 w-56" />
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    </Card>
  );
}

/** The dashboard's Productivity Per Hour card: today, yesterday and the period to date, the leaderboards and a 14-day sparkline. */
export function PphCard({ d, rankHref, reportHref }: { d: PphDashboard; rankHref: (p: CardPeriod) => string; reportHref: string }) {
  const head = (p: Pph) => (d.money ? money(p.servicePph) : clientsText(p.clientsPerHour));
  const shown = (v: number) => (d.money ? formatCents(v) : v.toFixed(2));
  const periodSub = d.period ? `${d.period.label} pay period` : "Each location's pay period";
  const sub: Record<CardPeriod, string> = {
    today: `${formatDate(d.dates.today, "EEE MMM d")}, so far`,
    yesterday: formatDate(d.dates.yesterday, "EEE MMM d"),
    period: periodSub,
  };
  const first = d.spark[0]?.date;
  return (
    <Card data-testid="pph-card">
      <CardHeader
        title="Productivity Per Hour (PPH)"
        subtitle={`${d.scope === "own" ? "Your own numbers" : d.totalLabel} · ${d.money ? "service sales per worked hour" : "completed service tickets per worked hour"}`}
        action={
          <Link className="text-xs underline" href={reportHref}>
            PPH report
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.2fr)]">
        {CARD_PERIODS.map((k) => {
          const p = d.total[k];
          return (
            <div key={k} className="rounded-lg bg-zinc-50 p-3" data-testid={`pph-${k}`}>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{CARD_PERIOD_LABEL[k]}</div>
              <div className="tabular mt-1 text-3xl font-semibold text-zinc-900">{head(p)}</div>
              <div className="text-xs text-zinc-500">{d.money ? PPH_LABEL.service : CLIENTS_LABEL}</div>
              <dl className="mt-2 space-y-0.5 text-xs tabular">
                {d.money && (
                  <>
                    <div className="flex justify-between gap-2">
                      <dt className="text-zinc-500">Clients per hour</dt>
                      <dd>{clientsText(p.clientsPerHour)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-zinc-500">Total PPH</dt>
                      <dd>{money(p.totalPph)}</dd>
                    </div>
                  </>
                )}
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Worked hours</dt>
                  <dd>{hoursText(p.hours)}</dd>
                </div>
              </dl>
              <div className="mt-1 text-[11px] text-zinc-400">{sub[k]}</div>
            </div>
          );
        })}
        <div className="rounded-lg bg-zinc-50 p-3 sm:col-span-3 lg:col-span-1" data-testid="pph-trend">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Last {d.spark.length} days</div>
          <Sparkline
            values={d.spark.map((s) => s.value)}
            labels={d.spark.map((s) => formatDate(s.date, "EEE MMM d"))}
            shown={shown}
            label={`${d.money ? PPH_LABEL.service : CLIENTS_LABEL} by day, last ${d.spark.length} days`}
          />
          <div className="mt-1 flex justify-between text-[11px] text-zinc-400">
            <span>{first ? formatDate(first, "MMM d") : ""}</span>
            <span>Today</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">Each day on its own. A gap is a day nobody worked.</p>
        </div>
      </div>
      {d.scope !== "own" && (
        <div className="border-t border-zinc-100 px-4 pb-4 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Leaderboards:</span>
            {CARD_PERIODS.map((k) => (
              <Link
                key={k}
                scroll={false}
                href={rankHref(k)}
                aria-current={k === d.rankBy ? "true" : undefined}
                className={cx("rounded-full px-2.5 py-1 ring-1", k === d.rankBy ? "bg-zinc-900 text-white ring-zinc-900" : "text-zinc-700 ring-zinc-300 hover:bg-zinc-50")}
              >
                {CARD_PERIOD_LABEL[k]}
              </Link>
            ))}
          </div>
          <div className={cx("grid gap-4", d.shops.length > 0 && "lg:grid-cols-2")}>
            <Board id="pph-barbers" title="Barbers" d={d} rows={d.barbers} detail={d.shops.length > 0} reportHref={reportHref} />
            {d.shops.length > 0 && <Board id="pph-locations" title="Locations" d={d} rows={d.shops} detail={false} reportHref={reportHref} />}
          </div>
        </div>
      )}
    </Card>
  );
}

function Board({ id, title, d, rows, detail, reportHref }: { id: string; title: string; d: PphDashboard; rows: Ranked<BoardEntry>[]; detail: boolean; reportHref: string }) {
  const total = d.total[d.rankBy];
  const shownRows = rows.slice(0, BOARD_ROWS);
  const cells = (p: Pph) =>
    d.money
      ? [money(p.servicePph), clientsText(p.clientsPerHour), money(p.totalPph), hoursText(p.hours)]
      : [clientsText(p.clientsPerHour), hoursText(p.hours)];
  const heads = d.money ? ["Service PPH", "Clients/hr", "Total PPH", "Hours"] : ["Clients/hr", "Hours"];
  return (
    <div data-testid={id}>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}: {CARD_PERIOD_LABEL[d.rankBy].toLowerCase()}
      </h3>
      {rows.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-500">No hours or sales {d.rankBy === "period" ? "this pay period" : d.rankBy} yet.</p>
      ) : (
        <Table label={`${title} by ${d.money ? PPH_LABEL.service : CLIENTS_LABEL}`}>
          <thead>
            <tr>
              <Th right>#</Th>
              <Th>{title === "Barbers" ? "Barber" : "Location"}</Th>
              {heads.map((h, i) => (
                <Th key={h} right sort={i === 0 ? "descending" : undefined}>
                  {h}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r) => (
              <tr key={r.item.id}>
                <Td right className="w-8 text-zinc-500">
                  {r.rank ?? "–"}
                </Td>
                <Td>
                  <span className="font-medium">{r.item.name}</span>
                  {detail && r.item.detail && <div className="text-xs text-zinc-500">{r.item.detail}</div>}
                </Td>
                {cells(r.item.p).map((c, i) => (
                  <Td key={i} right className={i === 0 ? "font-semibold" : undefined}>
                    {c}
                  </Td>
                ))}
              </tr>
            ))}
            <tr className="bg-zinc-50 font-semibold">
              <Td />
              <Td>{d.totalLabel}</Td>
              {cells(total).map((c, i) => (
                <Td key={i} right>
                  {c}
                </Td>
              ))}
            </tr>
          </tbody>
        </Table>
      )}
      {rows.length > BOARD_ROWS && (
        <Link className="mt-1 inline-block text-xs underline" href={reportHref}>
          {rows.length - BOARD_ROWS} more in the PPH report
        </Link>
      )}
    </div>
  );
}
