import type { Metadata } from "next";
import Link from "next/link";
import { Button, Notice, PageHeader, cx } from "@/components/ui";
import { payPeriodByIndex, payPeriodFor } from "@/domain/payroll";
import { formatDate, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { REPORT_LOADERS } from "@/server/report-data";
import { LocationField, LocationNotice, ViewToggle, locationProps, reportQuery } from "../reports/filters";
import { ReportTableCard, ReportTabs } from "../reports/report-view";
import { resolveLocations } from "../reports/scope";

export const metadata: Metadata = { title: "Payroll tips" };

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ p?: string; shop?: string | string[]; view?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/payroll");
  const current = payPeriodFor(todayLocal());
  const index = sp.p !== undefined && /^-?\d+$/.test(sp.p) ? Number(sp.p) : current.index - 1;
  const period = payPeriodByIndex(index);
  const l = await resolveLocations(ctx, sp);
  const t0 = performance.now();
  const data = await REPORT_LOADERS.tips_payroll({ scope: { shopIds: l.selection.shopIds, from: period.start, to: period.end }, loc: l.loc, viewer: ctx, params: {} });
  const ms = Math.round(performance.now() - t0);
  const choices = Array.from({ length: 6 }, (_, i) => payPeriodByIndex(current.index - i));
  const canExport = can(ctx, "report.tips_payroll.export");
  const csv = (table: string) => (canExport ? `/admin/reports/export?${reportQuery(l, { type: "tips_payroll", table, from: period.start, to: period.end })}` : null);
  const here = (extra: Record<string, string | null>, view = l.loc.view) =>
    `/admin/payroll?${reportQuery({ ...l, loc: { ...l.loc, view } }, { p: String(period.index), ...extra })}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Payroll: tips by pay period"
        subtitle={
          <>
            {l.label} · Bi-weekly, Sunday to Saturday. {formatDate(period.start, "MMM d")} – {formatDate(period.end, "MMM d, yyyy")}
            {period.index === current.index && " (in progress)"}
            {l.loc.view === "shops" && " · by location"}
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">loaded in {ms} ms</span>
          </>
        }
        actions={
          canExport ? (
            <a className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700" href={csv("payroll")!}>
              Export tips CSV
            </a>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active="tips_payroll" />
      <div className="no-print mb-4 flex flex-wrap gap-1.5">
        {choices.map((c) => (
          <Link
            key={c.index}
            href={here({ p: String(c.index) })}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", c.index === period.index ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.index === current.index && " · current"}
          </Link>
        ))}
      </div>
      {ctx.shops.length > 1 && (
        <form key={l.shopParam ?? ""} className="no-print mb-4 flex flex-wrap items-end gap-2 text-sm" action="/admin/payroll">
          <input type="hidden" name="p" value={period.index} />
          <LocationField p={locationProps(ctx, l)} />
          <Button type="submit" variant="dark" size="sm" className="h-9">
            Apply
          </Button>
          {l.selection.shopIds.length > 1 && (
            <div className="ml-auto self-center">
              <ViewToggle view={l.loc.view} href={(v) => here({}, v)} />
            </div>
          )}
        </form>
      )}
      <LocationNotice locations={l} />
      <div className="mb-4">
        <Notice tone="blue">
          Hours stay in the HR system, so there&apos;s no clock-in here. Sales and tips count at the shop where each ticket was rung up, so a barber who works at more than one shop
          is paid out per shop.
        </Notice>
      </div>
      {data.tables.map((t) => (
        <ReportTableCard key={t.id} t={t} csv={csv(t.id)} />
      ))}
    </div>
  );
}
