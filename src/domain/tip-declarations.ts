/**
 * Cash tip declarations (SB-C3): employees report the cash tips handed to them, which never touch a
 * ticket, so payroll can report and tax them. The IRS wants them monthly, by the 10th of the next
 * month, once they reach $20 in a month (Form 4070 or an electronic system with an attestation; the
 * CPA and iSolved confirm). Pure, so the rules are tested without a database (tests/tip-declarations.test.ts).
 */
import { addDays, type LocalDate } from "@/lib/time";
import type { TipDeclarationSettings } from "./payroll/calc";

/** The IRS's monthly reporting threshold, in cents. */
export const MONTHLY_REPORT_CENTS = 2000;
export const MAX_DECLARATION_CENTS = 1_000_000;

export const monthOf = (d: LocalDate) => d.slice(0, 7);
const firstOf = (month: string): LocalDate => `${month}-01`;
const nextMonth = (month: string) => monthOf(addDays(firstOf(month), 32));
export const lastMonthOf = (today: LocalDate) => monthOf(addDays(firstOf(monthOf(today)), -1));

/** The last day a month's declarations are open to employees: the lock day of the next month. */
export function closesOn(date: LocalDate, s: Pick<TipDeclarationSettings, "lockDay">): LocalDate {
  return `${nextMonth(monthOf(date))}-${String(s.lockDay).padStart(2, "0")}`;
}

export const monthClosed = (date: LocalDate, today: LocalDate, s: Pick<TipDeclarationSettings, "lockDay">) => today > closesOn(date, s);

/** From the 1st to the reminder day, for anyone who hasn't declared anything for last month. */
export const reminderDue = (today: LocalDate, s: Pick<TipDeclarationSettings, "enabled" | "remindUntilDay">, declaredLastMonth: boolean) =>
  s.enabled && !declaredLastMonth && Number(today.slice(8, 10)) <= s.remindUntilDay;

export interface DeclarationAttempt {
  businessDate: LocalDate;
  amountCents: number;
  attested: boolean;
  /** A manager correcting one, with a reason: allowed after the month closes. */
  manager: boolean;
  reason?: string | null;
  /** The pay period it's paid in is approved and locked at the shop: the day's, or for a correction the one the declaration it corrects was paid in. */
  periodLocked: boolean;
  /** Correcting an earlier declaration. */
  correction?: boolean;
}

export function declarationProblem(a: DeclarationAttempt, today: LocalDate, s: TipDeclarationSettings): string | null {
  if (!s.enabled) return "Cash tip declarations are turned off.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.businessDate)) return "Pick the day you got the tips.";
  if (a.businessDate > today) return "You can't declare tips for a day that hasn't happened yet.";
  if (!Number.isInteger(a.amountCents) || a.amountCents < 0 || a.amountCents > MAX_DECLARATION_CENTS) return "Enter an amount from $0 to $10,000.";
  if (!a.attested) return "Check the box to declare these are all your cash tips.";
  if (a.periodLocked && a.correction) return "That declaration was paid in a pay period that's already locked, so it stays as it is. Declare any more cash tips as a new declaration: they're paid in the next open period.";
  if (monthClosed(a.businessDate, today, s) && !a.manager) return `Declarations for that month closed on the ${ordinal(s.lockDay)}. Ask a manager to correct it.`;
  if (a.manager && !(a.reason ?? "").trim()) return "Say why it's being entered or corrected.";
  return null;
}

export const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
