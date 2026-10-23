import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { receiptForCustomer } from "@/server/mobile/purchases";

/** Email-style text, or a PDF when `format=pdf`. Amounts are not reduced by refunds. */
export const OPTIONS = options;
export const GET = route(async (req) => {
  const customerId = await requireCustomer(req);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ receipt: null });
  const receipt = await receiptForCustomer(customerId, id);
  if (!receipt) return json({ receipt: null });
  if (new URL(req.url).searchParams.get("format") === "pdf") {
    return new Response(Buffer.from(receipt.pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="receipt-${id}.pdf"` },
    });
  }
  return json({ receipt: { ...receipt.sale, text: receipt.text } });
});
