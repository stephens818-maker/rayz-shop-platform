import type { PayrollHoursStyle } from "@/lib/hours";
import type { TimeFormat } from "@/lib/time";

export type { PayrollHoursStyle };

/**
 * How the brand shows times and hours: `time_format` (brand_settings.time_format, shared with the
 * customer API) and payroll hours (brand_settings.display). Times are stored as UTC instants and
 * always shown in the shop's zone; these only change how they read.
 */
export const PAYROLL_HOURS_STYLES: readonly PayrollHoursStyle[] = ["decimal", "hm"];
export const PAYROLL_HOURS_LABEL: Record<PayrollHoursStyle, string> = {
  decimal: "Decimal hours (78.25), like the payroll workbook",
  hm: "Hours and minutes (78h 15m)",
};

export interface DisplaySettings {
  /** Every time of day on screen, in the staff app, in messages and in readable exports. Squire showed 24-hour; Charles wants 12-hour. */
  timeFormat: TimeFormat;
  /** Payroll hours on the Payroll Report, timesheets and pay screens. The iSolved file always has decimal hours. */
  payrollHours: PayrollHoursStyle;
}

export const DEFAULT_DISPLAY: DisplaySettings = { timeFormat: "12h", payrollHours: "decimal" };

/** The `time_format` column as read: anything but "24h" is 12-hour. */
export function timeFormatOf(v: unknown): TimeFormat {
  return v === "24h" ? "24h" : "12h";
}

export function displaySettings(raw: unknown): DisplaySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    timeFormat: timeFormatOf(r.timeFormat),
    payrollHours: PAYROLL_HOURS_STYLES.includes(r.payrollHours as PayrollHoursStyle) ? (r.payrollHours as PayrollHoursStyle) : DEFAULT_DISPLAY.payrollHours,
  };
}
