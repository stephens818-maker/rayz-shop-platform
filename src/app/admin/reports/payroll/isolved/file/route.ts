import { reportExport, reportView } from "@/domain/permissions";
import { isValidLocalDate } from "@/lib/time";
import { audit } from "@/server/audit";
import { can, routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { isolvedWorkbook } from "@/server/payroll/reports";
import { reportContext } from "@/server/report-access";
import { resolveLocations } from "../../../scope";

/**
 * A pay period's iSolved file in one click: one workbook, a tab per shop in the viewer's selection,
 * in the Timecard Import layout. Needs the report's export and "Download the payroll export". A
 * period that isn't approved and locked yet downloads as DRAFT. Every download is audited.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, reportView("payroll_isolved")) || !can(ctx, reportExport("payroll_isolved")) || !can(ctx, "payroll.export"))
    return new Response("You don't have permission to download the iSolved file", { status: 403 });
  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!isValidLocalDate(start) || !isValidLocalDate(end) || start > end) return new Response("Bad request", { status: 400 });
  let shopIds: string[];
  try {
    shopIds = (await resolveLocations(await reportContext(ctx, "payroll_isolved"), { shop: url.searchParams.getAll("shop") })).selection.shopIds;
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const f = await isolvedWorkbook(start, end, shopIds);
  if (!f) return new Response("None of your shops has a pay period with those dates.", { status: 404 });
  await audit(ctx.actor, "payroll.isolved_file", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, status: f.status, rows: f.rows, shops: f.shops, file: f.fileName }, ctx.currentShopId);
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
