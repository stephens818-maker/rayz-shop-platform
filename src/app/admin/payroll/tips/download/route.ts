import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { buildPayroll } from "@/server/payroll/run";
import { tipCheckCsv } from "@/server/payroll/tip-reconcile";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The payroll-period tip report as a CSV, for payroll to check the iSolved files against. */
export async function GET(req: Request) {
  const ctx = await routeStaff("payroll.run");
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!DATE.test(start) || !DATE.test(end)) return new Response("Bad request", { status: 400 });
  const view = await buildPayroll(start, end, { clockChecks: false });
  if (!view) return new Response("No shop has a pay period with those dates.", { status: 404 });
  const t = view.tips;
  await audit(ctx.actor, "payroll.tip_report", "payroll_period", null, {
    periodStart: start,
    periodEnd: end,
    employees: t.rows.length,
    payouts: t.rows.reduce((a, r) => a + r.payouts.length, 0),
    mismatches: t.mismatches.length,
  });
  return new Response(tipCheckCsv(t, start, end), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tips-${start}-to-${end}.csv"`,
      "cache-control": "no-store",
    },
  });
}
