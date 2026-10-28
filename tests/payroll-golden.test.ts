import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { totalsFormulaProblems } from "@/domain/payroll/workbook-audit";
import { DEFAULT_PAYROLL_SETTINGS, LOCATIONS_COLUMNS, computeLine, inNameOrder, locationSummary, totalsOf, type Line } from "@/domain/payroll/calc";
import { renderIsolvedWorkbook } from "@/server/payroll/export";
import { ACCOUNTING, NO_VALUE, locationsCsv, locationsWorkbook } from "@/server/payroll/locations";
import type { BlockView } from "@/server/payroll/run";
import { FIXTURES, TOTALS_ROW, TYPED, cached, load, near, type GoldenRow } from "./payroll-golden-fixtures";

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

/** The reference file was written by openpyxl, which stores numbers to 16 significant digits; the export keeps the formula's full double (checked exactly against golden.json). */
const asStored = (v: ExcelJS.CellValue) => (typeof v === "number" ? Number(v.toPrecision(16)) : v);

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

    it("I12: Kimberly's cached B, C and R totals are circular and reach into Rock Island's rows, so they're never an expected value", () => {
      const { golden } = g();
      const rowsOf = (shop: string) => golden.rows.filter((r) => r.inputs.location === shop).map((r) => r.inputs.row);
      const kimberly = ["B", "C", "R"].flatMap((c) => totalsFormulaProblems({ shop: "Kimberly", column: c, row: TOTALS_ROW.Kimberly, formula: `=SUM(${c}24:${c}37)`, employeeRows: rowsOf("Kimberly") }));
      expect(kimberly.map((p) => `${p.cell} ${p.kind}`)).toEqual(["B30 circular", "B30 outside_block", "C30 circular", "C30 outside_block", "R30 circular", "R30 outside_block"]);
      expect(kimberly[0].message).toBe("Kimberly B30 = =SUM(B24:B37) includes itself: a circular reference, so its cached value is stale, not a sum. Never an expected value.");
      const e = Object.entries(golden.workbook_location_totals_cached).flatMap(([shop, c]) =>
        totalsFormulaProblems({ shop, column: "E", row: TOTALS_ROW[shop], formula: c.formula_E, employeeRows: rowsOf(shop) }),
      );
      expect(e.filter((p) => p.kind !== "skips_rows")).toEqual([]);
      expect(e.map((p) => p.shop).sort()).toEqual(["Coralville", "Rock Island", "Silvis", "Utica"]);
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

    it("the Payroll Report download is the Locations tab: blocks in Charles's order, headers character for character, every row's values and formats, totals and the summary", async () => {
      const { golden, blocks } = g();
      const ordered = inNameOrder(blocks, DEFAULT_PAYROLL_SETTINGS.reportOrder, (b) => [b.shop]) as unknown as BlockView[];
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await locationsWorkbook({ blocks: ordered, settings: DEFAULT_PAYROLL_SETTINGS, start: "2026-10-04", end: "2026-10-17" }, ordered)) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet("Locations")!;
      // ExcelJS reads the Accounting format back without its backslashes; the file has them (styles.xml).
      const unescaped = (f: string | undefined) => f?.replace(/\\/g, "");
      const FMT = { hours: "0.00", rate: unescaped(ACCOUNTING), money: unescaped(ACCOUNTING), ratio: unescaped(ACCOUNTING), pct: "0%" } as const;
      const diffs: string[] = [];
      let r = 1;
      for (const b of ordered) {
        expect(ws.getCell(r, 1).value).toBe(b.shop);
        const fill = { Utica: "FFFFFF00", "Rock Island": "FF00B0F0", Silvis: "FF92D050" }[b.shop];
        expect((ws.getCell(r, 1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb, b.shop).toBe(fill);
        expect(LOCATIONS_COLUMNS.map((_, j) => ws.getCell(r + 1, j + 1).value)).toEqual(LOCATIONS_COLUMNS.map((c) => c.header));
        r += 2;
        b.lines.forEach((l, n) => {
          const want = golden.rows.filter((x) => x.inputs.location === b.shop)[n];
          LOCATIONS_COLUMNS.forEach((c, j) => {
            const cell = ws.getCell(r, j + 1);
            const v = c.key === "name" ? l.name : (l[c.key] as number | null);
            if (v === null) {
              if (cell.value !== NO_VALUE) diffs.push(`${b.shop} ${l.name} ${c.header}: ${String(cell.value)} for #DIV/0!`);
            } else if (cell.value !== v) diffs.push(`${b.shop} ${l.name} ${c.header}: ${String(cell.value)} vs ${v}`);
            if (c.kind !== "text" && v !== null && unescaped(cell.numFmt) !== FMT[c.kind]) diffs.push(`${b.shop} ${c.header} format ${cell.numFmt}`);
          });
          for (const [k, j] of [["total_wages", 14], ["net_comm", 13], ["hourly_total", 4]] as const) if (!near(ws.getCell(r, j).value as number, cached(want.expected_raw[k]))) diffs.push(`${b.shop} ${l.name} ${k} vs the workbook`);
          r++;
        });
        expect(ws.getCell(r, 1).value).toBe("Total");
        expect(ws.getCell(r, 15).numFmt).toBe(b.totals.pctOfGross === null ? undefined : "0.00%");
        expect(near(ws.getCell(r, 5).value as number, golden.corrected_location_totals_all_rows[b.shop].service)).toBe(true);
        expect(ws.getCell(r, 3).value).toBeNull();
        expect([ws.getCell(r + 1, 1).value, ws.getCell(r + 1, 14).value]).toEqual(["Gross Profit", b.totals.service - b.totals.totalWages]);
        r += 3;
      }
      expect(diffs).toEqual([]);
      r++;
      expect([2, 3, 4, 5, 6, 7].map((c) => ws.getCell(r, c).value)).toEqual(["Location", "Service Sales", "Location", "Employee Cost", "Location", "Gross Profit"]);
      for (const b of ordered) {
        r++;
        const want = golden.corrected_location_totals_all_rows[b.shop];
        expect(ws.getCell(r, 2).value).toBe(b.shop);
        expect(near(ws.getCell(r, 3).value as number, want.service) && near(ws.getCell(r, 5).value as number, want.total_wages) && near(ws.getCell(r, 7).value as number, want.gross_profit), b.shop).toBe(true);
        expect(unescaped(ws.getCell(r, 7).numFmt)).toBe(unescaped(ACCOUNTING));
      }
      expect(ws.getCell(r + 1, 2).value).toBe("Total");
      const csv = locationsCsv(ordered).split("\r\n");
      expect(csv[0]).toBe(["Location", ...LOCATIONS_COLUMNS.map((c) => c.header.trim())].join(","));
      expect(csv.filter((x) => x.includes(",Total,")).length).toBe(ordered.length);
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
