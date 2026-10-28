import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardHeader, Table, cx } from "@/components/ui";
import { Sparkline } from "@/components/sparkline";
import { BOARD_ROWS, CARD_PERIOD_LABEL, type CardPeriod, type PerClient, type PerClientCardData } from "@/domain/pph-card";
import { rangeText } from "@/domain/report-range";
import { CLIENTS_LABEL, PER_CLIENT_LABEL, PPH_LABEL, type Pph, type Ranked, clientsText, pphText } from "@/domain/pph";
import { formatCents } from "@/lib/money";
import { type LocalDate, formatDate } from "@/lib/time";
import { type StaffContext, reportShopIds } from "@/server/auth/staff";
import { type PphDashboard, pphDashboard } from "@/server/pph-dashboard";
import { Skeleton } from "@/components/skeleton";

/** Tighter than the report tables, so two leaderboards fit side by side. */
const TH = "whitespace-nowrap border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500";
const TD = "whitespace-nowrap border-b border-zinc-100 px-2 py-1.5";
const hoursText = (h: number) => h.toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (v: number | null) => pphText(v, formatCents);
const countText = (n: number) => n.toLocaleString("en-US");

/**
 * The cards for a dashboard: the brand's (every shop they have, when none is picked) or one shop's,
 * only the shops where they may see the PPH report. Productivity Per Hour, then product sales per
 * client beside it when they may see dollar amounts. Nothing when there are no such shops.
 */
export async function DashboardPph({
  ctx,
  rankBy,
  perClientBy,
  today,
  now,
  shopIds,
  range = null,
  query = "",
}: {
  ctx: StaffContext;
  rankBy: CardPeriod;
  perClientBy: CardPeriod;
  today: LocalDate;
  now: Date;
  /** The dashboard's shops; its current shop, or all of them, by default. */
  shopIds?: readonly string[];
  /** The dashboard's date range when it isn't today. */
  range?: { from: LocalDate; to: LocalDate; label: string } | null;
  /** The dashboard's shops and dates, kept by the leaderboard links. */
  query?: string;
}) {
  const ids = shopIds ?? reportShopIds(ctx);
  const d = await pphDashboard({
    access: ctx.access,
    shops: ids.map((id) => ({ id, name: ctx.shops.find((s) => s.id === id)?.name ?? "" })),
    brand: ctx.brandWide && ctx.currentShopId === null,
    today,
    now,
    rankBy,
    perClientBy,
    range,
  });
  if (!d) return null;
  const shop = d.scope === "brand" ? "all" : d.shopIds.join(",");
  const href = (pph: CardPeriod, ppc: CardPeriod) => `/admin?${query ? `${query}&` : ""}pph=${pph}&ppc=${ppc}`;
  const report = `/admin/reports/pph?${range ? `from=${range.from}&to=${range.to}` : "preset=payperiod"}&shop=${shop}`;
  return (
    <>
      <PphCard d={d} rankHref={(p) => href(p, perClientBy)} reportHref={report} />
      {d.perClient && <PerClientCard d={d} c={d.perClient} rankHref={(p) => href(rankBy, p)} reportHref={`${report}&rank=perClient`} />}
    </>
  );
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

const periodSubs = (d: PphDashboard): Record<CardPeriod, string> => ({
  today: `${formatDate(d.dates.today, "EEE MMM d")}, so far`,
  yesterday: formatDate(d.dates.yesterday, "EEE MMM d"),
  period: d.period ? `${d.period.label} pay period` : "Each location's pay period",
  range: d.range ? `${d.range.label}: ${rangeText(d.range.from, d.range.to > d.dates.today ? d.dates.today : d.range.to)}` : "",
});

const tileGrid = (n: number) => cx("grid grid-cols-1 gap-3 p-4", n === 4 ? "sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.2fr)]" : "sm:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.2fr)]");

/** The dashboard's Productivity Per Hour card: today, yesterday and the period to date, the leaderboards and a 14-day sparkline. */
export function PphCard({ d, rankHref, reportHref }: { d: PphDashboard; rankHref: (p: CardPeriod) => string; reportHref: string }) {
  const head = (p: Pph) => (d.money ? money(p.servicePph) : clientsText(p.clientsPerHour));
  const sub = periodSubs(d);
  const cells = (p: Pph) => (d.money ? [money(p.servicePph), clientsText(p.clientsPerHour), money(p.totalPph), hoursText(p.hours)] : [clientsText(p.clientsPerHour), hoursText(p.hours)]);
  const heads = d.money ? ["Service PPH", "Clients/hr", "Total PPH", "Hours"] : ["Clients/hr", "Hours"];
  const rowsOf = (rs: Ranked<{ id: string; name: string; detail: string | null; p: Pph }>[]): BoardRow[] => rs.map((r) => ({ rank: r.rank, id: r.item.id, name: r.item.name, detail: r.item.detail, cells: cells(r.item.p) }));
  const what = d.money ? PPH_LABEL.service : CLIENTS_LABEL;
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
      <div className={tileGrid(d.periods.length)}>
        {d.periods.map((k) => {
          const p = d.total[k];
          return (
            <Tile key={k} id={`pph-${k}`} period={k} head={head(p)} unit={what} sub={sub[k]}>
              {d.money && (
                <>
                  <Fact label="Clients per hour" value={clientsText(p.clientsPerHour)} />
                  <Fact label="Total PPH" value={money(p.totalPph)} />
                </>
              )}
              <Fact label="Worked hours" value={hoursText(p.hours)} />
            </Tile>
          );
        })}
        <Trend id="pph-trend" spark={d.spark} today={d.dates.today} inRange={!!d.range} shown={(v) => (d.money ? formatCents(v) : v.toFixed(2))} label={what} gap="A gap is a day nobody worked." />
      </div>
      {d.scope !== "own" && (
        <Boards periods={d.periods} rankBy={d.rankBy} rankHref={rankHref} two={d.shops.length > 0}>
          <Board id="pph-barbers" title="Barbers" rankBy={d.rankBy} heads={heads} rows={rowsOf(d.barbers)} total={cells(d.total[d.rankBy])} totalLabel={d.totalLabel} detail={d.shops.length > 0} reportHref={reportHref} label={what} />
          {d.shops.length > 0 && <Board id="pph-locations" title="Locations" rankBy={d.rankBy} heads={heads} rows={rowsOf(d.shops)} total={cells(d.total[d.rankBy])} totalLabel={d.totalLabel} detail={false} reportHref={reportHref} label={what} />}
        </Boards>
      )}
    </Card>
  );
}

/** Product sales per client beside PPH: the same shops, people and periods, ranked and charted by it. */
export function PerClientCard({ d, c, rankHref, reportHref }: { d: PphDashboard; c: PerClientCardData; rankHref: (p: CardPeriod) => string; reportHref: string }) {
  const sub = periodSubs(d);
  const cells = (f: PerClient) => [money(f.perClient), formatCents(f.productCents), countText(f.clients)];
  const heads = ["Per client", "Product sales", "Clients"];
  const rowsOf = (rs: PerClientCardData["barbers"]): BoardRow[] => rs.map((r) => ({ rank: r.rank, id: r.item.id, name: r.item.name, detail: r.item.detail, cells: cells(r.item.f) }));
  const many = c.shops.length > 0;
  return (
    <Card data-testid="per-client-card">
      <CardHeader
        title={PER_CLIENT_LABEL}
        subtitle={`${d.scope === "own" ? "Your own numbers" : d.totalLabel} · product sales before tax over unique clients served; a walk-in counts once per ticket`}
        action={
          <Link className="text-xs underline" href={reportHref}>
            PPH report
          </Link>
        }
      />
      <div className={tileGrid(d.periods.length)}>
        {d.periods.map((k) => {
          const f = c.total[k];
          return (
            <Tile key={k} id={`per-client-${k}`} period={k} head={money(f.perClient)} unit={PER_CLIENT_LABEL} sub={sub[k]}>
              <Fact label="Product sales" value={formatCents(f.productCents)} />
              <Fact label="Unique clients" value={countText(f.clients)} />
            </Tile>
          );
        })}
        <Trend id="per-client-trend" spark={c.spark} today={d.dates.today} inRange={!!d.range} shown={formatCents} label={PER_CLIENT_LABEL} gap="A gap is a day with no clients." />
      </div>
      {d.scope !== "own" && (
        <Boards periods={d.periods} rankBy={c.rankBy} rankHref={rankHref} two={many}>
          <Board id="per-client-barbers" title="Barbers" rankBy={c.rankBy} heads={heads} rows={rowsOf(c.barbers)} total={cells(c.total[c.rankBy])} totalLabel={d.totalLabel} detail={many} reportHref={reportHref} label={PER_CLIENT_LABEL} empty="No clients" />
          {many && <Board id="per-client-locations" title="Locations" rankBy={c.rankBy} heads={heads} rows={rowsOf(c.shops)} total={cells(c.total[c.rankBy])} totalLabel={d.totalLabel} detail={false} reportHref={reportHref} label={PER_CLIENT_LABEL} empty="No clients" />}
        </Boards>
      )}
    </Card>
  );
}

function Tile({ id, period, head, unit, sub, children }: { id: string; period: CardPeriod; head: string; unit: string; sub: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3" data-testid={id}>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{CARD_PERIOD_LABEL[period]}</div>
      <div className="tabular mt-1 text-3xl font-semibold text-zinc-900">{head}</div>
      <div className="text-xs text-zinc-500">{unit}</div>
      <dl className="mt-2 space-y-0.5 text-xs tabular">{children}</dl>
      <div className="mt-1 text-[11px] text-zinc-400">{sub}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Trend({ id, spark, today, inRange, shown, label, gap }: { id: string; spark: { date: LocalDate; value: number | null }[]; today: LocalDate; inRange: boolean; shown: (v: number) => string; label: string; gap: string }) {
  const first = spark[0]?.date;
  const last = spark[spark.length - 1]?.date;
  const title = inRange ? `Each day of the range${spark.length ? `, ${spark.length} days` : ""}` : `Last ${spark.length} days`;
  return (
    <div className="rounded-lg bg-zinc-50 p-3 sm:col-span-full lg:col-span-1" data-testid={id}>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      <Sparkline values={spark.map((s) => s.value)} labels={spark.map((s) => formatDate(s.date, "EEE MMM d"))} shown={shown} label={`${label} by day, ${title.toLowerCase()}`} />
      <div className="mt-1 flex justify-between text-[11px] text-zinc-400">
        <span>{first ? formatDate(first, "MMM d") : ""}</span>
        <span>{last === today ? "Today" : last ? formatDate(last, "MMM d") : ""}</span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">Each day on its own. {gap}</p>
    </div>
  );
}

function Boards({ periods, rankBy, rankHref, two, children }: { periods: readonly CardPeriod[]; rankBy: CardPeriod; rankHref: (p: CardPeriod) => string; two: boolean; children: ReactNode }) {
  return (
    <div className="border-t border-zinc-100 px-4 pb-4 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Leaderboards:</span>
        {periods.map((k) => (
          <Link
            key={k}
            scroll={false}
            href={rankHref(k)}
            aria-current={k === rankBy ? "true" : undefined}
            className={cx("rounded-full px-2.5 py-1 ring-1", k === rankBy ? "bg-zinc-900 text-white ring-zinc-900" : "text-zinc-700 ring-zinc-300 hover:bg-zinc-50")}
          >
            {CARD_PERIOD_LABEL[k]}
          </Link>
        ))}
      </div>
      <div className={cx("grid gap-4", two && "lg:grid-cols-2")}>{children}</div>
    </div>
  );
}

interface BoardRow {
  rank: number | null;
  id: string;
  name: string;
  detail: string | null;
  cells: string[];
}

function Board(p: { id: string; title: string; rankBy: CardPeriod; heads: string[]; rows: BoardRow[]; total: string[]; totalLabel: string; detail: boolean; reportHref: string; label: string; empty?: string }) {
  const shown = p.rows.slice(0, BOARD_ROWS);
  const when = p.rankBy === "period" ? "this pay period" : p.rankBy === "range" ? "in this range" : p.rankBy;
  return (
    <div data-testid={p.id}>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {p.title}: {CARD_PERIOD_LABEL[p.rankBy].toLowerCase()}
      </h3>
      {p.rows.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-500">
          {p.empty ?? "No hours or sales"} {when} yet.
        </p>
      ) : (
        <Table label={`${p.title} by ${p.label}`}>
          <thead>
            <tr>
              <th className={cx(TH, "text-right")}>#</th>
              <th className={cx(TH, "text-left")}>{p.title === "Barbers" ? "Barber" : "Location"}</th>
              {p.heads.map((h, i) => (
                <th key={h} className={cx(TH, "text-right")} aria-sort={i === 0 ? "descending" : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className={cx(TD, "tabular w-6 text-right text-zinc-500")}>{r.rank ?? "–"}</td>
                <td className={TD}>
                  <span className="font-medium">{r.name}</span>
                  {p.detail && r.detail && <div className="text-xs text-zinc-500">{r.detail}</div>}
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} className={cx(TD, "tabular text-right", i === 0 && "font-semibold")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-zinc-50 font-semibold">
              <td className={TD} />
              <td className={TD}>{p.totalLabel}</td>
              {p.total.map((c, i) => (
                <td key={i} className={cx(TD, "tabular text-right")}>
                  {c}
                </td>
              ))}
            </tr>
          </tbody>
        </Table>
      )}
      {p.rows.length > BOARD_ROWS && (
        <Link className="mt-1 inline-block text-xs underline" href={p.reportHref}>
          {p.rows.length - BOARD_ROWS} more in the PPH report
        </Link>
      )}
    </div>
  );
}
