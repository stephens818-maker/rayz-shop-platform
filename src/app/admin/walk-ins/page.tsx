import type { Metadata } from "next";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { appointments, services, staffSchedules } from "@/db/schema";
import { Empty, PageHeader } from "@/components/ui";
import { localMinutesOf, todayLocal, weekdayOf } from "@/lib/time";
import { guardPage, workingShopId } from "@/server/auth/staff";
import { estimateWait, waitlistForShop } from "@/server/booking";
import { clientPolicy } from "@/server/client-privacy";
import { shopBarbers, shopCatalog } from "@/server/catalog";
import { WalkIns } from "./walk-ins";

export const metadata: Metadata = { title: "Walk-ins" };

export default async function WalkInsPage() {
  const ctx = await guardPage("/admin/walk-ins");
  const shopId = workingShopId(ctx);
  if (!shopId) return <Empty title="No shop selected" />;
  const shop = ctx.shops.find((s) => s.id === shopId)!;
  const now = new Date();
  const today = todayLocal(now);
  const nowMin = localMinutesOf(now);
  const [catalog, barbers, waitlist, policy] = await Promise.all([shopCatalog(shopId), shopBarbers(shopId), waitlistForShop(shopId), clientPolicy(ctx)]);
  const ids = barbers.map((b) => b.id);
  const [scheds, current, svcNames] = await Promise.all([
    ids.length ? db.select().from(staffSchedules).where(and(inArray(staffSchedules.staffId, ids), eq(staffSchedules.weekday, weekdayOf(today)))) : [],
    ids.length
      ? db
          .select({ staffId: appointments.staffId, endsAt: appointments.endsAt, startsAt: appointments.startsAt, status: appointments.status })
          .from(appointments)
          .where(
            and(
              inArray(appointments.staffId, ids),
              inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service"]),
              lt(appointments.startsAt, new Date(now.getTime() + 45 * 60_000)),
              gt(appointments.endsAt, now),
            ),
          )
      : [],
    waitlist.length ? db.select({ id: services.id, name: services.name }).from(services).where(inArray(services.id, waitlist.map((w) => w.serviceId!).filter(Boolean))) : [],
  ]);
  const board = barbers
    .map((b) => {
      const here = scheds.filter((s) => s.staffId === b.id && s.shopId === shopId);
      const working = here.some((s) => s.startMin <= nowMin && s.endMin > nowMin);
      const elsewhere = scheds.some((s) => s.staffId === b.id && s.shopId !== shopId && s.startMin <= nowMin && s.endMin > nowMin);
      const mine = current.filter((c) => c.staffId === b.id).sort((a, z) => a.startsAt.getTime() - z.startsAt.getTime());
      const busyNow = mine.find((m) => m.startsAt <= now);
      const nextAt = mine.find((m) => m.startsAt > now)?.startsAt ?? null;
      const state: "free" | "busy" | "off" = !working ? "off" : busyNow ? "busy" : "free";
      return {
        id: b.id,
        label: b.displayName,
        color: b.color,
        state: elsewhere && !working ? ("off" as const) : state,
        note: elsewhere && !working ? "At another shop" : busyNow ? `Busy until ${busyNow.endsAt.toISOString()}` : nextAt ? `Next appt ${nextAt.toISOString()}` : working ? "Open" : "Not working now",
        until: busyNow?.endsAt.toISOString() ?? nextAt?.toISOString() ?? null,
        untilKind: busyNow ? ("busy" as const) : nextAt ? ("next" as const) : null,
      };
    })
    .filter((b) => b.state !== "off" || scheds.some((s) => s.staffId === b.id && s.shopId === shopId));
  const wait = await estimateWait(shopId, board.filter((b) => b.state !== "off").map((b) => b.id), now);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Walk-ins & waitlist" subtitle={`${shop.name} · current quoted wait about ${wait} min`} />
      {barbers.length === 0 ? (
        <Empty title={`No barbers are set up at ${shop.name} yet`}>Walk-ins need at least one barber with hours at this shop. Add one under Staff &amp; schedules.</Empty>
      ) : (
        <WalkIns
          shopId={shopId}
          canAddPhone={policy.canAdd("phone")}
          services={catalog.filter((s) => s.kind === "service").map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents }))}
          barbers={board}
          waitlist={waitlist.map((w) => ({
            id: w.id,
            name: w.name,
            hasPhone: !!w.phone,
            status: w.status,
            service: svcNames.find((s) => s.id === w.serviceId)?.name ?? "—",
            preferredStaffId: w.preferredStaffId,
            quotedWaitMin: w.quotedWaitMin,
            joinedAt: w.joinedAt.toISOString(),
          }))}
        />
      )}
    </div>
  );
}
