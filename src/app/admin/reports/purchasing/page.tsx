import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Purchase orders and vendor spend" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "purchasing", searchParams: await searchParams });
}
