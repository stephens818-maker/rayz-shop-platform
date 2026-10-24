/**
 * A small PDF writer for documents made of text, rules and shaded boxes (purchase orders). Uses the
 * built-in Helvetica fonts, so nothing is embedded. Coordinates are points from the top-left.
 */

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32–126, from the standard AFM files.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const SUBSTITUTE: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00b7": "-", "\u2022": "-", "\u00a0": " " };

/** WinAnsi (Latin-1 range) text; anything else becomes "?". */
export function pdfSafe(s: string): string {
  return [...s].map((ch) => SUBSTITUTE[ch] ?? (ch.charCodeAt(0) <= 255 && ch.charCodeAt(0) >= 32 ? ch : "?")).join("");
}

export function textWidth(s: string, size: number, bold = false): number {
  const w = bold ? W_BOLD : W_REGULAR;
  let units = 0;
  for (const ch of pdfSafe(s)) {
    const c = ch.charCodeAt(0);
    units += c >= 32 && c <= 126 ? w[c - 32] : 556;
  }
  return (units * size) / 1000;
}

/** Cut text to fit a width, with an ellipsis. */
export function fitText(s: string, maxWidth: number, size: number, bold = false): string {
  if (textWidth(s, size, bold) <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}...`, size, bold) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

function escape(s: string): string {
  return [...pdfSafe(s)]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (ch === "\\" || ch === "(" || ch === ")") return `\\${ch}`;
      return c > 126 ? `\\${c.toString(8).padStart(3, "0")}` : ch;
    })
    .join("");
}

const n = (x: number) => (Math.round(x * 100) / 100).toString();

export interface TextOpts {
  size?: number;
  bold?: boolean;
  align?: "left" | "right" | "center";
  /** 0 = black, 1 = white. */
  gray?: number;
}

export class PdfDoc {
  readonly width: number;
  readonly height: number;
  private pages: string[][] = [];

  constructor(o: { width?: number; height?: number } = {}) {
    this.width = o.width ?? 612;
    this.height = o.height ?? 792;
    this.addPage();
  }

  get pageCount() {
    return this.pages.length;
  }

  addPage() {
    this.pages.push([]);
  }

  private get ops() {
    return this.pages[this.pages.length - 1];
  }

  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const size = o.size ?? 10;
    const w = textWidth(s, size, o.bold);
    const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    this.ops.push(`BT /${o.bold ? "F2" : "F1"} ${n(size)} Tf ${n(o.gray ?? 0)} g 1 0 0 1 ${n(left)} ${n(this.height - y)} Tm (${escape(s)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; gray?: number } = {}) {
    this.ops.push(`${n(o.gray ?? 0.75)} G ${n(o.width ?? 0.5)} w ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, gray = 0.94) {
    this.ops.push(`${n(gray)} g ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re f 0 g`);
  }

  toBytes(): Uint8Array {
    const objects: string[] = [];
    /** Object numbers start at 1. */
    const add = (body: string) => objects.push(body);
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

    // Everything above is ASCII, so string length is byte length and offsets can be counted directly.
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }
}
