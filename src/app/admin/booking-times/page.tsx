import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { services, shopServices, shops, staffServiceDurations } from "@/db/schema";
import { Empty, Notice, PageHeader } from "@/components/ui";
import { guardPage, workingShopId } from "@/server/auth/staff";
import { barberIntervalRows, brandInterval } from "@/server/timing";
import { BarberDurationRow, BarberDurationsCard, BarberIntervalsCard, BrandIntervalCard, ServiceTimingCard, ShopIntervalsCard } from "./editors";

export const metadata: Metadata = { title: "Booking times" };

export default async function BookingTimesPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/booking-times");
  const { shop: requested } = await searchParams;
  const shopId = workingShopId(ctx, requested);
  const [brand, shopRows] = await Promise.all([brandInterval(), db.select({ id: shops.id, name: shops.name, minutes: shops.slotIntervalMinutes }).from(shops).where(and(inArray(shops.id, ctx.shopIds), ne(shops.status, "archived"))).orderBy(asc(shops.name))]);
  if (!shopRows.length) return <Empty title="No shops in your access" />;
  const shopById = new Map(shopRows.map((s) => [s.id, s]));

  const barbers = await barberIntervalRows(ctx);

  const working = shopId ? shopById.get(shopId) : undefined;
  const [catalog, menu, durations] = await Promise.all([
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.kind), asc(services.sortOrder), asc(services.name)),
    working ? db.select().from(shopServices).where(eq(shopServices.shopId, working.id)) : Promise.resolve([]),
    barbers.length
      ? db
          .select()
          .from(staffServiceDurations)
          .where(
            inArray(
              staffServiceDurations.staffId,
              barbers.map((b) => b.id),
            ),
          )
      : Promise.resolve([]),
  ]);
  const onMenu = new Map(menu.filter((m) => m.enabled).map((m) => [m.serviceId, m.durationMin]));
  const serviceById = new Map(catalog.map((s) => [s.id, s]));
  const barberById = new Map(barbers.map((b) => [b.id, b]));
  const durationRows: BarberDurationRow[] = durations
    .filter((d) => serviceById.has(d.serviceId) && (d.shopId === null || shopById.has(d.shopId)))
    .map((d) => ({
      staffId: d.staffId,
      barber: barberById.get(d.staffId)!.label,
      serviceId: d.serviceId,
      service: serviceById.get(d.serviceId)!.name,
      shopId: d.shopId,
      shop: d.shopId ? shopById.get(d.shopId)!.name : "Every shop",
      minutes: d.durationMin,
      usual: serviceById.get(d.serviceId)!.defaultDurationMin,
    }))
    .sort((a, b) => a.barber.localeCompare(b.barber) || a.service.localeCompare(b.service));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Booking times"
        subtitle="Which start times are offered online and at the front desk, and how long each booking holds the chair. The most specific interval wins: a barber at one shop, then the barber, then the shop, then the brand."
        actions={
          shopRows.length > 1 && (
            <nav aria-label="Shop for durations" className="flex flex-wrap gap-1 text-sm">
              {shopRows.map((s) => (
                <Link key={s.id} href={`/admin/booking-times?shop=${s.id}`} aria-current={s.id === working?.id ? "page" : undefined} className={s.id === working?.id ? "rounded-md bg-ink-900 px-2 py-1 text-white" : "rounded-md px-2 py-1 text-zinc-600 hover:bg-zinc-100"}>
                  {s.name}
                </Link>
              ))}
            </nav>
          )
        }
      />
      <Notice tone="blue">Changing an interval or a duration only changes new availability. Appointments already booked keep their times, and the calendar shows each barber on their own grid.</Notice>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-5">
          <BrandIntervalCard minutes={brand} canEdit={ctx.brandWide} />
          <ShopIntervalsCard brand={brand} shops={shopRows} />
        </div>
        <BarberIntervalsCard barbers={barbers} />
      </div>
      <ServiceTimingCard
        canEditBrand={ctx.brandWide}
        shop={working ? { id: working.id, name: working.name } : null}
        rows={catalog.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          defaultDurationMin: s.defaultDurationMin,
          durationStepMin: s.durationStepMin,
          bookingIncrementMin: s.bookingIncrementMin,
          bufferBeforeMin: s.bufferBeforeMin,
          bufferAfterMin: s.bufferAfterMin,
          shopDurationMin: onMenu.has(s.id) ? onMenu.get(s.id) : undefined,
        }))}
      />
      {barbers.length > 0 && (
        <BarberDurationsCard
          rows={durationRows}
          barbers={barbers.map((b) => ({ id: b.id, label: b.label, canSetEverywhere: b.canSetEverywhere, shops: b.shops.map((s) => ({ id: s.shopId, name: s.shopName })) }))}
          services={catalog.map((s) => ({ id: s.id, name: s.name, step: s.durationStepMin, minutes: s.defaultDurationMin }))}
        />
      )}
    </div>
  );
}
