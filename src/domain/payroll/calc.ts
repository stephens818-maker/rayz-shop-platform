/**
 * The Payroll Report math, row for row the workbook's Locations sheet (spec §2), plus the platform's
 * additions to the right of it: O.T. Pay, Training Pay and Labor Cost. Every total is a sum of the rows
 * below it; nothing is typed in or carried over.
 *
 * Money is dollars as JavaScript numbers (IEEE doubles, the same arithmetic Excel uses) and each
 * formula runs in the workbook's order, so an unrounded export matches the workbook to the last digit.
 */
import type { LocalDate } from "@/lib/time";
import { DEFAULT_BRAND_CALENDAR, calendarProblem, type PayCalendar } from "./calendar";

export interface PayrollSettings {
  /** Weekly overtime threshold: 40 under the federal FLSA. Iowa and Illinois appear to follow it with no daily rule; to confirm. */
  otThresholdHours: number;
  /** Optional daily overtime threshold (hours in one day). Null: weekly only. */
  dailyOtHours: number | null;
  /** For the report's OT Pay. iSolved computes the real (blended) OT itself. */
  otMultiplier: number;
  /** C2: training hours count toward the weekly 40. Off until Charles answers Q11. */
  trainingCountsTowardOt: boolean;
  /** Training hours paid at the training rate are labor cost. The workbook leaves them out. */
  trainingPayInCost: boolean;
  /** 2-decimal half-up on export values. Off: the workbook's values go out unrounded (pending Charles). */
  roundExport2dp: boolean;
  /** Full time = averaging more than this many hours a week. Exactly this many is part time. */
  ftHoursPerWeek: number;
  ftBasis: FtBasis;
  ftWindowWeeks: number;
  /**
   * The iSolved earning for tips paid through payroll rather than separately. Its column is added to
   * a shop's file only when someone there has such tips; the code is Charles's to confirm.
   */
  tipsInPayrollHeader: string;
  /**
   * Marks tips already paid out (cash from the drawer or Stripe to the employee's card or bank) in
   * their own column, so iSolved shows which of the tips received were paid. A memo amount only: it's
   * part of E_Cash Tips Recd, never paid again. Added only when someone in the file has paid tips.
   */
  markPaidTips: boolean;
  /** That column's header; the memo code is Charles's to confirm in iSolved. Where anyone in the file was paid by Stripe, it carries only the tips paid out another way. */
  tipsPaidOutHeader: string;
  /** The memo column for tips paid out by Stripe (ST-C13), apart from cash. Added only when someone in the file has them. */
  stripeTipsPaidHeader: string;
  /** The iSolved earning for owed Stripe tips paid through payroll at the cutoff (ST-C14's fallback), apart from tips the employee chose to get there (ST-C13). Added only when someone in the file has them. */
  owedTipsInPayrollHeader: string;
  /** The brand's pay calendar, matched to iSolved's: new pay groups start on it, and so do the brand-wide pay periods (tips by pay period, timesheets). */
  calendar: PayCalendar;
  /** The iSolved earning for cash tips employees declare (received in hand, not paid by the shop, but taxed). Added only when someone in the file declared any. */
  cashTipsDeclaredHeader: string;
  declarations: TipDeclarationSettings;
  tipTax: TipTaxSettings;
}

/** Employees declaring the cash tips handed to them (IRS: monthly, by the 10th of the next month, when $20 or more). */
export interface TipDeclarationSettings {
  enabled: boolean;
  /** Asked for at clock-out, as well as from the staff app's tips screen. */
  atClockOut: boolean;
  /** Reminded on the 1st through this day when they haven't declared anything for last month. */
  remindUntilDay: number;
  /** From the day after this one, last month's declarations are closed to employees; a manager can still correct one, with a reason. */
  lockDay: number;
  /** What the employee checks to declare. Kept with every declaration. */
  attestation: string;
}

/** 2026 W-2 reporting of qualified tips and overtime, and the 45B FICA tip credit. Codes and thresholds are the CPA's and iSolved's to confirm. */
export interface TipTaxSettings {
  /** W-2 box 12 code for qualified tips. */
  qualifiedTipsCode: string;
  /** W-2 box 12 code for qualified overtime (the FLSA half-time premium). */
  overtimeCode: string;
  /** Tips from this date count toward 45B (tax years after Dec 31, 2024 for barbering and other beauty services, per the 2025 Form 8846). */
  creditFrom: LocalDate;
  /** 45B's wage floor per hour, in cents: tips that only bring pay up to it don't count. For beauty services, the federal minimum wage in effect ($7.25), not the food and beverage $5.15. */
  creditWageCentsPerHour: number;
  /** The employer FICA rate on creditable tips. */
  ficaRate: number;
}

export const DEFAULT_ATTESTATION = "I declare these are all the cash tips I received that weren't rung up on a ticket.";

export type FtBasis = "worked" | "worked_training" | "paid";

export const FT_BASIS_LABEL: Record<FtBasis, string> = {
  worked: "Clocked worked hours",
  worked_training: "Worked + training hours",
  paid: "Worked + training + PTO hours",
};

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  otThresholdHours: 40,
  dailyOtHours: null,
  otMultiplier: 1.5,
  trainingCountsTowardOt: false,
  trainingPayInCost: true,
  roundExport2dp: false,
  ftHoursPerWeek: 32,
  ftBasis: "worked",
  ftWindowWeeks: 4,
  tipsInPayrollHeader: "E_Tips Paid In Payroll_Dollars",
  markPaidTips: true,
  tipsPaidOutHeader: "M_Tips Paid Out_Dollars",
  stripeTipsPaidHeader: "M_Tips Paid By Stripe_Dollars",
  owedTipsInPayrollHeader: "E_Owed Tips Paid In Payroll_Dollars",
  calendar: DEFAULT_BRAND_CALENDAR,
  cashTipsDeclaredHeader: "E_Cash Tips Declared_Dollars",
  declarations: { enabled: true, atClockOut: true, remindUntilDay: 9, lockDay: 10, attestation: DEFAULT_ATTESTATION },
  tipTax: { qualifiedTipsCode: "TP", overtimeCode: "TT", creditFrom: "2025-01-01", creditWageCentsPerHour: 725, ficaRate: 0.0765 },
};

const header = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : d);

function calendarOf(v: unknown): PayCalendar {
  const c = (v && typeof v === "object" ? v : {}) as Partial<PayCalendar>;
  const d = DEFAULT_BRAND_CALENDAR;
  const cal: PayCalendar = {
    anchorStart: typeof c.anchorStart === "string" ? c.anchorStart : d.anchorStart,
    anchorNumber: typeof c.anchorNumber === "number" ? c.anchorNumber : d.anchorNumber,
    periodDays: typeof c.periodDays === "number" ? c.periodDays : d.periodDays,
    checkOffsetDays: typeof c.checkOffsetDays === "number" ? c.checkOffsetDays : d.checkOffsetDays,
    numberResetsYearly: typeof c.numberResetsYearly === "boolean" ? c.numberResetsYearly : d.numberResetsYearly,
  };
  return calendarProblem(cal) ? d : cal;
}

export function payrollSettings(raw: unknown): PayrollSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PayrollSettings>;
  const d = DEFAULT_PAYROLL_SETTINGS;
  const num = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt);
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const dc = (r.declarations && typeof r.declarations === "object" ? r.declarations : {}) as Partial<TipDeclarationSettings>;
  const tt = (r.tipTax && typeof r.tipTax === "object" ? r.tipTax : {}) as Partial<TipTaxSettings>;
  const lockDay = Math.round(num(dc.lockDay, 1, 28, d.declarations.lockDay));
  const code = (v: unknown, dflt: string) => (typeof v === "string" && /^[A-Z0-9]{1,4}$/.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : dflt);
  return {
    otThresholdHours: num(r.otThresholdHours, 1, 80, d.otThresholdHours),
    dailyOtHours: r.dailyOtHours === null || r.dailyOtHours === undefined ? null : num(r.dailyOtHours, 1, 24, d.dailyOtHours ?? 0) || null,
    otMultiplier: num(r.otMultiplier, 1, 3, d.otMultiplier),
    trainingCountsTowardOt: bool(r.trainingCountsTowardOt, d.trainingCountsTowardOt),
    trainingPayInCost: bool(r.trainingPayInCost, d.trainingPayInCost),
    roundExport2dp: bool(r.roundExport2dp, d.roundExport2dp),
    ftHoursPerWeek: num(r.ftHoursPerWeek, 1, 60, d.ftHoursPerWeek),
    ftBasis: r.ftBasis && r.ftBasis in FT_BASIS_LABEL ? r.ftBasis : d.ftBasis,
    ftWindowWeeks: Math.round(num(r.ftWindowWeeks, 1, 26, d.ftWindowWeeks)),
    tipsInPayrollHeader: header(r.tipsInPayrollHeader, d.tipsInPayrollHeader),
    markPaidTips: bool(r.markPaidTips, d.markPaidTips),
    tipsPaidOutHeader: header(r.tipsPaidOutHeader, d.tipsPaidOutHeader),
    stripeTipsPaidHeader: header(r.stripeTipsPaidHeader, d.stripeTipsPaidHeader),
    owedTipsInPayrollHeader: header(r.owedTipsInPayrollHeader, d.owedTipsInPayrollHeader),
    calendar: calendarOf(r.calendar),
    cashTipsDeclaredHeader: header(r.cashTipsDeclaredHeader, d.cashTipsDeclaredHeader),
    declarations: {
      enabled: bool(dc.enabled, d.declarations.enabled),
      atClockOut: bool(dc.atClockOut, d.declarations.atClockOut),
      remindUntilDay: Math.min(lockDay, Math.round(num(dc.remindUntilDay, 0, 28, d.declarations.remindUntilDay))),
      lockDay,
      attestation: typeof dc.attestation === "string" && dc.attestation.trim() ? dc.attestation.trim().slice(0, 300) : d.declarations.attestation,
    },
    tipTax: {
      qualifiedTipsCode: code(tt.qualifiedTipsCode, d.tipTax.qualifiedTipsCode),
      overtimeCode: code(tt.overtimeCode, d.tipTax.overtimeCode),
      creditFrom: typeof tt.creditFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(tt.creditFrom) ? tt.creditFrom : d.tipTax.creditFrom,
      creditWageCentsPerHour: Math.round(num(tt.creditWageCentsPerHour, 0, 5000, d.tipTax.creditWageCentsPerHour)),
      ficaRate: num(tt.ficaRate, 0, 0.2, d.tipTax.ficaRate),
    },
  };
}

/** Values a manager can type over, each with a reason. The workbook had these as hand-typed cells. */
export const OVERRIDABLE = ["workedHours", "otHours", "serviceSales", "productSales", "tips", "netComm", "ptoHours", "trainingHours"] as const;
export type Overridable = (typeof OVERRIDABLE)[number];
export type Overrides = Partial<Record<Overridable, { value: number; reason: string }>>;

export const OVERRIDE_LABEL: Record<Overridable, string> = {
  workedHours: "Hours worked",
  otHours: "O.T. hours",
  serviceSales: "Service $",
  productSales: "Product $",
  tips: "Tips",
  netComm: "NetComm",
  ptoHours: "PTO hours",
  trainingHours: "Training hours",
};

export interface LineInput {
  staffId: string;
  name: string;
  shopId: string;
  /** iSolved Employee Number; null until it's entered. Lives in the database only. */
  employeeNumber: string | null;
  /** Written as text (and kept with its text format) rather than a number, as in the workbook. */
  keyIsText: boolean;
  isolvedName: string;
  hourlyRate: number;
  servicePct: number;
  productPct: number;
  /** Null = paid at the hourly rate. */
  trainingRate: number | null;
  /** All hours worked at this shop in the period, OT included (the Squire "Hours Worked" feed). */
  workedHours: number;
  otHours: number;
  ptoHours: number;
  trainingHours: number;
  serviceSales: number;
  productSales: number;
  tips: number;
  /** Of the tips, those paid through payroll (the employee or shop is paid that way); the rest are paid out separately. */
  tipsInPayroll?: number;
  /** Of the tips, those already paid out in cash or by Stripe when the report was built. */
  tipsPaidOut?: number;
  /** Of tipsPaidOut, those paid by Stripe. */
  tipsPaidByStripe?: number;
  /** Of tipsInPayroll, owed Stripe tips going through payroll at the cutoff (ST-C14) rather than by the employee's choice. */
  owedTipsInPayroll?: number;
  /** What brings the employee up to their guaranteed minimum (compensation plans, when payroll uses them). */
  guaranteeTopUp?: number;
  /** Cash tips the employee declared for the period (handed to them, never rung up). Not the shop's money, so not labor cost. */
  declaredCashTips?: number;
  /** Of the tips, card and gift card ("charged") ones; the rest were cash on a ticket. For the W-2 and 45B reports. */
  chargedTips?: number;
  /** Tip refunds in the period of tickets from an earlier pay period, already paid: always the shop's cost. */
  lateTipRefunds?: number;
  overrides?: Overrides;
}

export interface Line {
  input: LineInput;
  staffId: string;
  name: string;
  shopId: string;
  /** B: regular hours = worked − OT. */
  hours: number;
  /** C */
  wage: number;
  /** D = B × C */
  hourlyTotal: number;
  /** E */
  service: number;
  /** F = E / B; null where the workbook shows #DIV/0!. */
  grossPerHour: number | null;
  /** G */
  servicePct: number;
  /** H = E × G */
  commission: number;
  /** I = H − D */
  serviceTotal: number;
  /** J */
  product: number;
  /** K */
  productPct: number;
  /** L = J × K */
  productTotal: number;
  /** M = IF(I>0, I+L, L) — the Comm Sales export column. */
  netComm: number;
  /** M as the formula has it, whatever was typed over it. */
  netCommComputed: number;
  /** N = IF(I>0, D+I, D) + L — the workbook's Total Wages (no OT, no training). */
  totalWages: number;
  /** O = N / E */
  pctOfGross: number | null;
  /** P */
  ptoHours: number;
  /** Q */
  otHours: number;
  /** R */
  tips: number;
  /** R, paid through payroll: its own iSolved column. */
  tipsInPayroll: number;
  /** R, paid separately (cash or Stripe, already or by a later batch): E_Cash Tips Recd, tips the employee already received. */
  tipsOutside: number;
  /** Of tipsOutside, what was already paid out when the report was built. Information only. */
  tipsPaidOut: number;
  /** tipsPaidOut by how it was paid (ST-C13): by Stripe, and any other way. Absent in periods locked before the split. */
  tipsPaidOutStripe?: number;
  tipsPaidOutCash?: number;
  /** tipsInPayroll by why (ST-C13): owed Stripe tips (ST-C14's fallback), and the employee's or shop's choice. Absent in periods locked before the split. */
  tipsInPayrollOwed?: number;
  tipsInPayrollChosen?: number;
  /** Declared cash tips: their own iSolved earning, reported (and taxed), never paid by the shop. */
  declaredCashTips: number;
  /** Of R, card and gift card tips. Information only. */
  chargedTips: number;
  /** Tip refunds of earlier, already-paid periods issued in this one; flagged. Information only. */
  lateTipRefunds: number;
  /** Of those, the shop's cost: never taken from the employee unless the brand deducts them. */
  tipRefundsShopCost: number;
  /** S */
  trainingHours: number;
  /** T = OT multiplier × C × Q. Base rate only; iSolved may compute blended OT higher. */
  otPay: number;
  /** U = training rate × S when training pay counts as cost, else 0. */
  trainingPay: number;
  /** The guaranteed minimum's top-up: 0 unless compensation plans are on and set one. */
  guaranteeTopUp: number;
  /** V = N + T + U (+ the guarantee top-up) */
  laborCost: number;
  overridden: Overridable[];
}

const ov = (i: LineInput, k: Overridable, v: number) => i.overrides?.[k]?.value ?? v;

export function computeLine(i: LineInput, s: PayrollSettings): Line {
  const worked = ov(i, "workedHours", i.workedHours);
  const otHours = ov(i, "otHours", i.otHours);
  const hours = worked - otHours;
  const wage = i.hourlyRate;
  const hourlyTotal = hours * wage;
  const service = ov(i, "serviceSales", i.serviceSales);
  const commission = service * i.servicePct;
  const serviceTotal = commission - hourlyTotal;
  const product = ov(i, "productSales", i.productSales);
  const productTotal = product * i.productPct;
  const netCommComputed = serviceTotal > 0 ? serviceTotal + productTotal : productTotal;
  const netComm = ov(i, "netComm", netCommComputed);
  const totalWages = (serviceTotal > 0 ? hourlyTotal + serviceTotal : hourlyTotal) + productTotal;
  const trainingHours = ov(i, "trainingHours", i.trainingHours);
  const otPay = s.otMultiplier * wage * otHours;
  const tips = ov(i, "tips", i.tips);
  const tipsInPayroll = i.tipsInPayroll ?? 0;
  const tipsPaidOut = i.tipsPaidOut ?? 0;
  const between = (x: number | undefined, max: number) => (max >= 0 ? Math.min(max, Math.max(0, x ?? 0)) : 0);
  const tipsInPayrollOwed = between(i.owedTipsInPayroll, tipsInPayroll);
  const tipsPaidOutStripe = between(i.tipsPaidByStripe, tipsPaidOut);
  const trainingPay = s.trainingPayInCost ? (i.trainingRate ?? wage) * trainingHours : 0;
  const guaranteeTopUp = i.guaranteeTopUp ?? 0;
  return {
    input: i,
    staffId: i.staffId,
    name: i.name,
    shopId: i.shopId,
    hours,
    wage,
    hourlyTotal,
    service,
    grossPerHour: hours ? service / hours : null,
    servicePct: i.servicePct,
    commission,
    serviceTotal,
    product,
    productPct: i.productPct,
    productTotal,
    netComm,
    netCommComputed,
    totalWages,
    pctOfGross: service ? totalWages / service : null,
    ptoHours: ov(i, "ptoHours", i.ptoHours),
    otHours,
    tips,
    tipsInPayroll,
    tipsOutside: tips - tipsInPayroll,
    tipsPaidOut,
    tipsPaidOutStripe,
    tipsPaidOutCash: tipsPaidOut - tipsPaidOutStripe,
    tipsInPayrollOwed,
    tipsInPayrollChosen: tipsInPayroll - tipsInPayrollOwed,
    declaredCashTips: i.declaredCashTips ?? 0,
    chargedTips: Math.min(tips, Math.max(0, i.chargedTips ?? 0)),
    lateTipRefunds: i.lateTipRefunds ?? 0,
    tipRefundsShopCost: i.lateTipRefunds ?? 0,
    trainingHours,
    otPay,
    trainingPay,
    guaranteeTopUp,
    laborCost: totalWages + otPay + trainingPay + guaranteeTopUp,
    overridden: OVERRIDABLE.filter((k) => i.overrides?.[k] !== undefined),
  };
}

/** The columns that add up. Rates and percentages (C, G, K) don't; F and O are ratios of totals. */
export const SUMMED = [
  "hours",
  "hourlyTotal",
  "service",
  "commission",
  "serviceTotal",
  "product",
  "productTotal",
  "netComm",
  "totalWages",
  "ptoHours",
  "otHours",
  "tips",
  "tipsInPayroll",
  "tipsOutside",
  "tipsPaidOut",
  "declaredCashTips",
  "chargedTips",
  "lateTipRefunds",
  "tipRefundsShopCost",
  "trainingHours",
  "otPay",
  "trainingPay",
  "guaranteeTopUp",
  "laborCost",
] as const;
export type Summed = (typeof SUMMED)[number];
export type Totals = Record<Summed, number> & { grossPerHour: number | null; pctOfGross: number | null; grossProfit: number };

export const COLUMN_LABEL: Record<Summed | "wage" | "grossPerHour" | "servicePct" | "productPct" | "pctOfGross", string> = {
  hours: "Hours",
  wage: "Hourly Wage",
  hourlyTotal: "Hourly Total",
  service: "Service$",
  grossPerHour: "Gross /Hr",
  servicePct: "Service%",
  commission: "Commission$",
  serviceTotal: "Service Total",
  product: "Product$",
  productPct: "Prod%",
  productTotal: "Product Total",
  netComm: "NetComm",
  totalWages: "Total Wages",
  pctOfGross: "Total % of Gross",
  ptoHours: "PTO HRs.",
  otHours: "O.T. HRS",
  tips: "TIPS",
  tipsInPayroll: "Tips in payroll",
  tipsOutside: "Tips paid separately",
  tipsPaidOut: "Tips paid out",
  declaredCashTips: "Cash tips declared",
  chargedTips: "Charged tips",
  lateTipRefunds: "Post-payout tip refunds",
  tipRefundsShopCost: "Tip refunds, shop cost",
  trainingHours: "Training Hours",
  otPay: "O.T. Pay",
  trainingPay: "Training Pay",
  guaranteeTopUp: "Guarantee top-up",
  laborCost: "Labor Cost",
};

/** Hours columns; the rest are dollars. */
export const HOUR_COLUMNS: ReadonlySet<string> = new Set(["hours", "ptoHours", "otHours", "trainingHours"]);

export function totalsOf(rows: readonly Pick<Line, Summed>[]): Totals {
  const t = Object.fromEntries(SUMMED.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Record<Summed, number>;
  return { ...t, grossPerHour: t.hours ? t.service / t.hours : null, pctOfGross: t.service ? t.totalWages / t.service : null, grossProfit: t.service - t.laborCost };
}

/** Half-up to 2 decimals from the decimal digits (6.315 → 6.32), never banker's rounding or binary drift. */
export function roundHalfUp2(x: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const [int, frac = ""] = Math.abs(x).toPrecision(15).replace(/\.?0+$/, "").split(".");
  const asNum = Number(int + "." + frac);
  if (frac.length <= 2) return neg ? -asNum : asNum;
  const cents = Number(int) * 100 + Number(frac.slice(0, 2).padEnd(2, "0")) + (Number(frac[2]) >= 5 ? 1 : 0);
  const v = cents / 100;
  return neg ? -v : v;
}

/** The per-shop iSolved columns, in the workbook's order. Hours only for OT: never OT dollars. */
export const EXPORT_COLUMNS = [
  { header: "E_Regular_Hours", from: "hours" },
  { header: "E_Overtime 1.5_Hours", from: "otHours" },
  { header: "E_Cash Tips Recd_Dollars", from: "tipsOutside" },
  { header: "E_Comm Sales_Dollars", from: "netComm" },
  { header: "E_Ray'z Paid Time_Hours", from: "ptoHours" },
  { header: "E_Training_Hours", from: "trainingHours" },
] as const satisfies readonly { header: string; from: Summed }[];

export interface ExportRow {
  staffId: string;
  key: string | number | null;
  isolvedName: string;
  values: number[];
}

/** A shop's file gets the tips-in-payroll column only when someone there has tips paid through payroll, so the usual file is unchanged. */
export const hasPayrollTips = (lines: readonly Pick<Line, "tipsInPayroll">[]) => lines.some((l) => l.tipsInPayroll !== 0);
export const hasPaidTips = (lines: readonly Pick<Line, "tipsPaidOut">[]) => lines.some((l) => l.tipsPaidOut !== 0);
const hasGuarantee = (lines: readonly Pick<Line, "guaranteeTopUp">[]) => lines.some((l) => (l.guaranteeTopUp ?? 0) !== 0);
export const hasDeclaredTips = (lines: readonly Pick<Line, "declaredCashTips">[]) => lines.some((l) => (l.declaredCashTips ?? 0) !== 0);

/** What a column after the standard six carries. */
export type ExtraFrom = "tipsInPayroll" | "tipsInPayrollChosen" | "tipsInPayrollOwed" | "tipsPaidOut" | "tipsPaidOutCash" | "tipsPaidOutStripe" | "declaredCashTips" | "guaranteeTopUp" | "commission" | "productTotal" | "wage";

export const SPLIT_LABEL: Record<"tipsInPayrollChosen" | "tipsInPayrollOwed" | "tipsPaidOutCash" | "tipsPaidOutStripe", string> = {
  tipsInPayrollChosen: "Tips in payroll by choice",
  tipsInPayrollOwed: "Owed tips in payroll",
  tipsPaidOutCash: "Tips paid out, not by Stripe",
  tipsPaidOutStripe: "Tips paid by Stripe",
};

/** A file's tips paid through payroll and its tips already paid out, whichever columns carry them (one, or split by ST-C13). */
export const PAYROLL_TIP_COLUMNS: readonly ExtraFrom[] = ["tipsInPayroll", "tipsInPayrollChosen", "tipsInPayrollOwed"];
export const PAID_TIP_COLUMNS: readonly ExtraFrom[] = ["tipsPaidOut", "tipsPaidOutCash", "tipsPaidOutStripe"];
export const sumColumns = (from: readonly ExtraFrom[], values: readonly number[], ks: readonly ExtraFrom[]) =>
  ks.reduce((a, k) => {
    const j = from.indexOf(k);
    return a + (j >= 0 ? (values[EXPORT_COLUMNS.length + j] ?? 0) : 0);
  }, 0);
export interface ExtraColumn {
  header: string;
  from: ExtraFrom;
}
/** Options from compensation settings (src/domain/compensation.ts); without them the file is the standard one. */
export interface ExportOptions {
  /** Columns the brand asked for, after the rest. */
  extras?: readonly ExtraColumn[];
  /** The guarantee top-up's header; its column is added only when someone in the file has a top-up. */
  guaranteeHeader?: string;
}

const someHave = (lines: readonly Line[], k: "tipsInPayrollOwed" | "tipsInPayrollChosen" | "tipsPaidOutStripe" | "tipsPaidOutCash") => lines.some((l) => (l[k] ?? 0) !== 0);

/**
 * Tips paid through payroll and tips already paid out, each in one column, or split (ST-C13) where
 * anyone in the file has owed tips in payroll or was paid by Stripe: the employee's chosen payroll
 * tips apart from owed ones, and tips paid out by Stripe apart from cash. The usual file is unchanged.
 */
function tipColumns(lines: readonly Line[], s: PayrollSettings): ExtraColumn[] {
  const payroll: ExtraColumn[] = !someHave(lines, "tipsInPayrollOwed")
    ? hasPayrollTips(lines)
      ? [{ header: s.tipsInPayrollHeader, from: "tipsInPayroll" }]
      : []
    : [...(someHave(lines, "tipsInPayrollChosen") ? [{ header: s.tipsInPayrollHeader, from: "tipsInPayrollChosen" as const }] : []), { header: s.owedTipsInPayrollHeader, from: "tipsInPayrollOwed" }];
  const paid: ExtraColumn[] = !s.markPaidTips
    ? []
    : !someHave(lines, "tipsPaidOutStripe")
      ? hasPaidTips(lines)
        ? [{ header: s.tipsPaidOutHeader, from: "tipsPaidOut" }]
        : []
      : [...(someHave(lines, "tipsPaidOutCash") ? [{ header: s.tipsPaidOutHeader, from: "tipsPaidOutCash" as const }] : []), { header: s.stripeTipsPaidHeader, from: "tipsPaidOutStripe" }];
  return [...payroll, ...paid];
}

/** The columns after the standard six: tips in payroll, tips already paid out (where marked), declared cash tips and the guarantee top-up when someone in the file has them, then the brand's. */
export function exportExtraColumns(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): ExtraColumn[] {
  return [
    ...tipColumns(lines, s),
    ...(hasDeclaredTips(lines) ? [{ header: s.cashTipsDeclaredHeader, from: "declaredCashTips" as const }] : []),
    ...(hasGuarantee(lines) ? [{ header: o.guaranteeHeader ?? COLUMN_LABEL.guaranteeTopUp, from: "guaranteeTopUp" as const }] : []),
    ...(o.extras ?? []),
  ];
}

export function exportHeaders(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): string[] {
  return [...EXPORT_COLUMNS.map((c) => c.header), ...exportExtraColumns(lines, s, o).map((c) => c.header)];
}

export function exportRows(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): ExportRow[] {
  const extra = exportExtraColumns(lines, s, o);
  const out = (x: number) => (s.roundExport2dp ? roundHalfUp2(x) : x);
  return lines.map((l) => ({
    staffId: l.staffId,
    key: l.input.employeeNumber === null ? null : l.input.keyIsText || !/^\d+$/.test(l.input.employeeNumber) ? l.input.employeeNumber : Number(l.input.employeeNumber),
    isolvedName: l.input.isolvedName,
    values: [...EXPORT_COLUMNS.map((c) => out(l[c.from])), ...extra.map((c) => out(l[c.from] ?? 0))],
  }));
}

/** Sums to the cent (or hundredth of an hour) without float drift deciding the answer. */
export const toCents = (x: number) => Math.round(x * 100 + (x >= 0 ? 1e-7 : -1e-7));
export const sameToTheCent = (a: number, b: number) => toCents(a) === toCents(b);

export interface Mismatch {
  shopId: string | null;
  column: string;
  /** tips: an employee's tips in the export against the tip ledger and their payouts in the period (with direct Stripe payouts on). */
  check: "rows" | "export" | "locations" | "tips";
  report: number;
  other: number;
  detail: string;
}

export interface ShopBlock {
  shopId: string;
  shop: string;
  lines: Line[];
  totals: Totals;
  exportRows: ExportRow[];
  /** The file's columns after Key and name; absent in periods locked before tips in payroll existed (the six standard ones). */
  exportHeaders?: string[];
  /** What each column after the standard six carries; absent in periods locked before there could be more than tips in payroll. */
  exportFrom?: ExtraFrom[];
}

/** Locked before exportFrom existed, a seventh column could only be tips paid in payroll. */
export const extraFromOf = (b: Pick<ShopBlock, "exportFrom" | "exportHeaders">): ExtraFrom[] => b.exportFrom ?? ((b.exportHeaders?.length ?? EXPORT_COLUMNS.length) > EXPORT_COLUMNS.length ? ["tipsInPayroll"] : []);

/** The paystub's name for an iSolved import column: the earning (E_) or memo (M_) between the prefix and _Hours or _Dollars ("E_Comm Sales_Dollars" is Comm Sales). */
export function paystubName(header: string): { name: string; unit: "hours" | "dollars"; memo: boolean } {
  const m = /^([EM])_(.+)_(Hours|Dollars)$/.exec(header.trim());
  return m ? { name: m[2].trim(), unit: m[3] === "Hours" ? "hours" : "dollars", memo: m[1] === "M" } : { name: header.trim(), unit: "dollars", memo: false };
}

export type PaystubGroup = "hours" | "tips" | "wages";
const PAYSTUB_GROUP: Partial<Record<Summed | ExtraFrom, PaystubGroup>> = {
  hours: "hours",
  otHours: "hours",
  ptoHours: "hours",
  trainingHours: "hours",
  tipsOutside: "tips",
  tipsInPayroll: "tips",
  tipsInPayrollChosen: "tips",
  tipsInPayrollOwed: "tips",
  tipsPaidOut: "tips",
  tipsPaidOutCash: "tips",
  tipsPaidOutStripe: "tips",
  declaredCashTips: "tips",
};

export interface PaystubLine {
  /** The import column, exactly as in the payroll file. */
  header: string;
  /** What the paystub prints. */
  name: string;
  unit: "hours" | "dollars";
  amount: number;
  group: PaystubGroup;
  /** Tips the employee already has (paid out in cash or by Stripe): on the stub, never paid again. */
  memo: boolean;
}

/** One person's lines in their shop's payroll file, named as their paystub names them; zero lines left out. */
export function paystubLines(b: Pick<ShopBlock, "exportRows" | "exportHeaders" | "exportFrom">, staffId: string): PaystubLine[] {
  const row = b.exportRows.find((r) => r.staffId === staffId);
  if (!row) return [];
  const headers = b.exportHeaders ?? EXPORT_COLUMNS.map((c) => c.header);
  const from: (Summed | ExtraFrom)[] = [...EXPORT_COLUMNS.map((c) => c.from), ...extraFromOf(b)];
  return headers.flatMap((header, i) => {
    const amount = row.values[i] ?? 0;
    if (!amount) return [];
    const k = from[i];
    const n = paystubName(header);
    return [{ header, ...n, amount, group: (k && PAYSTUB_GROUP[k]) ?? "wages", memo: n.memo || (!!k && (PAID_TIP_COLUMNS as readonly string[]).includes(k)) }];
  });
}

/**
 * The reconciliation gate (spec §5). Approve-and-lock is blocked while this returns anything:
 * a report total that isn't the sum of its rows, a per-shop export column whose total isn't the report's,
 * or a Locations summary that isn't the shop blocks. The tolerance is $0.00.
 */
export function reconcile(blocks: readonly ShopBlock[], grand: Totals): Mismatch[] {
  const out: Mismatch[] = [];
  for (const b of blocks) {
    for (const k of SUMMED) {
      const sum = b.lines.reduce((a, l) => a + l[k], 0);
      if (!sameToTheCent(b.totals[k], sum)) out.push({ shopId: b.shopId, column: COLUMN_LABEL[k], check: "rows", report: b.totals[k], other: sum, detail: `${b.shop}: total isn't the sum of its rows` });
    }
    EXPORT_COLUMNS.forEach((c, i) => {
      const sum = b.exportRows.reduce((a, r) => a + r.values[i], 0);
      if (!sameToTheCent(b.totals[c.from], sum)) out.push({ shopId: b.shopId, column: c.header, check: "export", report: b.totals[c.from], other: sum, detail: `${b.shop}: export ${c.header} adds up to a different total than the report's ${COLUMN_LABEL[c.from]}` });
    });
    const from = extraFromOf(b);
    const exported = (k: ExtraFrom) => {
      const i = from.indexOf(k);
      return i < 0 ? 0 : b.exportRows.reduce((a, r) => a + (r.values[EXPORT_COLUMNS.length + i] ?? 0), 0);
    };
    const payrollTips = PAYROLL_TIP_COLUMNS.reduce((a, k) => a + exported(k), 0);
    if (!sameToTheCent(b.totals.tipsInPayroll, payrollTips))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.tipsInPayroll, check: "export", report: b.totals.tipsInPayroll, other: payrollTips, detail: `${b.shop}: the export's tips paid in payroll add up to a different total than the report's` });
    const topUps = exported("guaranteeTopUp");
    if (!sameToTheCent(b.totals.guaranteeTopUp ?? 0, topUps))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.guaranteeTopUp, check: "export", report: b.totals.guaranteeTopUp ?? 0, other: topUps, detail: `${b.shop}: the export's guarantee top-ups add up to a different total than the report's` });
    const declared = exported("declaredCashTips");
    if (!sameToTheCent(b.totals.declaredCashTips ?? 0, declared))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.declaredCashTips, check: "export", report: b.totals.declaredCashTips ?? 0, other: declared, detail: `${b.shop}: the export's declared cash tips add up to a different total than the report's` });
    for (const k of ["tipsPaidOut", "commission", "productTotal"] as const) {
      if (!from.includes(k)) continue;
      const sum = exported(k);
      if (!sameToTheCent(b.totals[k], sum)) out.push({ shopId: b.shopId, column: COLUMN_LABEL[k], check: "export", report: b.totals[k], other: sum, detail: `${b.shop}: the export's ${COLUMN_LABEL[k]} column adds up to a different total than the report's` });
    }
    if (from.some((k) => k === "tipsPaidOutCash" || k === "tipsPaidOutStripe")) {
      const sum = exported("tipsPaidOutCash") + exported("tipsPaidOutStripe");
      if (!sameToTheCent(b.totals.tipsPaidOut, sum)) out.push({ shopId: b.shopId, column: COLUMN_LABEL.tipsPaidOut, check: "export", report: b.totals.tipsPaidOut, other: sum, detail: `${b.shop}: the export's tips paid out by Stripe and otherwise add up to a different total than the report's` });
    }
    for (const k of ["tipsInPayrollOwed", "tipsPaidOutStripe"] as const) {
      if (!from.includes(k)) continue;
      const want = b.lines.reduce((a, l) => a + (l[k] ?? 0), 0);
      const sum = exported(k);
      if (!sameToTheCent(want, sum)) out.push({ shopId: b.shopId, column: SPLIT_LABEL[k], check: "export", report: want, other: sum, detail: `${b.shop}: the export's ${SPLIT_LABEL[k].toLowerCase()} add up to a different total than the report's` });
    }
    if (!sameToTheCent(b.totals.tipsInPayroll + b.totals.tipsOutside, b.totals.tips))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.tips, check: "rows", report: b.totals.tips, other: b.totals.tipsInPayroll + b.totals.tipsOutside, detail: `${b.shop}: tips paid separately and in payroll don't add up to TIPS` });
    if (b.exportRows.length !== b.lines.length) out.push({ shopId: b.shopId, column: "Rows", check: "export", report: b.lines.length, other: b.exportRows.length, detail: `${b.shop}: the export has a different number of rows` });
  }
  for (const k of ["service", "laborCost", "otPay", "trainingPay", "totalWages", "hours", "otHours", "tips", "netComm", "declaredCashTips"] as const) {
    const sum = blocks.reduce((a, b) => a + b.totals[k], 0);
    if (!sameToTheCent(grand[k], sum)) out.push({ shopId: null, column: COLUMN_LABEL[k], check: "locations", report: grand[k], other: sum, detail: "Locations total isn't the sum of the shops" });
  }
  return out;
}

export function assemble(shops: readonly { shopId: string; shop: string; inputs: readonly LineInput[] }[], s: PayrollSettings, o: ExportOptions = {}) {
  const blocks: ShopBlock[] = shops.map((sh) => {
    const lines = sh.inputs.map((i) => computeLine(i, s));
    const exportFrom = exportExtraColumns(lines, s, o).map((c) => c.from);
    return { shopId: sh.shopId, shop: sh.shop, lines, totals: totalsOf(lines), exportRows: exportRows(lines, s, o), exportHeaders: exportHeaders(lines, s, o), exportFrom };
  });
  const grand = totalsOf(blocks.map((b) => b.totals));
  return { blocks, grand, mismatches: reconcile(blocks, grand) };
}

export interface FtStatus {
  staffId: string;
  averageHours: number;
  weeks: number;
  fullTime: boolean;
}

/** Full time = average weekly hours (on the chosen basis, over the window) strictly above the threshold. */
export function ftStatus(staffId: string, weekly: readonly { worked: number; training: number; pto: number }[], s: PayrollSettings): FtStatus {
  const weeks = Math.max(1, s.ftWindowWeeks);
  const window = weekly.slice(-weeks);
  const basis = (w: { worked: number; training: number; pto: number }) => w.worked + (s.ftBasis !== "worked" ? w.training : 0) + (s.ftBasis === "paid" ? w.pto : 0);
  const total = window.reduce((a, w) => a + basis(w), 0);
  const averageHours = Math.round((total / weeks) * 100) / 100;
  return { staffId, averageHours, weeks, fullTime: averageHours > s.ftHoursPerWeek };
}

export interface Anomaly {
  staffId: string | null;
  shopId: string | null;
  kind: "owner_case" | "sales_without_hours" | "override" | "netcomm_gap" | "missing_key" | "training_in_hours" | "no_rate" | "late_tip_refund" | "changed_since_lock" | "late_import" | "below_minimum_wage" | "meal_missed" | "no_work_state";
  message: string;
}

/** Things to look at before locking. None of these block the lock, and none are "fixed" automatically. */
export function anomalies(blocks: readonly ShopBlock[], s: PayrollSettings): Anomaly[] {
  const out: Anomaly[] = [];
  for (const b of blocks) {
    for (const l of b.lines) {
      const who = `${l.name} (${b.shop})`;
      if (l.input.employeeNumber === null) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "missing_key", message: `${who} has no iSolved Employee Number yet, so their Key cell would be blank.` });
      if (l.hours + l.otHours > 0 && l.laborCost === 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "owner_case", message: `${who}: ${fmtHours(l.hours + l.otHours)} at $0.00 labor cost. Owner or salaried? Left as is until Charles decides (Q17).` });
      if (l.hours + l.otHours === 0 && l.service > 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "sales_without_hours", message: `${who}: ${fmtMoney(l.service)} of service sales with no hours. Owner case? Left as is (Q17).` });
      if (!sameToTheCent(l.netComm, l.netCommComputed)) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "netcomm_gap", message: `${who}: NetComm ${fmtMoney(l.netComm)} was typed over the formula's ${fmtMoney(l.netCommComputed)}, a ${fmtMoney(Math.abs(l.netComm - l.netCommComputed))} gap between the report's Total Wages and the export's Comm Sales. Not fixed (Q17).` });
      for (const k of l.overridden) {
        if (k === "netComm") continue;
        out.push({ staffId: l.staffId, shopId: b.shopId, kind: "override", message: `${who}: ${OVERRIDE_LABEL[k]} typed by hand (${l.input.overrides?.[k]?.reason}).` });
      }
      if (l.trainingHours > 0 && !s.trainingCountsTowardOt) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "training_in_hours", message: `${who}: ${fmtHours(l.trainingHours)} training. If the clocked hours already include it, it's counted twice (Q11, C2 flag).` });
      if (l.wage === 0 && l.service > 0 && l.servicePct === 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "no_rate", message: `${who} has sales but no wage or commission rate.` });
      const late = l.lateTipRefunds ?? 0;
      if (late > 0) {
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "late_tip_refund",
          message: `${who}: ${fmtMoney(late)} of tips refunded on tickets from an earlier pay period, already paid. ${fmtMoney(late)} is the shop's cost, never taken from their pay. Review before locking.`,
        });
      }
    }
  }
  return out;
}

export const fmtMoney = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtHours = (x: number) => `${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}h`;
