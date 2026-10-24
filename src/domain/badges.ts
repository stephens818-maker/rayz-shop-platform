/**
 * Client retention badges, kept pure: the catalog (label, icon, colour, what each gives away), the
 * brand's settings (which are on, the thresholds, which roles see which), the rules that turn a
 * client's facts into badges, and how a cached badge shows to one person. The server
 * (src/server/badges.ts) gathers the facts, caches each client's badges in client_badges nightly
 * and after checkout, and reads them back for every screen.
 */
import { z } from "zod";
import { formatCents } from "@/lib/money";
import { diffDays, formatDate, type LocalDate } from "@/lib/time";
import { upcomingBirthdayKeys } from "./client-filters";
import type { FieldKey, Level } from "./client-privacy";
import { SegmentSchema, segmentProblem, type Segment } from "./marketing";
import { isBrandLevelRole } from "./permissions";
import { CADENCE_GAPS, cadenceFromDays, cadenceLabel, median } from "./visit-cadence";

// ───────────────────────────── Catalog ─────────────────────────────

export const BADGE_TONES = ["gray", "green", "blue", "amber", "red", "violet"] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];
export const BADGE_TONE_LABEL: Record<BadgeTone, string> = { gray: "Gray", green: "Green", blue: "Blue", amber: "Amber", red: "Red", violet: "Violet" };

export const BADGE_ICONS = [
  "check",
  "clock",
  "alert",
  "hourglass",
  "trend_down",
  "sparkle",
  "repeat",
  "return",
  "crown",
  "heart",
  "gift",
  "card",
  "ticket",
  "cake",
  "calendar",
  "calendar_x",
  "user_check",
  "switch",
  "phone",
  "user_x",
  "thumbs_down",
  "star",
  "bag",
  "info",
  "bell_off",
  "users",
  "tag",
] as const;
export type BadgeIcon = (typeof BADGE_ICONS)[number];

export const BADGE_GROUPS = ["timing", "new", "value", "celebrations", "booking", "barber", "feedback", "profile", "custom"] as const;
export type BadgeGroup = (typeof BADGE_GROUPS)[number];
export const BADGE_GROUP_LABEL: Record<BadgeGroup, string> = {
  timing: "Visit timing",
  new: "New and returning",
  value: "Value",
  celebrations: "Celebrations",
  booking: "Booking behavior",
  barber: "Barber change",
  feedback: "Feedback and products",
  profile: "Profile and marketing",
  custom: "Custom",
};

interface BadgeDef {
  key: string;
  group: BadgeGroup;
  label: string;
  icon: BadgeIcon;
  tone: BadgeTone;
  /** What it means, on the settings page. */
  hint: string;
  /** Client details the badge gives away: it shows only to people who see at least this much of each. */
  reads?: readonly (readonly [FieldKey, Level])[];
  /** Spend or gift card money: only for people with every client, like the spend filters. */
  money?: boolean;
  /** Starts on only for brand-level roles; the brand decides who else sees it. */
  sensitive?: boolean;
  /** Something to act on in the chair today: highlighted on Today. */
  action?: boolean;
  /** The Morning Dashboard's line for today's booked clients. */
  today?: (n: number) => string;
}

const clients = (n: number, before: string, after = "") => `${n} ${before}${before ? " " : ""}client${n === 1 ? "" : "s"}${after ? ` ${after}` : ""}`;

export const BADGES = [
  { key: "on_track", group: "timing", label: "On track", icon: "check", tone: "green", hint: "Booked, or not yet due against their usual time between visits." },
  { key: "due", group: "timing", label: "Due", icon: "clock", tone: "amber", hint: "Within a few days of their usual time between visits, with nothing booked." },
  { key: "overdue", group: "timing", label: "Overdue", icon: "alert", tone: "red", hint: "Past their usual time between visits by a week or more, with nothing booked." },
  { key: "lapsed", group: "timing", label: "Lapsed", icon: "hourglass", tone: "gray", hint: "No visit in more than the lapsed weeks below, and nothing booked." },
  {
    key: "at_risk",
    group: "timing",
    label: "At risk",
    icon: "trend_down",
    tone: "red",
    hint: "Their last gap between visits stretched well past their norm.",
    action: true,
    today: (n) => clients(n, "at-risk"),
  },
  { key: "new_client", group: "new", label: "New client", icon: "sparkle", tone: "blue", hint: "No visits yet, or their first visit is today.", today: (n) => clients(n, "new") },
  {
    key: "second_visit",
    group: "new",
    label: "2nd visit",
    icon: "repeat",
    tone: "violet",
    hint: "One visit so far: the next one is when a new client becomes a regular.",
    action: true,
    today: (n) => `${clients(n, "")} on their 2nd visit`,
  },
  { key: "win_back", group: "new", label: "Win-back", icon: "return", tone: "green", hint: "Back, or booked again, after lapsing.", today: (n) => `${clients(n, "")} coming back after a lapse` },
  { key: "vip", group: "value", label: "VIP", icon: "crown", tone: "violet", hint: "Top spenders over the last 12 months.", money: true, sensitive: true, today: (n) => clients(n, "VIP") },
  { key: "loyal", group: "value", label: "Loyal regular", icon: "heart", tone: "green", hint: "At least the number of visits below." },
  { key: "reward", group: "value", label: "Reward ready", icon: "gift", tone: "violet", hint: "A loyalty reward is waiting to be used.", action: true, today: (n) => `${clients(n, "")} with a reward to use` },
  { key: "gift_card", group: "value", label: "Gift card", icon: "card", tone: "blue", hint: "Money left on a gift card.", money: true },
  { key: "coupon", group: "value", label: "Coupon", icon: "ticket", tone: "blue", hint: "An unused coupon code sent to them." },
  {
    key: "birthday_week",
    group: "celebrations",
    label: "Birthday this week",
    icon: "cake",
    tone: "violet",
    hint: "Birthday in the next 7 days. Needs the whole birthday.",
    reads: [["birthday", "full"]],
    action: true,
    today: (n) => `${clients(n, "")} with a birthday this week`,
  },
  {
    key: "birthday_month",
    group: "celebrations",
    label: "Birthday this month",
    icon: "cake",
    tone: "violet",
    hint: "Birthday this calendar month. Shows to people who see the birthday's month.",
    reads: [["birthday", "masked"]],
    action: true,
  },
  { key: "anniversary", group: "celebrations", label: "Anniversary", icon: "calendar", tone: "violet", hint: "A year (or more) since their first visit, this week." },
  {
    key: "no_show_risk",
    group: "booking",
    label: "No-show risk",
    icon: "calendar_x",
    tone: "red",
    hint: "No-shows in the last 12 months: the number below, or a third of their appointments.",
    today: (n) => `${clients(n, "")} with a no-show history`,
  },
  { key: "late_cancels", group: "booking", label: "Late cancels", icon: "calendar_x", tone: "amber", hint: "Cancelled within the hours below of the appointment, in the last 12 months." },
  {
    key: "always_with",
    group: "booking",
    label: "Always books with",
    icon: "user_check",
    tone: "blue",
    hint: "Most of their last 10 visits with one barber. Names the barber for people who see preferred barbers in full.",
    reads: [["preferred_barber", "masked"]],
  },
  { key: "switched_barber", group: "booking", label: "Switched barbers", icon: "switch", tone: "amber", hint: "Moved to a new barber recently after being a regular with another.", reads: [["preferred_barber", "masked"]] },
  { key: "online_booker", group: "booking", label: "Books online", icon: "phone", tone: "blue", hint: "Most of their bookings in the last 12 months made online or in the app." },
  {
    key: "barber_left",
    group: "barber",
    label: "Barber left",
    icon: "user_x",
    tone: "red",
    hint: "Their barber is no longer active, so they need a new one.",
    reads: [["preferred_barber", "masked"]],
    today: (n) => `${clients(n, "")} whose barber left`,
  },
  { key: "low_rating", group: "feedback", label: "Low rating", icon: "thumbs_down", tone: "red", hint: "Staff rate them below the stars below on average.", reads: [["ratings", "masked"]] },
  { key: "review_clicked", group: "feedback", label: "Review clicked", icon: "star", tone: "green", hint: "Opened the location's Google review link." },
  { key: "product_buyer", group: "feedback", label: "Product buyer", icon: "bag", tone: "green", hint: "Bought products in the last 12 months: suggest what goes with them." },
  { key: "no_product", group: "feedback", label: "Never bought product", icon: "bag", tone: "gray", hint: "Two or more visits and no product yet." },
  {
    key: "missing_info",
    group: "profile",
    label: "Missing info",
    icon: "info",
    tone: "amber",
    hint: "No phone, no email, or no agreement to appointment messages. Only for people who see phone and email at least masked.",
    reads: [
      ["phone", "masked"],
      ["email", "masked"],
    ],
  },
  { key: "opted_out", group: "profile", label: "Opted out", icon: "bell_off", tone: "gray", hint: "Unsubscribed from marketing texts, emails or app notifications." },
  { key: "referral_source", group: "profile", label: "Referral source", icon: "users", tone: "gray", hint: "How they found us, or referred by another client." },
  { key: "referrer", group: "profile", label: "Referrer", icon: "users", tone: "green", hint: "Referred other clients." },
] as const satisfies readonly BadgeDef[];

export type BadgeKey = (typeof BADGES)[number]["key"];
export const BADGE_KEYS = BADGES.map((b) => b.key) as BadgeKey[];
const DEFS = new Map<string, BadgeDef>(BADGES.map((b) => [b.key, b]));
export const badgeDef = (key: string): BadgeDef | undefined => DEFS.get(key);
export const isBadgeKey = (k: string): k is BadgeKey => DEFS.has(k);
export const CUSTOM_PREFIX = "custom:";
export const customKey = (id: string) => `${CUSTOM_PREFIX}${id}`;
/** Badges a barber can act on in the chair. */
export const ACTION_BADGES = BADGES.filter((b) => "action" in b && b.action).map((b) => b.key) as BadgeKey[];
/** What the Morning Dashboard counts among today's booked clients, in this order. */
export const MORNING_BADGES: BadgeKey[] = ["at_risk", "second_visit", "new_client", "win_back", "birthday_week", "reward", "no_show_risk", "barber_left", "vip"];

/** "3 at-risk clients". */
export function todayLine(key: string, n: number): string {
  const d = DEFS.get(key);
  return d?.today ? d.today(n) : clients(n, "", `marked ${d?.label ?? key}`);
}

// ───────────────────────────── Settings ─────────────────────────────

/** Clients with no visits who joined this recently are new. */
export const NEW_CLIENT_DAYS = 90;

export const BadgeThresholdsSchema = z.object({
  lapsedWeeks: z.number().int().min(4, "Lapsed starts at 4 weeks or more").max(104, "Lapsed starts by 104 weeks").default(16),
  /** The last gap as a percent of their usual one. */
  atRiskPct: z.number().int().min(110, "At risk needs a gap at least 110% of their usual").max(400, "At risk up to 400%").default(150),
  vipTopPct: z.number().int().min(1, "VIP is at least the top 1%").max(50, "VIP is at most the top 50%").default(10),
  loyalVisits: z.number().int().min(3, "Loyal needs at least 3 visits").max(500, "Loyal up to 500 visits").default(10),
  noShows: z.number().int().min(1, "At least 1 no-show").max(20, "Up to 20 no-shows").default(2),
  lateCancels: z.number().int().min(1, "At least 1 late cancel").max(20, "Up to 20 late cancels").default(2),
  lateCancelHours: z.number().int().min(1, "Late means at least 1 hour ahead").max(72, "Late means up to 72 hours ahead").default(24),
  alwaysWithPct: z.number().int().min(50, "Always with is at least 50%").max(100, "Always with is at most 100%").default(80),
  onlinePct: z.number().int().min(50, "Books online is at least 50%").max(100, "Books online is at most 100%").default(75),
  switchedDays: z.number().int().min(14, "Switched within at least 14 days").max(365, "Switched within up to 365 days").default(90),
  winBackDays: z.number().int().min(7, "Win-back lasts at least 7 days").max(180, "Win-back lasts up to 180 days").default(60),
  lowRatingBelow: z.number().min(1.5, "Low rating is below at least 1.5 stars").max(5, "Low rating is below at most 5 stars").default(3),
});
export type BadgeThresholds = z.output<typeof BadgeThresholdsSchema>;
export const DEFAULT_THRESHOLDS: BadgeThresholds = BadgeThresholdsSchema.parse({});

export const THRESHOLD_LABEL: Record<keyof BadgeThresholds, { label: string; unit: string; badge: BadgeKey }> = {
  lapsedWeeks: { label: "Lapsed after", unit: "weeks without a visit", badge: "lapsed" },
  atRiskPct: { label: "At risk when the last gap is", unit: "% of their usual", badge: "at_risk" },
  vipTopPct: { label: "VIP: the top", unit: "% of spenders, last 12 months", badge: "vip" },
  loyalVisits: { label: "Loyal regular from", unit: "visits", badge: "loyal" },
  noShows: { label: "No-show risk from", unit: "no-shows in 12 months", badge: "no_show_risk" },
  lateCancels: { label: "Late cancels from", unit: "late cancellations in 12 months", badge: "late_cancels" },
  lateCancelHours: { label: "A late cancel is within", unit: "hours of the appointment", badge: "late_cancels" },
  alwaysWithPct: { label: "Always books with: at least", unit: "% of the last 10 visits", badge: "always_with" },
  onlinePct: { label: "Books online: at least", unit: "% of bookings, last 12 months", badge: "online_booker" },
  switchedDays: { label: "Switched barbers within", unit: "days", badge: "switched_barber" },
  winBackDays: { label: "Win-back shows for", unit: "days after they're back", badge: "win_back" },
  lowRatingBelow: { label: "Low rating below", unit: "stars", badge: "low_rating" },
};

export const BadgeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Built-in badges the brand turned off. */
  off: z.array(z.string().refine(isBadgeKey, "Unknown badge")).max(100).default([]),
  /** Badge key to role id to shown or not. Missing: shown, except sensitive badges, which start shown to brand-level roles only. */
  roles: z.record(z.string(), z.record(z.string(), z.boolean())).default({}),
  thresholds: BadgeThresholdsSchema.default(DEFAULT_THRESHOLDS),
});
export type BadgeSettings = z.output<typeof BadgeSettingsSchema>;
export const DEFAULT_BADGE_SETTINGS: BadgeSettings = BadgeSettingsSchema.parse({});

/** Stored settings with missing or broken keys at their defaults; one bad threshold doesn't lose the rest. */
export function badgeSettings(raw: unknown): BadgeSettings {
  const r = BadgeSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: BadgeSettings = { ...DEFAULT_BADGE_SETTINGS, thresholds: { ...DEFAULT_THRESHOLDS } };
  for (const k of ["enabled", "off", "roles"] as const) {
    const v = BadgeSettingsSchema.shape[k].safeParse(o[k]);
    if (v.success) (out as Record<string, unknown>)[k] = v.data;
  }
  const t = o.thresholds && typeof o.thresholds === "object" ? (o.thresholds as Record<string, unknown>) : {};
  for (const k of Object.keys(BadgeThresholdsSchema.shape) as (keyof BadgeThresholds)[]) {
    const v = BadgeThresholdsSchema.shape[k].safeParse(t[k]);
    if (v.success) out.thresholds[k] = v.data;
  }
  return out;
}

// ───────────────────────────── Custom badges ─────────────────────────────

export const CustomBadgeSchema = z.object({
  id: z.uuid().nullable().default(null),
  label: z.string().trim().min(1, "Name the badge").max(24, "Keep the badge name to 24 characters"),
  tooltip: z.string().trim().max(200, "Keep the explanation to 200 characters").default(""),
  icon: z.enum(BADGE_ICONS).default("tag"),
  tone: z.enum(BADGE_TONES).default("blue"),
  filter: SegmentSchema,
  active: z.boolean().default(true),
});
export type CustomBadgeInput = z.input<typeof CustomBadgeSchema>;

export interface CustomBadge {
  id: string;
  label: string;
  tooltip: string;
  icon: BadgeIcon;
  tone: BadgeTone;
  filter: Segment;
  active: boolean;
}

/** Why a custom badge's filter won't do: it must filter something, and not on badges (they're computed together). */
export function customBadgeProblem(filter: Segment): string | null {
  if (filter.badges.length) return "A custom badge can't be built from other badges";
  const { shopIds: _s, channel: _c, barberMatch: _b, ...rest } = filter;
  const empty = SegmentSchema.parse({});
  if (Object.entries(rest).every(([k, v]) => JSON.stringify(v) === JSON.stringify((empty as Record<string, unknown>)[k]))) return "Pick at least one filter for the badge";
  return null;
}

// ───────────────────────────── Who sees which ─────────────────────────────

export interface BadgeRole {
  id: string;
  key: string | null;
  brandLevel?: boolean | null;
}

export interface BadgeViewer {
  isOwner: boolean;
  /** The roles they're working under right now; a badge shows only if every one of them allows it. */
  roles: readonly BadgeRole[];
  /** Every client's money (clients.view_all): spend and gift card badges. */
  money: boolean;
  level: (f: FieldKey) => Level;
}

const RANK: Record<Level, number> = { hidden: 0, masked: 1, full: 2 };

/** Whether this role sees the badge, before what the person may see of client details. */
export function roleSeesBadge(s: BadgeSettings, key: string, role: BadgeRole): boolean {
  const set = s.roles[key]?.[role.id];
  if (set !== undefined) return set;
  const sensitive = !!(DEFS.get(key) as { sensitive?: boolean } | undefined)?.sensitive;
  return !sensitive || isBrandLevelRole({ key: role.key, brandLevel: !!role.brandLevel });
}

/**
 * The badges this person may see: on for the brand, on for every role they're working under,
 * nothing that would give away a client detail hidden from them (a birthday's day, a barber, a
 * rating, whether there's a phone or email on file), and no money without every client. A custom
 * badge shows only to people who could run its filter themselves.
 */
export function visibleBadges(s: BadgeSettings, custom: readonly CustomBadge[], v: BadgeViewer): string[] {
  if (!s.enabled) return [];
  const rolesAllow = (key: string) => v.isOwner || v.roles.every((r) => roleSeesBadge(s, key, r));
  const out: string[] = [];
  for (const b of BADGES as readonly BadgeDef[]) {
    if ((s.off as string[]).includes(b.key) || !rolesAllow(b.key)) continue;
    if (b.money && !v.money) continue;
    if (b.reads?.some(([f, want]) => RANK[v.level(f)] < RANK[want])) continue;
    out.push(b.key);
  }
  const sees = {
    birthday: v.level("birthday") !== "hidden",
    ratings: v.level("ratings") !== "hidden",
    preferredBarber: v.level("preferred_barber") !== "hidden",
    level: v.level,
    money: v.money,
  };
  for (const c of custom) if (c.active && rolesAllow(customKey(c.id)) && !segmentProblem(c.filter, sees)) out.push(customKey(c.id));
  return out;
}

// ───────────────────────────── The rules ─────────────────────────────

export interface BadgeFacts {
  /** Completed visits, oldest first, one per local day (that day's barber). */
  visits: { day: LocalDate; staffId: string }[];
  /** The next booked appointment's day. */
  nextBooked: LocalDate | null;
  /** The last 12 months: appointments that started, no-shows, late cancels, and bookings (not imports) and how many were made online or in the app. */
  year: { appointments: number; noShows: number; lateCancels: number; bookings: number; online: number };
  createdOn: LocalDate;
  /** "MM-DD", or null. */
  birthday: string | null;
  preferredStaffId: string | null;
  barbers: Record<string, { name: string; active: boolean }>;
  /** Net spend over the last 12 months, less refunds. */
  spendCents: number;
  products: { year: number; ever: number };
  rewardCents: number;
  giftCardCents: number;
  coupons: number;
  rating: { avg: number; count: number } | null;
  reviewClicks: number;
  hasPhone: boolean;
  hasEmail: boolean;
  /** Agreed to appointment texts or emails. */
  optedIn: boolean;
  optedOut: string[];
  source: string | null;
  referredBy: boolean;
  referrals: number;
}

export interface DeriveContext {
  today: LocalDate;
  t: BadgeThresholds;
  /** The least a VIP spent in the last 12 months; null when nobody spent anything. */
  vipCutoffCents: number | null;
}

/** A badge as cached: its key and the facts its explanation needs. */
export interface StoredBadge {
  k: string;
  d?: Record<string, string | number>;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function tally(ids: readonly string[]): [string | null, number] {
  const n = new Map<string, number>();
  for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
  let best: [string | null, number] = [null, 0];
  for (const [id, c] of n) if (c > best[1]) best = [id, c];
  return best;
}

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** A whole number of years since the first visit falling a week either side of today. */
export function anniversaryNear(first: LocalDate, today: LocalDate): { years: number; on: LocalDate } | null {
  const y0 = Number(first.slice(0, 4));
  const ty = Number(today.slice(0, 4));
  for (const y of [ty - 1, ty, ty + 1]) {
    const md = first.slice(5) === "02-29" && !leap(y) ? "02-28" : first.slice(5);
    const on = `${y}-${md}`;
    const off = diffDays(on, today);
    if (y - y0 >= 1 && off >= -7 && off <= 6) return { years: y - y0, on };
  }
  return null;
}

/** Every built-in badge the facts earn. Which of them anyone sees is visibleBadges' call. */
export function deriveBadges(f: BadgeFacts, c: DeriveContext): StoredBadge[] {
  const { today, t } = c;
  const out: StoredBadge[] = [];
  const add = (k: BadgeKey, d: Record<string, string | number> = {}) => out.push(Object.keys(d).length ? { k, d } : { k });
  const days = [...new Set(f.visits.map((v) => v.day))].sort();
  const n = days.length;
  const last = days.at(-1) ?? null;
  const since = last ? diffDays(today, last) : null;
  const booked = f.nextBooked !== null;
  const next: Record<string, string> = f.nextBooked ? { next: f.nextBooked } : {};
  const away = since !== null && since > t.lapsedWeeks * 7;
  const gaps = days.slice(1).map((d, i) => diffDays(d, days[i]));
  const lastGap = gaps.at(-1) ?? null;
  const cad = cadenceFromDays(days, today, booked);
  const name = (id: string) => f.barbers[id]?.name ?? "a former barber";

  if (away && !booked) add("lapsed", { since: since!, last: last!, w: t.lapsedWeeks });
  else if (cad.status && !away) add(cad.status, { every: round1(cad.cadenceDays!), since: since!, ...(cad.nextExpected ? { due: cad.nextExpected } : {}), ...next });
  if (!away && gaps.length >= 3) {
    const recent = gaps.slice(-CADENCE_GAPS);
    const norm = median(recent.slice(0, -1));
    if (norm && lastGap! >= (norm * t.atRiskPct) / 100 && lastGap! - norm >= 7) add("at_risk", { gap: lastGap!, every: round1(norm) });
  }

  if (n === 0) {
    if (booked || diffDays(today, f.createdOn) <= NEW_CLIENT_DAYS) add("new_client", next);
  } else if (n === 1 && last === today) add("new_client", { first: today });
  else if (n === 1 && !away) add("second_visit", { first: last!, ...next });
  if (n > 0 && booked && away) add("win_back", { away: since!, last: last!, ...next });
  else if (lastGap !== null && lastGap > t.lapsedWeeks * 7 && since! <= t.winBackDays) add("win_back", { away: lastGap, back: last! });

  if (c.vipCutoffCents !== null && f.spendCents > 0 && f.spendCents >= c.vipCutoffCents) add("vip", { pct: t.vipTopPct, cents: f.spendCents });
  if (n >= t.loyalVisits) add("loyal", { visits: n });
  if (f.rewardCents > 0) add("reward", { cents: f.rewardCents });
  if (f.giftCardCents > 0) add("gift_card", { cents: f.giftCardCents });
  if (f.coupons > 0) add("coupon", { n: f.coupons });

  if (f.birthday) {
    if (upcomingBirthdayKeys(today, 6).includes(f.birthday)) add("birthday_week", { on: f.birthday });
    if (f.birthday.slice(0, 2) === today.slice(5, 7)) add("birthday_month", { on: f.birthday });
  }
  const anniversary = days[0] ? anniversaryNear(days[0], today) : null;
  if (anniversary) add("anniversary", anniversary);

  const y = f.year;
  if (y.noShows >= t.noShows || (y.noShows >= 1 && y.appointments > 0 && y.noShows / y.appointments >= 0.34)) add("no_show_risk", { n: y.noShows });
  if (y.lateCancels >= t.lateCancels) add("late_cancels", { n: y.lateCancels, h: t.lateCancelHours });
  const recent = f.visits.slice(-10);
  const [top, topN] = tally(recent.map((v) => v.staffId));
  if (top && recent.length >= 4 && topN / recent.length >= t.alwaysWithPct / 100 && f.barbers[top]?.active) add("always_with", { staff: name(top), n: topN, of: recent.length });
  if (f.visits.length >= 3) {
    const cur = f.visits.at(-1)!.staffId;
    let k = f.visits.length - 1;
    while (k > 0 && f.visits[k - 1].staffId === cur) k--;
    if (k > 0) {
      const prev = f.visits[k - 1].staffId;
      const regular = f.visits.slice(Math.max(0, k - 10), k).filter((v) => v.staffId === prev).length >= 2;
      if (regular && diffDays(today, f.visits[k].day) <= t.switchedDays) add("switched_barber", { from: name(prev), to: name(cur), on: f.visits[k].day });
    }
  }
  if (y.bookings >= 3 && y.online / y.bookings >= t.onlinePct / 100) add("online_booker", { pct: Math.round((y.online / y.bookings) * 100) });

  const primary = f.preferredStaffId ?? top;
  if (primary && f.barbers[primary] && !f.barbers[primary].active) add("barber_left", { staff: name(primary) });

  if (f.rating && f.rating.count > 0 && f.rating.avg < t.lowRatingBelow) add("low_rating", { avg: round1(f.rating.avg), n: f.rating.count });
  if (f.reviewClicks > 0) add("review_clicked", { n: f.reviewClicks });
  if (f.products.year > 0) add("product_buyer", { n: f.products.year });
  else if (f.products.ever === 0 && n >= 2) add("no_product", { visits: n });

  const miss = [!f.hasPhone && "phone", !f.hasEmail && "email", !f.optedIn && "opt_in"].filter((x): x is string => !!x);
  if (miss.length) add("missing_info", { miss: miss.join(",") });
  if (f.optedOut.length) add("opted_out", { ch: [...new Set(f.optedOut)].sort().join(",") });
  const source = f.source?.trim() && !/squire/i.test(f.source) ? f.source.trim().slice(0, 40) : null;
  if (source) add("referral_source", { src: source });
  else if (f.referredBy) add("referral_source", { by: 1 });
  if (f.referrals > 0) add("referrer", { n: f.referrals });
  return out;
}

// ───────────────────────────── Showing them ─────────────────────────────

export interface ShownBadge {
  key: string;
  label: string;
  icon: BadgeIcon;
  tone: BadgeTone;
  /** Why the client has it: the tooltip. */
  tip: string;
  action: boolean;
}

export interface BadgeView {
  /** visibleBadges for the person. */
  keys: ReadonlySet<string>;
  level: (f: FieldKey) => Level;
  custom: ReadonlyMap<string, Pick<CustomBadge, "label" | "tooltip" | "icon" | "tone">>;
}

const day = (d: string | number | undefined) => (d ? formatDate(String(d), "MMM d") : "");
const span = (days: number) => (days < 14 ? `${Math.round(days)} days` : `${Math.round((days / 7) * 2) / 2} weeks`);
const ago = (n: number) => (n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`);
const every = (d: number) => cadenceLabel(d).replace(/^Every/, "every");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthDay = (md: string, fmt: string) => formatDate(`2000-${md}`, fmt);
const CHANNEL_WORD: Record<string, string> = { sms: "texts", email: "emails", push: "app notifications" };
const MISSING_WORD: Record<string, string> = { phone: "phone number", email: "email", opt_in: "agreement to appointment texts or emails" };
const words = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function describe(key: BadgeKey, d: Record<string, string | number>, level: (f: FieldKey) => Level): { label?: string; tip: string } {
  const num = (k: string) => Number(d[k] ?? 0);
  const barberShown = level("preferred_barber") === "full";
  switch (key) {
    case "on_track":
      return { tip: `Usually ${every(num("every"))}; last in ${ago(num("since"))}.${d.next ? ` Next visit booked for ${day(d.next)}.` : d.due ? ` Next expected around ${day(d.due)}.` : ""}` };
    case "due":
      return { tip: `Due around ${day(d.due)}: usually ${every(num("every"))}, last in ${ago(num("since"))}, nothing booked yet.` };
    case "overdue":
      return { tip: `Expected around ${day(d.due)}: usually ${every(num("every"))}, last in ${ago(num("since"))}, nothing booked.` };
    case "lapsed":
      return { tip: `No visit in ${span(num("since"))} (last in ${day(d.last)}) and nothing booked: past the ${num("w")}-week lapsed mark.` };
    case "at_risk":
      return { tip: `Visits are stretching: their last gap was ${span(num("gap"))} against their usual ${span(num("every"))}.` };
    case "new_client":
      return { tip: d.first ? "First visit today." : d.next ? `No visits yet. First visit booked for ${day(d.next)}.` : "New on file, with no visits yet." };
    case "second_visit":
      return {
        tip: d.next
          ? `One visit so far (${day(d.first)}); the 2nd is booked for ${day(d.next)}. The 2nd visit is when a new client becomes a regular.`
          : `One visit so far (${day(d.first)}). The 2nd visit is when a new client becomes a regular: get them rebooked.`,
      };
    case "win_back":
      return { tip: d.next ? `Booked for ${day(d.next)} after ${span(num("away"))} away (last in ${day(d.last)}).` : `Came back on ${day(d.back)} after ${span(num("away"))} away.` };
    case "vip":
      return { tip: `Top ${num("pct")}% of spenders over the last 12 months (${formatCents(num("cents"))}).` };
    case "loyal":
      return { tip: `${plural(num("visits"), "visit")}.` };
    case "reward":
      return { tip: `${formatCents(num("cents"))} loyalty reward ready to use.` };
    case "gift_card":
      return { label: `Gift card ${formatCents(num("cents"))}`, tip: `${formatCents(num("cents"))} left on their gift cards.` };
    case "coupon":
      return { tip: `${plural(num("n"), "unused coupon")} waiting.` };
    case "birthday_week":
      return { tip: `Birthday ${monthDay(String(d.on), "MMMM d")}.` };
    case "birthday_month":
      return { tip: level("birthday") === "full" ? `Birthday ${monthDay(String(d.on), "MMMM d")}.` : `Birthday in ${monthDay(String(d.on), "MMMM")}.` };
    case "anniversary":
      return { tip: `${plural(num("years"), "year")} as a client on ${day(d.on)}.` };
    case "no_show_risk":
      return { tip: `${plural(num("n"), "no-show")} in the last 12 months.` };
    case "late_cancels":
      return { tip: `${plural(num("n"), "cancellation")} within ${num("h")} hours of the appointment in the last 12 months.` };
    case "always_with":
      return barberShown
        ? { label: `Always with ${d.staff}`, tip: `${num("n")} of their last ${num("of")} visits with ${d.staff}.` }
        : { label: "Same barber", tip: `${num("n")} of their last ${num("of")} visits with the same barber.` };
    case "switched_barber":
      return { tip: barberShown ? `Moved from ${d.from} to ${d.to} on ${day(d.on)}.` : `Moved to a new barber on ${day(d.on)}.` };
    case "online_booker":
      return { tip: `${num("pct")}% of their bookings in the last 12 months were made online or in the app.` };
    case "barber_left":
      return { tip: barberShown ? `${d.staff} is no longer active: give them a new barber.` : "Their barber is no longer active: give them a new barber." };
    case "low_rating":
      return { tip: `Staff rate them ${num("avg")}★ on average (${plural(num("n"), "rating")}).` };
    case "review_clicked":
      return { tip: `Opened the Google review link ${num("n") === 1 ? "once" : `${num("n")} times`}.` };
    case "product_buyer":
      return { tip: `Bought ${plural(num("n"), "product")} in the last 12 months: suggest what goes with them.` };
    case "no_product":
      return { tip: `${plural(num("visits"), "visit")} and no product yet.` };
    case "missing_info":
      return { tip: `Missing ${words(String(d.miss ?? "").split(",").filter(Boolean).map((m) => MISSING_WORD[m] ?? m))}.` };
    case "opted_out":
      return { tip: `Unsubscribed from marketing ${words(String(d.ch ?? "").split(",").filter(Boolean).map((c) => CHANNEL_WORD[c] ?? c))}.` };
    case "referral_source":
      return d.src ? { label: `Via ${String(d.src).slice(0, 20)}`, tip: `How they found us: ${d.src}.` } : { label: "Referred", tip: "Referred by another client." };
    case "referrer":
      return { tip: `Referred ${plural(num("n"), "client")}.` };
  }
}

const ORDER = new Map<string, number>(BADGES.map((b, i) => [b.key, i]));

/** The cached badges as this person may see them, in catalog order, custom ones last. */
export function showBadges(stored: readonly StoredBadge[], v: BadgeView): ShownBadge[] {
  const out: ShownBadge[] = [];
  const has = new Set(stored.map((s) => s.k));
  for (const s of stored) {
    if (!v.keys.has(s.k)) continue;
    if (s.k === "birthday_month" && has.has("birthday_week") && v.keys.has("birthday_week")) continue;
    if (s.k.startsWith(CUSTOM_PREFIX)) {
      const c = v.custom.get(s.k.slice(CUSTOM_PREFIX.length));
      if (c) out.push({ key: s.k, label: c.label, icon: c.icon, tone: c.tone, tip: c.tooltip || c.label, action: false });
      continue;
    }
    const def = DEFS.get(s.k);
    if (!def) continue;
    const t = describe(s.k as BadgeKey, s.d ?? {}, v.level);
    out.push({ key: s.k, label: t.label ?? def.label, icon: def.icon, tone: def.tone, tip: t.tip, action: !!def.action });
  }
  return out.sort((a, b) => (ORDER.get(a.key) ?? 999) - (ORDER.get(b.key) ?? 999));
}

/** A badge's name for filters and reports. */
export function badgeLabel(key: string, custom: ReadonlyMap<string, { label: string }>): string {
  if (key.startsWith(CUSTOM_PREFIX)) return custom.get(key.slice(CUSTOM_PREFIX.length))?.label ?? "Removed badge";
  return DEFS.get(key)?.label ?? key;
}

/** The badges as filter choices for this person, in catalog order. */
export function badgeOptions(keys: readonly string[], custom: ReadonlyMap<string, { label: string }>): { id: string; name: string }[] {
  return [...keys].sort((a, b) => (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999)).map((k) => ({ id: k, name: badgeLabel(k, custom) }));
}

/** Badges to act on first, then the rest, each in catalog order: for tight spaces like a calendar block. */
export const actionFirst = (b: readonly ShownBadge[]): ShownBadge[] => [...b].sort((x, y) => Number(y.action) - Number(x.action));
