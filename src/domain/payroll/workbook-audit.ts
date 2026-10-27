/**
 * Checks on a payroll workbook's totals formulas, for the parallel runs against Charles's workbook
 * (spec §8, review I12). The platform never writes formulas (its totals sum every row), so these
 * only say which of the workbook's cached totals can be compared at all.
 */

export interface TotalsFormula {
  shop: string;
  /** The column letter, e.g. "B". */
  column: string;
  /** The totals cell's row. */
  row: number;
  /** As the workbook has it, e.g. "=SUM(B24:B37)". */
  formula: string;
  /** The block's employee rows. */
  employeeRows: readonly number[];
}

export type TotalsProblemKind = "circular" | "outside_block" | "skips_rows" | "not_a_sum";

export interface TotalsProblem {
  shop: string;
  cell: string;
  kind: TotalsProblemKind;
  message: string;
}

const SUM = /^=\s*SUM\(\s*\$?([A-Z]{1,3})\$?(\d+)\s*:\s*\$?([A-Z]{1,3})\$?(\d+)\s*\)$/i;

/**
 * A totals cell's problems: a range that takes in the cell itself (circular: Excel keeps whatever
 * it last cached), one that reaches past its own block into the next shop's rows, and employees of
 * the block the range leaves out.
 */
export function totalsFormulaProblems(f: TotalsFormula): TotalsProblem[] {
  const cell = `${f.column}${f.row}`;
  const m = SUM.exec(f.formula.trim());
  if (!m || m[1].toUpperCase() !== f.column.toUpperCase() || m[3].toUpperCase() !== f.column.toUpperCase())
    return [{ shop: f.shop, cell, kind: "not_a_sum", message: `${f.shop} ${cell} is ${f.formula}, not a sum of its own column, so its cached value can't be compared.` }];
  const from = Math.min(Number(m[2]), Number(m[4]));
  const to = Math.max(Number(m[2]), Number(m[4]));
  const first = Math.min(...f.employeeRows);
  const out: TotalsProblem[] = [];
  if (from <= f.row && f.row <= to)
    out.push({ shop: f.shop, cell, kind: "circular", message: `${f.shop} ${cell} = ${f.formula.trim()} includes itself: a circular reference, so its cached value is stale, not a sum. Never an expected value.` });
  if (from < first || to > f.row)
    out.push({ shop: f.shop, cell, kind: "outside_block", message: `${f.shop} ${cell} = ${f.formula.trim()} reaches outside the ${f.shop} block (rows ${first} to ${f.row}) into another shop's rows.` });
  const skipped = f.employeeRows.filter((r) => r < from || r > to);
  if (skipped.length)
    out.push({ shop: f.shop, cell, kind: "skips_rows", message: `${f.shop} ${cell} = ${f.formula.trim()} leaves out row${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")}, so its total is short.` });
  return out;
}
