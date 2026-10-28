/**
 * The Payroll Report math, row for row the workbook's Locations sheet (spec §2), plus the platform's
 * additions to the right of it: O.T. Pay, Training Pay and Labor Cost. Every total is a sum of the rows
 * below it; nothing is typed in or carried over.
 *
 * Money is dollars as JavaScript numbers (IEEE doubles, the same arithmetic Excel uses) and each
 * formula runs in the workbook's order, so an unrounded export matches the workbook to the last digit.
 */
import { formatPayHours, payrollHoursStyle } from "@/lib/hours";
import type { LocalDate } from "@/lib/time";
import { DEFAULT_BRAND_CALENDAR, calendarProblem, type PayCalendar } from "./calendar";

export interface PayrollSettings {
  /** Weekly overtime threshold: 40 under the federal FLSA. Iowa and Illinois appear to follow it with no daily rule; to confirm. */
  otThresholdHours: number;
  /** Optional daily overtime threshold (hours in one day). Null: weekly only. */
  dailyOtHours: number | null;
  /** For the report's OT Pay. iSolved computes the real (blended) OT itself. */
  otMultiplier: number;
  /** C2: training hours on top of clocked hours count toward the weekly 40; training inside clocked time is already there. Configurable until Charles answers Q11. */
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
  /**
   * The report's hours come from the time clock (Charles: the basic clock ships at launch). Payroll
   * can't be approved until every shop's timesheets are locked for each day of its pay period, which
   * in turn needs each one manager-approved with no missed punches. Off: hours typed in or imported.
   */
  hoursFromClock: boolean;
  /** How the iSolved files are formatted. The values are the same either way. */
  exportFormat: ExportFormat;
  /**
   * A shop's file name, pending Charles (Q9): {start} and {end} as MM.DD.YY, {startIso} and {endIso},
   * {shop} (its sheet name), {payGroup} and {period} (two digits). ".xlsx" is added.
   */
  exportFileName: string;
  /** The all-shops workbook's name: the same placeholders but {shop} and {payGroup}. */
  exportWorkbookName: string;
  /** The six standard columns' iSolved earning codes, character for character as in iSolved's client setup. */
  earningCodes: Record<EarningFrom, string>;
  /**
   * The earning code for card and gift card tips paid outside payroll. The same as the tips column
   * (the default) sends them with cash tips under Cash Tips Recd, as the workbook does; a different
   * one gives them their own column. Charles's and his CPA's to confirm (Q2).
   */
  cardTipsHeader: string;
  /** Where PTO hours come from (Q10). */
  ptoSource: HoursSource;
  /** Where training hours come from (Q10). */
  trainingSource: HoursSource;
  /** I10: what Service$ and Product$ count. The defaults are how it's always worked: the card surcharge left out, a loyalty reward taken off the sale (Q15). */
  commissionBase: CommissionBase;
  /**
   * C1, the FLSA regular rate: commission is part of the regular rate, so half-time is owed on it for
   * OT hours. The file carries OT hours only, and whether iSolved's Overtime 1.5 counts Comm Sales in
   * the rate is an iSolved setting nobody has confirmed. "base": the file is unchanged and the report
   * shows what's owed, to check in iSolved or enter by hand. "adjust": the file gets an OT premium
   * adjustment column (a format change: Needs Charles).
   */
  otRegularRate: OtRegularRate;
  /** That column's header, Charles's to confirm in iSolved. Added only when someone in the file has an adjustment. */
  otPremiumHeader: string;
  /** The Payroll Report's shop order, by name (the workbook's Locations tab); shops not listed follow, by name. */
  reportOrder: string[];
  /** The all-shops workbook's sheet order, by name (the workbook's tabs); shops not listed follow, by name. */
  sheetOrder: string[];
}

export interface CommissionBase {
  cardFee: "exclude" | "include";
  loyalty: "reduces" | "shop_absorbs";
}
export const CARD_FEE_BASE_LABEL: Record<CommissionBase["cardFee"], string> = {
  exclude: "Left out of commission (the surcharge is the shop's)",
  include: "Part of the sale commission is paid on",
};
export const LOYALTY_BASE_LABEL: Record<CommissionBase["loyalty"], string> = {
  reduces: "Comes off the sale commission is paid on",
  shop_absorbs: "The shop's cost: commission is paid on the price before the reward",
};

export type OtRegularRate = "base" | "adjust";
export const OT_REGULAR_RATE_LABEL: Record<OtRegularRate, string> = {
  base: "OT hours only, as today; the report shows what commission adds to OT, to check in iSolved",
  adjust: "Add an OT premium adjustment column to the iSolved file (format change)",
};

/**
 * uniform: `0.00` on columns C to H of every sheet, Arial 8, bold grey headers (the reference file).
 * workbook: each tab's own formatting, cell for cell as in Charles's workbook.
 */
export type ExportFormat = "uniform" | "workbook";
export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  uniform: "0.00 on every hours and dollars column (reference file)",
  workbook: "Each tab's own formatting, as in the workbook",
};

/**
 * clock: time entries only (clocked, added on Payroll → Hours, or imported); nobody types the value on the report.
 * manager: typed on the report by a manager, with a reason; time entries of that kind are left out.
 * both: time entries, and a manager can type over them with a reason.
 */
export type HoursSource = "clock" | "manager" | "both";
export const HOURS_SOURCE_LABEL: Record<HoursSource, string> = {
  clock: "Time entries only",
  manager: "Entered by a manager on the report",
  both: "Time entries, or a manager's entry with a reason",
};

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
  trainingCountsTowardOt: true,
  trainingPayInCost: false,
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
  hoursFromClock: true,
  exportFormat: "uniform",
  exportFileName: "{start}-{end} {shop}",
  exportWorkbookName: "Rayz Payroll {start}-{end}",
  earningCodes: {
    hours: "E_Regular_Hours",
    otHours: "E_Overtime 1.5_Hours",
    tipsOutside: "E_Cash Tips Recd_Dollars",
    netComm: "E_Comm Sales_Dollars",
    ptoHours: "E_Ray'z Paid Time_Hours",
    trainingHours: "E_Training_Hours",
  },
  cardTipsHeader: "E_Cash Tips Recd_Dollars",
  commissionBase: { cardFee: "exclude", loyalty: "reduces" },
  otRegularRate: "base",
  otPremiumHeader: "E_OT Premium Adj_Dollars",
  ptoSource: "both",
  trainingSource: "both",
  reportOrder: ["Utica", "Moline", "Kimberly", "Rock Island", "Silvis", "Coralville", "LeClaire"],
  sheetOrder: ["Rock Island", "Moline", "Silvis", "Coralville", "Utica", "Kimberly", "LeClaire"],
};

/** A file name pattern: printable, no path characters, at most 120 long. */
const pattern = (v: unknown, d: string) => (typeof v === "string" && v.trim() && !/[\\/:*?"<>|\u0000-\u001f]/.test(v) ? v.trim().slice(0, 120) : d);
const names = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? [...new Set(v.map((x) => x.trim()).filter(Boolean))].slice(0, 50) : d);

const header = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : d);

function calendarOf(v: unknown): PayCalendar {
  const c = (v && typeof v === "object" ? v : {}) as Partial<PayCalendar>;
  const d = DEFAULT_BRAND_CALENDAR;
  const cal: PayCalendar = {
    anchorStart: typeof c.anchorStart === "string" ? c.anchorStart : d.anchorStart,
    anchorNumber: typeof c.anchorNumber === "number" ? c.anchorNumber : d.anchorNumber,
    periodDays: typeof c.periodDays === "number" ? c.periodDays : d.periodDays,
    checkOffsetDays: typeof c.checkOffsetDays === "number" ? c.checkOffsetDays : d.checkOffsetDays,
    submitOffsetDays: 0,
    numberResetsYearly: typeof c.numberResetsYearly === "boolean" ? c.numberResetsYearly : d.numberResetsYearly,
  };
  cal.submitOffsetDays = typeof c.submitOffsetDays === "number" ? c.submitOffsetDays : Math.min(d.submitOffsetDays, cal.checkOffsetDays);
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
    hoursFromClock: bool(r.hoursFromClock, d.hoursFromClock),
    exportFormat: r.exportFormat && r.exportFormat in EXPORT_FORMAT_LABEL ? r.exportFormat : d.exportFormat,
    exportFileName: pattern(r.exportFileName, d.exportFileName),
    exportWorkbookName: pattern(r.exportWorkbookName, d.exportWorkbookName),
    earningCodes: Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.from, header((r.earningCodes as Partial<Record<EarningFrom, string>> | undefined)?.[c.from], d.earningCodes[c.from])])) as Record<EarningFrom, string>,
    cardTipsHeader: header(r.cardTipsHeader, d.cardTipsHeader),
    commissionBase: {
      cardFee: (r.commissionBase as Partial<CommissionBase> | undefined)?.cardFee === "include" ? "include" : "exclude",
      loyalty: (r.commissionBase as Partial<CommissionBase> | undefined)?.loyalty === "shop_absorbs" ? "shop_absorbs" : "reduces",
    },
    otRegularRate: r.otRegularRate === "adjust" ? "adjust" : "base",
    otPremiumHeader: header(r.otPremiumHeader, d.otPremiumHeader),
    ptoSource: r.ptoSource && r.ptoSource in HOURS_SOURCE_LABEL ? r.ptoSource : d.ptoSource,
    trainingSource: r.trainingSource && r.trainingSource in HOURS_SOURCE_LABEL ? r.trainingSource : d.trainingSource,
    reportOrder: names(r.reportOrder, d.reportOrder),
    sheetOrder: names(r.sheetOrder, d.sheetOrder),
  };
}

/** The six standard columns' headers as the brand set them. */
export const earningHeaders = (s: Pick<PayrollSettings, "earningCodes">) => EXPORT_COLUMNS.map((c) => s.earningCodes?.[c.from] ?? c.header);

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Shops in a configured order by name (spaces and case aside, so "Le Claire" is "LeClaire"); the rest after, by name. */
export function inNameOrder<T>(list: readonly T[], order: readonly string[], namesOf: (x: T) => string[]): T[] {
  const at = (x: T) => {
    const i = order.findIndex((o) => namesOf(x).some((n) => letters(n) === letters(o)));
    return i < 0 ? order.length : i;
  };
  return [...list].sort((a, b) => at(a) - at(b) || namesOf(a)[0].localeCompare(namesOf(b)[0]));
}

/** Values a manager can type over, each with a reason. The workbook had these as hand-typed cells. */
export const OVERRIDABLE = ["workedHours", "otHours", "serviceSales", "productSales", "tips", "netComm", "ptoHours", "trainingHours", "hourlyTotal"] as const;
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
  hourlyTotal: "Hourly Total",
};

/** A rate that changed inside the period, so the line's rate is a blend of the versions in effect (shown as "mixed"). */
export type MixedRate = "wage" | "servicePct" | "productPct";

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
  /** Of the training hours, those inside the employee's clocked worked time (C2): counted toward OT once, as worked hours. */
  trainingOverlapHours?: number;
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
  /** Sales tax collected on the employee's tickets. Reference only: never in any pay math or the export. */
  salesTax?: number;
  /** The profile's "export hours, $0 hourly pay" (the owner's row): hours go to iSolved, Hourly Total is $0. */
  zeroHourlyPay?: boolean;
  /** Rates blended from more than one effective-dated version in the period. */
  mixedRates?: MixedRate[];
  /** C1: the half-time commission adds to this line's overtime (the FLSA regular rate), from regularRateAdjustments. */
  otRegularRateAdj?: number;
  /** I2: commission owed for earlier, locked periods, paid in this one, each with the half-time it adds to that period's overtime. */
  lateCommissions?: LateCommission[];
  overrides?: Overrides;
}

export interface LateCommission {
  id?: string;
  earnedStart: LocalDate;
  earnedEnd: LocalDate;
  amount: number;
  reason: string;
  /** 0.5 × that period's OT hours here × amount ÷ its hours worked, from its locked figures. */
  retroOtPremium: number;
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
  /** Of tipsOutside, card and gift card tips: their own column only when card tips have their own earning code. */
  cardTipsOutside: number;
  /** Sales tax on the employee's tickets. Reference only. */
  salesTax: number;
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
  /** Of M and N, commission owed for earlier, locked periods (I2). */
  lateCommission?: number;
  /** C1 and I2: the half-time commission adds to overtime, this period's and locked periods' (retro). Owed whatever the file does. */
  otPremiumOwed?: number;
  /** Of that, what the iSolved file carries: all of it with the OT premium adjustment column on, else none (entered by hand). */
  otPremiumAdj: number;
  /** V = N + T + U (+ the guarantee top-up and the OT premium owed) */
  laborCost: number;
  /** Commission refunds took below zero this period (I4): the shop absorbs it. Absent in periods locked before. */
  commissionWrittenOff?: number;
  overridden: Overridable[];
}

const ov = (i: LineInput, k: Overridable, v: number) => i.overrides?.[k]?.value ?? v;

/** C6: an adjustment can add hours or overtime but never take away what the punches show. Fix the punches instead. */
export const belowPunches = (i: LineInput, k: "workedHours" | "otHours") => {
  const v = i.overrides?.[k]?.value;
  return v !== undefined && toCents(v) < toCents(i[k]);
};

export function computeLine(i: LineInput, s: PayrollSettings): Line {
  const worked = Math.max(i.workedHours, ov(i, "workedHours", i.workedHours));
  const otHours = Math.max(i.otHours, ov(i, "otHours", i.otHours));
  const hours = worked - otHours;
  const wage = i.hourlyRate;
  const payWage = i.zeroHourlyPay ? 0 : wage;
  const hourlyTotal = i.zeroHourlyPay ? 0 : ov(i, "hourlyTotal", hours * wage);
  const service = ov(i, "serviceSales", i.serviceSales);
  // I4: refunds in the period come off its commission before the greater-of; what would take H or L below zero is written off (shop absorbs), never carried forward.
  const commissionRaw = service * i.servicePct;
  const commission = Math.max(0, commissionRaw);
  const serviceTotal = commission - hourlyTotal;
  const product = ov(i, "productSales", i.productSales);
  const productRaw = product * i.productPct;
  const productTotal = Math.max(0, productRaw);
  const lateCommission = (i.lateCommissions ?? []).reduce((a, c) => a + c.amount, 0);
  const netCommComputed = (serviceTotal > 0 ? serviceTotal + productTotal : productTotal) + lateCommission;
  const netComm = ov(i, "netComm", netCommComputed);
  const totalWages = (serviceTotal > 0 ? hourlyTotal + serviceTotal : hourlyTotal) + productTotal + lateCommission;
  const otPremiumOwed = (i.otRegularRateAdj ?? 0) + (i.lateCommissions ?? []).reduce((a, c) => a + c.retroOtPremium, 0);
  const otPremiumAdj = s.otRegularRate === "adjust" ? otPremiumOwed : 0;
  const trainingHours = ov(i, "trainingHours", i.trainingHours);
  const otPay = s.otMultiplier * payWage * otHours;
  const tips = ov(i, "tips", i.tips);
  const tipsInPayroll = i.tipsInPayroll ?? 0;
  const tipsPaidOut = i.tipsPaidOut ?? 0;
  const between = (x: number | undefined, max: number) => (max >= 0 ? Math.min(max, Math.max(0, x ?? 0)) : 0);
  const tipsInPayrollOwed = between(i.owedTipsInPayroll, tipsInPayroll);
  const tipsPaidOutStripe = between(i.tipsPaidByStripe, tipsPaidOut);
  const trainingPay = s.trainingPayInCost ? (i.trainingRate ?? payWage) * trainingHours : 0;
  const guaranteeTopUp = i.guaranteeTopUp ?? 0;
  const chargedTips = Math.min(tips, Math.max(0, i.chargedTips ?? 0));
  const tipsOutside = tips - tipsInPayroll;
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
    tipsOutside,
    cardTipsOutside: Math.max(0, Math.min(tipsOutside, chargedTips - tipsInPayroll)),
    salesTax: i.salesTax ?? 0,
    tipsPaidOut,
    tipsPaidOutStripe,
    tipsPaidOutCash: tipsPaidOut - tipsPaidOutStripe,
    tipsInPayrollOwed,
    tipsInPayrollChosen: tipsInPayroll - tipsInPayrollOwed,
    declaredCashTips: i.declaredCashTips ?? 0,
    chargedTips,
    lateTipRefunds: i.lateTipRefunds ?? 0,
    tipRefundsShopCost: i.lateTipRefunds ?? 0,
    trainingHours,
    otPay,
    trainingPay,
    guaranteeTopUp,
    lateCommission,
    otPremiumOwed,
    otPremiumAdj,
    laborCost: totalWages + otPay + trainingPay + guaranteeTopUp + otPremiumOwed,
    commissionWrittenOff: commission - commissionRaw + (productTotal - productRaw),
    overridden: OVERRIDABLE.filter((k) => i.overrides?.[k] !== undefined),
  };
}

/**
 * C1: the FLSA regular rate includes commission (29 CFR 778.117), so overtime owes half-time on it
 * as well as on the wage iSolved pays it at. Per employee across every shop of the period: the
 * commission above hourly pay (I when positive, L and any guarantee top-up) over all hours worked,
 * the equal-per-hour allocation 778.120 allows, times (OT multiplier − 1) × each line's OT hours.
 * Equal per hour, a week's share of the commission follows its hours, so the period's figure is the
 * sum of its weeks'. By `${staffId}|${shopId}`.
 */
export function regularRateAdjustments(lines: readonly Line[], s: Pick<PayrollSettings, "otMultiplier">): Map<string, number> {
  const by = new Map<string, { extra: number; hours: number; lines: Line[] }>();
  for (const l of lines) {
    const p = by.get(l.staffId) ?? { extra: 0, hours: 0, lines: [] };
    p.extra += Math.max(0, l.serviceTotal) + l.productTotal + (l.guaranteeTopUp ?? 0);
    p.hours += l.hours + l.otHours;
    p.lines.push(l);
    by.set(l.staffId, p);
  }
  const out = new Map<string, number>();
  for (const p of by.values()) {
    if (p.hours <= 0 || p.extra <= 0) continue;
    for (const l of p.lines) if (l.otHours > 0) out.set(`${l.staffId}|${l.shopId}`, (s.otMultiplier - 1) * l.otHours * (p.extra / p.hours));
  }
  return out;
}

/** I2: the half-time a late commission adds to a locked period's overtime at a shop, from that period's figures there. */
export const retroOtPremiumFor = (amount: number, locked: Pick<Line, "hours" | "otHours"> | null, s: Pick<PayrollSettings, "otMultiplier">) =>
  locked && locked.otHours > 0 && locked.hours + locked.otHours > 0 ? (s.otMultiplier - 1) * locked.otHours * (amount / (locked.hours + locked.otHours)) : 0;

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
  "cardTipsOutside",
  "tipsPaidOut",
  "declaredCashTips",
  "chargedTips",
  "lateTipRefunds",
  "tipRefundsShopCost",
  "trainingHours",
  "otPay",
  "trainingPay",
  "guaranteeTopUp",
  "otPremiumAdj",
  "laborCost",
  "salesTax",
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
  cardTipsOutside: "Card tips paid separately",
  salesTax: "Sales tax (reference)",
  tipsPaidOut: "Tips paid out",
  declaredCashTips: "Cash tips declared",
  chargedTips: "Charged tips",
  lateTipRefunds: "Post-payout tip refunds",
  tipRefundsShopCost: "Tip refunds, shop cost",
  trainingHours: "Training Hours",
  otPay: "O.T. Pay",
  trainingPay: "Training Pay",
  guaranteeTopUp: "Guarantee top-up",
  otPremiumAdj: "O.T. premium adj.",
  laborCost: "Labor Cost",
};

/** Hours columns; the rest are dollars. */
export const HOUR_COLUMNS: ReadonlySet<string> = new Set(["hours", "ptoHours", "otHours", "trainingHours"]);

export function totalsOf(rows: readonly Pick<Line, Summed>[]): Totals {
  const t = Object.fromEntries(SUMMED.map((k) => [k, rows.reduce((a, r) => a + (r[k] ?? 0), 0)])) as Record<Summed, number>;
  return { ...t, grossPerHour: t.hours ? t.service / t.hours : null, pctOfGross: t.service ? t.totalWages / t.service : null, grossProfit: t.service - t.laborCost };
}

/**
 * The Locations tab's columns A to S, with its header text character for character (the trailing
 * space after "Hourly Total" and the two spaces in "Training  Hours" are the workbook's). Rates (C, G,
 * K) aren't totalled; Gross /Hr and Total % of Gross are worked out from the totals.
 */
export const LOCATIONS_COLUMNS = [
  { key: "name", header: "Employee Name", kind: "text" },
  { key: "hours", header: "Hours", kind: "hours" },
  { key: "wage", header: "Hourly Wage", kind: "rate" },
  { key: "hourlyTotal", header: "Hourly Total ", kind: "money" },
  { key: "service", header: "Service$", kind: "money" },
  { key: "grossPerHour", header: "Gross /Hr", kind: "ratio" },
  { key: "servicePct", header: "Service%", kind: "pct" },
  { key: "commission", header: "Commission$", kind: "money" },
  { key: "serviceTotal", header: "Service Total", kind: "money" },
  { key: "product", header: "Product$", kind: "money" },
  { key: "productPct", header: "Prod%", kind: "pct" },
  { key: "productTotal", header: "Product Total", kind: "money" },
  { key: "netComm", header: "NetComm", kind: "money" },
  { key: "totalWages", header: "Total Wages", kind: "money" },
  { key: "pctOfGross", header: "Total % of Gross", kind: "pct" },
  { key: "ptoHours", header: "PTO HRs.", kind: "hours" },
  { key: "otHours", header: "O.T. HRS", kind: "hours" },
  { key: "tips", header: "TIPS", kind: "money" },
  { key: "trainingHours", header: "Training  Hours", kind: "hours" },
] as const satisfies readonly { key: keyof Line | "name"; header: string; kind: "text" | "hours" | "rate" | "money" | "ratio" | "pct" }[];

export interface LocationSummaryRow {
  shopId: string | null;
  shop: string;
  /** ΣE */
  service: number;
  /** ΣN, the workbook's Employee Cost: Total Wages, without O.T. Pay or Training Pay. */
  employeeCost: number;
  /** ΣE − ΣN */
  grossProfit: number;
}

/**
 * The Locations tab's summary (rows 68–76): Service Sales, Employee Cost and Gross Profit per shop and
 * in total, every one a sum of all of its shop's rows (the workbook's ranges skip some, §8).
 */
export function locationSummary(blocks: readonly { shopId: string; shop: string; totals: Pick<Totals, "service" | "totalWages"> }[]): { rows: LocationSummaryRow[]; total: LocationSummaryRow } {
  const rows = blocks.map((b) => ({ shopId: b.shopId, shop: b.shop, service: b.totals.service, employeeCost: b.totals.totalWages, grossProfit: b.totals.service - b.totals.totalWages }));
  const service = rows.reduce((a, r) => a + r.service, 0);
  const employeeCost = rows.reduce((a, r) => a + r.employeeCost, 0);
  return { rows, total: { shopId: null, shop: "Total", service, employeeCost, grossProfit: service - employeeCost } };
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
/** What a standard column carries; its header is the brand's earning code for it. */
export type EarningFrom = (typeof EXPORT_COLUMNS)[number]["from"];

export interface ExportRow {
  staffId: string;
  key: string | number | null;
  isolvedName: string;
  values: number[];
}

const hasGuarantee = (lines: readonly Pick<Line, "guaranteeTopUp">[]) => lines.some((l) => (l.guaranteeTopUp ?? 0) !== 0);

/** What a column after the standard six carries. */
export type ExtraFrom =
  | "cardTipsOutside"
  | "tipsInPayroll"
  | "tipsInPayrollChosen"
  | "tipsInPayrollOwed"
  | "tipsPaidOut"
  | "tipsPaidOutCash"
  | "tipsPaidOutStripe"
  | "declaredCashTips"
  | "guaranteeTopUp"
  | "otPremiumAdj"
  | "commission"
  | "productTotal"
  | "wage";

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

/**
 * The columns after the standard six. Never a tip column: Charles keeps the file at the workbook's 8
 * columns with every tip in E_Cash Tips Recd_Dollars (separate tip codes declined). Only the
 * guarantee top-up when someone in the file has one, the OT premium when the brand adjusts it, and
 * the brand's own columns, each a compensation choice the brand makes.
 */
export function exportExtraColumns(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): ExtraColumn[] {
  return [
    ...(hasGuarantee(lines) ? [{ header: o.guaranteeHeader ?? COLUMN_LABEL.guaranteeTopUp, from: "guaranteeTopUp" as const }] : []),
    ...(s.otRegularRate === "adjust" && lines.some((l) => (l.otPremiumAdj ?? 0) !== 0) ? [{ header: s.otPremiumHeader, from: "otPremiumAdj" as const }] : []),
    ...(o.extras ?? []),
  ];
}

export function exportHeaders(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): string[] {
  return [...earningHeaders(s), ...exportExtraColumns(lines, s, o).map((c) => c.header)];
}

/** A standard column's value. E_Cash Tips Recd_Dollars is every tip: ticket tips however they're paid (drawer, Stripe or payroll) and declared cash tips. */
const standardValue = (l: Line, from: EarningFrom) => (from === "tipsOutside" ? cashTipsRecd(l) : l[from]);
export const cashTipsRecd = (l: Pick<Line, "tips" | "declaredCashTips">) => l.tips + (l.declaredCashTips ?? 0);

export function exportRows(lines: readonly Line[], s: PayrollSettings, o: ExportOptions = {}): ExportRow[] {
  const extra = exportExtraColumns(lines, s, o);
  const out = (x: number) => (s.roundExport2dp ? roundHalfUp2(x) : x);
  return lines.map((l) => ({
    staffId: l.staffId,
    key: l.input.employeeNumber === null ? null : l.input.keyIsText || !/^\d+$/.test(l.input.employeeNumber) ? l.input.employeeNumber : Number(l.input.employeeNumber),
    isolvedName: l.input.isolvedName,
    values: [...EXPORT_COLUMNS.map((c) => out(standardValue(l, c.from))), ...extra.map((c) => out(l[c.from] ?? 0))],
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
  /** Sales at the shop with no employee on them (Squire's "Unassigned sales"): credited to nobody, shown as a warning. */
  unassigned?: { serviceSales: number; productSales: number; salesTax: number };
}

/** A file from before the 8-column rule, with tips split across their own columns: checked against its own layout. */
export const hasTipColumns = (from: readonly ExtraFrom[]) => from.some((k) => PAYROLL_TIP_COLUMNS.includes(k) || PAID_TIP_COLUMNS.includes(k) || k === "cardTipsOutside" || k === "declaredCashTips");

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
  cardTipsOutside: "tips",
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
    const from = extraFromOf(b);
    const cardSplit = from.includes("cardTipsOutside");
    const tipColumns = hasTipColumns(from);
    EXPORT_COLUMNS.forEach((c, i) => {
      const header = b.exportHeaders?.[i] ?? c.header;
      const want = c.from !== "tipsOutside" ? b.totals[c.from] : !tipColumns ? cashTipsRecd(b.totals) : cardSplit ? b.totals.tipsOutside - (b.totals.cardTipsOutside ?? 0) : b.totals.tipsOutside;
      const sum = b.exportRows.reduce((a, r) => a + r.values[i], 0);
      if (!sameToTheCent(want, sum)) out.push({ shopId: b.shopId, column: header, check: "export", report: want, other: sum, detail: `${b.shop}: export ${header} adds up to a different total than the report's ${COLUMN_LABEL[c.from]}` });
    });
    const exported = (k: ExtraFrom) => {
      const i = from.indexOf(k);
      return i < 0 ? 0 : b.exportRows.reduce((a, r) => a + (r.values[EXPORT_COLUMNS.length + i] ?? 0), 0);
    };
    const payrollTips = PAYROLL_TIP_COLUMNS.reduce((a, k) => a + exported(k), 0);
    if (tipColumns && !sameToTheCent(b.totals.tipsInPayroll, payrollTips))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.tipsInPayroll, check: "export", report: b.totals.tipsInPayroll, other: payrollTips, detail: `${b.shop}: the export's tips paid in payroll add up to a different total than the report's` });
    const topUps = exported("guaranteeTopUp");
    if (!sameToTheCent(b.totals.guaranteeTopUp ?? 0, topUps))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.guaranteeTopUp, check: "export", report: b.totals.guaranteeTopUp ?? 0, other: topUps, detail: `${b.shop}: the export's guarantee top-ups add up to a different total than the report's` });
    const declared = exported("declaredCashTips");
    if (tipColumns && !sameToTheCent(b.totals.declaredCashTips ?? 0, declared))
      out.push({ shopId: b.shopId, column: COLUMN_LABEL.declaredCashTips, check: "export", report: b.totals.declaredCashTips ?? 0, other: declared, detail: `${b.shop}: the export's declared cash tips add up to a different total than the report's` });
    for (const k of ["tipsPaidOut", "commission", "productTotal", "cardTipsOutside", "otPremiumAdj"] as const) {
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

export function assemble(shops: readonly { shopId: string; shop: string; inputs: readonly LineInput[]; unassigned?: ShopBlock["unassigned"] }[], s: PayrollSettings, o: ExportOptions = {}) {
  const blocks: ShopBlock[] = shops.map((sh) => {
    const lines = sh.inputs.map((i) => computeLine(i, s));
    const exportFrom = exportExtraColumns(lines, s, o).map((c) => c.from);
    return {
      shopId: sh.shopId,
      shop: sh.shop,
      lines,
      totals: totalsOf(lines),
      exportRows: exportRows(lines, s, o),
      exportHeaders: exportHeaders(lines, s, o),
      exportFrom,
      ...(sh.unassigned ? { unassigned: sh.unassigned } : {}),
    };
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
  kind: AnomalyKind;
  message: string;
}

export type AnomalyKind =
  | "owner_case"
  | "sales_without_hours"
  | "override"
  | "below_punches"
  | "netcomm_gap"
  | "missing_key"
  | "training_in_hours"
  | "no_rate"
  | "late_tip_refund"
  | "tip_refunded_after_export"
  | "late_tip"
  | "final_pay"
  | "final_pay_changed"
  | "refund_written_off"
  | "late_commission"
  | "ot_regular_rate"
  | "changed_since_lock"
  | "late_import"
  | "below_minimum_wage"
  | "meal_missed"
  | "no_work_state"
  | "missed_punch"
  | "timesheet_not_approved"
  | "hours_not_locked"
  | "sales_day_without_hours"
  | "hours_not_from_clock"
  | "unassigned_sales"
  | "mixed_rates"
  | "hours_source"
  | "cross_source_ot"
  | "rollout_source"
  | "tips_in_payroll_memo";

export const MIXED_RATE_NAME: Record<MixedRate, string> = { wage: "hourly wage", servicePct: "service %", productPct: "product %" };

/** Things to look at before locking. None of these block the lock, and none are "fixed" automatically. */
export function anomalies(blocks: readonly ShopBlock[], s: PayrollSettings): Anomaly[] {
  const out: Anomaly[] = [];
  for (const b of blocks) {
    const u = b.unassigned;
    if (u && (u.productSales || u.serviceSales))
      out.push({
        staffId: null,
        shopId: b.shopId,
        kind: "unassigned_sales",
        message: `${b.shop}: ${[u.productSales ? `${fmtMoney(u.productSales)} of product sales` : "", u.serviceSales ? `${fmtMoney(u.serviceSales)} of service sales` : ""].filter(Boolean).join(" and ")} with no employee on the ticket, so no one is paid commission on them. Put the employee on the ticket to credit them.`,
      });
    for (const l of b.lines) {
      const who = `${l.name} (${b.shop})`;
      if (l.input.employeeNumber === null) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "missing_key", message: `${who} has no iSolved Employee Number yet, so their Key cell would be blank.` });
      if (l.hours + l.otHours > 0 && l.laborCost === 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "owner_case", message: `${who}: ${fmtHours(l.hours + l.otHours)} at $0.00 labor cost. Owner or salaried? Left as is until Charles decides (Q17).` });
      if (l.hours + l.otHours === 0 && l.service > 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "sales_without_hours", message: `${who}: ${fmtMoney(l.service)} of service sales with no hours. A missed clock-in, or an owner (Q17)? Left as is.` });
      if (!sameToTheCent(l.netComm, l.netCommComputed)) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "netcomm_gap", message: `${who}: NetComm ${fmtMoney(l.netComm)} was typed over the formula's ${fmtMoney(l.netCommComputed)}, a ${fmtMoney(Math.abs(l.netComm - l.netCommComputed))} gap between the report's Total Wages and the export's Comm Sales. Not fixed (Q17).` });
      for (const k of l.overridden) {
        if (k === "netComm") continue;
        out.push({ staffId: l.staffId, shopId: b.shopId, kind: "override", message: `${who}: ${OVERRIDE_LABEL[k]} typed by hand (${l.input.overrides?.[k]?.reason}).` });
      }
      for (const k of ["workedHours", "otHours"] as const)
        if (belowPunches(l.input, k))
          out.push({
            staffId: l.staffId,
            shopId: b.shopId,
            kind: "below_punches",
            message: `${who}: ${OVERRIDE_LABEL[k]} typed as ${fmtHours(l.input.overrides![k]!.value)}, below the ${fmtHours(l.input[k])} the punches show. The report pays the punches' ${fmtHours(l.input[k])}; fix the punches on the timesheet if they're wrong.`,
          });
      const overlap = l.input.trainingOverlapHours ?? 0;
      if (overlap > 0)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "training_in_hours",
          message: `${who}: ${fmtHours(overlap)} of training falls inside their clocked hours, so it's paid as both worked and training time. It counts toward overtime once. Fix the training entry if it's the same time.`,
        });
      else if (l.trainingHours > 0 && !s.trainingCountsTowardOt)
        out.push({ staffId: l.staffId, shopId: b.shopId, kind: "training_in_hours", message: `${who}: ${fmtHours(l.trainingHours)} training, left out of the weekly 40 (training toward overtime is off, Q11).` });
      if (l.wage === 0 && l.service > 0 && l.servicePct === 0) out.push({ staffId: l.staffId, shopId: b.shopId, kind: "no_rate", message: `${who} has sales but no wage or commission rate.` });
      const mixed = l.input.mixedRates ?? [];
      if (mixed.length)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "mixed_rates",
          message: `${who}: the ${mixed.map((k) => MIXED_RATE_NAME[k]).join(" and ")} changed during the period, so each sale is paid at the rate in effect on its checkout date and each day's hours at that day's wage. The report shows "mixed".`,
        });
      for (const c of l.input.lateCommissions ?? [])
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "late_commission",
          message: `${who}: ${fmtMoney(c.amount)} of commission earned ${c.earnedStart} to ${c.earnedEnd}, already locked, is paid in this period's Comm Sales (${c.reason}).${c.retroOtPremium > 0 ? ` It adds ${fmtMoney(c.retroOtPremium)} of half-time to that period's overtime.` : ""}`,
        });
      const owed = l.otPremiumOwed ?? 0;
      if (owed >= 0.005 && s.otRegularRate !== "adjust")
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "ot_regular_rate",
          message: `${who}: commission raises their regular rate for overtime by ${fmtMoney(owed)} of half-time. Unless iSolved's Overtime 1.5 counts Comm Sales in the rate, enter it in iSolved by hand (C1, Needs Charles).`,
        });
      const off = l.commissionWrittenOff ?? 0;
      if (off > 0.000001)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "refund_written_off",
          message: `${who}: refunds this period came to more than the commission they'd earned, by ${fmtMoney(off)}. Commission is $0.00 (never negative) and the ${fmtMoney(off)} is written off: the shop absorbs it and it's never taken from a later check.`,
        });
      if (l.tipsInPayroll > 0)
        out.push({
          staffId: l.staffId,
          shopId: b.shopId,
          kind: "tips_in_payroll_memo",
          message: `${who}: ${fmtMoney(l.tipsInPayroll)} of tips to be paid through payroll. The iSolved file reports every tip in E_Cash Tips Recd_Dollars, which iSolved doesn't pay in the check, so pay these outside payroll (drawer or Stripe) before locking.`,
        });
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
export const fmtHours = (x: number) => (payrollHoursStyle() === "hm" ? formatPayHours(x) : `${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}h`);
