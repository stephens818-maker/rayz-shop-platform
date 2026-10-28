import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DEFAULT_PAYROLL_SETTINGS, LOCATIONS_COLUMNS, anomalies, assemble, inNameOrder, locationSummary, totalsOf, type Line } from "@/domain/payroll/calc";
import { evaluateWorkbookFormula, totalsFormulaProblems, type CellResult } from "@/domain/payroll/workbook-audit";
import { renderIsolvedWorkbook } from "@/server/payroll/export";
import { locationsWorkbook } from "@/server/payroll/locations";
import type { BlockView } from "@/server/payroll/run";
import { FIXTURES, ROOT, TOTALS_ROW, load, near } from "./payroll-golden-fixtures";

/**
 * The workbook totals audit (Claude bot, Oct 22): every Locations totals, gross profit, grand total and
 * summary cell, worked out the way the workbook's own formulas do from the golden rows, next to what
 * the platform's Payroll Report shows. The shop tabs are right; only the Locations totals are broken.
 * The real figures (the audit's totals_findings.csv and the headline totals) are in the gitignored
 * private fixture; the committed catalog holds cell addresses and formulas only.
 */

type Finding = "wrong_value" | "wrong_range" | "rate_sum" | "missing" | "label";
interface CatalogCell {
  cell: string;
  block: string;
  formula: string | null;
  finding: Finding;
}
const CATALOG = (JSON.parse(readFileSync(path.join(ROOT, "locations-totals-formulas.json"), "utf8")) as { cells: CatalogCell[] }).cells;

const COLUMN: Record<string, keyof Line> = {
  B: "hours",
  C: "wage",
  D: "hourlyTotal",
  E: "service",
  F: "grossPerHour",
  G: "servicePct",
  H: "commission",
  I: "serviceTotal",
  J: "product",
  K: "productPct",
  L: "productTotal",
  M: "netComm",
  N: "totalWages",
  O: "pctOfGross",
  P: "ptoHours",
  Q: "otHours",
  R: "tips",
  S: "trainingHours",
};
/** The Locations summary (rows 69 to 75, Total in 76): C Service Sales, E Employee Cost, G Gross Profit. */
const SUMMARY_ROW: Record<string, number> = { Utica: 69, Moline: 70, Kimberly: 71, "Rock Island": 72, Silvis: 73, LeClaire: 74, Coralville: 75 };
const SUMMARY_TOTAL = 76;
/** B56: the grand total of hours, on Coralville's gross profit row. */
const GRAND_HOURS = "B56";

const split = (cell: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(cell)!;
  return { col: m[1], row: Number(m[2]) };
};
const isError = (v: CellResult): v is Exclude<CellResult, number> => typeof v !== "number";
/** The audit's CSV keeps 4 decimals. */
const to4 = (a: number, b: number) => Math.abs(a - b) <= 0.00006;
const toCent = (a: number, b: number) => Math.abs(a - b) <= 0.005 + 1e-9;

type Blocks = ReturnType<typeof load>["blocks"];

/** The Locations sheet as the workbook computes it, over the platform's lines (which match the workbook's rows exactly). */
function workbookOf(blocks: Blocks) {
  const lineAt = new Map<number, Line>();
  for (const b of blocks) for (const l of b.lines) lineAt.set(Number(l.staffId.split(":")[1]), l);
  const totalsAt = new Map(blocks.map((b) => [TOTALS_ROW[b.shop], b]));
  const summaryAt = new Map(blocks.map((b) => [SUMMARY_ROW[b.shop], b]));
  const all = { service: blocks.reduce((a, b) => a + b.totals.service, 0), totalWages: blocks.reduce((a, b) => a + b.totals.totalWages, 0) };
  const byCell = new Map(CATALOG.map((c) => [c.cell, c]));

  /** The right value: every total a sum of all its block's rows, ratios of totals, rates not totalled. */
  function correct(cell: string): number | null | undefined {
    if (cell === GRAND_HOURS) return blocks.reduce((a, b) => a + b.totals.hours, 0);
    const { col, row } = split(cell);
    const t = totalsAt.get(row)?.totals;
    if (t) {
      if (col === "C" || col === "K") return null;
      if (col === "F") return t.grossPerHour;
      if (col === "G" || col === "O") return t.pctOfGross;
      return t[COLUMN[col] as keyof typeof t] as number;
    }
    const gp = totalsAt.get(row - 1)?.totals;
    if (gp && col === "H") return gp.service - gp.totalWages;
    const s = row === SUMMARY_TOTAL ? all : summaryAt.get(row)?.totals;
    if (s && col === "C") return s.service;
    if (s && col === "E") return s.totalWages;
    if (s && col === "G") return s.service - s.totalWages;
    return undefined;
  }

  /** What the workbook's formula gives. Cells the audit didn't flag are right, so they read as the correct value. */
  function shown(cell: string, stack: string[] = []): CellResult {
    const c = byCell.get(cell);
    if (!c?.formula?.startsWith("=")) throw new Error(`${cell} has no formula`);
    return evaluateWorkbookFormula(c.formula, (col, row) => {
      const ref = `${col}${row}`;
      if (ref === cell || stack.includes(ref)) return { error: "circular" };
      if (byCell.get(ref)?.formula?.startsWith("=")) return shown(ref, [...stack, cell]);
      const line = lineAt.get(row);
      if (line) {
        const v = line[COLUMN[col]] as number | null;
        return v === null ? { error: "#DIV/0!" } : v;
      }
      const v = correct(ref);
      return v === undefined ? 0 : v === null ? { error: "#N/A" } : v;
    });
  }

  function finding(c: CatalogCell): Finding {
    if (c.formula === null) return "missing";
    if (!c.formula.startsWith("=")) return "label";
    const { col, row } = split(c.cell);
    if ((col === "C" || col === "K") && totalsAt.has(row)) return "rate_sum";
    const s = shown(c.cell);
    const want = correct(c.cell)!;
    return isError(s) || !near(s, want) ? "wrong_value" : "wrong_range";
  }

  return { correct, shown, finding };
}

const employeeRows = (blocks: Blocks, shop: string) => blocks.find((b) => b.shop === shop)!.lines.map((l) => Number(l.staffId.split(":")[1]));

describe("the workbook totals audit's catalog", () => {
  it("has 112 flagged cells: 71 wrong values, 8 wrong ranges that are right today, 10 summed rate columns, 22 missing totals and 1 typed label", () => {
    const count = (f: Finding) => CATALOG.filter((c) => c.finding === f).map((c) => c.cell);
    expect(CATALOG.length).toBe(112);
    expect(new Set(CATALOG.map((c) => c.cell)).size).toBe(112);
    expect(count("wrong_value").length).toBe(71);
    expect(count("wrong_range")).toEqual(["L47", "M47", "P55", "Q55", "L63", "M63", "P63", "Q63"]);
    expect(count("rate_sum")).toEqual(["C9", "C20", "C30", "C39", "C47", "K47", "C55", "K55", "C63", "K63"]);
    expect(count("missing").length).toBe(22);
    expect(count("label")).toEqual(["F72"]);
  });

  it("only Moline's totals are all right: every other shop has wrong values, and Moline has none (just its summed wage and blank PTO, OT and training)", () => {
    const wrongBy = (shop: string) => CATALOG.filter((c) => c.block === shop && c.finding === "wrong_value").length;
    expect(wrongBy("Moline")).toBe(0);
    for (const shop of Object.keys(TOTALS_ROW).filter((s) => s !== "Moline")) expect(wrongBy(shop), shop).toBeGreaterThan(0);
    expect(CATALOG.filter((c) => c.block === "Moline").map((c) => `${c.cell} ${c.finding}`)).toEqual(["C20 rate_sum", "P20 missing", "Q20 missing", "S20 missing"]);
  });

  it("the totals that include themselves are exactly Utica C9, L9 and R9 and Kimberly B30, C30 and R30", () => {
    const { blocks } = load(FIXTURES[0].dir);
    const circular = CATALOG.filter((c) => c.formula && /^=SUM\(/.test(c.formula) && TOTALS_ROW[c.block] === split(c.cell).row)
      .flatMap((c) => totalsFormulaProblems({ shop: c.block, column: split(c.cell).col, row: split(c.cell).row, formula: c.formula!, employeeRows: employeeRows(blocks, c.block) }))
      .filter((p) => p.kind === "circular")
      .map((p) => p.cell);
    expect(circular).toEqual(["C9", "L9", "R9", "B30", "C30", "R30"]);
  });

  it("every wrong range names the rows it leaves out; the grand total of hours leaves out LeClaire and adds the circular B30", () => {
    const { blocks } = load(FIXTURES[0].dir);
    for (const c of CATALOG.filter((x) => x.finding === "wrong_range")) {
      const { col, row } = split(c.cell);
      const kinds = totalsFormulaProblems({ shop: c.block, column: col, row, formula: c.formula!, employeeRows: employeeRows(blocks, c.block) }).map((p) => p.kind);
      expect(kinds, c.cell).toContain("skips_rows");
    }
    const grand = CATALOG.find((c) => c.cell === GRAND_HOURS)!.formula!;
    expect(grand).toBe("=B55+B47+B39+B30+B20+B9");
    expect(grand).not.toContain(`B${TOTALS_ROW.LeClaire}`);
  });
});

for (const fx of FIXTURES) {
  describe.skipIf(!fx.present)(`the Locations totals, ${fx.name}`, () => {
    const g = () => load(fx.dir);

    it("each flagged cell is what the audit found: the workbook's formula against the platform's total", () => {
      const { blocks } = g();
      const wb = workbookOf(blocks);
      const differ = CATALOG.filter((c) => wb.finding(c) !== c.finding).map((c) => `${c.cell}: ${wb.finding(c)} vs ${c.finding}`);
      expect(differ).toEqual([]);
    });

    it("the platform's totals are the correct ones in every flagged cell: each block's sum of all its rows, ratios of totals, and the summary from those", () => {
      const { blocks } = g();
      const wb = workbookOf(blocks);
      for (const c of CATALOG.filter((x) => x.finding !== "label" && x.finding !== "rate_sum")) expect(wb.correct(c.cell), c.cell).toEqual(expect.any(Number));
      const ordered = inNameOrder(blocks, DEFAULT_PAYROLL_SETTINGS.reportOrder, (b) => [b.shop]);
      const { rows, total } = locationSummary(ordered);
      for (const r of rows) {
        const at = SUMMARY_ROW[r.shop];
        expect([r.service, r.employeeCost, r.grossProfit]).toEqual([wb.correct(`C${at}`), wb.correct(`E${at}`), wb.correct(`G${at}`)]);
      }
      expect([total.service, total.employeeCost, total.grossProfit]).toEqual([wb.correct("C76"), wb.correct("E76"), wb.correct("G76")]);
    });

    it("the Payroll Report download's totals rows carry every summed column (Product$, PTO, OT and Training too), leave the rates blank, and hold no formulas", async () => {
      const { blocks } = g();
      const ordered = inNameOrder(blocks, DEFAULT_PAYROLL_SETTINGS.reportOrder, (b) => [b.shop]) as unknown as BlockView[];
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await locationsWorkbook({ blocks: ordered, settings: DEFAULT_PAYROLL_SETTINGS, start: "2026-10-04", end: "2026-10-17" }, ordered)) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet("Locations")!;
      const totalRows: number[] = [];
      let summaryTotal = 0;
      ws.eachRow((row, r) => {
        row.eachCell((cell) => expect(cell.type, cell.address).not.toBe(ExcelJS.ValueType.Formula));
        if (row.getCell(1).value === "Total") totalRows.push(r);
        if (row.getCell(2).value === "Total") summaryTotal = r;
      });
      expect(totalRows.length).toBe(ordered.length);
      ordered.forEach((b, n) => {
        const r = ws.getRow(totalRows[n]);
        LOCATIONS_COLUMNS.forEach((c, j) => {
          if (c.key === "name") return;
          const v = r.getCell(j + 1).value;
          if (c.key === "wage" || c.key === "servicePct" || c.key === "productPct") expect(v, `${b.shop} ${c.header}`).toBeNull();
          else if (c.key === "grossPerHour") expect(v).toBe(b.totals.grossPerHour);
          else if (c.key === "pctOfGross") expect(v).toBe(b.totals.pctOfGross);
          else expect(v, `${b.shop} ${c.header}`).toBe(b.totals[c.key as keyof typeof b.totals]);
        });
      });
      const { total } = locationSummary(ordered);
      expect([3, 5, 7].map((c) => ws.getRow(summaryTotal).getCell(c).value)).toEqual([total.service, total.employeeCost, total.grossProfit]);
      const isolved = new ExcelJS.Workbook();
      await isolved.xlsx.load(
        (await renderIsolvedWorkbook(ordered.map((b) => ({ tab: b.shop, payGroup: b.shop, periodNumber: 1, periodStart: "2026-10-04", periodEnd: "2026-10-17", rows: b.exportRows, headers: b.exportHeaders })))) as unknown as ArrayBuffer,
      );
      isolved.eachSheet((s) => s.eachRow((row) => row.eachCell((cell) => expect(cell.type, `${s.name}!${cell.address}`).not.toBe(ExcelJS.ValueType.Formula))));
    });

    it("the shop tabs are right: each tab's columns add up to the platform's correct block totals, and no tab has a totals row", () => {
      const { golden, blocks } = g();
      for (const [tab, t] of Object.entries(golden.export_tabs)) {
        const b = blocks.find((x) => x.shop === tab)!;
        const rows = new Set(b.lines.map((l) => l.staffId));
        for (const r of t.rows) expect(rows.has(`${tab}:${/B(\d+)$/.exec(r.source_formulas[0])![1]}`), `${tab} row ${r.row}`).toBe(true);
        expect(t.rows.length).toBe(b.lines.filter((l) => b.exportRows.some((x) => x.staffId === l.staffId)).length);
        const sum = (k: keyof (typeof t.rows)[number]) => t.rows.reduce((a, r) => a + (r[k] as number), 0);
        const ours = (i: number) => b.exportRows.reduce((a, r) => a + (r.values[i] as number), 0);
        const want = [b.totals.hours, b.totals.otHours, b.totals.tips, b.totals.netComm, b.totals.ptoHours, b.totals.trainingHours];
        const tabSums = [sum("E_Regular_Hours"), sum("E_Overtime_1_5_Hours"), sum("E_Cash_Tips_Recd_Dollars"), sum("E_Comm_Sales_Dollars"), sum("E_Rayz_Paid_Time_Hours"), sum("E_Training_Hours")];
        tabSums.forEach((v, i) => {
          expect(Math.abs(v - want[i]), `${tab} column ${i}`).toBeLessThan(1e-6);
          expect(Math.abs(ours(i) - want[i]), `${tab} export column ${i}`).toBeLessThan(1e-6);
        });
      }
    });

    it("LeClaire G2 and G3 link two rows too low (the totals and gross profit rows), and Moline H3 and Silvis F5 are typed; the platform writes each person's figures from their own line", () => {
      const { golden } = g();
      const off: string[] = [];
      const typed: string[] = [];
      for (const [tab, t] of Object.entries(golden.export_tabs))
        for (const r of t.rows)
          r.source_formulas.forEach((f, i) => {
            const own = /B(\d+)$/.exec(r.source_formulas[0])![1];
            const at = /^=Locations!([A-Z]+)(\d+)$/.exec(f);
            if (!at) typed.push(`${tab} ${"CDEFGH"[i]}${r.row} = ${f}`);
            else if (at[2] !== own) off.push(`${tab} ${"CDEFGH"[i]}${r.row} = Locations!${at[1]}${at[2]}, not ${at[1]}${own}`);
          });
      expect(off).toEqual(["LeClaire G2 = Locations!P63, not P61", "LeClaire G3 = Locations!P64, not P62"]);
      expect(typed).toEqual(["Moline H3 = 0", "Silvis F5 = 0"]);
      const pto = new Map([
        ["LeClaire:61", 4],
        ["LeClaire:62", 6],
      ]);
      const { blocks } = load(fx.dir, (x) => (pto.has(x.staffId) ? { ...x, ptoHours: pto.get(x.staffId)! } : x));
      const leclaire = blocks.find((b) => b.shop === "LeClaire")!;
      const at = (leclaire.exportHeaders ?? []).indexOf("E_Ray'z Paid Time_Hours");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(["LeClaire:61", "LeClaire:62"].map((id) => leclaire.exportRows.find((r) => r.staffId === id)!.values[at])).toEqual([4, 6]);
      expect(leclaire.totals.ptoHours).toBe(10);
    });

    it("there's no payroll tax column: the Locations columns and the export carry none, and sales tax (reference only) changes no pay figure", () => {
      const { golden, blocks } = g();
      expect(LOCATIONS_COLUMNS.filter((c) => /tax/i.test(c.header))).toEqual([]);
      for (const b of blocks) expect((b.exportHeaders ?? []).filter((h) => /tax/i.test(h)), b.shop).toEqual([]);
      for (const t of Object.values(golden.export_tabs)) expect(t.headers.filter((h) => h && /tax/i.test(h))).toEqual([]);
      const taxed = load(fx.dir, (x) => ({ ...x, salesTax: 99.99 })).blocks;
      taxed.forEach((b, n) => {
        expect(b.totals.salesTax).toBeCloseTo(99.99 * b.lines.length, 6);
        expect({ ...b.totals, salesTax: 0 }).toEqual({ ...blocks[n].totals, salesTax: 0 });
        expect(b.exportRows.map((r) => r.values)).toEqual(blocks[n].exportRows.map((r) => r.values));
      });
    });

    it("the typed-over NetComm (Q17) is flagged with its gap, so the report's Total Wages and the export's Comm Sales are reconciled in the open", () => {
      const { blocks } = g();
      const typed = blocks.flatMap((b) => b.lines).filter((l) => !near(l.netComm, l.netCommComputed));
      const gaps = anomalies(blocks, DEFAULT_PAYROLL_SETTINGS).filter((a) => a.kind === "netcomm_gap");
      expect(gaps.map((a) => a.staffId).sort()).toEqual(typed.map((l) => l.staffId).sort());
      expect(typed.length).toBeGreaterThan(0);
    });

    it("a shop that isn't in the workbook (Dubuque) gets its own summary row and counts in the total", () => {
      const { byShop } = g();
      const dubuque = { shopId: "Dubuque", shop: "Dubuque", inputs: [{ ...byShop[0].inputs[0], staffId: "Dubuque:1", shopId: "Dubuque" }] };
      const { blocks } = assemble([...byShop, dubuque], DEFAULT_PAYROLL_SETTINGS);
      const { rows, total } = locationSummary(inNameOrder(blocks, DEFAULT_PAYROLL_SETTINGS.reportOrder, (b) => [b.shop]));
      expect(rows.map((r) => r.shop)).toEqual([...DEFAULT_PAYROLL_SETTINGS.reportOrder, "Dubuque"]);
      expect(near(total.service, rows.reduce((a, r) => a + r.service, 0))).toBe(true);
    });

    const expectedFile = path.join(fx.dir, "totals_expected.json");
    it.skipIf(!existsSync(expectedFile))("the golden period's grand totals and per-shop tab totals are the audit's correct values", () => {
      const want = JSON.parse(readFileSync(expectedFile, "utf8")) as {
        grand: Record<
          | "hours"
          | "otHours"
          | "service"
          | "employeeCost"
          | "grossProfit"
          | "tips"
          | "netComm"
          | "topUp"
          | "productCommission"
          | "netCommTypedOver"
          | "employeeCostWithTypedNetComm"
          | "ptoHours"
          | "trainingHours"
          | "otPay"
          | "trainingPay"
          | "laborCost"
          | "laborCostWithTraining"
          | "grossProfitAfterLabor",
          number
        >;
        shopTabs: Record<string, Record<"regular" | "ot" | "tips" | "netComm" | "pto" | "training", number>>;
      };
      const { blocks } = g();
      const lines = blocks.flatMap((b) => b.lines);
      const sum = (f: (l: Line) => number) => lines.reduce((a, l) => a + f(l), 0);
      const { total } = locationSummary(blocks);
      const topUp = sum((l) => Math.max(l.serviceTotal, 0));
      const product = sum((l) => l.productTotal);
      const typedOver = sum((l) => l.netComm - l.netCommComputed);
      const trainingPay = sum((l) => l.trainingPay);
      const laborCost = sum((l) => l.laborCost);
      const got = {
        hours: sum((l) => l.hours),
        otHours: sum((l) => l.otHours),
        service: total.service,
        employeeCost: total.employeeCost,
        grossProfit: total.grossProfit,
        tips: sum((l) => l.tips),
        netComm: sum((l) => l.netComm),
        topUp,
        productCommission: product,
        netCommTypedOver: typedOver,
        employeeCostWithTypedNetComm: total.employeeCost + typedOver,
        ptoHours: sum((l) => l.ptoHours),
        trainingHours: sum((l) => l.trainingHours),
        otPay: sum((l) => l.otPay),
        trainingPay,
        // The audit's Labor Cost and Gross Profit After Labor leave training pay out; the platform's include it (Charles, Oct 28).
        laborCost: laborCost - trainingPay,
        laborCostWithTraining: laborCost,
        grossProfitAfterLabor: total.service - laborCost + trainingPay,
      };
      expect(toCent(totalsOf(lines).grossProfit, total.service - want.grand.laborCostWithTraining)).toBe(true);
      for (const [k, v] of Object.entries(want.grand)) expect(toCent(got[k as keyof typeof got], v), `${k}: ${got[k as keyof typeof got]} vs ${v}`).toBe(true);
      expect(near(got.netComm, topUp + product + typedOver)).toBe(true);
      for (const [shop, t] of Object.entries(want.shopTabs)) {
        const b = blocks.find((x) => x.shop === shop)!.totals;
        const ours = { regular: b.hours, ot: b.otHours, tips: b.tips, netComm: b.netComm, pto: b.ptoHours, training: b.trainingHours };
        for (const [k, v] of Object.entries(t)) expect(toCent(ours[k as keyof typeof ours], v), `${shop} ${k}: ${ours[k as keyof typeof ours]} vs ${v}`).toBe(true);
      }
    });

    const findingsFile = path.join(fx.dir, "totals_findings.csv");
    it.skipIf(!existsSync(findingsFile))("every cell in the audit's totals_findings.csv: the shown value is the workbook formula's, and the correct value is the platform's", () => {
      const [head, ...lines] = readFileSync(findingsFile, "utf8").trim().split(/\r?\n/);
      expect(head).toBe("tab,cell,block,issue,formula,shown,correct,diff");
      const csv = lines.map((line) => {
        const cols: string[] = [];
        let cur = "";
        let quoted = false;
        for (const ch of line) {
          if (ch === '"') quoted = !quoted;
          else if (ch === "," && !quoted) {
            cols.push(cur);
            cur = "";
          } else cur += ch;
        }
        cols.push(cur);
        const [tab, cell, block, issue, formula, shown, correct, diff] = cols;
        return { tab, cell, block, issue, formula, shown, correct, diff };
      });
      expect(csv.map((r) => [r.cell, r.block, r.formula || null])).toEqual(CATALOG.map((c) => [c.cell, c.block, c.formula]));
      const { blocks } = g();
      const wb = workbookOf(blocks);
      const problems: string[] = [];
      for (const r of csv) {
        const c = CATALOG.find((x) => x.cell === r.cell)!;
        const csvFinding: Finding = !r.formula ? "missing" : !r.formula.startsWith("=") ? "label" : r.correct === "" ? "rate_sum" : r.shown === "#N/A" || Number(r.diff) !== 0 ? "wrong_value" : "wrong_range";
        if (csvFinding !== c.finding) problems.push(`${r.cell} finding ${c.finding} vs the CSV's ${csvFinding}`);
        if (r.correct !== "" && c.finding !== "label") {
          const ours = wb.correct(r.cell);
          if (typeof ours !== "number" || !to4(ours, Number(r.correct))) problems.push(`${r.cell} correct ${ours} vs ${r.correct}`);
        }
        if (c.finding === "wrong_value" || c.finding === "wrong_range") {
          // A circular total, or one built on it (F30, B56), has only Excel's stale cache: never compared.
          const s = wb.shown(r.cell);
          if (isError(s)) {
            if (s.error !== "circular" || c.finding !== "wrong_value") problems.push(`${r.cell} shown ${s.error} vs ${r.shown}`);
          } else if (!to4(s, Number(r.shown))) problems.push(`${r.cell} shown ${s} vs ${r.shown}`);
        }
      }
      expect(problems).toEqual([]);
      const circular = csv.filter((r) => /circular \(includes itself\)/.test(r.issue)).map((r) => r.cell);
      expect(circular).toEqual(["C9", "L9", "R9", "B30", "C30", "R30"]);
    });
  });
}
