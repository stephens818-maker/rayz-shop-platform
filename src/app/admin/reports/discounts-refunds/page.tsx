import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Discounts and refunds" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return <ReportPage report="discounts_refunds" searchParams={await searchParams} />;
}
