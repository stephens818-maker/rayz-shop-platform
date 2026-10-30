import type { Metadata } from "next";
import type { ReactNode } from "react";
import { reportExport } from "@/domain/permissions";
import type { TipsPaidStatus } from "@/domain/staff-payouts";
import { type StaffContext, can } from "@/server/auth/staff";
import type { ReportData } from "@/server/report-data";
import { ReportPage } from "../../report-view";
import type { ReportParams } from "../../scope";

export const metadata: Metadata = { title: "Tips paid (iSolved)" };

type Period = { start: string; end: string; label: string; status: TipsPaidStatus };

/** Per pay period: the tips-paid CSV for iSolved, marked DRAFT until every row is final. */
function rowActions(data: ReportData, ctx: StaffContext): Record<string, (row: number) => ReactNode> {
  const { periods = [], shopParam = null } = data as { periods?: Period[]; shopParam?: string | null };
  if (!periods.length || !can(ctx, reportExport("payroll_tips_paid")) || !can(ctx, "payroll.export")) return {};
  return {
    periods: (i) => {
      const p = periods[i];
      if (!p) return null;
      const q = new URLSearchParams({ start: p.start, end: p.end });
      if (shopParam) q.set("shop", shopParam);
      return (
        <a
          className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
          href={`/admin/reports/payroll/tips-paid/file?${q}`}
          title={`Download ${p.label}'s tips paid${p.status === "draft" ? " (marked DRAFT until every row is final)" : ""}`}
          data-testid="tips-paid-file"
        >
          Tips paid CSV
        </a>
      );
    },
  };
}

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "payroll_tips_paid", searchParams: await searchParams, rowActions });
}
