import ExcelJS from "exceljs";
import { cellText, cellValue, flatTable, type ExportFormat, type FlatTable, type ReportResult } from "@/domain/report-builder";
import { PdfDoc, fitText, textWidth } from "@/lib/pdf";
import { toCsv } from "../reports";

export interface ExportMeta {
  name: string;
  /** "Last 30 days (Sep 25 – Oct 24, 2026) · Coralville, Moline" */
  subtitle: string;
  /** "Generated Oct 24, 2026, 7:02 AM" */
  generated: string;
  /** For the file name, YYYY-MM-DD. */
  date: string;
  summary: boolean;
}

export interface ExportFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "report";

const typeAt = (t: FlatTable, kind: string, i: number) => (kind === "row" ? t.types[i] : t.totalTypes[i]);
const maskedAt = (t: FlatTable, kind: string, i: number) => kind === "row" && t.masked[i];

export function renderCsv(t: FlatTable): Uint8Array {
  return new TextEncoder().encode(
    toCsv(
      t.headers,
      t.rows.map((r) => r.cells.map((c, i) => cellValue(typeAt(t, r.kind, i), c, maskedAt(t, r.kind, i)))),
    ),
  );
}

const FMT: Partial<Record<string, string>> = { money: '"$"#,##0.00', int: "#,##0", number: "#,##0.0", stars: "0.0" };

export async function renderXlsx(t: FlatTable, meta: ExportMeta): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ray'z";
  const ws = wb.addWorksheet(meta.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Report", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.addRow([meta.name]).font = { bold: true, size: 14 };
  ws.addRow([`${meta.subtitle} · ${meta.generated}`]).font = { color: { argb: "FF71717A" } };
  ws.addRow([]);
  const head = ws.addRow(t.headers);
  head.font = { bold: true };
  head.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F5" } }));
  for (const r of t.rows) {
    const row = ws.addRow(
      r.cells.map((c, i) => {
        const v = cellValue(typeAt(t, r.kind, i), c, maskedAt(t, r.kind, i));
        // A text cell that looks like a formula stays text.
        return typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v;
      }),
    );
    r.cells.forEach((_, i) => {
      const f = maskedAt(t, r.kind, i) ? undefined : FMT[typeAt(t, r.kind, i)];
      if (f) row.getCell(i + 1).numFmt = f;
    });
    if (r.kind !== "row") row.font = { bold: true };
  }
  t.headers.forEach((h, i) => {
    const longest = Math.max(h.length, ...t.rows.slice(0, 500).map((r) => cellText(typeAt(t, r.kind, i), r.cells[i], maskedAt(t, r.kind, i)).length));
    ws.getColumn(i + 1).width = Math.min(48, Math.max(10, longest + 2));
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Landscape letter pages: a header on each, columns sized to their content, repeated column titles. */
export function renderPdf(t: FlatTable, meta: ExportMeta): Uint8Array {
  const doc = new PdfDoc({ width: 792, height: 612 });
  const margin = 36;
  const usable = 792 - margin * 2;
  const size = t.headers.length > 10 ? 7 : 8;
  const text = (kind: string, i: number, c: unknown) => cellText(typeAt(t, kind, i), c as never, maskedAt(t, kind, i));
  const natural = t.headers.map((h, i) => Math.max(textWidth(h, size, true), ...t.rows.slice(0, 300).map((r) => textWidth(text(r.kind, i, r.cells[i]), size, r.kind !== "row"))) + 8);
  const sum = natural.reduce((a, b) => a + b, 0);
  const widths = sum <= usable ? natural.map((w) => w + (usable - sum) / natural.length) : natural.map((w) => Math.max(36, (w / sum) * usable));
  const numeric = t.headers.map((_, i) => ["money", "int", "number", "stars"].includes(t.types[i]) && !t.masked[i]);
  let y = 0;
  let pageNo = 1;
  const top = () => {
    doc.text(margin, 40, fitText(meta.name, usable * 0.65, 14, true), { size: 14, bold: true });
    doc.text(792 - margin, 40, `Page ${pageNo}`, { size: 8, align: "right", gray: 0.45 });
    doc.text(margin, 56, fitText(`${meta.subtitle} · ${meta.generated}`, usable, 8), { size: 8, gray: 0.45 });
    y = 78;
    doc.rect(margin, y - 10, usable, 14, 0.93);
    let x = margin;
    t.headers.forEach((h, i) => {
      doc.text(numeric[i] ? x + widths[i] - 4 : x + 3, y, fitText(h, widths[i] - 6, size, true), { size, bold: true, align: numeric[i] ? "right" : "left" });
      x += widths[i];
    });
    y += 14;
  };
  top();
  for (const r of t.rows) {
    if (y > 612 - margin) {
      doc.addPage();
      pageNo++;
      top();
    }
    if (r.kind !== "row") doc.rect(margin, y - 9, usable, 12, r.kind === "total" ? 0.88 : 0.96);
    let x = margin;
    r.cells.forEach((c, i) => {
      const s = fitText(text(r.kind, i, c), widths[i] - 6, size, r.kind !== "row");
      doc.text(numeric[i] ? x + widths[i] - 4 : x + 3, y, s, { size, bold: r.kind !== "row", align: numeric[i] ? "right" : "left" });
      x += widths[i];
    });
    y += 12;
  }
  if (!t.rows.length) doc.text(margin, y + 4, "No clients match this report.", { size: 9, gray: 0.45 });
  return doc.toBytes();
}

export async function renderReport(result: Pick<ReportResult, "columns" | "groupBy" | "lines" | "totals">, format: ExportFormat, meta: ExportMeta): Promise<ExportFile> {
  const t = flatTable(result, meta.summary);
  const base = `${slug(meta.name)}-${meta.date}`;
  const bytes = format === "csv" ? renderCsv(t) : format === "xlsx" ? await renderXlsx(t, meta) : renderPdf(t, meta);
  return { filename: `${base}.${format}`, contentType: CONTENT_TYPE[format], bytes };
}
