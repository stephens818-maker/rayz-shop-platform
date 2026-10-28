import { reportExport, reportView } from "@/domain/permissions";
import { isValidLocalDate } from "@/lib/time";
import { audit } from "@/server/audit";
import { can, routeStaff } from "@/server/auth/staff";
import { payrollDetailFile } from "@/server/payroll/detail";

const PERIOD = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

/**
 * The payroll detail and reconciliation CSV for a pay period (or whole workweeks for the shops given,
 * `shop` repeated): every shop the person has, or the shops picked. Separate from the iSolved file.
 * Refused while the Payroll Report doesn't reconcile to $0.00. Every download is audited.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  if (!can(ctx, reportView("payroll_report")) || !can(ctx, reportExport("payroll_report")) || !can(ctx, "payroll.rates"))
    return new Response("You don't have permission to download the payroll detail file", { status: 403 });
  const url = new URL(req.url);
  const m = PERIOD.exec(url.searchParams.get("period") ?? "");
  if (!m || !isValidLocalDate(m[1]) || !isValidLocalDate(m[2]) || m[1] > m[2]) return new Response("Bad request", { status: 400 });
  const [, start, end] = m;
  const picked = url.searchParams.getAll("shop").filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (picked.some((id) => !ctx.shopIds.includes(id))) return new Response("You don't have access to that shop", { status: 403 });
  const f = await payrollDetailFile(start, end, { shopIds: picked.length ? picked : null, allowed: ctx.shopIds });
  if ("refused" in f) return new Response(f.refused, { status: f.status });
  await audit(ctx.actor, "payroll.detail_file", "payroll_period", `${start}_${end}`, { periodStart: start, periodEnd: end, status: f.status, shops: f.shops, rows: f.rows, file: f.fileName }, null);
  return new Response(f.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
