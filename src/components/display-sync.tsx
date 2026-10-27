"use client";

import { setPayrollHoursStyle, type PayrollHoursStyle } from "@/lib/hours";
import { setTimeFormat, type TimeFormat } from "@/lib/time";

/**
 * Puts the brand's time format and payroll hours style into the browser's formatters. It renders
 * ahead of the page, so every component below it formats the same way the server did.
 */
export function DisplaySync({ timeFormat, payrollHours }: { timeFormat: TimeFormat; payrollHours: PayrollHoursStyle }) {
  setTimeFormat(timeFormat);
  setPayrollHoursStyle(payrollHours);
  return null;
}
