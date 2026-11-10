import type { Metadata } from "next";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";

export const metadata: Metadata = { title: "Google review links" };

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "google_reviews", searchParams: await searchParams });
}
