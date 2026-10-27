/** Payroll hours on screen: decimal like the payroll workbook (79.94), or hours and minutes (79h 56m). */
export type PayrollHoursStyle = "decimal" | "hm";

const HOURS_KEY = "__rayzPayrollHours";
type HoursGlobal = { [HOURS_KEY]?: PayrollHoursStyle };

export function payrollHoursStyle(): PayrollHoursStyle {
  return (globalThis as HoursGlobal)[HOURS_KEY] === "hm" ? "hm" : "decimal";
}

export function setPayrollHoursStyle(s: PayrollHoursStyle): void {
  (globalThis as HoursGlobal)[HOURS_KEY] = s === "hm" ? "hm" : "decimal";
}

/**
 * Hours as the brand shows them: "79.94" (two decimals) or "79h 56m". `unit` adds " h" (or the
 * word given, "hours") to the decimal form; hours and minutes always carry their own units.
 */
export function formatPayHours(hours: number, o: { unit?: boolean | string; style?: PayrollHoursStyle; decimals?: number } = {}): string {
  const style = o.style ?? payrollHoursStyle();
  if (style === "hm") {
    const total = Math.round(Math.abs(hours) * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    const sign = hours < 0 && total > 0 ? "-" : "";
    return `${sign}${h}h${m ? ` ${String(m).padStart(2, "0")}m` : ""}`;
  }
  const d = o.decimals ?? 2;
  const s = hours.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return o.unit ? `${s} ${o.unit === true ? "h" : o.unit}` : s;
}
