/**
 * State wage-hour rules by where the work is done (ST-I16). A shop's work state is the state in its
 * address; every punch, time entry and payroll line belongs to one shop, so each hour is under that
 * state's rules and its withholding, whatever state the employee lives in. Ray'z works in Illinois
 * (Moline, Rock Island, Silvis) and Iowa; a state not listed here falls back to the federal minimum
 * and no state extras. The CPA confirms the rates and accrual method each January.
 */
import type { LocalDate } from "@/lib/time";

export interface MinimumWageStep {
  from: LocalDate;
  cents: number;
}

/** Earned paid leave: an hour per `hoursWorkedPerHour` worked there, usable once employed `usableAfterDays`. */
export interface PaidLeaveRule {
  law: string;
  hoursWorkedPerHour: number;
  /** The most that accrues in a year; the employer may cap a year's use at this too. */
  capHoursPerYear: number;
  usableAfterDays: number;
}

/** A meal period of `minutes`, starting no later than `startByHours` into a shift of `afterHours` or more, and another for each `extraEveryHours` beyond. */
export interface MealPeriodRule {
  law: string;
  minutes: number;
  afterHours: number;
  startByHours: number;
  extraEveryHours: number;
}

export interface StateRules {
  state: string;
  name: string;
  minimumWage: readonly MinimumWageStep[];
  paidLeave: PaidLeaveRule | null;
  mealPeriod: MealPeriodRule | null;
}

export const FEDERAL_MINIMUM_WAGE: readonly MinimumWageStep[] = [{ from: "2009-07-24", cents: 725 }];

export const STATE_RULES: Record<string, StateRules> = {
  IL: {
    state: "IL",
    name: "Illinois",
    minimumWage: [
      { from: "2023-01-01", cents: 1300 },
      { from: "2024-01-01", cents: 1400 },
      { from: "2025-01-01", cents: 1500 },
    ],
    paidLeave: { law: "Paid Leave for All Workers Act", hoursWorkedPerHour: 40, capHoursPerYear: 40, usableAfterDays: 90 },
    mealPeriod: { law: "One Day Rest in Seven Act", minutes: 20, afterHours: 7.5, startByHours: 5, extraEveryHours: 4.5 },
  },
  IA: {
    state: "IA",
    name: "Iowa",
    minimumWage: [{ from: "2008-01-01", cents: 725 }],
    paidLeave: null,
    mealPeriod: null,
  },
};

const FEDERAL: StateRules = { state: "US", name: "Federal", minimumWage: FEDERAL_MINIMUM_WAGE, paidLeave: null, mealPeriod: null };

/** The two-letter state of a shop's address, or null when it isn't one. */
export function workStateOf(addressState: string | null | undefined): string | null {
  const s = (addressState ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

export const rulesFor = (state: string | null | undefined): StateRules => (state && STATE_RULES[state]) || FEDERAL;

/** The higher of the state and federal minimum wage on a date, in cents an hour. */
export function minimumWageCents(state: string | null | undefined, on: LocalDate): number {
  const at = (steps: readonly MinimumWageStep[]) => [...steps].reverse().find((x) => x.from <= on)?.cents ?? 0;
  return Math.max(at(FEDERAL_MINIMUM_WAGE), at(rulesFor(state).minimumWage));
}

/**
 * How far straight-time pay falls short of the minimum wage over the hours paid: hourly, commission
 * and product pay, training and any guarantee top-up, and overtime hours at the straight rate. Tips
 * never count (no tip credit is taken). Zero when it doesn't.
 */
export function minimumWageShortfallCents(straightTimeCents: number, hoursPaid: number, minimumCents: number): number {
  if (hoursPaid <= 0) return 0;
  return Math.max(0, Math.round(hoursPaid * minimumCents) - straightTimeCents);
}

export interface PaidLeaveYear {
  workedHours: number;
  accruedHours: number;
  usedHours: number;
  carriedInHours: number;
  balanceHours: number;
  /** The accrual cap was reached this year. */
  capped: boolean;
}

const h2 = (x: number) => Math.round(x * 100) / 100;

/** One year of earned paid leave: accrued from hours worked (to the cap), plus what carried in, less what was used. */
export function paidLeaveYear(rule: PaidLeaveRule, v: { workedHours: number; usedHours: number; carriedInHours: number }): PaidLeaveYear {
  const raw = v.workedHours / rule.hoursWorkedPerHour;
  const accrued = h2(Math.min(rule.capHoursPerYear, raw));
  const balance = h2(Math.max(0, v.carriedInHours + accrued - v.usedHours));
  return { workedHours: h2(v.workedHours), accruedHours: accrued, usedHours: h2(v.usedHours), carriedInHours: h2(v.carriedInHours), balanceHours: balance, capped: raw >= rule.capHoursPerYear };
}

export interface MealShift {
  start: Date;
  end: Date | null;
  breaks: readonly { start: Date; end: Date | null }[];
}

export interface MealCheck {
  /** Meal periods the shift needs so far (0 under the threshold). */
  needed: number;
  /** Breaks of the full length taken (an open one counts once it's long enough). */
  taken: number;
  /** When the first meal period has to start by. */
  firstDueBy: Date;
  /** A closed shift that needed one and didn't get it, or got it late. */
  missed: boolean;
}

const HOUR = 3_600_000;

/** A shift against the state's meal period rule. `now` stands in for the end of an open shift. */
export function mealCheck(rule: MealPeriodRule, s: MealShift, now: Date): MealCheck {
  const end = s.end ?? now;
  const hours = (end.getTime() - s.start.getTime()) / HOUR;
  const needed = hours < rule.afterHours ? 0 : 1 + Math.floor((hours - rule.afterHours) / rule.extraEveryHours);
  const full = s.breaks.filter((b) => ((b.end ?? now).getTime() - b.start.getTime()) / 60_000 >= rule.minutes);
  const firstDueBy = new Date(s.start.getTime() + rule.startByHours * HOUR);
  const onTime = full.length > 0 && full[0].start <= firstDueBy;
  return { needed, taken: full.length, firstDueBy, missed: s.end !== null && needed > 0 && (full.length < needed || !onTime) };
}

/** An open shift still owed its first meal period, `leadMinutes` before it has to start: the moment to prompt. */
export function mealPromptDue(rule: MealPeriodRule, s: MealShift, now: Date, leadMinutes = 30): boolean {
  if (s.end !== null) return false;
  const started = s.breaks.some((b) => ((b.end ?? now).getTime() - b.start.getTime()) / 60_000 >= rule.minutes || b.end === null);
  if (started) return false;
  const promptAt = s.start.getTime() + rule.startByHours * HOUR - leadMinutes * 60_000;
  return now.getTime() >= promptAt && now.getTime() < s.start.getTime() + rule.startByHours * HOUR + HOUR;
}
