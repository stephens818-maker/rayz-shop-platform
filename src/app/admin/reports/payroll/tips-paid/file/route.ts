import { reportExport, reportView } from "@/domain/permissions";
import { isValidLocalDate } from "@/lib/time";
import { audit } from "@/server/audit";
import { can, routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { tipsPaidFile } from "@/server/payroll/reports";
import { NOT_OFFICIAL, officialGroups } from "@/server/payroll/run";
import { reportContext } from "@/server/report-access";
import { resolveLocations } from "../../../scope";

/**
 * A pay period's tips paid for iSolved (ST-C13), one row per employer and employee, as CSV. Needs the
 * report's export and "Download the payroll export". DRAFT until every row is final. Audited.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, reportView("payroll_tips_paid")) || !can(ctx, reportExport("payroll_tips_paid")) || !can(ctx, "payroll.export"))
    return new Response("You don't have permission to download tips paid", { status: 403 });
  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!isValidLocalDate(start) || !isValidLocalDate(end) || start > end) return new Response("Bad request", { status: 400 });
  if (!(await officialGroups(start, end)).length) return new Response(NOT_OFFICIAL, { status: 409 });
  let shopIds: string[];
  try {
    shopIds = (await resolveLocations(await reportContext(ctx, "payroll_tips_paid"), { shop: url.searchParams.getAll("shop") })).selection.shopIds;
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const f = await tipsPaidFile(start, end, shopIds);
  if (!f) return new Response("None of your shops has a pay period with those dates.", { status: 404 });
  await audit(ctx.actor, "payroll.tips_paid_file", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, status: f.status, rows: f.rows, file: f.fileName }, ctx.currentShopId);
  return new Response(f.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
