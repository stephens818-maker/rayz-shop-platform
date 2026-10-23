import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { reportFor, reportsFor } from "@/domain/navigation";
import { ReportKey, reportExport } from "@/domain/permissions";
import { REPORT_VIEWS, viewOf } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { WEEKDAYS, formatDate } from "@/lib/time";
import { StaffContext, can, guardPage } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { Cell, ColumnKind, REPORT_LOADERS, ReportData, ReportTable } from "@/server/report-data";
import { LocationNotice, ReportFilters, locationProps, reportQuery } from "./filters";
import { ReportParams, resolveScope } from "./scope";

/** The strip of reports this person may open. Reports they lack aren't shown at all. */
export function ReportTabs({ ctx, active }: { ctx: StaffContext; active: ReportKey }) {
  const list = reportsFor(ctx.permissions);
  if (list.length < 2) return null;
  return (
    <nav aria-label="Reports" className="no-print mb-4 flex flex-wrap gap-1 border-b border-zinc-200 pb-2">
      {list.map((r) => (
        <Link
          key={r.key}
          href={r.href}
          aria-current={r.key === active ? "page" : undefined}
          className={cx("rounded-md px-2.5 py-1 text-sm", r.key === active ? "bg-ink-900 text-white" : "text-zinc-600 hover:bg-zinc-100")}
        >
          {r.label}
        </Link>
      ))}
    </nav>
  );
}

function formatCell(v: Cell, kind: ColumnKind | undefined) {
  if (v === null || v === "") return "—";
  if (kind === "money" && typeof v === "number") return formatCents(v);
  if (kind === "pct" && typeof v === "number") return `${Math.round(v * 100)}%`;
  if (kind === "hours" && typeof v === "number") return (v / 60).toFixed(1);
  if (kind === "decimal" && typeof v === "number") return v.toFixed(2);
  if (kind === "minutes" && typeof v === "number") return v.toFixed(1);
  if (kind === "minutes_delta" && typeof v === "number") return `${v > 0.05 ? "+" : v < -0.05 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
  if (kind === "bool") return v ? "Yes" : "";
  return String(v);
}

const ROW_STYLE = { subtotal: "bg-zinc-50 font-medium", total: "bg-zinc-100 font-semibold" } as const;

/** One report table: per-row number formats for metric tables, shaded subtotal and total rows. */
export function ReportTableCard({ t, csv, rowAction }: { t: ReportTable; csv: string | null; rowAction?: (row: number) => ReactNode }) {
  const right = (k?: ColumnKind) => k === "money" || k === "int" || k === "pct" || k === "hours" || k === "decimal" || k === "minutes" || k === "minutes_delta";
  const kindAt = (i: number, j: number) => (t.rowKinds?.[i] && j > 0 ? t.rowKinds[i] : t.columns[j]?.kind);
  const last = t.columns.length - 1;
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
        <Table className="max-h-[560px] overflow-y-auto">
          <thead>
            <tr>
              {t.columns.map((c, j) => (
                <Th key={j} right={t.rowKinds ? j > 0 : right(c.kind)} className={cx(t.totalColumn && j === last && "bg-zinc-100 text-zinc-700")}>
                  {c.label}
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
                  const n = cells.find((x) => x.dow === d && x.hour === h)?.n ?? 0;
                  const a = n / max;
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
  const scope = await resolveScope(ctx, searchParams, report);
  const canExport = can(ctx, reportExport(report));
  const t0 = performance.now();
  const params = Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
  const data = await REPORT_LOADERS[report]({ scope, loc: scope.loc, viewer: ctx, client: await clientPolicy(ctx), params });
  const ms = Math.round(performance.now() - t0);
  const csv = (table: string) => (canExport ? `/admin/reports/export?${reportQuery(scope, { type: report, table, from: scope.from, to: scope.to })}` : null);
  const view = viewOf(scope.loc);
  const barberLabel = scope.barbers?.pickable && scope.barbers.selection.staffIds ? scope.barbers.label : null;
  const exportAll = data.tables.find((t) => t.exportOnly && t.id !== "heatmap");
  const heatmapCsv = data.heatmaps && data.tables.some((t) => t.id === "heatmap") ? csv("heatmap") : null;
  const actions = rowActions?.(data, ctx) ?? {};

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
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          exportAll && canExport ? (
            <a className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={csv(exportAll.id)!}>
              Export {exportAll.title.toLowerCase()} CSV
            </a>
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
        location={ctx.shops.length > 1 ? locationProps(ctx, scope) : null}
      />
      <LocationNotice locations={scope} />
      {data.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {data.stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} hint={s.hint} tone={s.tone} />
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
          <ReportTableCard key={t.id} t={t} csv={csv(t.id)} rowAction={actions[t.id]} />
        ))}
      {heatmapCsv && (
        <p className="mt-2 text-right text-xs">
          <a className="underline" href={heatmapCsv}>
            Download heatmap CSV
          </a>
        </p>
      )}
      {data.notes?.map((n) => (
        <p key={n} className="mt-3 text-xs text-zinc-500">
          {n}
        </p>
      ))}
    </div>
  );
}
