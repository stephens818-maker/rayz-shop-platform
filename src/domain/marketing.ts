/**
 * Campaign Center rules, kept pure: the automated campaigns and their settings, the message
 * templates and merge fields, quiet hours in the shop's time zone, frequency caps, which channel a
 * client hears on, the segment builder's filters, lapsed sequences and the report's ROI. The engine in
 * src/server/marketing gathers the facts and these decide.
 */
import { DateTime } from "luxon";
import { z } from "zod";

export const CHANNELS = ["sms", "email", "push"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { sms: "Text", email: "Email", push: "App push" };

// ───────────────────────────── Merge fields and templates ─────────────────────────────

export const MARKETING_FIELDS = {
  first_name: "The client's first name",
  shop: "The location, e.g. Ray'z Coralville",
  barber: "The barber's first name (their usual barber, or the one the campaign is about)",
  book_link: "A tracked link to book online",
  coupon_code: "The coupon code (a single-use code when the coupon has them)",
  expiry: "When the coupon stops working, e.g. Nov 30",
} as const;
export type MarketingField = keyof typeof MARKETING_FIELDS;
export type MarketingValues = Partial<Record<MarketingField, string>>;

export interface Templates {
  sms: string;
  emailSubject: string;
  emailBody: string;
  pushTitle: string;
  pushBody: string;
}

export const TemplatesSchema = z.object({
  sms: z.string().max(480).default(""),
  emailSubject: z.string().max(150).default(""),
  emailBody: z.string().max(5000).default(""),
  pushTitle: z.string().max(65).default(""),
  pushBody: z.string().max(240).default(""),
});

const FIELD_RE = /\{([a-z_]+)\}/g;
/** Two SMS segments; longer texts cost more. */
export const MARKETING_SMS_MAX = 320;
export const STOP_LINE = "Reply STOP to opt out.";

/** What's wrong with a campaign's wording, or null. */
export function templatesProblem(t: Templates, channels: readonly Channel[], o: { hasCoupon: boolean }): string | null {
  const parts: [string, string, Channel][] = [
    ["Text", t.sms, "sms"],
    ["Email subject", t.emailSubject, "email"],
    ["Email", t.emailBody, "email"],
    ["Push title", t.pushTitle, "push"],
    ["Push", t.pushBody, "push"],
  ];
  for (const [label, text] of parts) {
    for (const [, f] of text.matchAll(FIELD_RE)) {
      if (!(f in MARKETING_FIELDS)) return `${label}: {${f}} isn't a merge field. Use ${Object.keys(MARKETING_FIELDS).map((x) => `{${x}}`).join(", ")}.`;
      if ((f === "coupon_code" || f === "expiry") && !o.hasCoupon) return `${label}: pick a coupon to use {${f}}`;
    }
    if (/\{[^}]*$|^[^{]*\}/.test(text)) return `${label}: a { or } isn't closed`;
  }
  for (const [label, text, ch] of parts) if (channels.includes(ch) && !text.trim()) return `${label} can't be empty when the campaign sends by ${CHANNEL_LABEL[ch].toLowerCase()}`;
  if (channels.includes("sms") && !/\bSTOP\b/.test(t.sms)) return `Texts must say how to opt out (${STOP_LINE})`;
  if (channels.includes("sms") && fill(t.sms, SAMPLE_VALUES).length > MARKETING_SMS_MAX) return `Keep the text under ${MARKETING_SMS_MAX} characters with the sample filled in`;
  return null;
}

export function fill(text: string, values: MarketingValues): string {
  return text
    .replace(FIELD_RE, (_, f: string) => values[f as MarketingField] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,!?])/g, "$1")
    .trim();
}

export const SAMPLE_VALUES: MarketingValues = {
  first_name: "Jordan",
  shop: "Ray'z Coralville",
  barber: "Marcus",
  book_link: "https://rayz.example/m/Xy12abCD",
  coupon_code: "MISSYOU-7K2Q9D",
  expiry: "Nov 30",
};

/** The footer every marketing email carries (CAN-SPAM): who it's from, the brand's postal address and a working unsubscribe link. */
export function emailFooter(o: { brand: string; address: string; unsubscribeUrl: string }): string {
  return `\n\n--\n${o.brand}\n${o.address}\nYou're getting this because you agreed to emails from ${o.brand}. Unsubscribe: ${o.unsubscribeUrl}`;
}

export interface Rendered {
  sms: string;
  email: { subject: string; body: string };
  push: { title: string; body: string };
}

/** The messages for one client. Texts always end with the opt-out line, emails with the footer. */
export function render(t: Templates, v: MarketingValues, footer: { brand: string; address: string; unsubscribeUrl: string }): Rendered {
  const sms = fill(t.sms, v);
  return {
    sms: /\bSTOP\b/.test(sms) ? sms : `${sms} ${STOP_LINE}`.trim(),
    email: { subject: fill(t.emailSubject, v), body: fill(t.emailBody, v) + emailFooter(footer) },
    push: { title: fill(t.pushTitle, v), body: fill(t.pushBody, v) },
  };
}

// ───────────────────────────── Automated campaigns ─────────────────────────────

export interface TriggerSetting {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit: string;
}

export interface TriggerDef {
  key: TriggerKey;
  label: string;
  /** When it goes out, for the list. */
  when: (s: Record<string, number>) => string;
  settings: TriggerSetting[];
  templates: Templates;
}

const tpl = (sms: string, emailSubject: string, emailBody: string, pushTitle: string, pushBody: string): Templates => ({ sms, emailSubject, emailBody, pushTitle, pushBody });

export const TRIGGER_KEYS = ["birthday", "lapsed", "win_back", "first_visit", "milestone", "no_show", "rebook", "announcement", "fill_slow_day", "abandoned_booking", "barber_outreach"] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];
export const isTriggerKey = (k: unknown): k is TriggerKey => typeof k === "string" && (TRIGGER_KEYS as readonly string[]).includes(k);

export const TRIGGERS: Record<TriggerKey, TriggerDef> = {
  birthday: {
    key: "birthday",
    label: "Birthday",
    when: (s) => `${s.daysBefore ? `${s.daysBefore} days before` : "On"} the client's birthday`,
    settings: [{ key: "daysBefore", label: "Days before the birthday", min: 0, max: 30, default: 7, unit: "days" }],
    templates: tpl(
      `{shop}: Happy early birthday, {first_name}! Treat yourself to a fresh cut: {book_link} ${STOP_LINE}`,
      "Happy birthday from {shop}",
      "Hi {first_name},\n\nHappy birthday from all of us at {shop}! Celebrate with a fresh cut. Book here: {book_link}",
      "Happy birthday, {first_name}!",
      "Celebrate with a fresh cut at {shop}.",
    ),
  },
  lapsed: {
    key: "lapsed",
    label: "We miss you",
    when: (s) => `No visit in ${s.days} days`,
    settings: [{ key: "days", label: "Days since the last visit", min: 14, max: 365, default: 42, unit: "days" }],
    templates: tpl(
      `{shop}: Hi {first_name}, we miss you! It's been a while since your last cut. Book: {book_link} ${STOP_LINE}`,
      "We miss you at {shop}",
      "Hi {first_name},\n\nIt's been a while! {barber} would love to see you back in the chair. Book your next cut: {book_link}",
      "We miss you, {first_name}",
      "It's been a while. Book your next cut at {shop}.",
    ),
  },
  win_back: {
    key: "win_back",
    label: "Win-back",
    when: (s) => `No visit in ${s.days} days`,
    settings: [{ key: "days", label: "Days since the last visit", min: 30, max: 730, default: 90, unit: "days" }],
    templates: tpl(
      `{shop}: {first_name}, come back and see us! Book here: {book_link} ${STOP_LINE}`,
      "Come back to {shop}",
      "Hi {first_name},\n\nWe'd love to have you back at {shop}. Book a time that suits you: {book_link}",
      "Come back to {shop}",
      "We'd love to see you again, {first_name}.",
    ),
  },
  first_visit: {
    key: "first_visit",
    label: "Thanks for your first visit",
    when: (s) => `${s.delayHours} hours after a client's first visit`,
    settings: [{ key: "delayHours", label: "Hours after the visit", min: 1, max: 72, default: 24, unit: "hours" }],
    templates: tpl(
      `{shop}: Thanks for your first visit, {first_name}! Book your next cut with {barber}: {book_link} ${STOP_LINE}`,
      "Thanks for visiting {shop}",
      "Hi {first_name},\n\nThanks for choosing {shop}. When you're ready for your next cut with {barber}, book here: {book_link}",
      "Thanks for visiting {shop}",
      "Book your next cut with {barber} anytime.",
    ),
  },
  milestone: {
    key: "milestone",
    label: "Visit milestone",
    when: (s) => `After a client's ${s.visits}th visit`,
    settings: [{ key: "visits", label: "Visit number", min: 2, max: 200, default: 10, unit: "visits" }],
    templates: tpl(
      `{shop}: {first_name}, that's a milestone visit! Thanks for being a regular. Book: {book_link} ${STOP_LINE}`,
      "Thanks for being a regular at {shop}",
      "Hi {first_name},\n\nYou've hit a milestone with us. Thanks for being part of {shop}! Book your next cut: {book_link}",
      "Thanks for being a regular",
      "You've hit a milestone at {shop}, {first_name}.",
    ),
  },
  no_show: {
    key: "no_show",
    label: "Missed appointment follow-up",
    when: (s) => `${s.delayHours} hours after a no-show`,
    settings: [{ key: "delayHours", label: "Hours after the missed time", min: 1, max: 72, default: 3, unit: "hours" }],
    templates: tpl(
      `{shop}: Hi {first_name}, we missed you today. Pick a new time: {book_link} ${STOP_LINE}`,
      "We missed you at {shop}",
      "Hi {first_name},\n\nWe missed you at your appointment. Life happens! Pick a new time here: {book_link}",
      "We missed you today",
      "Pick a new time at {shop}.",
    ),
  },
  rebook: {
    key: "rebook",
    label: "Rebook reminder",
    when: (s) => `${s.leadDays ? `${s.leadDays} days before` : "When"} a regular is due, from their usual time between cuts`,
    settings: [{ key: "leadDays", label: "Days before they're due", min: 0, max: 14, default: 3, unit: "days" }],
    templates: tpl(
      `{shop}: {first_name}, you're about due for a cut with {barber}. Book: {book_link} ${STOP_LINE}`,
      "Time for a fresh cut?",
      "Hi {first_name},\n\nYou're about due for your next cut with {barber}. Grab a time: {book_link}",
      "Due for a cut?",
      "Book your next cut with {barber}.",
    ),
  },
  announcement: {
    key: "announcement",
    label: "New barber or location",
    when: (s) => `When a barber starts or a location opens, to clients within ${s.radiusMiles} miles`,
    settings: [
      { key: "radiusMiles", label: "Nearby (miles)", min: 1, max: 100, default: 15, unit: "miles" },
      { key: "withinDays", label: "Announce within (days of starting)", min: 1, max: 60, default: 14, unit: "days" },
    ],
    templates: tpl(
      `{shop}: {first_name}, meet {barber}, now taking bookings near you! Book: {book_link} ${STOP_LINE}`,
      "Now open near you: {shop}",
      "Hi {first_name},\n\nGood news: {barber} is now taking bookings at {shop}, near you. Book here: {book_link}",
      "New at {shop}",
      "{barber} is now taking bookings near you.",
    ),
  },
  fill_slow_day: {
    key: "fill_slow_day",
    label: "Fill slow days",
    when: (s) => `When a barber's next day is under ${s.utilizationPct}% booked, to their regulars`,
    settings: [
      { key: "utilizationPct", label: "Booked under (%)", min: 5, max: 95, default: 50, unit: "%" },
      { key: "maxPerBarber", label: "Most clients per barber per day", min: 1, max: 100, default: 20, unit: "clients" },
    ],
    templates: tpl(
      `{shop}: {first_name}, {barber} has openings tomorrow. Book with code {coupon_code}: {book_link} ${STOP_LINE}`,
      "{barber} has openings tomorrow",
      "Hi {first_name},\n\n{barber} has time tomorrow at {shop}. Use code {coupon_code} by {expiry}. Book: {book_link}",
      "{barber} has openings tomorrow",
      "Book with code {coupon_code}.",
    ),
  },
  abandoned_booking: {
    key: "abandoned_booking",
    label: "Finish your booking",
    when: (s) => `${s.delayMinutes} minutes after a client starts booking online and doesn't finish`,
    settings: [{ key: "delayMinutes", label: "Minutes after they stop", min: 15, max: 1440, default: 60, unit: "minutes" }],
    templates: tpl(
      `{shop}: {first_name}, still want that cut? Finish booking: {book_link} ${STOP_LINE}`,
      "Finish booking at {shop}",
      "Hi {first_name},\n\nYou started booking at {shop} but didn't finish. Pick up where you left off: {book_link}",
      "Finish your booking",
      "Your time at {shop} isn't booked yet.",
    ),
  },
  barber_outreach: {
    key: "barber_outreach",
    label: "From your barber",
    when: (s) => `When a barber sends it to their own clients with no visit in ${s.minDays} days or more`,
    settings: [
      { key: "minDays", label: "Only clients with no visit in at least (days)", min: 7, max: 365, default: 14, unit: "days" },
      { key: "maxPerDay", label: "Most clients a barber can message a day", min: 1, max: 200, default: 25, unit: "clients" },
    ],
    templates: tpl(
      `{shop}: Hi {first_name}, it's {barber}. It's been a minute! I'd love to get you back in the chair: {book_link} ${STOP_LINE}`,
      "{barber} at {shop} misses you",
      "Hi {first_name},\n\nIt's {barber} at {shop}. It's been a little while since your last cut. Grab a time with me here: {book_link}\n\n{barber}",
      "{barber} at {shop}",
      "It's been a minute, {first_name}. Book your next cut with {barber}.",
    ),
  },
};

/** Campaigns that only go out when someone sends them, never from the scheduled run. */
export const MANUAL_TRIGGERS: ReadonlySet<TriggerKey> = new Set(["barber_outreach"]);

/** The coupon-dependent default only makes sense with a coupon; without one the line is dropped. */
export function defaultTemplates(key: TriggerKey, hasCoupon: boolean): Templates {
  const t = { ...TRIGGERS[key].templates };
  if (hasCoupon || key !== "fill_slow_day") return t;
  return {
    ...t,
    sms: `{shop}: {first_name}, {barber} has openings tomorrow. Book: {book_link} ${STOP_LINE}`,
    emailBody: "Hi {first_name},\n\n{barber} has time tomorrow at {shop}. Book: {book_link}",
    pushBody: "Book a time with {barber}.",
  };
}

/** The trigger's settings with defaults filled in and out-of-range values clamped. */
export function triggerSettings(key: TriggerKey, raw: unknown): Record<string, number> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    TRIGGERS[key].settings.map((s) => {
      const v = Number(o[s.key]);
      return [s.key, Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, Math.round(v))) : s.default];
    }),
  );
}

/** Lapsed, win-back and rebook clients are caught up to this long after they cross the line, so turning one on doesn't text every old client at once. */
export const CATCH_UP_DAYS = 14;

/** Days from `today` to the next birthday on or after it (Feb 29 birthdays count on Feb 28 in other years). */
export function daysToBirthday(birthday: string, today: string): { days: number; year: number } {
  const t = DateTime.fromISO(today);
  const [, mm, dd] = birthday.split("-").map(Number);
  const on = (y: number) => {
    const leap = DateTime.local(y, 2, 1).isInLeapYear;
    return DateTime.local(y, mm, mm === 2 && dd === 29 && !leap ? 28 : dd);
  };
  let next = on(t.year);
  if (next < t.startOf("day")) next = on(t.year + 1);
  return { days: Math.round(next.diff(t.startOf("day"), "days").days), year: next.year };
}

/** Due a rebook reminder: a regular (3+ visits) with a usual gap of a week to four months, within the reminder window. */
export function rebookReminderDue(h: { visits: number; usualDays: number; sinceDays: number }, leadDays: number): boolean {
  if (h.visits < 3 || h.usualDays < 7 || h.usualDays > 120) return false;
  const from = h.usualDays - leadDays;
  return h.sinceDays >= from && h.sinceDays < from + CATCH_UP_DAYS;
}

/** Miles between two points (haversine). */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// ───────────────────────────── Brand settings ─────────────────────────────

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 21:00");

export const MarketingSettingsSchema = z.object({
  /** No marketing goes out from quietStart to quietEnd, in each location's time zone. */
  quietStart: hhmm.default("21:00"),
  quietEnd: hhmm.default("09:00"),
  /** Most marketing messages one client gets, all campaigns together. */
  capPerWeek: z.number().int().min(1).max(14).default(2),
  capPerMonth: z.number().int().min(1).max(60).default(6),
  /** The brand's postal address, printed on every marketing email (CAN-SPAM). */
  address: z.string().trim().max(300).default(""),
  /** A booking or a sale within this many days after a message counts toward that campaign. */
  attributionDays: z.number().int().min(1).max(60).default(7),
  /** What each message costs, in cents, for ROI. */
  smsCostCents: z.number().min(0).max(100).default(1),
  emailCostCents: z.number().min(0).max(100).default(0.1),
  pushCostCents: z.number().min(0).max(100).default(0),
  /** The answer to HELP. */
  helpText: z.string().trim().max(300).default("Ray'z Barber Shop: appointment and offer texts. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out."),
});
export type MarketingSettings = z.infer<typeof MarketingSettingsSchema>;
export const MARKETING_DEFAULTS: MarketingSettings = MarketingSettingsSchema.parse({});

export function marketingSettings(raw: unknown): MarketingSettings {
  const r = MarketingSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...MARKETING_DEFAULTS };
  for (const [k, v] of Object.entries(MarketingSettingsSchema.shape)) {
    const one = (v as z.ZodType).safeParse(o[k]);
    if (one.success) out[k] = one.data;
  }
  return out as MarketingSettings;
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Inside quiet hours at this local time (minutes after midnight). The window can wrap midnight. */
export function inQuiet(localMinutes: number, s: Pick<MarketingSettings, "quietStart" | "quietEnd">): boolean {
  const a = toMin(s.quietStart);
  const b = toMin(s.quietEnd);
  if (a === b) return false;
  return a < b ? localMinutes >= a && localMinutes < b : localMinutes >= a || localMinutes < b;
}

/** When a message may go out: now, or when quiet hours end in this time zone. */
export function nextSendAt(now: Date, timeZone: string, s: Pick<MarketingSettings, "quietStart" | "quietEnd">): Date {
  const local = DateTime.fromJSDate(now).setZone(timeZone);
  if (!inQuiet(local.hour * 60 + local.minute, s)) return now;
  const end = toMin(s.quietEnd);
  let at = local.startOf("day").plus({ minutes: end });
  if (at <= local) at = at.plus({ days: 1 });
  return at.toJSDate();
}

/** Over the frequency cap, given when this client's earlier marketing went out. */
export function capProblem(sentAt: readonly Date[], now: Date, s: Pick<MarketingSettings, "capPerWeek" | "capPerMonth">): "cap_week" | "cap_month" | null {
  const t = now.getTime();
  const week = sentAt.filter((d) => t - d.getTime() < 7 * 86_400_000).length;
  if (week >= s.capPerWeek) return "cap_week";
  const month = sentAt.filter((d) => t - d.getTime() < 30 * 86_400_000).length;
  if (month >= s.capPerMonth) return "cap_month";
  return null;
}

export type Reach = Record<Channel, boolean>;

/** The first channel in the campaign's order that this client can get marketing on. */
export const pickChannel = (order: readonly Channel[], reach: Reach): Channel | null => order.find((c) => reach[c]) ?? null;

export const costCents = (ch: Channel, s: Pick<MarketingSettings, "smsCostCents" | "emailCostCents" | "pushCostCents">) =>
  ch === "sms" ? s.smsCostCents : ch === "email" ? s.emailCostCents : s.pushCostCents;

/** Return on spend: what came back over what it cost (message costs plus coupon discounts). Null with no cost. */
export function roi(revenueCents: number, spendCents: number): number | null {
  return spendCents > 0 ? (revenueCents - spendCents) / spendCents : null;
}

export const SKIP_LABEL: Record<string, string> = {
  no_consent: "Hasn't agreed to marketing",
  unsubscribed: "Unsubscribed",
  cap_week: "Weekly limit reached",
  cap_month: "Monthly limit reached",
  no_coupon: "No coupon codes left",
};

// ───────────────────────────── Segments ─────────────────────────────

const ids = z.array(z.uuid()).max(200).default([]);
const optInt = (max: number) => z.number().int().min(0).max(max).nullable().default(null);

export const BARBER_MATCHES = ["primary", "recent", "any"] as const;
export type BarberMatch = (typeof BARBER_MATCHES)[number];
export const BARBER_MATCH_LABEL: Record<BarberMatch, string> = {
  primary: "Their primary barber",
  recent: "Their most recent barber",
  any: "Any visit with",
};
export const BARBER_MATCH_HINT: Record<BarberMatch, string> = {
  primary: "The preferred barber on the client's profile, or the barber of their last visit when none is set.",
  recent: "Who cut them last.",
  any: "Any completed visit with one of these barbers, ever.",
};

export const SegmentSchema = z.object({
  /** Clients whose last visit was at one of these locations (empty: the campaign's locations). */
  shopIds: ids,
  /** Clients of these barbers, matched as `barberMatch` says. */
  staffIds: ids,
  barberMatch: z.enum(BARBER_MATCHES).default("any"),
  /** Last visit no longer ago than this. With lastVisitOverDays it's a range, e.g. 21 to 28 days. */
  lastVisitWithinDays: optInt(3650),
  /** Last visit more than this many days ago. Clients who never visited don't match. */
  lastVisitOverDays: optInt(3650),
  /** Nothing booked since their last visit (a booking they cancelled doesn't count). */
  notBooked: z.boolean().default(false),
  minVisits: optInt(10000),
  maxVisits: optInt(10000),
  /** Net spend over all visits, in cents. */
  minSpendCents: optInt(100_000_000),
  maxSpendCents: optInt(100_000_000),
  /** Bought any of these services or products. */
  serviceIds: ids,
  /** 1 to 12. */
  birthdayMonths: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  /** Average staff rating of the client, 1 to 5 stars. */
  minRating: z.number().min(1).max(5).nullable().default(null),
  maxRating: z.number().min(1).max(5).nullable().default(null),
  /** Available loyalty rewards, in cents. */
  minLoyaltyCents: optInt(10_000_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  /** Only clients who agreed to marketing on this channel. */
  channel: z.enum(["any", ...CHANNELS]).default("any"),
});
export type Segment = z.infer<typeof SegmentSchema>;
export const EMPTY_SEGMENT: Segment = SegmentSchema.parse({});

/** The segment builder's quick filters: last visit more than this many weeks ago. */
export const LAPSED_WEEKS = [2, 3, 4, 5, 6, 8, 12] as const;

/** "Last visit more than 3 weeks ago" as a segment: nothing booked since, so it's clients who really lapsed. */
export const lapsedOver = (weeks: number): Pick<Segment, "lastVisitOverDays" | "lastVisitWithinDays" | "notBooked"> => ({ lastVisitOverDays: weeks * 7, lastVisitWithinDays: null, notBooked: true });
/** "Last visit 3 to 4 weeks ago". */
export const lapsedBetween = (fromDays: number, toDays: number): Pick<Segment, "lastVisitOverDays" | "lastVisitWithinDays" | "notBooked"> => ({
  lastVisitOverDays: fromDays,
  lastVisitWithinDays: toDays,
  notBooked: true,
});

const weeksOrDays = (d: number) => (d % 7 === 0 ? `${d / 7} week${d === 7 ? "" : "s"}` : `${d} days`);
/** The last-visit filter in words, or null with none. */
export function lastVisitLabel(s: Pick<Segment, "lastVisitOverDays" | "lastVisitWithinDays">): string | null {
  const over = s.lastVisitOverDays;
  const within = s.lastVisitWithinDays;
  if (over !== null && within !== null) {
    const same = over % 7 === 0 && within % 7 === 0;
    return same ? `Last visit ${over / 7} to ${within / 7} weeks ago` : `Last visit ${over} to ${within} days ago`;
  }
  if (over !== null) return `Last visit more than ${weeksOrDays(over)} ago`;
  if (within !== null) return `Last visit within ${weeksOrDays(within)}`;
  return null;
}

/** A filter on a client detail the person can't see would reveal it, so it's refused. */
export function segmentProblem(s: Segment, sees: { birthday: boolean; ratings: boolean; preferredBarber?: boolean }): string | null {
  if (s.birthdayMonths.length && !sees.birthday) return "You can't filter by birthday because client birthdays are hidden from you";
  if ((s.minRating !== null || s.maxRating !== null) && !sees.ratings) return "You can't filter by rating because client ratings are hidden from you";
  if (s.staffIds.length && s.barberMatch === "primary" && sees.preferredBarber === false)
    return "You can't filter by primary barber because clients' preferred barbers are hidden from you. Use their most recent barber instead.";
  if (s.lastVisitOverDays !== null && s.lastVisitWithinDays !== null && s.lastVisitWithinDays <= s.lastVisitOverDays)
    return "The last-visit range is empty: the far end has to be further back than the near end (e.g. 3 to 4 weeks)";
  if (s.minVisits !== null && s.maxVisits !== null && s.minVisits > s.maxVisits) return "The fewest visits is more than the most";
  if (s.minSpendCents !== null && s.maxSpendCents !== null && s.minSpendCents > s.maxSpendCents) return "The lowest spend is more than the highest";
  if (s.minRating !== null && s.maxRating !== null && s.minRating > s.maxRating) return "The lowest rating is more than the highest";
  return null;
}

/** Idempotency: one send per campaign, client and occasion. The database refuses a second row with the same key. */
export const dedupeKey = (campaignId: string, customerId: string, occasion: string) => `${campaignId}:${customerId}:${occasion}`;

// ───────────────────────────── Lapsed sequences ─────────────────────────────

/**
 * A lapsed sequence is several messages to the same lapsed client, each at its own point after
 * their last visit (2 weeks, 3, 4, 6+), each with its own wording and optional coupon. A client
 * gets the step for how long it's been, once per lapse, and leaves the sequence when they book.
 */
export const SEQUENCE_MAX_STEPS = 6;
/** Steps at least this far apart, so a client hears from a sequence at most once a week. */
export const STEP_GAP_DAYS = 7;

export const SequenceStepSchema = z.object({
  id: z.uuid().nullable().default(null),
  afterDays: z.number().int().min(7).max(365),
  templates: TemplatesSchema,
  promoId: z.uuid().nullable().default(null),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

/** Whose clients a sequence is for, beyond its locations. Empty barbers: every client of the locations. */
export const SequenceAudienceSchema = z.object({
  staffIds: ids,
  barberMatch: z.enum(["primary", "recent"]).default("primary"),
});
export type SequenceAudience = z.infer<typeof SequenceAudienceSchema>;

export const SequenceSettingsSchema = z.object({
  /** No message once the last visit is this long ago: turning a sequence on doesn't text every client who left years ago. */
  stopAfterDays: z.number().int().min(14).max(730).default(120),
});
export type SequenceSettings = z.infer<typeof SequenceSettingsSchema>;

export function stepsProblem(steps: readonly Pick<SequenceStep, "afterDays">[], stopAfterDays: number): string | null {
  if (!steps.length) return "Add at least one step";
  if (steps.length > SEQUENCE_MAX_STEPS) return `At most ${SEQUENCE_MAX_STEPS} steps`;
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].afterDays - steps[i - 1].afterDays < STEP_GAP_DAYS) return `Put each step at least a week after the one before (step ${i + 1} is ${steps[i].afterDays - steps[i - 1].afterDays} days after step ${i})`;
  }
  const last = steps[steps.length - 1].afterDays;
  if (stopAfterDays <= last) return `Stop after more than ${last} days, the last step`;
  return null;
}

/** The step a client is due by days since their last visit: the latest one they've reached, until the sequence stops. */
export function stepDue<T extends { afterDays: number }>(steps: readonly T[], sinceDays: number, stopAfterDays: number): T | null {
  if (sinceDays >= stopAfterDays) return null;
  let due: T | null = null;
  for (const s of [...steps].sort((a, b) => a.afterDays - b.afterDays)) if (sinceDays >= s.afterDays) due = s;
  return due;
}

/** "2 weeks", "6 weeks+" for the last step, which lasts until the sequence stops. */
export const stepLabel = (afterDays: number, last: boolean) => `${weeksOrDays(afterDays)}${last ? "+" : ""}`;

export const DEFAULT_LAPSED_STEPS: { afterDays: number; templates: Templates }[] = [
  {
    afterDays: 14,
    templates: tpl(
      `{shop}: Hi {first_name}, it's {barber}. It's been a couple of weeks. Want me to save you a spot this week? ${STOP_LINE}`,
      "Time for a fresh cut?",
      "Hi {first_name},\n\nIt's been a couple of weeks since your last cut. Whenever you're ready, I'd be glad to see you.\n\n{barber}, {shop}",
      "Time for a fresh cut?",
      "It's been a couple of weeks, {first_name}. {barber} has time for you.",
    ),
  },
  {
    afterDays: 21,
    templates: tpl(
      `{shop}: {first_name}, {barber} here. Ready for your next cut? Book with me: {book_link} ${STOP_LINE}`,
      "Book your next cut with {barber}",
      "Hi {first_name},\n\nReady for your next cut? Pick a time with me here: {book_link}\n\n{barber}, {shop}",
      "Ready for your next cut?",
      "Book with {barber} at {shop}.",
    ),
  },
  {
    afterDays: 28,
    templates: tpl(
      `{shop}: {first_name}, it's been a month! Here's {coupon_code} for your next cut with {barber}, good till {expiry}: {book_link} ${STOP_LINE}`,
      "A little something for your next cut",
      "Hi {first_name},\n\nIt's been a month. Use {coupon_code} on your next cut with me, good till {expiry}. Book here: {book_link}\n\n{barber}, {shop}",
      "A little something from {barber}",
      "Use {coupon_code} on your next cut, till {expiry}.",
    ),
  },
  {
    afterDays: 42,
    templates: tpl(
      `{shop}: {first_name}, we miss you! {barber} saved you a bigger deal: {coupon_code} till {expiry}. Book: {book_link} ${STOP_LINE}`,
      "We miss you, {first_name}",
      "Hi {first_name},\n\nWe haven't seen you in a while. Here's our best offer: {coupon_code}, good till {expiry}. Book with me: {book_link}\n\n{barber}, {shop}",
      "We miss you, {first_name}",
      "{barber} saved you a deal: {coupon_code}.",
    ),
  },
];

/** The lapsed report's buckets, by weeks since the last visit: [from, to) with null for no end. */
export const LAPSED_BUCKETS: { label: string; from: number; to: number | null }[] = [
  { label: "2–3 wks", from: 14, to: 21 },
  { label: "3–4 wks", from: 21, to: 28 },
  { label: "4–5 wks", from: 28, to: 35 },
  { label: "5–6 wks", from: 35, to: 42 },
  { label: "6–8 wks", from: 42, to: 56 },
  { label: "8–12 wks", from: 56, to: 84 },
  { label: "12+ wks", from: 84, to: null },
];
/** Past this a client counts as gone, not lapsed. */
export const LAPSED_MAX_DAYS = 365;
export const bucketOf = (sinceDays: number): number => LAPSED_BUCKETS.findIndex((b) => sinceDays >= b.from && (b.to === null || sinceDays < b.to));
