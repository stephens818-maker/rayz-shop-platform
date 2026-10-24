import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { reportsFor } from "@/domain/navigation";
import { guardPage } from "@/server/auth/staff";
import { usesCustomReports } from "@/server/report-builder/saved";

export const metadata: Metadata = { title: "Reports" };

/** The reports this person may open. Nothing else is listed, and each page checks again on the server. */
export default async function ReportsHub() {
  const ctx = await guardPage("/admin/reports");
  const list = reportsFor(ctx.permissions);
  const custom = usesCustomReports(ctx);
  if (list.length + (custom ? 1 : 0) === 1) redirect(custom ? "/admin/reports/custom" : list[0].href);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Reports" subtitle={`${list.length} reports available to you as ${ctx.staff.roleName}. CSV export is granted per report.`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {custom && (
          <Link href="/admin/reports/custom" className="group">
            <Card className="h-full p-4 ring-brand-200 transition group-hover:ring-zinc-400">
              <div className="font-medium">Custom reports</div>
              <div className="mt-1 text-xs text-zinc-500">Build your own customer report: pick columns, filter, group and total, then save, share, schedule or export it.</div>
            </Card>
          </Link>
        )}
        {list.map((r) => (
          <Link key={r.key} href={r.href} className="group">
            <Card className="h-full p-4 transition group-hover:ring-zinc-400">
              <div className="font-medium">{r.label}</div>
              <div className="mt-1 text-xs text-zinc-500">{"hint" in r && r.hint ? r.hint : r.canExport ? "View and export CSV" : "View only"}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
