import { reportExport, reportView } from "@/domain/permissions";
import { audit } from "@/server/audit";
import { can, routeStaff } from "@/server/auth/staff";
import { locationBlocks, locationsCsv, locationsFileName, locationsWorkbook } from "@/server/payroll/locations";
import { buildPayroll } from "@/server/payroll/run";

const PERIOD = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

/** The Payroll Report for a pay period, as the workbook's Locations tab (.xlsx) or CSV. Every download is audited. */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, reportView("payroll_report")) || !can(ctx, reportExport("payroll_report")) || !can(ctx, "payroll.rates"))
    return new Response("You don't have permission to download the Payroll Report", { status: 403 });
  const url = new URL(req.url);
  const m = PERIOD.exec(url.searchParams.get("period") ?? "");
  const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  if (!m || m[1] > m[2]) return new Response("Bad request", { status: 400 });
  const [, start, end] = m;
  const view = await buildPayroll(start, end, { clockChecks: false });
  const shop = url.searchParams.get("shop");
  const allowed = (view?.blocks ?? []).map((b) => b.shopId).filter((id) => ctx.shopIds.includes(id) && (!shop || id === shop));
  if (!view || !allowed.length) return new Response("None of your shops has a pay period with those dates.", { status: 404 });
  const blocks = locationBlocks(view, allowed);
  const fileName = locationsFileName(start, end, format);
  const body = format === "csv" ? Buffer.from(locationsCsv(blocks), "utf8") : await locationsWorkbook(view, blocks);
  await audit(ctx.actor, "payroll.report_file", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, format, shops: blocks.map((b) => b.shopId), rows: blocks.reduce((a, b) => a + b.lines.length, 0), file: fileName, locked: view.locked }, null);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}
