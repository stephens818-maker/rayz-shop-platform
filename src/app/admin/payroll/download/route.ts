import { audit } from "@/server/audit";
import { routeStaff } from "@/server/auth/staff";
import { NOT_OFFICIAL, approvedExport, officialGroups } from "@/server/payroll/run";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One shop's iSolved file once the pay period is approved (as locked, once it is). Charles uploads it by hand. */
export async function GET(req: Request) {
  const ctx = await routeStaff(["payroll.run", "payroll.export"]);
  if (ctx instanceof Response) return ctx;
  const url = new URL(req.url);
  const group = url.searchParams.get("group") ?? "";
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(group) || !DATE.test(start) || !DATE.test(end)) return new Response("Bad request", { status: 400 });
  if (!(await officialGroups(start, end)).some((g) => g.id === group)) return new Response(NOT_OFFICIAL, { status: 409 });
  const f = await approvedExport(group, start, end);
  if (!f) return new Response("That pay period isn't approved yet, or its figures changed since the approval, so there's nothing to download.", { status: 409 });
  await audit(ctx.actor, "payroll.download", f.runId ? "payroll_run" : "payroll_approval", f.runId ?? f.approvalId, { file: f.fileName, periodStart: start, periodEnd: end, locked: !!f.runId }, null);
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `attachment; filename="${f.fileName.replace(/"/g, "")}"`,
      "cache-control": "no-store",
    },
  });
}
