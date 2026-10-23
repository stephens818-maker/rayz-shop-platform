import ExcelJS from "exceljs";
import { EXPORT_COLUMNS, type ExportRow } from "@/domain/payroll/calc";
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
  /** The workbook tab this shop's file copies (sheet name and formatting). */
  tab: string;
  payGroup: string;
  periodNumber: number;
  periodStart: string;
  periodEnd: string;
  rows: ExportRow[];
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

export function addIsolvedSheet(wb: ExcelJS.Workbook, f: ExportFile): ExcelJS.Worksheet {
  const t = tabTemplate(f.tab);
  const ws = wb.addWorksheet(f.tab, { views: [{ zoomScale: t.zoom, zoomScaleNormal: t.zoom }] });
  t.widths.forEach((w, i) => {
    if (w) ws.getColumn(i + 1).width = w;
  });
  const header = ws.getRow(1);
  t.header.forEach((h, i) => {
    const c = header.getCell(i + 1);
    if (h !== null) c.value = h;
    apply(c, t.headerStyles[i]);
  });
  if (t.header[2] !== EXPORT_COLUMNS[0].header) throw new Error("Template headers changed");
  f.rows.forEach((r, n) => {
    const styles = dataRowStyles(t, n);
    const row = ws.getRow(n + 2);
    const cells: (string | number | null)[] = [r.key, r.isolvedName, ...r.values];
    cells.forEach((v, i) => {
      const c = row.getCell(i + 1);
      if (v !== null) c.value = v;
      apply(c, styles[i]);
    });
  });
  t.trailingStyles.forEach((styles, n) => {
    const row = ws.getRow(f.rows.length + 2 + n);
    styles.forEach((s, i) => apply(row.getCell(i + 1), s));
  });
  return ws;
}

export const isolvedTimecardExporter: PayrollExporter = {
  id: "isolved-timecard-xlsx",
  label: "iSolved Timecard Import (xlsx, one file per shop)",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileName: (f) => `${f.tab} - period ${String(f.periodNumber).padStart(2, "0")} (${f.periodStart} to ${f.periodEnd}).xlsx`,
  render: renderIsolvedTab,
};

export const EXPORTERS: readonly PayrollExporter[] = [isolvedTimecardExporter];
