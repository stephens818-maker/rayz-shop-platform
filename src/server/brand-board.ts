import { and, asc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, shopClosures, shopHours, shops, staff, staffDaysOn, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import type { ReasonViewer } from "@/domain/block-reasons";
import { LocalDate, endOfLocalDay, localDateOf, localMinutesOf, startOfLocalDay, weekdayOf } from "@/lib/time";
import { reasonShower } from "./block-reasons";

export interface BoardAppt {
  id: string;
  startMin: number;
  endMin: number;
  status: string;
  client: string;
  source: string;
}
export interface BoardLane {
  staffId: string;
  label: string;
  color: string | null;
  /** Working hours today: weekly hours inside the shop's, plus any day on. */
  spans: { startMin: number; endMin: number; dayOn: boolean }[];
  blocks: { startMin: number; endMin: number; label: string; off: boolean }[];
  appts: BoardAppt[];
  /** Also on the board at another shop today. */
  elsewhere: string[];
}
export interface BoardShop {
  id: string;
  name: string;
  closed: string | null;
  openMin: number | null;
  closeMin: number | null;
  lanes: BoardLane[];
  counts: { booked: number; checkedIn: number; done: number; noShow: number; working: number };
}
export interface BrandBoard {
  date: LocalDate;
  shops: BoardShop[];
  rangeStart: number;
  rangeEnd: number;
}

const clamp = (d: Date, date: LocalDate) => {
  const dd = localDateOf(d);
  return dd < date ? 0 : dd > date ? 24 * 60 : localMinutesOf(d);
};

/** Short client name for the board: first name and last initial. */
const clientLabel = (first: string | null, last: string | null, notes: string | null) =>
  first ? `${first}${last ? ` ${last.charAt(0)}.` : ""}` : (notes?.replace(/^Walk-in: /, "").slice(0, 24) ?? "Walk-in");

/**
 * Every shop's day side by side, a lane per barber working there: hours, blocks and time off, and
 * appointments. Read-only; each shop's calendar is where things are booked and moved.
 */
export async function loadBrandBoard(shopIds: readonly string[], date: LocalDate, reasons: ReasonViewer): Promise<BrandBoard> {
  if (!shopIds.length) return { date, shops: [], rangeStart: 9 * 60, rangeEnd: 18 * 60 };
  const ids = [...shopIds];
  const from = startOfLocalDay(date);
  const to = endOfLocalDay(date);
  const wd = weekdayOf(date);
  const [shopRows, hours, closures, links] = await Promise.all([
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ids)).orderBy(asc(shops.name)),
    db.select().from(shopHours).where(and(inArray(shopHours.shopId, ids), eq(shopHours.weekday, wd))),
    db.select().from(shopClosures).where(and(inArray(shopClosures.shopId, ids), eq(shopClosures.date, date))),
    db
      .select({ shopId: staffShops.shopId, id: staff.id, label: staff.displayLabel, color: staff.color })
      .from(staffShops)
      .innerJoin(staff, eq(staff.id, staffShops.staffId))
      .where(and(inArray(staffShops.shopId, ids), eq(staff.active, true), eq(staff.kind, "person")))
      .orderBy(asc(staff.displayLabel)),
  ]);
  const people = [...new Set(links.map((l) => l.id))];
  const none = ["00000000-0000-0000-0000-000000000000"];
  const [scheds, daysOn, blocks, appts, show] = await Promise.all([
    db
      .select()
      .from(staffSchedules)
      .where(and(inArray(staffSchedules.shopId, ids), eq(staffSchedules.weekday, wd), inArray(staffSchedules.staffId, people.length ? people : none))),
    db
      .select()
      .from(staffDaysOn)
      .where(and(inArray(staffDaysOn.shopId, ids), eq(staffDaysOn.date, date), isNull(staffDaysOn.removedAt))),
    db
      .select()
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, people.length ? people : none), lt(timeBlocks.startsAt, to), gt(timeBlocks.endsAt, from), or(isNull(timeBlocks.shopId), inArray(timeBlocks.shopId, ids)))),
    db
      .select({ a: appointments, first: customers.firstName, last: customers.lastName })
      .from(appointments)
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(and(inArray(appointments.shopId, ids), ne(appointments.status, "cancelled"), lt(appointments.startsAt, to), gt(appointments.endsAt, from)))
      .orderBy(asc(appointments.startsAt)),
    reasonShower(reasons),
  ]);

  const name = new Map(shopRows.map((s) => [s.id, s.name]));
  const out: BoardShop[] = shopRows.map((shop) => {
    const open = hours.filter((h) => h.shopId === shop.id);
    const closure = closures.find((c) => c.shopId === shop.id);
    const openMin = open.length ? Math.min(...open.map((h) => h.openMin)) : null;
    const closeMin = open.length ? Math.max(...open.map((h) => h.closeMin)) : null;
    const mineAppts = appts.filter((r) => r.a.shopId === shop.id);
    const lanes: BoardLane[] = links
      .filter((l) => l.shopId === shop.id)
      .map((l) => {
        const weekly = closure || openMin === null ? [] : scheds.filter((s) => s.staffId === l.id && s.shopId === shop.id).map((s) => ({ startMin: Math.max(s.startMin, openMin), endMin: Math.min(s.endMin, closeMin!), dayOn: false }));
        const extra = closure ? [] : daysOn.filter((d) => d.staffId === l.id && d.shopId === shop.id).map((d) => ({ startMin: d.startMin, endMin: d.endMin, dayOn: true }));
        const elsewhere = [
          ...new Set([
            ...scheds.filter((s) => s.staffId === l.id && s.shopId !== shop.id).map((s) => s.shopId),
            ...daysOn.filter((d) => d.staffId === l.id && d.shopId !== shop.id).map((d) => d.shopId),
          ]),
        ].map((id) => name.get(id) ?? "Another shop");
        return {
          staffId: l.id,
          label: l.label,
          color: l.color,
          spans: [...weekly.filter((s) => s.endMin > s.startMin), ...extra],
          blocks: blocks
            .filter((b) => b.staffId === l.id && (b.shopId === null || b.shopId === shop.id))
            .map((b) => {
              const off = b.category === "time_off" || b.kind === "day_off";
              return { startMin: clamp(b.startsAt, date), endMin: clamp(b.endsAt, date), label: show(b, off).label, off };
            }),
          appts: mineAppts
            .filter((r) => r.a.staffId === l.id)
            .map((r) => ({ id: r.a.id, startMin: clamp(r.a.startsAt, date), endMin: clamp(r.a.endsAt, date), status: r.a.status, client: clientLabel(r.first, r.last, r.a.notes), source: r.a.source })),
          elsewhere,
        };
      })
      .filter((l) => l.spans.length || l.appts.length || l.blocks.some((b) => !b.off));
    const st = (s: string) => mineAppts.filter((r) => r.a.status === s).length;
    return {
      id: shop.id,
      name: shop.name,
      closed: closure ? (closure.reason ?? "Closed") : openMin === null ? "Closed" : null,
      openMin,
      closeMin,
      lanes,
      counts: { booked: mineAppts.length - st("no_show"), checkedIn: st("checked_in") + st("in_service"), done: st("completed"), noShow: st("no_show"), working: lanes.filter((l) => l.spans.length).length },
    };
  });
  const starts = out.flatMap((s) => [s.openMin ?? 24 * 60, ...s.lanes.flatMap((l) => [...l.spans.map((x) => x.startMin), ...l.appts.map((a) => a.startMin)])]);
  const ends = out.flatMap((s) => [s.closeMin ?? 0, ...s.lanes.flatMap((l) => [...l.spans.map((x) => x.endMin), ...l.appts.map((a) => a.endMin)])]);
  const lo = Math.min(9 * 60, ...starts);
  const hi = Math.max(18 * 60, ...ends);
  return { date, shops: out, rangeStart: Math.floor(lo / 60) * 60, rangeEnd: Math.min(24 * 60, Math.ceil(hi / 60) * 60) };
}
