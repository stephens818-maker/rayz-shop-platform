import type { Metadata } from "next";
import { ReportPage } from "../../report-view";
import type { ReportParams } from "../../scope";

export const metadata: Metadata = { title: "FICA tip credit (45B)" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "payroll_fica_tip_credit", searchParams: await searchParams });
}
