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

/** A cell as the workbook would compute it: a number, or the error Excel would show. "circular" is a range that reaches its own cell. */
export type CellResult = number | { error: "#DIV/0!" | "#N/A" | "circular" };

const isError = (v: CellResult): v is { error: "#DIV/0!" | "#N/A" | "circular" } => typeof v !== "number";

/**
 * Works out a totals formula the way the workbook does: `SUM(X1:X9)` over one column, cell references,
 * and + − × ÷. `ref` gives each cell's value (blank and text cells are 0). Any error propagates, as in
 * Excel, so a total built on a circular cell is itself unknown.
 */
export function evaluateWorkbookFormula(formula: string, ref: (column: string, row: number) => CellResult): CellResult {
  const src = formula.trim().replace(/^=/, "").replace(/\$/g, "");
  const tokens = src.match(/SUM\([A-Z]+\d+:[A-Z]+\d+\)|[A-Z]+\d+|\d+(?:\.\d+)?|[-+*/()]/gi);
  if (!tokens || tokens.join("") !== src.replace(/\s+/g, "")) throw new Error(`Can't read the formula ${formula}`);
  let i = 0;
  const atom = (): CellResult => {
    const t = tokens[i++];
    if (t === "(") {
      const v = sum();
      i++;
      return v;
    }
    if (t === "-") {
      const v = atom();
      return isError(v) ? v : -v;
    }
    const range = /^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i.exec(t);
    if (range) {
      if (range[1].toUpperCase() !== range[3].toUpperCase()) throw new Error(`${t} spans columns`);
      let total = 0;
      for (let r = Math.min(+range[2], +range[4]); r <= Math.max(+range[2], +range[4]); r++) {
        const v = ref(range[1].toUpperCase(), r);
        if (isError(v)) return v;
        total += v;
      }
      return total;
    }
    const cell = /^([A-Z]+)(\d+)$/i.exec(t);
    if (cell) return ref(cell[1].toUpperCase(), +cell[2]);
    return Number(t);
  };
  const product = (): CellResult => {
    let v = atom();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++];
      const w = atom();
      if (isError(v)) continue;
      if (isError(w)) v = w;
      else if (op === "/" && w === 0) v = { error: "#DIV/0!" };
      else v = op === "*" ? v * w : v / w;
    }
    return v;
  };
  const sum = (): CellResult => {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++];
      const w = product();
      if (isError(v)) continue;
      v = isError(w) ? w : op === "+" ? v + w : v - w;
    }
    return v;
  };
  const out = sum();
  if (i !== tokens.length) throw new Error(`Can't read the formula ${formula}`);
  return out;
}

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
