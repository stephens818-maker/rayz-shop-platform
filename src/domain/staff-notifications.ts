/**
 * Per-staff notifications: how a barber hears that one of their clients booked, rescheduled,
 * cancelled or arrived, and when their clients get the first and second reminder. Unset follows
 * the defaults: no alerts to the barber, reminders 24 hours and 2 hours before.
 */

export const STAFF_EVENTS = ["confirm", "reschedule", "cancel", "arrived"] as const;
export type StaffEvent = (typeof STAFF_EVENTS)[number];
export const STAFF_EVENT_LABEL: Record<StaffEvent, string> = { confirm: "New booking", reschedule: "Rescheduled", cancel: "Cancelled", arrived: "Client arrived" };

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

export const channelsFor = (p: StaffNotificationPrefs | null | undefined, e: StaffEvent): StaffChannel[] => p?.events[e] ?? [];

/** The barber's own alert: short, with the client's first name only and no contact details. */
export function staffAlertText(e: StaffEvent, a: { firstName: string | null; when: string; shopName: string; services?: string[] }): string {
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
  }
}
