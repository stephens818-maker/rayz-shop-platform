/**
 * Checks the payroll engine and the iSolved exporter against Charles's workbook, locally. Prints cell
 * addresses and counts only, never names, keys or amounts, so its output is safe to paste.
 *
 *   pnpm tsx scripts/payroll-golden.ts path/to/payroll-workbook.xlsx
 *
 * 1. Every Locations employee row is recomputed from its own inputs (hours, wage, rates, sales, tips)
 *    and compared with Excel's cached results for B, D, F, H, I, L, M, N and O.
 * 2. Every shop tab is regenerated from those rows and diffed cell by cell with the workbook's:
 *    value, cell type, number format, font, fill, alignment and border.
 */
import ExcelJS from "exceljs";
import { DEFAULT_PAYROLL_SETTINGS, computeLine, exportRows, type LineInput, type Overrides } from "../src/domain/payroll/calc";
import { renderIsolvedTab, TEMPLATE_TABS } from "../src/server/payroll/export";

const num = (c: ExcelJS.Cell): number | null => {
  const v = c.value as unknown;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
    // exceljs leaves `result` out when Excel cached a 0
    const r = (v as { result?: unknown }).result;
    return r === undefined ? 0 : typeof r === "number" ? r : null;
  }
  return null;
};
const canon = (x: unknown): string =>
  x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${k}:${canon((x as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(x ?? null);
const isFormula = (c: ExcelJS.Cell) => c.type === ExcelJS.ValueType.Formula;
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : a === b || Math.abs(a - b) < 1e-9);

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Pass the workbook path.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const loc = wb.getWorksheet("Locations")!;

  const lines = new Map<number, ReturnType<typeof computeLine>>();
  let rowsChecked = 0;
  let cellsChecked = 0;
  const mismatches: string[] = [];
  const typed: string[] = [];
  // Blocks: a header row ("Hours" in B), employee rows, then the total row (a SUM in B).
  const blocks: { shop: string; header: number; rows: number[]; total: number }[] = [];
  for (let r = 1; r <= loc.rowCount; r++) {
    if (loc.getCell(r, 2).value !== "Hours") continue;
    const shop = String(loc.getCell(r - 1, 1).value ?? loc.getCell(r, 1).value ?? "").trim();
    const rows: number[] = [];
    let t = r + 1;
    for (; t <= loc.rowCount; t++) {
      const b = loc.getCell(t, 2).value as ExcelJS.CellFormulaValue | null;
      if (b && typeof b === "object" && "formula" in b && /^SUM\(/i.test(b.formula)) break;
      if (typeof loc.getCell(t, 1).value === "string") rows.push(t);
    }
    blocks.push({ shop, header: r, rows, total: t });
  }
  for (const r of blocks.flatMap((b) => b.rows)) {
    const b = loc.getCell(r, 2);
    if (!isFormula(b) && num(b) !== null) typed.push(`B${r}`);
    const q = num(loc.getCell(r, 17)) ?? 0;
    const overrides: Overrides = {};
    for (const col of [8, 9, 12, 14]) {
      const c = loc.getCell(r, col);
      if (!isFormula(c) && num(c) !== null) typed.push(`${c.address} (typed over a formula column; not carried)`);
    }
    // A typed Hourly Total (the owner row) is kept as the workbook has it, not guessed at (Q17).
    const d = loc.getCell(r, 4);
    const typedD = !isFormula(d) && num(d) !== null ? num(d)! : null;
    if (typedD !== null) typed.push(`${d.address} (typed Hourly Total kept as is)`);
    for (const [col, key] of [[5, "serviceSales"], [13, "netComm"], [18, "tips"]] as const) {
      const c = loc.getCell(r, col);
      if (!isFormula(c) && num(c) !== null) {
        overrides[key] = { value: num(c)!, reason: "typed in the workbook" };
        typed.push(`${c.address}`);
      }
    }
    const input: LineInput = {
      staffId: `row${r}`,
      name: `row ${r}`,
      shopId: "",
      employeeNumber: null,
      keyIsText: false,
      isolvedName: "",
      hourlyRate: typedD !== null ? (num(b) ? typedD / num(b)! : 0) : (num(loc.getCell(r, 3)) ?? 0),
      servicePct: num(loc.getCell(r, 7)) ?? 0,
      productPct: num(loc.getCell(r, 11)) ?? 0,
      trainingRate: null,
      workedHours: (num(b) ?? 0) + q,
      otHours: q,
      ptoHours: num(loc.getCell(r, 16)) ?? 0,
      trainingHours: num(loc.getCell(r, 19)) ?? 0,
      serviceSales: num(loc.getCell(r, 5)) ?? 0,
      productSales: num(loc.getCell(r, 10)) ?? 0,
      tips: num(loc.getCell(r, 18)) ?? 0,
      overrides,
    };
    const l = computeLine(input, DEFAULT_PAYROLL_SETTINGS);
    lines.set(r, l);
    rowsChecked++;
    if (loc.getCell(r, 2).value === null) typed.push(`B${r} (blank hours)`);
    const checks: [number, number | null][] = [
      [2, l.hours],
      [4, l.hourlyTotal],
      [6, l.grossPerHour],
      [8, l.commission],
      [9, l.serviceTotal],
      [12, l.productTotal],
      [13, l.netComm],
      [14, l.totalWages],
      [15, l.pctOfGross],
    ];
    for (const [col, v] of checks) {
      const c = loc.getCell(r, col);
      if (c.value === null && (v === 0 || v === null)) continue;
      cellsChecked++;
      const want = num(c);
      if (!same(want, v)) mismatches.push(`${c.address}${want === null ? " (error/blank in workbook)" : ""}`);
    }
  }
  console.log(`Locations: ${rowsChecked} employee rows, ${cellsChecked} computed cells, ${mismatches.length} mismatches${mismatches.length ? ": " + mismatches.join(", ") : ""}`);
  console.log(`Typed (non-formula) inputs carried as overrides: ${typed.join(", ") || "none"}`);

  if (process.argv.includes("--totals")) {
    // Shop-level totals only: what the workbook shows, and the sum of its own rows.
    const cols: [number, keyof ReturnType<typeof computeLine>][] = [[2, "hours"], [4, "hourlyTotal"], [5, "service"], [8, "commission"], [9, "serviceTotal"], [10, "product"], [12, "productTotal"], [13, "netComm"], [14, "totalWages"], [16, "ptoHours"], [17, "otHours"], [18, "tips"], [19, "trainingHours"]];
    for (const b of blocks) {
      const ls = b.rows.map((r) => lines.get(r)!);
      for (const [col, k] of cols) {
        const c = loc.getCell(b.total, col);
        const sum = ls.reduce((a, l) => a + (l[k] as number), 0);
        const f = c.type === ExcelJS.ValueType.Formula ? (c.value as ExcelJS.CellFormulaValue).formula ?? (c.value as { sharedFormula?: string }).sharedFormula : String(c.value ?? "");
        const shown = num(c);
        if (shown === null && sum === 0) continue;
        if (shown === null || Math.abs(shown - sum) > 0.004) console.log(`TOTAL ${b.shop} ${c.address} =${f} shows ${shown} rows sum ${sum.toFixed(4)}`);
      }
      for (const col of [3, 7, 11, 6, 15]) {
        const c = loc.getCell(b.total, col);
        if (c.type === ExcelJS.ValueType.Formula && /SUM\(/.test((c.value as ExcelJS.CellFormulaValue).formula ?? "")) console.log(`RATE-SUM ${b.shop} ${c.address} =${(c.value as ExcelJS.CellFormulaValue).formula} shows ${num(c)}`);
      }
      const ot = ls.reduce((a, l) => a + l.otPay, 0);
      const tr = ls.reduce((a, l) => a + l.trainingPay, 0);
      const wages = ls.reduce((a, l) => a + l.totalWages, 0);
      console.log(`COST ${b.shop} rows=${b.rows.length} wages ${wages.toFixed(2)} otPay ${ot.toFixed(2)} trainingPay ${tr.toFixed(2)} labor ${(wages + ot + tr).toFixed(2)} service ${ls.reduce((a, l) => a + l.service, 0).toFixed(2)}`);
    }
    for (let r = 68; r <= 76; r++) console.log(`SUMMARY r${r}`, [3, 5, 7].map((c) => num(loc.getCell(r, c))?.toFixed(2)).join(" | "));
  }

  const props = ["numFmt", "font", "fill", "alignment", "border"] as const;
  for (const tab of TEMPLATE_TABS) {
    const ws = wb.getWorksheet(tab)!;
    const rows = [];
    const valueNotes: string[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const key = ws.getCell(r, 1).value;
      const ref = ws.getCell(r, 3).value as ExcelJS.CellFormulaValue | null;
      const m = ref && typeof ref === "object" && "formula" in ref ? /Locations!B(\d+)/.exec(ref.formula) : null;
      if (key === null && !m) continue;
      const line = m ? lines.get(Number(m[1])) : undefined;
      if (!line) {
        valueNotes.push(`row ${r}: no Locations row`);
        continue;
      }
      const [er] = exportRows([line], DEFAULT_PAYROLL_SETTINGS);
      rows.push({ ...er, key: key as string | number | null, isolvedName: String(ws.getCell(r, 2).value ?? "") });
    }
    const buf = await renderIsolvedTab({ tab, payGroup: tab, periodNumber: 23, periodStart: "", periodEnd: "", rows });
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(buf as unknown as ArrayBuffer);
    const gen = out.getWorksheet(tab)!;
    const diffs: string[] = [];
    for (let r = 1; r <= Math.max(ws.rowCount, gen.rowCount); r++) {
      for (let c = 1; c <= 8; c++) {
        const a = ws.getCell(r, c);
        const g = gen.getCell(r, c);
        const av = a.type === ExcelJS.ValueType.Formula ? num(a) : a.value;
        if (r > 1 && c >= 3 && a.type === ExcelJS.ValueType.Formula) {
          if (!same(av as number | null, g.value as number | null)) diffs.push(`${a.address} value`);
        } else if (av !== g.value) diffs.push(`${a.address} value/type`);
        for (const p of props) if (canon(a[p]) !== canon(g[p])) diffs.push(`${a.address} ${p}`);
      }
    }
    for (let c = 1; c <= 8; c++) if (ws.getColumn(c).width !== gen.getColumn(c).width) diffs.push(`col ${c} width`);
    console.log(`${tab}: ${rows.length} rows, ${diffs.length} differences${diffs.length ? ": " + diffs.join(", ") : ""}${valueNotes.length ? " — " + valueNotes.join("; ") : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
