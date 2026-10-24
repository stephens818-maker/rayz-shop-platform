import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { DEFAULT_CUSTOMER_REPORT } from "@/domain/report-builder";
import { guardPage } from "@/server/auth/staff";
import { ReportBuilder } from "../builder";
import { builderOptions } from "../data";

export const metadata: Metadata = { title: "New custom report" };
export const dynamic = "force-dynamic";

export default async function NewCustomReportPage() {
  const ctx = await guardPage("/admin/reports/custom/new");
  const options = await builderOptions(ctx);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="New custom report"
        subtitle={
          <>
            <Link href="/admin/reports/custom" className="underline">
              Custom reports
            </Link>{" "}
            · Tick fields to add columns; the preview updates as you go.
          </>
        }
      />
      <ReportBuilder o={options} saved={null} initial={DEFAULT_CUSTOMER_REPORT} />
    </div>
  );
}
