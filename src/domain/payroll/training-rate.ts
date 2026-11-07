/**
 * Training pay (Charles, Oct 28): training is paid at its own flat hourly training rate, per employee
 * and effective-dated on their Staff page, and never enters commission or the greater-of. Training
 * pay is training hours × that rate, its own line on the Payroll Report, in Labor Cost. Pure: rates
 * are cents, dates shop-local.
 */
import { isValidLocalDate, type LocalDate } from "@/lib/time";
import type { TrainingRateSource } from "./calc";

export interface TrainingRateVersion {
  effectiveFrom: LocalDate;
  rateCents: number;
}

/** $500 an hour, as Payroll setup's rates. */
export const MAX_TRAINING_RATE_CENTS = 50_000;

/** Newest first. */
export const sortTrainingRates = <T extends TrainingRateVersion>(vs: readonly T[]): T[] => [...vs].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

/** The version in effect on a date, from versions sorted newest first. */
export const trainingRateOn = <T extends TrainingRateVersion>(sorted: readonly T[], date: LocalDate): T | null => sorted.find((v) => v.effectiveFrom <= date) ?? null;

export interface TrainingRate {
  /** Dollars an hour, hours-weighted when it changed during the period. Null: their hourly rate. */
  rate: number | null;
  source: TrainingRateSource;
  /** The rate changed during the period, so each day's training is paid at that day's rate. */
  mixed: boolean;
}

/**
 * A line's training rate for a pay period: each day's training at the rate in effect that day (their
 * Staff page), else Payroll setup's training rate, else their hourly rate. Hours-weighted when that
 * differs between days, so hours × rate is what each day's training earned. With no training days
 * (hours typed on the report, or a Squire import), the rate on the period's last day. The source is
 * the weakest any day used, so a day at the hourly rate is flagged.
 */
export function trainingRateFor(o: { days: readonly { date: LocalDate; centi: number }[]; versions: readonly TrainingRateVersion[]; setupRate: number | null; hourlyRate: number; end: LocalDate }): TrainingRate {
  const sorted = sortTrainingRates(o.versions);
  const on = (date: LocalDate) => {
    const v = trainingRateOn(sorted, date);
    if (v) return { rate: v.rateCents / 100, source: "staff" as const };
    if (o.setupRate !== null) return { rate: o.setupRate, source: "payroll_setup" as const };
    return { rate: null, source: "hourly" as const };
  };
  const rated = o.days.filter((d) => d.centi > 0).map((d) => ({ ...d, ...on(d.date) }));
  if (!rated.length) return { ...on(o.end), mixed: false };
  const source: TrainingRateSource = rated.some((d) => d.source === "hourly") ? "hourly" : rated.some((d) => d.source === "payroll_setup") ? "payroll_setup" : "staff";
  const dollars = (d: (typeof rated)[number]) => d.rate ?? o.hourlyRate;
  if (rated.every((d) => d.rate === rated[0].rate)) return { rate: rated[0].rate, source, mixed: false };
  const centi = rated.reduce((a, d) => a + d.centi, 0);
  return { rate: rated.reduce((a, d) => a + d.centi * dollars(d), 0) / centi, source, mixed: true };
}

/** What's wrong with a new training rate version, or null. Versions are history: a change starts after the last locked pay period. */
export function trainingRateProblem(v: TrainingRateVersion, c: { lockedThrough: LocalDate | null; existing: readonly TrainingRateVersion[] }): string | null {
  if (!isValidLocalDate(v.effectiveFrom)) return "Pick the date the rate starts";
  if (c.lockedThrough && v.effectiveFrom <= c.lockedThrough) return `A training rate has to start after the last locked pay period, which ended ${c.lockedThrough}`;
  if (!Number.isInteger(v.rateCents) || v.rateCents < 0 || v.rateCents > MAX_TRAINING_RATE_CENTS) return "The training rate is $0 to $500 an hour";
  if (c.existing.some((x) => x.effectiveFrom === v.effectiveFrom)) return "There's already a training rate starting that day. Delete it first if it hasn't started.";
  return null;
}
