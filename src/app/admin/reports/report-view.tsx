import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { reportFor, reportsFor } from "@/domain/navigation";
import { ReportKey, reportExport } from "@/domain/permissions";
import { formatCents } from "@/lib/money";
import { WEEKDAYS, formatDate } from "@/lib/time";
import { StaffContext, can, guardPage } from "@/server/auth/staff";
import { Cell, ColumnKind, REPORT_LOADERS, ReportTable } from "@/server/report-data";
import { ReportFilters } from "./filters";
import { ReportParams, resolveScope } from "./scope";

/** Reports that can be narrowed to one barber's tickets or appointments. */
const BARBER_FILTER: ReadonlySet<ReportKey> = new Set(["sales_summary", "sales_by_barber", "services_vs_products", "card_vs_cash", "discounts_refunds", "kpis", "heatmap"]);

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
  if (kind === "bool") return v ? "Yes" : "";
  return String(v);
}

function ReportTableCard({ t, csv }: { t: ReportTable; csv: string | null }) {
  const right = (k?: ColumnKind) => k === "money" || k === "int" || k === "pct";
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
        <Table className="max-h-[520px] overflow-y-auto">
          <thead>
            <tr>
              {t.columns.map((c) => (
                <Th key={c.label} right={right(c.kind)}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <Td key={j} right={right(t.columns[j]?.kind)}>
                    {formatCell(v, t.columns[j]?.kind)}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Heatmap({ cells }: { cells: { dow: number; hour: number; n: number }[] }) {
  const max = Math.max(1, ...cells.map((h) => h.n));
  const hours = Array.from({ length: 13 }, (_, i) => i + 8);
  return (
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
 */
export async function ReportPage({ report, searchParams }: { report: ReportKey; searchParams: ReportParams & Record<string, string | undefined> }) {
  const meta = reportFor(report);
  const ctx = await guardPage(meta.href);
  const scope = resolveScope(ctx, searchParams, report);
  const canExport = can(ctx, reportExport(report));
  const t0 = performance.now();
  const [data, barbers] = await Promise.all([
    REPORT_LOADERS[report]({ scope, viewer: ctx, params: searchParams }),
    BARBER_FILTER.has(report)
      ? db
          .selectDistinct({ id: staff.id, label: staff.displayLabel })
          .from(staffShops)
          .innerJoin(staff, eq(staff.id, staffShops.staffId))
          .where(inArray(staffShops.shopId, scope.shopIds))
          .orderBy(asc(staff.displayLabel))
      : Promise.resolve(null),
  ]);
  const ms = Math.round(performance.now() - t0);
  const csv = (table: string) => {
    if (!canExport) return null;
    const q = new URLSearchParams({ type: report, table, from: scope.from, to: scope.to });
    if (scope.shopParam) q.set("shop", scope.shopParam);
    if (scope.staffId && report !== "my_sales") q.set("staff", scope.staffId);
    return `/admin/reports/export?${q}`;
  };
  const scopeLabel =
    scope.shopIds.length === 1 ? ctx.shops.find((s) => s.id === scope.shopIds[0])?.name : scope.shopIds.length === ctx.shops.length ? "All my shops" : `${scope.shopIds.length} shops`;
  const exportAll = data.tables.find((t) => t.exportOnly);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={meta.label}
        subtitle={
          <>
            {scopeLabel} · {formatDate(scope.from, "MMM d, yyyy")}
            {scope.to !== scope.from && ` – ${formatDate(scope.to, "MMM d, yyyy")}`}
            {scope.staffId && report !== "my_sales" && ` · ${barbers?.find((b) => b.id === scope.staffId)?.label ?? "barber"}`}
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
        shop={scope.shopParam}
        staff={report === "my_sales" ? null : (scope.staffId ?? null)}
        shops={ctx.shops}
        barbers={barbers}
        showShop={ctx.shops.length > 1}
      />
      {data.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {data.stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} hint={s.hint} tone={s.tone} />
          ))}
        </div>
      )}
      {data.heatmap && <Heatmap cells={data.heatmap} />}
      {data.tables
        .filter((t) => !t.exportOnly && !(data.heatmap && t.id === "heatmap"))
        .map((t) => (
          <ReportTableCard key={t.id} t={t} csv={csv(t.id)} />
        ))}
      {data.heatmap && canExport && (
        <p className="mt-2 text-right text-xs">
          <a className="underline" href={csv("heatmap")!}>
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
