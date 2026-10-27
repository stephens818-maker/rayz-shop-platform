/**
 * Staff milestones: counts (cuts, clients served, new clients, rebooks, products sold), work
 * anniversaries from the hire date, optional birthdays, personal bests and streaks. The rules live in
 * staff_milestone_rules (the built-ins seeded by drizzle/core_0066_staff_milestones.sql and the
 * brand's own); what each person reached is staff_milestones, found by src/server/milestones.ts.
 * Everything here is pure: the settings, rule checks, wording, and the arithmetic of when a
 * threshold, anniversary, record or streak was reached.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import { LocalDate, SHOP_TZ, addDays, diffDays, formatDate, weekdayOf } from "@/lib/time";

export const MILESTONE_KINDS = [
  "count",
  "anniversary",
  "birthday",
  "best",
  "streak",
] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export const KIND_LABEL: Record<MilestoneKind, string> = {
  count: "Counts",
  anniversary: "Work anniversaries",
  birthday: "Birthdays",
  best: "Personal bests",
  streak: "Streaks",
};

export const COUNT_METRICS = [
  "services",
  "clients",
  "new_clients",
  "rebooks",
  "products",
] as const;
export type CountMetric = (typeof COUNT_METRICS)[number];
export const BEST_METRICS = [
  "sales_day",
  "sales_week",
  "sales_month",
  "cuts_day",
  "rebook_month",
] as const;
export type BestMetric = (typeof BEST_METRICS)[number];
export const STREAK_METRICS = ["five_star", "on_time"] as const;
export type StreakMetric = (typeof STREAK_METRICS)[number];
export type MilestoneMetric =
  CountMetric | BestMetric | StreakMetric | "hire_date" | "birthday";

export interface MetricInfo {
  kind: MilestoneKind;
  label: string;
  /** Counts and streaks: what the number is of, plural. */
  unit?: string;
  hint: string;
}

export const METRICS: Record<MilestoneMetric, MetricInfo> = {
  services: {
    kind: "count",
    label: "Cuts and services",
    unit: "cuts",
    hint: "Completed appointments, imported Squire visits included.",
  },
  clients: {
    kind: "count",
    label: "Clients served",
    unit: "clients served",
    hint: "Different clients they've finished a visit for.",
  },
  new_clients: {
    kind: "count",
    label: "New clients",
    unit: "new clients",
    hint: "Clients whose first visit at Ray'z was with them.",
  },
  rebooks: {
    kind: "count",
    label: "Rebooks",
    unit: "rebooks",
    hint: "Visits where the client booked their next one before leaving or within a day, as in the rebook KPI.",
  },
  products: {
    kind: "count",
    label: "Products sold",
    unit: "products sold",
    hint: "Products sold on their tickets, less refunds.",
  },
  hire_date: {
    kind: "anniversary",
    label: "Work anniversary",
    hint: "Years from the hire date on their staff profile.",
  },
  birthday: {
    kind: "birthday",
    label: "Birthday",
    hint: "Only when birthdays are on and they've added theirs (month and day, never the year).",
  },
  sales_day: {
    kind: "best",
    label: "Best sales day",
    hint: "Net service and product sales credited to them in one day, after at least 30 days of history.",
  },
  sales_week: {
    kind: "best",
    label: "Best sales week",
    hint: "Net service and product sales, Sunday to Saturday, after at least 4 weeks of history.",
  },
  sales_month: {
    kind: "best",
    label: "Best sales month",
    hint: "Net service and product sales in a calendar month, after at least 3 months of history.",
  },
  cuts_day: {
    kind: "best",
    label: "Most cuts in a day",
    hint: "Completed appointments in one day, after at least 30 days of history.",
  },
  rebook_month: {
    kind: "best",
    label: "Highest rebook rate",
    hint: `Rebooked visits over visits in a calendar month with at least ${20} visits, after at least 3 months of history.`,
  },
  five_star: {
    kind: "streak",
    label: "5-star ratings in a row",
    unit: "5-star ratings in a row",
    hint: "Back-to-back 5-star answers to the post-visit question.",
  },
  on_time: {
    kind: "streak",
    label: "On-time starts in a row",
    unit: "on-time starts in a row",
    hint: "Back-to-back booked appointments started within 5 minutes of the booked time. Walk-ins don't count.",
  },
};

export const metricsOf = (kind: MilestoneKind) =>
  (Object.keys(METRICS) as MilestoneMetric[]).filter(
    (m) => METRICS[m].kind === kind,
  );
export const isMetric = (s: string): s is MilestoneMetric => s in METRICS;

/** The milestones a barber's clients may celebrate with them: nothing about money, rates or ratings. */
export const SHAREABLE = new Set<MilestoneMetric>([
  "services",
  "clients",
  "new_clients",
  "hire_date",
]);

/** A record or a threshold this many days back still gets an alert; older ones are kept quietly. */
export const NOTIFY_DAYS = 2;
/** Congratulations show in the person's portal this long, until they dismiss it. */
export const CONGRATS_DAYS = 14;
/** The team feed's window. */
export const FEED_DAYS = 30;
/** The rebook rate needs this many visits in the month to count as a record. */
export const MIN_REBOOK_VISITS = 20;
/** Periods of history before a record is celebrated. */
export const BEST_HISTORY: Record<BestMetric, number> = {
  sales_day: 30,
  sales_week: 4,
  sales_month: 3,
  cuts_day: 30,
  rebook_month: 3,
};
/** Pace for "coming up" estimates: the last this many days. */
export const PACE_DAYS = 28;

// ───────────────────────────── Settings ─────────────────────────────

// ───────────────────────────── ST-I2 Shop goals ─────────────────────────────

/** What a shop goal counts: the shop's totals for the week or month, never money or one barber's numbers. */
export const GOAL_METRICS = ["services", "new_clients", "rebooks", "products"] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const GOAL_PERIODS = ["week", "month"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export const GOAL_PERIOD_LABEL: Record<GoalPeriod, string> = { week: "This week", month: "This month" };

export const ShopGoal = z.object({
  id: z.string().trim().min(1).max(40),
  metric: z.enum(GOAL_METRICS),
  period: z.enum(GOAL_PERIODS),
  target: z.number().int().min(1, "Set each goal to at least 1").max(1_000_000, "Keep each goal under a million"),
  /** Empty: every shop. */
  shopIds: z.array(z.uuid()).max(200).default([]),
});
export type ShopGoal = z.output<typeof ShopGoal>;

/** The goals that apply at a shop. */
export const goalsAt = (goals: readonly ShopGoal[], shopId: string) => goals.filter((g) => !g.shopIds.length || g.shopIds.includes(shopId));

/** A goal's dates: the Sunday-to-Saturday week or the calendar month that today is in. */
export function goalPeriod(period: GoalPeriod, today: LocalDate): { from: LocalDate; to: LocalDate } {
  if (period === "week") {
    const from = addDays(today, -weekdayOf(today));
    return { from, to: addDays(from, 6) };
  }
  const d = DateTime.fromISO(today, { zone: SHOP_TZ });
  return { from: d.startOf("month").toISODate()!, to: d.endOf("month").toISODate()! };
}

/** "120 of 400 cuts", whole percent (capped at 100) and whether it's reached. */
export function goalProgress(target: number, current: number) {
  return { current, target, pct: Math.min(100, Math.floor((current / target) * 100)), reached: current >= target };
}

export const MilestoneSettings = z.object({
  enabled: z.boolean().default(true),
  /** Off: no birthdays recorded, asked for or shown. */
  birthdays: z.boolean().default(false),
  /** Email the brand (people with access to every shop who see milestones). */
  alertBrand: z.boolean().default(true),
  /** Email the managers of the shops the person works at. */
  alertManagers: z.boolean().default(true),
  /** A congratulations notice in the person's own portal. */
  congratulate: z.boolean().default(true),
  /** Teammates at the same shops see each other's milestones and can cheer them. */
  teamFeed: z.boolean().default(false),
  /** Offer the brand's "Celebrate a barber's milestone" template for the barber's clients. */
  celebrate: z.boolean().default(true),
  /** How far ahead "coming up" looks. */
  upcomingDays: z
    .number()
    .int()
    .min(1, "At least 1 day")
    .max(31, "Up to 31 days")
    .default(7),
  /** On the day: a banner on the shop's calendar. */
  calendarBanner: z.boolean().default(true),
  /** On the day: a banner on the shop's Sales & checkout and the POS. */
  posBanner: z.boolean().default(true),
  /** On the day: a confetti badge on their calendar column. */
  columnBadge: z.boolean().default(true),
  /** A congratulations window when they clock in or open their portal. */
  welcomeModal: z.boolean().default(true),
  /** A toast for everyone signed in at the shop when a count is reached during the day. */
  liveToast: z.boolean().default(true),
  /** Banners and toasts at every location, not only the shops the person works at. */
  allLocations: z.boolean().default(false),
  /** ST-I2: shop goals everyone at the shop sees with their milestones. */
  goals: z.array(ShopGoal).max(20, "Up to 20 shop goals").default([]),
});
export type MilestoneSettings = z.output<typeof MilestoneSettings>;

export function milestoneSettings(raw: unknown): MilestoneSettings {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ok = MilestoneSettings.safeParse(obj);
  if (ok.success) return ok.data;
  const defaults = MilestoneSettings.parse({});
  const keep = Object.fromEntries(
    Object.keys(defaults)
      .filter(
        (k) =>
          MilestoneSettings.shape[k as keyof MilestoneSettings].safeParse(
            obj[k],
          ).success,
      )
      .map((k) => [k, obj[k]]),
  );
  return MilestoneSettings.parse(keep);
}

// ───────────────────────────── Rules ─────────────────────────────

export interface RuleLike {
  id: string;
  key: string | null;
  kind: MilestoneKind;
  metric: string;
  name: string;
  unit: string | null;
  thresholds: number[];
  serviceIds: string[];
  active: boolean;
  builtIn: boolean;
}

export const RuleInput = z.object({
  id: z.uuid().nullable().default(null),
  kind: z.enum(MILESTONE_KINDS),
  metric: z.string(),
  name: z
    .string()
    .trim()
    .min(1, "Give it a name")
    .max(60, "Keep the name under 60 characters"),
  unit: z
    .string()
    .trim()
    .max(40, "Keep what it counts under 40 characters")
    .default(""),
  thresholds: z
    .array(
      z
        .number()
        .int()
        .min(1, "Numbers start at 1")
        .max(1_000_000, "Numbers go up to 1,000,000"),
    )
    .max(20, "Up to 20 numbers")
    .default([]),
  serviceIds: z.array(z.uuid()).max(50).default([]),
  active: z.boolean().default(true),
});
export type RuleInput = z.output<typeof RuleInput>;

/** The built-in milestones, as core_0066 seeds them; restored if a reset removes them. */
export const BUILT_IN_RULES: {
  key: string;
  kind: MilestoneKind;
  metric: MilestoneMetric;
  name: string;
  unit: string | null;
  thresholds: number[];
  sortOrder: number;
}[] = [
  {
    key: "services",
    kind: "count",
    metric: "services",
    name: "Cuts and services",
    unit: "cuts",
    thresholds: [100, 500, 1000, 5000, 10000],
    sortOrder: 10,
  },
  {
    key: "clients",
    kind: "count",
    metric: "clients",
    name: "Clients served",
    unit: "clients served",
    thresholds: [100, 250, 500, 1000, 2500],
    sortOrder: 20,
  },
  {
    key: "new_clients",
    kind: "count",
    metric: "new_clients",
    name: "New clients",
    unit: "new clients",
    thresholds: [50, 100, 250, 500, 1000],
    sortOrder: 30,
  },
  {
    key: "rebooks",
    kind: "count",
    metric: "rebooks",
    name: "Rebooks",
    unit: "rebooks",
    thresholds: [100, 250, 500, 1000, 2500],
    sortOrder: 40,
  },
  {
    key: "products",
    kind: "count",
    metric: "products",
    name: "Products sold",
    unit: "products sold",
    thresholds: [100, 250, 500, 1000],
    sortOrder: 50,
  },
  {
    key: "anniversary",
    kind: "anniversary",
    metric: "hire_date",
    name: "Work anniversary",
    unit: null,
    thresholds: [1, 5, 10],
    sortOrder: 60,
  },
  {
    key: "birthday",
    kind: "birthday",
    metric: "birthday",
    name: "Birthday",
    unit: null,
    thresholds: [],
    sortOrder: 70,
  },
  {
    key: "best_sales_day",
    kind: "best",
    metric: "sales_day",
    name: "Best sales day",
    unit: null,
    thresholds: [],
    sortOrder: 80,
  },
  {
    key: "best_sales_week",
    kind: "best",
    metric: "sales_week",
    name: "Best sales week",
    unit: null,
    thresholds: [],
    sortOrder: 81,
  },
  {
    key: "best_sales_month",
    kind: "best",
    metric: "sales_month",
    name: "Best sales month",
    unit: null,
    thresholds: [],
    sortOrder: 82,
  },
  {
    key: "best_cuts_day",
    kind: "best",
    metric: "cuts_day",
    name: "Most cuts in a day",
    unit: null,
    thresholds: [],
    sortOrder: 83,
  },
  {
    key: "best_rebook_month",
    kind: "best",
    metric: "rebook_month",
    name: "Highest rebook rate",
    unit: null,
    thresholds: [],
    sortOrder: 84,
  },
  {
    key: "streak_five_star",
    kind: "streak",
    metric: "five_star",
    name: "5-star ratings in a row",
    unit: "5-star ratings in a row",
    thresholds: [10, 25, 50, 100],
    sortOrder: 90,
  },
  {
    key: "streak_on_time",
    kind: "streak",
    metric: "on_time",
    name: "On-time starts in a row",
    unit: "on-time starts in a row",
    thresholds: [25, 50, 100, 250],
    sortOrder: 91,
  },
];

/** The brand-approved "celebrate with clients" template, as core_0066 adds it. "a big milestone" becomes the milestone. */
export const MILESTONE_TEMPLATE = {
  name: "Celebrate a barber's milestone",
  campaignType: "update" as const,
  description:
    "Lets a barber's clients celebrate with them: first name only, never a number about the business. Offered from the barber's milestone; \"a big milestone\" becomes the milestone itself.",
  templates: {
    sms: "{shop}: {barber} just hit a big milestone, and clients like you made it happen. Thanks, {first_name}! Come celebrate in the chair: {book_link} Reply STOP to opt out.",
    emailSubject: "{barber} just hit a big milestone",
    emailBody:
      "Hi {first_name},\n\n{barber} at {shop} just hit a big milestone, and clients like you made it happen. Thank you!\n\nCome celebrate in the chair: {book_link}",
    pushTitle: "{barber} just hit a big milestone",
    pushBody: "Thanks for being part of it, {first_name}.",
  },
};

/** Kinds the brand can add more of; bests and birthdays are built in only. */
export const CUSTOM_KINDS: readonly MilestoneKind[] = [
  "count",
  "anniversary",
  "streak",
];

export const cleanThresholds = (xs: readonly number[]) =>
  [...new Set(xs.filter((x) => Number.isInteger(x) && x > 0))].sort(
    (a, b) => a - b,
  );

/** "100, 500, 1000" or "100 500 1000". Null when something isn't a whole number. */
export function parseThresholds(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  return cleanThresholds(parts.map(Number));
}

export function ruleProblem(
  r: Pick<RuleInput, "kind" | "metric" | "thresholds" | "serviceIds">,
): string | null {
  if (!isMetric(r.metric) || METRICS[r.metric].kind !== r.kind)
    return "Pick what it counts";
  const needsNumbers =
    r.kind === "count" || r.kind === "anniversary" || r.kind === "streak";
  if (needsNumbers && !r.thresholds.length)
    return r.kind === "anniversary"
      ? "Add at least one year"
      : "Add at least one number to reach";
  if (!needsNumbers && r.thresholds.length)
    return "This one has no numbers to reach";
  if (r.kind === "anniversary" && r.thresholds.some((t) => t > 60))
    return "Anniversaries go up to 60 years";
  if (r.serviceIds.length && r.metric !== "services")
    return "Only cuts and services can be limited to some services";
  return null;
}

export const ruleUnit = (r: Pick<RuleLike, "metric" | "unit">) =>
  r.unit?.trim() || METRICS[r.metric as MilestoneMetric]?.unit || "times";

// ───────────────────────────── Wording ─────────────────────────────

export interface MilestoneFacts {
  kind: MilestoneKind;
  metric: string;
  threshold: number | null;
  value: number | null;
  /** The rule's unit, for counts and streaks. */
  unit?: string | null;
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const rate = (tenths: number) => `${Math.round(tenths / 10)}%`;
const unitOf = (m: MilestoneFacts) =>
  m.unit?.trim() || METRICS[m.metric as MilestoneMetric]?.unit || "times";
export const yearsLabel = (n: number) => `${n}-year work anniversary`;

/**
 * What was reached: "1,000 cuts", "5-year work anniversary", "Best sales week: $3,210". Without
 * `money` (the team feed, a client message) a sales record leaves the amount out.
 */
export function milestoneTitle(
  m: MilestoneFacts,
  o: { money?: boolean } = {},
): string {
  const money = o.money ?? true;
  switch (m.kind) {
    case "count":
    case "streak":
      return `${int(m.threshold ?? 0)} ${unitOf(m)}`;
    case "anniversary":
      return yearsLabel(m.threshold ?? 0);
    case "birthday":
      return "Birthday";
    case "best": {
      const label = METRICS[m.metric as BestMetric]?.label ?? "Personal best";
      const v = m.value ?? 0;
      if (m.metric === "cuts_day") return `${label}: ${int(v)}`;
      if (m.metric === "rebook_month") return `${label}: ${rate(v)}`;
      return money ? `${label}: ${dollars(v)}` : `New ${label.toLowerCase()}`;
    }
  }
}

const BEST_PHRASE: Record<BestMetric, string> = {
  sales_day: "a new best sales day",
  sales_week: "a new best sales week",
  sales_month: "a new best sales month",
  cuts_day: "a new record for cuts in a day",
  rebook_month: "a new best rebook rate",
};

/** "Jamie hit 1,000 cuts", "Casey's 5-year work anniversary", "Jamie set a new best sales day: $1,234". */
export function milestoneSentence(
  name: string,
  m: MilestoneFacts,
  o: { money?: boolean } = {},
): string {
  switch (m.kind) {
    case "count":
    case "streak":
      return `${name} hit ${milestoneTitle(m)}`;
    case "anniversary":
      return `${name}'s ${milestoneTitle(m)}`;
    case "birthday":
      return `${name}'s birthday`;
    case "best": {
      const phrase =
        BEST_PHRASE[m.metric as BestMetric] ?? "a new personal best";
      const money = o.money ?? true;
      const v = m.value ?? 0;
      const amount =
        m.metric === "cuts_day"
          ? `${int(v)} cuts`
          : m.metric === "rebook_month"
            ? rate(v)
            : money
              ? dollars(v)
              : null;
      return `${name} set ${phrase}${amount ? `: ${amount}` : ""}`;
    }
  }
}

/** A recorded milestone: its title as it read when reached, and the facts. */
export interface RecordedLike {
  kind: MilestoneKind;
  metric: string;
  threshold: number | null;
  value: number | null;
  title: string;
}

/** The recorded title, with a sales record's amount left out when `money` is false. */
export const recordedTitle = (m: RecordedLike, o: { money?: boolean } = {}) =>
  m.kind === "best" ? milestoneTitle(m, o) : m.title;

export function recordedSentence(
  name: string,
  m: RecordedLike,
  o: { money?: boolean } = {},
): string {
  if (m.kind === "count" || m.kind === "streak")
    return `${name} hit ${m.title}`;
  if (m.kind === "anniversary") return `${name}'s ${m.title}`;
  return milestoneSentence(name, m, o);
}

/** Said to them: "You hit 1,000 cuts", "Your 5-year work anniversary", "Happy birthday". */
export const congratsLine = (m: RecordedLike) =>
  m.kind === "birthday"
    ? "Happy birthday"
    : recordedSentence("You", m).replace(/^You's /, "Your ");

// ───────────────────────────── On the day ─────────────────────────────

/** What the whole shop sees on the day, by first name: nothing about money or client ratings. */
export const SHOP_SHOWN = new Set<MilestoneMetric>([
  "services",
  "clients",
  "new_clients",
  "rebooks",
  "products",
  "hire_date",
  "birthday",
  "on_time",
]);
/** Reached during the day (at checkout or a punch), so the shop gets a live toast. */
export const LIVE_KINDS: readonly MilestoneKind[] = ["count", "streak"];
/** The welcome window also covers a day off: whatever they haven't seen from the last week. */
export const WELCOME_DAYS = 7;

/** 1st, 2nd, 3rd, 11th, 101st, 1,000th. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ??
        "th");
  return `${int(n)}${suffix}`;
}

const possessive = (name: string) => `${name}'s`;

const NTH: Record<CountMetric, (name: string, nth: string) => string> = {
  services: (n, nth) => `Today is ${possessive(n)} ${nth} cut!`,
  clients: (n, nth) => `${n} served their ${nth} client today!`,
  new_clients: (n, nth) => `${n} welcomed their ${nth} new client today!`,
  rebooks: (n, nth) => `Today is ${possessive(n)} ${nth} rebook!`,
  products: (n, nth) => `${n} sold their ${nth} product today!`,
};

/**
 * The shop's line for a milestone reached today, by first name: "Today is Jamie's 1,000th cut!",
 * "Happy 5-year anniversary, Casey!". The built-in counts read as the nth one; the brand's own
 * counts and streaks use their title ("Jamie hit 100 beard trims today!").
 */
export function dayLine(
  firstName: string,
  m: RecordedLike & { builtIn?: boolean },
): string {
  if (m.kind === "anniversary")
    return `Happy ${m.threshold}-year anniversary, ${firstName}!`;
  if (m.kind === "birthday") return `Happy birthday, ${firstName}!`;
  const metric = m.metric as CountMetric;
  if (
    m.kind === "count" &&
    m.builtIn &&
    m.threshold &&
    NTH[metric] &&
    m.title === milestoneTitle({ ...m, unit: METRICS[metric].unit })
  )
    return NTH[metric](firstName, ordinal(m.threshold));
  return `${firstName} hit ${recordedTitle(m, { money: false })} today!`;
}

/** Said to them in the welcome window: "Your 1,000th cut", "Your 5-year work anniversary". */
export const welcomeLine = (
  m: RecordedLike & { builtIn?: boolean },
  o: { money?: boolean } = {},
) => {
  if (
    m.kind === "count" &&
    m.builtIn &&
    m.threshold &&
    m.metric === "services" &&
    m.title === milestoneTitle({ ...m, unit: METRICS.services.unit })
  )
    return `Your ${ordinal(m.threshold)} cut`;
  if (m.kind === "best") return milestoneSentence("You", m, o);
  return congratsLine(m);
};

/** For a client message: what the barber reached, said plainly ("1,000 cuts", "5 years at Ray'z"). */
export function clientPhrase(m: RecordedLike): string | null {
  if (!SHAREABLE.has(m.metric as MilestoneMetric)) return null;
  if (m.kind === "anniversary")
    return `${m.threshold} ${m.threshold === 1 ? "year" : "years"} at Ray'z`;
  if (m.kind === "count") return m.title;
  return null;
}

/** "today", "tomorrow", "Friday" within the week, then "Nov 3". */
export function whenLabel(on: LocalDate, today: LocalDate): string {
  const d = diffDays(on, today);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1 && d < 7) return formatDate(on, "EEEE");
  return formatDate(on, "MMM d");
}

export interface Upcoming extends MilestoneFacts {
  staffId: string;
  on: LocalDate;
  /** From today's bookings or a fixed date; otherwise an estimate from their pace. */
  sure: boolean;
  /** Counts: how many to go. */
  left: number | null;
}

/** "Jamie hits 1,000 cuts today", "Casey's 5-year work anniversary Friday", "Kate should hit 500 clients served around Nov 3". */
export function upcomingSentence(
  name: string,
  u: Upcoming,
  today: LocalDate,
): string {
  const when = whenLabel(u.on, today);
  if (u.kind === "anniversary") return `${name}'s ${milestoneTitle(u)} ${when}`;
  if (u.kind === "birthday") return `${name}'s birthday ${when}`;
  if (u.sure) return `${name} hits ${milestoneTitle(u)} ${when}`;
  const left = u.left !== null ? ` (${int(u.left)} to go)` : "";
  return `${name} should hit ${milestoneTitle(u)} ${when === "today" || when === "tomorrow" ? when : `around ${when}`}${left}`;
}

// ───────────────────────────── Counts ─────────────────────────────

export interface Baseline {
  count: number;
  asOf: LocalDate;
}

/**
 * Which event reaches threshold T: the (T − baseline)th counted since the baseline's date. Zero or
 * less means the baseline already covered it, before the history in the system.
 */
export const eventIndexFor = (threshold: number, baseline: Baseline | null) =>
  threshold - (baseline?.count ?? 0);

/** Thresholds reached by a total, and the next one. */
export function thresholdProgress(
  thresholds: readonly number[],
  total: number,
) {
  const sorted = cleanThresholds(thresholds);
  const reached = sorted.filter((t) => t <= total);
  const next = sorted.find((t) => t > total) ?? null;
  const prev = reached.at(-1) ?? 0;
  return {
    reached,
    next,
    prev,
    pct: next ? Math.max(0, Math.min(1, (total - prev) / (next - prev))) : 1,
  };
}

/** When a pace of `perDay` reaches `threshold` from `total`, or null when it's further out than `horizon` days. */
export function paceDate(
  total: number,
  threshold: number,
  perDay: number,
  today: LocalDate,
  horizon: number,
): LocalDate | null {
  if (threshold <= total || perDay <= 0) return null;
  const days = Math.ceil((threshold - total) / perDay);
  return days <= horizon ? addDays(today, days) : null;
}

// ───────────────────────────── Dates ─────────────────────────────

/** Hire date plus N years; a Feb 29 hire's anniversary is Feb 28 in other years. */
export function anniversaryDate(hire: LocalDate, years: number): LocalDate {
  return DateTime.fromISO(hire, { zone: SHOP_TZ }).plus({ years }).toISODate()!;
}

/** Their birthday in a year; Feb 29 is Feb 28 outside leap years. */
export function birthdayIn(
  year: number,
  month: number,
  day: number,
): LocalDate {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone: SHOP_TZ });
  const d = Math.min(day, first.daysInMonth ?? day);
  return first.set({ day: d }).toISODate()!;
}

export const BirthdayInput = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .nullable()
  .refine(
    (b) =>
      !b ||
      b.day <= (b.month === 2 ? 29 : [4, 6, 9, 11].includes(b.month) ? 30 : 31),
    "That day isn't in that month",
  );

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const birthdayLabel = (month: number, day: number) =>
  `${MONTHS[month - 1]} ${day}`;

/** Years and months since the hire date: "4 years, 11 months". */
export function tenureLabel(hire: LocalDate, today: LocalDate): string {
  const d = DateTime.fromISO(today)
    .diff(DateTime.fromISO(hire), ["years", "months"])
    .toObject();
  const y = Math.floor(d.years ?? 0);
  const m = Math.floor(d.months ?? 0);
  if (y <= 0 && m <= 0) return "New this month";
  return [
    y ? `${y} ${y === 1 ? "year" : "years"}` : null,
    m ? `${m} ${m === 1 ? "month" : "months"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// ───────────────────────────── Personal bests ─────────────────────────────

export interface PeriodValue {
  period: string;
  /** The period's last day. */
  end: LocalDate;
  value: number;
  shopId: string | null;
}

export interface BestRecord extends PeriodValue {
  /** The best before this one; null when it's the first period. */
  previous: number | null;
  /** Periods with activity before it. */
  history: number;
}

/** The record (the first period with the highest value) among closed periods, with the record it beat. */
export function bestRecord(series: readonly PeriodValue[]): BestRecord | null {
  const sorted = [...series].sort((a, b) => a.period.localeCompare(b.period));
  let best: BestRecord | null = null;
  for (const [i, p] of sorted.entries()) {
    const max: number | null = best ? (best as BestRecord).value : null;
    if (max === null || p.value > max)
      best = { ...p, previous: max, history: i };
  }
  return best;
}

/** A record worth an alert: it beat an earlier one, after enough history, and its period closed lately. */
export const bestIsNews = (
  r: BestRecord,
  metric: BestMetric,
  today: LocalDate,
) =>
  r.previous !== null &&
  r.value > r.previous &&
  r.history >= BEST_HISTORY[metric] &&
  diffDays(today, r.end) <= NOTIFY_DAYS + 1;

export const monthEnd = (month: string): LocalDate =>
  DateTime.fromISO(`${month}-01`).endOf("month").toISODate()!;

// ───────────────────────────── Streaks ─────────────────────────────

export interface StreakEvent {
  id: string;
  day: LocalDate;
  shopId: string | null;
  ok: boolean;
}

/** The first time each threshold was reached by a run of ok events in a row, and the current run. */
export function streakHits(
  events: readonly StreakEvent[],
  thresholds: readonly number[],
) {
  const ts = cleanThresholds(thresholds);
  const hits = new Map<
    number,
    {
      threshold: number;
      day: LocalDate;
      shopId: string | null;
      startId: string;
    }
  >();
  let run = 0;
  let start: string | null = null;
  let longest = 0;
  for (const e of events) {
    if (!e.ok) {
      run = 0;
      start = null;
      continue;
    }
    if (run === 0) start = e.id;
    run++;
    longest = Math.max(longest, run);
    for (const t of ts)
      if (t === run && !hits.has(t))
        hits.set(t, {
          threshold: t,
          day: e.day,
          shopId: e.shopId,
          startId: start!,
        });
  }
  return { hits: [...hits.values()], current: run, longest };
}

// ───────────────────────────── Who sees what ─────────────────────────────

export interface MilestoneViewer {
  staffId: string;
  /** Sees everyone's milestones (milestones.view with access to every shop). */
  brand: boolean;
  /** Shops where they see everyone's milestones (milestones.view there). */
  viewShops: readonly string[];
  /** The shops they work at, for the team feed. */
  workShops: readonly string[];
}

export interface MilestoneSubject {
  staffId: string;
  workShops: readonly string[];
  /** They let their milestones show in the team feed. */
  shared: boolean;
}

const overlaps = (a: readonly string[], b: readonly string[]) =>
  a.some((x) => b.includes(x));

/** Their own, everyone's where they may see milestones, and with the team feed on, shared teammates' at the same shops. */
export function seesMilestonesOf(
  v: MilestoneViewer,
  s: MilestoneSubject,
  teamFeed: boolean,
): "own" | "manage" | "team" | null {
  if (v.staffId === s.staffId) return "own";
  if (v.brand || overlaps(v.viewShops, s.workShops)) return "manage";
  if (teamFeed && s.shared && overlaps(v.workShops, s.workShops)) return "team";
  return null;
}
