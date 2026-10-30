import type { Metadata } from "next";
import { ReportPage } from "../../report-view";
import type { ReportParams } from "../../scope";

export const metadata: Metadata = { title: "W-2 tip and overtime codes" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "payroll_w2_codes", searchParams: await searchParams });
}
