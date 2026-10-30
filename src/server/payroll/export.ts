import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { DEFAULT_PAYROLL_SETTINGS, EXPORT_COLUMNS, type ExportFormat, type ExportRow } from "@/domain/payroll/calc";
import template from "./isolved-template.json";

/**
 * How payroll leaves the platform. Today the only exporter writes Charles's per-shop iSolved tab as
 * an xlsx that he uploads by hand (Timecard Import, picking the pay group at upload). A direct iSolved
 * integration would be another implementation of this interface; none exists, and nothing here
 * talks to iSolved.
 */
export interface PayrollExporter {
  id: string;
  label: string;
  contentType: string;
  fileName(f: ExportFile): string;
  render(f: ExportFile): Promise<Buffer>;
}

export interface ExportFile {
  /** The sheet name: the shop's name as iSolved's tab has it ("LeClaire"). In the workbook format, also the tab whose formatting the file copies. */
  tab: string;
  payGroup: string;
  /** iSolved's pay group code, for the file name; absent or null until set. */
  payGroupCode?: string | null;
  periodNumber: number;
  periodStart: string;
  periodEnd: string;
  rows: ExportRow[];
  /** The columns after Key and name. The template's six unless tips paid in payroll add one; absent means the six. */
  headers?: string[];
  /** Absent: uniform. */
  format?: ExportFormat;
  /** The file name pattern (payroll settings); absent: the default. */
  namePattern?: string;
}

type Style = Partial<Pick<ExcelJS.Cell, "numFmt" | "font" | "fill" | "alignment" | "border">>;
interface TabTemplate {
  widths: (number | null)[];
  zoom: number;
  header: (string | null)[];
  headerStyles: Style[];
  rowStyles: Style[][];
  trailingStyles: Style[][];
}

const TABS = template.tabs as unknown as Record<string, TabTemplate>;
export const TEMPLATE_TABS = Object.keys(TABS);
export const DEFAULT_TAB = template.defaultTab;

/** A shop without a tab of its own (Dubuque) gets the default tab's formatting under its own sheet name. */
export function tabTemplate(tab: string): TabTemplate {
  return TABS[tab] ?? TABS[DEFAULT_TAB];
}

/** Row n's styles (0-based data row). Rows past the workbook's roster take its last data row's styles. */
export function dataRowStyles(t: TabTemplate, n: number): Style[] {
  return t.rowStyles[Math.min(n, t.rowStyles.length - 1)] ?? t.headerStyles;
}

function apply(cell: ExcelJS.Cell, s: Style | undefined) {
  if (!s) return;
  if (s.numFmt !== undefined) cell.numFmt = s.numFmt;
  if (s.font) cell.font = s.font;
  if (s.fill) cell.fill = s.fill;
  if (s.alignment) cell.alignment = s.alignment;
  if (s.border) cell.border = s.border;
}

export async function renderIsolvedTab(f: ExportFile): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addIsolvedSheet(wb, f);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Every shop's sheet in one workbook, in the order given. */
export async function renderIsolvedWorkbook(files: readonly ExportFile[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ray'z";
  for (const f of files) addIsolvedSheet(wb, f);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Excel's limits on a sheet name: 31 characters, none of []:*?/\ . */
export const sheetName = (s: string) => s.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";

export function addIsolvedSheet(wb: ExcelJS.Workbook, f: ExportFile): ExcelJS.Worksheet {
  return (f.format ?? "uniform") === "workbook" ? addWorkbookSheet(wb, f) : addUniformSheet(wb, f);
}

const UNIFORM_WIDTHS = [10.71, 28.71, 16, 20.43, 22.71, 21.43, 22, 16.43];
const GREY: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCDCDC" } };

/**
 * The reference file's layout (golden expected_isolved_export.xlsx): Arial 8; bold headers, grey on A1
 * to F1; `0.00` on the header from D and on every data cell from C. Key cells keep their type (text
 * or number) in General format, so iSolved reads them exactly as stored. No totals, no blank rows.
 */
function addUniformSheet(wb: ExcelJS.Workbook, f: ExportFile): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName(f.tab));
  const headers = f.headers ?? EXPORT_COLUMNS.map((c) => c.header);
  const all: (string | null)[] = ["Key", null, ...headers];
  for (let i = 0; i < all.length; i++) ws.getColumn(i + 1).width = UNIFORM_WIDTHS[i] ?? 22;
  const header = ws.getRow(1);
  all.forEach((h, i) => {
    const c = header.getCell(i + 1);
    if (h !== null) c.value = h;
    c.font = { name: "Arial", size: 8, bold: true };
    if (i < 6) c.fill = GREY;
    if (i >= 3) c.numFmt = "0.00";
  });
  f.rows.forEach((r, n) => {
    const row = ws.getRow(n + 2);
    [r.key, r.isolvedName, ...r.values].forEach((v, i) => {
      const c = row.getCell(i + 1);
      if (v !== null) c.value = v;
      c.font = { name: "Arial", size: 8 };
      if (i >= 2) c.numFmt = "0.00";
    });
  });
  return ws;
}

function addWorkbookSheet(wb: ExcelJS.Workbook, f: ExportFile): ExcelJS.Worksheet {
  const t = tabTemplate(f.tab);
  const ws = wb.addWorksheet(sheetName(f.tab), { views: [{ zoomScale: t.zoom, zoomScaleNormal: t.zoom }] });
  t.widths.forEach((w, i) => {
    if (w) ws.getColumn(i + 1).width = w;
  });
  const header = ws.getRow(1);
  t.header.forEach((h, i) => {
    const c = header.getCell(i + 1);
    const own = i >= 2 ? f.headers?.[i - 2] : undefined;
    if (own ?? h) c.value = own ?? h;
    apply(c, t.headerStyles[i]);
  });
  if (t.header[2] !== EXPORT_COLUMNS[0].header) throw new Error("Template headers changed");
  const first = 2 + EXPORT_COLUMNS.length;
  (f.headers ?? []).slice(EXPORT_COLUMNS.length).forEach((h, i) => {
    const c = header.getCell(first + i + 1);
    c.value = h;
    apply(c, t.headerStyles[first - 1]);
  });
  f.rows.forEach((r, n) => {
    const styles = dataRowStyles(t, n);
    const row = ws.getRow(n + 2);
    const cells: (string | number | null)[] = [r.key, r.isolvedName, ...r.values];
    cells.forEach((v, i) => {
      const c = row.getCell(i + 1);
      if (v !== null) c.value = v;
      apply(c, styles[Math.min(i, first - 1)]);
    });
  });
  t.trailingStyles.forEach((styles, n) => {
    const row = ws.getRow(f.rows.length + 2 + n);
    styles.forEach((s, i) => apply(row.getCell(i + 1), s));
  });
  return ws;
}

const mdy = (d: string) => (d ? DateTime.fromISO(d).toFormat("MM.dd.yy") : "");

/**
 * A file name from its pattern (payroll settings): {start} and {end} as MM.DD.YY, {startIso},
 * {endIso}, {shop}, {payGroup}, {code} (iSolved's pay group code, blank until set) and {period}.
 * Anything a file name can't hold becomes a space.
 */
export function exportFileName(pattern: string, f: Pick<ExportFile, "tab" | "payGroup" | "payGroupCode" | "periodNumber" | "periodStart" | "periodEnd">): string {
  const v: Record<string, string> = {
    start: mdy(f.periodStart),
    end: mdy(f.periodEnd),
    startIso: f.periodStart,
    endIso: f.periodEnd,
    shop: f.tab,
    payGroup: f.payGroup,
    code: f.payGroupCode ?? "",
    period: String(f.periodNumber).padStart(2, "0"),
  };
  const name = pattern
    .replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || "iSolved"}.xlsx`;
}

export const isolvedTimecardExporter: PayrollExporter = {
  id: "isolved-timecard-xlsx",
  label: "iSolved Timecard Import (xlsx, one file per shop)",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileName: (f) => exportFileName(f.namePattern ?? DEFAULT_PAYROLL_SETTINGS.exportFileName, f),
  render: renderIsolvedTab,
};

export const EXPORTERS: readonly PayrollExporter[] = [isolvedTimecardExporter];
