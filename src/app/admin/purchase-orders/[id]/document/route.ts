import { eq } from "drizzle-orm";
import { db } from "@/db";
import { purchaseOrders } from "@/db/schema";
import { poCsv, poPdf } from "@/domain/po-document";
import { routeStaff } from "@/server/auth/staff";
import { poDocument, poFileName } from "@/server/inventory/purchasing";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The order exactly as the vendor gets it: `?format=pdf` (default) or `?format=csv`. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await routeStaff(["po.create", "po.approve", "po.send", "po.receive"]);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, id), columns: { shopId: true } });
  if (!po || !ctx.shopIds.includes(po.shopId)) return new Response("Not found", { status: 404 });
  const doc = await poDocument(id);
  const csv = new URL(req.url).searchParams.get("format") === "csv";
  const name = poFileName(doc.number, csv ? "csv" : "pdf");
  const body = csv ? poCsv(doc) : Buffer.from(poPdf(doc));
  return new Response(body, {
    headers: { "content-type": csv ? "text/csv; charset=utf-8" : "application/pdf", "content-disposition": `${csv ? "attachment" : "inline"}; filename="${name}"` },
  });
}
