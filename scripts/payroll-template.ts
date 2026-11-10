/**
 * Extracts the per-shop iSolved tabs' formatting from Charles's payroll workbook into
 * src/server/payroll/isolved-template.json: column widths, zoom, header text, and every cell's type
 * hint, number format, font, fill, alignment and border by row position. No names, keys or values
 * leave the workbook.
 *
 *   pnpm tsx scripts/payroll-template.ts path/to/payroll-workbook.xlsx
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";
import path from "node:path";

const TABS = ["Rock Island", "Moline", "Utica", "Kimberly", "Silvis", "Coralville", "LeClaire"];
const COLS = 8;

const styleOf = (c: ExcelJS.Cell) => {
  const s = JSON.parse(JSON.stringify({ numFmt: c.numFmt, font: c.font, fill: c.fill, alignment: c.alignment, border: c.border }));
  for (const k of Object.keys(s)) if (s[k] === undefined || (typeof s[k] === "object" && Object.keys(s[k]).length === 0)) delete s[k];
  return s;
};

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Pass the workbook path.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const tabs: Record<string, unknown> = {};
  for (const name of TABS) {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`No ${name} tab`);
    const row = (r: number) => Array.from({ length: COLS }, (_, i) => styleOf(ws.getCell(r, i + 1)));
    let last = 1;
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value !== null || ws.getCell(r, 2).value !== null) last = r;
    tabs[name] = {
      widths: Array.from({ length: COLS }, (_, i) => ws.getColumn(i + 1).width ?? null),
      zoom: ws.views[0]?.zoomScale ?? 100,
      header: Array.from({ length: COLS }, (_, i) => {
        const v = ws.getCell(1, i + 1).value;
        return typeof v === "string" ? v : null;
      }),
      headerStyles: row(1),
      rowStyles: Array.from({ length: last - 1 }, (_, i) => row(i + 2)),
      trailingStyles: Array.from({ length: Math.max(0, ws.rowCount - last) }, (_, i) => row(last + 1 + i)),
    };
  }
  const out = path.join(__dirname, "..", "src", "server", "payroll", "isolved-template.json");
  writeFileSync(out, JSON.stringify({ source: "Shop tabs of the payroll workbook (formatting only)", defaultTab: "Rock Island", tabs }, null, 1) + "\n");
  console.log(`Wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
