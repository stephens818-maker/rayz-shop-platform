import type { Metadata } from "next";
import type { ReactNode } from "react";
import { reportExport } from "@/domain/permissions";
import { type StaffContext, can } from "@/server/auth/staff";
import type { IsolvedPeriod } from "@/server/payroll/reports";
import type { ReportData } from "@/server/report-data";
import { ReportPage } from "../../report-view";
import type { ReportParams } from "../../scope";
import { IsolvedSentControl } from "./client";

export const metadata: Metadata = { title: "iSolved export preview" };

const STATUS_TONE: Record<IsolvedPeriod["status"], string> = {
  draft: "bg-amber-50 text-amber-800 ring-amber-200",
  approved: "bg-sky-50 text-sky-800 ring-sky-200",
  sent: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};

/** Per pay period: the one-click iSolved file, and marking it sent (or undoing that) for brand approvers. */
function rowActions(data: ReportData, ctx: StaffContext): Record<string, (row: number) => ReactNode> {
  const { periods = [], shopParam = null } = data as { periods?: IsolvedPeriod[]; shopParam?: string | null };
  if (!periods.length) return {};
  const download = can(ctx, reportExport("payroll_isolved")) && can(ctx, "payroll.export");
  const approve = can(ctx, "payroll.approve") && ctx.brandWide;
  if (!download && !approve) return {};
  return {
    periods: (i) => {
      const p = periods[i];
      if (!p) return null;
      const q = new URLSearchParams({ start: p.start, end: p.end });
      if (shopParam) q.set("shop", shopParam);
      return (
        <span className="flex flex-wrap items-start justify-end gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_TONE[p.status]}`}>{p.status === "sent" ? "Sent" : p.status === "approved" ? "Approved" : "Draft"}</span>
          {download && (
            <a
              className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
              href={`/admin/reports/payroll/isolved/file?${q}`}
              title={`Download ${p.label}'s iSolved file${p.status === "draft" ? " (marked DRAFT until it's approved and locked)" : ""}`}
              data-testid="isolved-file"
            >
              iSolved export
            </a>
          )}
          {approve && <IsolvedSentControl start={p.start} end={p.end} label={p.label} sent={p.status === "sent"} blocked={p.blocked} locks={!p.locked} />}
        </span>
      );
    },
  };
}

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "payroll_isolved", searchParams: await searchParams, rowActions });
}
