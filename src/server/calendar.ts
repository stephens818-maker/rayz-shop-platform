import "server-only";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, sales, shopClosures, shopHours, shops, staff, staffSchedules, staffShops, timeBlocks, timeOffRequests, timePunches } from "@/db/schema";
import type { ReasonViewer, ShownReason } from "@/domain/block-reasons";
import { type ClockBlockKind, clockKindOf, effectiveEnd } from "@/domain/clock-blocks";
import { type LiveDay, type LiveStatus, MISSED_LABEL, affectedBy } from "@/domain/clock-live";
import { payPeriodFor } from "@/domain/payroll";
import type { ShownBadge } from "@/domain/badges";
import type { RatingSummary } from "@/domain/ratings";
import type { TimesView } from "@/domain/service-times";
import type { IntervalSource } from "@/domain/timing";
import { LocalDate, addDays, endOfLocalDay, localMinutesOf, localDateOf, startOfLocalDay, todayLocal, weekdayOf } from "@/lib/time";
import { refreshClockBlocks } from "./clock-blocks";
import { liveClock } from "./clock-live";
import { shownBadges } from "./badges";
import type { ClientPolicy } from "./client-privacy";
import { Tenant, hasShop } from "./tenant";
import { staffIntervals } from "./timing";
import { ratingSummaries } from "./ratings";
import { timesFor } from "./service-times";
import { reasonShower } from "./block-reasons";
import { staffingFor } from "./staff-time";
import { guardian, householdContact } from "./household-contact";

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
  /** A child's parent: the phone and consent above are theirs. */
  guardian: { id: string; name: string } | null;
  services: string[];
  estimateCents: number;
  notes: string | null;
  /** Staff-only star average for the client. */
  rating: RatingSummary | null;
  /** Client badges the viewer sees. */
  badges: ShownBadge[];
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
  /** A clock block (break, early clock-out, not in yet) sits over it: the manager should move or rebook it. */
  clockHold: { kind: ClockBlockKind; blockId: string } | null;
}

/** One barber's time clock on the calendar day, in minutes after midnight. Staff only: clients never see it. */
export interface CalClock {
  /** Null for a day that isn't today. */
  status: LiveStatus | null;
  sinceMin: number | null;
  /** Clocked in at another shop right now: its name, or null outside the viewer's workspace. */
  elsewhere: { shop: string | null } | null;
  worked: { startMin: number; endMin: number; open: boolean }[];
  breaks: { startMin: number; endMin: number; open: boolean }[];
  firstInMin: number | null;
  lastOutMin: number | null;
  lateMin: number | null;
  overdueMin: number | null;
  earlyOutMin: number | null;
  missed: { label: string; atMin: number }[];
  early: { startMin: number; endMin: number } | null;
}

/** A block the time clock wrote, and the punches it's tied to. */
export interface CalClockBlock {
  kind: ClockBlockKind;
  /** Still going: its end moves on until the punch that ends it. */
  open: boolean;
  /** A manager set its times by hand. */
  overridden: boolean;
  /** The punch it came from and the one that ended it, as times after midnight. */
  punchMin: number | null;
  endPunchMin: number | null;
  /** Their timesheet for the period, where the punches are. */
  timesheetHref: string;
}

export interface CalBlock extends ShownReason {
  id: string;
  startMin: number;
  endMin: number;
  kind: string;
  category: string;
  recurring: boolean;
  fromRequest: boolean;
  clock: CalClockBlock | null;
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
  /** With the reason as the viewer may see it: a private one is just "Blocked" or "Time off". */
  blocks: CalBlock[];
  /** `shop` is null for a shop outside the viewer's workspace. */
  elsewhere: { startMin: number; endMin: number; shop: string | null }[];
  appts: CalAppt[];
  /** Null for days still to come. */
  clock: CalClock | null;
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
  off: { staffId: string; label: string; allDay: boolean; spans: { startMin: number; endMin: number; reason: string; color: string }[]; pending: boolean }[];
}

const NO_ID = "00000000-0000-0000-0000-000000000000";

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
 * `reasons` is who is looking at block and time off reasons: private ones come back as "Blocked".
 */
export async function loadDayCalendar(
  shopId: string,
  date: LocalDate,
  onlyStaffId: string | null,
  viewer: Pick<Tenant, "shopIds" | "brandWide">,
  privacy: Pick<ClientPolicy, "show" | "stars"> & Partial<Pick<ClientPolicy, "badges" | "level" | "customBadges">>,
  reasons: ReasonViewer,
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
        phone: householdContact.phone,
        smsOptIn: householdContact.smsOptIn,
        guardianId: guardian.id,
        guardianFirst: guardian.firstName,
        guardianLast: guardian.lastName,
        saleId: sales.id,
        saleStatus: sales.status,
      })
      .from(appointments)
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .leftJoin(guardian, eq(guardian.id, customers.guardianId))
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
  const now = new Date();
  if (date === todayLocal(now)) await refreshClockBlocks(now, [shopId]);

  const [blocks, elsewhere, items, ratings, punchTimes, badges] = await Promise.all([
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
    ids.length
      ? db
          .select({ id: timePunches.id, at: timePunches.at })
          .from(timePunches)
          .where(and(inArray(timePunches.staffId, ids), gt(timePunches.at, new Date(dayStart.getTime() - 86_400_000)), lt(timePunches.at, dayEnd)))
      : [],
    privacy.badges?.size && privacy.level && privacy.customBadges
      ? shownBadges(
          { badges: privacy.badges, level: privacy.level, customBadges: privacy.customBadges },
          apptRows.map((r) => r.a.customerId),
        )
      : new Map<string, ShownBadge[]>(),
  ]);
  const punchAt = new Map(punchTimes.map((p) => [p.id, p.at]));
  const times = await timesFor(apptRows.map((r) => r.a.id));
  const show = await reasonShower(reasons);

  const intervals = await staffIntervals(shop, ids);
  const live = date <= todayLocal(now) ? await liveClock(shop, date, ids, now) : null;
  const otherIds = [...new Set([...(live?.days.values() ?? [])].map((d) => d.elsewhereShopId).filter((x): x is string => !!x))];
  const otherNames = new Map(
    otherIds.length ? (await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, otherIds))).map((s) => [s.id, shopLabel(s.id, s.name)] as const) : [],
  );
  const at = (d: Date | null) => (d ? clampDay(d, date) : clampDay(now, date));
  const calClock = (d: LiveDay): CalClock => {
    const lastClosed = [...d.shifts].reverse().find((s) => s.end !== null && d.status !== "in" && d.status !== "break");
    return {
      status: d.status,
      sinceMin: d.since ? at(d.since) : null,
      elsewhere: d.elsewhereShopId ? { shop: otherNames.get(d.elsewhereShopId) ?? null } : null,
      worked: d.shifts.map((s) => ({ startMin: at(s.start), endMin: at(s.end), open: s.end === null })),
      breaks: d.shifts.flatMap((s) => s.breaks.map((b) => ({ startMin: at(b.start), endMin: at(b.end ?? s.end), open: b.end === null && s.end === null }))),
      firstInMin: d.shifts[0] ? at(d.shifts[0].start) : null,
      lastOutMin: lastClosed ? at(lastClosed.end) : null,
      lateMin: d.lateMin,
      overdueMin: d.overdueMin,
      earlyOutMin: d.earlyOutMin,
      missed: d.missed.map((m) => ({ label: MISSED_LABEL[m.kind], atMin: at(m.at) })),
      early: d.early ? { startMin: at(d.early.start), endMin: at(d.early.end) } : null,
    };
  };
  const clockRows = blocks
    .filter((b) => b.source === "clock")
    .map((b) => ({ ...b, endsAt: effectiveEnd(b, now), kind: clockKindOf(b.clockKey) ?? ("break" as const) }))
    .filter((b) => b.endsAt > now);
  const held = new Map(affectedBy(clockRows, apptRows.map((r) => r.a)).map((a) => [a.id, { kind: a.why, blockId: a.blockId }]));
  const sheet = `?period=${payPeriodFor(date).start}`;
  const minOf = (id: string | null) => {
    const p = id ? punchAt.get(id) : undefined;
    return p ? clampDay(p, date) : null;
  };
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
          endMin: clampDay(effectiveEnd(b, now), date),
          ...show(b, b.category === "time_off" || b.kind === "day_off"),
          kind: b.kind,
          category: b.category,
          recurring: b.seriesId !== null,
          fromRequest: b.requestId !== null,
          clock:
            b.source === "clock"
              ? {
                  kind: clockKindOf(b.clockKey) ?? "break",
                  open: b.clockOpen && !b.overriddenAt,
                  overridden: !!b.overriddenAt,
                  punchMin: minOf(b.punchId),
                  endPunchMin: minOf(b.endPunchId),
                  timesheetHref: `/admin/timesheets/${b.staffId}${sheet}`,
                }
              : null,
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
          guardian: r.guardianId ? { id: r.guardianId, name: [r.guardianFirst, r.guardianLast].filter(Boolean).join(" ") } : null,
          services: items.filter((i) => i.appointmentId === r.a.id).map((i) => i.name),
          estimateCents: r.a.estimateCents,
          notes: r.a.notes,
          rating: r.a.customerId ? privacy.stars(ratings.get(r.a.customerId)) : null,
          badges: (r.a.customerId && badges.get(r.a.customerId)) || [],
          anyBarber: r.a.anyBarber,
          saleId: r.saleId,
          saleStatus: r.saleStatus,
          bufferBeforeMin: r.a.bufferBeforeMinutes,
          bufferAfterMin: r.a.bufferMinutes,
          squeezed: r.a.squeezed,
          times: times.get(r.a.id) ?? null,
          clockHold: held.get(r.a.id) ?? null,
        })),
      clock: live?.days.get(c.id) ? calClock(live.days.get(c.id)!) : null,
    };
  });

  const staffing = await staffingFor([shopId], date, date, reasons, onlyStaffId ? [onlyStaffId] : null);
  const off = staffing
    .filter((r) => r.status === "off" || r.status === "partly_off" || r.pending || (r.hasTimeOff && r.status === "not_scheduled"))
    .map((r) => ({
      staffId: r.staffId,
      label: r.label,
      allDay: r.status === "off",
      spans: r.blocks.filter((b) => b.category === "time_off").map((b) => ({ startMin: b.startMin, endMin: b.endMin, reason: b.label, color: b.color })),
      pending: r.pending,
    }));

  const openMin = hours.length ? Math.min(...hours.map((h) => h.openMin)) : null;
  const closeMin = hours.length ? Math.max(...hours.map((h) => h.closeMin)) : null;
  const worked = columns.flatMap((c) => c.clock?.worked ?? []);
  const starts = [openMin ?? 9 * 60, ...columns.flatMap((c) => [...c.spans.map((s) => s.startMin), ...c.appts.map((a) => a.startMin)]), ...worked.map((w) => w.startMin)];
  const ends = [closeMin ?? 18 * 60, ...columns.flatMap((c) => [...c.spans.map((s) => s.endMin), ...c.appts.map((a) => a.endMin)]), ...worked.map((w) => w.endMin)];
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

export interface WeekAppt {
  id: string;
  code: string;
  startMin: number;
  endMin: number;
  status: string;
  customerName: string;
  services: string[];
}

export interface WeekDay {
  date: LocalDate;
  closed: string | null;
  /** This barber's hours here that day. */
  spans: { startMin: number; endMin: number }[];
  blocks: CalBlock[];
  /** Time off waiting for a manager. */
  pending: ({ id: string; startMin: number; endMin: number } & ShownReason)[];
  appts: WeekAppt[];
}

export interface WeekCalendarData {
  shop: { id: string; name: string };
  weekStart: LocalDate;
  barber: { id: string; label: string; color: string } | null;
  /** Who the picker offers. */
  barbers: { id: string; label: string }[];
  days: WeekDay[];
  rangeStart: number;
  rangeEnd: number;
}

/** One barber's week at one shop (Sunday to Saturday): hours, closures, blocks with their reasons, time off and appointments. */
export async function loadWeekCalendar(shopId: string, weekStart: LocalDate, staffId: string | null, barberIds: readonly string[] | null, reasons: ReasonViewer): Promise<WeekCalendarData> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw new Error("shop not found");
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const from = startOfLocalDay(dates[0]);
  const to = endOfLocalDay(dates[6]);
  const links = await db
    .select({ id: staff.id, label: staff.displayLabel, color: staff.color })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staff.active, true), eq(staff.kind, "person"), barberIds ? inArray(staff.id, barberIds.length ? [...barberIds] : [NO_ID]) : undefined))
    .orderBy(asc(staff.displayLabel));
  const barber = links.find((l) => l.id === staffId) ?? links[0] ?? null;
  const [hours, closures] = await Promise.all([
    db.select().from(shopHours).where(eq(shopHours.shopId, shopId)),
    db.select().from(shopClosures).where(and(eq(shopClosures.shopId, shopId), inArray(shopClosures.date, dates))),
  ]);
  const base = { shop: { id: shop.id, name: shop.name }, weekStart, barbers: links.map((l) => ({ id: l.id, label: l.label })) };
  const openMin = hours.length ? Math.min(...hours.map((h) => h.openMin)) : 9 * 60;
  const closeMin = hours.length ? Math.max(...hours.map((h) => h.closeMin)) : 18 * 60;
  if (!barber) return { ...base, barber: null, days: [], rangeStart: Math.floor(openMin / 60) * 60, rangeEnd: Math.ceil(closeMin / 60) * 60 };

  const [scheds, blocks, pending, apptRows, show] = await Promise.all([
    db.select().from(staffSchedules).where(and(eq(staffSchedules.staffId, barber.id), eq(staffSchedules.shopId, shopId))),
    db
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.staffId, barber.id), lt(timeBlocks.startsAt, to), gt(timeBlocks.endsAt, from), or(isNull(timeBlocks.shopId), eq(timeBlocks.shopId, shopId)))),
    db
      .select()
      .from(timeOffRequests)
      .where(
        and(
          eq(timeOffRequests.staffId, barber.id),
          eq(timeOffRequests.status, "pending"),
          lt(timeOffRequests.startsAt, to),
          gt(timeOffRequests.endsAt, from),
          or(isNull(timeOffRequests.shopId), eq(timeOffRequests.shopId, shopId)),
        ),
      ),
    db
      .select({ a: appointments, firstName: customers.firstName, lastName: customers.lastName })
      .from(appointments)
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(and(eq(appointments.staffId, barber.id), eq(appointments.shopId, shopId), ne(appointments.status, "cancelled"), lt(appointments.startsAt, to), gt(appointments.endsAt, from)))
      .orderBy(asc(appointments.startsAt)),
    reasonShower(reasons),
  ]);
  const items = apptRows.length
    ? await db
        .select({ appointmentId: appointmentItems.appointmentId, name: appointmentItems.name, kind: appointmentItems.kind })
        .from(appointmentItems)
        .where(inArray(appointmentItems.appointmentId, apptRows.map((r) => r.a.id)))
        .orderBy(asc(appointmentItems.kind))
    : [];

  const days: WeekDay[] = dates.map((date) => {
    const ds = startOfLocalDay(date);
    const de = endOfLocalDay(date);
    const inDay = (x: { startsAt: Date; endsAt: Date }) => x.startsAt < de && x.endsAt > ds;
    const wd = weekdayOf(date);
    const closure = closures.find((c) => c.date === date);
    const open = hours.filter((h) => h.weekday === wd);
    return {
      date,
      closed: closure ? (closure.reason ?? "Closed") : open.length === 0 ? "Closed" : null,
      spans: scheds.filter((s) => s.weekday === wd).map((s) => ({ startMin: s.startMin, endMin: s.endMin })),
      blocks: blocks.filter(inDay).map((b) => ({
        id: b.id,
        startMin: clampDay(b.startsAt, date),
        endMin: clampDay(b.endsAt, date),
        ...show(b, b.category === "time_off" || b.kind === "day_off"),
        kind: b.kind,
        category: b.category,
        recurring: b.seriesId !== null,
        fromRequest: b.requestId !== null,
        clock:
          b.source === "clock"
            ? { kind: clockKindOf(b.clockKey) ?? "break", open: b.clockOpen && !b.overriddenAt, overridden: !!b.overriddenAt, punchMin: null, endPunchMin: null, timesheetHref: `/admin/timesheets/${b.staffId}?period=${payPeriodFor(date).start}` }
            : null,
      })),
      pending: pending.filter(inDay).map((p) => ({ id: p.id, startMin: clampDay(p.startsAt, date), endMin: clampDay(p.endsAt, date), ...show(p, true) })),
      appts: apptRows
        .filter((r) => inDay(r.a))
        .map((r) => ({
          id: r.a.id,
          code: r.a.code,
          startMin: clampDay(r.a.startsAt, date),
          endMin: clampDay(r.a.endsAt, date),
          status: r.a.status,
          customerName: r.firstName ? `${r.firstName}${r.lastName ? ` ${r.lastName.charAt(0)}.` : ""}` : (r.a.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
          services: items.filter((i) => i.appointmentId === r.a.id).map((i) => i.name),
        })),
    };
  });
  const starts = [openMin, ...days.flatMap((d) => [...d.spans.map((s) => s.startMin), ...d.appts.map((a) => a.startMin)])];
  const ends = [closeMin, ...days.flatMap((d) => [...d.spans.map((s) => s.endMin), ...d.appts.map((a) => a.endMin)])];
  return {
    ...base,
    barber,
    days,
    rangeStart: Math.floor(Math.min(...starts) / 60) * 60,
    rangeEnd: Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60),
  };
}
