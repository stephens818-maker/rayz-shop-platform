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
  /** Prep held before it, as booked. */
  bufferBeforeMin?: number;
  /** Cleanup and gap held after it, as booked. Missing: the input's bufferMin. */
  bufferAfterMin?: number;
}

/** One barber's timing for the booking being looked up (src/domain/timing.ts bookingPlan, resolved for them). */
export interface StaffPlan {
  durationMin: number;
  intervalMin: number;
  beforeMin: number;
  afterMin: number;
  gapMin: number;
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
  /** Defaults for every barber; `plans` overrides them per barber. */
  durationMin: number;
  slotIntervalMin?: number;
  /** The shop's gap between appointments: held after a new booking, and after existing ones that don't say their own. */
  bufferMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  /** Per barber: their interval at this shop, their durations, the services' buffers. */
  plans?: Record<string, Partial<StaffPlan>>;
  minLeadMin?: number;
  now?: Date | number;
  /** When rescheduling, ignore the appointment being moved. */
  ignoreAppointmentId?: string;
  /** Time a barber opened ahead of a scheduled stretch by clocking in early (src/domain/clock-live.ts). */
  early?: EarlyOpening[];
}

/** Bookable time before a scheduled stretch. `end` is that stretch's start; its slots count back from there, so the day's grid doesn't move. */
export interface EarlyOpening {
  staffId: string;
  start: Date | number;
  end: Date | number;
}

export interface Slot {
  start: number;
  /** The latest end among the barbers offering it (their durations can differ). */
  end: number;
  staffIds: string[];
  /** Each barber's end time for this start. */
  ends: Record<string, number>;
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

/** This barber's timing for the booking: their entry in `plans`, falling back to the input's defaults. */
export function planFor(input: DayAvailabilityInput, staffId: string): StaffPlan {
  const p = input.plans?.[staffId] ?? {};
  return {
    durationMin: p.durationMin ?? input.durationMin,
    intervalMin: p.intervalMin ?? input.slotIntervalMin ?? 15,
    beforeMin: p.beforeMin ?? input.bufferBeforeMin ?? 0,
    afterMin: p.afterMin ?? input.bufferAfterMin ?? 0,
    gapMin: p.gapMin ?? input.bufferMin ?? 0,
  };
}

/** Their weekly hours inside the shop's on this date. Each stretch starts its own slot grid. */
function scheduledSpans(input: DayAvailabilityInput, staffId: string): Span[] {
  const { date, shopId } = input;
  if (input.closedDates?.includes(date)) return [];
  const shopOpen = toSpans(date, input.shopHours);
  if (shopOpen.length === 0) return [];
  const work = toSpans(
    date,
    input.schedules.filter((s) => s.staffId === staffId && s.shopId === shopId),
  );
  return intersectSpans(shopOpen, work);
}

/** Early-opened time inside shop hours, each with the scheduled start its slots count back from. */
function earlySpans(input: DayAvailabilityInput, staffId: string): (Span & { anchor: number })[] {
  if (!input.early?.length || input.closedDates?.includes(input.date)) return [];
  const shopOpen = toSpans(input.date, input.shopHours);
  return input.early
    .filter((e) => e.staffId === staffId)
    .flatMap((e) => intersectSpans(shopOpen, [{ start: ms(e.start), end: ms(e.end) }]).map((s) => ({ ...s, anchor: ms(e.end) })));
}

/** When one barber works at this shop on this date: their weekly hours inside the shop's, plus any time an early clock-in opened. */
export function workSpans(input: DayAvailabilityInput, staffId: string): Span[] {
  const base = scheduledSpans(input, staffId);
  const early = earlySpans(input, staffId);
  return early.length ? mergeSpans([...base, ...early]) : base;
}

const isBusy = (input: DayAvailabilityInput, a: BusyAppointment, staffId: string) =>
  a.staffId === staffId && !(a.id && a.id === input.ignoreAppointmentId) && (BUSY_STATUSES as readonly string[]).includes(a.status);

/** Time off and blocks for this barber here (a block with no shop applies everywhere). */
function blockSpans(input: DayAvailabilityInput, staffId: string): Span[] {
  return input.blocks.filter((b) => b.staffId === staffId && (b.shopId === null || b.shopId === input.shopId)).map((b) => ({ start: ms(b.startsAt), end: ms(b.endsAt) }));
}

/** What existing appointments hold, at any shop: service time plus their prep and cleanup buffers. */
function heldSpans(input: DayAvailabilityInput, staffId: string): Span[] {
  const gap = input.bufferMin ?? 0;
  return input.appointments
    .filter((a) => isBusy(input, a, staffId))
    .map((a) => ({ start: ms(a.startsAt) - (a.bufferBeforeMin ?? 0) * 60_000, end: ms(a.endsAt) + (a.bufferAfterMin ?? gap) * 60_000 }));
}

/** Free time for one barber at one shop on one local date: working hours minus blocks and what other appointments hold. */
export function freeSpansForBarber(input: DayAvailabilityInput, staffId: string): Span[] {
  const work = workSpans(input, staffId);
  if (work.length === 0) return [];
  return subtractSpans(work, [...blockSpans(input, staffId), ...heldSpans(input, staffId)]);
}

/** What a booking starting at `start` holds: [prep, service, cleanup) must be in working hours; the gap after only must not hit anything. */
function holdAt(plan: StaffPlan, start: number) {
  const service = { start, end: start + plan.durationMin * 60_000 };
  const inHours = { start: start - plan.beforeMin * 60_000, end: service.end + plan.afterMin * 60_000 };
  return { service, inHours, held: { start: inHours.start, end: inHours.end + plan.gapMin * 60_000 } };
}

function fits(plan: StaffPlan, start: number, work: Span[], busy: Span[]): boolean {
  if (plan.durationMin <= 0) return false;
  const h = holdAt(plan, start);
  if (!work.some((w) => w.start <= h.inHours.start && w.end >= h.inHours.end)) return false;
  return !busy.some((b) => overlaps(b, h.held));
}

const earliestStart = (input: DayAvailabilityInput) => (input.now === undefined ? Date.now() : ms(input.now)) + (input.minLeadMin ?? 0) * 60_000;

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
 * Start times on one barber's grid: every interval from the start of each scheduled stretch, and,
 * before a stretch an early clock-in opened, every interval back from its start. In absolute time.
 */
export function gridStarts(input: DayAvailabilityInput, staffId: string): number[] {
  const step = planFor(input, staffId).intervalMin * 60_000;
  if (step <= 0) return [];
  const out = new Set<number>();
  for (const w of scheduledSpans(input, staffId)) for (let t = w.start; t < w.end; t += step) out.add(t);
  for (const e of earlySpans(input, staffId)) for (let t = e.anchor - step; t >= e.start; t -= step) if (t < e.end) out.add(t);
  return [...out].sort((a, b) => a - b);
}

/**
 * Bookable start times for a day. Each barber's starts step on their own interval from the start
 * of each stretch they work, in absolute time, so a DST transition never produces duplicate or
 * phantom slots. A start is offered when the service, add-ons, prep and cleanup all fit inside
 * their working hours and nothing they hold touches a block or another appointment's held time.
 */
export function computeDaySlots(input: DayAvailabilityInput): Slot[] {
  const earliest = earliestStart(input);
  const byStart = new Map<number, Slot>();
  for (const staffId of input.staffIds) {
    const plan = planFor(input, staffId);
    if (plan.durationMin <= 0) continue;
    const work = workSpans(input, staffId);
    const busy = [...blockSpans(input, staffId), ...heldSpans(input, staffId)];
    for (const t of gridStarts(input, staffId)) {
      if (t < earliest || !fits(plan, t, work, busy)) continue;
      const end = t + plan.durationMin * 60_000;
      const existing = byStart.get(t);
      if (existing) {
        existing.staffIds.push(staffId);
        existing.ends[staffId] = end;
        existing.end = Math.max(existing.end, end);
      } else byStart.set(t, { start: t, end, staffIds: [staffId], ends: { [staffId]: end } });
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/**
 * Does `start` sit on the grid computeDaySlots offers? With a barber: whole intervals of their
 * interval after the start of a stretch they work. Without one: the shop's interval after an opening.
 */
export function onSlotGrid(input: DayAvailabilityInput, start: number, staffId?: string): boolean {
  if (staffId) {
    const step = planFor(input, staffId).intervalMin * 60_000;
    return (
      scheduledSpans(input, staffId).some((w) => start >= w.start && start < w.end && (start - w.start) % step === 0) ||
      earlySpans(input, staffId).some((e) => start >= e.start && start < e.end && (e.anchor - start) % step === 0)
    );
  }
  const interval = (input.slotIntervalMin ?? 15) * 60_000;
  return toSpans(input.date, input.shopHours).some((open) => start >= open.start && (start - open.start) % interval === 0);
}

/** Can this barber take the booking at `start` (grid aside)? Used to validate a booking request server-side. */
export function isSlotFree(input: DayAvailabilityInput, staffId: string, start: number): boolean {
  if (start < earliestStart(input)) return false;
  const busy = [...blockSpans(input, staffId), ...heldSpans(input, staffId)];
  return fits(planFor(input, staffId), start, workSpans(input, staffId), busy);
}

/** The rules a staff "squeeze in" may bend. It never puts two services in one chair at once or books over time off. */
export type SqueezeBypass = "off_grid" | "buffer" | "outside_hours";
export const SQUEEZE_BYPASS_LABEL: Record<SqueezeBypass, string> = {
  off_grid: "off the time grid",
  buffer: "into buffer time",
  outside_hours: "outside working hours",
};

export type SqueezeResult = { ok: true; bypasses: SqueezeBypass[] } | { ok: false; reason: string };

/** What booking at `start` would bend, or why it can't be done even as a squeeze-in. No bypasses: it's an ordinary booking. */
export function squeezeCheck(input: DayAvailabilityInput, staffId: string, start: number): SqueezeResult {
  const plan = planFor(input, staffId);
  if (plan.durationMin <= 0) return { ok: false, reason: "Pick a service" };
  const now = input.now === undefined ? Date.now() : ms(input.now);
  if (start < now) return { ok: false, reason: "That time has already passed" };
  const h = holdAt(plan, start);
  if (blockSpans(input, staffId).some((b) => overlaps(b, h.service))) return { ok: false, reason: "The barber has time off then" };
  const services = input.appointments.filter((a) => isBusy(input, a, staffId)).map((a) => ({ start: ms(a.startsAt), end: ms(a.endsAt) }));
  if (services.some((s) => overlaps(s, h.service))) return { ok: false, reason: "The barber is with another client then" };
  const bypasses: SqueezeBypass[] = [];
  if (!onSlotGrid(input, start, staffId)) bypasses.push("off_grid");
  const work = workSpans(input, staffId);
  if (!work.some((w) => w.start <= h.inHours.start && w.end >= h.inHours.end)) bypasses.push("outside_hours");
  if ([...blockSpans(input, staffId), ...heldSpans(input, staffId)].some((b) => overlaps(b, h.held))) bypasses.push("buffer");
  return { ok: true, bypasses };
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
