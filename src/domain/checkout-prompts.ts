/**
 * Checkout prompts, shown on the ticket before or while it's paid.
 *
 * - rebook: the client's next visit with the same barber, at their usual interval (or the main
 *   service's, or the brand's), as 2-3 times to book in one tap; a family on one ticket is booked
 *   together. A "no" can carry a reason and a reminder to book.
 * - product: what the barber used in the service, the brand's products for the services on the
 *   ticket, and what the client bought before (what they're likely running out of first), with
 *   stock, to add in one tap. Their last purchases show with it, each to buy again in one tap.
 *
 * The brand sets each prompt on or off and skippable or required to answer; a location, a role (of
 * whoever is signed in at checkout) or a barber (the ticket's) can turn it on or off, most specific
 * first. Pure, so the server and the tests share it.
 */
import { z } from "zod";
import { type LocalDate, addDays, diffDays } from "@/lib/time";
import type { RefillStatus } from "./product-history";

export const PROMPT_KINDS = ["rebook", "product"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];
export const isPromptKind = (k: string): k is PromptKind => (PROMPT_KINDS as readonly string[]).includes(k);

export const PROMPT_LABEL: Record<PromptKind, string> = { rebook: "Rebook", product: "Products" };

/** skippable: staff may pay without answering (counted as declined). acknowledge: book it or say no first. */
export const PROMPT_MODES = ["skippable", "acknowledge"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];
export const PROMPT_MODE_LABEL: Record<PromptMode, string> = { skippable: "Skippable", acknowledge: "Required to answer" };

export const REBOOK_DAYS = { min: 7, max: 182 } as const;
/** How far either side of the target date the rebook prompt looks for times. */
export const REBOOK_SPREAD_DAYS = 7;
export const REASON_MAX = 120;
export const DEFAULT_REASONS = ["Will book online", "Not sure of their schedule", "Traveling", "Price", "Other"];
/** When a rebook reminder goes out, shop time. */
export const REMINDER_HOUR = 10;

const reason = z.string().trim().min(1).max(REASON_MAX, `Keep each reason under ${REASON_MAX} characters`);

export const RebookSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(PROMPT_MODES).default("skippable"),
  /** Times offered. */
  options: z.number().int().min(2, "2 or 3 times").max(3, "2 or 3 times").default(3),
  /** The interval for a client with no visit history and a service with none of its own. */
  defaultDays: z.number().int().min(REBOOK_DAYS.min, `${REBOOK_DAYS.min} to ${REBOOK_DAYS.max} days`).max(REBOOK_DAYS.max, `${REBOOK_DAYS.min} to ${REBOOK_DAYS.max} days`).default(28),
  /** Staff may set a reminder to book when the client says no. */
  reminders: z.boolean().default(true),
  /** The reminder goes this many days before the date they'd be due. */
  reminderLeadDays: z.number().int().min(0, "0 to 14 days").max(14, "0 to 14 days").default(3),
  reasons: z.array(reason).max(12, "Up to 12 reasons").default(DEFAULT_REASONS),
});

export const ProductSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(PROMPT_MODES).default("skippable"),
  /** Products shown. */
  max: z.number().int().min(1, "1 to 8 products").max(8, "1 to 8 products").default(4),
  /** Include what the client bought before. */
  pastPurchases: z.boolean().default(true),
});

export const CheckoutPromptSettingsSchema = z.object({ rebook: RebookSettingsSchema, product: ProductSettingsSchema });
export type RebookSettings = z.output<typeof RebookSettingsSchema>;
export type ProductSettings = z.output<typeof ProductSettingsSchema>;
export type CheckoutPromptSettings = z.output<typeof CheckoutPromptSettingsSchema>;

export const PROMPT_DEFAULTS: CheckoutPromptSettings = { rebook: RebookSettingsSchema.parse({}), product: ProductSettingsSchema.parse({}) };

/** Stored settings read defensively: a field that doesn't parse falls back to its default, the others stay. */
export function promptSettings(raw: unknown): CheckoutPromptSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const part = <S extends z.ZodObject>(schema: S, value: unknown, fallback: z.output<S>): z.output<S> => {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const out: Record<string, unknown> = { ...fallback };
    for (const k of Object.keys(schema.shape)) {
      const r = (schema.shape[k] as z.ZodType).safeParse(v[k]);
      if (r.success && v[k] !== undefined) out[k] = r.data;
    }
    return out as z.output<S>;
  };
  const rebook = part(RebookSettingsSchema, o.rebook, PROMPT_DEFAULTS.rebook);
  return { rebook: { ...rebook, reasons: [...new Set(rebook.reasons)] }, product: part(ProductSettingsSchema, o.product, PROMPT_DEFAULTS.product) };
}

// ───────────────────────────── Who sees it ─────────────────────────────

export type RuleTarget = "location" | "role" | "barber";
export const RULE_TARGET_LABEL: Record<RuleTarget, string> = { location: "Location", role: "Role", barber: "Barber" };

export interface PromptRule {
  prompt: PromptKind;
  shopId: string | null;
  roleId: string | null;
  staffId: string | null;
  enabled: boolean;
}
export const ruleTarget = (r: Pick<PromptRule, "shopId" | "roleId" | "staffId">): RuleTarget => (r.staffId ? "barber" : r.roleId ? "role" : "location");

export interface PromptAudience {
  shopId: string;
  /** The role of whoever is signed in at checkout. */
  roleId: string | null;
  /** The ticket's barber. */
  barberId: string | null;
}

/** Whether a prompt shows here: the barber's rule, then the role's, then the location's, then the brand. */
export function resolvePrompt(prompt: PromptKind, brandEnabled: boolean, rules: readonly PromptRule[], who: PromptAudience): { enabled: boolean; source: "brand" | RuleTarget } {
  const mine = rules.filter((r) => r.prompt === prompt);
  const barber = who.barberId ? mine.find((r) => r.staffId === who.barberId) : undefined;
  if (barber) return { enabled: barber.enabled, source: "barber" };
  const role = who.roleId ? mine.find((r) => r.roleId === who.roleId) : undefined;
  if (role) return { enabled: role.enabled, source: "role" };
  const shop = mine.find((r) => r.shopId === who.shopId);
  if (shop) return { enabled: shop.enabled, source: "location" };
  return { enabled: brandEnabled, source: "brand" };
}

// ───────────────────────────── Rebook ─────────────────────────────

export type IntervalSource = "client" | "service" | "brand";
export const INTERVAL_SOURCE_LABEL: Record<IntervalSource, string> = { client: "their usual interval", service: "the service's interval", brand: "the brand's default" };

const clampDays = (d: number) => Math.min(REBOOK_DAYS.max, Math.max(REBOOK_DAYS.min, Math.round(d)));

/** The client's own cadence when they have one, else the main service's interval, else the brand's. */
export function rebookInterval(o: { cadenceDays: number | null | undefined; serviceDays: number | null | undefined; defaultDays: number }): { days: number; source: IntervalSource } {
  if (o.cadenceDays != null && Number.isFinite(o.cadenceDays) && o.cadenceDays > 0) return { days: clampDays(o.cadenceDays), source: "client" };
  if (o.serviceDays != null && o.serviceDays > 0) return { days: clampDays(o.serviceDays), source: "service" };
  return { days: clampDays(o.defaultDays), source: "brand" };
}

/** Days to look for times on, nearest the target first (later before earlier on a tie), never before `earliest`. */
export function candidateDays(target: LocalDate, earliest: LocalDate, spread = REBOOK_SPREAD_DAYS): LocalDate[] {
  const from = diffDays(target, earliest) < 0 ? earliest : target;
  const out: LocalDate[] = [from];
  for (let i = 1; i <= spread; i++) {
    out.push(addDays(from, i));
    const before = addDays(from, -i);
    if (before >= earliest) out.push(before);
  }
  return out;
}

export interface DayChoices<T> {
  date: LocalDate;
  /** Each time on offer that day, with its start's minutes after midnight (shop time). */
  options: (T & { minute: number })[];
}

/**
 * Up to n times: on each day in the order given, the one nearest the time of day they came in at,
 * one per day; then, if the days ran out, the next nearest on those days. Sorted by date.
 */
export function pickTimes<T>(days: readonly DayChoices<T>[], preferMinute: number, n: number): (T & { minute: number; date: LocalDate })[] {
  const ranked = days.map((d) => ({ date: d.date, list: [...d.options].sort((a, b) => Math.abs(a.minute - preferMinute) - Math.abs(b.minute - preferMinute) || a.minute - b.minute) }));
  const out: (T & { minute: number; date: LocalDate })[] = [];
  for (let round = 0; out.length < n; round++) {
    let any = false;
    for (const d of ranked) {
      if (out.length >= n) break;
      const o = d.list[round];
      if (!o) continue;
      any = true;
      out.push({ ...o, date: d.date });
    }
    if (!any) break;
  }
  return out.sort((a, b) => (a.date === b.date ? a.minute - b.minute : a.date < b.date ? -1 : 1));
}

/** The reminder goes at 10 AM shop time, leadDays before they'd be due, and never sooner than tomorrow. */
export function reminderDay(target: LocalDate, leadDays: number, today: LocalDate): LocalDate {
  const d = addDays(target, -leadDays);
  const tomorrow = addDays(today, 1);
  return d < tomorrow ? tomorrow : d;
}

export interface RebookSeat {
  customerId: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
}
export interface RebookOption {
  date: LocalDate;
  startsAt: string;
  endsAt: string;
  /** One seat per person; a family's plan from src/domain/booking-group.ts. */
  seats: RebookSeat[];
  plan?: string;
}
export interface RebookPerson {
  customerId: string;
  name: string;
  isChild: boolean;
  appointmentId: string | null;
  staffId: string;
  staffName: string;
  serviceId: string;
  addonIds: string[];
  serviceName: string;
}
export interface RebookSuggested {
  kind: "rebook";
  intervalDays: number;
  intervalSource: IntervalSource;
  visitDate: LocalDate;
  targetDate: LocalDate;
  people: RebookPerson[];
  options: RebookOption[];
  /** Why there are no times, when there are none. */
  reason: string | null;
  estimateCents: number;
}

// ───────────────────────────── Products ─────────────────────────────

export const PRODUCT_SOURCES = ["used", "service", "past"] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];
export const PRODUCT_SOURCE_LABEL: Record<ProductSource, string> = { used: "Used today", service: "Goes with the service", past: "Bought before" };

export interface ProductPick {
  productId: string;
  sources: ProductSource[];
}

/**
 * What to suggest, best first: what the barber used, then the brand's products for the services
 * (in their order), then past purchases (likely running out first, then ran out, then most often
 * bought, then most recent). Each product once, with every reason it's there; products the shop
 * doesn't carry are left out.
 */
export function rankProducts(o: {
  used: readonly string[];
  mapped: readonly { productId: string; sortOrder: number }[];
  past: readonly { productId: string; times: number; lastAt: Date | string; refill?: RefillStatus | null }[];
  carried: ReadonlySet<string>;
  max: number;
}): ProductPick[] {
  const due = (r: RefillStatus | null | undefined) => (r === "running_out" ? 0 : r === "ran_out" ? 1 : 2);
  const out = new Map<string, ProductPick>();
  const put = (id: string, s: ProductSource) => {
    if (!o.carried.has(id)) return;
    const p = out.get(id);
    if (p) {
      if (!p.sources.includes(s)) p.sources.push(s);
    } else out.set(id, { productId: id, sources: [s] });
  };
  for (const id of o.used) put(id, "used");
  for (const m of [...o.mapped].sort((a, b) => a.sortOrder - b.sortOrder)) put(m.productId, "service");
  for (const p of [...o.past].sort((a, b) => due(a.refill) - due(b.refill) || b.times - a.times || new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())) put(p.productId, "past");
  return [...out.values()].slice(0, o.max);
}

export type StockStatus = "in_stock" | "low" | "out";
export const STOCK_LABEL: Record<StockStatus, string> = { in_stock: "In stock", low: "Low stock", out: "Out of stock" };
export function stockStatus(available: number, lowAt: number): StockStatus {
  if (available <= 0) return "out";
  return available <= lowAt ? "low" : "in_stock";
}

export interface ProductSuggestion extends ProductPick {
  name: string;
  brand: string;
  priceCents: number;
  available: number;
  stock: StockStatus;
  /** For a product the client buys: whether they're likely running out, and when it's due. */
  refill?: { status: RefillStatus; due: LocalDate } | null;
}
export interface ProductSuggested {
  kind: "product";
  products: ProductSuggestion[];
}

// ───────────────────────────── Answers and the report ─────────────────────────────

export type PromptOutcome = "accepted" | "declined";

/** A required prompt still waiting for an answer. A rebook counts as answered once the client has a next visit, however it was booked. */
export function unansweredRequired(prompts: readonly { prompt: PromptKind; required: boolean; outcome: PromptOutcome | null }[], o: { booked: boolean }): PromptKind[] {
  const waiting = new Set(prompts.filter((p) => p.required && !p.outcome && !(p.prompt === "rebook" && o.booked)).map((p) => p.prompt));
  return PROMPT_KINDS.filter((k) => waiting.has(k));
}

export function requiredMessage(kinds: readonly PromptKind[]): string {
  const what = kinds.map((k) => (k === "rebook" ? "the rebook prompt" : "the product suggestions")).join(" and ");
  return `Answer ${what} before taking payment.`;
}

export const reasonProblem = (r: string | null | undefined, list: readonly string[]): string | null => {
  if (!r) return null;
  if (r.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters`;
  return list.includes(r) ? null : "Pick one of the reasons";
};

export const rate = (n: number, d: number) => (d ? n / d : null);
