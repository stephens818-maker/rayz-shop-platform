/**
 * Badges as the customer sees them, kept pure: which badges a customer may see (the brand's
 * customer-visible setting over the catalog's default; staff judgments never), their own wording,
 * the earned date, progress toward the next one ("2 more visits to Gold"), the line a "Badge news"
 * message carries when they earn or lose one, and the public API's shape.
 */
import { z } from "zod";
import { formatCents } from "@/lib/money";
import { formatDate, type LocalDate } from "@/lib/time";
import {
  BADGES,
  CUSTOM_PREFIX,
  badgeDef,
  customKey,
  type BadgeIcon,
  type BadgeKey,
  type BadgeProgressFacts,
  type BadgeSettings,
  type BadgeThresholds,
  type BadgeTone,
  type CustomBadge,
  type StoredBadge,
} from "./badges";
import type { Segment } from "./marketing";

/** The app and the web draw the same colours. */
export const TONE_HEX: Record<BadgeTone, string> = {
  gray: "#71717a",
  green: "#059669",
  blue: "#0284c7",
  amber: "#d97706",
  orange: "#ea580c",
  red: "#dc2626",
  violet: "#7c3aed",
};

// ───────────────────────────── Who sees which ─────────────────────────────

/** A custom badge built on staff ratings stays staff-only, like the ratings themselves. */
const readsRatings = (f: Pick<Segment, "minRating" | "maxRating">) => f.minRating != null || f.maxRating != null;

/** Whether the brand may show this badge to customers at all. */
export function customerMayShow(key: string, custom?: Pick<CustomBadge, "filter"> | null): boolean {
  if (key.startsWith(CUSTOM_PREFIX)) return !!custom && !readsRatings(custom.filter);
  const d = badgeDef(key) as { customer?: string } | undefined;
  return !!d && d.customer !== "never";
}

/** Whether customers see it, before whether the brand has badges on. */
export function customerSetting(s: BadgeSettings, key: string, custom?: Pick<CustomBadge, "filter"> | null): boolean {
  if (!customerMayShow(key, custom)) return false;
  const set = s.customer[key];
  if (set !== undefined) return set;
  return (badgeDef(key) as { customer?: string } | undefined)?.customer === "default";
}

/** The badges customers see: on for the brand, on for customers, never a staff judgment. */
export function customerBadgeKeys(s: BadgeSettings, custom: readonly CustomBadge[]): string[] {
  if (!s.enabled) return [];
  const out: string[] = [];
  for (const b of BADGES) if (!(s.off as string[]).includes(b.key) && customerSetting(s, b.key)) out.push(b.key);
  for (const c of custom) if (c.active && customerSetting(s, customKey(c.id), c)) out.push(customKey(c.id));
  return out;
}

// ───────────────────────────── Messages ─────────────────────────────

/** Badges that message customers when earned unless the brand says otherwise. None message when lost. */
export const NOTIFY_DEFAULT: ReadonlySet<string> = new Set(["gold", "silver", "bronze", "miss_you", "streak", "referral_champion"]);
export type BadgeChange = "earned" | "lost";
/** We miss you clears when they book: a message then would only be noise. */
const NO_LOST_MESSAGE: ReadonlySet<string> = new Set(["miss_you", "birthday_week", "birthday_month", "anniversary"]);

export function canNotify(key: string, change: BadgeChange): boolean {
  return change === "earned" || !NO_LOST_MESSAGE.has(key);
}

/** Whether a customer hears about this change: they see the badge, and the brand has messages on for it. */
export function notifies(s: BadgeSettings, key: string, change: BadgeChange, custom?: Pick<CustomBadge, "filter"> | null): boolean {
  if (!s.enabled || (s.off as string[]).includes(key) || !customerSetting(s, key, custom) || !canNotify(key, change)) return false;
  const set = s.notify[key]?.[change];
  if (set !== undefined) return set;
  return change === "earned" && NOTIFY_DEFAULT.has(key);
}

// ───────────────────────────── Wording ─────────────────────────────

const day = (d: unknown) => (d ? formatDate(String(d), "MMM d") : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Their name and why they have it, in the second person. */
export function customerWording(key: BadgeKey, d: Record<string, string | number>): { name: string; text: string } {
  const num = (k: string) => Number(d[k] ?? 0);
  const label = badgeDef(key)?.label ?? key;
  switch (key) {
    case "gold":
      return { name: "Gold", text: `Great client: ${plural(num("visits"), "visit")} and you keep your appointments. Thank you!` };
    case "silver":
      return { name: "Silver", text: `${plural(num("visits"), "visit")} and you keep your appointments.` };
    case "bronze":
      return { name: "Bronze", text: `${plural(num("visits"), "visit")} with us. Keep it up!` };
    case "miss_you":
      return { name: "We miss you", text: `It's been ${plural(num("weeks"), "week")} since your last cut. Book your next one and this goes away.` };
    case "streak":
      return { name: "Streak", text: `${num("n")} appointments in a row, on time.` };
    case "referral_champion":
      return { name: "Referral champion", text: `You've sent us ${plural(num("n"), "friend")}. Thank you!` };
    case "reward":
      return { name: "Reward available", text: `${formatCents(num("cents"))} off your next visit.` };
    case "birthday_week":
    case "birthday_month":
      return { name: "Happy birthday", text: "Happy birthday from all of us!" };
    case "anniversary":
      return { name: "Anniversary", text: `${plural(num("years"), "year")} with us. Thanks for sticking around!` };
    case "review_clicked":
      return { name: "Reviewer", text: "Thanks for reviewing us." };
    case "on_track":
      return { name: "On track", text: d.next ? `Next cut booked for ${day(d.next)}.` : "Right on your usual schedule." };
    case "due":
    case "overdue":
      return { name: "Due for a cut", text: "You're about due for your next cut." };
    case "new_client":
      return { name: "Welcome", text: "Welcome to Ray'z!" };
    case "second_visit":
      return { name: "Welcome back", text: "Thanks for coming back." };
    case "win_back":
      return { name: "Welcome back", text: "Great to have you back." };
    case "loyal":
      return { name: "Loyal regular", text: `${plural(num("visits"), "visit")} with us.` };
    case "vip":
      return { name: "VIP", text: "One of our top clients." };
    case "gift_card":
      return { name: "Gift card", text: `${formatCents(num("cents"))} left on your gift card.` };
    case "coupon":
      return { name: "Coupon", text: `You have ${plural(num("n"), "coupon")} to use.` };
    case "always_with":
      return { name: "Regular", text: `Most of your cuts are with ${d.staff}.` };
    case "online_booker":
      return { name: "Books online", text: "You book online." };
    case "product_buyer":
      return { name: "Product fan", text: "Thanks for picking up products with us." };
    case "barber_left":
      return { name: "New barber needed", text: `${d.staff} has moved on. Pick a new barber when you book.` };
    case "switched_barber":
      return { name: "New barber", text: `You're now with ${d.to}.` };
    case "no_show_risk":
      return { name: "Missed appointments", text: `${plural(num("n"), "missed appointment")} in the last year.` };
    case "late_cancels":
      return { name: "Late cancellations", text: `${plural(num("n"), "late cancellation")} in the last year.` };
    case "at_risk":
      return { name: "We'd love to see you", text: "It's been longer than usual since your last cut." };
    case "lapsed":
      return { name: "We miss you", text: "It's been a while since your last cut." };
    case "missing_info":
      return { name: "Finish your profile", text: "Add your phone and email so we can send reminders." };
    case "opted_out":
      return { name: "Offers off", text: "You've turned off our offers." };
    case "referrer":
      return { name: "Referrer", text: `You've sent us ${plural(num("n"), "friend")}.` };
    default:
      return { name: label, text: label };
  }
}

/** The {badge_message} line of a Badge news message. */
export function badgeMessage(key: string, change: BadgeChange, name: string, text: string): string {
  if (change === "earned") return key === "miss_you" ? `we miss you! ${text}` : `you've earned ${name}! ${text}`;
  return key === "gold" || key === "silver" || key === "bronze" || key === "streak" ? `your ${name} badge is on pause. Keep your next appointment to get it back.` : `your ${name} badge has ended.`;
}

// ───────────────────────────── The customer's view ─────────────────────────────

export interface CustomerBadge {
  id: string;
  name: string;
  icon: BadgeIcon;
  tone: BadgeTone;
  color: string;
  earnedOn: LocalDate | null;
  text: string;
  /** We miss you: where to book. */
  action: { label: string; url: string } | null;
}

export interface CustomerProgress {
  /** The badge they're working toward. */
  badge: string;
  name: string;
  icon: BadgeIcon;
  tone: BadgeTone;
  color: string;
  current: number;
  target: number;
  remaining: number;
  /** "2 more visits to Gold". */
  text: string;
}

export interface CustomerBadges {
  badges: CustomerBadge[];
  progress: CustomerProgress[];
}

const ORDER = new Map<string, number>(BADGES.map((b, i) => [b.key, i]));

function meter(key: BadgeKey, current: number, target: number, unit: [string, string]): CustomerProgress {
  const d = badgeDef(key)!;
  const remaining = Math.max(0, target - current);
  return {
    badge: key,
    name: d.label,
    icon: d.icon,
    tone: d.tone,
    color: TONE_HEX[d.tone],
    current: Math.min(current, target),
    target,
    remaining,
    text: `${remaining} more ${remaining === 1 ? unit[0] : unit[1]} to ${d.label}`,
  };
}

/** Progress toward the next badge of each kind they can still earn. */
export function badgeProgress(p: BadgeProgressFacts | null, has: ReadonlySet<string>, shows: ReadonlySet<string>, t: BadgeThresholds): CustomerProgress[] {
  if (!p) return [];
  const out: CustomerProgress[] = [];
  const tiers: [BadgeKey, number][] = [
    ["bronze", t.bronzeVisits],
    ["silver", t.silverVisits],
    ["gold", t.goldVisits],
  ];
  if (p.noShows <= t.tierNoShows && !has.has("gold")) {
    const next = tiers.find(([k, n]) => shows.has(k) && p.visits < n);
    if (next) out.push(meter(next[0], p.visits, next[1], ["visit", "visits"]));
  }
  if (shows.has("streak") && !has.has("streak")) out.push(meter("streak", p.streak, t.streakVisits, ["on-time appointment", "on-time appointments"]));
  if (shows.has("referral_champion") && !has.has("referral_champion") && p.referrals > 0) out.push(meter("referral_champion", p.referrals, t.championReferrals, ["referral", "referrals"]));
  return out;
}

/**
 * What a customer sees of their cached badges: only customer-visible ones, in their wording, with
 * the day each was earned. Nothing a staff member wrote or judged leaves here.
 */
export function customerView(
  stored: readonly StoredBadge[],
  o: {
    since: Readonly<Record<string, string>>;
    progress: BadgeProgressFacts | null;
    settings: BadgeSettings;
    custom: readonly CustomBadge[];
    bookUrl: string;
  },
): CustomerBadges {
  const shows = new Set(customerBadgeKeys(o.settings, o.custom));
  const has = new Set(stored.map((b) => b.k));
  const custom = new Map(o.custom.map((c) => [customKey(c.id), c]));
  const badges: CustomerBadge[] = [];
  for (const b of stored) {
    if (!shows.has(b.k)) continue;
    if (b.k === "birthday_month" && has.has("birthday_week") && shows.has("birthday_week")) continue;
    const earnedOn = o.since[b.k] ?? null;
    const c = custom.get(b.k);
    if (c) {
      badges.push({ id: b.k, name: c.label, icon: c.icon, tone: c.tone, color: TONE_HEX[c.tone], earnedOn, text: c.tooltip || c.label, action: null });
      continue;
    }
    const d = badgeDef(b.k);
    if (!d) continue;
    const w = customerWording(b.k as BadgeKey, b.d ?? {});
    badges.push({ id: b.k, name: w.name, icon: d.icon, tone: d.tone, color: TONE_HEX[d.tone], earnedOn, text: w.text, action: b.k === "miss_you" ? { label: "Book now", url: o.bookUrl } : null });
  }
  badges.sort((a, b) => (ORDER.get(a.id) ?? 999) - (ORDER.get(b.id) ?? 999));
  return { badges, progress: badgeProgress(o.progress, has, shows, o.settings.thresholds) };
}

// ───────────────────────────── Public API ─────────────────────────────

const ToneSchema = z.enum(["gray", "green", "blue", "amber", "orange", "red", "violet"]);
export const CustomerBadgeSchema = z.object({
  id: z.string().describe('The badge: a catalog key like "gold" or "miss_you", or "custom:<uuid>"'),
  name: z.string(),
  icon: z.string().describe("Icon name, e.g. medal, flame, frown, trophy, cake, gift"),
  tone: ToneSchema,
  color: z.string().describe("The tone as a hex colour"),
  earnedOn: z.string().nullable().describe("YYYY-MM-DD (shop time) the badge was earned"),
  text: z.string().describe("Why they have it, for the customer"),
  action: z.object({ label: z.string(), url: z.string() }).nullable().describe("A call to action, e.g. Book now on We miss you"),
});
export const CustomerProgressSchema = z.object({
  badge: z.string(),
  name: z.string(),
  icon: z.string(),
  tone: ToneSchema,
  color: z.string(),
  current: z.number().int(),
  target: z.number().int(),
  remaining: z.number().int(),
  text: z.string().describe('e.g. "2 more visits to Gold"'),
});
export const CustomerBadgesSchema = z.object({ badges: z.array(CustomerBadgeSchema), progress: z.array(CustomerProgressSchema) });

/** For openApiDocument (src/server/openapi.ts): the path and its schema, in that file's shapes. Served by src/server/customer-badges-api.ts. */
export const CUSTOMER_BADGES_OPENAPI = {
  components: { CustomerBadges: CustomerBadgesSchema },
  paths: {
    "/me/badges": {
      get: {
        tags: ["Me"],
        summary: "My badges (only the ones the brand shows customers), when each was earned, and progress toward the next",
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/CustomerBadges" } } } },
          401: { description: "Sign in required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
} as const;
