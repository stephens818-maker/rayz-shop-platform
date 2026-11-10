import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Cash drawer report" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "cash_drawer", searchParams: await searchParams });
}
