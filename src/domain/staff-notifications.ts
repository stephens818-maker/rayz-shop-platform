/**
 * Per-staff notifications: how a barber hears that one of their clients booked, rescheduled,
 * cancelled or arrived, and when their clients get the first and second reminder. Unset follows
 * the defaults: no alerts to the barber, reminders 24 hours and 2 hours before.
 */

import { addDays, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";

export const STAFF_EVENTS = ["confirm", "reschedule", "cancel", "arrived", "late", "waitlist", "clock_out", "meal_break", "schedule", "pay_question"] as const;
export type StaffEvent = (typeof STAFF_EVENTS)[number];
export const STAFF_EVENT_LABEL: Record<StaffEvent, string> = {
  confirm: "New booking",
  reschedule: "Rescheduled",
  cancel: "Cancelled",
  arrived: "Client arrived",
  late: "Client running late",
  waitlist: "You're up",
  clock_out: "Clock-out reminder",
  meal_break: "Meal break reminder",
  schedule: "Schedule change",
  pay_question: "Pay question",
};
/** About one of their clients' appointments; the rest are about their own time. */
export const APPOINTMENT_EVENTS = ["confirm", "reschedule", "cancel", "arrived", "late", "waitlist"] as const satisfies readonly StaffEvent[];
/** Unset, these go to their staff app phones (push needs the app, so only people using it hear them); the rest stay off until chosen. */
export const PUSH_BY_DEFAULT: readonly StaffEvent[] = ["late", "waitlist", "clock_out", "meal_break", "schedule", "pay_question"];

export const STAFF_CHANNELS = ["sms", "email", "push"] as const;
export type StaffChannel = (typeof STAFF_CHANNELS)[number];
export const STAFF_CHANNEL_LABEL: Record<StaffChannel, string> = { sms: "Text", email: "Email", push: "App" };

/** First reminder choices, in hours: "see you tomorrow" still reads right for all of them. 0 is off. */
export const FIRST_REMINDER_HOURS = [0, 12, 18, 24, 30] as const;
export const SECOND_REMINDER_HOURS = [0, 1, 2, 3, 4] as const;
export const DEFAULT_REMINDERS = { firstHours: 24, secondHours: 2 } as const;

export interface StaffNotificationPrefs {
  events: Partial<Record<StaffEvent, StaffChannel[]>>;
  /** Unset follows DEFAULT_REMINDERS. */
  firstHours?: number;
  secondHours?: number;
}

export function cleanNotificationPrefs(raw: unknown): StaffNotificationPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ev = r.events && typeof r.events === "object" ? (r.events as Record<string, unknown>) : {};
  const events: StaffNotificationPrefs["events"] = {};
  for (const e of STAFF_EVENTS) {
    const v = ev[e];
    if (Array.isArray(v)) events[e] = STAFF_CHANNELS.filter((c) => v.includes(c));
  }
  const out: StaffNotificationPrefs = { events };
  const first = Number(r.firstHours);
  const second = Number(r.secondHours);
  if (r.firstHours !== undefined && r.firstHours !== null && (FIRST_REMINDER_HOURS as readonly number[]).includes(first)) out.firstHours = first;
  if (r.secondHours !== undefined && r.secondHours !== null && (SECOND_REMINDER_HOURS as readonly number[]).includes(second)) out.secondHours = second;
  return out;
}

/** The reminder times for this barber's clients, in hours before the start; 0 is no reminder. Unset follows the location's times. */
export function reminderHours(p: StaffNotificationPrefs | null | undefined, location: { firstHours: number; secondHours: number } = DEFAULT_REMINDERS): { firstHours: number; secondHours: number } {
  return { firstHours: p?.firstHours ?? location.firstHours, secondHours: p?.secondHours ?? location.secondHours };
}

export const channelsFor = (p: StaffNotificationPrefs | null | undefined, e: StaffEvent): StaffChannel[] => p?.events[e] ?? (PUSH_BY_DEFAULT.includes(e) ? ["push"] : []);

/**
 * Quiet hours: off the clock, a non-urgent app alert or text waits for the person's work time, so
 * nobody is pulled into work on their own time. Email isn't held. These always go at once: a client
 * here or running late, being up next, their own clock-out and meal reminders.
 */
export const URGENT_EVENTS: readonly StaffEvent[] = ["arrived", "late", "waitlist", "clock_out", "meal_break"];
/** Anything about an appointment starting this soon is urgent too, and a held one goes by then. */
export const URGENT_WITHIN_MIN = 120;
export const QUIET_CHANNELS: readonly StaffChannel[] = ["sms", "push"];
/** With no shift coming up in the next week, held messages go at 9 AM. */
export const QUIET_MORNING_MIN = 9 * 60;
export const QUIET_LOOKAHEAD_DAYS = 7;
/** A break with no planned length is taken to run this long. */
export const QUIET_BREAK_MIN = 30;

export const QUIET_HOURS_POLICY = {
  heldChannels: QUIET_CHANNELS,
  urgentEvents: URGENT_EVENTS,
  urgentWithinMin: URGENT_WITHIN_MIN,
  summary:
    "When you're off the clock or on a break, non-urgent texts and app alerts wait until you clock in, your break ends or your next scheduled shift starts (9 AM if you have none this week). Clients arriving or running late, being up next, clock-out and meal reminders, and anything about an appointment in the next two hours still come right away. Email isn't held.",
} as const;

export type WorkNow = { state: "working" } | { state: "on_break"; until: Date } | { state: "off" };
export interface QuietShift {
  weekday: number;
  startMin: number;
  endMin: number;
}

/**
 * When a held message should go, or null to send it now. Off the clock but inside a scheduled shift
 * counts as work time (someone running late still hears about today); a shift that starts during
 * time off is skipped.
 */
export function quietUntil(
  event: StaffEvent,
  o: { now: Date; work: WorkNow; shifts: readonly QuietShift[]; timeOff?: readonly { startsAt: Date; endsAt: Date }[]; startsAt?: Date | null },
): Date | null {
  if (isUrgent(event, o.now, o.startsAt) || o.work.state === "working") return null;
  const timeOff = o.timeOff ?? [];
  let hold = o.work.state === "on_break" ? o.work.until : (nextShiftStart(o.now, o.shifts, timeOff) ?? nextMorning(o.now, timeOff));
  if (o.startsAt) {
    const latest = new Date(o.startsAt.getTime() - URGENT_WITHIN_MIN * 60_000);
    if (latest < hold) hold = latest;
  }
  return hold > o.now ? hold : null;
}

export const isUrgent = (event: StaffEvent, now: Date, startsAt?: Date | null) =>
  URGENT_EVENTS.includes(event) || (!!startsAt && startsAt.getTime() - URGENT_WITHIN_MIN * 60_000 <= now.getTime());

function nextShiftStart(now: Date, shifts: readonly QuietShift[], timeOff: readonly { startsAt: Date; endsAt: Date }[]): Date | null {
  const today = todayLocal(now);
  let best: Date | null = null;
  for (let d = -1; d <= QUIET_LOOKAHEAD_DAYS; d++) {
    const date = addDays(today, d);
    for (const s of shifts) {
      if (s.weekday !== weekdayOf(date)) continue;
      const start = zonedWallTime(date, s.startMin).toJSDate();
      const end = zonedWallTime(date, s.endMin).toJSDate();
      if (end <= now) continue;
      const at = start > now ? start : now;
      if (timeOff.some((t) => t.startsAt <= at && t.endsAt > at)) continue;
      if (!best || at < best) best = at;
    }
  }
  return best;
}

function nextMorning(now: Date, timeOff: readonly { startsAt: Date; endsAt: Date }[]): Date {
  const today = todayLocal(now);
  for (let d = 0; d <= QUIET_LOOKAHEAD_DAYS; d++) {
    const at = zonedWallTime(addDays(today, d), QUIET_MORNING_MIN).toJSDate();
    if (at > now && !timeOff.some((t) => t.startsAt <= at && t.endsAt > at)) return at;
  }
  return zonedWallTime(addDays(today, QUIET_LOOKAHEAD_DAYS + 1), QUIET_MORNING_MIN).toJSDate();
}

/** The barber's own alert: short, with the client's first name only and no contact details. */
export function staffAlertText(e: (typeof APPOINTMENT_EVENTS)[number], a: { firstName: string | null; when: string; shopName: string; services?: string[]; detail?: string | null }): string {
  const who = a.firstName?.trim() || "A client";
  const what = a.services?.length ? ` (${a.services.join(", ")})` : "";
  switch (e) {
    case "confirm":
      return `Ray'z ${a.shopName}: ${who} booked you for ${a.when}${what}.`;
    case "reschedule":
      return `Ray'z ${a.shopName}: ${who} moved their appointment to ${a.when}${what}.`;
    case "cancel":
      return `Ray'z ${a.shopName}: ${who} cancelled ${a.when}.`;
    case "arrived":
      return `Ray'z ${a.shopName}: ${who} is here for ${a.when}${what}.`;
    case "late":
      return `Ray'z ${a.shopName}: ${who} is running ${a.detail ?? "late"} for ${a.when}.`;
    case "waitlist":
      return `Ray'z ${a.shopName}: ${who} is up next for you${what}.`;
  }
}
