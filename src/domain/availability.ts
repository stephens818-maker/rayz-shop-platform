import { LocalDate, endOfLocalDay, startOfLocalDay, weekdayOf, zonedWallTime } from "@/lib/time";

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Span {
  start: number;
  end: number;
}

export interface WeeklyHours {
  weekday: number; // 0 = Sun
  startMin: number; // minutes after local midnight
  endMin: number;
}

export interface BarberWeeklyHours extends WeeklyHours {
  staffId: string;
  shopId: string;
}

export interface TimeBlock {
  staffId: string;
  /** null = applies at every shop (e.g. a day off). */
  shopId: string | null;
  startsAt: Date | number;
  endsAt: Date | number;
}

export interface BusyAppointment {
  id?: string;
  staffId: string;
  shopId: string;
  startsAt: Date | number;
  endsAt: Date | number;
  status: string;
}

/**
 * Statuses that occupy a barber's chair: the same set the database's no-double-booking constraint
 * covers. A completed appointment frees the chair (a cut that finishes early opens the rest of its
 * slot); cancelled and no-show free it too.
 */
export const BUSY_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;
/** For spreading "any barber" bookings: time already worked today counts as load. */
const LOAD_STATUSES: readonly string[] = [...BUSY_STATUSES, "completed"];

export interface DayAvailabilityInput {
  date: LocalDate;
  shopId: string;
  shopHours: WeeklyHours[];
  /** Closed dates (holidays) for this shop. */
  closedDates?: LocalDate[];
  /** Barbers that may be booked at this shop (already filtered to active + bookable). */
  staffIds: string[];
  schedules: BarberWeeklyHours[];
  blocks: TimeBlock[];
  /** Appointments for these barbers at ANY shop — this is what prevents cross-shop double-booking. */
  appointments: BusyAppointment[];
  durationMin: number;
  slotIntervalMin?: number;
  bufferMin?: number;
  minLeadMin?: number;
  now?: Date | number;
  /** When rescheduling, ignore the appointment being moved. */
  ignoreAppointmentId?: string;
}

export interface Slot {
  start: number;
  end: number;
  staffIds: string[];
}

const ms = (d: Date | number) => (typeof d === "number" ? d : d.getTime());

function toSpans(date: LocalDate, hours: WeeklyHours[]): Span[] {
  const wd = weekdayOf(date);
  return hours
    .filter((h) => h.weekday === wd && h.endMin > h.startMin)
    .map((h) => ({
      start: zonedWallTime(date, h.startMin).toMillis(),
      end: zonedWallTime(date, h.endMin).toMillis(),
    }));
}

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function intersectSpans(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of mergeSpans(a)) {
    for (const y of mergeSpans(b)) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return mergeSpans(out);
}

export function subtractSpans(base: Span[], remove: Span[]): Span[] {
  let result = mergeSpans(base);
  for (const r of mergeSpans(remove)) {
    const next: Span[] = [];
    for (const s of result) {
      if (r.end <= s.start || r.start >= s.end) {
        next.push(s);
        continue;
      }
      if (r.start > s.start) next.push({ start: s.start, end: r.start });
      if (r.end < s.end) next.push({ start: r.end, end: s.end });
    }
    result = next;
  }
  return result;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Free time for one barber at one shop on one local date. */
export function freeSpansForBarber(input: DayAvailabilityInput, staffId: string): Span[] {
  const { date, shopId } = input;
  if (input.closedDates?.includes(date)) return [];
  const shopOpen = toSpans(date, input.shopHours);
  if (shopOpen.length === 0) return [];
  const work = toSpans(
    date,
    input.schedules.filter((s) => s.staffId === staffId && s.shopId === shopId),
  );
  const bookable = intersectSpans(shopOpen, work);
  if (bookable.length === 0) return [];

  const buffer = (input.bufferMin ?? 0) * 60_000;
  const busy: Span[] = [];
  for (const b of input.blocks) {
    if (b.staffId !== staffId) continue;
    if (b.shopId !== null && b.shopId !== shopId) continue;
    busy.push({ start: ms(b.startsAt), end: ms(b.endsAt) });
  }
  for (const a of input.appointments) {
    if (a.staffId !== staffId) continue;
    if (a.id && a.id === input.ignoreAppointmentId) continue;
    if (!(BUSY_STATUSES as readonly string[]).includes(a.status)) continue;
    // Busy regardless of which shop the appointment is at.
    busy.push({ start: ms(a.startsAt) - buffer, end: ms(a.endsAt) + buffer });
  }
  return subtractSpans(bookable, busy);
}

/**
 * Weekly hours for one barber must not overlap across shops (they can't be in two chairs).
 * Returns human-readable conflicts; the schedule editor refuses to save when non-empty.
 */
export function findScheduleConflicts(rows: BarberWeeklyHours[]): string[] {
  const conflicts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.staffId !== b.staffId || a.weekday !== b.weekday) continue;
      if (a.startMin < b.endMin && b.startMin < a.endMin) {
        conflicts.push(`weekday ${a.weekday}: ${a.shopId} ${a.startMin}-${a.endMin} overlaps ${b.shopId} ${b.startMin}-${b.endMin}`);
      }
    }
  }
  return conflicts;
}

/**
 * Bookable start times for a day. Slots step in absolute time from each opening, so a
 * DST transition never produces duplicate or phantom slots.
 */
export function computeDaySlots(input: DayAvailabilityInput): Slot[] {
  const interval = (input.slotIntervalMin ?? 15) * 60_000;
  const duration = input.durationMin * 60_000;
  if (duration <= 0) return [];
  const now = input.now === undefined ? Date.now() : ms(input.now);
  const earliest = now + (input.minLeadMin ?? 0) * 60_000;
  const shopOpen = toSpans(input.date, input.shopHours);

  const byStart = new Map<number, Slot>();
  for (const staffId of input.staffIds) {
    const free = freeSpansForBarber(input, staffId);
    for (const open of shopOpen) {
      for (let t = open.start; t + duration <= open.end; t += interval) {
        if (t < earliest) continue;
        const span = { start: t, end: t + duration };
        if (!free.some((f) => f.start <= span.start && f.end >= span.end)) continue;
        const existing = byStart.get(t);
        if (existing) existing.staffIds.push(staffId);
        else byStart.set(t, { start: t, end: t + duration, staffIds: [staffId] });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** Does `start` sit on the grid computeDaySlots offers (whole intervals after an opening)? */
export function onSlotGrid(input: DayAvailabilityInput, start: number): boolean {
  const interval = (input.slotIntervalMin ?? 15) * 60_000;
  return toSpans(input.date, input.shopHours).some((open) => start >= open.start && (start - open.start) % interval === 0);
}

/** Is [start, start+duration) bookable for this barber? Used to validate a booking request server-side. */
export function isSlotFree(input: DayAvailabilityInput, staffId: string, start: number): boolean {
  const span = { start, end: start + input.durationMin * 60_000 };
  const now = input.now === undefined ? Date.now() : ms(input.now);
  if (span.start < now + (input.minLeadMin ?? 0) * 60_000) return false;
  return freeSpansForBarber(input, staffId).some((f) => f.start <= span.start && f.end >= span.end);
}

/**
 * "Any barber": pick the barber with the fewest booked minutes that day (spreads the load),
 * breaking ties by stable ordering so results are deterministic.
 */
export function pickBarber(candidates: string[], appointments: BusyAppointment[], date: LocalDate): string | null {
  if (candidates.length === 0) return null;
  const dayStart = startOfLocalDay(date).getTime();
  const dayEnd = endOfLocalDay(date).getTime();
  const load = new Map<string, number>(candidates.map((c) => [c, 0]));
  for (const a of appointments) {
    if (!load.has(a.staffId)) continue;
    if (!LOAD_STATUSES.includes(a.status)) continue;
    const s = Math.max(ms(a.startsAt), dayStart);
    const e = Math.min(ms(a.endsAt), dayEnd);
    if (e > s) load.set(a.staffId, load.get(a.staffId)! + (e - s));
  }
  return [...candidates].sort((a, b) => load.get(a)! - load.get(b)! || candidates.indexOf(a) - candidates.indexOf(b))[0];
}

/** Total chair time for a service plus add-ons. */
export function totalDuration(items: { durationMin: number }[]): number {
  return items.reduce((sum, i) => sum + Math.max(0, i.durationMin), 0);
}
