import type { PayrollHoursStyle } from "@/lib/hours";
import { CLOCK_FORMATS, type ClockFormat } from "@/lib/time";

export type { PayrollHoursStyle };

/**
 * How the brand shows times and hours (brand_settings.display). Times are stored as UTC instants
 * and always shown in the shop's zone; these only change how they read.
 */
export const PAYROLL_HOURS_STYLES: readonly PayrollHoursStyle[] = ["decimal", "hm"];
export const PAYROLL_HOURS_LABEL: Record<PayrollHoursStyle, string> = {
  decimal: "Decimal hours (79.94), like the payroll workbook",
  hm: "Hours and minutes (79h 56m)",
};

export interface DisplaySettings {
  /** Every time of day on screen, in the staff app, in messages and in readable exports. Squire showed 24-hour; Charles wants 12-hour. */
  clockFormat: ClockFormat;
  /** Payroll hours on the Payroll Report, timesheets and pay screens. The iSolved file always has decimal hours. */
  payrollHours: PayrollHoursStyle;
}

export const DEFAULT_DISPLAY: DisplaySettings = { clockFormat: "12h", payrollHours: "decimal" };

export function displaySettings(raw: unknown): DisplaySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    clockFormat: CLOCK_FORMATS.includes(r.clockFormat as ClockFormat) ? (r.clockFormat as ClockFormat) : DEFAULT_DISPLAY.clockFormat,
    payrollHours: PAYROLL_HOURS_STYLES.includes(r.payrollHours as PayrollHoursStyle) ? (r.payrollHours as PayrollHoursStyle) : DEFAULT_DISPLAY.payrollHours,
  };
}
