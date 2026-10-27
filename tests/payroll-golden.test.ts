import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DEFAULT_PAYROLL_SETTINGS, LOCATIONS_COLUMNS, assemble, computeLine, inNameOrder, locationSummary, totalsOf, type LineInput, type Line, type Overrides } from "@/domain/payroll/calc";
import { renderIsolvedWorkbook } from "@/server/payroll/export";

/**
 * Charles's payroll workbook, reproduced. `anon` is committed: fictional names, keys, rates, hours and
 * sales with the workbook's formula branches, typed cells and zeros (scripts/payroll-golden-anonymize.py).
 * `private` is the real workbook's golden data, gitignored and present only on machines it was copied to.
 */
const ROOT = path.join(__dirname, "fixtures/payroll-golden");
const FIXTURES = [
  { name: "anonymized (committed)", dir: path.join(ROOT, "anon") },
  { name: "real (local only)", dir: path.join(ROOT, "private") },
].map((f) => ({ ...f, present: existsSync(path.join(f.dir, "golden.json")) && existsSync(path.join(f.dir, "expected_isolved_export.xlsx")) }));

type Cached = number | null | "#DIV/0!";
interface GoldenRow {
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
interface GoldenExportRow {
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
interface Golden {
  rows: GoldenRow[];
  export_tabs: Record<string, { headers: (string | null)[]; rows: GoldenExportRow[] }>;
  workbook_location_totals_cached: Record<string, { E: number; N: number }>;
  workbook_total_ranges?: Record<string, { E: [number, number]; N: [number, number] }>;
  workbook_summary_cached: Record<string, { service_sales: number; employee_cost: number; gross_profit: number }>;
  corrected_location_totals_all_rows: Record<string, Record<"hours" | "hourly_total" | "service" | "commission" | "net_comm" | "total_wages" | "tips" | "gross_profit", number>>;
}

/** The workbook's cached value as the platform has it: a blank cell is 0, #DIV/0! is no value. */
const cached = (v: Cached | undefined) => (v === "#DIV/0!" ? null : (v ?? 0));
const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

/** Worked hours (the clock's total, OT included) whose B = worked − OT is the workbook's B to the last bit. */
function workedFor(hours: number, ot: number, feed: number): number {
  for (const w of [feed, hours + ot]) if (w - ot === hours) return w;
  let w = hours + ot;
  for (let n = 0; n < 64 && w - ot !== hours; n++) w = w - ot < hours ? w + Number.EPSILON * Math.max(1, Math.abs(w)) : w - Number.EPSILON * Math.max(1, Math.abs(w));
  if (w - ot !== hours) throw new Error(`no worked hours give B = ${hours} with OT ${ot}`);
  return w;
}

const TYPED = "typed in the workbook";

/** The reference file was written by openpyxl, which stores numbers to 16 significant digits; the export keeps the formula's full double (checked exactly against golden.json). */
const asStored = (v: ExcelJS.CellValue) => (typeof v === "number" ? Number(v.toPrecision(16)) : v);

/** A golden row as the platform's input: the system's figures, with every hand-typed workbook cell a manual adjustment with a reason. */
function lineInput(g: GoldenRow, x: GoldenExportRow | undefined, shopId: string): LineInput {
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

const ROW_CHECKS: [keyof GoldenRow["expected_raw"], keyof Line][] = [
  ["hourly_total", "hourlyTotal"],
  ["gross_per_hr", "grossPerHour"],
  ["commission", "commission"],
  ["service_total", "serviceTotal"],
  ["product_commission", "productTotal"],
  ["net_comm", "netComm"],
  ["total_wages", "totalWages"],
  ["pct_of_gross", "pctOfGross"],
];

/** Shops whose cached workbook totals skip rows with money in them (spec §8): the corrected totals differ. */
const SKIPPED_ROWS = ["Utica", "Rock Island", "Silvis", "Coralville", "LeClaire"];

function load(dir: string) {
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
    inputs: golden.rows.filter((r) => r.inputs.location === shop).map((r) => lineInput(r, exportRow.get(`${shop}:${r.inputs.row}`), shop)),
  }));
  return { golden, exportRow, byShop, ...assemble(byShop, DEFAULT_PAYROLL_SETTINGS) };
}

for (const fx of FIXTURES) {
  describe.skipIf(!fx.present)(`Charles's payroll workbook, ${fx.name}`, () => {
    const g = () => load(fx.dir);

    it("every Locations row: Hourly Total, Gross /Hr, Commission$, Service Total, Product Total, NetComm, Total Wages and Total % of Gross", () => {
      const { golden, byShop } = g();
      expect(byShop.reduce((a, s) => a + s.inputs.length, 0)).toBe(golden.rows.length);
      const diffs: string[] = [];
      for (const s of byShop)
        s.golden.forEach((row, n) => {
          const line = computeLine(s.inputs[n], DEFAULT_PAYROLL_SETTINGS);
          expect(line.hours).toBe(row.inputs.hours);
          expect(line.service).toBe(row.inputs.service);
          for (const [want, got] of ROW_CHECKS) {
            const w = cached(row.expected_raw[want]);
            const v = line[got] as number | null;
            if (!near(v, w)) diffs.push(`${s.shop} row ${row.inputs.row} ${want}: ${v} vs ${w}`);
          }
        });
      expect(diffs).toEqual([]);
    });

    it("typed workbook cells are manual adjustments with a reason, never silent", () => {
      const { byShop, blocks } = g();
      for (const s of byShop)
        s.golden.forEach((row, n) => {
          const l = blocks.find((b) => b.shopId === s.shopId)!.lines[n];
          const m = row.inputs.manual;
          expect(l.overridden.includes("workedHours")).toBe(m.B);
          expect(l.overridden.includes("serviceSales")).toBe(m.E);
          expect(l.overridden.includes("tips")).toBe(m.R);
          expect(l.overridden.includes("netComm")).toBe(row.inputs.netcomm_override !== null);
          expect(l.overridden.includes("productSales")).toBe(false);
          for (const k of l.overridden) expect(l.input.overrides?.[k]?.reason).toBe(TYPED);
        });
    });

    it("the workbook's cached totals are sums over its own row ranges, which skip employees", () => {
      const { golden, blocks } = g();
      const ranges = golden.workbook_total_ranges;
      if (!ranges) return;
      for (const b of blocks) {
        const sum = (k: "service" | "totalWages", [from, to]: [number, number]) => b.lines.filter((l) => +l.staffId.split(":")[1] >= from && +l.staffId.split(":")[1] <= to).reduce((a, l) => a + l[k], 0);
        const c = golden.workbook_location_totals_cached[b.shop];
        expect(near(sum("service", ranges[b.shop].E), c.E)).toBe(true);
        expect(near(sum("totalWages", ranges[b.shop].N), c.N)).toBe(true);
        const sc = golden.workbook_summary_cached[b.shop];
        expect([sc.service_sales, sc.employee_cost]).toEqual([c.E, c.N]);
        expect(near(sc.gross_profit, c.E - c.N)).toBe(true);
      }
    });

    it("the platform's totals include every employee (the corrected totals)", () => {
      const { golden, blocks, mismatches } = g();
      expect(mismatches).toEqual([]);
      const differ: string[] = [];
      for (const b of blocks) {
        const want = golden.corrected_location_totals_all_rows[b.shop];
        const t = b.totals;
        const got = { hours: t.hours, hourly_total: t.hourlyTotal, service: t.service, commission: t.commission, net_comm: t.netComm, total_wages: t.totalWages, tips: t.tips, gross_profit: t.service - t.totalWages };
        for (const [k, v] of Object.entries(want)) expect(near(got[k as keyof typeof got], v), `${b.shop} ${k}`).toBe(true);
        const c = golden.workbook_location_totals_cached[b.shop];
        if (!near(t.service, c.E) || !near(t.totalWages, c.N)) differ.push(b.shop);
      }
      expect(differ.sort()).toEqual([...SKIPPED_ROWS].sort());
    });

    it("the Locations summary: Service Sales, Employee Cost (Total Wages) and Gross Profit per shop and in total, in Charles's order", () => {
      const { golden, blocks } = g();
      const { rows, total } = locationSummary(blocks);
      expect(rows.map((r) => r.shop)).toEqual(DEFAULT_PAYROLL_SETTINGS.reportOrder);
      for (const r of rows) {
        const want = golden.corrected_location_totals_all_rows[r.shop];
        expect(near(r.service, want.service)).toBe(true);
        expect(near(r.employeeCost, want.total_wages)).toBe(true);
        expect(near(r.grossProfit, want.gross_profit)).toBe(true);
      }
      const all = Object.values(golden.corrected_location_totals_all_rows);
      expect(near(total.service, all.reduce((a, t) => a + t.service, 0))).toBe(true);
      expect(near(total.employeeCost, all.reduce((a, t) => a + t.total_wages, 0))).toBe(true);
      expect(near(total.grossProfit, total.service - total.employeeCost)).toBe(true);
      expect(near(totalsOf(blocks.flatMap((b) => b.lines)).totalWages, total.employeeCost)).toBe(true);
    });

    it("the report's columns are the Locations tab's, header for header", () => {
      expect(LOCATIONS_COLUMNS.map((c) => c.header)).toEqual([
        "Employee Name",
        "Hours",
        "Hourly Wage",
        "Hourly Total ",
        "Service$",
        "Gross /Hr",
        "Service%",
        "Commission$",
        "Service Total",
        "Product$",
        "Prod%",
        "Product Total",
        "NetComm",
        "Total Wages",
        "Total % of Gross",
        "PTO HRs.",
        "O.T. HRS",
        "TIPS",
        "Training  Hours",
      ]);
    });

    it("the iSolved export matches expected_isolved_export.xlsx cell for cell: sheets, values, cell types, number formats, fonts, fills and widths", async () => {
      const { golden, blocks } = g();
      const sheets = inNameOrder(blocks, DEFAULT_PAYROLL_SETTINGS.sheetOrder, (b) => [b.shop]);
      expect(sheets.map((b) => b.shop)).toEqual(Object.keys(golden.export_tabs));
      const files = sheets.map((b) => {
        const order = new Map(golden.export_tabs[b.shop].rows.map((r) => [`${b.shop}:${/B(\d+)$/.exec(r.source_formulas[0])![1]}`, r.row]));
        const rows = b.exportRows.filter((r) => order.has(r.staffId)).sort((x, y) => order.get(x.staffId)! - order.get(y.staffId)!);
        return { tab: b.shop, payGroup: b.shop, periodNumber: 1, periodStart: "2026-10-04", periodEnd: "2026-10-17", rows, headers: b.exportHeaders };
      });
      const ours = new ExcelJS.Workbook();
      await ours.xlsx.load((await renderIsolvedWorkbook(files)) as unknown as ArrayBuffer);
      const want = new ExcelJS.Workbook();
      await want.xlsx.readFile(path.join(fx.dir, "expected_isolved_export.xlsx"));

      expect(ours.worksheets.map((w) => w.name)).toEqual(want.worksheets.map((w) => w.name));
      const style = (c: ExcelJS.Cell) => ({
        numFmt: c.numFmt || "General",
        font: { name: c.font?.name, size: c.font?.size, bold: !!c.font?.bold },
        fill: c.fill && !(c.fill.type === "pattern" && (!c.fill.pattern || c.fill.pattern === "none")) ? JSON.stringify(c.fill) : null,
      });
      const diffs: string[] = [];
      for (const w of want.worksheets) {
        const o = ours.getWorksheet(w.name)!;
        expect([o.rowCount, o.columnCount], w.name).toEqual([w.rowCount, w.columnCount]);
        for (let col = 1; col <= w.columnCount; col++) if (o.getColumn(col).width !== w.getColumn(col).width) diffs.push(`${w.name} column ${col} width`);
        for (let r = 1; r <= w.rowCount; r++)
          for (let col = 1; col <= w.columnCount; col++) {
            const a = o.getCell(r, col);
            const b = w.getCell(r, col);
            if (asStored(a.value) !== b.value || a.type !== b.type) diffs.push(`${w.name}!${b.address} value ${JSON.stringify(a.value)} vs ${JSON.stringify(b.value)}`);
            if (JSON.stringify(style(a)) !== JSON.stringify(style(b))) diffs.push(`${w.name}!${b.address} style ${JSON.stringify(style(a))} vs ${JSON.stringify(style(b))}`);
          }
      }
      expect(diffs).toEqual([]);
    });

    it("the export's values are the golden export's, and each Key keeps its cell type", () => {
      const { golden, blocks } = g();
      for (const [tab, t] of Object.entries(golden.export_tabs)) {
        const b = blocks.find((x) => x.shop === tab)!;
        expect(b.exportHeaders).toEqual(t.headers.slice(2));
        for (const r of t.rows) {
          const id = `${tab}:${/B(\d+)$/.exec(r.source_formulas[0])![1]}`;
          const x = b.exportRows.find((e) => e.staffId === id)!;
          expect(x.key).toBe(r.key);
          expect(typeof x.key).toBe(r.key_type === "text" ? "string" : "number");
          expect(x.isolvedName).toBe(r.isolved_name);
          expect(x.values).toEqual([r.E_Regular_Hours, r.E_Overtime_1_5_Hours, r.E_Cash_Tips_Recd_Dollars, r.E_Comm_Sales_Dollars, r.E_Rayz_Paid_Time_Hours, r.E_Training_Hours]);
        }
      }
    });
  });
}

describe("golden fixtures", () => {
  it("the anonymized fixture is committed; the real one never is", () => {
    expect(FIXTURES[0].present).toBe(true);
    const ignore = readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\/tests\/fixtures\/payroll-golden\/private\/$/m);
  });
});
