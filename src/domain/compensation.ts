/**
 * Compensation fields: each employee's effective-dated pay plan, the brand's own employee fields, and
 * the commission math the Commission Payout report, payroll (when the brand says so) and My pay share.
 * Pure: money is cents unless a name says dollars, rates are fractions (0.45 = 45%), dates are
 * shop-local. Off until the brand turns it on, and with it off nothing else in the app changes.
 * Nothing here holds bank, card, SSN or tax ID data: that stays with Stripe and iSolved.
 */
import { formatCents } from "@/lib/money";
import { findSensitive, isForbiddenKey } from "@/lib/sensitive";
import { addDays, diffDays, isValidLocalDate, type LocalDate } from "@/lib/time";
import { roundHalfUp2 } from "./payroll/calc";
import { TIP_METHODS, type TipMethod } from "./tips";

// ───────────────────────────── Settings ─────────────────────────────

/** iSolved columns a shop's file can add on request, after the standard ones. */
export const OPTIONAL_EXPORT = ["serviceCommission", "productCommission", "hourlyRate"] as const;
export type OptionalExport = (typeof OPTIONAL_EXPORT)[number];
export const OPTIONAL_EXPORT_LABEL: Record<OptionalExport, string> = {
  serviceCommission: "Service commission $ (the report's Commission$)",
  productCommission: "Product commission $ (the report's Product Total)",
  hourlyRate: "Hourly rate (not a total, so not reconciled)",
};
/** The payroll report column each one copies. */
export const OPTIONAL_EXPORT_FROM = { serviceCommission: "commission", productCommission: "productTotal", hourlyRate: "wage" } as const;

export interface CompensationSettings {
  /** The master switch. Off: no compensation tab, report rows, My pay, or change to payroll, tips or the export. */
  enabled: boolean;
  /** Payroll takes hourly rates, commission % and the guaranteed minimum from each employee's plan; anyone without one keeps Payroll setup's rates. */
  payrollUsesPlans: boolean;
  /** My pay shows people with "See their own pay" an estimate of this period's pay. */
  payEstimate: boolean;
  exportColumns: Record<OptionalExport, { on: boolean; header: string }>;
  /** The guaranteed minimum top-up's iSolved column, added to a shop's file only when someone there has one. */
  guaranteeHeader: string;
}

export const DEFAULT_COMPENSATION_SETTINGS: CompensationSettings = {
  enabled: false,
  payrollUsesPlans: false,
  payEstimate: false,
  exportColumns: {
    serviceCommission: { on: false, header: "E_Service Commission_Dollars" },
    productCommission: { on: false, header: "E_Product Commission_Dollars" },
    hourlyRate: { on: false, header: "R_Regular_Rate" },
  },
  guaranteeHeader: "E_Guaranteed Minimum_Dollars",
};

const header = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : dflt);

export function compensationSettings(raw: unknown): CompensationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof CompensationSettings, unknown>>;
  const d = DEFAULT_COMPENSATION_SETTINGS;
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const cols = (r.exportColumns && typeof r.exportColumns === "object" ? r.exportColumns : {}) as Record<string, { on?: unknown; header?: unknown } | undefined>;
  return {
    enabled: bool(r.enabled, d.enabled),
    payrollUsesPlans: bool(r.payrollUsesPlans, d.payrollUsesPlans),
    payEstimate: bool(r.payEstimate, d.payEstimate),
    exportColumns: Object.fromEntries(OPTIONAL_EXPORT.map((k) => [k, { on: bool(cols[k]?.on, d.exportColumns[k].on), header: header(cols[k]?.header, d.exportColumns[k].header) }])) as CompensationSettings["exportColumns"],
    guaranteeHeader: header(r.guaranteeHeader, d.guaranteeHeader),
  };
}

/** Column headers must differ from each other and from the file's own (passed in: the six standard ones and the tips-in-payroll one). */
export function settingsProblem(s: CompensationSettings, taken: readonly string[]): string | null {
  const heads = [...OPTIONAL_EXPORT.filter((k) => s.exportColumns[k].on).map((k) => s.exportColumns[k].header), s.guaranteeHeader];
  const seen = new Set(taken.map((h) => h.toLowerCase()));
  for (const h of heads) {
    if (seen.has(h.toLowerCase())) return `The export already has a column called "${h}". Pick another header.`;
    seen.add(h.toLowerCase());
  }
  return null;
}

/** The optional columns a shop's file gets, in order, when compensation is on. */
export function exportExtras(s: CompensationSettings): { header: string; from: (typeof OPTIONAL_EXPORT_FROM)[OptionalExport] }[] {
  if (!s.enabled) return [];
  return OPTIONAL_EXPORT.filter((k) => s.exportColumns[k].on).map((k) => ({ header: s.exportColumns[k].header, from: OPTIONAL_EXPORT_FROM[k] }));
}

// ───────────────────────────── Versions ─────────────────────────────

export type TierMode = "step" | "marginal";
export const TIER_MODE_LABEL: Record<TierMode, string> = {
  step: "Whole month at the tier reached",
  marginal: "Sliding: each slice of sales at its own rate",
};
export type RentFrequency = "weekly" | "biweekly" | "monthly";
export const RENT_FREQUENCIES: RentFrequency[] = ["weekly", "biweekly", "monthly"];
export const RENT_LABEL: Record<RentFrequency, string> = { weekly: "a week", biweekly: "every two weeks", monthly: "a month" };
export type GuaranteePer = "pay_period" | "week" | "month" | "year";
export const GUARANTEE_PERS: GuaranteePer[] = ["pay_period", "week", "month", "year"];
export const GUARANTEE_LABEL: Record<GuaranteePer, string> = { pay_period: "a pay period", week: "a week", month: "a month", year: "a year" };

export interface ServiceOverride {
  kind: "service" | "category";
  /** A service id, or a category name. */
  ref: string;
  pct: number;
}
export interface Tier {
  /** Monthly net service sales from which this rate applies. */
  fromCents: number;
  pct: number;
}

export interface CompVersion {
  id?: string;
  effectiveFrom: LocalDate;
  /** Orders two versions from the same day: the later one wins. */
  createdAt: Date | string;
  hourlyRateCents: number | null;
  shopHourlyRates: { shopId: string; cents: number }[];
  servicePct: number | null;
  serviceOverrides: ServiceOverride[];
  serviceTiers: Tier[];
  tierMode: TierMode;
  productPct: number | null;
  boothRentCents: number | null;
  boothRentFrequency: RentFrequency | null;
  guaranteeCents: number | null;
  guaranteePer: GuaranteePer | null;
  tipMethod: TipMethod | null;
  note: string | null;
}

export type VersionInput = Omit<CompVersion, "id" | "createdAt">;

const time = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());

/** Newest first: by start date, then the later save of the same day. */
export const sortVersions = <V extends Pick<CompVersion, "effectiveFrom" | "createdAt">>(vs: readonly V[]): V[] =>
  [...vs].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || time(b.createdAt) - time(a.createdAt));

/** The version in effect on a date, from a list sorted by sortVersions. Null before the first one. */
export const versionOn = <V extends Pick<CompVersion, "effectiveFrom">>(sorted: readonly V[], date: LocalDate): V | null => sorted.find((v) => v.effectiveFrom <= date) ?? null;

export type VersionStatus = "scheduled" | "current" | "past" | "replaced";
export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = { scheduled: "Starts later", current: "In effect", past: "Ended", replaced: "Replaced the same day" };

/** Each version with when it was in effect: until the day before the next start. A version saved again for the same day replaces it. */
export function timeline<V extends Pick<CompVersion, "effectiveFrom" | "createdAt">>(vs: readonly V[], today: LocalDate): (V & { status: VersionStatus; until: LocalDate | null })[] {
  const sorted = sortVersions(vs);
  const winners = sorted.filter((v, i) => i === 0 || sorted[i - 1].effectiveFrom !== v.effectiveFrom);
  const current = versionOn(winners, today);
  return sorted.map((v) => {
    if (!winners.includes(v)) return { ...v, status: "replaced" as const, until: null };
    const next = winners[winners.indexOf(v) - 1];
    const until = next ? addDays(next.effectiveFrom, -1) : null;
    const status: VersionStatus = v.effectiveFrom > today ? "scheduled" : v === current ? "current" : "past";
    return { ...v, status, until };
  });
}

export interface VersionContext {
  today: LocalDate;
  /** The last day of the latest locked pay period, if any. */
  lockedThrough: LocalDate | null;
  shopIds: readonly string[];
  serviceIds: readonly string[];
  categories: readonly string[];
  /** Tip methods the brand allows. */
  tipMethods: readonly TipMethod[];
}

const MAX_HOURLY = 50_000;
const MAX_AMOUNT = 100_000_000;
const isPct = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const isCents = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

export function versionProblem(v: VersionInput, c: VersionContext): string | null {
  if (!isValidLocalDate(v.effectiveFrom)) return "Pick the date this takes effect";
  if (c.lockedThrough && v.effectiveFrom <= c.lockedThrough) return `Pay through ${c.lockedThrough} is approved and locked, so a change can start ${addDays(c.lockedThrough, 1)} at the earliest`;
  if (diffDays(v.effectiveFrom, c.today) > 730) return "A change can be set up to two years ahead";
  if (v.hourlyRateCents !== null && !isCents(v.hourlyRateCents, MAX_HOURLY)) return "The hourly rate must be between $0 and $500";
  const shops = new Set<string>();
  for (const r of v.shopHourlyRates) {
    if (!c.shopIds.includes(r.shopId)) return "A per-location rate is for a shop this person doesn't work at";
    if (shops.has(r.shopId)) return "Each location can have one hourly rate";
    if (!isCents(r.cents, MAX_HOURLY)) return "Hourly rates must be between $0 and $500";
    shops.add(r.shopId);
  }
  if (v.servicePct !== null && !isPct(v.servicePct)) return "Service commission must be between 0% and 100%";
  if (v.productPct !== null && !isPct(v.productPct)) return "Product commission must be between 0% and 100%";
  if (v.serviceOverrides.length > 100) return "Up to 100 service and category rates";
  const refs = new Set<string>();
  const cats = new Set(c.categories.map((x) => x.toLowerCase()));
  for (const o of v.serviceOverrides) {
    if (o.kind === "service" ? !c.serviceIds.includes(o.ref) : !cats.has(o.ref.toLowerCase())) return o.kind === "service" ? "A service rate is for a service that doesn't exist" : `There's no service category "${o.ref}"`;
    const k = `${o.kind}:${o.ref.toLowerCase()}`;
    if (refs.has(k)) return "Each service or category can have one rate";
    if (!isPct(o.pct)) return "Service and category rates must be between 0% and 100%";
    refs.add(k);
  }
  if (v.serviceTiers.length > 10) return "Up to 10 tiers";
  let last = -1;
  for (const t of v.serviceTiers) {
    if (!isCents(t.fromCents, MAX_AMOUNT)) return "Tier thresholds must be amounts of $0 or more";
    if (t.fromCents <= last) return "Each tier must start at a higher monthly sales amount than the one before";
    if (!isPct(t.pct)) return "Tier rates must be between 0% and 100%";
    last = t.fromCents;
  }
  if ((v.boothRentCents === null) !== (v.boothRentFrequency === null)) return "Booth rent needs both an amount and how often it's due";
  if (v.boothRentCents !== null && !isCents(v.boothRentCents, MAX_AMOUNT)) return "Booth rent must be an amount of $0 or more";
  if ((v.guaranteeCents === null) !== (v.guaranteePer === null)) return "The guaranteed minimum needs both an amount and what it's per";
  if (v.guaranteeCents !== null && !isCents(v.guaranteeCents, MAX_AMOUNT)) return "The guaranteed minimum must be an amount of $0 or more";
  if (v.tipMethod !== null && (!TIP_METHODS.includes(v.tipMethod) || !c.tipMethods.includes(v.tipMethod))) return "The brand doesn't allow that tip payout method";
  if (v.note !== null) {
    if (v.note.length > 500) return "Keep the note under 500 characters";
    if (findSensitive(v.note).length) return "Notes can't hold card, bank, SSN or tax ID numbers. Those stay with Stripe and iSolved.";
  }
  return null;
}

// ───────────────────────────── Rates ─────────────────────────────

/** Payroll setup's rates for an employee at a shop (null: their every-shop rates). Hourly in dollars, as payroll keeps it. */
export interface BaseRates {
  hourlyRate: number;
  servicePct: number;
  productPct: number;
}
export type Fallback = (shopId: string | null) => BaseRates;
export const NO_RATES: BaseRates = { hourlyRate: 0, servicePct: 0, productPct: 0 };

/** Dollars an hour at a shop on a version: its rate for that shop, else its rate, else Payroll setup's. */
export function hourlyOn(v: CompVersion | null, shopId: string, fb: Fallback): number {
  const cents = v ? (v.shopHourlyRates.find((r) => r.shopId === shopId)?.cents ?? v.hourlyRateCents) : null;
  return cents === null || cents === undefined ? fb(shopId).hourlyRate : cents / 100;
}

/**
 * One rate for a pay period's hours at a shop: hours-weighted when a change starts mid-period, so
 * hours × rate is what each day's hours earned. With no hours, the rate on the last day.
 */
export function blendedHourly(days: readonly { date: LocalDate; centi: number }[], sorted: readonly CompVersion[], shopId: string, fb: Fallback, end: LocalDate): number {
  const rated = days.filter((d) => d.centi).map((d) => ({ ...d, rate: hourlyOn(versionOn(sorted, d.date), shopId, fb) }));
  if (!rated.length || rated.every((d) => d.rate === rated[0].rate)) return rated[0]?.rate ?? hourlyOn(versionOn(sorted, end), shopId, fb);
  return rated.reduce((a, d) => a + d.centi * d.rate, 0) / rated.reduce((a, d) => a + d.centi, 0);
}

/** Commission on a month's sales to date under a tier table. Below the first tier: the base rate. */
export function tierCommissionCents(tiers: readonly Tier[], mode: TierMode, basePct: number, salesCents: number): number {
  const sorted = [...tiers].sort((a, b) => a.fromCents - b.fromCents);
  const rateAt = (s: number) => sorted.reduce((r, t) => (s >= t.fromCents ? t.pct : r), basePct);
  if (salesCents <= 0 || mode === "step") return salesCents * rateAt(Math.max(0, salesCents));
  let total = 0;
  let from = 0;
  let pct = basePct;
  for (const t of sorted) {
    if (t.fromCents >= salesCents) break;
    total += (t.fromCents - from) * pct;
    from = t.fromCents;
    pct = t.pct;
  }
  return total + (salesCents - from) * pct;
}

/** The average tier rate on a month's sales to date. */
export function tierRate(tiers: readonly Tier[], mode: TierMode, basePct: number, salesCents: number): number {
  if (salesCents > 0) return tierCommissionCents(tiers, mode, basePct, salesCents) / salesCents;
  return tiers.find((t) => t.fromCents === 0)?.pct ?? basePct;
}

/** A sale or refund line, as commission counts it. Refunds are negative and count on the day they were given. */
export interface CommissionLine {
  date: LocalDate;
  /** The original sale's date: a refund takes back commission at the rate the sale earned. */
  saleDate: LocalDate;
  shopId: string;
  kind: "service" | "product";
  refId: string | null;
  category: string | null;
  grossCents: number;
  discountCents: number;
  refundCents: number;
  netCents: number;
}

export type LineRate = { pct: number; source: "override" | "flat" | "product" } | { source: "tier" };

export function lineRate(v: CompVersion | null, l: Pick<CommissionLine, "kind" | "refId" | "category" | "shopId">, fb: Fallback): LineRate {
  if (l.kind === "product") return { pct: v?.productPct ?? fb(l.shopId).productPct, source: "product" };
  if (v) {
    const o =
      v.serviceOverrides.find((x) => x.kind === "service" && l.refId !== null && x.ref === l.refId) ??
      v.serviceOverrides.find((x) => x.kind === "category" && l.category !== null && x.ref.toLowerCase() === l.category.toLowerCase());
    if (o) return { pct: o.pct, source: "override" };
    if (v.serviceTiers.length) return { source: "tier" };
  }
  return { pct: v?.servicePct ?? fb(l.shopId).servicePct, source: "flat" };
}

export interface CommissionTotals {
  serviceGrossCents: number;
  serviceDiscountCents: number;
  serviceRefundCents: number;
  serviceNetCents: number;
  /** Unrounded: round once where it's shown or paid. */
  serviceCommissionCents: number;
  /** Of the service net, what was paid on the tier table. */
  tieredNetCents: number;
  productGrossCents: number;
  productDiscountCents: number;
  productRefundCents: number;
  productNetCents: number;
  productCommissionCents: number;
}

export const zeroTotals = (): CommissionTotals => ({
  serviceGrossCents: 0,
  serviceDiscountCents: 0,
  serviceRefundCents: 0,
  serviceNetCents: 0,
  serviceCommissionCents: 0,
  tieredNetCents: 0,
  productGrossCents: 0,
  productDiscountCents: 0,
  productRefundCents: 0,
  productNetCents: 0,
  productCommissionCents: 0,
});

export const monthStart = (d: LocalDate) => `${d.slice(0, 7)}-01`;
export const monthEnd = (d: LocalDate) => addDays(monthStart(addDays(monthStart(d), 32)), -1);

/** The calendar months [from, to] touches, each clipped to it. */
export function monthsBetween(from: LocalDate, to: LocalDate): { start: LocalDate; end: LocalDate }[] {
  const out: { start: LocalDate; end: LocalDate }[] = [];
  for (let m = monthStart(from); m <= to; m = addDays(monthEnd(m), 1)) out.push({ start: m < from ? from : m, end: monthEnd(m) > to ? to : monthEnd(m) });
  return out;
}

/**
 * One employee's commission for [from, to], per shop. `lines` must reach back to the first of
 * from's month: tiered commission is worked out on the month's sales to date, so a period gets what
 * the month to date earns at its end less what it had earned by the period's start. Earlier periods
 * are never recomputed; reaching a higher tier mid-month (in step mode) lands in the period it
 * happens. Flat, per-service and per-category rates come from the version in effect on each sale's
 * date; the tier table from the version in effect at the end of the stretch being worked out.
 * Every service sale counts toward the month's tier, whatever rate it earns itself.
 */
export function commissionBetween(lines: readonly CommissionLine[], sorted: readonly CompVersion[], fb: Fallback, from: LocalDate, to: LocalDate): Map<string, CommissionTotals> {
  const out = new Map<string, CommissionTotals>();
  const at = (shopId: string) => out.get(shopId) ?? out.set(shopId, zeroTotals()).get(shopId)!;
  const rated = lines.map((l) => ({ l, r: lineRate(versionOn(sorted, l.saleDate), l, fb) }));
  for (const { l, r } of rated) {
    if (l.date < from || l.date > to) continue;
    const t = at(l.shopId);
    if (l.kind === "product") {
      t.productGrossCents += l.grossCents;
      t.productDiscountCents += l.discountCents;
      t.productRefundCents += l.refundCents;
      t.productNetCents += l.netCents;
      if (r.source !== "tier") t.productCommissionCents += l.netCents * r.pct;
    } else {
      t.serviceGrossCents += l.grossCents;
      t.serviceDiscountCents += l.discountCents;
      t.serviceRefundCents += l.refundCents;
      t.serviceNetCents += l.netCents;
      if (r.source === "tier") t.tieredNetCents += l.netCents;
      else t.serviceCommissionCents += l.netCents * r.pct;
    }
  }
  if (from > to) return out;
  for (const m of monthsBetween(from, to)) {
    const first = monthStart(m.start);
    const month = rated.filter(({ l }) => l.kind === "service" && l.date >= first && l.date <= m.end);
    const upTo = (x: LocalDate) => {
      if (x < first) return 0;
      const sales = month.filter(({ l }) => l.date <= x).reduce((a, { l }) => a + l.netCents, 0);
      const tiered = month.filter(({ l, r }) => r.source === "tier" && l.date <= x).reduce((a, { l }) => a + l.netCents, 0);
      if (!tiered) return 0;
      const v = versionOn(sorted, x);
      const base = v?.servicePct ?? fb(null).servicePct;
      return (v?.serviceTiers.length ? tierRate(v.serviceTiers, v.tierMode, base, sales) : base) * tiered;
    };
    const amount = upTo(m.end) - upTo(addDays(m.start, -1));
    if (!amount) continue;
    const share = new Map<string, number>();
    for (const { l, r } of month) if (r.source === "tier" && l.date >= m.start) share.set(l.shopId, (share.get(l.shopId) ?? 0) + l.netCents);
    const weight = [...share.values()].reduce((a, b) => a + b, 0);
    if (weight) {
      for (const [shopId, w] of share) at(shopId).serviceCommissionCents += (amount * w) / weight;
    } else {
      const most = new Map<string, number>();
      for (const { l, r } of month) if (r.source === "tier") most.set(l.shopId, (most.get(l.shopId) ?? 0) + Math.abs(l.netCents));
      const shopId = [...most.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (shopId) at(shopId).serviceCommissionCents += amount;
    }
  }
  return out;
}

export function addTotals(a: CommissionTotals, b: CommissionTotals): CommissionTotals {
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof CommissionTotals] + b[k as keyof CommissionTotals]])) as unknown as CommissionTotals;
}

// ───────────────────────────── Guarantee and booth rent ─────────────────────────────

/** A year of 52 weeks, so a month is 12/52 of a year and two weeks are exactly 1/26. */
const YEAR_DAYS = 364;

/** The guaranteed minimum for a stretch of `days`, in cents (unrounded); "a pay period" is a period of `periodDays`. */
export function guaranteeForDays(g: { cents: number; per: GuaranteePer }, days: number, periodDays: number): number {
  if (g.per === "pay_period") return (g.cents * days) / periodDays;
  if (g.per === "week") return (g.cents * days) / 7;
  if (g.per === "month") return (g.cents * 12 * days) / YEAR_DAYS;
  return (g.cents * days) / YEAR_DAYS;
}

export function boothRentForDays(r: { cents: number; frequency: RentFrequency }, days: number): number {
  if (r.frequency === "weekly") return (r.cents * days) / 7;
  if (r.frequency === "biweekly") return (r.cents * days) / 14;
  return (r.cents * 12 * days) / YEAR_DAYS;
}

/**
 * The top-up that brings each employee with a guaranteed minimum up to it for a pay period, in
 * dollars rounded to the cent, put on their line at the shop where they worked the most hours.
 * What they earned is every shop's wages, commission, overtime and training pay; tips don't count.
 */
export function guaranteeTopUps(lines: readonly { staffId: string; shopId: string; earned: number; hours: number }[], guaranteeOf: (staffId: string) => number | null): Map<string, number> {
  const out = new Map<string, number>();
  const byStaff = new Map<string, typeof lines>();
  for (const l of lines) byStaff.set(l.staffId, [...(byStaff.get(l.staffId) ?? []), l]);
  for (const [staffId, mine] of byStaff) {
    const g = guaranteeOf(staffId);
    if (g === null) continue;
    const short = roundHalfUp2(g - mine.reduce((a, l) => a + l.earned, 0));
    if (!(short > 0)) continue;
    const top = mine.reduce((best, l) => (l.hours > best.hours ? l : best), mine[0]);
    out.set(`${staffId}|${top.shopId}`, short);
  }
  return out;
}

// ───────────────────────────── Custom employee fields ─────────────────────────────

export const FIELD_KINDS = ["text", "number", "percent", "date", "dropdown"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const FIELD_KIND_LABEL: Record<FieldKind, string> = { text: "Text", number: "Number", percent: "Percent", date: "Date", dropdown: "Dropdown" };

/** Same words as the staff_custom_fields_not_sensitive check in core_0058_compensation.sql; keep the two in step. */
export const SENSITIVE_LABEL =
  /(^|[^a-z])(ssn|social security|bank|routing|iban|swift|account (number|no|#)|acct|card number|credit card|debit card|cvv|cvc|tax ?id|tin|itin|ein|fein|driver.?s licen[cs]e|passport|date of birth|dob|birth ?date)([^a-z]|$)/i;
export const sensitiveLabel = (s: string) => isForbiddenKey(s) || SENSITIVE_LABEL.test(s);
const NO_SENSITIVE = "Bank, card, SSN, tax ID and ID document details stay with Stripe and iSolved, so they can't be employee fields.";

export interface FieldDef {
  label: string;
  kind: FieldKind;
  options: string[];
}

export function fieldProblem(f: FieldDef, otherLabels: readonly string[]): string | null {
  const label = f.label.trim();
  if (!label || label.length > 60) return "Give the field a name of up to 60 characters";
  if (sensitiveLabel(label) || findSensitive(label).length) return NO_SENSITIVE;
  if (otherLabels.some((l) => l.trim().toLowerCase() === label.toLowerCase())) return `There's already a field called "${label}"`;
  if (!FIELD_KINDS.includes(f.kind)) return "Pick a field type";
  if (f.kind === "dropdown") {
    const opts = f.options.map((o) => o.trim());
    if (!opts.length || opts.length > 30) return "A dropdown needs 1 to 30 choices";
    if (opts.some((o) => !o || o.length > 40)) return "Each choice needs a name of up to 40 characters";
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return "Each choice can be listed once";
    if (opts.some((o) => sensitiveLabel(o) || findSensitive(o).length)) return NO_SENSITIVE;
  } else if (f.options.length) return "Only dropdowns have choices";
  return null;
}

/** A value as stored (text), or null to clear it. Numbers are plain decimals; percents 0 to 100; dates YYYY-MM-DD. */
export function fieldValue(f: Pick<FieldDef, "kind" | "options">, raw: string): { value: string | null } | { error: string } {
  const v = raw.trim();
  if (!v) return { value: null };
  if (findSensitive(v).length) return { error: "Employee fields can't hold card, bank, SSN or tax ID numbers. Those stay with Stripe and iSolved." };
  switch (f.kind) {
    case "text":
      return v.length > 200 ? { error: "Keep it under 200 characters" } : { value: v };
    case "number":
    case "percent": {
      const n = Number(v.replace(/[,%\s]/g, ""));
      if (!/^-?\d+(\.\d+)?$/.test(v.replace(/[,%\s]/g, "")) || !Number.isFinite(n)) return { error: "Enter a number" };
      if (f.kind === "percent" && (n < 0 || n > 100)) return { error: "Enter a percent from 0 to 100" };
      if (Math.abs(n) > 1e12) return { error: "That number is too large" };
      return { value: String(n) };
    }
    case "date":
      return isValidLocalDate(v) ? { value: v } : { error: "Enter a date" };
    case "dropdown": {
      const o = f.options.find((x) => x.toLowerCase() === v.toLowerCase());
      return o ? { value: o } : { error: "Pick one of the choices" };
    }
  }
}

export function formatFieldValue(f: Pick<FieldDef, "kind">, value: string | null): string {
  if (value === null) return "";
  return f.kind === "percent" ? `${value}%` : value;
}

// ───────────────────────────── Describing a plan ─────────────────────────────

const pctText = (f: number) => `${Math.round(f * 10000) / 100}%`;

/** A version in plain words, one line per part, for the staff tab and My pay. Blank parts say what applies instead. */
export function describePlan(v: CompVersion, names: { shop: (id: string) => string; service: (id: string) => string; tipMethod: (m: TipMethod) => string }): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  out.push({ label: "Hourly", value: v.hourlyRateCents === null ? "Payroll setup's rate" : `${formatCents(v.hourlyRateCents)}/h` });
  for (const r of v.shopHourlyRates) out.push({ label: `Hourly at ${names.shop(r.shopId)}`, value: `${formatCents(r.cents)}/h` });
  out.push({ label: "Service commission", value: v.servicePct === null ? "Payroll setup's %" : pctText(v.servicePct) });
  for (const o of v.serviceOverrides) out.push({ label: o.kind === "service" ? names.service(o.ref) : `${o.ref} (category)`, value: pctText(o.pct) });
  if (v.serviceTiers.length)
    out.push({
      label: `Tiers (${v.tierMode === "step" ? "whole month at the tier reached" : "sliding"})`,
      value: v.serviceTiers.map((t) => `${pctText(t.pct)} from ${formatCents(t.fromCents)}`).join(", "),
    });
  out.push({ label: "Product commission", value: v.productPct === null ? "Payroll setup's %" : pctText(v.productPct) });
  if (v.boothRentCents !== null && v.boothRentFrequency) out.push({ label: "Booth rent", value: `${formatCents(v.boothRentCents)} ${RENT_LABEL[v.boothRentFrequency]}` });
  if (v.guaranteeCents !== null && v.guaranteePer) out.push({ label: "Guaranteed minimum", value: `${formatCents(v.guaranteeCents)} ${GUARANTEE_LABEL[v.guaranteePer]}` });
  if (v.tipMethod) out.push({ label: "Tips paid by", value: names.tipMethod(v.tipMethod) });
  return out;
}
