/**
 * Franchising. The hierarchy is Brand (the franchisor) > owner group (Rayz corporate or a
 * franchisee: a legal business) > region or market (optional) > location. Pure: owner groups and
 * regions, effective-dated royalty and ad fund terms, how a card charge's Stripe application fee
 * splits into processing, royalty and ad fund, the royalty statement, and the brand's client-data
 * settings for franchise agreements.
 */
import { z } from "zod";
import type { FeeCollection, OwnerEntityKind, OwnerEntityStatus } from "@/db/schema";

export type { FeeCollection, OwnerEntityKind, OwnerEntityStatus };

export const ENTITY_KIND_LABEL: Record<OwnerEntityKind, string> = { brand: "Rayz corporate", franchisee: "Franchisee" };
export const ENTITY_STATUS_LABEL: Record<OwnerEntityStatus, string> = { onboarding: "Onboarding", active: "Active", exited: "Exited" };
export const ENTITY_STATUSES = ["onboarding", "active", "exited"] as const satisfies readonly OwnerEntityStatus[];

// ───────────────────────────── Owner groups and regions ─────────────────────────────

const PAYROLL_CODE = /^[A-Za-z0-9._-]{1,32}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface EntityInput {
  name: string;
  legalName?: string | null;
  kind: string;
  contactEmail?: string | null;
  payrollCompanyCode?: string | null;
}

export function entityProblem(v: EntityInput): string | null {
  if (v.name.trim().length < 2) return "Give the owner group a name";
  if (v.kind !== "brand" && v.kind !== "franchisee") return "Pick Rayz corporate or franchisee";
  if (v.contactEmail && !EMAIL.test(v.contactEmail)) return "That email doesn't look right";
  if (v.payrollCompanyCode && !PAYROLL_CODE.test(v.payrollCompanyCode)) return "The payroll company code is letters, numbers, dots, dashes or underscores (32 at most)";
  return null;
}

/**
 * Sales tax filing per state for an owner group's shops: who files and how often. Rates stay on the
 * shop (tax_rate); tax IDs stay with Stripe and the state, never here.
 */
export const EntityTaxSettingsSchema = z.object({
  /** Who files sales tax for the group's shops: the owner group itself, or the brand on its behalf. */
  filer: z.enum(["entity", "brand"]).default("entity"),
  /** Filing frequency by state, e.g. { IL: "monthly", IA: "quarterly" }. */
  frequency: z.record(z.string().regex(/^[A-Z]{2}$/), z.enum(["monthly", "quarterly", "annual"])).default({}),
});
export type EntityTaxSettings = z.output<typeof EntityTaxSettingsSchema>;

export function entityTaxSettings(raw: unknown): EntityTaxSettings {
  const r = EntityTaxSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : EntityTaxSettingsSchema.parse({});
}

export function regionProblem(v: { name: string }): string | null {
  return v.name.trim().length < 2 ? "Give the region a name" : null;
}

/** A shop can be in a brand market, or in its own owner group's region; never in another owner's region. */
export function regionFitProblem(region: { ownerEntityId: string | null } | null, shopOwnerId: string | null): string | null {
  if (!region || !region.ownerEntityId) return null;
  return region.ownerEntityId === shopOwnerId ? null : "That region belongs to another owner group";
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "region";

// ───────────────────────────── Royalty and ad fund terms ─────────────────────────────

/** 30% is the most either rate can be; the database checks it too. */
export const MAX_FEE_BPS = 3000;

export interface FeeTerms {
  effectiveFrom: string;
  royaltyBps: number;
  adFundBps: number;
  collect: FeeCollection;
}

export const FEE_COLLECTION_LABEL: Record<FeeCollection, string> = {
  application_fee: "Taken from each card charge (Stripe application fee)",
  invoice: "Invoiced from the royalty statement",
};

export const bpsLabel = (bps: number) => `${+(bps / 100).toFixed(2)}%`;

/** "6.5" (percent) → 650 basis points. Null for anything that isn't a percent in range. */
export function parsePercentBps(s: string | number | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(String(s).replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0 || n * 100 > MAX_FEE_BPS) return null;
  return Math.round(n * 100);
}

export function feeTermsProblem(t: FeeTerms): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.effectiveFrom)) return "Pick the date the rates start";
  for (const [label, v] of [
    ["royalty", t.royaltyBps],
    ["ad fund", t.adFundBps],
  ] as const)
    if (!Number.isInteger(v) || v < 0 || v > MAX_FEE_BPS) return `The ${label} rate must be between 0% and ${bpsLabel(MAX_FEE_BPS)}`;
  if (t.collect !== "application_fee" && t.collect !== "invoice") return "Pick how the royalty is collected";
  return null;
}

/** The terms in force on a business date: the latest that started on or before it. */
export function termsOn<T extends Pick<FeeTerms, "effectiveFrom">>(terms: readonly T[], day: string): T | null {
  let best: T | null = null;
  for (const t of terms) if (t.effectiveFrom <= day && (!best || t.effectiveFrom > best.effectiveFrom)) best = t;
  return best;
}

/**
 * What a sale owes on its royalty base: services and products after discounts, before tax, tips,
 * card fees and gift card sales (a gift card owes when it's spent on a service or product).
 */
export function royaltyDue(baseCents: number, t: Pick<FeeTerms, "royaltyBps" | "adFundBps"> | null): { royaltyCents: number; adFundCents: number } {
  if (!t || baseCents === 0) return { royaltyCents: 0, adFundCents: 0 };
  return { royaltyCents: Math.round((baseCents * t.royaltyBps) / 10_000), adFundCents: Math.round((baseCents * t.adFundBps) / 10_000) };
}

/**
 * One card charge's share of the sale's royalty base, in proportion to the charge's amount. Earlier
 * legs of a split payment have taken `allocatedCents` of it; the last leg gets what's left, so the
 * legs add up to the base exactly.
 */
export function legBase(o: { baseCents: number; saleTotalCents: number; legCents: number; paidBeforeCents: number; allocatedCents: number }): number {
  if (o.baseCents <= 0 || o.legCents <= 0 || o.saleTotalCents <= 0) return 0;
  const left = Math.max(0, o.baseCents - o.allocatedCents);
  if (o.paidBeforeCents + o.legCents >= o.saleTotalCents) return left;
  return Math.min(left, Math.round((o.baseCents * o.legCents) / o.saleTotalCents));
}

/**
 * The application fee on a charge to an owner group's account: processing first, then the royalty,
 * then the ad fund, never more than the charge. What doesn't fit stays due on the royalty statement.
 */
export function applicationFee(o: { chargeCents: number; processingCents: number; royaltyCents: number; adFundCents: number }) {
  let room = Math.max(0, o.chargeCents);
  const take = (c: number) => {
    const t = Math.max(0, Math.min(room, c));
    room -= t;
    return t;
  };
  const processingCents = take(o.processingCents);
  const royaltyCents = take(o.royaltyCents);
  const adFundCents = take(o.adFundCents);
  return { applicationFeeCents: processingCents + royaltyCents + adFundCents, processingCents, royaltyCents, adFundCents };
}

// ───────────────────────────── Royalty statement ─────────────────────────────

/** One owner group's day: royalty-eligible sales and refunds, and what card charges already collected. */
export interface RoyaltyDay {
  day: string;
  grossSalesCents: number;
  baseCents: number;
  refundBaseCents: number;
  collectedRoyaltyCents: number;
  collectedAdFundCents: number;
}

export interface RoyaltyStatement {
  grossSalesCents: number;
  baseCents: number;
  refundBaseCents: number;
  netBaseCents: number;
  royaltyDueCents: number;
  adFundDueCents: number;
  collectedRoyaltyCents: number;
  collectedAdFundCents: number;
  /** Still owed to the brand; negative is a credit (refunds after the fee was collected). */
  royaltyBalanceCents: number;
  adFundBalanceCents: number;
  /** The rates in force over the days, for the statement's header. */
  rates: { effectiveFrom: string; royaltyBps: number; adFundBps: number; collect: FeeCollection }[];
}

/**
 * Due is each day's net base at the rates in force that day; collected is what application fees
 * took. Refunds lower what's due on their own day, and Stripe keeps application fees on refunds,
 * so a refund after collection leaves a credit for the next statement.
 */
export function royaltyStatement(days: readonly RoyaltyDay[], terms: readonly FeeTerms[]): RoyaltyStatement {
  const s: RoyaltyStatement = {
    grossSalesCents: 0,
    baseCents: 0,
    refundBaseCents: 0,
    netBaseCents: 0,
    royaltyDueCents: 0,
    adFundDueCents: 0,
    collectedRoyaltyCents: 0,
    collectedAdFundCents: 0,
    royaltyBalanceCents: 0,
    adFundBalanceCents: 0,
    rates: [],
  };
  const used = new Map<string, FeeTerms>();
  for (const d of days) {
    const t = termsOn(terms, d.day);
    if (t) used.set(t.effectiveFrom, t);
    const net = d.baseCents - d.refundBaseCents;
    const due = royaltyDue(net, t);
    s.grossSalesCents += d.grossSalesCents;
    s.baseCents += d.baseCents;
    s.refundBaseCents += d.refundBaseCents;
    s.netBaseCents += net;
    s.royaltyDueCents += due.royaltyCents;
    s.adFundDueCents += due.adFundCents;
    s.collectedRoyaltyCents += d.collectedRoyaltyCents;
    s.collectedAdFundCents += d.collectedAdFundCents;
  }
  s.royaltyBalanceCents = s.royaltyDueCents - s.collectedRoyaltyCents;
  s.adFundBalanceCents = s.adFundDueCents - s.collectedAdFundCents;
  s.rates = [...used.values()].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return s;
}

/** Statement periods: calendar months or quarters, from the first day of the range. */
export type RoyaltyPeriod = "month" | "quarter";
export function periodOf(day: string, p: RoyaltyPeriod): string {
  const [y, m] = day.split("-").map(Number);
  if (p === "month") return `${y}-${String(m).padStart(2, "0")}`;
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// ───────────────────────────── Client data for franchise agreements ─────────────────────────────

/**
 * How client data is shared with franchisees. Every client profile is one brand-wide record that
 * the brand holds; these settings only decide what franchisees may do with it. The defaults are
 * the most protective for the brand. Which of them a franchise agreement calls for is for the
 * brand's franchise attorney to decide (see "Client data and franchise agreements" in the README).
 */
export const FranchiseDataSchema = z.object({
  /**
   * Who owns client data under the franchise agreement, for the record and the exit rules:
   * brand: the brand owns every client; shared: the brand owns it and licenses each franchisee to
   * use its own locations' clients while the agreement runs; franchisee: the franchisee owns the
   * clients its locations created (the brand keeps a copy for the system).
   */
  clientOwnership: z.enum(["brand", "shared", "franchisee"]).default("brand"),
  /** What franchisee staff see of a client's visits to other owners' locations: all of it, or only their own owner group's. */
  crossOwnerHistory: z.enum(["full", "own_owner_only"]).default("full"),
  /** Contact exports for franchisee people: never, or only with a contact access grant the brand gives. */
  franchiseeExport: z.enum(["never", "brand_grant"]).default("never"),
  /** When a franchisee leaves the system: the brand keeps every client, or hands a list of its own locations' clients over. */
  onExit: z.enum(["brand_keeps", "export_own_clients"]).default("brand_keeps"),
  /** The agreement and section these settings follow, e.g. "FA 2026 §14.3", for whoever reads the audit log. */
  agreementRef: z.string().trim().max(120).nullable().default(null),
});
export type FranchiseData = z.output<typeof FranchiseDataSchema>;

export const FRANCHISE_DATA_LABEL = {
  clientOwnership: { brand: "The brand owns every client", shared: "The brand owns them; franchisees may use their locations' clients", franchisee: "Franchisees own their locations' clients" },
  crossOwnerHistory: { full: "Franchisee staff see a client's visits at every location", own_owner_only: "Franchisee staff see visits at their own owner group's locations only" },
  franchiseeExport: { never: "Franchisee people can't export client contacts", brand_grant: "Only with a contact access grant from the brand" },
  onExit: { brand_keeps: "The brand keeps every client", export_own_clients: "The franchisee gets a list of its own locations' clients" },
} as const;

export function franchiseData(raw: unknown): FranchiseData {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = FranchiseDataSchema.parse({});
  for (const k of Object.keys(out) as (keyof FranchiseData)[]) {
    const r = FranchiseDataSchema.shape[k].safeParse(o[k]);
    if (r.success) (out as Record<string, unknown>)[k] = r.data;
  }
  return out;
}

/** A person is a franchisee's when everything they reach belongs to franchisee owner groups. */
export const isFranchiseePerson = (ownerKinds: readonly (OwnerEntityKind | null)[]) => ownerKinds.length > 0 && ownerKinds.every((k) => k === "franchisee");
