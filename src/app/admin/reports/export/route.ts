import { REPORTS, ReportKey, reportExport, reportView } from "@/domain/permissions";
import { type ReportTable, viewOf } from "@/domain/report-views";
import { audit } from "@/server/audit";
import { can, reasonViewer, routeStaff } from "@/server/auth/staff";
import { clientListDenied, clientPolicy } from "@/server/client-privacy";
import { AppError } from "@/server/errors";
import { reportContext } from "@/server/report-access";
import { loadReport, tableCsv } from "@/server/report-data";
import { resolveScope } from "../scope";

/** Older export links, kept working. */
const ALIASES: Record<string, { report: ReportKey; table?: string; view?: string }> = {
  summary: { report: "sales_summary" },
  shops: { report: "sales_summary", table: "summary", view: "shops" },
  daily: { report: "sales_summary", table: "daily" },
  monthly: { report: "sales_summary", table: "monthly" },
  barbers: { report: "sales_by_barber" },
  payroll: { report: "tips_payroll" },
};

/** A downloaded audit log would list the clients whose records were touched, so only brand-level people get those entries. */
function withoutClientEntries(t: ReportTable): ReportTable {
  const area = t.columns.findIndex((c) => c.label === "Area");
  return area < 0 ? t : { ...t, rows: t.rows.filter((r) => r[area] !== "customer" && r[area] !== "client_rating") };
}

/**
 * CSV for one report table. Needs both "view" and "export" for that report, for shops in your
 * access, and only the barbers the viewer may see. The file follows the page's view: combined, by
 * location, by barber, or by location and barber, with Location and Barber columns to match.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const p = Object.fromEntries(url.searchParams) as Record<string, string>;
  const alias = p.type === "sales_summary" && p.table === "shops" ? ALIASES.shops : ALIASES[p.type ?? "summary"];
  if (alias === ALIASES.shops) delete p.table;
  const key = (alias?.report ?? p.type) as ReportKey;
  if (!REPORTS.some((r) => r.key === key)) return new Response("Unknown report", { status: 404 });
  if (!can(ctx, reportView(key)) || !can(ctx, reportExport(key))) return new Response("You don't have permission to export this report", { status: 403 });
  if (key === "client_ratings") return Response.redirect(new URL(`/admin/reports/ratings/export?${url.searchParams}`, url), 307);
  const rctx = await reportContext(ctx);
  let scope;
  try {
    scope = await resolveScope(rctx, { ...p, shop: url.searchParams.getAll("shop"), staff: url.searchParams.getAll("staff"), view: p.view ?? alias?.view }, key);
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const data = await loadReport(key, { scope, loc: scope.loc, viewer: rctx, client: await clientPolicy(ctx), reasons: reasonViewer(ctx), params: p });
  const tableId = p.table ?? alias?.table;
  const found = tableId ? data.tables.find((t) => t.id === tableId) : data.tables[0];
  if (!found) return new Response("Unknown table", { status: 404 });
  const table = key === "audit_log" && clientListDenied(ctx) ? withoutClientEntries(found) : found;
  const csv = tableCsv(table);
  await audit(ctx.actor, "report.export", "report", key, { table: table.id, rows: table.rows.length, from: scope.from, to: scope.to, shops: scope.shopIds }, ctx.currentShopId);
  const view = { combined: "", shops: "-by-location", barbers: "-by-barber", shops_barbers: "-by-location-and-barber" }[viewOf(scope.loc)];
  const name =
    key === "audit_log"
      ? `rayz-audit-log${view}-${new Date().toISOString().slice(0, 10)}`
      : `rayz-${key.replace(/_/g, "-")}${tableId ? `-${tableId}` : ""}${view}-${scope.from}-to-${scope.to}`;
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "no-store" } });
}
