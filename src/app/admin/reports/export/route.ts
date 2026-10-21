import { REPORTS, ReportKey, reportExport, reportView } from "@/domain/permissions";
import { can, routeStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { REPORT_LOADERS, tableCsv } from "@/server/report-data";
import { resolveScope } from "../scope";

/** Older export links, kept working. */
const ALIASES: Record<string, { report: ReportKey; table?: string }> = {
  summary: { report: "sales_summary" },
  shops: { report: "sales_summary", table: "shops" },
  daily: { report: "sales_summary", table: "daily" },
  monthly: { report: "sales_summary", table: "monthly" },
  barbers: { report: "sales_by_barber" },
  payroll: { report: "tips_payroll" },
};

/** CSV for one report table. Needs both "view" and "export" for that report, for shops in your access. */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const p = Object.fromEntries(url.searchParams) as Record<string, string>;
  const alias = ALIASES[p.type ?? "summary"];
  const key = (alias?.report ?? p.type) as ReportKey;
  if (!REPORTS.some((r) => r.key === key)) return new Response("Unknown report", { status: 404 });
  if (!can(ctx, reportView(key)) || !can(ctx, reportExport(key))) return new Response("You don't have permission to export this report", { status: 403 });
  if (key === "client_ratings") return Response.redirect(new URL(`/admin/reports/ratings/export?${url.searchParams}`, url), 307);
  let scope;
  try {
    scope = resolveScope(ctx, p, key);
  } catch (e) {
    return new Response(e instanceof AppError ? e.message : "Bad request", { status: 403 });
  }
  const data = await REPORT_LOADERS[key]({ scope, viewer: ctx, params: p });
  const tableId = p.table ?? alias?.table;
  const table = tableId ? data.tables.find((t) => t.id === tableId) : data.tables[0];
  if (!table) return new Response("Unknown table", { status: 404 });
  const csv = tableCsv(table);
  const name = key === "audit_log" ? `rayz-audit-log-${new Date().toISOString().slice(0, 10)}` : `rayz-${key.replace(/_/g, "-")}${tableId ? `-${tableId}` : ""}-${scope.from}-to-${scope.to}`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
