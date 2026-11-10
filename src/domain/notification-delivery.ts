/**
 * Customer messages after they're queued: where each one got to (queued, sent, delivered, failed,
 * opted out), add-to-calendar links, when reminders go out around quiet hours, and the email
 * providers' delivery events. Pure: no database, no network.
 */
import { localMinutesOf } from "@/lib/time";
import { marketingEmailHtml } from "./marketing-email";
import { inQuietHours, sendTime, type OutreachRules } from "./outreach";

/** Kinds sent to a client (the rest go to staff or vendors). Their number or email shows as the viewer may see it. */
export const CLIENT_MESSAGE_KINDS = new Set([
  "confirmation",
  "reminder_24h",
  "reminder_2h",
  "cancellation",
  "reschedule",
  "otp",
  "waitlist_ready",
  "staff_text",
  "staff_call",
  "time_off_reschedule",
  "callin_reassign",
  "callin_rebook",
  "callin_voice",
  "callin_link",
  "missed_call",
  "shop_reply",
  "fill_offer",
  "rebook_nudge",
  "rebook_reminder",
  "no_show_reminder",
  "running_late",
  "receipt",
  "review_request",
  "marketing",
]);

/** What each kind of message is, for the outbox and message lists. */
export const MESSAGE_KIND_LABEL: Record<string, string> = {
  confirmation: "Confirmation",
  reminder_24h: "24h reminder",
  reminder_2h: "2h reminder",
  cancellation: "Cancellation",
  reschedule: "Rescheduled",
  otp: "Sign-in code",
  waitlist_ready: "Waitlist: ready",
  purchase_order: "Purchase order",
  low_stock: "Low stock",
  staff_text: "Text from staff",
  staff_call: "Call through shop line",
  privacy_alert: "Client data alert",
  time_off_reschedule: "Time off: please reschedule",
  time_off_decision: "Time off decision",
  clock_forgot_out: "Forgotten clock-out",
  ft_status_change: "Full-time / part-time change",
  clock_late_in: "Not clocked in for first client",
  clock_affected: "Clients booked over a break or clock-out",
  callin_reassign: "Call-in: moved to another barber",
  callin_rebook: "Call-in: rebook link",
  callin_voice: "Call-in: automated call",
  callin_link: "Call-in: link after a call",
  missed_call: "Missed call text",
  shop_reply: "Shop text",
  fill_offer: "Today: open-chair offer",
  rebook_nudge: "Today: due to rebook",
  rebook_reminder: "Rebook reminder from checkout",
  no_show_reminder: "Today: extra reminder",
  running_late: "Today: running late",
  digest: "Morning Dashboard",
  receipt: "Receipt",
  review_request: "Google review request",
  marketing: "Campaign Center",
  saved_report: "Custom report",
  access_alert: "Blocked sign-in alert",
  tip_payout: "Tip payout",
  tip_banking: "Payout account notice",
  tip_onboarding: "Payout setup invite",
  tip_declaration: "Cash tip declaration reminder",
  pay_question: "Pay question",
  staff_invite: "Brand portal invite",
  milestone: "Staff milestone",
};

/** Why a message wasn't sent when the client asked not to get it. */
export const OPT_OUT_REASON = {
  stop: "The number replied STOP",
  noCalls: "The client asked for no automated calls",
  bounce: "The address bounced, so emails to it are stopped",
  complaint: "The client marked an email as spam, so emails to it are stopped",
  unsubscribe: "The client stopped these emails",
  staff: "Emails to this address were stopped by staff",
  withdrawn: "The client turned these reminders off after they were queued",
} as const;
export type SuppressionReason = "bounce" | "complaint" | "unsubscribe" | "staff";
const OPT_OUT_TEXTS = new Set<string>(Object.values(OPT_OUT_REASON));

export type DeliveryState = "queued" | "sent" | "delivered" | "failed" | "opted_out" | "not_sent" | "cancelled";
export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  opted_out: "Opted out",
  not_sent: "Not sent (off)",
  cancelled: "Cancelled",
};
export const DELIVERY_TONE = { queued: "blue", sent: "green", delivered: "green", failed: "red", opted_out: "amber", not_sent: "gray", cancelled: "gray" } as const;

/** "suppressed" covers both an opt-out and a channel that's switched off; the reason tells them apart. */
export function deliveryState(j: { status: string; deliveredAt: Date | null; lastError: string | null }): DeliveryState {
  if (j.status === "pending") return "queued";
  if (j.status === "sent") return j.deliveredAt ? "delivered" : "sent";
  if (j.status === "failed") return "failed";
  if (j.status === "cancelled") return "cancelled";
  return j.lastError && OPT_OUT_TEXTS.has(j.lastError) ? "opted_out" : "not_sent";
}

// ───────────────────────────── Add to calendar ─────────────────────────────

const compactUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface CalendarEventLink {
  title: string;
  start: Date;
  end: Date;
  location: string;
  details: string;
}

/** Google Calendar and Outlook.com "add event" links; Apple and everything else use the .ics file. */
export function calendarLinks(e: CalendarEventLink): { google: string; outlook: string } {
  const g = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${compactUtc(e.start)}/${compactUtc(e.end)}`, location: e.location, details: e.details });
  const o = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: e.start.toISOString(),
    enddt: e.end.toISOString(),
    location: e.location,
    body: e.details,
  });
  return { google: `https://calendar.google.com/calendar/render?${g}`, outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${o}` };
}

// ───────────────────────────── Reminders and quiet hours ─────────────────────────────

/** A reminder moved out of quiet hours still lands at least this long before the appointment. */
export const REMINDER_MIN_LEAD_MIN = 30;
/** Two reminders pushed this close together become one. */
export const REMINDER_MIN_GAP_MIN = 120;

type Quiet = Pick<OutreachRules, "quietStartMin" | "quietEndMin">;

/** When the quiet hours that `at` falls in began, in shop time (the send window and the brand's own may overlap). */
function quietStartedAt(at: Date, r: Quiet): Date {
  let t = Math.floor(at.getTime() / 60_000) * 60_000;
  for (let i = 0; i < 24 * 60 && inQuietHours(localMinutesOf(new Date(t - 60_000)), r); i++) t -= 60_000;
  return new Date(t);
}

/**
 * When a reminder due at `target` goes out: then, unless that's in quiet hours (shop time, 9 AM to 8 PM at most).
 * Then it waits for quiet hours to end if that's still REMINDER_MIN_LEAD_MIN before the appointment,
 * else it goes the minute before quiet hours began. Null: nothing sensible is left (already past).
 */
export function placeReminder(target: Date, startsAt: Date, now: Date, r: Quiet): Date | null {
  if (target <= now) return null;
  if (!inQuietHours(localMinutesOf(target), r)) return target;
  const after = sendTime(target, r);
  if (after.getTime() <= startsAt.getTime() - REMINDER_MIN_LEAD_MIN * 60_000) return after;
  const before = new Date(quietStartedAt(target, r).getTime() - 60_000);
  return before > now ? before : null;
}

/** The first and second reminders' send times; the second is dropped when quiet hours push the two together. */
export function reminderTimes(startsAt: Date, now: Date, hours: { firstHours: number; secondHours: number }, r: Quiet): { first: Date | null; second: Date | null } {
  const at = (h: number) => (h > 0 ? placeReminder(new Date(startsAt.getTime() - h * 3_600_000), startsAt, now, r) : null);
  const first = at(hours.firstHours);
  let second = at(hours.secondHours);
  if (first && second && Math.abs(second.getTime() - first.getTime()) < REMINDER_MIN_GAP_MIN * 60_000) second = null;
  return { first, second };
}

// ───────────────────────────── Email provider events ─────────────────────────────

export interface EmailEvent {
  kind: "delivered" | "bounced" | "complained";
  messageId: string | null;
  email: string | null;
  /** A hard bounce: the address doesn't exist. Soft bounces (a full mailbox) don't stop future emails. */
  permanent: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Resend's webhook body (`email.delivered`, `email.bounced`, `email.complained`); anything else is ignored. */
export function resendEvent(raw: unknown): EmailEvent | null {
  const b = obj(raw);
  const data = obj(b.data);
  const to = Array.isArray(data.to) ? str(data.to[0]) : str(data.to);
  const base = { messageId: str(data.email_id), email: to };
  switch (b.type) {
    case "email.delivered":
      return { ...base, kind: "delivered", permanent: false };
    case "email.bounced": {
      const type = str(obj(data.bounce).type);
      return { ...base, kind: "bounced", permanent: !type || /permanent|hard/i.test(type) };
    }
    case "email.complained":
      return { ...base, kind: "complained", permanent: true };
    default:
      return null;
  }
}

/** Postmark's delivery, bounce and spam complaint webhooks. */
export function postmarkEvent(raw: unknown): EmailEvent | null {
  const b = obj(raw);
  const base = { messageId: str(b.MessageID), email: str(b.Email) ?? str(b.Recipient) };
  switch (b.RecordType) {
    case "Delivery":
      return { ...base, kind: "delivered", permanent: false };
    case "Bounce": {
      const type = str(b.Type) ?? "";
      if (type === "SpamComplaint" || type === "SpamNotification") return { ...base, kind: "complained", permanent: true };
      return { ...base, kind: "bounced", permanent: ["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "Blocked"].includes(type) };
    }
    case "SpamComplaint":
      return { ...base, kind: "complained", permanent: true };
    default:
      return null;
  }
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

// ───────────────────────────── The client email ─────────────────────────────

const MANAGE_LINK = /https?:\/\/\S+\/a\/[A-Za-z0-9]{4,16}(?=\s|$)/;

/**
 * The HTML part of an email to a client, in the brand's layout: the message, a button to the
 * booking when it links to one, and the shop's details and the stop-these-emails link in the footer.
 * The plain text keeps the location footer after a line with "—" (locationFooter).
 */
export function clientEmailHtml(o: { subject: string; body: string; unsubscribeUrl: string | null; color?: string | null }): string {
  const [main, footer = ""] = o.body.split(/\n\n?—\n/);
  const link = main.match(MANAGE_LINK)?.[0] ?? null;
  const stop = o.unsubscribeUrl ? `Don't want these emails? Stop them: ${o.unsubscribeUrl}` : "";
  const foot = [footer.trim(), stop].filter(Boolean).join("\n\n");
  return marketingEmailHtml({
    subject: o.subject,
    body: foot ? `${main.trim()}\n\n--\n${foot}` : main.trim(),
    cta: link ? { label: "View or change your booking", url: link } : null,
    color: o.color ?? null,
  });
}

/** The plain text part with the same stop link at the end. */
export const withUnsubscribe = (body: string, url: string | null) => (url ? `${body}\n\nDon't want these emails? Stop them: ${url}` : body);
