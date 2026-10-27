import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { EXPORT_COLUMNS, type ExportRow } from "@/domain/payroll/calc";
import { DEFAULT_TAB, EXPORTERS, TEMPLATE_TABS, exportFileName, dataRowStyles, isolvedTimecardExporter, renderIsolvedTab, tabTemplate } from "@/server/payroll/export";

/** Order-insensitive, and an empty style object is the same as none. */
const canon = (x: unknown): string =>
  x && typeof x === "object" && Object.keys(x).length ? `{${Object.keys(x).sort().map((k) => `${k}:${canon((x as Record<string, unknown>)[k])}`).join(",")}}` : x && typeof x === "object" ? "null" : JSON.stringify(x ?? null);

const rows = (n: number): ExportRow[] =>
  Array.from({ length: n }, (_, i) => ({
    staffId: `s${i}`,
    key: i % 3 === 1 ? `00${100 + i}` : 9000 + i,
    isolvedName: `PERSON, NUMBER ${i}`,
    values: [80 - i, i === 0 ? 2.78 : 0, 412.5 + i, 224.43300000000005, 0, i === 2 ? 3.5 : 0],
  }));

async function read(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("iSolved per-shop export, workbook format (each tab's own formatting)", () => {
  it.each(TEMPLATE_TABS)("%s: headers, cell types, number formats, fonts, fills, alignment, borders and widths match the workbook tab", async (tab) => {
    const t = tabTemplate(tab);
    const data = rows(t.rowStyles.length + 1);
    const wb = await read(await renderIsolvedTab({ format: "workbook", tab, payGroup: tab, periodNumber: 23, periodStart: "2026-10-18", periodEnd: "2026-10-31", rows: data }));
    expect(wb.worksheets.map((w) => w.name)).toEqual([tab]);
    const ws = wb.getWorksheet(tab)!;
    expect(ws.views[0]?.zoomScale).toBe(t.zoom);
    t.widths.forEach((w, i) => expect(ws.getColumn(i + 1).width ?? null).toBe(w));

    const diffs: string[] = [];
    const check = (cell: ExcelJS.Cell, want: Record<string, unknown> | undefined) => {
      for (const p of ["numFmt", "font", "fill", "alignment", "border"] as const) {
        if (canon(cell[p]) !== canon(want?.[p])) diffs.push(`${cell.address} ${p}`);
      }
    };
    t.header.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      expect(c.value ?? null).toBe(h);
      check(c, t.headerStyles[i]);
    });
    data.forEach((r, n) => {
      const styles = dataRowStyles(t, n);
      const row = ws.getRow(n + 2);
      const key = row.getCell(1);
      expect(key.value).toBe(r.key);
      expect(key.type).toBe(typeof r.key === "string" ? ExcelJS.ValueType.String : ExcelJS.ValueType.Number);
      expect(row.getCell(2).value).toBe(r.isolvedName);
      r.values.forEach((v, i) => {
        expect(row.getCell(i + 3).value).toBe(v);
        expect(row.getCell(i + 3).type).toBe(ExcelJS.ValueType.Number);
      });
      styles.forEach((s, i) => check(row.getCell(i + 1), s));
    });
    t.trailingStyles.forEach((styles, n) => styles.forEach((s, i) => check(ws.getRow(data.length + 2 + n).getCell(i + 1), s)));
    expect(diffs).toEqual([]);
  });

  it("the header row is exactly the workbook's, including E_Cash Tips Recd_Dollars, in order", async () => {
    for (const tab of TEMPLATE_TABS) expect(tabTemplate(tab).header).toEqual(["Key", null, ...EXPORT_COLUMNS.map((c) => c.header)]);
  });

  it("carries no OT dollars: the OT column is hours and no column is OT pay", async () => {
    const ws = (await read(await renderIsolvedTab({ format: "workbook", tab: "Moline", payGroup: "Moline", periodNumber: 23, periodStart: "", periodEnd: "", rows: rows(2) }))).getWorksheet("Moline")!;
    const headers = (ws.getRow(1).values as unknown[]).filter((v) => typeof v === "string") as string[];
    expect(headers.filter((h) => /overtime|o\.?t\.?/i.test(h))).toEqual(["E_Overtime 1.5_Hours"]);
    expect(headers.filter((h) => h.endsWith("_Dollars"))).toEqual(["E_Cash Tips Recd_Dollars", "E_Comm Sales_Dollars"]);
    expect(ws.getCell("D2").value).toBe(2.78);
  });

  it("text keys keep text (and the @ format where the workbook has it); number keys stay numbers", async () => {
    const t = tabTemplate("Utica");
    const textRow = t.rowStyles.findIndex((r) => r[0].numFmt === "@");
    expect(textRow).toBeGreaterThanOrEqual(0);
    const data = rows(t.rowStyles.length);
    data[textRow] = { ...data[textRow], key: "0012345" };
    const ws = (await read(await renderIsolvedTab({ format: "workbook", tab: "Utica", payGroup: "Utica", periodNumber: 23, periodStart: "", periodEnd: "", rows: data }))).getWorksheet("Utica")!;
    const c = ws.getCell(textRow + 2, 1);
    expect(c.value).toBe("0012345");
    expect(c.numFmt).toBe("@");
  });

  it("Dubuque gets its own file in the same format, under its own sheet name", async () => {
    const wb = await read(await renderIsolvedTab({ format: "workbook", tab: "Dubuque", payGroup: "Dubuque", periodNumber: 1, periodStart: "2026-10-04", periodEnd: "2026-10-17", rows: rows(2) }));
    const ws = wb.getWorksheet("Dubuque")!;
    expect(ws).toBeDefined();
    const t = tabTemplate(DEFAULT_TAB);
    expect(ws.getRow(1).getCell(3).value).toBe("E_Regular_Hours");
    expect(canon(ws.getCell("A1").font)).toBe(canon(t.headerStyles[0].font));
    expect(isolvedTimecardExporter.fileName({ tab: "Dubuque", payGroup: "Dubuque", periodNumber: 1, periodStart: "2026-10-04", periodEnd: "2026-10-17", rows: [] })).toBe(
      "10.04.26-10.17.26 Dubuque.xlsx",
    );
  });

  it("file names follow the settings pattern; characters a file name can't hold become spaces", () => {
    const f = { tab: "Le/Claire", payGroup: "LeClaire", periodNumber: 3, periodStart: "2026-10-04", periodEnd: "2026-10-17" };
    expect(exportFileName("{payGroup} - period {period} ({startIso} to {endIso})", f)).toBe("LeClaire - period 03 (2026-10-04 to 2026-10-17).xlsx");
    expect(exportFileName("{shop} {unknown}", f)).toBe("Le Claire {unknown}.xlsx");
    expect(exportFileName("", f)).toBe("iSolved.xlsx");
    expect(isolvedTimecardExporter.fileName({ ...f, tab: "Moline", rows: [], namePattern: "Payroll {end} {shop}" })).toBe("Payroll 10.17.26 Moline.xlsx");
  });

  it("{code} is the shop's iSolved pay group code, and drops out until it's set", () => {
    const f = { tab: "Moline", payGroup: "Moline", periodNumber: 22, periodStart: "2026-10-04", periodEnd: "2026-10-17" };
    expect(exportFileName("{code} {shop} {period}", { ...f, payGroupCode: "C" })).toBe("C Moline 22.xlsx");
    expect(exportFileName("{code} {shop} {period}", { ...f, payGroupCode: null })).toBe("Moline 22.xlsx");
    expect(exportFileName("{code} {shop} {period}", f)).toBe("Moline 22.xlsx");
  });

  it("the only exporter writes a file; nothing connects to iSolved", () => {
    expect(EXPORTERS.map((e) => e.id)).toEqual(["isolved-timecard-xlsx"]);
  });
});
