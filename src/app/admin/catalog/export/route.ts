import { routeStaff } from "@/server/auth/staff";
import { catalogExport } from "@/server/catalog-import";
import { toCsv } from "@/server/reports";

/** The whole catalog in the upload format, with per-shop columns for the caller's shops. Upload it back to make changes. */
export async function GET() {
  const ctx = await routeStaff(["catalog.manage", "inventory.manage"]);
  if (ctx instanceof Response) return ctx;
  const [headers, ...rows] = await catalogExport(ctx.shopIds);
  return new Response(toCsv(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rayz-catalog-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
