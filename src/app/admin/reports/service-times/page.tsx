import type { Metadata } from "next";
import type { ReactNode } from "react";
import { type StaffContext, can } from "@/server/auth/staff";
import type { ReportData } from "@/server/report-data";
import type { SuggestionRow } from "@/server/service-times-report";
import { ReportPage } from "../report-view";
import type { ReportParams } from "../scope";
import { AcceptSuggestion } from "./client";

export const metadata: Metadata = { title: "Service times" };

/** "Use N min" on each suggested booked time, for people who set barber durations. */
function rowActions(data: ReportData, ctx: StaffContext): Record<string, (row: number) => ReactNode> {
  const list = (data as { suggestions?: SuggestionRow[] }).suggestions ?? [];
  if (!can(ctx, "scheduling.timing") || !list.length) return {};
  return {
    suggestions: (i) => {
      const x = list[i];
      if (!x) return null;
      const s = x.suggestion;
      return (
        <AcceptSuggestion
          staffId={x.staffId}
          serviceId={x.serviceId}
          shopId={x.shopId}
          minutes={s.minutes}
          evidence={{ n: s.n, avgMin: s.avgMin, medianMin: s.medianMin, fromMin: s.currentMin }}
          label={`Book ${x.barber}'s ${x.service} at ${x.shop} for ${s.minutes} minutes from now on`}
        />
      );
    },
  };
}

export default async function Page({ searchParams }: { searchParams: Promise<ReportParams> }) {
  return ReportPage({ report: "service_times", searchParams: await searchParams, rowActions });
}
