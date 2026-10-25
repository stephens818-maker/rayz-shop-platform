import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { usesCustomReports } from "@/server/report-builder/saved";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { reportFor, reportsFor } from "@/domain/navigation";
import { reportView } from "@/domain/permissions";
import { groupReports } from "@/domain/report-groups";
import { shortcutsFor } from "@/domain/report-shortcuts";
import { cleanTaxFiling } from "@/domain/sales-tax";

export const metadata: Metadata = { title: "Reports" };

/** The reports this person may open. Nothing else is listed, and each page checks again on the server. */
export default async function ReportsHub() {
  const ctx = await guardPage("/admin/reports");
  const list = reportsFor(ctx.permissions);
  const custom = usesCustomReports(ctx);
  const groups = groupReports(list);
  if (list.length + (custom ? 1 : 0) === 1) redirect(custom ? "/admin/reports/custom" : list[0].href);
  const [states, settings] = await Promise.all([
    ctx.shopIds.length ? db.select({ state: shops.state }).from(shops).where(inArray(shops.id, ctx.shopIds)) : Promise.resolve([]),
    db.query.brandSettings.findFirst({ columns: { taxFiling: true } }),
  ]);
  const saved = shortcutsFor(
    states.map((s) => s.state),
    cleanTaxFiling(settings?.taxFiling),
  ).filter((x) => ctx.permissions.has(reportView(x.report)));
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Reports" subtitle={`${list.length} reports available to you as ${ctx.staff.roleName}. CSV export is granted per report.`} />
      {saved.length > 0 && (
        <section aria-label="Saved reports" className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-zinc-700">Saved reports</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {saved.map((x) => (
              <Link key={x.label} href={`${reportFor(x.report).href}${x.query ? `?${x.query}` : ""}`} className="group">
                <Card className="h-full p-3 transition group-hover:ring-zinc-400">
                  <div className="text-sm font-medium">{x.label}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{x.hint}</div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
      {custom && (
        <Link href="/admin/reports/custom" className="group mb-6 block">
          <Card className="p-4 ring-brand-200 transition group-hover:ring-zinc-400">
            <div className="font-medium">Custom reports</div>
            <div className="mt-1 text-xs text-zinc-500">Build your own customer report: pick columns, filter, group and total, then save, share, schedule or export it.</div>
          </Card>
        </Link>
      )}
      {groups.length > 1 && (
        <nav aria-label="Report categories" className="mb-4 flex flex-wrap gap-1 text-sm">
          {groups.map((g) => (
            <a key={g.id} href={`#${g.id}`} className="rounded-md px-2.5 py-1 text-zinc-600 ring-1 ring-zinc-200 hover:bg-zinc-100">
              {g.label} <span className="text-zinc-400">{g.reports.length}</span>
            </a>
          ))}
        </nav>
      )}
      {groups.map((g) => (
        <section key={g.id} id={g.id} aria-label={g.label} className="mb-6 scroll-mt-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-700">{g.label}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.reports.map((r) => (
              <Link key={r.key} href={r.href} className="group">
                <Card className="h-full p-4 transition group-hover:ring-zinc-400">
                  <div className="font-medium">{r.label}</div>
                  <div className="mt-1 text-xs text-zinc-500">{"hint" in r && r.hint ? r.hint : r.canExport ? "View and export CSV" : "View only"}</div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
