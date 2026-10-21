import { formatCents } from "@/lib/money";
import { PdfDoc, fitText } from "@/lib/pdf";
import { poNumber, poTotalCents } from "./inventory";

/** Everything printed on a purchase order. */
export interface PoDocument {
  number: number;
  date: string;
  expectedOn: string | null;
  notes: string | null;
  brand: string;
  shop: { name: string; address: string; city: string; state: string; zip: string; phone: string | null; email: string | null };
  vendor: { name: string; contactName: string | null; email: string | null; phone: string | null; address: string | null; accountNumber: string | null; paymentTerms: string | null; minimumOrderCents: number };
  lines: { vendorSku: string | null; sku: string; name: string; casePack: number; qtyOrdered: number; unitCostCents: number }[];
}

const dollars = (c: number) => (c / 100).toFixed(2);

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per line, for vendors who import orders. */
export function poCsv(d: PoDocument): string {
  const head = ["po_number", "date", "ship_to", "vendor", "account_number", "vendor_sku", "sku", "product", "case_pack", "cases", "units", "unit_cost", "line_total"];
  const shipTo = `${d.brand} ${d.shop.name}`;
  const rows = d.lines.map((l) => [
    poNumber(d.number),
    d.date,
    shipTo,
    d.vendor.name,
    d.vendor.accountNumber,
    l.vendorSku,
    l.sku,
    l.name,
    l.casePack,
    l.casePack > 1 && l.qtyOrdered % l.casePack === 0 ? l.qtyOrdered / l.casePack : null,
    l.qtyOrdered,
    dollars(l.unitCostCents),
    dollars(l.qtyOrdered * l.unitCostCents),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function poPdf(d: PoDocument): Uint8Array {
  const pdf = new PdfDoc();
  const L = 48;
  const R = pdf.width - 48;
  let y = 56;

  const header = () => {
    pdf.text(L, y, `${d.brand}`, { size: 16, bold: true });
    pdf.text(R, y, "PURCHASE ORDER", { size: 16, bold: true, align: "right" });
    y += 18;
    pdf.text(L, y, d.shop.name, { size: 10, gray: 0.35 });
    pdf.text(R, y, `${poNumber(d.number)} · ${d.date}`, { size: 10, align: "right" });
    y += 12;
    pdf.line(L, y, R, y, { width: 1, gray: 0.2 });
    y += 20;
  };
  header();

  const block = (x: number, title: string, rows: (string | null | undefined)[]) => {
    let yy = y;
    pdf.text(x, yy, title, { size: 8, bold: true, gray: 0.4 });
    yy += 13;
    for (const r of rows.filter((v): v is string => !!v)) {
      pdf.text(x, yy, fitText(r, 240, 10), { size: 10 });
      yy += 13;
    }
    return yy;
  };
  const cityLine = [d.shop.city, [d.shop.state, d.shop.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const left = block(L, "VENDOR", [
    d.vendor.name,
    d.vendor.contactName ? `Attn: ${d.vendor.contactName}` : null,
    ...(d.vendor.address ?? "").split("\n"),
    d.vendor.phone,
    d.vendor.email,
  ]);
  const right = block(320, "SHIP TO", [`${d.brand} - ${d.shop.name}`, d.shop.address, cityLine, d.shop.phone, d.shop.email]);
  y = Math.max(left, right) + 8;
  const terms = [
    d.vendor.accountNumber ? `Account ${d.vendor.accountNumber}` : null,
    d.vendor.paymentTerms ? `Terms: ${d.vendor.paymentTerms}` : null,
    d.expectedOn ? `Needed by ${d.expectedOn}` : null,
  ].filter(Boolean);
  if (terms.length) {
    pdf.text(L, y, terms.join("   ·   "), { size: 9, gray: 0.25 });
    y += 18;
  }

  const cols = [
    { label: "Vendor SKU", x: L, w: 78 },
    { label: "Our SKU", x: L + 82, w: 88 },
    { label: "Product", x: L + 174, w: 150 },
    { label: "Pack", x: L + 352, right: true },
    { label: "Cases", x: L + 392, right: true },
    { label: "Units", x: L + 430, right: true },
    { label: "Unit cost", x: L + 478, right: true },
    { label: "Total", x: R, right: true },
  ];
  const tableHead = () => {
    pdf.rect(L - 4, y - 11, R - L + 8, 16);
    for (const c of cols) pdf.text(c.x, y, c.label, { size: 8, bold: true, align: c.right ? "right" : "left" });
    y += 16;
  };
  tableHead();
  for (const l of d.lines) {
    if (y > pdf.height - 110) {
      pdf.text(R, pdf.height - 40, "Continued", { size: 8, gray: 0.5, align: "right" });
      pdf.addPage();
      y = 56;
      header();
      tableHead();
    }
    const cases = l.casePack > 1 && l.qtyOrdered % l.casePack === 0 ? String(l.qtyOrdered / l.casePack) : "";
    const cells = [l.vendorSku ?? "", l.sku, l.name, String(l.casePack), cases, String(l.qtyOrdered), formatCents(l.unitCostCents), formatCents(l.qtyOrdered * l.unitCostCents)];
    cols.forEach((c, i) => pdf.text(c.x, y, c.w ? fitText(cells[i], c.w, 9) : cells[i], { size: 9, align: c.right ? "right" : "left" }));
    y += 6;
    pdf.line(L - 4, y, R + 4, y, { gray: 0.88 });
    y += 12;
  }

  const total = poTotalCents(d.lines);
  y += 6;
  pdf.text(L + 430, y, `${d.lines.reduce((a, l) => a + l.qtyOrdered, 0)} units`, { size: 9, align: "right", gray: 0.35 });
  pdf.text(L + 478, y, "Total", { size: 11, bold: true, align: "right" });
  pdf.text(R, y, formatCents(total), { size: 11, bold: true, align: "right" });
  y += 22;
  if (d.notes) {
    pdf.text(L, y, "NOTES", { size: 8, bold: true, gray: 0.4 });
    y += 13;
    for (const line of d.notes.split("\n").slice(0, 8)) {
      pdf.text(L, y, fitText(line, R - L, 10), { size: 10 });
      y += 13;
    }
  }
  const contact = [d.shop.phone, d.shop.email].filter(Boolean).join(" · ");
  pdf.text(L, pdf.height - 40, fitText(`Please put ${poNumber(d.number)} on the invoice and packing slip.${contact ? ` Questions: ${contact}` : ""}`, R - L - 60, 8), { size: 8, gray: 0.45 });
  return pdf.toBytes();
}
