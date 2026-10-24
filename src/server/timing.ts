import { and, asc, eq, inArray } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, shops, staff, staffServiceDurations, staffShops, Shop } from "@/db/schema";
import type { StaffPlan } from "@/domain/availability";
import { BookingPlan, IntervalSource, bookingPlan, resolveDuration, resolveInterval } from "@/domain/timing";
import type { EffectiveService } from "./catalog";

export const DEFAULT_INTERVAL = 15;

export async function brandInterval(tx: DBorTx = db): Promise<number> {
  const [row] = await tx.select({ n: brandSettings.slotIntervalMinutes }).from(brandSettings).limit(1);
  return row?.n ?? DEFAULT_INTERVAL;
}

/** The shop's interval and where it comes from (its own setting or the brand default). */
export async function shopInterval(shop: Pick<Shop, "slotIntervalMinutes">, tx: DBorTx = db) {
  return resolveInterval({ brand: await brandInterval(tx), shop: shop.slotIntervalMinutes });
}

export interface ResolvedInterval {
  minutes: number;
  source: IntervalSource;
}

/** Each barber's slot interval at this shop: barber at this shop, then barber, then shop, then brand. */
export async function staffIntervals(shop: Pick<Shop, "id" | "slotIntervalMinutes">, staffIds: string[], tx: DBorTx = db): Promise<Map<string, ResolvedInterval>> {
  const brand = await brandInterval(tx);
  const out = new Map<string, ResolvedInterval>();
  if (!staffIds.length) return out;
  const rows = await tx
    .select({ id: staff.id, barber: staff.slotIntervalMinutes, atShop: staffShops.slotIntervalMinutes })
    .from(staff)
    .leftJoin(staffShops, and(eq(staffShops.staffId, staff.id), eq(staffShops.shopId, shop.id)))
    .where(inArray(staff.id, staffIds));
  for (const r of rows) out.set(r.id, resolveInterval({ brand, shop: shop.slotIntervalMinutes, barber: r.barber, barberAtShop: r.atShop }));
  for (const id of staffIds) if (!out.has(id)) out.set(id, resolveInterval({ brand, shop: shop.slotIntervalMinutes }));
  return out;
}

/** Barbers' own durations for these services: at this shop, or everywhere. Keyed `${staffId}:${serviceId}`. */
async function barberDurations(shopId: string, staffIds: string[], serviceIds: string[], tx: DBorTx) {
  const out = new Map<string, { atShop?: number; everywhere?: number }>();
  if (!staffIds.length || !serviceIds.length) return out;
  const rows = await tx
    .select()
    .from(staffServiceDurations)
    .where(and(inArray(staffServiceDurations.staffId, staffIds), inArray(staffServiceDurations.serviceId, serviceIds)));
  for (const r of rows) {
    if (r.shopId !== null && r.shopId !== shopId) continue;
    const k = `${r.staffId}:${r.serviceId}`;
    const v = out.get(k) ?? {};
    if (r.shopId === null) v.everywhere = r.durationMin;
    else v.atShop = r.durationMin;
    out.set(k, v);
  }
  return out;
}

export interface StaffBooking {
  /** The items as this barber does them at this shop: their own durations where they have one. */
  items: EffectiveService[];
  plan: BookingPlan;
  interval: ResolvedInterval;
}

/**
 * What booking these items holds on each barber's calendar at this shop: their durations, the
 * services' buffers plus the shop's gap, and their interval (or the main service's own increment).
 */
export async function bookingPlans(shop: Shop, staffIds: string[], items: EffectiveService[], tx: DBorTx = db): Promise<Map<string, StaffBooking>> {
  const [intervals, durations] = await Promise.all([
    staffIntervals(shop, staffIds, tx),
    barberDurations(
      shop.id,
      staffIds,
      items.map((i) => i.id),
      tx,
    ),
  ]);
  const out = new Map<string, StaffBooking>();
  for (const staffId of staffIds) {
    const timed = items.map((i) => {
      const d = durations.get(`${staffId}:${i.id}`);
      return { ...i, durationMin: resolveDuration({ service: i.durationMin, barber: d?.everywhere, barberAtShop: d?.atShop }).minutes };
    });
    const interval = intervals.get(staffId)!;
    out.set(staffId, { items: timed, interval, plan: bookingPlan(timed, { intervalMin: interval.minutes, gapMin: shop.bufferMinutes }) });
  }
  return out;
}

export const toStaffPlans = (plans: Map<string, StaffBooking>): Record<string, StaffPlan> => Object.fromEntries([...plans].map(([id, b]) => [id, b.plan]));

export interface BarberRow {
  id: string;
  label: string;
  color: string;
  minutes: number | null;
  /** Their all-shops setting can only be changed by someone with access to every shop they work at. */
  canSetEverywhere: boolean;
  shops: { shopId: string; shopName: string; minutes: number | null; shopMinutes: number; shopSource: IntervalSource; effective: ResolvedInterval }[];
}

/** Barbers working at these shops (or one barber), with their interval at each of these shops and where it comes from. */
export async function barberIntervalRows(viewer: { shopIds: string[]; brandWide: boolean }, onlyStaffId?: string): Promise<BarberRow[]> {
  const brand = await brandInterval();
  const shopRows = await db.select({ id: shops.id, name: shops.name, minutes: shops.slotIntervalMinutes }).from(shops).where(inArray(shops.id, viewer.shopIds));
  const shopById = new Map(shopRows.map((s) => [s.id, s]));
  const links = await db
    .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, minutes: staffShops.slotIntervalMinutes, label: staff.displayLabel, color: staff.color, barberMinutes: staff.slotIntervalMinutes })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staff.active, true), eq(staff.kind, "person"), onlyStaffId ? eq(staff.id, onlyStaffId) : eq(staff.isBookable, true)))
    .orderBy(asc(staff.displayLabel));
  const byBarber = new Map<string, typeof links>();
  for (const l of links) byBarber.set(l.staffId, [...(byBarber.get(l.staffId) ?? []), l]);
  return [...byBarber.values()]
    .filter((ls) => ls.some((l) => shopById.has(l.shopId)))
    .map((ls) => {
      const b = ls[0];
      return {
        id: b.staffId,
        label: b.label,
        color: b.color,
        minutes: b.barberMinutes,
        canSetEverywhere: viewer.brandWide || ls.every((l) => shopById.has(l.shopId)),
        shops: ls
          .filter((l) => shopById.has(l.shopId))
          .map((l) => {
            const shop = shopById.get(l.shopId)!;
            const shopLevel = resolveInterval({ brand, shop: shop.minutes });
            return {
              shopId: l.shopId,
              shopName: shop.name,
              minutes: l.minutes,
              shopMinutes: shopLevel.minutes,
              shopSource: shopLevel.source,
              effective: resolveInterval({ brand, shop: shop.minutes, barber: b.barberMinutes, barberAtShop: l.minutes }),
            };
          })
          .sort((x, y) => x.shopName.localeCompare(y.shopName)),
      };
    });
}
