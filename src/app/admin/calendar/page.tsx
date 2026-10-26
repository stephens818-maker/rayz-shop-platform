import type { Metadata } from "next";
import Link from "next/link";
import { CelebrationBanner } from "@/components/celebration";
import { Empty, PageHeader } from "@/components/ui";
import {
  addDays,
  isValidLocalDate,
  localMinutesOf,
  todayLocal,
  weekdayOf,
} from "@/lib/time";
import {
  can,
  guardPage,
  reasonViewer,
  workingShopId,
} from "@/server/auth/staff";
import { pickerReasons } from "@/server/block-reasons";
import { loadDayCalendar, loadWeekCalendar } from "@/server/calendar";
import { noteViewer } from "@/server/client-notes";
import { clientPolicy } from "@/server/client-privacy";
import { shopCatalog } from "@/server/catalog";
import { shopDay } from "@/server/milestones/day";
import { entryFields } from "@/server/client-entry";
import { DayCalendar } from "./day-calendar";
import { WeekCalendar } from "./week-calendar";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: string;
    shop?: string;
    appt?: string;
    view?: string;
    staff?: string;
  }>;
}) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/calendar");
  const shopId = workingShopId(ctx, sp.shop);
  if (!shopId)
    return (
      <Empty title="No shop assigned">Ask an admin to add you to a shop.</Empty>
    );
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : today;
  const manages = can(ctx, "calendar.manage");
  const header = ctx.currentShopId === null && (
    <PageHeader
      title="Calendar"
      subtitle={
        <>
          The calendar shows one shop at a time. Use the shop switcher to change
          {manages && (
            <>
              , or see every shop on the{" "}
              <Link className="underline" href="/admin/calendar/board">
                all-shops day board
              </Link>
            </>
          )}
          .
        </>
      }
    />
  );

  if (sp.view === "week") {
    // Without "calendar.manage", people see only their own week.
    const weekStart = addDays(date, -weekdayOf(date));
    const [data, day] = await Promise.all([
      loadWeekCalendar(
        shopId,
        weekStart,
        manages ? (sp.staff ?? null) : ctx.staff.id,
        manages ? null : [ctx.staff.id],
        reasonViewer(ctx),
      ),
      today >= weekStart && today < addDays(weekStart, 7)
        ? shopDay([shopId])
        : null,
    ]);
    return (
      <div className="space-y-3">
        {header}
        <CelebrationBanner items={day?.calendar ?? []} />
        <WeekCalendar data={data} today={today} canPickBarber={manages} />
      </div>
    );
  }

  const policy = await clientPolicy(ctx);
  const [data, catalog, reasons, day] = await Promise.all([
    loadDayCalendar(
      shopId,
      date,
      manages ? null : ctx.staff.id,
      ctx,
      policy,
      reasonViewer(ctx),
      noteViewer(ctx, policy),
    ),
    shopCatalog(shopId),
    pickerReasons("blocks"),
    date === today ? shopDay([shopId]) : null,
  ]);
  return (
    <div className="space-y-3">
      {header}
      <CelebrationBanner items={day?.calendar ?? []} />
      <DayCalendar
        celebrating={day?.badges ?? {}}
        data={data}
        today={today}
        nowMin={date === today ? localMinutesOf(new Date()) : null}
        services={catalog.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          priceCents: s.priceCents,
          durationMin: s.durationMin,
        }))}
        canManage={{
          walkins: can(ctx, "walkins.manage"),
          sales: can(ctx, "sales.view"),
          schedules: can(ctx, "schedules.edit"),
          clients: can(ctx, "clients.view_all"),
          message: can(ctx, "clients.message"),
          entry: entryFields(policy),
          correctTimes: can(ctx, "service_times.correct"),
          callIns: can(ctx, "callins.mark"),
          clockBlocks: can(ctx, "blocks.others"),
          family: can(ctx, "clients.family"),
        }}
        meId={ctx.staff.id}
        initialApptId={sp.appt ?? null}
        reasons={reasons}
      />
    </div>
  );
}
