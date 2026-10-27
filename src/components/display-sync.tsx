"use client";

import { setPayrollHoursStyle, type PayrollHoursStyle } from "@/lib/hours";
import { setClockFormat, type ClockFormat } from "@/lib/time";

/**
 * Puts the brand's time format and payroll hours style into the browser's formatters. It renders
 * ahead of the page, so every component below it formats the same way the server did.
 */
export function DisplaySync({ clockFormat, payrollHours }: { clockFormat: ClockFormat; payrollHours: PayrollHoursStyle }) {
  setClockFormat(clockFormat);
  setPayrollHoursStyle(payrollHours);
  return null;
}
