import ExcelJS from "exceljs";
import { BASE_COLUMNS, shopColumn, templateHeaders } from "@/domain/catalog-import";
import { routeStaff } from "@/server/auth/staff";
import { toCsv } from "@/server/reports";

/** A blank upload sheet with the caller's shops as per-shop columns and two example rows. */
export async function GET(req: Request) {
  const ctx = await routeStaff(["catalog.manage", "inventory.manage"]);
  if (ctx instanceof Response) return ctx;
  const format = new URL(req.url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const headers = templateHeaders(ctx.shops);
  const example = (cols: Record<string, string>) => headers.map((h) => cols[h] ?? "");
  const first = ctx.shops[0];
  const rows = [
    example({
      type: "product",
      sku: "REUZEL-BLUE-4OZ",
      name: "Reuzel Blue Pomade 4oz",
      category: "Styling",
      maker: "Reuzel",
      brand_cost: "11.00",
      price: "24.00",
      tax_category: "product",
      barcode: "850012345678",
      active: "yes",
      low_stock_threshold: "3",
      ...(first ? { [shopColumn("price", first)]: "22.00", [shopColumn("stock", first)]: "12" } : {}),
    }),
    example({ type: "service", sku: "BEARD-LINEUP", name: "Beard Line-up", category: "Beard", price: "15.00", duration_min: "15", tax_category: "service", active: "yes" }),
  ];
  if (format === "csv") {
    return new Response(toCsv(headers, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="rayz-catalog-template.csv"', "Cache-Control": "no-store" },
    });
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Catalog");
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => (c.width = 16));
  ws.getColumn(headers.indexOf("sku") + 1).numFmt = "@";
  ws.getColumn(headers.indexOf("barcode") + 1).numFmt = "@";
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const help = wb.addWorksheet("Instructions");
  help.addRow(["Column", "What to put in it"]).font = { bold: true };
  for (const c of BASE_COLUMNS) help.addRow([c.key, c.hint]);
  for (const s of ctx.shops) {
    help.addRow([shopColumn("price", s), `Optional. ${s.name}'s own price; blank keeps the brand price.`]);
    help.addRow([shopColumn("stock", s), `Optional. Products: stock on hand at ${s.name}.`]);
  }
  help.addRow([]);
  help.addRow(["", "Blank cells leave existing items as they are. Rows are matched by SKU, so uploading again updates them."]);
  help.getColumn(1).width = 24;
  help.getColumn(2).width = 90;
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="rayz-catalog-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
