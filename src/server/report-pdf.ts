import { formatCell, numericKind } from "@/domain/report-format";
import type { ColumnKind, ReportTable } from "@/domain/report-views";
import { PdfDoc, fitText, textWidth } from "@/lib/pdf";

/** Rows per table in the PDF; the CSV has every row. */
export const PDF_MAX_ROWS = 400;

const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const USABLE = PAGE_W - MARGIN * 2;

/**
 * A report as a landscape PDF: its title and range, the stat tiles, then every table the page shows
 * (subtotal and total rows shaded), each cut to `PDF_MAX_ROWS` rows. Numbers are formatted as on the page.
 */
export function reportPdf(r: { title: string; subtitle: string; generated: string; stats: { label: string; value: string; hint?: string }[]; tables: ReportTable[]; notes?: string[] }): Uint8Array {
  const doc = new PdfDoc({ width: PAGE_W, height: PAGE_H });
  let page = 1;
  let y = 0;
  const header = () => {
    doc.text(MARGIN, 40, fitText(r.title, USABLE * 0.7, 14, true), { size: 14, bold: true });
    doc.text(PAGE_W - MARGIN, 40, `Page ${page}`, { size: 8, align: "right", gray: 0.45 });
    doc.text(MARGIN, 56, fitText(`${r.subtitle} · ${r.generated}`, USABLE, 8), { size: 8, gray: 0.45 });
    y = 76;
  };
  const newPage = () => {
    doc.addPage();
    page++;
    header();
  };
  const room = (h: number) => {
    if (y + h > PAGE_H - MARGIN) newPage();
  };
  header();

  if (r.stats.length) {
    const perRow = Math.min(4, r.stats.length);
    const w = USABLE / perRow;
    r.stats.forEach((s, i) => {
      if (i % perRow === 0) room(40);
      const x = MARGIN + (i % perRow) * w;
      doc.rect(x + 2, y - 10, w - 4, 36, 0.96);
      doc.text(x + 8, y, fitText(s.label, w - 16, 7), { size: 7, gray: 0.4 });
      doc.text(x + 8, y + 13, fitText(s.value, w - 16, 11, true), { size: 11, bold: true });
      if (s.hint) doc.text(x + 8, y + 22, fitText(s.hint, w - 16, 6), { size: 6, gray: 0.5 });
      if (i % perRow === perRow - 1 || i === r.stats.length - 1) y += 42;
    });
    y += 4;
  }

  for (const t of r.tables.filter((x) => !x.exportOnly)) {
    const size = t.columns.length > 12 ? 6 : t.columns.length > 8 ? 7 : 8;
    const kindAt = (i: number, j: number): ColumnKind | undefined => (t.rowKinds?.[i] && j > 0 ? t.rowKinds[i] : t.columns[j]?.kind);
    const body = t.rows.slice(0, PDF_MAX_ROWS);
    const cell = (i: number, j: number) => formatCell(body[i][j], kindAt(i, j));
    const natural = t.columns.map((c, j) => Math.max(textWidth(c.label, size, true), ...body.slice(0, 200).map((_, i) => textWidth(cell(i, j), size, !!t.rowStyles?.[i]))) + 8);
    const sum = natural.reduce((a, b) => a + b, 0);
    const widths = sum <= USABLE ? natural.map((w) => w + (USABLE - sum) / natural.length) : natural.map((w) => Math.max(30, (w / sum) * USABLE));
    const right = t.columns.map((c, j) => (t.rowKinds ? j > 0 : numericKind(c.kind)));
    const columnHeader = () => {
      doc.rect(MARGIN, y - 9, USABLE, 13, 0.92);
      let x = MARGIN;
      t.columns.forEach((c, j) => {
        doc.text(right[j] ? x + widths[j] - 3 : x + 3, y, fitText(c.label, widths[j] - 6, size, true), { size, bold: true, align: right[j] ? "right" : "left" });
        x += widths[j];
      });
      y += 13;
    };
    room(40);
    doc.text(MARGIN, y + 2, fitText(t.title, USABLE, 10, true), { size: 10, bold: true });
    y += 16;
    if (!body.length) {
      doc.text(MARGIN, y, "Nothing in this range.", { size: 8, gray: 0.45 });
      y += 18;
      continue;
    }
    columnHeader();
    body.forEach((row, i) => {
      if (y + 11 > PAGE_H - MARGIN) {
        newPage();
        doc.text(MARGIN, y + 2, fitText(`${t.title} (continued)`, USABLE, 9, true), { size: 9, bold: true });
        y += 14;
        columnHeader();
      }
      const style = t.rowStyles?.[i];
      if (style) doc.rect(MARGIN, y - 8, USABLE, 11, style === "total" ? 0.88 : 0.95);
      let x = MARGIN;
      row.forEach((_, j) => {
        doc.text(right[j] ? x + widths[j] - 3 : x + 3, y, fitText(cell(i, j), widths[j] - 6, size, !!style), { size, bold: !!style, align: right[j] ? "right" : "left" });
        x += widths[j];
      });
      y += 11;
    });
    if (t.rows.length > body.length) {
      doc.text(MARGIN, y + 2, `The first ${body.length} of ${t.rows.length} rows. The CSV has them all.`, { size: 7, gray: 0.45 });
      y += 12;
    }
    y += 12;
  }

  for (const n of r.notes ?? []) {
    const words = n.split(/\s+/);
    let lineText = "";
    const flush = () => {
      room(10);
      doc.text(MARGIN, y, lineText, { size: 7, gray: 0.4 });
      y += 9;
      lineText = "";
    };
    for (const w of words) {
      if (textWidth(`${lineText} ${w}`, 7) > USABLE && lineText) flush();
      lineText = lineText ? `${lineText} ${w}` : w;
    }
    if (lineText) flush();
    y += 3;
  }
  return doc.toBytes();
}
