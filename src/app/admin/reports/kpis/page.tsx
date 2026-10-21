import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Retention and rebook KPIs" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "kpis", searchParams: await searchParams });
}
