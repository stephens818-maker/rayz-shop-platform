import ExcelJS from "exceljs";
import { LOCATIONS_COLUMNS, inNameOrder, locationSummary, type Line, type MixedRate, type Totals } from "@/domain/payroll/calc";
import { csv } from "@/domain/time-clock";
import type { LocalDate } from "@/lib/time";
import type { BlockView, PayrollView } from "./run";

/**
 * The Payroll Report as the workbook's Locations tab: a block per shop (title, headers, a row per
 * employee, totals and Gross Profit), then the summary of service sales, employee cost and gross
 * profit. Every total sums every row, and a rate that changed inside the period shows "mixed".
 */

/** Excel's Accounting format: negatives in parentheses, zero as "-". */
export const ACCOUNTING = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
export const NO_VALUE = "—";

const TITLE_FILL: Record<string, string> = { utica: "FFFF00", rockisland: "00B0F0", silvis: "92D050" };
const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
export const titleFill = (shop: string): string | null => TITLE_FILL[letters(shop)] ?? null;

const MIXED_KEY: Partial<Record<(typeof LOCATIONS_COLUMNS)[number]["key"], MixedRate>> = { wage: "wage", servicePct: "servicePct", productPct: "productPct" };
const NOT_TOTALLED = new Set(["wage", "servicePct", "productPct"]);

export type LocationsCell = number | string | null;
export type LocationsColumnKey = (typeof LOCATIONS_COLUMNS)[number]["key"];

/** One employee's row, A to S: numbers unrounded as the workbook has them, "mixed" for a blended rate, null for #DIV/0!. */
export function locationsRow(l: Line): LocationsCell[] {
  const mixed = new Set(l.input.mixedRates ?? []);
  return LOCATIONS_COLUMNS.map((c) => {
    if (c.key === "name") return l.name;
    const m = MIXED_KEY[c.key];
    if (m && mixed.has(m)) return "mixed";
    return l[c.key] as number | null;
  });
}

/** The block's totals row: every row summed; rates left blank, Gross /Hr and Total % of Gross from the totals. */
export function locationsTotals(t: Totals): LocationsCell[] {
  return LOCATIONS_COLUMNS.map((c) => {
    if (c.key === "name") return "Total";
    if (NOT_TOTALLED.has(c.key)) return null;
    return t[c.key as keyof Totals] as number | null;
  });
}

/** The shops in the report's order (Payroll setup), cut down to the ones picked. */
export function locationBlocks(view: Pick<PayrollView, "blocks" | "settings">, shopIds?: readonly string[]): BlockView[] {
  const list = shopIds ? view.blocks.filter((b) => shopIds.includes(b.shopId)) : view.blocks;
  return inNameOrder(list, view.settings.reportOrder, (b) => [b.shop, b.exportTab]);
}

const mmddyy = (d: LocalDate) => `${d.slice(5, 7)}.${d.slice(8, 10)}.${d.slice(2, 4)}`;
/** "Rayz Payroll Report MM.DD.YY-MM.DD.YY", with the period's dates. */
export const locationsFileName = (start: LocalDate, end: LocalDate, ext: "xlsx" | "csv") => `Rayz Payroll Report ${mmddyy(start)}-${mmddyy(end)}.${ext}`;

function numFmt(kind: (typeof LOCATIONS_COLUMNS)[number]["kind"], total: boolean): string | undefined {
  if (kind === "hours") return "0.00";
  if (kind === "money" || kind === "rate" || kind === "ratio") return ACCOUNTING;
  if (kind === "pct") return total ? "0.00%" : "0%";
  return undefined;
}

/** The whole report as one sheet laid out like the Locations tab, headers character for character. */
export async function locationsWorkbook(view: Pick<PayrollView, "blocks" | "settings" | "start" | "end">, blocks: readonly BlockView[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ray'z";
  const ws = wb.addWorksheet("Locations");
  const n = LOCATIONS_COLUMNS.length;
  ws.getColumn(1).width = 24;
  for (let i = 2; i <= n; i++) ws.getColumn(i).width = 13;
  const put = (cells: LocationsCell[], total: boolean) => {
    const row = ws.addRow(cells);
    LOCATIONS_COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const v = cells[i];
      if (v === null && (c.key === "grossPerHour" || c.key === "pctOfGross")) {
        cell.value = NO_VALUE;
        cell.alignment = { horizontal: "right" };
      } else if (typeof v === "number") {
        const f = numFmt(c.kind, total && c.key === "pctOfGross");
        if (f) cell.numFmt = f;
      } else if (typeof v === "string" && i > 0) cell.alignment = { horizontal: "right" };
    });
    if (total) row.font = { bold: true };
    return row;
  };
  for (const b of blocks) {
    const title = ws.addRow([b.shop]);
    ws.mergeCells(title.number, 1, title.number, n);
    title.font = { bold: true, size: 12 };
    title.alignment = { horizontal: "center" };
    const fill = titleFill(b.shop);
    if (fill) title.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fill}` } };
    const head = ws.addRow(LOCATIONS_COLUMNS.map((c) => c.header));
    head.font = { bold: true };
    head.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    for (const l of b.lines) put(locationsRow(l), false);
    put(locationsTotals(b.totals), true);
    const gp = ws.addRow(["Gross Profit"]);
    gp.font = { bold: true };
    const cell = gp.getCell(LOCATIONS_COLUMNS.findIndex((c) => c.key === "totalWages") + 1);
    cell.value = b.totals.service - b.totals.totalWages;
    cell.numFmt = ACCOUNTING;
    ws.addRow([]);
  }
  const { rows, total } = locationSummary(blocks);
  ws.addRow([]);
  const head = ws.addRow([null, "Location", "Service Sales", "Location", "Employee Cost", "Location", "Gross Profit"]);
  head.font = { bold: true };
  for (const r of [...rows, total]) {
    const row = ws.addRow([null, r.shop, r.service, r.shop, r.employeeCost, r.shop, r.grossProfit]);
    for (const c of [3, 5, 7]) row.getCell(c).numFmt = ACCOUNTING;
    if (r === total) row.font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvNum = (v: LocationsCell) => (v === null ? "" : typeof v === "number" ? String(Number(v.toFixed(6))) : v);

/** The same report as CSV: a "Location" column ahead of the 19, totals and Gross Profit per shop, then the summary. */
export function locationsCsv(blocks: readonly BlockView[]): string {
  const out: string[][] = [["Location", ...LOCATIONS_COLUMNS.map((c) => c.header.trim())]];
  for (const b of blocks) {
    for (const l of b.lines) out.push([b.shop, ...locationsRow(l).map(csvNum)]);
    out.push([b.shop, ...locationsTotals(b.totals).map(csvNum)]);
    out.push([b.shop, "Gross Profit", ...LOCATIONS_COLUMNS.slice(1).map((c) => (c.key === "totalWages" ? csvNum(b.totals.service - b.totals.totalWages) : ""))]);
  }
  const { rows, total } = locationSummary(blocks);
  out.push([]);
  out.push(["Location", "Service Sales", "Employee Cost", "Gross Profit"]);
  for (const r of [...rows, total]) out.push([r.shop, csvNum(r.service), csvNum(r.employeeCost), csvNum(r.grossProfit)]);
  return csv(out);
}
