import type { Metadata } from "next";
import { Empty, PageHeader } from "@/components/ui";
import { isValidLocalDate, localMinutesOf, todayLocal } from "@/lib/time";
import { requireStaff, workingShopId } from "@/server/auth/staff";
import { loadDayCalendar } from "@/server/calendar";
import { shopCatalog } from "@/server/catalog";
import { DayCalendar } from "./day-calendar";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ date?: string; shop?: string; appt?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const shopId = workingShopId(ctx, sp.shop);
  if (!shopId) return <Empty title="No shop assigned">Ask an admin to add you to a shop.</Empty>;
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : today;
  const [data, catalog] = await Promise.all([loadDayCalendar(shopId, date, ctx.isBarber ? ctx.staff.id : null), shopCatalog(shopId)]);
  return (
    <div>
      {ctx.currentShopId === null && (
        <PageHeader title="Calendar" subtitle="Brand view shows one shop at a time. Use the shop switcher to change." />
      )}
      <DayCalendar
        data={data}
        today={today}
        nowMin={date === today ? localMinutesOf(new Date()) : null}
        services={catalog.map((s) => ({ id: s.id, name: s.name, kind: s.kind, priceCents: s.priceCents, durationMin: s.durationMin }))}
        canManage={ctx.isAdmin || ctx.isManager}
        meId={ctx.staff.id}
        initialApptId={sp.appt ?? null}
      />
    </div>
  );
}
