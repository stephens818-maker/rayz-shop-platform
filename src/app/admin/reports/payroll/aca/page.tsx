import type { Metadata } from "next";
import { ReportPage } from "../../report-view";
import type { ReportParams } from "../../scope";

export const metadata: Metadata = { title: "ACA hours" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "payroll_aca", searchParams: await searchParams });
}
