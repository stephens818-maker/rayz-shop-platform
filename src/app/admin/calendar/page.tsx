import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CelebrationBanner } from "@/components/celebration";
import { Empty } from "@/components/ui";
import {
  addDays,
  formatDate,
  isValidLocalDate,
  localMinutesOf,
  todayLocal,
  weekdayOf,
} from "@/lib/time";
import { ShopRequired } from "../shop-pick";
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
import { isListStatus, loadAppointmentList } from "@/server/appointment-list";
import { barbersAt } from "@/server/barbers";
import { AppointmentList } from "./appointment-list";
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
    days?: string;
    status?: string;
  }>;
}) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/calendar");
  const shopId = workingShopId(ctx, sp.shop);
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : today;
  const manages = can(ctx, "calendar.manage");
  if (!shopId) {
    if (!ctx.shopIds.length) return <Empty title="No shop assigned">Ask an admin to add you to a shop.</Empty>;
    if (sp.view === "list" || sp.view === "week" || !manages) return <ShopRequired ctx={ctx} base="/admin/calendar" />;
    const q = date === today ? "" : `?date=${date}`;
    redirect(`/admin/calendar/board${q}`);
  }
  const shopName = ctx.shops.find((s) => s.id === shopId)?.name ?? "This shop";
  const shops = ctx.assignedShops.filter((s) => s.status !== "archived");
  const dayQuery = date === today ? "" : `&date=${date}`;
  const switcher = shops.length > 1 && (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Shop">
      <span className="mr-1 text-sm font-semibold text-zinc-900">{shopName}</span>
      {manages && (
        <Link href={date === today ? "/admin/calendar/board" : `/admin/calendar/board?date=${date}`} className="rounded-full px-3 py-1 text-sm ring-1 ring-zinc-300 hover:bg-zinc-50">
          All shops
        </Link>
      )}
      {shops.map((s) => (
        <Link key={s.id} href={`/admin/calendar?shop=${s.id}${dayQuery}`} className={s.id === shopId ? "rounded-full bg-ink-900 px-3 py-1 text-sm text-white" : "rounded-full px-3 py-1 text-sm ring-1 ring-zinc-300 hover:bg-zinc-50"}>
          {s.name}
        </Link>
      ))}
    </div>
  );
  // "See every barber's column" without managing the calendar: everyone's day, only their own to act on.
  const seesAll = manages || can(ctx, "calendar.view_all");
  const header = switcher;

  if (sp.view === "list") {
    const days = sp.days === "7" ? 7 : 1;
    const status = isListStatus(sp.status) ? sp.status : "all";
    const staffId = seesAll ? (sp.staff ?? null) : ctx.staff.id;
    const [list, barbers] = await Promise.all([
      loadAppointmentList(shopId, date, days, { staffId, status, privacy: await clientPolicy(ctx) }),
      seesAll ? barbersAt([shopId]) : null,
    ]);
    return (
      <div className="space-y-3">
        {header}
        <AppointmentList
          shop={list.shop}
          rows={list.rows}
          date={date}
          days={days}
          today={today}
          status={status}
          staffId={staffId}
          barbers={barbers?.filter((b) => b.active !== false).map((b) => ({ id: b.id, name: b.name })) ?? null}
          links={{ clients: can(ctx, "clients.view_all"), sales: can(ctx, "sales.view") }}
        />
      </div>
    );
  }

  if (sp.view === "week") {
    // Without "calendar.manage" or "calendar.view_all", people see only their own week.
    const weekStart = addDays(date, -weekdayOf(date));
    const [data, day] = await Promise.all([
      loadWeekCalendar(
        shopId,
        weekStart,
        seesAll ? (sp.staff ?? null) : ctx.staff.id,
        seesAll ? null : [ctx.staff.id],
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
        <WeekCalendar data={data} today={today} canPickBarber={seesAll} />
      </div>
    );
  }

  const policy = await clientPolicy(ctx);
  const [data, catalog, reasons, day] = await Promise.all([
    loadDayCalendar(
      shopId,
      date,
      seesAll ? null : ctx.staff.id,
      ctx,
      policy,
      reasonViewer(ctx),
      noteViewer(ctx, policy),
    ),
    shopCatalog(shopId),
    pickerReasons("blocks", shopId),
    date === today ? shopDay([shopId]) : null,
  ]);
  return (
    <div className="space-y-3">
      {header}
      {data.columns.every((c) => c.appts.length === 0) && (
        <p className="text-sm text-zinc-500">No appointments booked for {formatDate(date, "EEEE")}</p>
      )}
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
          clock: ctx.staff.kind === "shop" || can(ctx, "timeclock.punch") || can(ctx, "timeclock.edit_others") || can(ctx, "timesheet.edit"),
          clockOthers: ctx.staff.kind === "shop" || can(ctx, "timeclock.edit_others") || can(ctx, "timesheet.edit"),
        }}
        meId={ctx.staff.id}
        othersReadOnly={!manages}
        initialApptId={sp.appt ?? null}
        reasons={reasons}
      />
    </div>
  );
}
