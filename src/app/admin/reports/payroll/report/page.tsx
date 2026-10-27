import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, cx } from "@/components/ui";
import { LOCATIONS_COLUMNS, MIXED_RATE_NAME, locationSummary, type Line, type Overridable } from "@/domain/payroll/calc";
import { reportExport } from "@/domain/permissions";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { NO_VALUE, locationBlocks, locationsRow, locationsTotals, titleFill, type LocationsCell, type LocationsColumnKey } from "@/server/payroll/locations";
import { approvalBlocked, approvalOf, approvalStatus, buildPayroll, payrollTrail, periodChoices, type ApprovalStatus, type BlockView } from "@/server/payroll/run";
import { ApprovalControls } from "../../../payroll/report/approval";
import { ApprovalNotice, PayrollTrailCard } from "../../../payroll/report/flow";

export const metadata: Metadata = { title: "Payroll Report" };

const HREF = "/admin/reports/payroll/report";

const two = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Excel's Accounting format on screen: negatives in parentheses, zero as "-". */
const acct = (x: number) => (Math.abs(x) < 0.005 ? "$ -" : x < 0 ? `($${two(-x)})` : `$${two(x)}`);

function show(kind: (typeof LOCATIONS_COLUMNS)[number]["kind"], v: LocationsCell, total: boolean): string {
  if (v === null) return kind === "ratio" || kind === "pct" ? NO_VALUE : "";
  if (typeof v === "string") return v;
  if (kind === "hours") return v.toFixed(2);
  if (kind === "pct") return total ? `${(v * 100).toFixed(2)}%` : `${Math.round(v * 100)}%`;
  return acct(v);
}

const ADJUSTED: Partial<Record<Overridable, LocationsColumnKey>> = {
  workedHours: "hours",
  otHours: "otHours",
  serviceSales: "service",
  productSales: "product",
  tips: "tips",
  netComm: "netComm",
  ptoHours: "ptoHours",
  trainingHours: "trainingHours",
  hourlyTotal: "hourlyTotal",
};

const STATUS: Record<ApprovalStatus, { label: string; tone: "amber" | "blue" | "green" | "red" }> = {
  draft: { label: "Draft", tone: "amber" },
  approved: { label: "Approved", tone: "blue" },
  stale: { label: "Changed since approval", tone: "red" },
  locked: { label: "Approved and locked", tone: "green" },
};

export default async function Page({ searchParams }: { searchParams: Promise<{ period?: string; shop?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage(HREF);
  const choices = await periodChoices();
  const current = choices.findIndex((c) => c.current);
  const chosen = choices.find((c) => c.key === sp.period) ?? choices[current + 1] ?? choices[0];
  const view = chosen ? await buildPayroll(chosen.start, chosen.end) : null;
  const rates = can(ctx, "payroll.rates");
  const mine = view ? view.blocks.filter((b) => ctx.shopIds.includes(b.shopId)) : [];
  const shopId = sp.shop && mine.some((b) => b.shopId === sp.shop) ? sp.shop : null;
  const blocks = view ? locationBlocks(view, (shopId ? [shopId] : mine.map((b) => b.shopId))) : [];
  const [approval, trail] = view ? await Promise.all([approvalOf(view), payrollTrail(view.start, view.end)]) : [null, []];
  const status = view ? approvalStatus(view, approval) : "draft";
  const canApprove = can(ctx, "payroll.approve") && ctx.brandWide;
  const canExport = can(ctx, reportExport("payroll_report"));
  const canFiles = can(ctx, "payroll.export") || can(ctx, "payroll.run");
  const drill = can(ctx, "payroll.run") || can(ctx, "payroll.approve");
  const filesReady = status === "approved" || status === "locked";
  const q = (extra: Record<string, string>) => new URLSearchParams({ ...(chosen ? { period: chosen.key } : {}), ...(shopId ? { shop: shopId } : {}), ...extra }).toString();
  const names = new Map(view ? view.blocks.flatMap((b) => b.lines.map((l) => [l.staffId, l.name] as const)) : []);
  const label = chosen ? `${formatDate(chosen.start, "MMM d")} – ${formatDate(chosen.end, "MMM d, yyyy")}` : "";

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader
        title="Payroll Report"
        subtitle={
          chosen && (
            <>
              {label} · {shopId ? blocks[0]?.shop : "all shops"} <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
            </>
          )
        }
        actions={
          view && canApprove && rates ? (
            <ApprovalControls start={view.start} end={view.end} label={`${label} for ${view.blocks.length} shop${view.blocks.length === 1 ? "" : "s"}`} status={status} blocked={approvalBlocked(view)} />
          ) : undefined
        }
      />
      <div className="no-print flex flex-wrap gap-1.5">
        {choices.slice(0, 8).map((c) => (
          <Link
            key={c.key}
            href={`${HREF}?${new URLSearchParams({ period: c.key, ...(shopId ? { shop: shopId } : {}) })}`}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", c.key === chosen?.key ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.current && " · current"}
            {c.lockedGroups > 0 && (c.lockedGroups === c.groups.length ? " · locked" : ` · ${c.lockedGroups} locked`)}
          </Link>
        ))}
      </div>
      {mine.length > 1 && (
        <div className="no-print flex flex-wrap gap-1.5 text-sm">
          <Link href={`${HREF}?${new URLSearchParams(chosen ? { period: chosen.key } : {})}`} className={cx("rounded-full px-3 py-1 ring-1", !shopId ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
            All shops
          </Link>
          {locationBlocks(view!, mine.map((b) => b.shopId)).map((b) => (
            <Link
              key={b.shopId}
              href={`${HREF}?${new URLSearchParams({ ...(chosen ? { period: chosen.key } : {}), shop: b.shopId })}`}
              className={cx("rounded-full px-3 py-1 ring-1", shopId === b.shopId ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
            >
              {b.shop}
            </Link>
          ))}
        </div>
      )}

      {!view || !blocks.length ? (
        <Notice>None of your shops has a pay period with those dates.</Notice>
      ) : !rates ? (
        <Notice>The Payroll Report shows pay rates and wages, so it needs &quot;See pay rates and labor cost&quot;.</Notice>
      ) : (
        <>
          <ApprovalNotice view={view} approval={approval} status={status} />
          {approvalBlocked(view) && status !== "locked" && (
            <Notice tone="red">
              {approvalBlocked(view)}, so the period can&apos;t be approved yet.{" "}
              {drill && (
                <Link href={`/admin/payroll/report?period=${chosen!.key}`} className="font-medium underline">
                  See what to fix
                </Link>
              )}
            </Notice>
          )}

          <Card>
            <CardHeader title="Downloads" subtitle="Every download is recorded in the audit trail below." />
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4 text-sm">
              {canExport && (
                <>
                  <a className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700" href={`${HREF}/file?${q({ format: "xlsx" })}`} data-testid="payroll-report-xlsx">
                    Payroll Report (.xlsx)
                  </a>
                  <a className="rounded-lg px-3 py-1.5 font-medium ring-1 ring-zinc-300 hover:bg-zinc-50" href={`${HREF}/file?${q({ format: "csv" })}`}>
                    CSV
                  </a>
                </>
              )}
              {canFiles &&
                (filesReady ? (
                  <>
                    <span className="ml-2 text-zinc-500">iSolved files:</span>
                    {blocks.map((b) => (
                      <a
                        key={b.shopId}
                        className="rounded-lg px-3 py-1.5 font-medium ring-1 ring-zinc-300 hover:bg-zinc-50"
                        href={`/admin/payroll/download?group=${b.payGroupId}&start=${view.start}&end=${view.end}`}
                        data-testid="isolved-shop-file"
                      >
                        {b.shop}
                      </a>
                    ))}
                    {can(ctx, reportExport("payroll_isolved")) && can(ctx, "payroll.export") && (
                      <a className="rounded-lg px-3 py-1.5 font-medium ring-1 ring-zinc-300 hover:bg-zinc-50" href={`/admin/reports/payroll/isolved/file?start=${view.start}&end=${view.end}`}>
                        All shops (one workbook)
                      </a>
                    )}
                  </>
                ) : (
                  <span className="ml-2 text-zinc-500">The iSolved files download once the figures are approved.</span>
                ))}
            </div>
          </Card>

          <Anomalies blocks={blocks} anomalies={view.anomalies} periodKey={chosen!.key} drill={drill} />

          {blocks.map((b) => (
            <LocationBlock key={b.shopId} b={b} periodKey={chosen!.key} drill={drill && !b.locked} />
          ))}

          <Summary blocks={blocks} />

          <PayrollTrailCard trail={trail} names={names} />
        </>
      )}
    </div>
  );
}

function Anomalies({ blocks, anomalies, periodKey, drill }: { blocks: BlockView[]; anomalies: { staffId: string | null; shopId: string | null; kind: string; message: string }[]; periodKey: string; drill: boolean }) {
  const ids = new Set(blocks.map((b) => b.shopId));
  const list = anomalies.filter((a) => !a.shopId || ids.has(a.shopId));
  if (!list.length) return <Notice tone="green">No anomalies to review for these shops.</Notice>;
  return (
    <Card>
      <CardHeader title={`Review before approving (${list.length})`} subtitle="Flags for review. None of these block approval and none are changed automatically: adjust a figure with a reason if it's wrong." />
      <ul className="divide-y divide-zinc-100 text-sm" data-testid="payroll-anomalies">
        {list.map((a, i) => (
          <li key={i} className="flex flex-wrap items-start gap-2 px-4 py-2">
            <Badge tone={a.kind === "below_minimum_wage" || a.kind === "missed_punch" || a.kind === "unassigned_sales" ? "red" : "amber"}>{a.kind.replace(/_/g, " ")}</Badge>
            <span className="flex-1">{a.message}</span>
            {drill && a.shopId && a.staffId && (
              <Link href={`/admin/payroll/report?period=${periodKey}#${a.shopId}-${a.staffId}`} className="text-brand-700 underline-offset-2 hover:underline">
                Review →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function adjustedTitle(l: Line, key: LocationsColumnKey): string | undefined {
  const o = l.input.overrides ?? {};
  for (const [k, col] of Object.entries(ADJUSTED)) if (col === key && o[k as Overridable]) return `Adjusted: ${o[k as Overridable]!.reason}`;
  if (key === "hourlyTotal" && l.input.zeroHourlyPay) return "$0 hourly pay (Payroll setup): hours still go to iSolved";
  const mixed = l.input.mixedRates ?? [];
  if ((key === "wage" && mixed.includes("wage")) || (key === "servicePct" && mixed.includes("servicePct")) || (key === "productPct" && mixed.includes("productPct")))
    return `The ${MIXED_RATE_NAME[key as "wage"]} changed in the period: each sale is paid at the rate on its checkout date, and hours at the wage on the day worked.`;
  return undefined;
}

function LocationBlock({ b, periodKey, drill }: { b: BlockView; periodKey: string; drill: boolean }) {
  const fill = titleFill(b.shop);
  const gp = b.totals.service - b.totals.totalWages;
  return (
    <Card data-testid="payroll-location">
      <div className="px-4 py-2 text-center font-semibold" style={fill ? { backgroundColor: `#${fill}` } : undefined}>
        {b.shop}
        {b.locked && (
          <Badge tone="green" className="ml-2">
            locked
          </Badge>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-xs">
          <thead className="bg-zinc-50 text-[11px] text-zinc-600">
            <tr>
              {LOCATIONS_COLUMNS.map((c, i) => (
                <th key={c.key} className={cx("px-2 py-2", i === 0 ? "sticky left-0 bg-zinc-50 text-left" : "text-right")}>
                  {c.header.trim()}
                </th>
              ))}
              <th className="bg-zinc-100 px-2 py-2 text-right text-zinc-500" title="Sales tax collected on the employee's tickets. Reference only: never in any pay figure or the iSolved file.">
                Sales tax (ref.)
              </th>
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l) => {
              const cells = locationsRow(l);
              return (
                <tr key={l.staffId} className="border-t border-zinc-100">
                  {LOCATIONS_COLUMNS.map((c, i) => {
                    const t = adjustedTitle(l, c.key);
                    if (i === 0)
                      return (
                        <td key={c.key} className="sticky left-0 bg-white px-2 py-1.5 font-medium">
                          {drill ? (
                            <Link href={`/admin/payroll/report?period=${periodKey}#${b.shopId}-${l.staffId}`} className="hover:underline" title="Drill down: hours by week, OT, and adjustments">
                              {l.name}
                            </Link>
                          ) : (
                            l.name
                          )}
                          {l.overridden.length > 0 && <span title="Has adjusted figures"> ✎</span>}
                        </td>
                      );
                    return (
                      <td key={c.key} title={t} className={cx("px-2 py-1.5 text-right tabular-nums", t && "bg-amber-50", cells[i] === "mixed" && "italic text-sky-800")}>
                        {show(c.kind, cells[i], false)}
                      </td>
                    );
                  })}
                  <td className="bg-zinc-50 px-2 py-1.5 text-right tabular-nums text-zinc-500">{acct(l.salesTax)}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-zinc-300 bg-zinc-50 font-semibold">
              {locationsTotals(b.totals).map((v, i) => (
                <td key={i} className={cx("px-2 py-1.5", i === 0 ? "sticky left-0 bg-zinc-50" : "text-right tabular-nums")}>
                  {i === 0 ? v : show(LOCATIONS_COLUMNS[i].kind, v, true)}
                </td>
              ))}
              <td className="bg-zinc-100 px-2 py-1.5 text-right tabular-nums text-zinc-500">{acct(b.totals.salesTax)}</td>
            </tr>
            <tr className="bg-zinc-50">
              <td className="sticky left-0 bg-zinc-50 px-2 py-1.5 font-semibold">Gross Profit</td>
              <td colSpan={LOCATIONS_COLUMNS.length} className="px-2 py-1.5 tabular-nums">
                Service$ {acct(b.totals.service)} − Total Wages {acct(b.totals.totalWages)} = <strong data-testid="block-gross-profit">{acct(gp)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {b.unassigned && (b.unassigned.productSales > 0 || b.unassigned.serviceSales > 0) && (
        <p className="border-t border-zinc-100 bg-red-50 px-4 py-2 text-xs text-red-800" data-testid="unassigned-sales">
          Unassigned sales at {b.shop}: {b.unassigned.serviceSales > 0 && `${acct(b.unassigned.serviceSales)} of services`}
          {b.unassigned.serviceSales > 0 && b.unassigned.productSales > 0 && " and "}
          {b.unassigned.productSales > 0 && `${acct(b.unassigned.productSales)} of products`} with no employee on the ticket. They aren&apos;t credited to anyone, so no commission is paid on them.
        </p>
      )}
    </Card>
  );
}

function Summary({ blocks }: { blocks: BlockView[] }) {
  const { rows, total } = locationSummary(blocks);
  return (
    <Card>
      <CardHeader title="Location summary" subtitle="Employee Cost is Total Wages (hourly, commission over hourly and product commission), as in the workbook. Every figure sums every employee's row." />
      <div className="overflow-x-auto">
        <table className="w-full max-w-2xl text-sm" data-testid="payroll-summary">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2">Location</th>
              <th className="px-3 py-2 text-right">Service Sales</th>
              <th className="px-3 py-2 text-right">Employee Cost</th>
              <th className="px-3 py-2 text-right">Gross Profit</th>
            </tr>
          </thead>
          <tbody>
            {[...rows, total].map((r) => (
              <tr key={r.shop} className={cx("border-t border-zinc-100", r === total && "bg-zinc-50 font-semibold")}>
                <td className="px-3 py-1.5">{r.shop}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{acct(r.service)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{acct(r.employeeCost)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{acct(r.grossProfit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
