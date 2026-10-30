/**
 * Coupons and promo codes: who may use one, and what it takes off a ticket. Pure, so the POS
 * preview and the server's checkout price a coupon the same way. A coupon is a promo code with
 * rules; a "unique" coupon is issued as single-use codes, one per client, by a campaign.
 */
import { z } from "zod";
import type { CartLine, Discount, DiscountTarget } from "./checkout";
import { formatCents } from "@/lib/money";
import { formatTimeOfDay } from "@/lib/time-parse";

export const COUPON_TYPES = ["percent", "amount", "free_item"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export const COUPON_TYPE_LABEL: Record<CouponType, string> = { percent: "Percent off", amount: "Dollars off", free_item: "Free add-on or product" };

export const CODE_MODES = ["shared", "unique"] as const;
export type CodeMode = (typeof CODE_MODES)[number];
export const CODE_MODE_LABEL: Record<CodeMode, string> = { shared: "One shared code", unique: "Single-use codes, one per client" };

export type FreeItemKind = "service" | "addon" | "product";

/** What a coupon does on a ticket, sent to the POS so its preview matches checkout. */
export interface CouponRule {
  promoId: string;
  /** The code as entered: the shared code, or the client's single-use code. */
  code: string;
  label: string;
  type: CouponType;
  /** Percent: whole percent. Amount: cents. Free item: unused. */
  value: number;
  appliesTo: DiscountTarget;
  /** Only these services and add-ons, and these products. Both empty: whatever appliesTo allows. */
  serviceIds: string[];
  productIds: string[];
  freeItem: { kind: FreeItemKind; id: string; name: string } | null;
  minSpendCents: number | null;
  stackable: boolean;
  /** Typed in, held from an online booking, or applied because the client has it. */
  via: "code" | "booking" | "auto";
}

const grossOf = (lines: readonly CartLine[]) => lines.filter((l) => l.kind !== "gift_card").reduce((a, l) => a + Math.max(0, Math.round(l.unitPriceCents * l.qty)), 0);

/** The discount a coupon gives on these lines, or why it gives nothing. */
export function couponDiscount(rule: CouponRule, lines: readonly CartLine[]): { discount: Discount | null; problem: string | null } {
  const none = (problem: string) => ({ discount: null, problem });
  const spend = grossOf(lines);
  if (rule.minSpendCents && spend < rule.minSpendCents) return none(`${rule.code} needs a ticket of at least ${formatCents(rule.minSpendCents)} before discounts`);
  const base = { source: "promo" as const, label: rule.label, refId: rule.promoId };
  if (rule.type === "free_item") {
    const f = rule.freeItem;
    if (!f) return none(`${rule.code} has no free item set`);
    const line = lines.find((l) => l.refId === f.id && l.kind === f.kind && l.qty > 0);
    if (!line) return none(`Add ${f.name} to the ticket to use ${rule.code}`);
    return { discount: { ...base, type: "amount", value: Math.max(0, Math.round(line.unitPriceCents)), appliesTo: "all", lineRefIds: [f.id] }, problem: null };
  }
  const targets = [...rule.serviceIds, ...rule.productIds];
  if (targets.length && !lines.some((l) => l.refId && targets.includes(l.refId) && l.kind !== "gift_card")) return none(`${rule.code} is for items that aren't on the ticket`);
  return {
    discount: { ...base, type: rule.type === "percent" ? "percent" : "amount", value: rule.value, appliesTo: rule.appliesTo, lineRefIds: targets.length ? targets : null },
    problem: null,
  };
}

/** Coupons that can't go together on one ticket. */
export function stackProblem(rules: readonly Pick<CouponRule, "code" | "promoId" | "stackable">[], opts: { manualDiscount?: boolean } = {}): string | null {
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.promoId)) return `${r.code}: that coupon is already on the ticket`;
    ids.add(r.promoId);
  }
  const alone = rules.find((r) => !r.stackable);
  if (alone && rules.length > 1) return `${alone.code} can't be combined with other coupons`;
  if (alone && opts.manualDiscount) return `${alone.code} can't be combined with a manual discount`;
  return null;
}

/** The promo row's rules, as they're read for eligibility. */
export interface CouponLimits {
  active: boolean;
  code: string;
  shopId: string | null;
  shopIds: string[];
  startsOn: string | null;
  endsOn: string | null;
  maxRedemptions: number | null;
  redemptions: number;
  maxPerCustomer: number | null;
  firstVisitOnly: boolean;
  codeMode: CodeMode;
  /** 0 Sunday to 6 Saturday; empty is every day. */
  daysOfWeek?: readonly number[];
  /** HH:MM, local; both or neither. */
  timeFrom?: string | null;
  timeTo?: string | null;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const clock = (s: string) => formatTimeOfDay(hm(s));

/** "Tue, Wed", "Weekdays", "Tue, Wed, 10 AM to 2 PM", or null for any time. */
export function couponWhenLabel(p: Pick<CouponLimits, "daysOfWeek" | "timeFrom" | "timeTo">): string | null {
  const days = [...new Set(p.daysOfWeek ?? [])].sort((a, b) => a - b);
  const d = !days.length || days.length === 7 ? null : days.join() === "1,2,3,4,5" ? "Weekdays" : days.join() === "0,6" ? "Weekends" : days.map((x) => DAY_NAMES[x]).join(", ");
  const t = p.timeFrom && p.timeTo ? `${clock(p.timeFrom)} to ${clock(p.timeTo)}` : null;
  return d && t ? `${d}, ${t}` : (d ?? t);
}

export interface CouponCheck {
  today: string;
  /** When it's used, in the location's time zone: the weekday (0 Sunday) and minutes after midnight. Undefined skips the day and time limits (checked again at checkout). */
  weekday?: number;
  minutes?: number;
  shopId: string;
  /** Undefined: not known yet (a client booking online before they're matched); the client's limits are checked at checkout. */
  customerId?: string | null;
  /** Earlier completed visits by this client, anywhere in the brand. */
  priorVisits: number;
  /** This client's redemptions of this coupon that weren't reversed. */
  customerUses: number;
  /** The single-use code that was entered, for unique coupons. */
  issued?: { customerId: string | null; expiresOn: string | null; redeemed: boolean } | null;
}

/** Why this coupon can't be used here and now, or null. */
export function couponProblem(p: CouponLimits, c: CouponCheck): string | null {
  if (!p.active) return "That coupon has been turned off";
  const shops = p.shopIds.length ? p.shopIds : p.shopId ? [p.shopId] : [];
  if (shops.length && !shops.includes(c.shopId)) return "That coupon isn't valid at this location";
  if (p.startsOn && c.today < p.startsOn) return "That coupon isn't active yet";
  if (p.endsOn && c.today > p.endsOn) return "That coupon has expired";
  if (p.maxRedemptions !== null && p.redemptions >= p.maxRedemptions) return "That coupon has been fully redeemed";
  if (c.weekday !== undefined && p.daysOfWeek?.length && !p.daysOfWeek.includes(c.weekday)) return `That coupon only works ${couponWhenLabel({ daysOfWeek: p.daysOfWeek })}`;
  if (c.minutes !== undefined && p.timeFrom && p.timeTo && (c.minutes < hm(p.timeFrom) || c.minutes >= hm(p.timeTo))) return `That coupon only works ${couponWhenLabel({ timeFrom: p.timeFrom, timeTo: p.timeTo })}`;
  if (p.codeMode === "unique") {
    if (!c.issued) return "That coupon only works with the client's own code";
    if (c.issued.redeemed) return "That code has already been used";
    if (c.issued.expiresOn && c.today > c.issued.expiresOn) return "That code has expired";
    if (c.issued.customerId && c.customerId !== undefined && c.issued.customerId !== c.customerId) return c.customerId ? "That code belongs to another client" : "Attach the client this code was sent to";
  }
  if (c.customerId === undefined) return null;
  if ((p.maxPerCustomer !== null || p.firstVisitOnly) && !c.customerId) return "Attach a client to use this coupon";
  if (p.maxPerCustomer !== null && c.customerUses >= p.maxPerCustomer) return p.maxPerCustomer === 1 ? "This client has already used that coupon" : `This client has used that coupon ${c.customerUses} times, the most allowed`;
  if (p.firstVisitOnly && c.priorVisits > 0) return "That coupon is for a client's first visit";
  return null;
}

/** A short description for lists and the booking page: "20% off services", "$10 off", "Free Beard Trim". */
export function couponSummary(r: Pick<CouponRule, "type" | "value" | "appliesTo" | "freeItem" | "minSpendCents"> & { targets?: string[] }): string {
  const on = r.targets?.length ? ` ${r.targets.join(", ")}` : r.appliesTo === "all" ? "" : ` ${r.appliesTo}`;
  const what = r.type === "free_item" ? `Free ${r.freeItem?.name ?? "item"}` : r.type === "percent" ? `${r.value}% off${on}` : `${formatCents(r.value)} off${on}`;
  return r.minSpendCents ? `${what} on ${formatCents(r.minSpendCents)} or more` : what;
}

const CODE = /^[A-Z0-9-]{3,24}$/;
const day = z.union([z.iso.date(), z.literal("")]).nullable().optional();
const count = z.number().int().min(1).max(1_000_000).nullable().optional();

/** The coupon editor's input. Code is required for a shared coupon; unique coupons get a prefix for their codes. */
export const CouponInput = z
  .object({
    code: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .refine((s) => CODE.test(s), "Codes are 3 to 24 letters, numbers or dashes"),
    description: z.string().trim().max(200).nullable().optional(),
    type: z.enum(COUPON_TYPES),
    value: z.number().int().min(0).max(100_000),
    appliesTo: z.enum(["services", "products", "all"]).default("services"),
    serviceIds: z.array(z.uuid()).max(100).default([]),
    productIds: z.array(z.uuid()).max(100).default([]),
    freeItemKind: z.enum(["service", "addon", "product"]).nullable().optional(),
    freeItemId: z.uuid().nullable().optional(),
    shopIds: z.array(z.uuid()).max(200).default([]),
    minSpendCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
    startsOn: day,
    endsOn: day,
    maxRedemptions: count,
    maxPerCustomer: count,
    codeMode: z.enum(CODE_MODES).default("shared"),
    validDays: z.number().int().min(1).max(365).nullable().optional(),
    firstVisitOnly: z.boolean().default(false),
    stackable: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    timeFrom: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 10:00"), z.literal("")]).nullable().optional(),
    timeTo: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:00"), z.literal("")]).nullable().optional(),
  })
  .superRefine((c, ctx) => {
    const bad = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (!!c.timeFrom !== !!c.timeTo) bad("Set both times, or neither", "timeTo");
    if (c.timeFrom && c.timeTo && c.timeTo <= c.timeFrom) bad("The end time is before the start time", "timeTo");
    if (c.type === "percent" && (c.value < 1 || c.value > 100)) bad("Percent off is 1 to 100", "value");
    if (c.type === "amount" && c.value < 1) bad("Enter the dollars off", "value");
    if (c.type === "free_item" && (!c.freeItemId || !c.freeItemKind)) bad("Pick the free add-on or product", "freeItemId");
    if (c.startsOn && c.endsOn && c.endsOn < c.startsOn) bad("The end date is before the start date", "endsOn");
    if (c.codeMode === "unique" && c.autoApply) bad("Single-use codes are applied with the client's code, so they can't also apply automatically", "autoApply");
    if (c.autoApply && !c.maxPerCustomer && !c.firstVisitOnly) bad("Auto-apply needs a limit per client or first visit only, or it would apply to every ticket", "autoApply");
  });
export type CouponInput = z.infer<typeof CouponInput>;

/** A client's single-use code: the coupon's prefix and six characters nobody can guess in a few tries. */
export function uniqueCode(prefix: string, random: (n: number) => string): string {
  return `${prefix.slice(0, 12)}-${random(6)}`;
}

/** Last day a single-use code works: the coupon's end date or validDays after it's sent, whichever is first. */
export function issuedExpiry(sentOn: string, validDays: number | null, endsOn: string | null, addDays: (d: string, n: number) => string): string | null {
  const byDays = validDays ? addDays(sentOn, validDays) : null;
  if (byDays && endsOn) return byDays < endsOn ? byDays : endsOn;
  return byDays ?? endsOn;
}
