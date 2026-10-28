import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, cx } from "@/components/ui";
import { LOCATIONS_COLUMNS, MIXED_RATE_NAME, locationSummary, type Line, type Overridable } from "@/domain/payroll/calc";
import { reportExport } from "@/domain/permissions";
import { formatDate, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { NO_VALUE, locationBlocks, locationsRow, locationsTotals, titleFill, type LocationsCell, type LocationsColumnKey } from "@/server/payroll/locations";
import { approvalBlocked, approvalOf, approvalStatus, payrollTrail, periodKey, preparersOf, SELF_APPROVAL, type ApprovalStatus, type BlockView } from "@/server/payroll/run";
import { reportContext } from "@/server/report-access";
import { ApprovalControls } from "../../../payroll/report/approval";
import { type PayrollRangeParams, payrollRange, payrollRangeQuery, runFileQuery } from "../../../payroll/report/range";
import { RangeNotices } from "../../../payroll/report/range-notices";
import { ReportFilters, locationProps } from "../../filters";
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

export default async function Page({ searchParams }: { searchParams: Promise<PayrollRangeParams> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/reports/payroll/report");
  const r = await payrollRange(await reportContext(ctx, "payroll_report"), sp, "payroll_report");
  const { view, full, official } = r;
  const rates = can(ctx, "payroll.rates");
  const blocks = view ? locationBlocks(view, view.blocks.map((b) => b.shopId)) : [];
  const [approval, trail, preparers] = official && full ? await Promise.all([approvalOf(full), payrollTrail(full.start, full.end), preparersOf(full.start, full.end)]) : [null, [], []];
  const selfPrepared = !ctx.isOwner && preparers.some((p) => p.staffId === ctx.actor.staffId);
  const status = full ? approvalStatus(full, approval) : "draft";
  const canApprove = can(ctx, "payroll.approve") && ctx.brandWide && official;
  const canExport = can(ctx, reportExport("payroll_report")) && official;
  const canFiles = (can(ctx, "payroll.export") || can(ctx, "payroll.run")) && official;
  const drill = can(ctx, "payroll.run") || can(ctx, "payroll.approve");
  const filesReady = status === "approved" || status === "locked";
  const one = blocks.length === 1 && r.locations.selection.shopIds.length === 1 ? blocks[0].shopId : null;
  const q = (extra: Record<string, string>) => {
    const out = new URLSearchParams({ ...(view ? { period: periodKey(view.start, view.end) } : {}), ...extra });
    for (const id of full?.scopeShopIds ?? (one ? [one] : [])) out.append("shop", id);
    return out.toString();
  };
  const drillQuery = payrollRangeQuery(r);
  const names = new Map(view ? view.blocks.flatMap((b) => b.lines.map((l) => [l.staffId, l.name] as const)) : []);
  const label = view ? `${formatDate(view.start, "MMM d")} – ${formatDate(view.end, "MMM d, yyyy")}` : "";

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader
        title="Payroll Report"
        subtitle={
          <>
            <span data-testid="payroll-range">{r.heading}</span> · {r.locations.label}{" "}
            {official ? <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge> : <Badge tone="amber">Not an official pay period</Badge>}
          </>
        }
        actions={
          full && canApprove && rates ? (
            <ApprovalControls
              start={full.start}
              end={full.end}
              label={`${label} for ${full.blocks.length} shop${full.blocks.length === 1 ? "" : "s"}`}
              status={status}
              blocked={approvalBlocked(full)}
              approveBlocked={selfPrepared ? SELF_APPROVAL : null}
              shops={full.scopeShopIds}
            />
          ) : undefined
        }
      />
      <ReportFilters
        base={HREF}
        preset={r.range.preset}
        from={r.range.from}
        to={r.range.to}
        scope={r.locations}
        location={ctx.shops.length > 1 ? locationProps(ctx, r.locations) : null}
        payPeriods={r.payPeriods}
        presets={r.presets}
        standard={false}
        views={false}
      />
      <RangeNotices r={r} />

      {!view || !blocks.length ? (
        <Notice>None of the shops shown has hours or sales in these dates.</Notice>
      ) : !rates ? (
        <Notice>The Payroll Report shows pay rates and wages, so it needs &quot;See pay rates and labor cost&quot;.</Notice>
      ) : (
        <>
          {official && (
            <p className="text-sm text-zinc-600" data-testid="payroll-due">
              {dueLine(blocks)}
            </p>
          )}
          {official && status !== "locked" && <DueNotice blocks={blocks} />}
          {official && full && <ApprovalNotice view={full} approval={approval} status={status} preparers={preparers} />}
          {official && full && approvalBlocked(full) && status !== "locked" && (
            <Notice tone="red">
              {approvalBlocked(full)}, so the period can&apos;t be approved yet.{" "}
              {drill && (
                <Link href={`/admin/payroll/report?${drillQuery}`} className="font-medium underline">
                  See what to fix
                </Link>
              )}
            </Notice>
          )}

          {official ? (
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
                          href={`/admin/payroll/download?${runFileQuery(view, b.payGroupId)}`}
                          data-testid="isolved-shop-file"
                        >
                          {b.shop}
                          {b.payGroupCode && <span className="ml-1 font-normal text-zinc-500">({b.payGroupCode})</span>}
                        </a>
                      ))}
                      {r.kind === "pay_period" && can(ctx, reportExport("payroll_isolved")) && can(ctx, "payroll.export") && (
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
          ) : (
            <p className="text-sm text-zinc-500" data-testid="no-downloads">
              No downloads for a review: the Payroll Report file and the iSolved files are for a pay period, or whole Sunday–Saturday workweeks.
            </p>
          )}

          <Anomalies blocks={blocks} anomalies={view.anomalies} drillQuery={drillQuery} drill={drill} />

          {blocks.map((b) => (
            <LocationBlock key={b.shopId} b={b} drillQuery={drillQuery} drill={drill && !b.locked} />
          ))}

          <Summary blocks={blocks} />

          {official && <PayrollTrailCard trail={trail} names={names} />}
        </>
      )}
    </div>
  );
}

function Anomalies({ blocks, anomalies, drillQuery, drill }: { blocks: BlockView[]; anomalies: { staffId: string | null; shopId: string | null; kind: string; message: string }[]; drillQuery: string; drill: boolean }) {
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
              <Link href={`/admin/payroll/report?${drillQuery}#${a.shopId}-${a.staffId}`} className="text-brand-700 underline-offset-2 hover:underline">
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

/** "Period 22 · due in iSolved Wed Oct 21 · check Fri Oct 23", per set of shops when their dates differ. */
function dueLine(blocks: readonly BlockView[]) {
  const by = new Map<string, string[]>();
  for (const b of blocks) {
    const p = b.period;
    const k = `${p.number ? `Period ${String(p.number).padStart(2, "0")}` : "Whole workweeks (no period number)"} · due in iSolved ${formatDate(p.submitBy ?? p.checkDate, "EEE MMM d")} · check ${formatDate(p.checkDate, "EEE MMM d")}`;
    by.set(k, [...(by.get(k) ?? []), b.payGroupCode ? `${b.shop} (${b.payGroupCode})` : b.shop]);
  }
  const parts = [...by.entries()];
  return parts.length === 1 ? parts[0][0] : parts.map(([k, shops]) => `${shops.join(", ")}: ${k}`).join("; ");
}

function DueNotice({ blocks }: { blocks: readonly BlockView[] }) {
  const today = todayLocal();
  const open = blocks.filter((b) => !b.locked && b.period.submitBy);
  const late = open.filter((b) => b.period.submitBy < today);
  const dueToday = open.filter((b) => b.period.submitBy === today);
  if (late.length)
    return (
      <Notice tone="red">
        Hours were due in iSolved on {formatDate(late[0].period.submitBy, "EEEE, MMM d")} for {late.map((b) => b.shop).join(", ")}, and the period isn&apos;t locked yet.
      </Notice>
    );
  if (dueToday.length) return <Notice tone="amber">Hours are due in iSolved today for {dueToday.map((b) => b.shop).join(", ")}.</Notice>;
  return null;
}

function LocationBlock({ b, drillQuery, drill }: { b: BlockView; drillQuery: string; drill: boolean }) {
  const fill = titleFill(b.shop);
  const gp = b.totals.service - b.totals.totalWages;
  return (
    <Card data-testid="payroll-location">
      <div className="px-4 py-2 text-center font-semibold" style={fill ? { backgroundColor: `#${fill}` } : undefined}>
        {b.shop}
        {b.payGroupCode && <span className="ml-2 text-xs font-normal text-zinc-700">iSolved {b.payGroupCode}</span>}
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
                            <Link href={`/admin/payroll/report?${drillQuery}#${b.shopId}-${l.staffId}`} className="hover:underline" title="Drill down: hours by week, OT, and adjustments">
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
