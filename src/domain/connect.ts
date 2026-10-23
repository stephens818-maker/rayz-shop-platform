/**
 * Stripe Connect, merchant-of-record model: one Ray'z platform account, and per shop a choice of
 * where its card money settles (PaymentsMode):
 *  - connected: the shop's own connected account. A card charge is a destination charge settled on
 *    behalf of it (on_behalf_of + transfer_data.destination); the platform keeps an application fee
 *    equal to the shop's processing fee, so revenue, tips, surcharges, refunds, fees and payouts all
 *    land in the shop's own account and bank. For a shop run by its own LLC.
 *  - brand: the brand's own (platform) Stripe account, paid out to the brand's bank.
 *  - cash_only: no cards; cash and gift cards only.
 * Pure: the states, the fee schedule, statement descriptors, payout schedules and their labels.
 */
import { z } from "zod";
import { REVIEW_FOLLOW_UP_DEFAULT, ReviewFollowUpSchema, googleReviewLink, reviewFollowUp, storedReviewLink } from "./reviews";
import type { PaymentsMode, PayoutSchedule } from "@/db/schema";

export type { PaymentsMode, PayoutSchedule };

/** The go-live checklist step for payments. */
export const PAYMENTS_STEP_TITLE = "Payments and banking";

export const PAYMENTS_MODES = ["connected", "brand", "cash_only"] as const satisfies readonly PaymentsMode[];

export const PAYMENTS_MODE_LABEL: Record<PaymentsMode, string> = {
  connected: "Its own Stripe account and bank",
  brand: "The brand's Stripe account and bank",
  cash_only: "No cards (cash and gift cards only)",
};

export const PAYMENTS_MODE_SHORT: Record<PaymentsMode, string> = { connected: "Own account", brand: "Brand account", cash_only: "Cash only" };

export const PAYMENTS_MODE_HINT: Record<PaymentsMode, string> = {
  connected: "For a shop that's its own business (an LLC with its own EIN). Stripe collects its legal details, owner and bank account, and pays out to that bank.",
  brand: "Card sales settle in the brand's main Stripe account and are paid out to the brand's bank with every other shop on it. Nothing to onboard.",
  cash_only: "Until cards are set up. The shop can go live without Stripe; switch it to one of the others later.",
};

export interface AccountFlags {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
  deauthorizedAt: Date | string | null;
}

export type AccountState = "not_started" | "onboarding" | "in_review" | "restricted" | "enabled" | "disconnected";

export const ACCOUNT_STATE_LABEL: Record<AccountState, string> = {
  not_started: "Not set up",
  onboarding: "Onboarding not finished",
  in_review: "Stripe is reviewing",
  restricted: "Needs attention",
  enabled: "Taking card payments",
  disconnected: "Disconnected",
};

export function accountState(a: AccountFlags | null | undefined): AccountState {
  if (!a) return "not_started";
  if (a.deauthorizedAt) return "disconnected";
  if (a.chargesEnabled && a.payoutsEnabled && !a.requirementsDue.length) return "enabled";
  if (a.chargesEnabled) return "restricted";
  if (!a.detailsSubmitted) return "onboarding";
  return a.requirementsDue.length || a.disabledReason ? "restricted" : "in_review";
}

/** Card payments need the account's charges capability; payouts can lag behind. */
export const canCharge = (a: AccountFlags | null | undefined) => !!a && !a.deauthorizedAt && a.chargesEnabled;

/** Whether the shop can take cards right now, by its payments mode. The brand account is always ready. */
export function takesCards(mode: PaymentsMode, a: AccountFlags | null | undefined): boolean {
  if (mode === "cash_only") return false;
  if (mode === "brand") return true;
  return canCharge(a);
}

/**
 * The go-live checklist's payments step. Go-live waits for Stripe to enable charges on the shop's
 * own account; payouts can follow. The brand account and cash-only need nothing more.
 */
export function paymentsStep(mode: PaymentsMode, a: AccountFlags | null | undefined): { done: boolean; detail: string } {
  if (mode === "cash_only") return { done: true, detail: "Cash and gift cards only. Choose a Stripe account here to start taking cards." };
  if (mode === "brand") return { done: true, detail: "Cards settle in the brand's Stripe account and are paid out to the brand's bank." };
  const state = accountState(a);
  if (state === "enabled") return { done: true, detail: "Taking cards; payouts go to the shop's bank." };
  if (canCharge(a)) return { done: true, detail: "Taking cards. Stripe needs a few more details before it pays out to the shop's bank." };
  if (state === "not_started") return { done: false, detail: "Create this shop's Stripe account so its card sales, fees and payouts are its own." };
  if (state === "disconnected") return { done: false, detail: "The shop's Stripe account was disconnected. Reconnect it, or choose the brand account or cash only." };
  if (state === "in_review") return { done: false, detail: "Stripe is reviewing the shop's details. Cards start once it enables charges." };
  return { done: false, detail: "Finish Stripe's onboarding so this shop can take cards." };
}

/** Stripe's statement descriptor rules: 5 to 22 Latin characters, at least one letter, none of < > \ ' " *. */
export function statementDescriptorProblem(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.length < 5 || s.length > 22) return "The statement descriptor must be 5 to 22 characters";
  if (!/[A-Za-z]/.test(s)) return "The statement descriptor needs at least one letter";
  if (/[<>\\'"*]/.test(s)) return "The statement descriptor can't contain < > \\ ' \" or *";
  if (!/^[\x20-\x7E]+$/.test(s)) return "Use plain letters, numbers and spaces in the statement descriptor";
  return null;
}

/**
 * On the brand account, a card statement reads "<brand prefix>* <suffix>", 22 characters at most.
 * The shop's descriptor becomes the suffix, without the brand prefix if it starts with it.
 */
export function descriptorSuffix(descriptor: string | null | undefined, prefix: string): string | null {
  if (!descriptor) return null;
  const room = 22 - prefix.length - 2;
  if (room < 1) return null;
  let s = descriptor.trim();
  if (s.toUpperCase().startsWith(prefix.toUpperCase())) s = s.slice(prefix.length).replace(/^[\s*.-]+/, "");
  s = s.slice(0, room).trim();
  return /[A-Za-z0-9]/.test(s) ? s : null;
}

const WEEKDAY = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "Daily, 2 days after the charge", as Stripe reports the schedule. */
export function payoutScheduleLabel(s: PayoutSchedule | null | undefined): string {
  if (!s) return "Not reported by Stripe yet";
  const delay = s.delayDays != null ? `, ${s.delayDays} day${s.delayDays === 1 ? "" : "s"} after the charge` : "";
  if (s.interval === "daily") return `Daily${delay}`;
  if (s.interval === "weekly") return `Weekly${s.weeklyAnchor ? ` on ${WEEKDAY(s.weeklyAnchor)}` : ""}${delay}`;
  if (s.interval === "monthly") return `Monthly${s.monthlyAnchor ? ` on the ${ordinal(s.monthlyAnchor)}` : ""}${delay}`;
  if (s.interval === "manual") return "Manual: payouts are made by hand in Stripe";
  return s.interval;
}

/** The simulator pays out like a new US Stripe account: daily, two days later. */
export const SIMULATED_PAYOUT_SCHEDULE: PayoutSchedule = { interval: "daily", delayDays: 2 };

export const ReceiptBrandingSchema = z.object({
  /** Replaces "Ray'z Barber Shop · <shop>" at the top. */
  headline: z.string().trim().max(60).nullable().default(null),
  /** Replaces the thank-you line at the bottom. */
  footer: z.string().trim().max(200).nullable().default(null),
  showLogo: z.boolean().default(true),
  showAddress: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  /**
   * The location's Google review link, behind the receipt's "Leave a review" button and the follow-up.
   * Takes a g.page/r/… or writereview?placeid=… link or a Place ID; saved as the write-review URL.
   * No link, no button.
   */
  reviewUrl: z
    .string()
    .max(600)
    .nullable()
    .default(null)
    .transform((v, ctx) => {
      const r = googleReviewLink(v);
      if (r.ok) return r.url;
      ctx.addIssue({ code: "custom", message: r.message });
      return z.NEVER;
    }),
  reviewFollowUp: ReviewFollowUpSchema.default({ ...REVIEW_FOLLOW_UP_DEFAULT }),
  /** Receipts are digital. A Print button on the staff receipt only where the shop turns it on. */
  allowPrint: z.boolean().default(false),
});
export type ReceiptBranding = z.output<typeof ReceiptBrandingSchema>;

/** Stored settings, read defensively: a link that isn't Google's or follow-up settings out of range fall back to none and off. */
export function receiptBranding(raw: unknown): ReceiptBranding {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const r = ReceiptBrandingSchema.safeParse({ ...o, reviewUrl: storedReviewLink(o.reviewUrl), reviewFollowUp: reviewFollowUp(o.reviewFollowUp) });
  return r.success ? { ...r.data, headline: r.data.headline || null, footer: r.data.footer || null } : ReceiptBrandingSchema.parse({});
}

export interface PayoutItem {
  type: string;
  amount: number;
  fee: number;
  /** For a payment on a connected account: the platform transfer that funded it. */
  sourceTransfer?: string | null;
}

/**
 * What a payout is made of, from its balance transactions. On a shop's own account a destination
 * charge arrives as a payment already less the application fee, so that fee comes from our records
 * (by transfer) and is added back to show the gross.
 */
export function summarizePayout(items: readonly PayoutItem[], appFeeByTransfer: ReadonlyMap<string, number> = new Map()) {
  let grossCents = 0;
  let feeCents = 0;
  let refundCents = 0;
  let itemCount = 0;
  for (const t of items) {
    if (t.type === "payout") continue;
    itemCount++;
    if (t.type === "charge" || t.type === "payment") {
      const app = (t.sourceTransfer && appFeeByTransfer.get(t.sourceTransfer)) || 0;
      grossCents += t.amount + app;
      feeCents += t.fee + app;
    } else if (t.type === "refund" || t.type === "payment_refund") {
      refundCents += -t.amount;
      feeCents += t.fee;
    } else {
      feeCents += t.fee;
    }
  }
  return { grossCents, feeCents, refundCents, itemCount };
}

export interface FeeRate {
  /** Fraction, e.g. 0.029. */
  rate: number;
  fixedCents: number;
}
export type EntryMode = "keyed" | "terminal";

/** Stripe's standard US card pricing: online and keyed 2.9% + 30¢, in person (Terminal) 2.7% + 5¢. */
export const DEFAULT_PROCESSING_FEES: Record<EntryMode, FeeRate> = { keyed: { rate: 0.029, fixedCents: 30 }, terminal: { rate: 0.027, fixedCents: 5 } };

/** "2.9%+30" → { rate: 0.029, fixedCents: 30 }. Null for anything else. */
export function parseFeeRate(s: string | null | undefined): FeeRate | null {
  const m = s?.replace(/\s|¢/g, "").match(/^(\d+(?:\.\d+)?)%(?:\+(\d+))?$/);
  if (!m) return null;
  const rate = Number((Number(m[1]) / 100).toFixed(6));
  if (!(rate >= 0 && rate < 0.2)) return null;
  return { rate, fixedCents: m[2] ? Number(m[2]) : 0 };
}

/**
 * The application fee on one charge: the shop's processing fee, never more than the charge.
 * Refunds don't give it back, the same as Stripe's own fee on a standard account.
 */
export function processingFeeCents(amountCents: number, fee: FeeRate): number {
  if (amountCents <= 0) return 0;
  return Math.min(amountCents, Math.round(amountCents * fee.rate) + fee.fixedCents);
}

export const formatFeeRate = (f: FeeRate) => `${+(f.rate * 100).toFixed(2)}%${f.fixedCents ? ` + ${f.fixedCents}¢` : ""}`;

/** Readable names for the Stripe requirement fields shown in setup. */
export function requirementLabel(field: string): string {
  const known: Record<string, string> = {
    external_account: "Bank account for payouts",
    "business_profile.url": "Business website",
    "business_profile.mcc": "Business category",
    "business_profile.product_description": "What the business sells",
    tos_acceptance: "Accept Stripe's terms",
    "tos_acceptance.date": "Accept Stripe's terms",
    "tos_acceptance.ip": "Accept Stripe's terms",
    "company.tax_id": "Business tax ID (EIN)",
    "company.name": "Legal business name",
    "company.address": "Business address",
    "company.phone": "Business phone",
    representative: "Account representative",
  };
  if (known[field]) return known[field];
  const tail = field.split(".").pop() ?? field;
  if (/^(person_|individual)/.test(field)) return `Owner details (${tail.replace(/_/g, " ")})`;
  return tail.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const OWNER_KIND_LABEL = { brand: "Brand-owned", franchisee: "Franchisee" } as const;

export function ownerEntityProblem(v: { name: string; kind: string; contactEmail?: string | null }): string | null {
  if (v.name.trim().length < 2) return "Give the owner a name";
  if (v.kind !== "brand" && v.kind !== "franchisee") return "Pick brand-owned or franchisee";
  if (v.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.contactEmail)) return "That email doesn't look right";
  return null;
}
