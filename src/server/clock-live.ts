import { and, asc, eq, gt, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { appointments, brandSettings, customers, shops, staff, staffSchedules, timePunches } from "@/db/schema";
import { type HoldWhy, type LiveDay, affectedBy, lateClockIn, liveDay } from "@/domain/clock-live";
import { clockRules, scheduledOn, shopClockSettings, type ScheduleRow, type ShopClockSettings } from "@/domain/time-clock";
import { endOfLocalDay, startOfLocalDay, todayLocal, weekdayOf, type LocalDate } from "@/lib/time";

/**
 * Loads what src/domain/clock-live.ts needs for barbers at one shop on one day: their punches, their
 * schedule there, the brand's and the shop's clock rules and whether each lets an early clock-in
 * open slots. Used by availability (online booking and the staff picker), the calendar and Today.
 */

const HOUR = 3_600_000;

export interface LiveClock {
  settings: ShopClockSettings;
  days: Map<string, LiveDay>;
}

export async function liveClock(shop: { id: string; timeClock: unknown }, date: LocalDate, staffIds: readonly string[], now = new Date(), tx: DBorTx = db): Promise<LiveClock> {
  const settings = shopClockSettings(shop.timeClock);
  const days = new Map<string, LiveDay>();
  const ids = [...new Set(staffIds)];
  if (!ids.length) return { settings, days };
  const dayStart = startOfLocalDay(date);
  const dayEnd = endOfLocalDay(date);
  const [punches, scheds, [brand], permits] = await Promise.all([
    tx
      .select({ id: timePunches.id, staffId: timePunches.staffId, shopId: timePunches.shopId, type: timePunches.type, at: timePunches.at })
      .from(timePunches)
      .where(and(inArray(timePunches.staffId, ids), gte(timePunches.at, new Date(dayStart.getTime() - 36 * HOUR)), lt(timePunches.at, new Date(dayEnd.getTime() + 36 * HOUR)), isNull(timePunches.voidedAt))),
    tx
      .select({ staffId: staffSchedules.staffId, weekday: staffSchedules.weekday, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin })
      .from(staffSchedules)
      .where(and(inArray(staffSchedules.staffId, ids), eq(staffSchedules.shopId, shop.id), eq(staffSchedules.weekday, weekdayOf(date)))),
    tx.select({ t: brandSettings.timeClock }).from(brandSettings).limit(1),
    tx.select({ id: staff.id, early: staff.clockOpensEarly }).from(staff).where(inArray(staff.id, ids)),
  ]);
  const rules = clockRules(brand?.t);
  const allows = new Map(permits.map((p) => [p.id, p.early]));
  for (const staffId of ids) {
    const rows: ScheduleRow[] = scheds.filter((s) => s.staffId === staffId);
    days.set(
      staffId,
      liveDay({
        staffId,
        shopId: shop.id,
        punches: punches.filter((p) => p.staffId === staffId),
        dayStart,
        dayEnd,
        scheduled: scheduledOn(date, weekdayOf(date), rows),
        now,
        shop: settings,
        rules,
        permitsEarly: allows.get(staffId) ?? false,
      }),
    );
  }
  return { settings, days };
}

export interface FalloutAppt {
  id: string;
  code: string;
  startsAt: Date;
  status: string;
  first: string | null;
}

export interface ShopFallout {
  shopId: string;
  shop: string;
  /** Not clocked in with their first appointment close (or begun). Only people who use the clock (a punch in the last 30 days). */
  late: { staffId: string; label: string; appt: FalloutAppt; minutesToGo: number }[];
  /** Clients booked over a break, or after an early clock-out. */
  affected: { staffId: string; label: string; why: HoldWhy; start: Date; end: Date; appts: FalloutAppt[] }[];
}

const NONE = ["00000000-0000-0000-0000-000000000000"];

/** For Today and the cron's emails: at each of these shops today, who isn't clocked in for their first client, and who has clients the clock now holds time over. */
export async function clockFallout(shopIds: readonly string[], now = new Date()): Promise<ShopFallout[]> {
  if (!shopIds.length) return [];
  const today = todayLocal(now);
  const ds = startOfLocalDay(today);
  const de = endOfLocalDay(today);
  const shopRows = await db.select({ id: shops.id, name: shops.name, timeClock: shops.timeClock }).from(shops).where(inArray(shops.id, [...shopIds]));
  const appts = await db
    .select({ id: appointments.id, code: appointments.code, shopId: appointments.shopId, staffId: appointments.staffId, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status, first: customers.firstName })
    .from(appointments)
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(and(inArray(appointments.shopId, [...shopIds]), notInArray(appointments.status, ["cancelled", "no_show"]), gte(appointments.startsAt, ds), lt(appointments.startsAt, de)))
    .orderBy(asc(appointments.startsAt));
  const staffIds = [...new Set(appts.map((a) => a.staffId))];
  if (!staffIds.length) return [];
  const [labels, users] = await Promise.all([
    db.select({ id: staff.id, label: staff.displayLabel, kind: staff.kind }).from(staff).where(inArray(staff.id, staffIds)),
    db
      .selectDistinct({ id: timePunches.staffId })
      .from(timePunches)
      .where(and(inArray(timePunches.staffId, staffIds.length ? staffIds : NONE), gte(timePunches.at, new Date(now.getTime() - 30 * 24 * HOUR)))),
  ]);
  const label = new Map(labels.filter((l) => l.kind === "person").map((l) => [l.id, l.label]));
  const usesClock = new Set(users.map((u) => u.id));
  const out: ShopFallout[] = [];
  for (const s of shopRows.sort((a, b) => a.name.localeCompare(b.name))) {
    const here = appts.filter((a) => a.shopId === s.id && label.has(a.staffId));
    if (!here.length) continue;
    const { settings, days } = await liveClock(s, today, [...new Set(here.map((a) => a.staffId))], now);
    const f: ShopFallout = { shopId: s.id, shop: s.name, late: [], affected: [] };
    for (const d of days.values()) {
      const mine = here.filter((a) => a.staffId === d.staffId);
      const lateIn = usesClock.has(d.staffId) ? lateClockIn(d, mine[0] ?? null, now, settings.lateAlertMinutes) : null;
      if (lateIn) f.late.push({ staffId: d.staffId, label: label.get(d.staffId)!, appt: mine[0], minutesToGo: lateIn.minutesToGo });
      const hit = affectedBy(d, s.id, mine);
      for (const h of d.holds) {
        const inIt = hit.filter((a) => a.why === h.why);
        if (inIt.length) f.affected.push({ staffId: d.staffId, label: label.get(d.staffId)!, why: h.why, start: h.start, end: h.end, appts: inIt });
      }
    }
    f.late.sort((a, b) => a.appt.startsAt.getTime() - b.appt.startsAt.getTime());
    if (f.late.length || f.affected.length) out.push(f);
  }
  return out;
}

/** Changes whenever a punch or an appointment at this shop that day does: the calendar polls it and refreshes when it moves. */
export async function clockPulse(shopId: string, date: LocalDate): Promise<string> {
  const from = startOfLocalDay(date);
  const to = endOfLocalDay(date);
  const [p] = await db
    .select({ h: sql<string>`coalesce(md5(string_agg(${timePunches.id}::text || ${timePunches.at}::text || coalesce(${timePunches.voidedAt}::text, ''), ',' order by ${timePunches.id})), '')` })
    .from(timePunches)
    .where(and(eq(timePunches.shopId, shopId), gte(timePunches.at, new Date(from.getTime() - 36 * HOUR)), lt(timePunches.at, to)));
  const [a] = await db
    .select({ h: sql<string>`coalesce(md5(string_agg(${appointments.id}::text || ${appointments.status} || ${appointments.staffId}::text || ${appointments.startsAt}::text, ',' order by ${appointments.id})), '')` })
    .from(appointments)
    .where(and(eq(appointments.shopId, shopId), lt(appointments.startsAt, to), gt(appointments.endsAt, from)));
  return `${p?.h ?? ""}.${a?.h ?? ""}`;
}
