/**
 * "We have openings", kept pure: a location tells one barber's regulars and recent clients who
 * agreed to marketing that the barber has open times on a day or two, first come, first served.
 * The brand's rules (how often a client may get one, each location's send limits, whether the
 * brand approves first, the wording), the days it can cover and the {day} merge field. The server
 * in src/server/marketing/openings.ts gathers the facts and these decide.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import { STOP_LINE, type Templates, templatesProblem } from "./marketing";

export const OPENINGS_FIELDS = { day: "The days with openings: today, tomorrow, today and tomorrow, or on Thu, Oct 29" } as const;
export const OPENINGS_CHANNELS = ["sms", "email"] as const;
export type OpeningsChannel = (typeof OPENINGS_CHANNELS)[number];

/** As far ahead as a location can announce openings, and how many days one blast covers. */
export const OPENINGS_DAYS_AHEAD = 6;
export const OPENINGS_MAX_DAYS = 3;
/** Barbers in one send; each is its own blast. */
export const OPENINGS_MAX_BARBERS = 12;

export const OPENINGS_TEMPLATES = {
  sms: `Hi {first_name}, {barber} at {shop} has openings {day}. First come, first served: {book_link} ${STOP_LINE}`,
  emailSubject: "{barber} has openings {day}",
  emailBody: "Hi {first_name},\n\n{barber} at {shop} has openings {day}. First come, first served: grab a time before they're gone.\n\n{book_link}",
};

export const OpeningsTemplatesSchema = z.object({
  sms: z.string().trim().min(1, "Write the text").max(480),
  emailSubject: z.string().trim().min(1, "Write the email subject").max(150),
  emailBody: z.string().trim().min(1, "Write the email").max(5000),
});
export type OpeningsTemplates = z.infer<typeof OpeningsTemplatesSchema>;

/** A location's own limits and approval rule; null follows the brand's. */
export const OpeningsShopRulesSchema = z.object({
  perDay: z.number().int().min(0).max(50).nullable().default(null),
  perWeek: z.number().int().min(0).max(200).nullable().default(null),
  approval: z.boolean().nullable().default(null),
});
export type OpeningsShopRules = z.infer<typeof OpeningsShopRulesSchema>;

export const OpeningsSettingsSchema = z.object({
  /** At most one openings message per client in this many days, from any location. */
  capDays: z.number().int().min(1).max(60).default(7),
  /** Openings blasts a location may send in its day and in the last 7 days; each barber is one. */
  perDay: z.number().int().min(0).max(50).default(3),
  perWeek: z.number().int().min(0).max(200).default(12),
  /** The brand approves each blast before it goes. */
  approval: z.boolean().default(false),
  /** Most clients one blast goes to: the ones longest since their last visit first. */
  maxRecipients: z.number().int().min(1).max(1000).default(150),
  /** A recent client: a completed visit with the barber at the location within this many days. Regulars are two or more in a year. */
  recentDays: z.number().int().min(14).max(365).default(60),
  templates: OpeningsTemplatesSchema.default(OPENINGS_TEMPLATES),
  /** Per location, by shop id. */
  shops: z.record(z.uuid(), OpeningsShopRulesSchema).default({}),
});
export type OpeningsSettings = z.infer<typeof OpeningsSettingsSchema>;
export const OPENINGS_DEFAULTS: OpeningsSettings = OpeningsSettingsSchema.parse({});

/** The brand's stored rules with defaults filled in; a bad value falls back on its own, not the whole set. */
export function openingsSettings(raw: unknown): OpeningsSettings {
  const r = OpeningsSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...OPENINGS_DEFAULTS };
  for (const [k, v] of Object.entries(OpeningsSettingsSchema.shape)) {
    const one = (v as z.ZodType).safeParse(o[k]);
    if (one.success) out[k] = one.data;
  }
  return out as OpeningsSettings;
}

export interface OpeningsRules {
  perDay: number;
  perWeek: number;
  approval: boolean;
}

export function rulesFor(s: OpeningsSettings, shopId: string): OpeningsRules {
  const own = s.shops[shopId];
  return { perDay: own?.perDay ?? s.perDay, perWeek: own?.perWeek ?? s.perWeek, approval: own?.approval ?? s.approval };
}

const blasts = (n: number) => `${n} openings blast${n === 1 ? "" : "s"}`;

/** Over the location's send limits with `adding` more blasts, given what it sent today and in the last 7 days. */
export function limitProblem(used: { today: number; week: number }, adding: number, r: Pick<OpeningsRules, "perDay" | "perWeek">): string | null {
  const day = Math.max(0, r.perDay - used.today);
  const week = Math.max(0, r.perWeek - used.week);
  if (adding > day)
    return day ? `This location can send ${blasts(day)} more today (each barber is one)` : `This location has sent its ${blasts(r.perDay)} for today. Try again tomorrow.`;
  if (adding > week)
    return week ? `This location can send ${blasts(week)} more this week (each barber is one)` : `This location has sent its ${blasts(r.perWeek)} for the last 7 days`;
  return null;
}

const shiftDay = (d: string, n: number) => DateTime.fromISO(d).plus({ days: n }).toISODate()!;

/** What's wrong with the days picked, or null. */
export function windowProblem(dates: readonly string[], today: string): string | null {
  if (!dates.length) return "Pick a day";
  if (new Set(dates).size !== dates.length) return "Pick each day once";
  if (dates.length > OPENINGS_MAX_DAYS) return `Pick up to ${OPENINGS_MAX_DAYS} days`;
  if (dates.some((d) => !DateTime.fromISO(d).isValid)) return "Pick a day";
  if (dates.some((d) => d < today)) return "That day has passed";
  if (dates.some((d) => d > shiftDay(today, OPENINGS_DAYS_AHEAD))) return `We have openings covers today and the next ${OPENINGS_DAYS_AHEAD} days`;
  return null;
}

/** The days a location can pick from: today and the next six. */
export const openingsDays = (today: string): string[] => Array.from({ length: OPENINGS_DAYS_AHEAD + 1 }, (_, i) => shiftDay(today, i));

/**
 * The {day} field, as of the day the message arrives: "today", "tomorrow", "today and tomorrow",
 * "on Thu, Oct 29", "tomorrow and Sat, Oct 31". Days before that are left out.
 */
export function dayLabel(dates: readonly string[], today: string): string {
  const days = [...new Set(dates)].filter((d) => d >= today).sort();
  const word = (d: string) => (d === today ? "today" : d === shiftDay(today, 1) ? "tomorrow" : DateTime.fromISO(d).toFormat("EEE, MMM d"));
  const words = days.map(word);
  if (!words.length) return "";
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return days[0] > shiftDay(today, 1) ? `on ${list}` : list;
}

/** What's wrong with the brand's openings wording, or null. Both channels must work: a location picks text, email or both. */
export function openingsTemplatesProblem(t: OpeningsTemplates): string | null {
  const full: Templates = { ...t, pushTitle: "", pushBody: "" };
  const p = templatesProblem(full, OPENINGS_CHANNELS, { hasCoupon: false, extraFields: Object.keys(OPENINGS_FIELDS) });
  if (p) return p;
  if (!t.sms.includes("{book_link}")) return "The text needs {book_link}: it's how clients see the open times";
  if (!t.emailBody.includes("{book_link}")) return "The email needs {book_link}: it's how clients see the open times";
  return null;
}

export const OPENINGS_STATUS_LABEL: Record<string, string> = {
  pending_approval: "Waiting for the brand",
  sending: "Sending",
  sent: "Sent",
  rejected: "Not approved",
  expired: "Expired: the times passed or filled first",
  cancelled: "Withdrawn",
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day");

/** What a location sends: barbers, days, an optional "last visit over N weeks" and the channels. */
export const OpeningsInputSchema = z.object({
  shopId: z.uuid(),
  staffIds: z.array(z.uuid()).min(1, "Pick a barber").max(OPENINGS_MAX_BARBERS),
  dates: z.array(isoDate).min(1, "Pick a day").max(OPENINGS_MAX_DAYS, `Pick up to ${OPENINGS_MAX_DAYS} days`),
  lastVisitOverWeeks: z.number().int().min(1).max(52).nullable().default(null),
  channels: z
    .array(z.enum(OPENINGS_CHANNELS))
    .min(1, "Pick text, email or both")
    .max(2)
    .refine((a) => new Set(a).size === a.length, "Each channel once"),
});
export type OpeningsInput = z.input<typeof OpeningsInputSchema>;

/** One blast's barber, days and filter, kept in marketing_campaigns.segment. */
export const OpeningsSegmentSchema = z.object({
  staffId: z.uuid(),
  dates: z.array(isoDate).min(1).max(OPENINGS_MAX_DAYS),
  lastVisitOverWeeks: z.number().int().min(1).max(52).nullable().default(null),
  /** The service the open times are for: the barber's most booked one. */
  serviceId: z.uuid(),
});
export type OpeningsSegment = z.infer<typeof OpeningsSegmentSchema>;
