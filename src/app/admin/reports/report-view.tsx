import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardHeader, Empty, Notice, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { BarChartCard } from "@/components/bar-chart";
import { ChipStrip } from "@/components/chip-strip";
import { TrendChart } from "@/components/trend-chart";
import { reportBarChart } from "@/domain/report-charts";
import { reportFor, reportsFor } from "@/domain/navigation";
import { ReportKey, reportExport } from "@/domain/permissions";
import { MONEY_HIDDEN_NOTE } from "@/domain/report-money";
import { formatCell, numericKind } from "@/domain/report-format";
import { REPORT_GROUP, groupReports } from "@/domain/report-groups";
import { REPORT_VIEWS, viewOf } from "@/domain/report-views";
import { WEEKDAYS, formatDate } from "@/lib/time";
import { StaffContext, can, guardPage, reasonViewer } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { ReportData, ReportTable, loadReport } from "@/server/report-data";
import { reportContext } from "@/server/report-access";
import { LocationNotice, ReportFilters, locationProps, optionValues, reportQuery } from "./filters";
import { ReportParams, resolveScope } from "./scope";
import { SavedViews } from "./saved-views";
import { cleanViewQuery, listReportViews } from "@/server/report-views-saved";
import { compactTimeOfDay } from "@/lib/time-parse";

/** Report categories on top (only those with a report this person may open), then every report in the active one's category. Nothing sits behind a "More" menu. */
export function ReportTabs({ ctx, active }: { ctx: StaffContext; active: ReportKey }) {
  const list = reportsFor(ctx.permissions);
  if (list.length < 2) return null;
  const groups = groupReports(list);
  const current = groups.find((g) => g.id === REPORT_GROUP[active]) ?? groups[0];
  return (
    <nav aria-label="Reports" className="no-print mb-4 border-b border-zinc-200 pb-2">
      {groups.length > 1 && (
        <ChipStrip className="mb-1.5" label="Report categories">
          <Link href="/admin/reports" className="rounded-md px-2.5 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100">
            All reports
          </Link>
          {groups.map((g) => (
            <Link
              key={g.id}
              href={g.reports[0].href}
              aria-current={g.id === current.id ? "true" : undefined}
              className={cx("rounded-md px-2.5 py-1 text-xs font-medium", g.id === current.id ? "bg-zinc-200 text-ink-900" : "text-zinc-500 hover:bg-zinc-100")}
            >
              {g.label} <span className="text-zinc-400">{g.reports.length}</span>
            </Link>
          ))}
        </ChipStrip>
      )}
      <ChipStrip>
        {current.reports.map((r) => (
          <Link
            key={r.key}
            href={r.href}
            aria-current={r.key === active ? "page" : undefined}
            className={cx("rounded-md px-2.5 py-1 text-sm", r.key === active ? "bg-ink-900 text-white" : "text-zinc-600 hover:bg-zinc-100")}
          >
            {r.label}
          </Link>
        ))}
      </ChipStrip>
    </nav>
  );
}

const ROW_STYLE = { subtotal: "bg-zinc-50 font-medium", total: "bg-zinc-100 font-semibold" } as const;

/** One report table: per-row number formats for metric tables, shaded subtotal and total rows. */
export function ReportTableCard({ t, csv, rowAction, sortHref }: { t: ReportTable; csv: string | null; rowAction?: (row: number) => ReactNode; sortHref?: (options: Record<string, string>) => string }) {
  const right = numericKind;
  const kindAt = (i: number, j: number) => (t.rowKinds?.[i] && j > 0 ? t.rowKinds[i] : t.columns[j]?.kind);
  const last = t.columns.length - 1;
  const heading = (label: string, j: number) => {
    const to = sortHref && t.sortBy?.[j];
    if (!to) return label;
    const on = t.sorted?.column === j ? t.sorted.dir : null;
    return (
      <a href={sortHref(to)} className="underline decoration-dotted underline-offset-2 hover:text-zinc-900" title="Sort by this column">
        {label}
        {on && <span aria-hidden> {on === "asc" ? "▲" : "▼"}</span>}
      </a>
    );
  };
  return (
    <Card className="mt-4">
      <CardHeader
        title={t.title}
        subtitle={t.subtitle}
        action={
          csv ? (
            <a className="text-xs underline" href={csv}>
              CSV
            </a>
          ) : undefined
        }
      />
      {t.rows.length === 0 ? (
        <div className="p-4">
          <Empty title="Nothing in this range" />
        </div>
      ) : (
        <Table className="max-h-[560px] overflow-y-auto" label={t.title}>
          <thead>
            <tr>
              {t.columns.map((c, j) => (
                <Th key={j} right={t.rowKinds ? j > 0 : right(c.kind)} sort={t.sorted?.column === j ? (t.sorted.dir === "asc" ? "ascending" : "descending") : undefined} className={cx(t.totalColumn && j === last && "bg-zinc-100 text-zinc-700")}>
                  {heading(c.label, j)}
                </Th>
              ))}
              {rowAction && <Th />}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => {
              const style = t.rowStyles?.[i];
              return (
                <tr key={i} className={style ? ROW_STYLE[style] : undefined}>
                  {r.map((v, j) => (
                    <Td
                      key={j}
                      right={right(kindAt(i, j))}
                      className={cx(t.totalColumn && j === last && "bg-zinc-50 font-semibold", style === "total" && "border-t border-zinc-300")}
                    >
                      {formatCell(v, kindAt(i, j))}
                    </Td>
                  ))}
                  {rowAction && <Td right>{rowAction(i)}</Td>}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Heatmap({ title, cells }: { title: string; cells: { dow: number; hour: number; n: number }[] }) {
  const max = Math.max(1, ...cells.map((h) => h.n));
  const hours = Array.from({ length: 13 }, (_, i) => i + 8);
  return (
    <Card className="mt-4">
      <CardHeader title={`Busiest times: ${title}`} subtitle={`Appointments by day and hour (Chicago time) · ${cells.reduce((a, c) => a + c.n, 0)} appointments`} />
      <div className="overflow-x-auto p-4">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {hours.map((h) => (
                <th key={h} className="px-1 pb-1 font-normal text-zinc-500">
                  {compactTimeOfDay(h * 60)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <tr key={d}>
                <td className="pr-2 text-zinc-500">{WEEKDAYS[d]}</td>
                {hours.map((h) => {
                  const n = cells.find((x) => x.dow === d && x.hour === h)?.n ?? 0;
                  const a = n / max;
                  return (
                    <td key={h} className="p-0.5">
                      <div
                        title={`${WEEKDAYS[d]} ${h}:00 — ${n}`}
                        className={cx("grid h-7 w-9 place-items-center rounded tabular", a > 0.55 ? "text-white" : "text-zinc-700")}
                        style={{ background: n ? `rgba(200, 30, 30, ${0.08 + a * 0.85})` : "var(--color-zinc-100)" }}
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
  );
}

/**
 * One a la carte report. The page needs that report's view permission (via PAGE_ACCESS), shops are
 * limited to the viewer's access, and CSV links only appear with the report's export permission.
 * Every report covers one shop, any set of shops, a saved group or all shops, combined or by location.
 */
export async function ReportPage({
  report,
  searchParams,
  rowActions,
}: {
  report: ReportKey;
  searchParams: ReportParams & Record<string, string | string[] | undefined>;
  /** Per table id, a control at the end of each row (for example "Accept" on a suggestion). */
  rowActions?: (data: ReportData, ctx: StaffContext) => Record<string, (row: number) => ReactNode>;
}) {
  const meta = reportFor(report);
  const ctx = await guardPage(meta.href);
  const rctx = await reportContext(ctx, report);
  const scope = await resolveScope(rctx, searchParams, report);
  const canExport = can(ctx, reportExport(report));
  const t0 = performance.now();
  const params = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
  const [data, views] = await Promise.all([
    loadReport(report, { scope, loc: scope.loc, viewer: rctx, client: await clientPolicy(ctx), reasons: reasonViewer(ctx), params }),
    listReportViews(ctx.staff.id, report),
  ]);
  const query = cleanViewQuery(new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString());
  const ms = Math.round(performance.now() - t0);
  const csv = (table: string) => (canExport ? `/admin/reports/export?${reportQuery(scope, { ...optionValues(data.options), type: report, table, from: scope.from, to: scope.to })}` : null);
  const sortHref = (o: Record<string, string>) => `${meta.href}?${reportQuery(scope, { ...optionValues(data.options), ...o, ...(scope.preset ? { preset: scope.preset } : { from: scope.from, to: scope.to }) })}`;
  const view = viewOf(scope.loc);
  const barberLabel = scope.barbers?.pickable && scope.barbers.selection.staffIds ? scope.barbers.label : null;
  const exportAll = data.tables.find((t) => t.exportOnly && !t.downloadLabel && t.id !== "heatmap");
  const heatmapCsv = data.heatmaps && data.tables.some((t) => t.id === "heatmap") ? csv("heatmap") : null;
  const actions = rowActions?.(data, ctx) ?? {};
  const bars = data.bars || data.charts?.length || data.heatmaps?.length ? null : reportBarChart(data.tables);
  const pdf = canExport && data.tables.some((t) => !t.exportOnly) ? `/admin/reports/export?${reportQuery(scope, { ...optionValues(data.options), type: report, format: "pdf", from: scope.from, to: scope.to })}` : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={meta.label}
        subtitle={
          <>
            {scope.label} · {formatDate(scope.from, "MMM d, yyyy")}
            {scope.to !== scope.from && ` – ${formatDate(scope.to, "MMM d, yyyy")}`}
            {barberLabel && ` · ${barberLabel}`}
            {view !== "combined" && ` · ${REPORT_VIEWS[view].toLowerCase()}`}
            <span className="ml-2 whitespace-nowrap rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          (exportAll && canExport) || pdf ? (
            <span className="flex flex-wrap gap-2">
              {exportAll && canExport && (
                <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={csv(exportAll.id)!}>
                  Export {exportAll.title.toLowerCase()} CSV
                </a>
              )}
              {pdf && (
                <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={pdf} data-testid="report-pdf">
                  PDF
                </a>
              )}
            </span>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active={report} />
      <ReportFilters
        base={meta.href}
        preset={scope.preset}
        from={scope.from}
        to={scope.to}
        scope={scope}
        location={rctx.shops.length > 1 ? locationProps(rctx, scope) : null}
        options={data.options}
        presets={data.presets}
      />
      <SavedViews report={report} base={meta.href} query={query} views={views} canShare={can(ctx, "report_builder.build")} />
      <LocationNotice locations={scope} />
      {data.notes?.includes(MONEY_HIDDEN_NOTE) && <Notice tone="blue">{MONEY_HIDDEN_NOTE}</Notice>}
      {data.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {data.stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} hint={s.hint} tone={s.tone} />
          ))}
        </div>
      )}
      {data.charts && (
        <div className={cx(data.charts.length > 1 && "grid gap-x-4 xl:grid-cols-2")}>
          {data.charts.map((c) => (
            <TrendChart key={c.id} id={c.id} title={c.title} labels={c.labels} series={c.series} kind={c.kind} />
          ))}
        </div>
      )}
      {bars && <BarChartCard chart={bars} />}
      {data.bars && data.bars.length > 0 && (
        <div className={cx(data.bars.length > 1 && "grid gap-x-4 xl:grid-cols-2")}>
          {data.bars.map((b) => (
            <BarChartCard key={b.id} chart={b} />
          ))}
        </div>
      )}
      {data.heatmaps && (
        <div className={cx(data.heatmaps.length > 1 && "grid gap-x-4 xl:grid-cols-2")}>
          {data.heatmaps.map((h) => (
            <Heatmap key={h.title} title={h.title} cells={h.cells} />
          ))}
        </div>
      )}
      {data.tables
        .filter((t) => !t.exportOnly)
        .map((t) => (
          <ReportTableCard key={t.id} t={t} csv={csv(t.id)} rowAction={actions[t.id]} sortHref={t.sortBy ? sortHref : undefined} />
        ))}
      {canExport && data.tables.some((t) => t.exportOnly && t.downloadLabel) && (
        <p className="mt-2 flex flex-wrap justify-end gap-4 text-xs">
          {data.tables
            .filter((t) => t.exportOnly && t.downloadLabel)
            .map((t) => (
              <a key={t.id} className="underline" href={csv(t.id)!} title={t.subtitle}>
                {t.downloadLabel}
              </a>
            ))}
        </p>
      )}
      {heatmapCsv && (
        <p className="mt-2 text-right text-xs">
          <a className="underline" href={heatmapCsv}>
            Download heatmap CSV
          </a>
        </p>
      )}
      {data.notes
        ?.filter((n) => n !== MONEY_HIDDEN_NOTE)
        .map((n) => (
          <p key={n} className="mt-3 text-xs text-zinc-500">
            {n}
          </p>
        ))}
    </div>
  );
}
