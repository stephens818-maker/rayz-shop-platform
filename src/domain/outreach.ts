/**
 * Call-ins and client outreach: when a barber calls in, which appointments it hits, what each client is
 * offered (moved to another barber, a rebook link, an automated call), the rules for quiet hours and
 * follow-ups, and how a text reply is read. Pure; src/server/call-ins.ts and src/server/shop-line.ts
 * load rows and call these.
 */
import { addDays, localDateOf, localMinutesOf, minutesToLabel, weekdayOf, zonedWallTime } from "@/lib/time";

export type CallInKind = "sick" | "emergency" | "other";
export type OutreachOption = "reassign" | "rebook" | "voice";
export type OutreachStatus = "pending" | "notified" | "delivered" | "rebooked" | "declined" | "no_response" | "unreachable" | "cancelled";

export const CALL_IN_KINDS: readonly CallInKind[] = ["sick", "emergency", "other"];
export const CALL_IN_KIND_LABEL: Record<CallInKind, string> = { sick: "Sick", emergency: "Emergency", other: "Other" };
/** The block reason each kind is written with; "other" uses the reason the manager picks. */
export const CALL_IN_REASON_KEY: Record<Exclude<CallInKind, "other">, string> = { sick: "sick", emergency: "emergency" };

export const OUTREACH_OPTIONS: readonly OutreachOption[] = ["reassign", "rebook", "voice"];
export const OPTION_LABEL: Record<OutreachOption, string> = {
  reassign: "Move to a free barber",
  rebook: "Text and email a rebook link",
  voice: "Automated call",
};

export const STATUS_LABEL: Record<OutreachStatus, string> = {
  pending: "Not contacted",
  notified: "Notified",
  delivered: "Delivered",
  rebooked: "Rebooked",
  declined: "Declined",
  no_response: "No response",
  unreachable: "Can't reach",
  cancelled: "Closed",
};
export const STATUS_TONE: Record<OutreachStatus, "gray" | "blue" | "green" | "amber" | "red"> = {
  pending: "gray",
  notified: "blue",
  delivered: "blue",
  rebooked: "green",
  declined: "amber",
  no_response: "red",
  unreachable: "red",
  cancelled: "gray",
};

const TERMINAL: ReadonlySet<OutreachStatus> = new Set(["rebooked", "declined", "cancelled"]);
export const isOpen = (s: OutreachStatus) => !TERMINAL.has(s);
/** Waiting on the client: sent, and they haven't answered. */
export const isAwaiting = (s: OutreachStatus) => s === "notified" || s === "delivered";

export type OutreachEvent = "sent" | "delivered" | "rebooked" | "declined" | "no_response" | "unreachable" | "cancelled";

/** The status after an event, or null when it doesn't change. A rebook, decline or close is final. */
export function advance(current: OutreachStatus, event: OutreachEvent): OutreachStatus | null {
  if (TERMINAL.has(current)) return null;
  switch (event) {
    case "sent":
      return current === "delivered" || current === "notified" ? null : "notified";
    case "delivered":
      return current === "notified" ? "delivered" : null;
    case "no_response":
      return isAwaiting(current) ? "no_response" : null;
    case "unreachable":
      return current === "pending" || current === "notified" ? "unreachable" : null;
    default:
      return event === current ? null : event;
  }
}

// ───────────────────────────── Affected appointments ─────────────────────────────

/** Statuses a call-in touches. Clients already in the shop are listed but handled in person. */
export const AFFECTED_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;
export const REACHABLE_STATUSES = ["booked", "confirmed"] as const;

export interface ApptLike {
  id: string;
  staffId: string;
  shopId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

/** The barber's appointments the call-in hits: still on the books, overlapping it, and not over yet. */
export function affectedAppointments<A extends ApptLike>(
  callIn: { staffId: string; shopId: string | null; startsAt: Date; endsAt: Date },
  appts: readonly A[],
  now: Date,
): A[] {
  return appts
    .filter(
      (a) =>
        a.staffId === callIn.staffId &&
        (callIn.shopId === null || a.shopId === callIn.shopId) &&
        (AFFECTED_STATUSES as readonly string[]).includes(a.status) &&
        a.startsAt < callIn.endsAt &&
        callIn.startsAt < a.endsAt &&
        a.endsAt > now,
    )
    .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
}

export const reachable = (status: string) => (REACHABLE_STATUSES as readonly string[]).includes(status);

// ───────────────────────────── Channels and consent ─────────────────────────────

export interface ContactFacts {
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
  /** Replied STOP. */
  smsOptedOut: boolean;
  /** Pressed 9 on an automated call. */
  voiceOptedOut: boolean;
}

/** Where outreach may go: texts and emails only with the client's yes, calls unless they asked us to stop. */
export function channelsFor(c: ContactFacts) {
  return {
    sms: !!c.phone && c.smsOptIn && !c.smsOptedOut,
    email: !!c.email && c.emailOptIn,
    voice: !!c.phone && !c.voiceOptedOut,
  };
}
export type Channels = ReturnType<typeof channelsFor>;

/** What the shop is offered first for an appointment. */
export function suggestOption(o: { reachable: boolean; freeBarber: boolean; channels: Channels }): OutreachOption | null {
  if (!o.reachable) return null;
  if (o.freeBarber && (o.channels.sms || o.channels.email || o.channels.voice)) return "reassign";
  if (o.channels.sms || o.channels.email) return "rebook";
  if (o.channels.voice) return "voice";
  return null;
}

/** Why an option can't be sent to this client, or null. */
export function optionProblem(option: OutreachOption, c: Channels): string | null {
  if (option === "voice") return c.voice ? null : "There's no phone number to call, or the client asked not to get automated calls";
  if (option === "rebook") return c.sms || c.email ? null : "The client hasn't agreed to texts or emails. Use an automated call or phone them.";
  return null;
}

// ───────────────────────────── Rules: quiet hours, follow-ups, links ─────────────────────────────

export interface OutreachRules {
  /** Hours to wait for an answer before the one retry, and again before the appointment is flagged for staff. */
  retryAfterHours: number;
  /** No automated texts or calls between these local times (minutes after midnight). Equal values: no quiet hours. */
  quietStartMin: number;
  quietEndMin: number;
  /** How long a rebook link works. */
  linkTtlHours: number;
}

export const DEFAULT_OUTREACH_RULES: OutreachRules = { retryAfterHours: 3, quietStartMin: 21 * 60, quietEndMin: 8 * 60, linkTtlHours: 72 };

const intIn = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

export function cleanOutreachRules(raw: unknown): Partial<OutreachRules> {
  const out: Partial<OutreachRules> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const retry = intIn(r.retryAfterHours, 1, 48);
  const qs = intIn(r.quietStartMin, 0, 24 * 60 - 1);
  const qe = intIn(r.quietEndMin, 0, 24 * 60 - 1);
  const ttl = intIn(r.linkTtlHours, 1, 24 * 14);
  if (retry !== undefined) out.retryAfterHours = retry;
  if (qs !== undefined) out.quietStartMin = qs;
  if (qe !== undefined) out.quietEndMin = qe;
  if (ttl !== undefined) out.linkTtlHours = ttl;
  return out;
}

export const outreachRules = (raw: unknown): OutreachRules => ({ ...DEFAULT_OUTREACH_RULES, ...cleanOutreachRules(raw) });

export function outreachRulesProblem(raw: Record<string, unknown>): string | null {
  const clean = cleanOutreachRules(raw);
  if (raw.retryAfterHours !== undefined && clean.retryAfterHours === undefined) return "Wait 1 to 48 hours before following up";
  if (raw.linkTtlHours !== undefined && clean.linkTtlHours === undefined) return "Rebook links can last 1 hour to 14 days";
  if ((raw.quietStartMin !== undefined && clean.quietStartMin === undefined) || (raw.quietEndMin !== undefined && clean.quietEndMin === undefined)) return "Give quiet hours as times of day";
  return null;
}

export function inQuietHours(minutes: number, r: Pick<OutreachRules, "quietStartMin" | "quietEndMin">): boolean {
  const { quietStartMin: s, quietEndMin: e } = r;
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export const quietLabel = (r: Pick<OutreachRules, "quietStartMin" | "quietEndMin">) =>
  r.quietStartMin === r.quietEndMin ? "none" : `${minutesToLabel(r.quietStartMin)} to ${minutesToLabel(r.quietEndMin)}`;

/** When an automated message started now may go out: now, or when quiet hours end. */
export function sendTime(now: Date, r: Pick<OutreachRules, "quietStartMin" | "quietEndMin">): Date {
  const m = localMinutesOf(now);
  if (!inQuietHours(m, r)) return now;
  const today = localDateOf(now);
  const day = r.quietStartMin > r.quietEndMin && m >= r.quietStartMin ? addDays(today, 1) : today;
  return zonedWallTime(day, r.quietEndMin).toJSDate();
}

/** Too late to bother: the message would land under an hour before the appointment. Staff should phone instead. */
export const LAST_CALL_MIN = 60;
export const tooLateToSend = (at: Date, startsAt: Date) => at.getTime() > startsAt.getTime() - LAST_CALL_MIN * 60_000;

/** When to follow up after a try: the wait, but no later than an hour before the appointment and no sooner than 30 minutes. */
export function nextFollowUpAt(now: Date, startsAt: Date, r: Pick<OutreachRules, "retryAfterHours">): Date {
  const wait = now.getTime() + r.retryAfterHours * 3_600_000;
  const beforeAppt = startsAt.getTime() - LAST_CALL_MIN * 60_000;
  return new Date(Math.max(now.getTime() + 30 * 60_000, Math.min(wait, beforeAppt)));
}

export const MAX_ATTEMPTS = 2;

export type FollowUp = { action: "retry" } | { action: "flag"; reason: string } | null;

/**
 * What the follow-up job does for one row. Only rebook links and automated calls wait on the client;
 * a client moved to another barber keeps the appointment if they never answer.
 */
export function followUpDue(
  o: { option: OutreachOption | null; status: OutreachStatus; attempts: number; nextActionAt: Date | null; startsAt: Date },
  now: Date,
): FollowUp {
  if (!isAwaiting(o.status) || (o.option !== "rebook" && o.option !== "voice")) return null;
  if (o.startsAt <= now) return { action: "flag", reason: "The appointment time came with no answer" };
  if (!o.nextActionAt || o.nextActionAt > now) return null;
  if (o.attempts < MAX_ATTEMPTS) return { action: "retry" };
  return { action: "flag", reason: `No answer after ${o.attempts} tries` };
}

/** Whether the shop is open: a call outside this goes to the after-hours message. */
export function shopOpenAt(hours: readonly { weekday: number; openMin: number; closeMin: number }[], closedDates: readonly string[], now: Date): boolean {
  const date = localDateOf(now);
  if (closedDates.includes(date)) return false;
  const wd = weekdayOf(date);
  const m = localMinutesOf(now);
  return hours.some((h) => h.weekday === wd && m >= h.openMin && m < h.closeMin);
}

// ───────────────────────────── Rebook links ─────────────────────────────

export const linkExpiry = (now: Date, r: Pick<OutreachRules, "linkTtlHours">) => new Date(now.getTime() + r.linkTtlHours * 3_600_000);

export type LinkState = "ok" | "expired" | "used" | "revoked" | "closed";

/** Whether a link still works: not expired, used or replaced, and the appointment is still on the books. */
export function linkState(link: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null }, appointmentStatus: string, now: Date): LinkState {
  if (link.usedAt) return "used";
  if (link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  if (!reachable(appointmentStatus)) return "closed";
  return "ok";
}

export const LINK_STATE_MESSAGE: Record<Exclude<LinkState, "ok">, string> = {
  used: "This link was already used. Your appointment details are below.",
  revoked: "A newer link was sent for this appointment. Please use the latest text or email.",
  expired: "This link has expired. Call or text the shop and we'll find you a time.",
  closed: "This appointment can't be changed online any more. Call or text the shop.",
};

// ───────────────────────────── Text replies ─────────────────────────────

export type Reply = "accept" | "decline" | "stop" | "start" | "help" | "message";

/** Carrier opt-out and opt-in words, as Twilio reads them. */
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const ACCEPT = new Set(["1", "YES", "Y", "OK"]);
const DECLINE = new Set(["2", "NO", "N"]);

/** How the shop reads a text from a client. YES re-subscribes a number that replied STOP, as carriers do; otherwise it accepts. */
export function parseReply(body: string, o: { optedOut: boolean } = { optedOut: false }): Reply {
  const w = body.trim().toUpperCase().replace(/[.!\s]+$/g, "");
  if (STOP_WORDS.has(w)) return "stop";
  if (START_WORDS.has(w) || (o.optedOut && w === "YES")) return "start";
  if (HELP_WORDS.has(w)) return "help";
  if (ACCEPT.has(w)) return "accept";
  if (DECLINE.has(w)) return "decline";
  return "message";
}

// ───────────────────────────── What the client is told ─────────────────────────────

/** Never the reason: "sick" and "emergency" are private. */
export interface OutreachText {
  /** "Ray'z Coralville" */
  shop: string;
  firstName: string | null;
  barber: string;
  /** "Fri, Oct 23 at 10:00 AM" */
  when: string;
  link: string;
  suggestion?: { when: string; barber: string } | null;
  moved?: { barber: string; shop: string | null; address: string | null } | null;
  shopPhone?: string | null;
}

const hi = (n: string | null) => (n ? `Hi ${n}, ` : "");

export function outreachSms(option: "reassign" | "rebook", t: OutreachText): string {
  const sorry = `${t.shop}: ${hi(t.firstName)}sorry, ${t.barber} can't make your ${t.when} appointment.`;
  if (option === "reassign" && t.moved) {
    const where = t.moved.shop ? ` at ${t.moved.shop}${t.moved.address ? ` (${t.moved.address})` : ""}` : "";
    return `${sorry} We've booked you with ${t.moved.barber}${where} at the same time. Reply 1 to keep it, 2 to cancel, or pick another time or barber: ${t.link} Reply STOP to opt out.`;
  }
  const offer = t.suggestion ? ` Reply 1 for ${t.suggestion.when} with ${t.suggestion.barber}, or pick` : " Pick";
  return `${sorry}${offer} any time with any barber, same services: ${t.link} Reply 2 to cancel. Reply STOP to opt out.`;
}

export function outreachEmail(option: "reassign" | "rebook", t: OutreachText): { subject: string; body: string } {
  const greeting = t.firstName ? `Hi ${t.firstName},` : "Hi,";
  if (option === "reassign" && t.moved) {
    const where = t.moved.shop ? ` at ${t.moved.shop}${t.moved.address ? `, ${t.moved.address}` : ""}` : "";
    return {
      subject: `${t.shop}: your ${t.when} appointment is now with ${t.moved.barber}`,
      body: [
        greeting,
        `We're sorry: ${t.barber} can't make your appointment on ${t.when}. So you don't lose your spot, we've booked you with ${t.moved.barber}${where} at the same time, with the same services.`,
        `Prefer another time or barber, or need to cancel? Use this link: ${t.link}`,
        `See you soon,\n${t.shop}`,
      ].join("\n\n"),
    };
  }
  return {
    subject: `${t.shop}: please pick a new time for your ${t.when} appointment`,
    body: [
      greeting,
      `We're sorry: ${t.barber} can't make your appointment on ${t.when}.`,
      t.suggestion ? `The next opening is ${t.suggestion.when} with ${t.suggestion.barber}.` : null,
      `Pick any open time with any barber, or one you choose. Your services and add-ons stay the same: ${t.link}`,
      `Your booking stays on hold until you choose. Sorry for the trouble,\n${t.shop}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** What the automated call says. Spoken, so the shop's name is spelled the way it sounds. */
export function voiceScript(t: Pick<OutreachText, "shop" | "firstName" | "barber" | "when" | "shopPhone">) {
  const shop = t.shop.replace("Ray'z", "Rays");
  const intro = `Hi${t.firstName ? ` ${t.firstName}` : ""}, this is ${shop}. We're sorry, ${t.barber} can't make your appointment on ${t.when}.`;
  return {
    human: intro,
    menu: "Press 1 and we'll text you a link to pick a new time with any barber. Press 2 to talk to the shop. Press 9 to stop these calls.",
    noInput: "We didn't get that. We'll try you again later. Goodbye.",
    voicemail: `${intro} Please call or text us${t.shopPhone ? ` at ${spokenPhone(t.shopPhone)}` : ""} and we'll find you a new time. Thank you.`,
    texted: "We've texted you a link. Goodbye.",
    cantText: "We can't text this number. Please call the shop and we'll find you a new time. Goodbye.",
    connecting: "Connecting you to the shop.",
    optedOut: "You won't get these calls again. Goodbye.",
  };
}

/** "+13195551234" → "3 1 9, 5 5 5, 1 2 3 4" so text-to-speech reads it digit by digit. */
export function spokenPhone(e164: string) {
  const d = e164.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? [d.slice(0, 3), d.slice(3, 6), d.slice(6)].map((g) => g.split("").join(" ")).join(", ") : d.split("").join(" ");
}

/** Auto-text after a missed or after-hours call. */
export function missedCallText(o: { shop: string; afterHours: boolean; link: string; rebook: boolean }) {
  const lead = o.afterHours ? `${o.shop}: Thanks for calling. We're closed right now.` : `${o.shop}: Sorry we missed your call.`;
  return o.rebook ? `${lead} Pick a new time for your appointment here: ${o.link}` : `${lead} Book online anytime: ${o.link} Or text us here.`;
}

export const HELP_TEXT = (shop: string) => `${shop}: Text us here and the shop will answer. Reply STOP to opt out of texts.`;
export const STOP_CONFIRM = (shop: string) => `${shop}: You're unsubscribed and won't get more texts. Reply START to opt back in.`;
export const START_CONFIRM = (shop: string) => `${shop}: You're subscribed to texts again. Reply STOP to opt out.`;
