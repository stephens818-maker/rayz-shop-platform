import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { clientListDenied, recordClientAccess } from "@/server/client-privacy";
import { handBackCsv, handBackReport } from "@/server/cutover";
import { inTenant } from "@/server/tenant";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upcoming bookings made here, for entering in Squire when a shop goes back to it. */
export async function GET(_req: Request, { params }: { params: Promise<{ shopId: string }> }) {
  const ctx = await routeStaff(["import.run"]);
  if (ctx instanceof Response) return ctx;
  const { shopId } = await params;
  if (!UUID.test(shopId) || !(await inTenant(ctx, "shop", shopId))) return new Response("Not found", { status: 404 });
  const refused = clientListDenied(ctx);
  if (refused) return new Response(refused, { status: 403 });
  const { bookings } = await handBackReport(shopId);
  await recordClientAccess(ctx, { kind: "export", detail: { export: "cutover_hand_back", shopId, rows: bookings.length } });
  await audit(ctx.actor, "client.export", "shop", shopId, { export: "cutover_hand_back", rows: bookings.length }, shopId);
  return new Response(handBackCsv(bookings), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="bookings-for-squire-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
