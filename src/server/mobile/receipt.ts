import { formatForHumans } from "@/server/brand-time";
import type { RefundFrom, SettlementView } from "./settlement";

export interface ReceiptRefund {
  id: string;
  createdAt: string;
  amountCents: number;
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  shopPortionCents?: number | null;
  tipPortionCents?: number | null;
  from?: RefundFrom | null;
}

export interface ReceiptSale {
  id: string;
  number?: number | null;
  paidAt: string | null;
  shopName: string;
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  settlement?: SettlementView | null;
  refunds: ReceiptRefund[];
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Shop and tip lines from the ledger. Omitted when the ticket has no Connect settlement. */
export function settlementLines(ticketTipCents: number, settlement: SettlementView | null | undefined): string[] {
  if (!settlement) return [];
  const lines = [`Shop ${dollars(settlement.shopCents)}`];
  if (settlement.tipStatus === "with_shop" && ticketTipCents > 0) {
    lines.push(`Tip ${dollars(ticketTipCents)} stays with the shop for iSolved.`);
  } else if (settlement.tipCents > 0 && (settlement.tipStatus === "executed" || settlement.tipStatus === "reversed" || settlement.tipStatus === "planned")) {
    lines.push(`Tip to the barber ${dollars(settlement.tipCents)}`);
  }
  return lines;
}

/** Account the refund left. Blank when the ledger did not record a card settlement. */
export function refundPortionPhrase(refund: Pick<ReceiptRefund, "from" | "shopPortionCents" | "tipPortionCents">): string {
  if (refund.from === "shop") return " from the shop";
  if (refund.from === "tip") return " from the tip";
  if (refund.from === "shop_and_tip" && refund.shopPortionCents != null && refund.tipPortionCents != null) {
    return ` from the shop ${dollars(refund.shopPortionCents)} and the tip ${dollars(refund.tipPortionCents)}`;
  }
  return "";
}

/** Email body. Amounts are the original ticket. Refunds are their own lines with their own dates. */
export async function renderReceiptText(sale: ReceiptSale): Promise<string> {
  const when = sale.paidAt ? await formatForHumans(sale.paidAt) : "Unpaid";
  const lines = [
    `Ray'z ${sale.shopName}`,
    `Receipt${sale.number ? ` #${sale.number}` : ""}`,
    when,
    `Services ${dollars(sale.serviceCents)}`,
    `Products ${dollars(sale.productCents)}`,
    `Tax ${dollars(sale.taxCents)}`,
    `Tip ${dollars(sale.tipCents)}`,
    ...settlementLines(sale.tipCents, sale.settlement),
    `Total ${dollars(sale.totalCents)}`,
  ];
  for (const r of sale.refunds) {
    lines.push(
      `Refund ${await formatForHumans(r.createdAt)} ${dollars(r.amountCents)}${refundPortionPhrase(r)} (services ${dollars(r.serviceCents)}, products ${dollars(r.productCents)}, tax ${dollars(r.taxCents)}, tip ${dollars(r.tipCents)})`,
    );
  }
  return lines.join("\n");
}

/** One-page PDF of the same receipt text. Times are already 12-hour Chicago when the text was rendered. */
export function receiptPdf(text: string): Uint8Array {
  const safe = text.replace(/[()\\]/g, " ");
  const body = safe.split("\n").join(") Tj T* (");
  const stream = `BT /F1 12 Tf 50 760 Td 16 TL (${body}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];
  let pdf = "%PDF-1.4\n";
  const xref = [0];
  for (const obj of objects) {
    xref.push(pdf.length);
    pdf += `${obj}\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${xref.length}\n0000000000 65535 f \n`;
  for (const off of xref.slice(1)) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
