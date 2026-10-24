/**
 * The Morning Dashboard: the last open day's numbers with week to date and the same day the week
 * before, today's schedule, and the exceptions to handle, for one person and one version (all their
 * locations, or one shop). The same data object feeds the in-app page, the HTML and text email, the
 * PDF and the text-message line. Settings live in brand_settings.digest.
 */
import { z } from "zod";
import { LocalDate, addDays, diffDays, formatDate } from "@/lib/time";
import { weekStartOf } from "./payroll/overtime";

export const MORNING_ROLE_DEFAULTS = ["brand_owner", "brand_admin", "regional_manager", "shop_manager"];

export const MORNING_SECTIONS = ["sales", "traffic", "utilization", "loyalty", "marketing", "reviews", "today", "exceptions"] as const;
export type MorningSection = (typeof MORNING_SECTIONS)[number];

export const SECTION_LABEL: Record<MorningSection, string> = {
  sales: "Sales",
  traffic: "Clients and bookings",
  utilization: "Barber utilization",
  loyalty: "Loyalty and gift cards",
  marketing: "Campaign Center",
  reviews: "Google review links",
  today: "Today",
  exceptions: "Needs attention",
};

export const SECTION_HINT: Record<MorningSection, string> = {
  sales: "Gross and net sales, services and products, tips, card fees, refunds and voids, tickets and average ticket, by location and barber",
  traffic: "New and returning clients, bookings made online, walk-in and at the desk, visits, cancellations and no-shows",
  utilization: "Booked against available hours per barber, and average time in the chair against the booked time",
  loyalty: "Rewards issued and redeemed, gift cards sold and redeemed, and what's still owed on gift cards",
  marketing: "Campaign Center sends, clicks, bookings, coupon redemptions and attributed revenue",
  reviews: "Review follow-ups sent and clicks on each location's Google review link",
  today: "Each shop's hours, who's working, open time per barber, time off and call-ins",
  exceptions: "Missed punches, overtime risk, low stock and purchase orders, pending tip payouts, approvals and Stripe payouts",
};

/** All locations in one email, one email per shop, or both. */
export const VERSION_KINDS = ["combined", "per_shop", "both"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const MorningVersion = z.object({
  kind: z.enum(VERSION_KINDS).default("combined"),
  /** Which of their shops it covers; empty is every shop they may see it for. */
  shopIds: z.array(z.uuid()).default([]),
});
export type MorningVersion = z.output<typeof MorningVersion>;

const ALL_ON = Object.fromEntries(MORNING_SECTIONS.map((k) => [k, true])) as Record<MorningSection, boolean>;

export const MorningSettings = z.object({
  enabled: z.boolean().default(true),
  /** Local minutes after midnight, any minute from 4:00 to 11:00. The job runs every minute. */
  sendAtMin: z
    .number()
    .int()
    .min(4 * 60, "Pick a time from 4:00 AM")
    .max(11 * 60, "Pick a time by 11:00 AM")
    .default(7 * 60 + 2),
  /** Role keys whose people get it, as a main role or a role at one of their shops. */
  roles: z.array(z.string()).default(MORNING_ROLE_DEFAULTS),
  /** People who get it even though their role doesn't. */
  include: z.array(z.uuid()).default([]),
  /** People who don't, whatever their role. */
  exclude: z.array(z.uuid()).default([]),
  /** Per person: the all-locations version, a single-shop version per shop, or both. */
  versions: z.record(z.uuid(), MorningVersion).default({}),
  sections: z.object(Object.fromEntries(MORNING_SECTIONS.map((k) => [k, z.boolean().default(true)])) as Record<MorningSection, z.ZodDefault<z.ZodBoolean>>).default(ALL_ON),
  /** No email on days every shop is closed (Sundays). */
  skipClosedDays: z.boolean().default(true),
  /** Cover the last day a shop was open, so Monday's covers Saturday. Off covers yesterday, open or not. */
  coverLastOpenDay: z.boolean().default(true),
  /** Attach the dashboard as a PDF. */
  pdf: z.boolean().default(false),
  /** Also text a one-line summary to recipients with a mobile number. */
  sms: z.boolean().default(false),
});
export type MorningSettings = z.output<typeof MorningSettings>;

/** Settings saved by the earlier morning digest had sales, staff and alerts sections. */
function upgrade(raw: Record<string, unknown>): Record<string, unknown> {
  const s = raw.sections;
  if (!s || typeof s !== "object" || "today" in s || "exceptions" in s) return raw;
  const old = s as Record<string, unknown>;
  const sections: Record<string, unknown> = { ...old };
  if (typeof old.staff === "boolean") sections.today = old.staff;
  if (typeof old.alerts === "boolean") sections.exceptions = old.alerts;
  return { ...raw, sections };
}

export const morningSettings = (raw: unknown): MorningSettings => MorningSettings.parse(raw && typeof raw === "object" ? upgrade(raw as Record<string, unknown>) : {});

export const parseMorningSettings = (raw: unknown) => MorningSettings.safeParse(raw && typeof raw === "object" ? upgrade(raw as Record<string, unknown>) : raw);

// ───────────────────────────── Versions ─────────────────────────────

export interface VersionPlan {
  /** "all" for a multi-shop version, or the shop's id. */
  scope: string;
  shopIds: string[];
}

/**
 * Which emails one person gets, from the shops they may see the dashboard for. One shop is always
 * the single-shop version; more than one is the all-locations version unless the brand picked
 * single-shop emails (or both) for them.
 */
export function versionPlans(eligible: readonly string[], v: MorningVersion | undefined): VersionPlan[] {
  if (!eligible.length) return [];
  const picked = v?.shopIds.length ? eligible.filter((id) => v.shopIds.includes(id)) : [...eligible];
  if (!picked.length) return [];
  const single = picked.map((id) => ({ scope: id, shopIds: [id] }));
  if (picked.length === 1) return single;
  const combined = { scope: "all", shopIds: picked };
  const kind = v?.kind ?? "combined";
  return kind === "combined" ? [combined] : kind === "per_shop" ? single : [combined, ...single];
}

// ───────────────────────────── Periods ─────────────────────────────

export interface MorningPeriods {
  /** The morning it's for. */
  today: LocalDate;
  /** The day the numbers are for: the last day before today a shop in the version was open. */
  reportDay: LocalDate;
  /** The same weekday the week before. */
  compareDay: LocalDate;
  /** Sunday of the report day's week through the report day. */
  wtdFrom: LocalDate;
  /** The same days the week before. */
  wtdPriorFrom: LocalDate;
  wtdPriorTo: LocalDate;
  /** Closed days between the report day and today, which the numbers skip (Sunday, on Monday). */
  skipped: LocalDate[];
}

/** Monday's dashboard covers Saturday when the shops are closed Sundays; at most a week back. */
export function morningPeriods(today: LocalDate, wasOpen: (d: LocalDate) => boolean, coverLastOpenDay = true): MorningPeriods {
  let reportDay = addDays(today, -1);
  if (coverLastOpenDay) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, -i);
      if (wasOpen(d)) {
        reportDay = d;
        break;
      }
    }
  }
  const wtdFrom = weekStartOf(reportDay);
  const skipped: LocalDate[] = [];
  for (let d = addDays(reportDay, 1); d < today; d = addDays(d, 1)) skipped.push(d);
  return { today, reportDay, compareDay: addDays(reportDay, -7), wtdFrom, wtdPriorFrom: addDays(wtdFrom, -7), wtdPriorTo: addDays(reportDay, -7), skipped };
}

export const wtdDays = (p: MorningPeriods) => diffDays(p.reportDay, p.wtdFrom) + 1;

// ───────────────────────────── The data ─────────────────────────────

/** A number for the report day, the same day last week, week to date, and the same days last week. */
export interface Cmp {
  day: number;
  prior: number;
  wtd: number;
  wtdPrior: number;
}
export const cmp = (day = 0, prior = 0, wtd = 0, wtdPrior = 0): Cmp => ({ day, prior, wtd, wtdPrior });
export const CMP_KEYS = ["day", "prior", "wtd", "wtdPrior"] as const;
export type Period = (typeof CMP_KEYS)[number];
export const cmpOf = (f: (p: Period) => number): Cmp => ({ day: f("day"), prior: f("prior"), wtd: f("wtd"), wtdPrior: f("wtdPrior") });
export const ratioCmp = (a: Cmp, b: Cmp, scale = 1): Cmp => cmpOf((p) => (b[p] ? (a[p] / b[p]) * scale : 0));

export interface ShopRef {
  id: string;
  name: string;
}

export interface BarberSales {
  staffId: string;
  label: string;
  net: number;
  services: number;
  products: number;
  tips: number;
  tickets: number;
  netWtd: number;
}

export interface SalesBlock {
  shops: ShopRef[];
  gross: Cmp;
  net: Cmp;
  services: Cmp;
  products: Cmp;
  tips: Cmp;
  cardFees: Cmp;
  refunds: Cmp;
  tickets: Cmp;
  avgTicket: Cmp;
  /** Needs the discounts and refunds report. */
  voids: Cmp | null;
  /** Each location, when there's more than one. */
  byShop: { shop: ShopRef; net: Cmp; tickets: Cmp }[];
  /** Needs the barber performance report; null without it. */
  byBarber: BarberSales[] | null;
  /** Without "every barber's numbers", only their own row. */
  ownOnly: boolean;
  /** Net sales per day of the report week, against the same weekday last week. */
  daily: { date: LocalDate; net: number; prior: number }[];
}

export interface TrafficBlock {
  shops: ShopRef[];
  newClients: Cmp;
  returningClients: Cmp;
  /** Appointments booked on the day, whenever they're for. */
  bookingsMade: Cmp;
  online: Cmp;
  walkIns: Cmp;
  frontDesk: Cmp;
  /** Appointments that started on the day, whatever happened to them. */
  visits: Cmp;
  cancellations: Cmp;
  noShows: Cmp;
}

export interface BarberTime {
  staffId: string;
  label: string;
  bookedMin: number;
  availableMin: number;
  utilization: number | null;
  utilizationWtd: number | null;
  /** Needs the service times report. */
  avgActualMin: number | null;
  avgBookedMin: number | null;
  timed: number;
}

export interface UtilizationBlock {
  shops: ShopRef[];
  booked: Cmp;
  available: Cmp;
  utilization: Cmp;
  barbers: BarberTime[];
  ownOnly: boolean;
  /** Average actual and booked minutes of timed services on the day; null without the service times report. */
  cutTimes: { avgActualMin: number | null; avgBookedMin: number | null; n: number } | null;
}

export interface LoyaltyBlock {
  loyalty: { shops: ShopRef[]; rewardsIssued: Cmp; rewardsRedeemed: Cmp; redeemedCents: Cmp; members: Cmp } | null;
  giftCards: { shops: ShopRef[]; soldN: Cmp; soldCents: Cmp; redeemedCents: Cmp; outstandingCents: number } | null;
}

export interface MarketingBlock {
  shops: ShopRef[];
  /** Only We have openings blasts, for people with the openings report but not the Campaign Center's. */
  openingsOnly: boolean;
  sends: Cmp;
  clicks: Cmp;
  bookings: Cmp;
  redemptions: Cmp;
  revenue: Cmp;
}

export interface ReviewsBlock {
  shops: ShopRef[];
  clicks: Cmp;
  followUps: Cmp;
  byShop: { shop: ShopRef; clicks: Cmp }[];
}

export interface TodayBarber {
  staffId: string;
  label: string;
  /** "9:00 AM–6:00 PM", with time off cut out. */
  hours: string;
  partlyOff: boolean;
  booked: number;
  openMin: number;
  /** Open stretches left, like "2:00 PM–3:30 PM". */
  open: string[];
}

export interface TodayShop {
  shop: ShopRef;
  open: boolean;
  /** Shop hours, or why it's closed. */
  hours: string;
  appointments: number;
  barbers: TodayBarber[];
  off: { label: string; why: string }[];
  callIns: { label: string; kind: string; when: string }[];
  openMin: number;
}

export interface TodayBlock {
  date: LocalDate;
  shops: TodayShop[];
}

export const EXCEPTION_CATEGORIES = ["punches", "overtime", "stock", "purchasing", "tips", "approvals", "payouts"] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];
export const EXCEPTION_LABEL: Record<ExceptionCategory, string> = {
  punches: "Missed clock-ins and clock-outs",
  overtime: "Overtime risk",
  stock: "Low stock",
  purchasing: "Purchase orders",
  tips: "Tip payouts",
  approvals: "Waiting for approval",
  payouts: "Stripe payouts",
};

export interface ExceptionItem {
  category: ExceptionCategory;
  /** "low" is status to know (a deposit on its way), not something to handle. */
  severity: "high" | "medium" | "low";
  shop: string | null;
  title: string;
  detail?: string;
  /** Path in the app, without the host. */
  href: string;
}

export interface ExceptionsBlock {
  /** Categories this person may see; an empty one means nothing to handle there. */
  categories: ExceptionCategory[];
  items: ExceptionItem[];
}

export interface MorningDashboard {
  firstName: string;
  version: { scope: string; label: string; shops: ShopRef[] };
  periods: MorningPeriods;
  /** The app's address, for links. */
  baseUrl: string;
  sales: SalesBlock | null;
  traffic: TrafficBlock | null;
  utilization: UtilizationBlock | null;
  loyalty: LoyaltyBlock | null;
  marketing: MarketingBlock | null;
  reviews: ReviewsBlock | null;
  today: TodayBlock | null;
  exceptions: ExceptionsBlock | null;
}

export const hasContent = (d: MorningDashboard) => MORNING_SECTIONS.some((k) => d[k] !== null);

export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
export const urgentCount = (d: MorningDashboard) => d.exceptions?.items.filter((i) => i.severity === "high").length ?? 0;
export const handleCount = (d: MorningDashboard) => d.exceptions?.items.filter((i) => i.severity !== "low").length ?? 0;

// ───────────────────────────── Formatting ─────────────────────────────

/** Change from `prev` to `cur`, or null when there's nothing to compare against. */
export function change(cur: number, prev: number): number | null {
  if (!prev) return null;
  return (cur - prev) / Math.abs(prev);
}

export const pctLabel = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** "▲ 8%", "▼ 12%", "even", or "new" when last week had nothing. */
export function changeLabel(cur: number, prev: number): string {
  const c = change(cur, prev);
  if (c === null) return cur ? "new" : "—";
  const p = Math.round(c * 100);
  return p === 0 ? "even" : `${p > 0 ? "▲" : "▼"} ${Math.abs(p)}%`;
}

/** Plain words for text and SMS, where arrows may not survive: "up 8%". */
export function changeWords(cur: number, prev: number): string {
  const c = change(cur, prev);
  if (c === null) return cur ? "new" : "no change";
  const p = Math.round(c * 100);
  return p === 0 ? "even" : `${p > 0 ? "up" : "down"} ${Math.abs(p)}%`;
}

export const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Whole dollars, for headlines and charts. */
export const dollars = (c: number) => `${c < 0 ? "-" : ""}$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;
export const hoursLabel = (min: number) => `${(Math.round((min / 60) * 10) / 10).toLocaleString("en-US")}h`;
export const minLabel = (m: number | null) => (m === null ? "—" : `${Math.round(m)} min`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function periodLabels(p: MorningPeriods) {
  return {
    day: formatDate(p.reportDay, "EEEE, MMM d"),
    dayShort: formatDate(p.reportDay, "EEE"),
    prior: `last ${formatDate(p.compareDay, "EEEE")}`,
    wtd: `Week to date (${formatDate(p.wtdFrom, "EEE")}–${formatDate(p.reportDay, "EEE")})`,
    today: formatDate(p.today, "EEEE, MMMM d"),
  };
}

/** A report in the app for the given days and this version's shops. */
export function reportLink(d: Pick<MorningDashboard, "baseUrl" | "version">, href: string, from: LocalDate, to: LocalDate, shops?: readonly ShopRef[]): string {
  const q = new URLSearchParams({ from, to });
  for (const s of shops ?? d.version.shops) q.append("shop", s.id);
  return `${d.baseUrl}${href}?${q.toString()}`;
}

export const appLink = (d: Pick<MorningDashboard, "baseUrl">, path: string) => `${d.baseUrl}${path}`;

/** The in-app dashboard for this version and morning. */
export function dashboardLink(d: Pick<MorningDashboard, "baseUrl" | "version" | "periods">) {
  const q = new URLSearchParams({ date: d.periods.today });
  if (d.version.scope !== "all") q.set("shop", d.version.scope);
  else for (const s of d.version.shops) q.append("shop", s.id);
  return `${d.baseUrl}/admin/morning?${q.toString()}`;
}
