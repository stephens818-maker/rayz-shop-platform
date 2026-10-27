/**
 * Tip payouts: the brand's policy, each shop's schedule, when a tip is available to pay out, and
 * what a batch pays each employee. Money is integer cents. Pure, so the ledger math is tested
 * without a database (tests/tips.test.ts).
 */
import { addDays, type LocalDate } from "@/lib/time";

export const TIP_SCHEDULES = ["end_of_night", "daily_delay", "weekly", "payroll", "manual"] as const;
export type TipSchedule = (typeof TIP_SCHEDULES)[number];
export const SCHEDULE_LABEL: Record<TipSchedule, string> = {
  end_of_night: "End of night, at cash drawer close",
  daily_delay: "Daily, a few days after the tip so card money settles first",
  weekly: "Weekly",
  payroll: "With payroll only (exported to iSolved, not paid separately)",
  manual: "Manual, when a manager builds a batch",
};

export const TIP_METHODS = ["cash", "stripe", "payroll"] as const;
export type TipMethod = (typeof TIP_METHODS)[number];
export const METHOD_LABEL: Record<TipMethod | "prior", string> = {
  cash: "Cash from the drawer",
  stripe: "Stripe to their own debit card or bank",
  payroll: "Through payroll",
  prior: "Paid before tip payouts",
};

export const STATUS_LABEL = {
  pending: "Waiting for approval",
  held: "Held",
  approved: "Approved",
  processing: "Sent",
  paid: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

export interface BrandTipPolicy {
  /** The methods shops may use and employees may pick. */
  methods: TipMethod[];
  /** Employees pick their own method (from the allowed ones); otherwise the shop's default applies to everyone. */
  employeeChooses: boolean;
  /** Stripe instant payouts to an eligible debit card, for Stripe's fee. */
  instantAllowed: boolean;
  /** Stripe's instant payout fee comes out of the employee's payout; off, the shop pays it on top. */
  instantFeePassedOn: boolean;
}

export const DEFAULT_BRAND_TIP_POLICY: BrandTipPolicy = { methods: ["cash", "stripe", "payroll"], employeeChooses: true, instantAllowed: true, instantFeePassedOn: true };

export function brandTipPolicy(raw: unknown): BrandTipPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BrandTipPolicy>;
  const d = DEFAULT_BRAND_TIP_POLICY;
  const methods = Array.isArray(r.methods) ? TIP_METHODS.filter((m) => (r.methods as unknown[]).includes(m)) : d.methods;
  return {
    methods: methods.length ? methods : d.methods,
    employeeChooses: typeof r.employeeChooses === "boolean" ? r.employeeChooses : d.employeeChooses,
    instantAllowed: typeof r.instantAllowed === "boolean" ? r.instantAllowed : d.instantAllowed,
    instantFeePassedOn: typeof r.instantFeePassedOn === "boolean" ? r.instantFeePassedOn : d.instantFeePassedOn,
  };
}

export interface ShopTipSettings {
  schedule: TipSchedule;
  /** Card tips become available this many days after the sale, once the card money has settled. Cash and gift card tips are available at once. */
  cardDelayDays: number;
  /** Weekly schedule: the weekday batches are built (0 = Sunday … 6 = Saturday). */
  weeklyDay: number;
  /** For employees who haven't chosen, or everyone where the brand doesn't let them choose. */
  defaultMethod: TipMethod;
  /**
   * Take each card tip's share of the card processing fee out of the payout. Off by default:
   * whether this is allowed, and how it's reported, needs the brand's accountant or lawyer to confirm.
   */
  netCardFee: boolean;
}

/** The card settlement delay when the shop hasn't set one. */
export const DEFAULT_CARD_DELAY: Record<TipSchedule, number> = { end_of_night: 0, daily_delay: 2, weekly: 2, payroll: 0, manual: 0 };

/** Out of the box nothing is paid automatically: managers build batches by hand, in cash, with no fee netting. */
export const DEFAULT_SHOP_TIP_SETTINGS: ShopTipSettings = { schedule: "manual", cardDelayDays: 0, weeklyDay: 1, defaultMethod: "cash", netCardFee: false };

export function shopTipSettings(raw: unknown, policy: BrandTipPolicy = DEFAULT_BRAND_TIP_POLICY): ShopTipSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ShopTipSettings>;
  const d = DEFAULT_SHOP_TIP_SETTINGS;
  const schedule = TIP_SCHEDULES.includes(r.schedule as TipSchedule) ? (r.schedule as TipSchedule) : d.schedule;
  const int = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : dflt);
  const method = TIP_METHODS.includes(r.defaultMethod as TipMethod) && policy.methods.includes(r.defaultMethod as TipMethod) ? (r.defaultMethod as TipMethod) : policy.methods.includes(d.defaultMethod) ? d.defaultMethod : policy.methods[0];
  return {
    schedule,
    cardDelayDays: int(r.cardDelayDays, 0, 14, DEFAULT_CARD_DELAY[schedule]),
    weeklyDay: int(r.weeklyDay, 0, 6, d.weeklyDay),
    defaultMethod: schedule === "payroll" ? "payroll" : method,
    netCardFee: typeof r.netCardFee === "boolean" ? r.netCardFee : d.netCardFee,
  };
}

export function settingsProblem(s: ShopTipSettings, policy: BrandTipPolicy): string | null {
  if (!policy.methods.includes(s.defaultMethod)) return "The brand doesn't allow that payout method.";
  if (s.schedule === "payroll" && !policy.methods.includes("payroll")) return "The brand doesn't allow paying tips through payroll.";
  return null;
}

/**
 * How an employee is paid at a shop: payroll-only shops pay everyone through payroll; otherwise the
 * method their compensation plan sets (when the brand uses compensation fields), else their own
 * choice where allowed, else the shop's default.
 */
export function effectiveMethod(shop: ShopTipSettings, policy: BrandTipPolicy, choice: TipMethod | null | undefined, planned?: TipMethod | null): TipMethod {
  if (shop.schedule === "payroll") return "payroll";
  if (planned && policy.methods.includes(planned)) return planned;
  if (policy.employeeChooses && choice && policy.methods.includes(choice)) return choice;
  return shop.defaultMethod;
}

/** Whether the card fee comes out of an employee's card tips: their compensation plan's say, else the shop's. */
export const netsCardFee = (shop: Pick<ShopTipSettings, "netCardFee">, planned?: boolean | null) => planned ?? shop.netCardFee;

export interface LedgerEntry {
  id: string;
  staffId: string;
  kind: "tip" | "refund" | "adjust";
  method: "card" | "cash" | "gift_card" | "adjust";
  amountCents: number;
  feeCents: number;
  businessDate: LocalDate;
  payoutId: string | null;
  payoutStatus?: string | null;
}

export type EntryStatus = "pending_settlement" | "available" | "in_batch" | "paid_out";
export const ENTRY_STATUS_LABEL: Record<EntryStatus, string> = {
  pending_settlement: "Pending settlement",
  available: "Available",
  in_batch: "In a payout",
  paid_out: "Paid out",
};

/**
 * When a tip can be paid out. Card tips wait for settlement; cash and gift card tips, and anything
 * that takes money away (a refund, a negative adjustment), count at once so nobody is overpaid.
 */
export function availableOn(e: Pick<LedgerEntry, "method" | "amountCents" | "businessDate">, s: Pick<ShopTipSettings, "cardDelayDays">): LocalDate {
  return e.method === "card" && e.amountCents > 0 ? addDays(e.businessDate, s.cardDelayDays) : e.businessDate;
}

export function entryStatus(e: LedgerEntry, s: Pick<ShopTipSettings, "cardDelayDays">, today: LocalDate): EntryStatus {
  if (e.payoutId) return e.payoutStatus === "paid" ? "paid_out" : "in_batch";
  return availableOn(e, s) > today ? "pending_settlement" : "available";
}

export interface PayoutDraft {
  staffId: string;
  entryIds: string[];
  grossCents: number;
  feeCents: number;
  adjustCents: number;
  netCents: number;
}

export interface PayoutTotals {
  grossCents: number;
  feeCents: number;
  adjustCents: number;
  netCents: number;
}

/** A payout's amounts from its entries: tips less refunds, less their card fee share where the shop nets it, plus adjustments. */
export function payoutTotals(entries: readonly Pick<LedgerEntry, "kind" | "amountCents" | "feeCents">[], netCardFee: boolean): PayoutTotals {
  const grossCents = entries.filter((e) => e.kind !== "adjust").reduce((a, e) => a + e.amountCents, 0);
  const adjustCents = entries.filter((e) => e.kind === "adjust").reduce((a, e) => a + e.amountCents, 0);
  const feeCents = netCardFee ? entries.filter((e) => e.kind !== "adjust").reduce((a, e) => a + e.feeCents, 0) : 0;
  return { grossCents, feeCents, adjustCents, netCents: grossCents - feeCents + adjustCents };
}

/**
 * What a batch with this cutoff pays each employee, paid on `asOf`: every unpaid entry up to the
 * cutoff that's available by then. Someone whose entries net to zero or less (a refund after they
 * were paid) gets no payout; their entries stay unpaid and net against the next batch.
 */
export function draftPayouts(entries: readonly LedgerEntry[], s: Pick<ShopTipSettings, "cardDelayDays" | "netCardFee">, cutoff: LocalDate, asOf: LocalDate, netCardFeeOf: (staffId: string) => boolean = () => s.netCardFee) {
  const eligible = entries.filter((e) => !e.payoutId && e.businessDate <= cutoff && availableOn(e, s) <= asOf);
  const byStaff = new Map<string, LedgerEntry[]>();
  for (const e of eligible) byStaff.set(e.staffId, [...(byStaff.get(e.staffId) ?? []), e]);
  const payouts: PayoutDraft[] = [];
  const carried: { staffId: string; netCents: number }[] = [];
  for (const [staffId, list] of byStaff) {
    const t = payoutTotals(list, netCardFeeOf(staffId));
    if (t.netCents > 0) payouts.push({ staffId, entryIds: list.map((e) => e.id), ...t });
    else if (list.length) carried.push({ staffId, netCents: t.netCents });
  }
  return { payouts, carried };
}

/** An employee's tips at a glance. */
export interface TipSummary {
  todayCents: number;
  pendingSettlementCents: number;
  availableCents: number;
  inPayoutCents: number;
  paidOutCents: number;
}

export function summarize(entries: readonly LedgerEntry[], s: Pick<ShopTipSettings, "cardDelayDays">, today: LocalDate): TipSummary {
  const out: TipSummary = { todayCents: 0, pendingSettlementCents: 0, availableCents: 0, inPayoutCents: 0, paidOutCents: 0 };
  for (const e of entries) {
    if (e.businessDate === today && e.kind !== "adjust") out.todayCents += e.amountCents;
    const st = entryStatus(e, s, today);
    if (st === "pending_settlement") out.pendingSettlementCents += e.amountCents;
    else if (st === "available") out.availableCents += e.amountCents;
    else if (st === "in_batch") out.inPayoutCents += e.amountCents;
    else out.paidOutCents += e.amountCents;
  }
  return out;
}

/** The batch a shop's schedule builds on its own today, if any: daily and weekly batches cover through yesterday. End of night is built at drawer close; payroll and manual never on their own. */
export function scheduledBatch(s: ShopTipSettings, today: LocalDate, weekday: number): { kind: "daily_delay" | "weekly"; cutoff: LocalDate } | null {
  if (s.schedule === "daily_delay") return { kind: "daily_delay", cutoff: addDays(today, -1) };
  if (s.schedule === "weekly" && weekday === s.weeklyDay) return { kind: "weekly", cutoff: addDays(today, -1) };
  return null;
}

export interface InstantFeeRate {
  pct: number;
  minCents: number;
}
/** Stripe's US instant payout fee as of this writing (1.5%, $0.50 minimum). Set TIP_INSTANT_FEE to match the account's pricing, e.g. "1.5%min50". */
export const DEFAULT_INSTANT_FEE: InstantFeeRate = { pct: 1.5, minCents: 50 };

export function parseInstantFee(raw: string | undefined | null): InstantFeeRate | null {
  const m = raw?.trim().match(/^(\d+(?:\.\d+)?)%(?:\s*min\s*(\d+))?$/i);
  return m ? { pct: Number(m[1]), minCents: m[2] ? Number(m[2]) : 0 } : null;
}

export function instantFeeCents(netCents: number, rate: InstantFeeRate = DEFAULT_INSTANT_FEE): number {
  if (netCents <= 0) return 0;
  return Math.min(netCents, Math.max(rate.minCents, Math.round((netCents * rate.pct) / 100)));
}

/** Who pays Stripe's instant payout fee, by the brand's policy: the employee (out of the payout) or the shop (on top of it). */
export type InstantFeePayer = "employee" | "shop";
export const instantFeePayer = (policy: Pick<BrandTipPolicy, "instantFeePassedOn">): InstantFeePayer => (policy.instantFeePassedOn ? "employee" : "shop");

type PayoutAmounts = { netCents: number; instantFeeCents: number; instantFeePaidBy: InstantFeePayer | string };
/** What reaches the employee's card or bank: the net, less the instant fee where it's passed on. */
export const receivedCents = (p: PayoutAmounts) => p.netCents - (p.instantFeePaidBy === "shop" ? 0 : p.instantFeeCents);
/** What the payout costs the shop: the net, plus the instant fee where the shop pays it. */
export const shopCostCents = (p: PayoutAmounts) => p.netCents + (p.instantFeePaidBy === "shop" ? p.instantFeeCents : 0);
/** The instant fee the employee pays: all of it, or none where the shop pays it. */
export const employeeFeeCents = (p: PayoutAmounts) => (p.instantFeePaidBy === "shop" ? 0 : p.instantFeeCents);

/** A card tip's share of the charge's processing fee, pro rata to the charge. */
export function feeShareCents(feeCents: number, tipCents: number, amountCents: number): number {
  return amountCents > 0 ? Math.round((feeCents * tipCents) / amountCents) : 0;
}

/** A reversal's share of the fee recorded on the tip it reverses; a full reversal gives back exactly the fee. */
export function reversalFeeCents(tip: { amountCents: number; feeCents: number }, reversedTipCents: number): number {
  if (tip.amountCents <= 0) return 0;
  return reversedTipCents >= tip.amountCents ? tip.feeCents : Math.round((tip.feeCents * reversedTipCents) / tip.amountCents);
}
