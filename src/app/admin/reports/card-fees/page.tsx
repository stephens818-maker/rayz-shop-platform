import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Credit card fees" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "card_fees", searchParams: await searchParams });
}
