import type { Metadata } from "next";
import { Empty, PageHeader } from "@/components/ui";
import { addDays, isValidLocalDate, localMinutesOf, todayLocal, weekdayOf } from "@/lib/time";
import { can, guardPage, reasonViewer, workingShopId } from "@/server/auth/staff";
import { pickerReasons } from "@/server/block-reasons";
import { loadDayCalendar, loadWeekCalendar } from "@/server/calendar";
import { clientPolicy } from "@/server/client-privacy";
import { shopCatalog } from "@/server/catalog";
import { DayCalendar } from "./day-calendar";
import { WeekCalendar } from "./week-calendar";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ date?: string; shop?: string; appt?: string; view?: string; staff?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/calendar");
  const shopId = workingShopId(ctx, sp.shop);
  if (!shopId) return <Empty title="No shop assigned">Ask an admin to add you to a shop.</Empty>;
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : today;
  const manages = can(ctx, "calendar.manage");
  const header = ctx.currentShopId === null && <PageHeader title="Calendar" subtitle="The calendar shows one shop at a time. Use the shop switcher to change." />;

  if (sp.view === "week") {
    // Without "calendar.manage", people see only their own week.
    const data = await loadWeekCalendar(shopId, addDays(date, -weekdayOf(date)), manages ? (sp.staff ?? null) : ctx.staff.id, manages ? null : [ctx.staff.id], reasonViewer(ctx));
    return (
      <div>
        {header}
        <WeekCalendar data={data} today={today} canPickBarber={manages} />
      </div>
    );
  }

  const policy = await clientPolicy(ctx);
  const [data, catalog, reasons] = await Promise.all([
    loadDayCalendar(shopId, date, manages ? null : ctx.staff.id, ctx, policy, reasonViewer(ctx)),
    shopCatalog(shopId),
    pickerReasons("blocks"),
  ]);
  return (
    <div>
      {header}
      <DayCalendar
        data={data}
        today={today}
        nowMin={date === today ? localMinutesOf(new Date()) : null}
        services={catalog.map((s) => ({ id: s.id, name: s.name, kind: s.kind, priceCents: s.priceCents, durationMin: s.durationMin }))}
        canManage={{ walkins: can(ctx, "walkins.manage"), sales: can(ctx, "sales.view"), schedules: can(ctx, "schedules.edit"), clients: can(ctx, "clients.view_all"), message: can(ctx, "clients.message"), addPhone: policy.canAdd("phone"), correctTimes: can(ctx, "service_times.correct") }}
        meId={ctx.staff.id}
        initialApptId={sp.appt ?? null}
        reasons={reasons}
      />
    </div>
  );
}
