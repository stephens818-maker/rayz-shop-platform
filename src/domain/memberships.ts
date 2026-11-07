import { DateTime } from "luxon";
import { z } from "zod";
import type { CartLine, Discount } from "./checkout";

export const PlanInput = z.object({
  name: z.string().trim().min(1, "Name the plan").max(60),
  description: z.string().trim().max(300).optional().default(""),
  priceCents: z.number().int().min(100, "Plans are at least $1 a month").max(100_000, "Plans are at most $1,000 a month"),
  serviceIds: z.array(z.uuid()).max(30).default([]),
  visitsPerPeriod: z.number().int().min(1).max(31).nullable().default(null),
  productDiscountPct: z.number().int().min(0).max(50).default(0),
  shopIds: z.array(z.uuid()).max(200).default([]),
  active: z.boolean().default(true),
});
export type PlanInput = z.infer<typeof PlanInput>;

export function planProblem(p: PlanInput): string | null {
  if (!p.serviceIds.length && !p.productDiscountPct) return "A plan needs services it covers or a retail discount";
  return null;
}

/** One billing month: the same day next month, or the month's last day when it's shorter. */
export function periodEnd(start: string): string {
  return DateTime.fromISO(start, { zone: "utc" }).plus({ months: 1 }).toISODate()!;
}

export const visitsLeft = (perPeriod: number | null, used: number) => (perPeriod == null ? null : Math.max(0, perPeriod - used));

export function planSummary(p: { priceCents: number; visitsPerPeriod: number | null; productDiscountPct: number }, services: string[]) {
  const parts = [];
  if (services.length) parts.push(`${p.visitsPerPeriod == null ? "Unlimited" : `${p.visitsPerPeriod} a month:`} ${services.join(", ")}`);
  if (p.productDiscountPct) parts.push(`${p.productDiscountPct}% off retail`);
  return parts.join(" · ");
}

/** What a member's plan can cover on today's ticket, as checkout shows it. */
export interface MemberCoverage {
  membershipId: string;
  customerId: string;
  memberName: string;
  planName: string;
  serviceIds: string[];
  /** Null is unlimited. */
  visitsLeft: number | null;
  productDiscountPct: number;
  periodStart: string;
}

/**
 * The membership's discounts on a ticket: the member's own covered services in full, most expensive
 * first, up to the visits left this month, and the retail discount on the ticket's products.
 */
export function membershipDiscounts(c: MemberCoverage, lines: (CartLine & { forCustomerId: string | null })[]): { discounts: Discount[]; visits: number } {
  const discounts: Discount[] = [];
  const units = lines
    .filter((l) => l.kind === "service" && !!l.refId && c.serviceIds.includes(l.refId) && l.forCustomerId === c.customerId)
    .flatMap((l) => Array.from({ length: l.qty }, () => ({ key: l.key, cents: Math.max(0, l.unitPriceCents) })))
    .sort((a, b) => b.cents - a.cents);
  const covered = c.visitsLeft == null ? units : units.slice(0, c.visitsLeft);
  const cents = covered.reduce((a, u) => a + u.cents, 0);
  if (covered.length && cents > 0)
    discounts.push({
      source: "membership",
      label: `${c.planName} (${covered.length} visit${covered.length === 1 ? "" : "s"})`,
      type: "amount",
      value: cents,
      appliesTo: "services",
      lineKeys: [...new Set(covered.map((u) => u.key))],
      refId: c.membershipId,
    });
  if (c.productDiscountPct > 0 && lines.some((l) => l.kind === "product"))
    discounts.push({ source: "membership", label: `${c.planName}: ${c.productDiscountPct}% off retail`, type: "percent", value: c.productDiscountPct, appliesTo: "products", refId: c.membershipId });
  return { discounts, visits: covered.length };
}

export const MEMBERSHIP_STATUS_LABEL = { incomplete: "Waiting for first payment", active: "Active", past_due: "Payment failed", canceled: "Canceled" } as const;

/** Monthly recurring revenue from members who are paying or about to be billed again. */
export const monthlyRecurring = (rows: readonly { status: string; priceCents: number; cancelAtPeriodEnd: boolean }[]) =>
  rows.filter((r) => (r.status === "active" || r.status === "past_due") && !r.cancelAtPeriodEnd).reduce((a, r) => a + r.priceCents, 0);
