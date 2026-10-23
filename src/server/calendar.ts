import "server-only";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, sales, shopClosures, shopHours, shops, staff, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import type { RatingSummary } from "@/domain/ratings";
import type { TimesView } from "@/domain/service-times";
import type { IntervalSource } from "@/domain/timing";
import { LocalDate, endOfLocalDay, localMinutesOf, localDateOf, startOfLocalDay, weekdayOf } from "@/lib/time";
import type { ClientPolicy } from "./client-privacy";
import { Tenant, hasShop } from "./tenant";
import { staffIntervals } from "./timing";
import { ratingSummaries } from "./ratings";
import { timesFor } from "./service-times";
import { staffingFor } from "./staff-time";

export interface CalAppt {
  id: string;
  code: string;
  startMin: number;
  endMin: number;
  startsAt: string;
  status: string;
  source: string;
  customerId: string | null;
  customerName: string;
  /** As the viewer may see it (usually masked); calls and texts go through the shop line. */
  phone: string | null;
  hasPhone: boolean;
  smsOptIn: boolean;
  services: string[];
  estimateCents: number;
  notes: string | null;
  /** Staff-only star average for the client. */
  rating: RatingSummary | null;
  anyBarber: boolean;
  saleId: string | null;
  saleStatus: string | null;
  /** Prep and cleanup held around it, as booked. */
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Booked off the grid, into buffer time or outside hours. */
  squeezed: boolean;
  /** Arrival, Start, Finish and checkout as recorded, with who recorded each. */
  times: TimesView | null;
}

export interface CalColumn {
  id: string;
  label: string;
  color: string;
  spans: { startMin: number; endMin: number }[];
  /** This barber's slot interval at this shop and where it comes from; their rows step by it from the start of each stretch they work. */
  intervalMin: number;
  intervalSource: IntervalSource;
  gridStarts: number[];
  blocks: { id: string; startMin: number; endMin: number; reason: string; kind: string; category: string; recurring: boolean; fromRequest: boolean }[];
  /** `shop` is null for a shop outside the viewer's workspace. */
  elsewhere: { startMin: number; endMin: number; shop: string | null }[];
  appts: CalAppt[];
}

export interface DayCalendarData {
  date: LocalDate;
  shop: { id: string; name: string; slug: string };
  closed: string | null;
  openMin: number | null;
  closeMin: number | null;
  rangeStart: number;
  rangeEnd: number;
  columns: CalColumn[];
  /** Barbers here who are off for some or all of the day, or have time off waiting for a manager. */
  off: { staffId: string; label: string; allDay: boolean; spans: { startMin: number; endMin: number; reason: string }[]; pending: boolean }[];
}

const clampDay = (d: Date, date: LocalDate) => {
  const m = localMinutesOf(d);
  const dd = localDateOf(d);
  if (dd < date) return 0;
  if (dd > date) return 24 * 60;
  return m;
};

/**
 * `viewer` is the workspace looking: barbers' time at shops outside it shows without the shop's name.
 * `privacy` is what they may see of clients: phones and ratings come back already masked or dropped.
 */
export async function loadDayCalendar(
  shopId: string,
  date: LocalDate,
  onlyStaffId: string | null,
  viewer: Pick<Tenant, "shopIds" | "brandWide">,
  privacy: Pick<ClientPolicy, "show" | "stars">,
): Promise<DayCalendarData> {
  const shopLabel = (id: string, name: string) => (viewer.brandWide || hasShop(viewer, id) ? name : null);
  const dayStart = startOfLocalDay(date);
  const dayEnd = endOfLocalDay(date);
  const wd = weekdayOf(date);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw new Error("shop not found");

  const [hours, closure, links, schedRows, apptRows] = await Promise.all([
    db.select().from(shopHours).where(and(eq(shopHours.shopId, shopId), eq(shopHours.weekday, wd))),
    db.query.shopClosures.findFirst({ where: and(eq(shopClosures.shopId, shopId), eq(shopClosures.date, date)) }),
    db
      .select({ id: staff.id, label: staff.displayLabel, color: staff.color, active: staff.active, isBookable: staff.isBookable })
      .from(staffShops)
      .innerJoin(staff, eq(staff.id, staffShops.staffId))
      .where(eq(staffShops.shopId, shopId)),
    db.select().from(staffSchedules).where(and(eq(staffSchedules.shopId, shopId), eq(staffSchedules.weekday, wd))),
    db
      .select({
        a: appointments,
        firstName: customers.firstName,
        lastName: customers.lastName,
        phone: customers.phone,
        smsOptIn: customers.smsOptIn,
        saleId: sales.id,
        saleStatus: sales.status,
      })
      .from(appointments)
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .leftJoin(sales, and(eq(sales.appointmentId, appointments.id), ne(sales.status, "voided")))
      .where(and(eq(appointments.shopId, shopId), lt(appointments.startsAt, dayEnd), gt(appointments.endsAt, dayStart)))
      .orderBy(asc(appointments.startsAt)),
  ]);

  const scheduledIds = new Set(schedRows.map((s) => s.staffId));
  const apptStaff = new Set(apptRows.filter((r) => r.a.status !== "cancelled").map((r) => r.a.staffId));
  let cols = links.filter((l) => (l.active && scheduledIds.has(l.id)) || apptStaff.has(l.id));
  if (onlyStaffId) cols = cols.filter((c) => c.id === onlyStaffId);
  cols.sort((a, b) => a.label.localeCompare(b.label));
  const ids = cols.map((c) => c.id);

  const [blocks, elsewhere, items, ratings] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(timeBlocks)
          .where(and(inArray(timeBlocks.staffId, ids), lt(timeBlocks.startsAt, dayEnd), gt(timeBlocks.endsAt, dayStart), or(isNull(timeBlocks.shopId), eq(timeBlocks.shopId, shopId))))
      : [],
    ids.length
      ? db
          .select({ staffId: appointments.staffId, startsAt: appointments.startsAt, endsAt: appointments.endsAt, shopId: shops.id, shop: shops.name })
          .from(appointments)
          .innerJoin(shops, eq(shops.id, appointments.shopId))
          .where(
            and(
              inArray(appointments.staffId, ids),
              ne(appointments.shopId, shopId),
              inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service", "completed"]),
              lt(appointments.startsAt, dayEnd),
              gt(appointments.endsAt, dayStart),
            ),
          )
      : [],
    apptRows.length
      ? db.select().from(appointmentItems).where(inArray(appointmentItems.appointmentId, apptRows.map((r) => r.a.id))).orderBy(asc(appointmentItems.kind))
      : [],
    ratingSummaries(apptRows.map((r) => r.a.customerId)),
  ]);
  const times = await timesFor(apptRows.map((r) => r.a.id));

  const intervals = await staffIntervals(shop, ids);
  const stretchStarts = (spans: { startMin: number; endMin: number }[]) =>
    [...new Set(spans.flatMap((sp) => hours.filter((h) => h.openMin < sp.endMin && sp.startMin < h.closeMin).map((h) => Math.max(h.openMin, sp.startMin))))].sort((a, b) => a - b);

  // Barbers working elsewhere today also show their other-shop schedule as "elsewhere".
  const otherScheds = ids.length
    ? await db
        .select({ staffId: staffSchedules.staffId, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin, shopId: shops.id, shop: shops.name })
        .from(staffSchedules)
        .innerJoin(shops, eq(shops.id, staffSchedules.shopId))
        .where(and(inArray(staffSchedules.staffId, ids), eq(staffSchedules.weekday, wd), ne(staffSchedules.shopId, shopId)))
    : [];

  const columns: CalColumn[] = cols.map((c) => {
    const spans = schedRows.filter((s) => s.staffId === c.id).map((s) => ({ startMin: s.startMin, endMin: s.endMin }));
    const interval = intervals.get(c.id)!;
    return {
      id: c.id,
      label: c.label,
      color: c.color,
      spans,
      intervalMin: interval.minutes,
      intervalSource: interval.source,
      gridStarts: stretchStarts(spans),
      blocks: blocks
        .filter((b) => b.staffId === c.id)
        .map((b) => ({
          id: b.id,
          startMin: clampDay(b.startsAt, date),
          endMin: clampDay(b.endsAt, date),
          reason: b.reason,
          kind: b.kind,
          category: b.category,
          recurring: b.seriesId !== null,
          fromRequest: b.requestId !== null,
        })),
      elsewhere: [
        ...otherScheds.filter((o) => o.staffId === c.id).map((o) => ({ startMin: o.startMin, endMin: o.endMin, shop: shopLabel(o.shopId, o.shop) })),
        ...elsewhere.filter((e) => e.staffId === c.id).map((e) => ({ startMin: clampDay(e.startsAt, date), endMin: clampDay(e.endsAt, date), shop: shopLabel(e.shopId, e.shop) })),
      ],
      appts: apptRows
        .filter((r) => r.a.staffId === c.id)
        .map((r) => ({
          id: r.a.id,
          code: r.a.code,
          startMin: clampDay(r.a.startsAt, date),
          endMin: clampDay(r.a.endsAt, date),
          startsAt: r.a.startsAt.toISOString(),
          status: r.a.status,
          source: r.a.source,
          customerId: r.a.customerId,
          customerName: r.firstName ? `${r.firstName}${r.lastName ? ` ${r.lastName}` : ""}` : (r.a.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
          phone: privacy.show("phone", r.phone),
          hasPhone: !!r.phone,
          smsOptIn: !!r.smsOptIn,
          services: items.filter((i) => i.appointmentId === r.a.id).map((i) => i.name),
          estimateCents: r.a.estimateCents,
          notes: r.a.notes,
          rating: r.a.customerId ? privacy.stars(ratings.get(r.a.customerId)) : null,
          anyBarber: r.a.anyBarber,
          saleId: r.saleId,
          saleStatus: r.saleStatus,
          bufferBeforeMin: r.a.bufferBeforeMinutes,
          bufferAfterMin: r.a.bufferMinutes,
          squeezed: r.a.squeezed,
          times: times.get(r.a.id) ?? null,
        })),
    };
  });

  const staffing = await staffingFor([shopId], date, date, onlyStaffId ? [onlyStaffId] : null);
  const off = staffing
    .filter((r) => r.status === "off" || r.status === "partly_off" || r.pending || (r.hasTimeOff && r.status === "not_scheduled"))
    .map((r) => ({
      staffId: r.staffId,
      label: r.label,
      allDay: r.status === "off",
      spans: r.blocks.filter((b) => b.category === "time_off").map((b) => ({ startMin: b.startMin, endMin: b.endMin, reason: b.reason })),
      pending: r.pending,
    }));

  const openMin = hours.length ? Math.min(...hours.map((h) => h.openMin)) : null;
  const closeMin = hours.length ? Math.max(...hours.map((h) => h.closeMin)) : null;
  const starts = [openMin ?? 9 * 60, ...columns.flatMap((c) => [...c.spans.map((s) => s.startMin), ...c.appts.map((a) => a.startMin)])];
  const ends = [closeMin ?? 18 * 60, ...columns.flatMap((c) => [...c.spans.map((s) => s.endMin), ...c.appts.map((a) => a.endMin)])];
  return {
    date,
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    closed: closure ? (closure.reason ?? "Closed") : hours.length === 0 ? (wd === 0 ? "Closed Sundays" : "Closed today") : null,
    openMin,
    closeMin,
    rangeStart: Math.floor(Math.min(...starts) / 60) * 60,
    rangeEnd: Math.ceil(Math.max(...ends) / 60) * 60,
    columns,
    off,
  };
}
