import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PAYROLL_SETTINGS, assemble, inNameOrder, type LineInput, type Overrides } from "@/domain/payroll/calc";

/**
 * Charles's payroll workbook, reproduced. `anon` is committed: fictional names, keys, rates, hours and
 * sales with the workbook's formula branches, typed cells and zeros (scripts/payroll-golden-anonymize.py).
 * `private` is the real workbook's golden data, gitignored and present only on machines it was copied to.
 */
export const ROOT = path.join(__dirname, "fixtures/payroll-golden");
export const FIXTURES = [
  { name: "anonymized (committed)", dir: path.join(ROOT, "anon"), real: false },
  { name: "real (local only)", dir: path.join(ROOT, "private"), real: true },
].map((f) => ({ ...f, present: existsSync(path.join(f.dir, "golden.json")) && existsSync(path.join(f.dir, "expected_isolved_export.xlsx")) }));

export type Cached = number | null | "#DIV/0!";
export interface GoldenRow {
  inputs: {
    location: string;
    row: number;
    name: string;
    feed_hours: number;
    ot_hours: number;
    hours: number;
    wage: number;
    service: number;
    service_pct: number;
    product: number;
    prod_pct: number;
    pto_hours: number;
    training_hours: number;
    tips: number;
    hourly_total_override: number | null;
    netcomm_override: number | null;
    manual: Record<"B" | "E" | "J" | "R" | "D" | "M", boolean>;
  };
  expected_raw: Record<"hourly_total" | "gross_per_hr" | "commission" | "service_total" | "product_commission" | "net_comm" | "total_wages" | "pct_of_gross", Cached>;
}
export interface GoldenExportRow {
  row: number;
  key: string | number;
  key_type: "text" | "number";
  isolved_name: string;
  E_Regular_Hours: number;
  E_Overtime_1_5_Hours: number;
  E_Cash_Tips_Recd_Dollars: number;
  E_Comm_Sales_Dollars: number;
  E_Rayz_Paid_Time_Hours: number;
  E_Training_Hours: number;
  source_formulas: string[];
}
export interface Golden {
  rows: GoldenRow[];
  export_tabs: Record<string, { headers: (string | null)[]; rows: GoldenExportRow[] }>;
  /** B, C and R of Kimberly's totals row are circular (I12): never compared. */
  workbook_location_totals_cached: Record<string, { E: number; N: number; formula_E: string }>;
  workbook_total_ranges?: Record<string, { E: [number, number]; N: [number, number] }>;
  workbook_summary_cached: Record<string, { service_sales: number; employee_cost: number; gross_profit: number }>;
  corrected_location_totals_all_rows: Record<string, Record<"hours" | "hourly_total" | "service" | "commission" | "net_comm" | "total_wages" | "tips" | "gross_profit", number>>;
}

/** The workbook's cached value as the platform has it: a blank cell is 0, #DIV/0! is no value. */
export const cached = (v: Cached | undefined) => (v === "#DIV/0!" ? null : (v ?? 0));
export const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

/** Worked hours (the clock's total, OT included) whose B = worked − OT is the workbook's B to the last bit. */
function workedFor(hours: number, ot: number, feed: number): number {
  for (const w of [feed, hours + ot]) if (w - ot === hours) return w;
  let w = hours + ot;
  for (let n = 0; n < 64 && w - ot !== hours; n++) w = w - ot < hours ? w + Number.EPSILON * Math.max(1, Math.abs(w)) : w - Number.EPSILON * Math.max(1, Math.abs(w));
  if (w - ot !== hours) throw new Error(`no worked hours give B = ${hours} with OT ${ot}`);
  return w;
}

export const TYPED = "typed in the workbook";

/** A golden row as the platform's input: the system's figures, with every hand-typed workbook cell a manual adjustment with a reason. */
export function lineInput(g: GoldenRow, x: GoldenExportRow | undefined, shopId: string): LineInput {
  const i = g.inputs;
  const worked = workedFor(i.hours, i.ot_hours, i.feed_hours);
  const overrides: Overrides = {};
  if (i.manual.B) overrides.workedHours = { value: worked, reason: TYPED };
  if (i.manual.E) overrides.serviceSales = { value: i.service, reason: TYPED };
  if (i.manual.R) overrides.tips = { value: i.tips, reason: TYPED };
  if (i.netcomm_override !== null) overrides.netComm = { value: i.netcomm_override, reason: TYPED };
  if (i.hourly_total_override !== null && i.hourly_total_override !== 0) overrides.hourlyTotal = { value: i.hourly_total_override, reason: TYPED };
  return {
    staffId: `${i.location}:${i.row}`,
    name: i.name,
    shopId,
    employeeNumber: x ? String(x.key) : null,
    keyIsText: x?.key_type === "text",
    isolvedName: x?.isolved_name ?? i.name,
    hourlyRate: i.wage,
    servicePct: i.service_pct,
    productPct: i.prod_pct,
    trainingRate: null,
    workedHours: i.manual.B ? 0 : worked,
    otHours: i.ot_hours,
    ptoHours: i.pto_hours,
    trainingHours: i.training_hours,
    serviceSales: i.manual.E ? 0 : i.service,
    productSales: i.product,
    tips: i.manual.R ? 0 : i.tips,
    zeroHourlyPay: i.hourly_total_override === 0,
    overrides,
  };
}

/** Each Locations block's totals row. */
export const TOTALS_ROW: Record<string, number> = { Utica: 9, Moline: 20, Kimberly: 30, "Rock Island": 39, Silvis: 47, Coralville: 55, LeClaire: 63 };

/** The golden period through the platform's payroll engine, one block per shop in Charles's report order. */
export function load(dir: string, tweak?: (input: LineInput) => LineInput) {
  const golden = JSON.parse(readFileSync(path.join(dir, "golden.json"), "utf8")) as Golden;
  const exportRow = new Map<string, GoldenExportRow>();
  for (const [tab, t] of Object.entries(golden.export_tabs))
    for (const r of t.rows) {
      const m = /^=Locations!B(\d+)$/.exec(r.source_formulas[0] ?? "");
      if (!m) throw new Error(`${tab} row ${r.row}: no Locations row`);
      exportRow.set(`${tab}:${m[1]}`, r);
    }
  const shops = [...new Set(golden.rows.map((r) => r.inputs.location))];
  const ordered = inNameOrder(shops, DEFAULT_PAYROLL_SETTINGS.reportOrder, (s) => [s]);
  const byShop = ordered.map((shop) => ({
    shopId: shop,
    shop,
    golden: golden.rows.filter((r) => r.inputs.location === shop),
    inputs: golden.rows.filter((r) => r.inputs.location === shop).map((r) => (tweak ?? ((x: LineInput) => x))(lineInput(r, exportRow.get(`${shop}:${r.inputs.row}`), shop))),
  }));
  return { golden, exportRow, byShop, ...assemble(byShop, DEFAULT_PAYROLL_SETTINGS) };
}
