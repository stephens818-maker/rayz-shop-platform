import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { VISIBILITY_LABEL, scheduleLabel, sourceLabel } from "@/domain/report-builder";
import { guardPage } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { openSavedReport } from "@/server/report-builder/saved";
import { ReportBuilder } from "../builder";
import { builderOptions } from "../data";

export const metadata: Metadata = { title: "Custom report" };
export const dynamic = "force-dynamic";

export default async function CustomReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await guardPage("/admin/reports/custom/[id]");
  const { id } = await params;
  let r;
  try {
    r = await openSavedReport(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const options = await builderOptions(ctx);
  const row = r.row;
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title={row.name}
        subtitle={
          <>
            <Link href="/admin/reports/custom" className="underline">
              Custom reports
            </Link>{" "}
            · {sourceLabel(row.source)} · {r.mine ? "Yours" : `By ${r.owner}`} · {VISIBILITY_LABEL[row.visibility]}
            {r.schedule ? ` · ${scheduleLabel(r.schedule)}` : ""}
            {row.description ? <span className="block">{row.description}</span> : null}
          </>
        }
      />
      <ReportBuilder
        key={row.updatedAt.toISOString()}
        o={options}
        saved={{ id: row.id, name: row.name, description: row.description ?? "", visibility: row.visibility, roleIds: row.roleIds, schedule: r.schedule, morning: row.morning, owner: r.owner, mine: r.mine, mayEdit: r.mayEdit }}
        initial={r.definition}
      />
    </div>
  );
}
